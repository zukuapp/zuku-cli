using System;
using System.Text;
using System.Text.Json;

namespace Zuku.Studio.Core;

public enum RendererKind { Core, Subscribe, Unsubscribe, PickProject, PreviewShow, PreviewHide }

public readonly record struct PreviewRect(int X, int Y, int Width, int Height);

/// <summary>One admitted renderer request. ParamsJson is the validated, re-serialized params object.</summary>
public sealed record RendererRequest(RendererKind Kind, string Id, string Method, string ParamsJson, string? PreviewHandle = null, PreviewRect? Rect = null);

/// <summary>
/// Native admission of window.zukuStudio messages ({protocolVersion:1,id,method,params}).
/// Core methods: bridge.js allowlist with schema key shapes; the stdio host re-validates every
/// value with the same schema.mjs. native.*: exact shapes. Private native methods
/// (project.grant, native.projectChosen, native.resolvePreview, decisions, credentials) never pass.
/// </summary>
public static class RendererGate
{
    static readonly string[] Envelope = ["protocolVersion", "id", "method", "params"];
    static readonly string[] None = [];
    static readonly string[] SubscribeKeys = ["subscriptionId", "sessionId", "afterSequence"];
    static readonly string[] UnsubscribeKeys = ["subscriptionId"];
    static readonly string[] PreviewKeys = ["previewHandle", "rect"];
    static readonly string[] RectKeys = ["x", "y", "width", "height"];

    public static RendererRequest? Admit(string? message, ProtocolManifest manifest)
    {
        if (message is null || message.Length > Limits.RendererMessageBytes) return null;
        var bytes = Encoding.UTF8.GetBytes(message);
        using var document = JsonSafety.Parse(bytes, Limits.RendererMessageBytes);
        if (document is null) return null;
        var root = document.RootElement;
        if (!JsonSafety.HasShape(root, Envelope, None) || !JsonSafety.Inspect(root, manifest)) return null;
        if (!JsonSafety.Integer(root, "protocolVersion", 1, 1, out _)) return null;
        var id = JsonSafety.String(root, "id");
        var method = JsonSafety.String(root, "method");
        // Renderer ids can never impersonate the shell's own native_ request ids.
        if (!JsonSafety.IsId(id) || id!.StartsWith("native_", StringComparison.Ordinal) || method is null) return null;
        var parameters = root.GetProperty("params");
        if (parameters.ValueKind != JsonValueKind.Object) return null;
        if (manifest.NativePrivate.Contains(method)) return null;

        switch (method)
        {
            case "native.pickProject":
                return JsonSafety.HasShape(parameters, None, None) ? new(RendererKind.PickProject, id, method, "{}") : null;
            case "native.previewHide":
                return JsonSafety.HasShape(parameters, None, None) ? new(RendererKind.PreviewHide, id, method, "{}") : null;
            case "native.subscribe":
                if (!JsonSafety.HasShape(parameters, SubscribeKeys, None) || !JsonSafety.IsId(JsonSafety.String(parameters, "subscriptionId"))
                    || !JsonSafety.IsId(JsonSafety.String(parameters, "sessionId")) || !JsonSafety.Integer(parameters, "afterSequence", 0, JsonSafety.MaxSafeInteger, out _)) return null;
                return new(RendererKind.Subscribe, id, method, parameters.GetRawText());
            case "native.unsubscribe":
                if (!JsonSafety.HasShape(parameters, UnsubscribeKeys, None) || !JsonSafety.IsId(JsonSafety.String(parameters, "subscriptionId"))) return null;
                return new(RendererKind.Unsubscribe, id, method, parameters.GetRawText());
            case "native.previewShow":
                if (!JsonSafety.HasShape(parameters, PreviewKeys, None)) return null;
                var handle = JsonSafety.String(parameters, "previewHandle");
                var rect = parameters.GetProperty("rect");
                if (!JsonSafety.IsId(handle) || !JsonSafety.HasShape(rect, RectKeys, None)) return null;
                if (!JsonSafety.Integer(rect, "x", 0, 16384, out var x) || !JsonSafety.Integer(rect, "y", 0, 16384, out var y)
                    || !JsonSafety.Integer(rect, "width", 16, 16384, out var width) || !JsonSafety.Integer(rect, "height", 16, 16384, out var height)) return null;
                return new(RendererKind.PreviewShow, id, method, "{}", handle, new PreviewRect((int)x, (int)y, (int)width, (int)height));
        }
        if (method.StartsWith("native.", StringComparison.Ordinal)) return null;
        if (!manifest.RendererMethods.TryGetValue(method, out var shape)) return null;
        if (!JsonSafety.HasShape(parameters, shape.Required, shape.Optional)) return null;
        return new(RendererKind.Core, id, method, parameters.GetRawText());
    }
}
