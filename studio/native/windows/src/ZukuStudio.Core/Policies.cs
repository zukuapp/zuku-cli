using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Zuku.Studio.Core;

public static partial class PreviewPolicy
{
    [GeneratedRegex("^http://127\\.0\\.0\\.1:([1-9][0-9]{0,4})/p/([a-f0-9]{32})/$", RegexOptions.CultureInvariant)]
    private static partial Regex Url();

    /// <summary>Accepts exactly http://127.0.0.1:&lt;port&gt;/p/&lt;32 hex&gt;/ — no userinfo, query or fragment.</summary>
    public static Uri? Admit(string? value)
    {
        if (value is null || value.Length > 200) return null;
        var match = Url().Match(value);
        if (!match.Success || !int.TryParse(match.Groups[1].Value, out var port) || port > 65535) return null;
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.OriginalString != value || uri.AbsoluteUri != value) return null;
        return uri;
    }

    /// <summary>Same origin AND under the nonce path prefix. Used for navigations, frames and every subresource.</summary>
    public static bool Within(Uri baseUri, string? candidate)
    {
        if (candidate is null || !Uri.TryCreate(candidate, UriKind.Absolute, out var uri)) return false;
        if (uri.Scheme != Uri.UriSchemeHttp || uri.Host != "127.0.0.1" || uri.Port != baseUri.Port || uri.UserInfo.Length != 0) return false;
        var path = uri.AbsolutePath;
        // Uri has already collapsed dot segments; encoded separators would escape the prefix after decoding.
        if (path.Contains("%2f", StringComparison.OrdinalIgnoreCase) || path.Contains("%5c", StringComparison.OrdinalIgnoreCase) || path.Contains('\\')) return false;
        return path.StartsWith(baseUri.AbsolutePath, StringComparison.Ordinal);
    }
}

public enum LaunchKind { Activate, Connect, Project }

/// <summary>What a launch (or second instance) asks the running Studio to do. Never carries credentials or commands.</summary>
public sealed record LaunchRequest(LaunchKind Kind, string? ProjectPath)
{
    public const string ConnectUri = "zuku://ai/connect";

    public static LaunchRequest FromArguments(IReadOnlyList<string> arguments)
    {
        if (arguments.Count != 1) return new(LaunchKind.Activate, null);
        var value = arguments[0];
        // Only the exact token-free URI. Anything else on the zuku: scheme is ignored, never interpreted.
        if (value == ConnectUri) return new(LaunchKind.Connect, null);
        if (value.StartsWith("zuku:", StringComparison.OrdinalIgnoreCase) || value.StartsWith('-')) return new(LaunchKind.Activate, null);
        if (value.Length <= 4096 && !JsonSafety.HasControl(value) && FolderPolicy.IsDrivePath(value)) return new(LaunchKind.Project, value);
        return new(LaunchKind.Activate, null);
    }

    public const int WireBytes = 8192;

    public byte[] Encode() => JsonSafety.Write(writer =>
    {
        writer.WriteStartObject();
        writer.WriteNumber("protocolVersion", 1);
        writer.WriteString("type", Kind switch { LaunchKind.Connect => "connect", LaunchKind.Project => "project", _ => "activate" });
        if (Kind == LaunchKind.Project && ProjectPath is not null) writer.WriteString("projectPath", ProjectPath);
        writer.WriteEndObject();
    });

    public static LaunchRequest? Decode(ReadOnlySpan<byte> wire)
    {
        using var document = JsonSafety.Parse(wire.ToArray(), WireBytes);
        if (document is null) return null;
        var root = document.RootElement;
        var type = JsonSafety.String(root, "type");
        if (!JsonSafety.Integer(root, "protocolVersion", 1, 1, out _)) return null;
        if ((type == "activate" || type == "connect") && JsonSafety.HasShape(root, ["protocolVersion", "type"], []))
            return new(type == "connect" ? LaunchKind.Connect : LaunchKind.Activate, null);
        if (type == "project" && JsonSafety.HasShape(root, ["protocolVersion", "type", "projectPath"], []))
        {
            var path = JsonSafety.String(root, "projectPath");
            return path is not null && path.Length <= 4096 && !JsonSafety.HasControl(path) && FolderPolicy.IsDrivePath(path) ? new(LaunchKind.Project, path) : null;
        }
        return null;
    }
}

/// <summary>
/// String-level policy for a folder the user picked. The Windows layer canonicalizes first
/// (final path by handle, reparse rejection); this decides whether that canonical path may be a project.
/// </summary>
public static partial class FolderPolicy
{
    [GeneratedRegex("^[A-Za-z]:\\\\", RegexOptions.CultureInvariant)] private static partial Regex Drive();

    static readonly HashSet<string> Sensitive = new(StringComparer.OrdinalIgnoreCase)
    {
        ".ssh", ".gnupg", ".config", ".aws", ".azure", ".kube", ".docker", ".codex", ".claude", ".git", "AppData",
    };

    public static bool IsDrivePath(string path) => Drive().IsMatch(path);

    public sealed record Roots(string UserProfile, IReadOnlyList<string> Forbidden);

    /// <summary>Returns the normalized path, or null with a reason code.</summary>
    public static string? Admit(string? canonical, Roots roots, out string reason)
    {
        reason = "PROJECT_PATH_INVALID";
        if (canonical is null || canonical.Length > 4096 || JsonSafety.HasControl(canonical) || !IsDrivePath(canonical)) return null;
        if (canonical.Contains('/') || canonical.Contains("\\\\", StringComparison.Ordinal)) return null;
        var path = canonical.TrimEnd('\\');
        if (path.Length <= 2) { reason = "PROJECT_PATH_ROOT"; return null; }
        var parts = path.Split('\\');
        if (parts.Skip(1).Any(part => part.Length == 0 || part == "." || part == ".." || part.EndsWith('.') || part.EndsWith(' '))) return null;
        if (parts.Any(part => Sensitive.Contains(part))) { reason = "PROJECT_PATH_SENSITIVE"; return null; }
        var profile = roots.UserProfile.TrimEnd('\\');
        if (Same(path, profile) || Under(profile, path)) { reason = "PROJECT_PATH_TOO_BROAD"; return null; }
        foreach (var forbidden in roots.Forbidden)
        {
            var root = forbidden.TrimEnd('\\');
            if (root.Length > 2 && (Same(path, root) || Under(path, root) || Under(root, path))) { reason = "PROJECT_PATH_SYSTEM"; return null; }
        }
        reason = "";
        return path;
    }

    static bool Same(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
    /// <summary>child is strictly inside parent.</summary>
    static bool Under(string child, string parent) => child.Length > parent.Length + 1 && child.StartsWith(parent + "\\", StringComparison.OrdinalIgnoreCase);
}

public enum PromptKind { Pairing, Auth }

/// <summary>A validated native approval request. Text shown natively, never as HTML.</summary>
public sealed record PromptRequest(PromptKind Kind, string RequestId, long ExpiresAt, string? ProviderId = null, string? MethodId = null, string? Question = null, bool Experimental = false);

public static class PromptPolicy
{
    public const string Origin = "https://ai.zuzunza.com";
    static readonly string[] PairingKeys = ["requestId", "challengeId", "origin", "purpose", "expiresAt"];
    static readonly string[] AuthRequired = ["requestId", "providerId", "methodId", "question", "expiresAt"];
    static readonly string[] AuthOptional = ["experimental", "official"];
    static readonly Regex Purpose = new("^[a-z][a-z0-9._-]{0,63}$", RegexOptions.CultureInvariant);

    /// <summary>Returns the request id if it is well formed (so a refusal can be sent), else null.</summary>
    public static string? RequestId(JsonElement data) => JsonSafety.String(data, "requestId") is { } id && JsonSafety.IsId(id) ? id : null;

    public static PromptRequest? Pairing(JsonElement data, long now)
    {
        if (!JsonSafety.HasShape(data, PairingKeys, [])) return null;
        var id = RequestId(data);
        if (id is null || !JsonSafety.IsId(JsonSafety.String(data, "challengeId")) || JsonSafety.String(data, "origin") != Origin) return null;
        if (JsonSafety.String(data, "purpose") is not { } purpose || !Purpose.IsMatch(purpose)) return null;
        if (!Deadline(data, now, out var expiresAt)) return null;
        return new(PromptKind.Pairing, id, expiresAt);
    }

    public static PromptRequest? Auth(JsonElement data, long now, ProtocolManifest manifest)
    {
        if (!JsonSafety.HasShape(data, AuthRequired, AuthOptional)) return null;
        var id = RequestId(data);
        var provider = JsonSafety.String(data, "providerId");
        var method = JsonSafety.String(data, "methodId");
        var question = JsonSafety.String(data, "question");
        if (id is null || provider is null || !JsonSafety.Provider().IsMatch(provider) || !JsonSafety.IsId(method)) return null;
        if (question is null || question.Length == 0 || question.Length > Limits.PromptQuestionChars || JsonSafety.HasControl(question) || manifest.SecretText.IsMatch(question)) return null;
        var experimental = false;
        if (data.TryGetProperty("experimental", out var flag))
        {
            if (flag.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return null;
            experimental = flag.ValueKind == JsonValueKind.True;
        }
        if (data.TryGetProperty("official", out var official) && official.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return null;
        if (!Deadline(data, now, out var expiresAt)) return null;
        return new(PromptKind.Auth, id, expiresAt, provider, method, question, experimental);
    }

    static bool Deadline(JsonElement data, long now, out long expiresAt)
    {
        if (!JsonSafety.Integer(data, "expiresAt", 0, JsonSafety.MaxSafeInteger, out expiresAt)) return false;
        var remaining = expiresAt - now;
        return remaining > 0 && remaining <= Limits.PromptMaxMilliseconds;
    }
}
