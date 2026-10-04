using System;
using System.Buffers;
using System.Collections.Generic;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Zuku.Studio.Core;

/// <summary>Strict JSON admission helpers mirroring schema.mjs inspect()/relativePath().</summary>
public static partial class JsonSafety
{
    static readonly JsonDocumentOptions Options = new() { MaxDepth = Limits.Depth + 4, CommentHandling = JsonCommentHandling.Disallow, AllowTrailingCommas = false };

    [GeneratedRegex("^[A-Za-z0-9_-]{1,128}$", RegexOptions.CultureInvariant)] public static partial Regex Id();
    [GeneratedRegex("^[a-z][a-z0-9_-]{0,63}$", RegexOptions.CultureInvariant)] public static partial Regex Provider();
    [GeneratedRegex("^[A-Z][A-Z0-9_]{0,63}$", RegexOptions.CultureInvariant)] public static partial Regex Code();
    [GeneratedRegex("[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]", RegexOptions.CultureInvariant)] private static partial Regex Control();
    [GeneratedRegex("\\x1b\\[[0-?]*[ -/]*[@-~]", RegexOptions.CultureInvariant)] private static partial Regex Ansi();
    [GeneratedRegex("^(?:node_modules|credentials?|secrets?)$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)] private static partial Regex ReservedSegment();

    public static bool IsId(string? value) => value is not null && Id().IsMatch(value);

    /// <summary>Parses one bounded UTF-8 JSON value; returns null instead of throwing.</summary>
    public static JsonDocument? Parse(ReadOnlyMemory<byte> utf8, int maxBytes)
    {
        if (utf8.Length == 0 || utf8.Length > maxBytes) return null;
        try { return JsonDocument.Parse(utf8, Options); }
        catch (JsonException) { return null; }
        catch (ArgumentException) { return null; }
    }

    public static bool IsObject(JsonElement value) => value.ValueKind == JsonValueKind.Object;

    /// <summary>Exactly the given keys: all required present, nothing outside required ∪ optional, no duplicates.</summary>
    public static bool HasShape(JsonElement value, IReadOnlyCollection<string> required, IReadOnlyCollection<string> optional)
    {
        if (value.ValueKind != JsonValueKind.Object) return false;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var property in value.EnumerateObject())
        {
            if (!seen.Add(property.Name)) return false;
            if (!Contains(required, property.Name) && !Contains(optional, property.Name)) return false;
        }
        foreach (var key in required) if (!seen.Contains(key)) return false;
        return true;
    }
    static bool Contains(IReadOnlyCollection<string> set, string key)
    {
        if (set is ICollection<string> collection) return collection.Contains(key);
        foreach (var entry in set) if (entry == key) return true;
        return false;
    }

    /// <summary>schema.mjs inspect(): depth, key count, duplicate keys, secret-like keys/text, control characters.</summary>
    public static bool Inspect(JsonElement value, ProtocolManifest manifest, int depth = 0)
    {
        if (depth > Limits.Depth) return false;
        switch (value.ValueKind)
        {
            case JsonValueKind.String:
                var text = value.GetString()!;
                return !Control().IsMatch(text) && !manifest.SecretText.IsMatch(text);
            case JsonValueKind.Number: case JsonValueKind.True: case JsonValueKind.False: case JsonValueKind.Null:
                return true;
            case JsonValueKind.Array:
                foreach (var entry in value.EnumerateArray()) if (!Inspect(entry, manifest, depth + 1)) return false;
                return true;
            case JsonValueKind.Object:
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (var property in value.EnumerateObject())
                {
                    if (!seen.Add(property.Name) || seen.Count > 1024 || manifest.SecretKey.IsMatch(property.Name)) return false;
                    if (!Inspect(property.Value, manifest, depth + 1)) return false;
                }
                return true;
            default:
                return false;
        }
    }

    public static string? String(JsonElement value, string key) =>
        value.ValueKind == JsonValueKind.Object && value.TryGetProperty(key, out var entry) && entry.ValueKind == JsonValueKind.String ? entry.GetString() : null;

    public static bool Integer(JsonElement value, string key, long minimum, long maximum, out long result)
    {
        result = 0;
        return value.ValueKind == JsonValueKind.Object && value.TryGetProperty(key, out var entry) && entry.ValueKind == JsonValueKind.Number
            && entry.TryGetInt64(out result) && result >= minimum && result <= maximum;
    }

    public const long MaxSafeInteger = 9007199254740991L;

    public static bool RelativePath(string? value)
    {
        if (value is null || value.Length == 0 || value.Length > 512) return false;
        foreach (var c in value) if (c == '\\' || c == ':' || c < 0x20) return false;
        foreach (var part in value.Split('/'))
            if (part.Length == 0 || part == "." || part == ".." || part.StartsWith('.') || ReservedSegment().IsMatch(part)) return false;
        return true;
    }

    /// <summary>Port of schema.mjs sanitizeText() without caller-supplied roots or secrets.</summary>
    public static string SanitizeText(string text, ProtocolManifest manifest)
    {
        text = Control().Replace(Ansi().Replace(text, ""), "");
        if (manifest.SecretText.IsMatch(text) || manifest.CredentialAssignment.IsMatch(text)) return "[redacted]";
        return manifest.LocalPath.Replace(text, "[local path]");
    }

    public static bool HasControl(string text) => Control().IsMatch(text);

    public static byte[] Write(Action<Utf8JsonWriter> body)
    {
        var buffer = new ArrayBufferWriter<byte>(256);
        using (var writer = new Utf8JsonWriter(buffer, new JsonWriterOptions { Indented = false, SkipValidation = false }))
        {
            body(writer);
        }
        return buffer.WrittenSpan.ToArray();
    }

    public static string WriteString(Action<Utf8JsonWriter> body) => Encoding.UTF8.GetString(Write(body));
}

/// <summary>Port of schema.mjs projectPublicResult(): explicit key vocabulary, sanitized strings.</summary>
public static class PublicProjection
{
    public static void Write(Utf8JsonWriter writer, JsonElement value, ProtocolManifest manifest, int depth = 0)
    {
        if (depth > Limits.Depth) { writer.WriteNullValue(); return; }
        switch (value.ValueKind)
        {
            case JsonValueKind.String:
                var text = JsonSafety.SanitizeText(value.GetString()!, manifest);
                writer.WriteStringValue(text.Length > 65536 ? text[..65536] : text);
                return;
            case JsonValueKind.Number: value.WriteTo(writer); return;
            case JsonValueKind.True: writer.WriteBooleanValue(true); return;
            case JsonValueKind.False: writer.WriteBooleanValue(false); return;
            case JsonValueKind.Array:
                writer.WriteStartArray();
                var count = 0;
                foreach (var entry in value.EnumerateArray()) { if (count++ >= 1024) break; Write(writer, entry, manifest, depth + 1); }
                writer.WriteEndArray();
                return;
            case JsonValueKind.Object:
                writer.WriteStartObject();
                var seen = new HashSet<string>(StringComparer.Ordinal);
                foreach (var property in value.EnumerateObject())
                {
                    if (!manifest.PublicKeys.Contains(property.Name) || !seen.Add(property.Name)) continue;
                    if (property.Name == "path" && !(property.Value.ValueKind == JsonValueKind.String && JsonSafety.RelativePath(property.Value.GetString()))) continue;
                    if (property.Name == "content" && property.Value.ValueKind != JsonValueKind.String) continue;
                    writer.WritePropertyName(property.Name);
                    Write(writer, property.Value, manifest, depth + 1);
                }
                writer.WriteEndObject();
                return;
            default:
                writer.WriteNullValue();
                return;
        }
    }
}
