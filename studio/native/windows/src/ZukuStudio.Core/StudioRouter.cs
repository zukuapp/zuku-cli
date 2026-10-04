using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;

namespace Zuku.Studio.Core;

/// <summary>Side effects the Windows shell must perform, produced by <see cref="StudioRouter"/>.</summary>
public abstract record RouterAction
{
    /// <summary>Post this JSON to the trusted editor (PostWebMessageAsJson). Never raw host input.</summary>
    public sealed record ToRenderer(string Json) : RouterAction;
    public sealed record OpenPicker(string RequestId) : RouterAction;
    public sealed record ShowPreview(Uri Url, PreviewRect Rect) : RouterAction;
    public sealed record HidePreview : RouterAction;
    public sealed record ShowPrompt(PromptRequest Prompt) : RouterAction;
    public sealed record ClosePrompt(string RequestId) : RouterAction;
    /// <summary>New bytes are queued for the host; wake the writer.</summary>
    public sealed record HostWrite : RouterAction;
    /// <summary>The host broke protocol framing or versioning; stop it.</summary>
    public sealed record HostFault(string Code) : RouterAction;
}

/// <summary>
/// Pure routing state for one Studio window and one stdio host. Single-threaded: call only
/// from the UI dispatcher. Owns the pending table (128 entries, 180 s) and the outgoing queue.
/// </summary>
public sealed class StudioRouter
{
    sealed class Pending
    {
        public required string Method;
        public required string? ReplyTo;      // renderer id to answer, or null for shell-internal requests
        public required long Expires;
        public PreviewRect Rect;
        public long Generation;
    }

    readonly ProtocolManifest manifest;
    readonly Func<long> clock;               // Unix milliseconds
    readonly Dictionary<string, Pending> pending = new(StringComparer.Ordinal);
    string? pickerRequest;
    PromptRequest? prompt;
    long previewGeneration;
    bool hostAvailable = true;

    public StudioRouter(ProtocolManifest manifest, Func<long> clock, OutgoingQueue? queue = null)
    {
        this.manifest = manifest;
        this.clock = clock;
        Outgoing = queue ?? new OutgoingQueue();
    }

    public OutgoingQueue Outgoing { get; }
    public int PendingCount => pending.Count;
    public PromptRequest? ActivePrompt => prompt;
    public bool PickerOpen => pickerRequest is not null;

    // ---------------------------------------------------------------- renderer → shell
    public List<RouterAction> FromRenderer(string? message)
    {
        var actions = new List<RouterAction>();
        var request = RendererGate.Admit(message, manifest);
        if (request is null) return actions;                    // malformed input gets no reply (bridge times out)
        if (!hostAvailable) { actions.Add(Error(request.Id, "HOST_UNAVAILABLE")); return actions; }
        if (pending.ContainsKey(request.Id)) { actions.Add(Error(request.Id, "REQUEST_CONFLICT")); return actions; }
        if (pending.Count >= Limits.PendingLimit) { actions.Add(Error(request.Id, "REQUEST_LIMIT")); return actions; }

        switch (request.Kind)
        {
            case RendererKind.PickProject:
                if (pickerRequest is not null) { actions.Add(Error(request.Id, "REQUEST_LIMIT")); break; }
                pickerRequest = request.Id;
                // The OS dialog may stay open for a while; expiry restarts when the choice is sent.
                pending[request.Id] = new Pending { Method = request.Method, ReplyTo = request.Id, Expires = long.MaxValue };
                actions.Add(new RouterAction.OpenPicker(request.Id));
                break;
            case RendererKind.PreviewHide:
                previewGeneration++;
                actions.Add(new RouterAction.HidePreview());
                actions.Add(Result(request.Id, writer => writer.WriteString("status", "hidden")));
                break;
            case RendererKind.PreviewShow:
                var generation = ++previewGeneration;
                var rect = request.Rect.GetValueOrDefault();
                pending[request.Id] = new Pending { Method = request.Method, ReplyTo = request.Id, Expires = Deadline(), Rect = rect, Generation = generation };
                var handle = request.PreviewHandle!;
                if (!Send(NativeId(), "native.resolvePreview", writer => { writer.WriteStartObject(); writer.WriteString("previewHandle", handle); writer.WriteEndObject(); }, false, request.Id, rect, generation))
                {
                    pending.Remove(request.Id);
                    actions.Add(Error(request.Id, "HOST_QUEUE_FULL"));
                    break;
                }
                actions.Add(new RouterAction.HostWrite());
                break;
            default:
                // Core RPC, native.subscribe and native.unsubscribe go to the host under the renderer's own id.
                pending[request.Id] = new Pending { Method = request.Method, ReplyTo = request.Id, Expires = Deadline() };
                var raw = request.ParamsJson;
                var line = JsonSafety.Write(writer =>
                {
                    writer.WriteStartObject();
                    writer.WriteNumber("protocolVersion", 1);
                    writer.WriteString("id", request.Id);
                    writer.WriteString("method", request.Method);
                    writer.WritePropertyName("params");
                    writer.WriteRawValue(raw, skipInputValidation: false);
                    writer.WriteEndObject();
                });
                if (!Outgoing.TryEnqueue(line, false)) { pending.Remove(request.Id); actions.Add(Error(request.Id, "HOST_QUEUE_FULL")); break; }
                actions.Add(new RouterAction.HostWrite());
                break;
        }
        return actions;
    }

    // ---------------------------------------------------------------- native UI → shell
    /// <summary>The folder picker closed. canonicalPath is null when cancelled or refused by policy.</summary>
    public List<RouterAction> PickerCompleted(string requestId, string? canonicalPath, string? refusal = null)
    {
        var actions = new List<RouterAction>();
        if (pickerRequest != requestId) return actions;
        pickerRequest = null;
        if (!pending.TryGetValue(requestId, out var entry)) return actions;
        if (canonicalPath is null || !hostAvailable)
        {
            pending.Remove(requestId);
            actions.Add(Error(requestId, !hostAvailable ? "HOST_UNAVAILABLE" : refusal is not null && JsonSafety.Code().IsMatch(refusal) ? refusal : "COMMAND_CANCELLED"));
            return actions;
        }
        entry.Expires = Deadline();
        var nativeId = NativeId();
        if (!Send(nativeId, "native.projectChosen", writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("requestId", requestId);
            writer.WriteString("localPath", canonicalPath);
            writer.WriteEndObject();
        }, false, requestId))
        {
            pending.Remove(requestId);
            actions.Add(Error(requestId, "HOST_QUEUE_FULL"));
            return actions;
        }
        actions.Add(new RouterAction.HostWrite());
        return actions;
    }

    public List<RouterAction> PairingDecided(string requestId, bool allow)
    {
        var actions = new List<RouterAction>();
        if (prompt is not { Kind: PromptKind.Pairing } || prompt.RequestId != requestId) return actions;
        prompt = null;
        if (Send(NativeId(), "native.pairingDecision", writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("requestId", requestId);
            writer.WriteBoolean("allow", allow);
            writer.WriteEndObject();
        }, false, null)) actions.Add(new RouterAction.HostWrite());
        return actions;
    }

    /// <summary>Sends the masked credential (empty string = refused). The serialized line is zeroed after writing.</summary>
    public List<RouterAction> AuthAnswered(string requestId, string value)
    {
        var actions = new List<RouterAction>();
        if (prompt is not { Kind: PromptKind.Auth } || prompt.RequestId != requestId) return actions;
        prompt = null;
        if (value.Length > Limits.SecretValueChars || JsonSafety.HasControl(value)) value = "";
        if (Send(NativeId(), "native.authResponse", writer =>
        {
            writer.WriteStartObject();
            writer.WriteString("requestId", requestId);
            writer.WriteString("value", value);
            writer.WriteEndObject();
        }, true, null)) actions.Add(new RouterAction.HostWrite());
        return actions;
    }

    // ---------------------------------------------------------------- host → shell
    public List<RouterAction> FromHost(ReadOnlyMemory<byte> line)
    {
        var actions = new List<RouterAction>();
        using var document = JsonSafety.Parse(line, Limits.IncomingLineBytes);
        if (document is null || document.RootElement.ValueKind != JsonValueKind.Object || !JsonSafety.Integer(document.RootElement, "protocolVersion", 1, 1, out _))
        {
            actions.Add(new RouterAction.HostFault("HOST_PROTOCOL_MISMATCH"));
            return actions;
        }
        var root = document.RootElement;
        var id = JsonSafety.String(root, "id");
        if (id is not null)
        {
            if (JsonSafety.IsId(id) && pending.Remove(id, out var entry)) Response(root, id, entry, actions);
            return actions;
        }
        var type = JsonSafety.String(root, "type");
        if (type is null || !root.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object) return actions;
        switch (type)
        {
            case "native.pairing": case "native.auth":
                Prompt(type, data, actions);
                break;
            case "native.pairingClosed": case "native.authClosed":
                if (prompt is not null && PromptPolicy.RequestId(data) == prompt.RequestId
                    && (type == "native.pairingClosed") == (prompt.Kind == PromptKind.Pairing))
                {
                    actions.Add(new RouterAction.ClosePrompt(prompt.RequestId));
                    prompt = null;
                }
                break;
            case "native.subscription":
                if (Subscription(data) is { } json) actions.Add(new RouterAction.ToRenderer(json));
                break;
        }
        return actions;
    }

    void Response(JsonElement root, string id, Pending entry, List<RouterAction> actions)
    {
        var reply = entry.ReplyTo;
        // A shell-internal request answers a renderer request only while that request is still open.
        if (reply is not null && reply != id && !pending.Remove(reply)) reply = null;
        var preview = entry.Method is "native.resolvePreview" or "native.previewShow";
        if (root.TryGetProperty("error", out var error))
        {
            if (preview && entry.Generation == previewGeneration) actions.Add(new RouterAction.HidePreview());
            if (reply is not null) actions.Add(SafeError(reply, error));
            return;
        }
        root.TryGetProperty("result", out var result);
        if (preview)
        {
            // The read-only URL is consumed natively and never forwarded to the renderer.
            var url = PreviewPolicy.Admit(JsonSafety.String(result, "url") ?? JsonSafety.String(result, "readonlyURL"));
            if (url is not null && entry.Generation == previewGeneration)
            {
                actions.Add(new RouterAction.ShowPreview(url, entry.Rect));
                if (reply is not null) actions.Add(Result(reply, writer => writer.WriteString("status", "shown")));
            }
            else if (reply is not null) actions.Add(Error(reply, "TOOL_UNAVAILABLE"));
            return;
        }
        if (reply is null) return;
        actions.Add(new RouterAction.ToRenderer(JsonSafety.WriteString(writer =>
        {
            writer.WriteStartObject();
            writer.WriteNumber("protocolVersion", 1);
            writer.WriteString("id", reply);
            writer.WritePropertyName("result");
            if (result.ValueKind == JsonValueKind.Undefined) writer.WriteNullValue();
            else PublicProjection.Write(writer, result, manifest);
            writer.WriteEndObject();
        })));
    }

    void Prompt(string type, JsonElement data, List<RouterAction> actions)
    {
        var pairing = type == "native.pairing";
        var request = pairing ? PromptPolicy.Pairing(data, clock()) : PromptPolicy.Auth(data, clock(), manifest);
        var requestId = PromptPolicy.RequestId(data);
        if (request is not null && prompt is null)
        {
            prompt = request;
            actions.Add(new RouterAction.ShowPrompt(request));
            return;
        }
        // Invalid, expired or concurrent: refuse immediately (default is refusal).
        if (requestId is null || prompt?.RequestId == requestId) return;
        var sent = pairing
            ? Send(NativeId(), "native.pairingDecision", writer => { writer.WriteStartObject(); writer.WriteString("requestId", requestId); writer.WriteBoolean("allow", false); writer.WriteEndObject(); }, false, null)
            : Send(NativeId(), "native.authResponse", writer => { writer.WriteStartObject(); writer.WriteString("requestId", requestId); writer.WriteString("value", ""); writer.WriteEndObject(); }, false, null);
        if (sent) actions.Add(new RouterAction.HostWrite());
    }

    static readonly string[] SubscriptionEvent = ["subscriptionId", "event"];
    static readonly string[] SubscriptionStatus = ["subscriptionId", "status"];
    static readonly string[] EventEnvelope = ["protocolVersion", "sessionId", "sequence", "eventId", "time", "type", "data"];
    static readonly HashSet<string> StatusStates = new(StringComparer.Ordinal) { "connected", "disconnected", "cursor_expired", "closed" };
    static readonly System.Text.RegularExpressions.Regex Time = new("^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    string? Subscription(JsonElement data)
    {
        var subscription = JsonSafety.String(data, "subscriptionId");
        if (!JsonSafety.IsId(subscription)) return null;
        if (JsonSafety.HasShape(data, SubscriptionEvent, []))
        {
            var envelope = data.GetProperty("event");
            if (!ValidEvent(envelope)) return null;
            var raw = envelope.GetRawText();
            return JsonSafety.WriteString(writer =>
            {
                writer.WriteStartObject();
                writer.WriteNumber("protocolVersion", 1);
                writer.WriteString("type", "native.subscription");
                writer.WriteStartObject("data");
                writer.WriteString("subscriptionId", subscription);
                writer.WritePropertyName("event");
                writer.WriteRawValue(raw);
                writer.WriteEndObject();
                writer.WriteEndObject();
            });
        }
        if (!JsonSafety.HasShape(data, SubscriptionStatus, [])) return null;
        var status = data.GetProperty("status");
        if (JsonSafety.String(status, "kind") != "status" || JsonSafety.String(status, "state") is not { } state || !StatusStates.Contains(state)) return null;
        var hasMinimum = JsonSafety.Integer(status, "minimumSequence", 0, JsonSafety.MaxSafeInteger, out var minimum);
        return JsonSafety.WriteString(writer =>
        {
            writer.WriteStartObject();
            writer.WriteNumber("protocolVersion", 1);
            writer.WriteString("type", "native.subscription");
            writer.WriteStartObject("data");
            writer.WriteString("subscriptionId", subscription);
            writer.WriteStartObject("status");
            writer.WriteString("kind", "status");
            writer.WriteString("state", state);
            if (hasMinimum) writer.WriteNumber("minimumSequence", minimum);
            writer.WriteEndObject();
            writer.WriteEndObject();
            writer.WriteEndObject();
        });
    }

    /// <summary>Envelope + per-type key shape + inspect + 32 KiB, as schema.mjs validateEvent (values re-checked by the renderer).</summary>
    public bool ValidEvent(JsonElement envelope)
    {
        if (!JsonSafety.HasShape(envelope, EventEnvelope, []) || !JsonSafety.Inspect(envelope, manifest)) return false;
        if (System.Text.Encoding.UTF8.GetByteCount(envelope.GetRawText()) > Limits.EventBytes) return false;
        if (!JsonSafety.Integer(envelope, "protocolVersion", 1, 1, out _) || !JsonSafety.Integer(envelope, "sequence", 1, JsonSafety.MaxSafeInteger, out _)) return false;
        if (!JsonSafety.IsId(JsonSafety.String(envelope, "sessionId")) || !JsonSafety.IsId(JsonSafety.String(envelope, "eventId"))) return false;
        if (JsonSafety.String(envelope, "time") is not { } time || !Time.IsMatch(time)) return false;
        if (JsonSafety.String(envelope, "type") is not { } type || !manifest.Events.TryGetValue(type, out var shape)) return false;
        return JsonSafety.HasShape(envelope.GetProperty("data"), shape.Required, shape.Optional);
    }

    // ---------------------------------------------------------------- lifecycle
    /// <summary>Expires stale requests (call every few seconds).</summary>
    public List<RouterAction> Tick()
    {
        var actions = new List<RouterAction>();
        var now = Environment.TickCount64;
        foreach (var (id, entry) in pending.Where(pair => pair.Value.Expires <= now).ToList())
        {
            pending.Remove(id);
            if (entry.ReplyTo == id) actions.Add(Error(id, "HOST_TIMEOUT"));
        }
        return actions;
    }

    /// <summary>The host exited or faulted: fail every open renderer request, close prompts, refuse new work.</summary>
    public List<RouterAction> HostUnavailable()
    {
        var actions = new List<RouterAction>();
        hostAvailable = false;
        foreach (var (id, entry) in pending.ToList()) if (entry.ReplyTo == id) actions.Add(Error(id, "HOST_UNAVAILABLE"));
        pending.Clear();
        pickerRequest = null;
        if (prompt is not null) { actions.Add(new RouterAction.ClosePrompt(prompt.RequestId)); prompt = null; }
        previewGeneration++;
        actions.Add(new RouterAction.HidePreview());
        Outgoing.Close();
        return actions;
    }

    // ---------------------------------------------------------------- helpers
    static long Deadline() => Environment.TickCount64 + Limits.PendingSeconds * 1000L;

    static string NativeId() => "native_" + Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16));

    bool Send(string id, string method, Action<Utf8JsonWriter> parameters, bool sensitive, string? replyTo, PreviewRect rect = default, long generation = 0)
    {
        if (pending.Count >= Limits.PendingLimit || !hostAvailable) return false;
        var line = JsonSafety.Write(writer =>
        {
            writer.WriteStartObject();
            writer.WriteNumber("protocolVersion", 1);
            writer.WriteString("id", id);
            writer.WriteString("method", method);
            writer.WritePropertyName("params");
            parameters(writer);
            writer.WriteEndObject();
        });
        var queued = Outgoing.TryEnqueue(line, sensitive);
        if (sensitive) CryptographicOperations.ZeroMemory(line);
        if (!queued) return false;
        pending[id] = new Pending { Method = method, ReplyTo = replyTo, Expires = Deadline(), Rect = rect, Generation = generation };
        return true;
    }

    static RouterAction Result(string id, Action<Utf8JsonWriter> fields) => new RouterAction.ToRenderer(JsonSafety.WriteString(writer =>
    {
        writer.WriteStartObject();
        writer.WriteNumber("protocolVersion", 1);
        writer.WriteString("id", id);
        writer.WriteStartObject("result");
        fields(writer);
        writer.WriteEndObject();
        writer.WriteEndObject();
    }));

    static RouterAction Error(string id, string code) => new RouterAction.ToRenderer(JsonSafety.WriteString(writer =>
    {
        writer.WriteStartObject();
        writer.WriteNumber("protocolVersion", 1);
        writer.WriteString("id", id);
        writer.WriteStartObject("error");
        writer.WriteString("code", code);
        writer.WriteEndObject();
        writer.WriteEndObject();
    }));

    static readonly HashSet<string> ErrorActions = new(StringComparer.Ordinal) { "login", "update", "retry", "inspect_project", "recover_deployment" };

    /// <summary>Only {code, action?, retryAfterMs?} from the closed vocabulary reaches the renderer.</summary>
    static RouterAction SafeError(string id, JsonElement error) => new RouterAction.ToRenderer(JsonSafety.WriteString(writer =>
    {
        var code = JsonSafety.String(error, "code");
        var action = JsonSafety.String(error, "action");
        writer.WriteStartObject();
        writer.WriteNumber("protocolVersion", 1);
        writer.WriteString("id", id);
        writer.WriteStartObject("error");
        writer.WriteString("code", code is not null && JsonSafety.Code().IsMatch(code) ? code : "CORE_OPERATION_FAILED");
        if (action is not null && ErrorActions.Contains(action)) writer.WriteString("action", action);
        if (JsonSafety.Integer(error, "retryAfterMs", 0, 21600000, out var retry)) writer.WriteNumber("retryAfterMs", retry);
        writer.WriteEndObject();
        writer.WriteEndObject();
    }));
}
