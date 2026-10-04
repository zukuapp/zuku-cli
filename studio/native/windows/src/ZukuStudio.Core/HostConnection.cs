using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;

namespace Zuku.Studio.Core;

/// <summary>
/// The typed stdio child: exactly `&lt;managed node&gt; &lt;package&gt;\lib\studio-host.mjs --stdio`,
/// started without a shell, with redirected pipes. Incoming lines (≤256 KiB) flow through a
/// bounded channel (64) so a slow UI back-pressures the reader instead of growing memory.
/// stderr is drained and discarded (it may contain provider diagnostics; nothing is logged).
/// </summary>
public sealed class HostConnection : IAsyncDisposable
{
    static readonly string[] StrippedEnvironment = ["NODE_OPTIONS", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE"];

    readonly Process process;
    readonly OutgoingQueue queue;
    readonly Channel<byte[]> incoming = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(Limits.IncomingQueueCount) { SingleReader = true, SingleWriter = true, FullMode = BoundedChannelFullMode.Wait });
    readonly SemaphoreSlim wake = new(0, int.MaxValue);
    readonly CancellationTokenSource stop = new();
    readonly TaskCompletionSource<string> exited = new(TaskCreationOptions.RunContinuationsAsynchronously);
    int stopping;

    HostConnection(Process process, OutgoingQueue queue)
    {
        this.process = process;
        this.queue = queue;
    }

    public ChannelReader<byte[]> Lines => incoming.Reader;
    /// <summary>Completes with a stable reason code once the host is gone or was stopped.</summary>
    public Task<string> Completion => exited.Task;
    public int ProcessId => process.Id;

    /// <param name="contain">Called right after start, e.g. to assign a kill-on-close Windows Job Object.</param>
    public static HostConnection Start(string executable, IReadOnlyList<string> arguments, string workingDirectory, OutgoingQueue queue, Action<Process>? contain = null)
    {
        if (!Path.IsPathFullyQualified(executable) || !Path.IsPathFullyQualified(workingDirectory)) throw new InstallationException("STUDIO_RUNTIME_MISSING");
        var info = new ProcessStartInfo
        {
            FileName = executable,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = workingDirectory,
        };
        foreach (var argument in arguments) info.ArgumentList.Add(argument);
        foreach (var name in StrippedEnvironment) info.Environment.Remove(name);
        var process = new Process { StartInfo = info, EnableRaisingEvents = true };
        if (!process.Start()) throw new InstallationException("STUDIO_HOST_START_FAILED");
        var connection = new HostConnection(process, queue);
        try { contain?.Invoke(process); }
        catch { connection.Kill(); throw; }
        connection.Run();
        return connection;
    }

    void Run()
    {
        var reader = Task.Run(ReadAsync);
        _ = Task.Run(WriteAsync);
        _ = Task.Run(DrainErrorsAsync);
        _ = Task.Run(async () =>
        {
            try { await process.WaitForExitAsync().ConfigureAwait(false); } catch (InvalidOperationException) { }
            // Let the reader deliver lines already in the pipe before reporting the exit.
            await Task.WhenAny(reader, Task.Delay(2000)).ConfigureAwait(false);
            exited.TrySetResult("HOST_EXITED");
            stop.Cancel();
            incoming.Writer.TryComplete();
        });
    }

    /// <summary>Wake the writer after the router queued lines.</summary>
    public void Signal() => wake.Release();

    async Task ReadAsync()
    {
        var framer = new LineFramer();
        var buffer = new byte[16384];
        var stream = process.StandardOutput.BaseStream;
        try
        {
            while (!stop.IsCancellationRequested)
            {
                var count = await stream.ReadAsync(buffer, stop.Token).ConfigureAwait(false);
                if (count == 0) break;
                foreach (var line in framer.Push(buffer.AsSpan(0, count)))
                    await incoming.Writer.WriteAsync(line, stop.Token).ConfigureAwait(false);
                if (framer.Overflowed) { Fault("HOST_LINE_TOO_LARGE"); return; }
            }
        }
        catch (OperationCanceledException) { }
        catch (ChannelClosedException) { }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
        incoming.Writer.TryComplete();
    }

    async Task WriteAsync()
    {
        var stream = process.StandardInput.BaseStream;
        try
        {
            while (!stop.IsCancellationRequested)
            {
                await wake.WaitAsync(stop.Token).ConfigureAwait(false);
                while (queue.TryPeek(out var entry) && entry is not null)
                {
                    await stream.WriteAsync(entry.Bytes, stop.Token).ConfigureAwait(false);
                    await stream.FlushAsync(stop.Token).ConfigureAwait(false);
                    queue.Complete(entry);
                }
            }
        }
        catch (OperationCanceledException) { }
        catch (IOException) { Fault("HOST_PIPE_CLOSED"); }
        catch (ObjectDisposedException) { }
    }

    async Task DrainErrorsAsync()
    {
        var buffer = new byte[4096];
        var stream = process.StandardError.BaseStream;
        try { while (await stream.ReadAsync(buffer, stop.Token).ConfigureAwait(false) > 0) { } }
        catch (OperationCanceledException) { }
        catch (IOException) { }
        catch (ObjectDisposedException) { }
    }

    /// <summary>Protocol violation: record the reason and terminate the child.</summary>
    public void Fault(string code)
    {
        exited.TrySetResult(code);
        Kill();
    }

    void Kill()
    {
        stop.Cancel();
        incoming.Writer.TryComplete();
        try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { } catch (System.ComponentModel.Win32Exception) { }
    }

    /// <summary>Graceful stop: close stdin (host sees EOF), wait, then kill the tree.</summary>
    public async Task StopAsync(TimeSpan grace)
    {
        if (Interlocked.Exchange(ref stopping, 1) != 0) return;
        queue.Close();
        try { process.StandardInput.Close(); } catch (IOException) { } catch (InvalidOperationException) { }
        using (var timeout = new CancellationTokenSource(grace))
        {
            try { await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false); }
            catch (OperationCanceledException) { }
        }
        exited.TrySetResult("HOST_STOPPED");
        Kill();
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync(TimeSpan.FromSeconds(2)).ConfigureAwait(false);
        process.Dispose();
        stop.Dispose();
        wake.Dispose();
    }
}
