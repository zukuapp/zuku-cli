using System;
using System.Collections.Generic;
using System.Collections.Frozen;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Zuku.Studio.Core;

/// <summary>Bounds shared with studio/native/linux/protocol.h and the stdio host.</summary>
public static class Limits
{
    public const int OutgoingLineBytes = 65536;      // one request line to the host, newline included
    public const int OutgoingQueueCount = 64;
    public const int OutgoingQueueBytes = 262144;
    public const int IncomingLineBytes = 262144;     // one response/event line from the host
    public const int IncomingQueueCount = 64;
    public const int RendererMessageBytes = 65536;   // bridge.js refuses larger messages too
    public const int PendingLimit = 128;
    public const int PendingSeconds = 180;
    public const int EventBytes = 32768;
    public const int Depth = 12;
    public const int SecretValueChars = 4096;
    public const int PromptQuestionChars = 1000;
    public const long PromptMaxMilliseconds = 125000;
}

/// <summary>
/// Protocol tables generated from lib/agent-protocol/schema.mjs and studio/native/bridge.js
/// by tools/protocol-manifest.mjs. The test suite fails when the embedded copy is stale.
/// </summary>
public sealed class ProtocolManifest
{
    public sealed record Shape(FrozenSet<string> Required, FrozenSet<string> Optional);

    public int ProtocolVersion { get; }
    public FrozenDictionary<string, Shape> RendererMethods { get; }
    public FrozenSet<string> NativePrivate { get; }
    public FrozenDictionary<string, Shape> Events { get; }
    public FrozenSet<string> PublicKeys { get; }
    public Regex SecretKey { get; }
    public Regex SecretText { get; }
    public Regex CredentialAssignment { get; }
    public Regex LocalPath { get; }

    static readonly Lazy<ProtocolManifest> Embedded = new(() =>
    {
        using var stream = typeof(ProtocolManifest).Assembly.GetManifestResourceStream("Zuku.Studio.Core.protocol-manifest.json")
            ?? throw new InvalidOperationException("protocol manifest resource missing");
        using var reader = new StreamReader(stream);
        return Parse(reader.ReadToEnd());
    });
    public static ProtocolManifest Current => Embedded.Value;

    ProtocolManifest(JsonElement root)
    {
        ProtocolVersion = root.GetProperty("protocolVersion").GetInt32();
        RendererMethods = Shapes(root.GetProperty("rendererMethods"));
        NativePrivate = root.GetProperty("nativePrivate").EnumerateArray().Select(entry => entry.GetString()!).ToFrozenSet(StringComparer.Ordinal);
        Events = Shapes(root.GetProperty("events"));
        PublicKeys = root.GetProperty("publicKeys").EnumerateArray().Select(entry => entry.GetString()!).ToFrozenSet(StringComparer.Ordinal);
        var timeout = TimeSpan.FromMilliseconds(250);
        SecretKey = new Regex(root.GetProperty("secretKeyPattern").GetString()!, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, timeout);
        SecretText = new Regex(root.GetProperty("secretTextPattern").GetString()!, RegexOptions.CultureInvariant, timeout);
        CredentialAssignment = new Regex(root.GetProperty("credentialAssignmentPattern").GetString()!, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, timeout);
        LocalPath = new Regex(root.GetProperty("localPathPattern").GetString()!, RegexOptions.CultureInvariant, timeout);
        if (ProtocolVersion != 1) throw new InvalidOperationException("unsupported protocol manifest");
        foreach (var method in RendererMethods.Keys)
            if (NativePrivate.Contains(method) || method.StartsWith("native.", StringComparison.Ordinal)) throw new InvalidOperationException("renderer method table exposes a private method");
    }

    public static ProtocolManifest Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        return new ProtocolManifest(document.RootElement.Clone());
    }

    static FrozenDictionary<string, Shape> Shapes(JsonElement table)
    {
        var result = new Dictionary<string, Shape>(StringComparer.Ordinal);
        foreach (var entry in table.EnumerateObject())
            result[entry.Name] = new Shape(
                entry.Value.GetProperty("required").EnumerateArray().Select(value => value.GetString()!).ToFrozenSet(StringComparer.Ordinal),
                entry.Value.GetProperty("optional").EnumerateArray().Select(value => value.GetString()!).ToFrozenSet(StringComparer.Ordinal));
        return result.ToFrozenDictionary(StringComparer.Ordinal);
    }
}
