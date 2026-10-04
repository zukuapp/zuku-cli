using System;
using System.Collections.Generic;
using System.Security.Cryptography;

namespace Zuku.Studio.Core;

/// <summary>
/// Bounded FIFO of newline-terminated request lines for the host's stdin:
/// at most 64 lines, 256 KiB queued, 64 KiB per line (newline included).
/// Sensitive lines (credential answers) are zeroed as soon as they leave the queue.
/// Thread-safe: the UI thread enqueues, one writer task drains.
/// </summary>
public sealed class OutgoingQueue
{
    public sealed class Entry
    {
        internal Entry(byte[] bytes, bool sensitive) { Bytes = bytes; Sensitive = sensitive; }
        public byte[] Bytes { get; }
        public bool Sensitive { get; }
    }

    readonly object gate = new();
    readonly Queue<Entry> queue = new();
    long bytes;
    bool closed;

    public int Count { get { lock (gate) return queue.Count; } }
    public long Bytes { get { lock (gate) return bytes; } }

    /// <summary>Appends '\n' to a single JSON line; refuses (and wipes sensitive input) when any bound is hit.</summary>
    public bool TryEnqueue(ReadOnlySpan<byte> json, bool sensitive)
    {
        var length = json.Length + 1;
        if (json.IsEmpty || json.IndexOf((byte)'\n') >= 0 || length > Limits.OutgoingLineBytes) return false;
        var line = new byte[length];
        json.CopyTo(line);
        line[^1] = (byte)'\n';
        lock (gate)
        {
            if (!closed && queue.Count < Limits.OutgoingQueueCount && bytes + length <= Limits.OutgoingQueueBytes)
            {
                queue.Enqueue(new Entry(line, sensitive));
                bytes += length;
                return true;
            }
        }
        if (sensitive) CryptographicOperations.ZeroMemory(line);
        return false;
    }

    public bool TryPeek(out Entry? entry) { lock (gate) return queue.TryPeek(out entry); }

    /// <summary>Removes the head after it was written; zeroes it when sensitive.</summary>
    public void Complete(Entry entry)
    {
        lock (gate)
        {
            if (!queue.TryPeek(out var head) || !ReferenceEquals(head, entry)) return;
            queue.Dequeue();
            bytes -= entry.Bytes.Length;
        }
        if (entry.Sensitive) CryptographicOperations.ZeroMemory(entry.Bytes);
    }

    /// <summary>Stops admission and wipes everything still queued.</summary>
    public void Close()
    {
        Entry[] remaining;
        lock (gate) { closed = true; remaining = queue.ToArray(); queue.Clear(); bytes = 0; }
        foreach (var entry in remaining) if (entry.Sensitive) CryptographicOperations.ZeroMemory(entry.Bytes);
    }
}

/// <summary>Splits host stdout into lines; reports overflow when one line exceeds 256 KiB.</summary>
public sealed class LineFramer
{
    readonly int maximum;
    byte[] buffer;
    int length;

    public LineFramer(int maximum = Limits.IncomingLineBytes) { this.maximum = maximum; buffer = new byte[Math.Min(maximum + 1, 16384)]; }

    public bool Overflowed { get; private set; }

    /// <summary>Feeds a chunk; returns complete lines (without '\n' or trailing '\r'). Empty lines are skipped.</summary>
    public List<byte[]> Push(ReadOnlySpan<byte> chunk)
    {
        var lines = new List<byte[]>();
        while (!Overflowed && !chunk.IsEmpty)
        {
            var newline = chunk.IndexOf((byte)'\n');
            var take = newline >= 0 ? chunk[..newline] : chunk;
            if (length + take.Length > maximum) { Overflowed = true; length = 0; break; }
            Append(take);
            if (newline < 0) break;
            var end = length > 0 && buffer[length - 1] == (byte)'\r' ? length - 1 : length;
            if (end > 0) lines.Add(buffer.AsSpan(0, end).ToArray());
            length = 0;
            chunk = chunk[(newline + 1)..];
        }
        return lines;
    }

    void Append(ReadOnlySpan<byte> data)
    {
        if (length + data.Length > buffer.Length) Array.Resize(ref buffer, Math.Min(maximum + 1, Math.Max(buffer.Length * 2, length + data.Length)));
        data.CopyTo(buffer.AsSpan(length));
        length += data.Length;
    }
}
