using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace Zuku.Studio.Core;

/// <summary>
/// Native protocol self-test. Pure checks need nothing; the stdio group starts the labeled
/// synthetic fixture (tests/stdio-fixture.mjs) with a given Node — never the real Agent Core.
/// </summary>
public static class SelfTest
{
    sealed class Run(TextWriter output)
    {
        public int Passed, Failed;
        public void Check(bool condition, string label, [CallerLineNumber] int line = 0)
        {
            if (condition) { Passed++; return; }
            Failed++;
            output.WriteLine($"FAIL {label} (SelfTest.cs:{line})");
        }
    }

    public static async Task<int> RunAsync(TextWriter output, string? node = null, string? fixture = null)
    {
        var run = new Run(output);
        var manifest = ProtocolManifest.Current;
        Manifest(run, manifest);
        Gate(run, manifest);
        Routing(run, manifest);
        Prompts(run, manifest);
        Subscriptions(run, manifest);
        Bounds(run);
        Policies(run);
        Locator(run, output);
        var stdio = node is not null && fixture is not null;
        if (stdio) await Stdio(run, manifest, node!, fixture!);
        output.WriteLine($"Studio Windows native protocol: {run.Passed} checks passed, {run.Failed} failed"
            + (stdio ? "; stdio group used the SYNTHETIC fixture, not the real Agent Core." : "; stdio group not run (no --node/--fixture)."));
        return run.Failed;
    }

    static string Req(string id, string method, string parameters) => $"{{\"protocolVersion\":1,\"id\":\"{id}\",\"method\":\"{method}\",\"params\":{parameters}}}";

    static JsonElement Json(string text) { using var document = JsonDocument.Parse(text); return document.RootElement.Clone(); }

    static List<JsonElement> Drain(StudioRouter router)
    {
        var lines = new List<JsonElement>();
        while (router.Outgoing.TryPeek(out var entry) && entry is not null)
        {
            lines.Add(Json(Encoding.UTF8.GetString(entry.Bytes, 0, entry.Bytes.Length - 1)));
            router.Outgoing.Complete(entry);
        }
        return lines;
    }

    static List<string> Renderer(IEnumerable<RouterAction> actions) => actions.OfType<RouterAction.ToRenderer>().Select(action => action.Json).ToList();

    static ReadOnlyMemory<byte> Line(string json) => Encoding.UTF8.GetBytes(json);

    static void Manifest(Run run, ProtocolManifest manifest)
    {
        run.Check(manifest.RendererMethods.ContainsKey("session.input") && manifest.RendererMethods.ContainsKey("project.list"), "manifest has core renderer methods");
        run.Check(!manifest.RendererMethods.ContainsKey("project.grant") && manifest.NativePrivate.Contains("project.grant"), "project.grant is native-private");
        run.Check(manifest.Events.ContainsKey("agent.delta") && manifest.Events.Count == 23, "23 shared event types");
        run.Check(manifest.SecretKey.IsMatch("apiKey") && manifest.SecretKey.IsMatch("ACCESS_TOKEN") && !manifest.SecretKey.IsMatch("projectHandle"), "secret key pattern");
        run.Check(manifest.SecretText.IsMatch("Bearer abcdefghijklmnopqrstuvwxyz") && !manifest.SecretText.IsMatch("게임 점프 동작 추가"), "secret text pattern");
    }

    static void Gate(Run run, ProtocolManifest manifest)
    {
        string[] valid =
        [
            Req("ui_1", "project.list", "{}"),
            Req("ui_2", "session.input", "{\"sessionId\":\"session_1\",\"requestId\":\"input_1\",\"operation\":\"game.maintain\",\"request\":\"플레이어 이동에 대시 기능 추가해줘\",\"experimental\":false}"),
            Req("ui_3", "auth.request", "{\"providerId\":\"codex\",\"experimental\":true}"),
            Req("ui_4", "native.subscribe", "{\"subscriptionId\":\"sub_1\",\"sessionId\":\"session_1\",\"afterSequence\":0}"),
            Req("ui_5", "native.unsubscribe", "{\"subscriptionId\":\"sub_1\"}"),
            Req("ui_6", "native.pickProject", "{}"),
            Req("ui_7", "native.previewShow", "{\"previewHandle\":\"preview_1\",\"rect\":{\"x\":0,\"y\":10,\"width\":320,\"height\":240}}"),
            Req("ui_8", "native.previewHide", "{}"),
            Req("ui_9", "provider.add", "{\"config\":{\"id\":\"local\",\"apiType\":\"openai-chat\",\"baseUrl\":\"http://127.0.0.1:1234/v1\"}}"),
        ];
        foreach (var message in valid) run.Check(RendererGate.Admit(message, manifest) is not null, "admit " + message[..Math.Min(60, message.Length)]);
        string[] invalid =
        [
            "[]", "{", "null", "",
            Req("ui_1", "project.open", "{\"path\":\"C:\\\\Windows\"}"),
            Req("ui_1", "project.grant", "{\"localPath\":\"C:\\\\games\\\\a\"}"),
            Req("ui_1", "native.projectChosen", "{\"requestId\":\"ui_0\",\"localPath\":\"C:\\\\games\\\\a\"}"),
            Req("ui_1", "native.resolvePreview", "{\"previewHandle\":\"preview_1\"}"),
            Req("ui_1", "native.pairingDecision", "{\"requestId\":\"pair_1\",\"allow\":true}"),
            Req("ui_1", "native.authResponse", "{\"requestId\":\"auth_1\",\"value\":\"x\"}"),
            Req("ui_1", "preview.read", "{\"previewHandle\":\"preview_1\",\"path\":\"index.html\"}"),
            Req("ui_1", "studio.open", "{}"),
            Req("ui_1", "pair.decide", "{\"allow\":true}"),
            Req("ui_1", "session.input", "{\"sessionId\":\"session_1\",\"requestId\":\"input_1\",\"operation\":\"game.maintain\",\"request\":\"x\",\"command\":\"cmd /c whoami\"}"),
            Req("ui_1", "auth.request", "{\"providerId\":\"codex\",\"apiKey\":\"secret\"}"),
            Req("ui_1", "session.input", "{\"sessionId\":\"session_1\",\"requestId\":\"input_1\",\"operation\":\"game.maintain\",\"request\":\"use sk-proj-abcdefghijklmnopqrstuvwxyz123456\"}"),
            Req("native_1", "project.list", "{}"),
            Req(new string('a', 129), "project.list", "{}"),
            "{\"protocolVersion\":0,\"id\":\"ui_1\",\"method\":\"project.list\",\"params\":{}}",
            "{\"protocolVersion\":1,\"id\":\"ui_1\",\"id\":\"ui_2\",\"method\":\"project.list\",\"params\":{}}",
            "{\"protocolVersion\":1,\"id\":\"ui_1\",\"method\":\"project.list\",\"params\":{},\"extra\":1}",
            Req("ui_1", "native.subscribe", "{\"subscriptionId\":\"sub_1\",\"sessionId\":\"session_1\",\"afterSequence\":-1}"),
            Req("ui_1", "native.subscribe", "{\"subscriptionId\":\"sub_1\",\"sessionId\":\"session_1\",\"afterSequence\":1.5}"),
            Req("ui_1", "native.previewShow", "{\"previewHandle\":\"preview_1\",\"rect\":{\"x\":0,\"y\":0,\"width\":15,\"height\":240}}"),
            Req("ui_1", "native.previewShow", "{\"previewHandle\":\"preview_1\",\"rect\":{\"x\":0,\"y\":0,\"width\":20,\"height\":20,\"z\":1}}"),
            Req("ui_1", "native.previewShow", "{\"previewHandle\":\"preview_1\",\"url\":\"http://127.0.0.1:1/p/x/\",\"rect\":{\"x\":0,\"y\":0,\"width\":20,\"height\":20}}"),
            Req("ui_1", "native.pickProject", "{\"localPath\":\"C:\\\\\"}"),
            Req("ui_1", "project.list", "{\"__proto__\":{}}"),
            Req("ui_1", "project.list", "{}") + new string(' ', Limits.RendererMessageBytes),
        ];
        foreach (var message in invalid) run.Check(RendererGate.Admit(message, manifest) is null, "reject " + message[..Math.Min(60, message.Length)]);
    }

    static void Routing(Run run, ProtocolManifest manifest)
    {
        var router = new StudioRouter(manifest, () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        var actions = router.FromRenderer(Req("ui_list", "project.list", "{}"));
        var sent = Drain(router);
        run.Check(actions.OfType<RouterAction.HostWrite>().Any() && sent.Count == 1 && sent[0].GetProperty("id").GetString() == "ui_list" && sent[0].GetProperty("method").GetString() == "project.list", "core call forwarded under renderer id");
        run.Check(Renderer(router.FromRenderer(Req("ui_list", "project.list", "{}"))).Single().Contains("REQUEST_CONFLICT"), "duplicate pending id refused");
        Drain(router);
        var reply = Renderer(router.FromHost(Line("{\"protocolVersion\":1,\"id\":\"ui_list\",\"result\":{\"projects\":[{\"projectHandle\":\"project_1\",\"name\":\"Game\",\"path\":\"C:\\\\Users\\\\me\\\\game\",\"apiKey\":\"leak\",\"token\":\"x\"}],\"note\":\"saved in C:\\\\Users\\\\me\\\\x and Bearer abcdefghijklmnopqrstuvwxyz\"}}"))).Single();
        run.Check(reply.Contains("project_1") && !reply.Contains("apiKey") && !reply.Contains("Users") && !reply.Contains("\"token\"") && !reply.Contains("note"), "result projected to public vocabulary");
        run.Check(Renderer(router.FromHost(Line("{\"protocolVersion\":1,\"id\":\"ui_list\",\"result\":{}}"))).Count == 0, "late duplicate response ignored");

        router.FromRenderer(Req("ui_err", "hello", "{}")); Drain(router);
        var error = Renderer(router.FromHost(Line("{\"protocolVersion\":1,\"id\":\"ui_err\",\"error\":{\"code\":\"AUTH_REQUIRED\",\"action\":\"login\",\"message\":\"at C:\\\\secret\",\"retryAfterMs\":5}}"))).Single();
        run.Check(error.Contains("AUTH_REQUIRED") && error.Contains("login") && !error.Contains("secret") && !error.Contains("message"), "error reduced to code/action/retryAfterMs");
        router.FromRenderer(Req("ui_err2", "hello", "{}")); Drain(router);
        run.Check(Renderer(router.FromHost(Line("{\"protocolVersion\":1,\"id\":\"ui_err2\",\"error\":{\"code\":\"not a code\"}}"))).Single().Contains("CORE_OPERATION_FAILED"), "unsafe error code replaced");

        // Preview: renderer never sees the URL; the native side gets it only for the current generation.
        router.FromRenderer(Req("ui_prev", "native.previewShow", "{\"previewHandle\":\"preview_1\",\"rect\":{\"x\":4,\"y\":8,\"width\":320,\"height\":200}}"));
        var resolve = Drain(router).Single();
        var resolveId = resolve.GetProperty("id").GetString()!;
        run.Check(resolve.GetProperty("method").GetString() == "native.resolvePreview" && resolveId.StartsWith("native_") && resolve.GetProperty("params").GetProperty("previewHandle").GetString() == "preview_1", "previewShow intercepted as native.resolvePreview");
        var shown = router.FromHost(Line($"{{\"protocolVersion\":1,\"id\":\"{resolveId}\",\"result\":{{\"url\":\"http://127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/\"}}}}"));
        var show = shown.OfType<RouterAction.ShowPreview>().SingleOrDefault();
        run.Check(show is not null && show.Rect == new PreviewRect(4, 8, 320, 200) && show.Url.Port == 45678, "native preview shown at rect");
        run.Check(Renderer(shown).Single() is { } previewReply && previewReply.Contains("\"shown\"") && !previewReply.Contains("127.0.0.1") && previewReply.Contains("ui_prev"), "renderer gets status only, no URL");
        router.FromRenderer(Req("ui_prev2", "native.previewShow", "{\"previewHandle\":\"preview_1\",\"rect\":{\"x\":0,\"y\":0,\"width\":320,\"height\":200}}"));
        var stale = Drain(router).Single().GetProperty("id").GetString()!;
        router.FromRenderer(Req("ui_hide", "native.previewHide", "{}"));
        var late = router.FromHost(Line($"{{\"protocolVersion\":1,\"id\":\"{stale}\",\"result\":{{\"url\":\"http://127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/\"}}}}"));
        run.Check(!late.OfType<RouterAction.ShowPreview>().Any() && Renderer(late).Single().Contains("TOOL_UNAVAILABLE"), "stale preview generation not shown");
        foreach (var url in new[] { "http://127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/?t=1", "http://localhost:45678/p/0123456789abcdef0123456789abcdef/", "https://127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/", "http://user@127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/", "http://127.0.0.1:45678/private" })
        {
            router.FromRenderer(Req("ui_badurl", "native.previewShow", "{\"previewHandle\":\"preview_1\",\"rect\":{\"x\":0,\"y\":0,\"width\":320,\"height\":200}}"));
            var bad = Drain(router).Single().GetProperty("id").GetString()!;
            var result = router.FromHost(Line(JsonSerializer.Serialize(new { protocolVersion = 1, id = bad, result = new { url } })));
            run.Check(!result.OfType<RouterAction.ShowPreview>().Any() && Renderer(result).Single().Contains("TOOL_UNAVAILABLE"), "reject preview url " + url);
        }

        // Project picker: OS chooser, protected native.projectChosen, host answers the original UI id.
        var open = router.FromRenderer(Req("ui_pick", "native.pickProject", "{}"));
        run.Check(open.OfType<RouterAction.OpenPicker>().Single().RequestId == "ui_pick" && Drain(router).Count == 0, "pickProject opens the OS chooser without host traffic");
        run.Check(Renderer(router.FromRenderer(Req("ui_pick2", "native.pickProject", "{}"))).Single().Contains("REQUEST_LIMIT"), "one picker at a time");
        router.PickerCompleted("ui_pick", @"C:\Games\Dash");
        var chosen = Drain(router).Single();
        run.Check(chosen.GetProperty("method").GetString() == "native.projectChosen" && chosen.GetProperty("id").GetString()!.StartsWith("native_")
            && chosen.GetProperty("params").GetProperty("requestId").GetString() == "ui_pick" && chosen.GetProperty("params").GetProperty("localPath").GetString() == @"C:\Games\Dash", "native.projectChosen carries picker id and canonical path");
        var picked = Renderer(router.FromHost(Line("{\"protocolVersion\":1,\"id\":\"ui_pick\",\"result\":{\"projectHandle\":\"project_9\",\"name\":\"Dash\",\"path\":\"C:\\\\Games\\\\Dash\"}}"))).Single();
        run.Check(picked.Contains("project_9") && !picked.Contains("Games"), "picker result returned without local path");
        router.FromRenderer(Req("ui_pick3", "native.pickProject", "{}"));
        run.Check(Renderer(router.PickerCompleted("ui_pick3", null)).Single().Contains("COMMAND_CANCELLED"), "cancelled picker rejects with COMMAND_CANCELLED");
        router.FromRenderer(Req("ui_pick4", "native.pickProject", "{}"));
        run.Check(Renderer(router.PickerCompleted("ui_pick4", null, "PROJECT_PATH_SENSITIVE")).Single().Contains("PROJECT_PATH_SENSITIVE"), "policy refusal code surfaced");

        run.Check(router.FromHost(Line("{\"protocolVersion\":2,\"id\":\"x\"}")).OfType<RouterAction.HostFault>().Any(), "protocol mismatch faults host");
        run.Check(router.FromHost(Line("not json")).OfType<RouterAction.HostFault>().Any(), "malformed line faults host");
        router.FromRenderer(Req("ui_open", "hello", "{}")); Drain(router);
        var down = router.HostUnavailable();
        run.Check(Renderer(down).Any(json => json.Contains("ui_open") && json.Contains("HOST_UNAVAILABLE")) && router.PendingCount == 0, "host loss fails pending requests");
        run.Check(Renderer(router.FromRenderer(Req("ui_after", "hello", "{}"))).Single().Contains("HOST_UNAVAILABLE"), "no new work after host loss");
    }

    static void Prompts(Run run, ProtocolManifest manifest)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var router = new StudioRouter(manifest, () => now);
        string Pairing(string id, string origin = PromptPolicy.Origin, long? expires = null, string extra = "") =>
            $"{{\"protocolVersion\":1,\"type\":\"native.pairing\",\"data\":{{\"requestId\":\"{id}\",\"challengeId\":\"challenge_1\",\"origin\":\"{origin}\",\"purpose\":\"browser.connect\",\"expiresAt\":{expires ?? now + 60000}{extra}}}}}";
        var prompt = router.FromHost(Line(Pairing("pair_1"))).OfType<RouterAction.ShowPrompt>().SingleOrDefault();
        run.Check(prompt is not null && prompt.Prompt.Kind == PromptKind.Pairing && Drain(router).Count == 0, "pairing shows native prompt");
        router.FromHost(Line(Pairing("pair_2")));
        var concurrent = Drain(router).Single();
        run.Check(concurrent.GetProperty("method").GetString() == "native.pairingDecision" && concurrent.GetProperty("params").GetProperty("allow").GetBoolean() == false, "concurrent pairing refused");
        router.PairingDecided("pair_1", true);
        var decision = Drain(router).Single().GetProperty("params");
        run.Check(decision.GetProperty("requestId").GetString() == "pair_1" && decision.GetProperty("allow").GetBoolean(), "approval sent only after native decision");
        run.Check(router.PairingDecided("pair_1", true).Count == 0 && Drain(router).Count == 0, "decision cannot be replayed");
        foreach (var bad in new[] { Pairing("pair_3", "https://evil.example"), Pairing("pair_4", expires: now - 1), Pairing("pair_5", expires: now + 600000), Pairing("pair_6", extra: ",\"projectName\":\"<b>x</b>\"") })
        {
            run.Check(!router.FromHost(Line(bad)).OfType<RouterAction.ShowPrompt>().Any(), "pairing refused: invalid");
            run.Check(Drain(router).Single().GetProperty("params").GetProperty("allow").GetBoolean() == false, "invalid pairing answered with refusal");
        }
        router.FromHost(Line(Pairing("pair_7")));
        var closed = router.FromHost(Line("{\"protocolVersion\":1,\"type\":\"native.pairingClosed\",\"data\":{\"requestId\":\"pair_7\"}}"));
        run.Check(closed.OfType<RouterAction.ClosePrompt>().Single().RequestId == "pair_7" && router.ActivePrompt is null, "host-closed pairing closes dialog");

        string Auth(string id, string extra) => $"{{\"protocolVersion\":1,\"type\":\"native.auth\",\"data\":{{\"requestId\":\"{id}\",\"providerId\":\"codex\",\"methodId\":\"compat_login\",\"question\":\"Codex 로그인 코드를 입력하세요\",\"expiresAt\":{now + 60000}{extra}}}}}";
        var plain = router.FromHost(Line(Auth("auth_1", ""))).OfType<RouterAction.ShowPrompt>().Single().Prompt;
        run.Check(!plain.Experimental && plain.ProviderId == "codex", "(exp!) never inferred from provider name");
        router.AuthAnswered("auth_1", "");
        Drain(router);
        var experimental = router.FromHost(Line(Auth("auth_2", ",\"experimental\":true"))).OfType<RouterAction.ShowPrompt>().Single().Prompt;
        run.Check(experimental.Experimental, "(exp!) taken from metadata");
        router.AuthAnswered("auth_2", "synthetic-credential-value");
        run.Check(router.Outgoing.TryPeek(out var secret) && secret is not null && secret.Sensitive, "credential line marked sensitive");
        var bytes = secret!.Bytes;
        router.Outgoing.Complete(secret);
        run.Check(bytes.All(value => value == 0), "credential bytes zeroed after write");
        run.Check(!router.FromHost(Line(Auth("auth_3", ",\"experimental\":\"yes\""))).OfType<RouterAction.ShowPrompt>().Any(), "non-boolean experimental refused");
        run.Check(Drain(router).Single().GetProperty("params").GetProperty("value").GetString() == "", "refused auth answers empty value");
    }

    static void Subscriptions(Run run, ProtocolManifest manifest)
    {
        var router = new StudioRouter(manifest, () => 0);
        string Event(string type, string data, string time = "2026-10-04T00:00:00.000Z") =>
            $"{{\"protocolVersion\":1,\"type\":\"native.subscription\",\"data\":{{\"subscriptionId\":\"sub_1\",\"event\":{{\"protocolVersion\":1,\"sessionId\":\"session_1\",\"sequence\":3,\"eventId\":\"event_3\",\"time\":\"{time}\",\"type\":\"{type}\",\"data\":{data}}}}}}}";
        var forwarded = Renderer(router.FromHost(Line(Event("agent.delta", "{\"text\":\"점프 추가\",\"blockId\":\"b_1\"}"))));
        run.Check(forwarded.Count == 1 && forwarded[0].Contains("native.subscription") && forwarded[0].Contains("점프"), "valid event forwarded");
        foreach (var bad in new[] { Event("agent.delta", "{\"text\":\"x\",\"blockId\":\"b\",\"apiKey\":\"k\"}"), Event("agent.thoughts", "{\"text\":\"x\"}"), Event("agent.delta", "{\"text\":\"x\",\"blockId\":\"b\"}", "yesterday"), Event("agent.delta", "{\"text\":\"Bearer abcdefghijklmnopqrstuvwxyz\",\"blockId\":\"b\"}"), Event("agent.delta", "{\"blockId\":\"b\"}") })
            run.Check(Renderer(router.FromHost(Line(bad))).Count == 0, "invalid event dropped");
        var status = Renderer(router.FromHost(Line("{\"protocolVersion\":1,\"type\":\"native.subscription\",\"data\":{\"subscriptionId\":\"sub_1\",\"status\":{\"kind\":\"status\",\"state\":\"cursor_expired\",\"minimumSequence\":7,\"path\":\"/root/x\"}}}"))).Single();
        run.Check(status.Contains("cursor_expired") && status.Contains("7") && !status.Contains("root"), "status rebuilt from closed vocabulary");
        run.Check(Renderer(router.FromHost(Line("{\"protocolVersion\":1,\"type\":\"native.subscription\",\"data\":{\"subscriptionId\":\"sub_1\",\"status\":{\"kind\":\"status\",\"state\":\"exec\"}}}"))).Count == 0, "unknown status dropped");
    }

    static void Bounds(Run run)
    {
        var queue = new OutgoingQueue();
        var line = Encoding.UTF8.GetBytes("{\"a\":1}");
        for (var i = 0; i < Limits.OutgoingQueueCount; i++) queue.TryEnqueue(line, false);
        run.Check(!queue.TryEnqueue(line, false) && queue.Count == 64, "queue count bound 64");
        var big = new OutgoingQueue();
        var chunk = new byte[Limits.OutgoingLineBytes - 1];
        Array.Fill(chunk, (byte)'x');
        var admitted = 0;
        while (big.TryEnqueue(chunk, false)) admitted++;
        run.Check(admitted == 4 && big.Bytes == 4L * Limits.OutgoingLineBytes, "queue byte bound 256 KiB");
        run.Check(!new OutgoingQueue().TryEnqueue(new byte[Limits.OutgoingLineBytes], false), "line bound 64 KiB including newline");
        run.Check(!new OutgoingQueue().TryEnqueue("{\"a\":\n1}"u8, false), "embedded newline refused");
        var sensitive = new OutgoingQueue();
        sensitive.TryEnqueue("{\"value\":\"secret\"}"u8, true);
        sensitive.TryPeek(out var entry);
        sensitive.Close();
        run.Check(entry is not null && entry.Bytes.All(value => value == 0) && !sensitive.TryEnqueue(line, false), "close wipes sensitive and stops admission");

        var framer = new LineFramer();
        var first = framer.Push("{\"a\":1}\r\n{\"b\""u8);
        var second = framer.Push(":2}\n\n"u8);
        run.Check(first.Count == 1 && Encoding.UTF8.GetString(first[0]) == "{\"a\":1}" && second.Count == 1 && Encoding.UTF8.GetString(second[0]) == "{\"b\":2}", "framing across chunks and CRLF");
        var exact = new LineFramer();
        var full = new byte[Limits.IncomingLineBytes + 1];
        Array.Fill(full, (byte)'x');
        full[^1] = (byte)'\n';
        run.Check(exact.Push(full).Count == 1 && !exact.Overflowed, "256 KiB line accepted");
        var over = new LineFramer();
        over.Push(new byte[Limits.IncomingLineBytes]);
        over.Push("x"u8);
        run.Check(over.Overflowed, "line over 256 KiB overflows");
    }

    static void Policies(Run run)
    {
        run.Check(PreviewPolicy.Admit("http://127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/") is not null, "preview url accepted");
        foreach (var url in new[] { "http://127.0.0.1:45678/p/0123456789ABCDEF0123456789abcdef/", "http://127.0.0.1:45678/p/0123456789abcdef0123456789abcdef", "http://127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/#x", "http://127.0.0.1:0/p/0123456789abcdef0123456789abcdef/", "http://127.0.0.1:99999/p/0123456789abcdef0123456789abcdef/", "http://[::1]:45678/p/0123456789abcdef0123456789abcdef/", "file:///C:/Windows/" })
            run.Check(PreviewPolicy.Admit(url) is null, "preview url rejected " + url);
        var preview = PreviewPolicy.Admit("http://127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/")!;
        run.Check(PreviewPolicy.Within(preview, "http://127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/assets/a.png?v=1"), "same origin + nonce prefix allowed");
        foreach (var other in new[] { "http://127.0.0.1:45679/p/0123456789abcdef0123456789abcdef/", "http://127.0.0.1:45678/p/ffffffffffffffffffffffffffffffff/", "http://127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/../../v1/health", "http://127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/..%2f..%2fv1", "http://localhost:45678/p/0123456789abcdef0123456789abcdef/", "https://ai.zuzunza.com/", "data:text/html,x" })
            run.Check(!PreviewPolicy.Within(preview, other), "outside preview prefix " + other);

        run.Check(LaunchRequest.FromArguments(["zuku://ai/connect"]).Kind == LaunchKind.Connect, "exact connect uri");
        foreach (var uri in new[] { "zuku://ai/connect?token=secret", "ZUKU://ai/connect", "zuku://ai/connect/../exec", "zuku://ai/run?cmd=calc" })
            run.Check(LaunchRequest.FromArguments([uri]).Kind == LaunchKind.Activate, "uri ignored " + uri);
        run.Check(LaunchRequest.FromArguments([@"C:\Games\Dash"]) is { Kind: LaunchKind.Project, ProjectPath: @"C:\Games\Dash" }, "project path hint");
        run.Check(LaunchRequest.FromArguments(["--remote-debugging-port=9222"]).Kind == LaunchKind.Activate, "flags ignored");
        var roundTrip = LaunchRequest.Decode(new LaunchRequest(LaunchKind.Project, @"D:\work\game").Encode());
        run.Check(roundTrip is { Kind: LaunchKind.Project, ProjectPath: @"D:\work\game" }, "single-instance message round trip");
        run.Check(LaunchRequest.Decode("{\"protocolVersion\":1,\"type\":\"connect\",\"token\":\"x\"}"u8) is null && LaunchRequest.Decode("{\"protocolVersion\":1,\"type\":\"exec\"}"u8) is null, "single-instance message strict");

        var roots = new FolderPolicy.Roots(@"C:\Users\me", [@"C:\Windows", @"C:\Program Files", @"C:\Program Files (x86)", @"C:\ProgramData"]);
        run.Check(FolderPolicy.Admit(@"C:\Users\me\Games\Dash\", roots, out _) == @"C:\Users\me\Games\Dash", "game folder admitted");
        run.Check(FolderPolicy.Admit(@"D:\work\dash", roots, out _) == @"D:\work\dash", "other drive admitted");
        foreach (var (path, code) in new[] { (@"C:\", "PROJECT_PATH_ROOT"), (@"C:\Users\me", "PROJECT_PATH_TOO_BROAD"), (@"C:\Users", "PROJECT_PATH_TOO_BROAD"), (@"C:\Users\me\.ssh", "PROJECT_PATH_SENSITIVE"), (@"C:\Users\me\AppData\Local\ZukuJS", "PROJECT_PATH_SENSITIVE"), (@"C:\Users\me\src\.git", "PROJECT_PATH_SENSITIVE"), (@"C:\Windows\System32", "PROJECT_PATH_SYSTEM"), (@"C:\Program Files\x", "PROJECT_PATH_SYSTEM"), (@"\\server\share\game", "PROJECT_PATH_INVALID"), (@"C:\games\..\Windows", "PROJECT_PATH_INVALID"), ("C:\\games\\a\u0001", "PROJECT_PATH_INVALID") })
        {
            run.Check(FolderPolicy.Admit(path, roots, out var reason) is null && reason == code, $"folder refused {path} as {code}");
        }

        run.Check(TrustedOrigin.AssetFor("GET", TrustedOrigin.PageUri) == "/studio/renderer/index.html", "page asset served");
        run.Check(TrustedOrigin.AssetFor("GET", TrustedOrigin.Origin + "/lib/agent-protocol/schema.mjs") is not null, "shared schema served");
        foreach (var (method, uri) in new[] { ("GET", TrustedOrigin.Origin + "/studio/native/bridge.js"), ("GET", TrustedOrigin.Origin + "/lib/studio-host.mjs"), ("GET", TrustedOrigin.Origin + "/package.json"), ("GET", TrustedOrigin.PageUri + "?x=1"), ("POST", TrustedOrigin.PageUri), ("GET", "http://zuku-studio.example/studio/renderer/index.html"), ("GET", "https://zuku-studio.example:444/studio/renderer/index.html"), ("GET", TrustedOrigin.Origin + "/studio/renderer/../../lib/studio-host.mjs"), ("GET", "https://evil.example/studio/renderer/index.html") })
            run.Check(TrustedOrigin.AssetFor(method, uri) is null, $"not served {method} {uri}");
        run.Check(InstallLocator.ServedAssets.Count == 11, "finite allowlist: 10 renderer files + shared schema");
        var script = TrustedOrigin.BridgeScript("/*bridge*/");
        run.Check(script.StartsWith("if (window === window.top && location.href === \"https://zuku-studio.example/studio/renderer/index.html\")"), "bridge guarded to trusted top frame");
    }

    static void Locator(Run run, TextWriter output)
    {
        var temp = Directory.CreateTempSubdirectory("zuku-studio-locator-");
        try
        {
            const string version = "0.3.0", sha = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
            var release = Path.Combine(temp.FullName, "releases", "cli-" + version + "-abcdef012345");
            var package = Path.Combine(release, "npm", "node_modules", "@zukujs", "cli");
            var exe = Path.Combine(release, "studio", "windows");
            var node = Path.Combine(release, "runtime", "node.exe");
            Directory.CreateDirectory(exe);
            Directory.CreateDirectory(Path.GetDirectoryName(node)!);
            File.WriteAllText(node, "synthetic");
            void Write(string relative, string text) { var path = Path.Combine(package, relative.Replace('/', Path.DirectorySeparatorChar)); Directory.CreateDirectory(Path.GetDirectoryName(path)!); File.WriteAllText(path, text); }
            Write("package.json", "{\"name\":\"@zukujs/cli\",\"version\":\"0.3.0\",\"bin\":{\"zuku\":\"./index.mjs\",\"zukujs\":\"./index.mjs\"}}");
            Write(InstallLocator.HostFile, "// host");
            Write(InstallLocator.BridgeFile, "// bridge");
            foreach (var relative in InstallLocator.ServedAssets.Values) Write(relative, "// " + relative);
            void Marker(string nodePath) => File.WriteAllText(Path.Combine(release, "install.json"), JsonSerializer.Serialize(new { schema = InstallLocator.Schema, version, sha256 = sha, node = nodePath }));
            const string nodeRelative = "runtime/node.exe";
            Marker(node);
            var found = InstallLocator.Locate(exe, version, nodeRelative);
            run.Check(found.Assets.Count == 11 && found.HostEntry.EndsWith("studio-host.mjs") && found.NodePath == Path.GetFullPath(node), "installed release located by exact marker");
            string Code(Action action) { try { action(); return "OK"; } catch (InstallationException error) { return error.Code; } }
            run.Check(Code(() => InstallLocator.Locate(exe, "0.3.1", nodeRelative)) == "STUDIO_VERSION_MISMATCH", "version must match exactly");
            run.Check(Code(() => InstallLocator.Locate(Path.Combine(release, "studio"), version, nodeRelative)) == "STUDIO_LAYOUT_UNSUPPORTED", "unexpected layout refused");
            Marker(Path.Combine(temp.FullName, "node.exe"));
            run.Check(Code(() => InstallLocator.Locate(exe, version, nodeRelative)) == "STUDIO_RUNTIME_UNMANAGED", "unmanaged node refused");
            Marker(node);
            File.Delete(Path.Combine(package, "studio", "renderer", "app.mjs"));
            run.Check(Code(() => InstallLocator.Locate(exe, version, nodeRelative)) == "STUDIO_ASSETS_MISSING", "missing asset refused");
            Write("studio/renderer/app.mjs", "// app");
            var linkTarget = Path.Combine(temp.FullName, "elsewhere.mjs");
            File.WriteAllText(linkTarget, "// elsewhere");
            var link = Path.Combine(package, "studio", "renderer", "diff.mjs");
            File.Delete(link);
            try
            {
                File.CreateSymbolicLink(link, linkTarget);
                run.Check(Code(() => InstallLocator.Locate(exe, version, nodeRelative)) == "STUDIO_LINK_REJECTED", "symlinked asset refused");
            }
            catch (Exception error) when (error is UnauthorizedAccessException or IOException)
            {
                output.WriteLine("SKIP symlinked asset check: this account cannot create symbolic links");
            }
        }
        finally { try { temp.Delete(true); } catch (IOException) { } }
    }

    static async Task Stdio(Run run, ProtocolManifest manifest, string node, string fixture)
    {
        var router = new StudioRouter(manifest, () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        await using var host = HostConnection.Start(Path.GetFullPath(node), [Path.GetFullPath(fixture)], Path.GetDirectoryName(Path.GetFullPath(fixture))!, router.Outgoing);
        async Task<List<RouterAction>> Exchange(string message, int expected)
        {
            var collected = new List<RouterAction>();
            if (message.Length > 0)
            {
                collected.AddRange(router.FromRenderer(message));
                host.Signal();
            }
            var deadline = Task.Delay(5000);
            while (collected.OfType<RouterAction.ToRenderer>().Count() + collected.OfType<RouterAction.ShowPrompt>().Count() < expected)
            {
                var read = host.Lines.ReadAsync().AsTask();
                if (await Task.WhenAny(read, deadline) != read) break;
                collected.AddRange(router.FromHost(await read));
            }
            return collected;
        }
        var list = Renderer(await Exchange(Req("ui_s1", "project.list", "{}"), 1));
        run.Check(list.Count == 1 && list[0].Contains("project_fixture") && !list[0].Contains("synthetic-leak") && !list[0].Contains("fixture\\\\game"), "stdio: core round trip projected");
        var failed = Renderer(await Exchange(Req("ui_s2", "model.list", "{}"), 1));
        run.Check(failed.Count == 1 && failed[0].Contains("UNKNOWN_OPERATION") && !failed[0].Contains("stack"), "stdio: error reduced");
        var subscribed = Renderer(await Exchange(Req("ui_s3", "native.subscribe", "{\"subscriptionId\":\"sub_s\",\"sessionId\":\"session_fixture\",\"afterSequence\":0}"), 3));
        run.Check(subscribed.Count == 3 && subscribed.Count(json => json.Contains("agent.delta")) == 1 && !subscribed.Any(json => json.Contains("leak") || json.Contains("/root")), "stdio: subscription filtered");
        var preview = await Exchange(Req("ui_s4", "native.previewShow", "{\"previewHandle\":\"preview_ok\",\"rect\":{\"x\":0,\"y\":0,\"width\":64,\"height\":64}}"), 1);
        run.Check(preview.OfType<RouterAction.ShowPreview>().Count() == 1 && !Renderer(preview).Single().Contains("127.0.0.1"), "stdio: preview resolved natively");
        router.FromRenderer(Req("ui_s5", "native.pickProject", "{}"));
        var chosen = router.PickerCompleted("ui_s5", @"C:\Games\Dash");
        host.Signal();
        var picked = Renderer(await Exchange("", 1));
        run.Check(chosen.OfType<RouterAction.HostWrite>().Any() && picked.Count == 1 && picked[0].Contains("ui_s5") && picked[0].Contains("project_fixture") && !picked[0].Contains("Dash\\\\"), "stdio: projectChosen answered on picker id");
        var pairing = await Exchange(Req("ui_s6", "hello", "{\"clientVersion\":\"emit-pairing\"}"), 2);
        var pairPrompt = pairing.OfType<RouterAction.ShowPrompt>().SingleOrDefault();
        run.Check(pairPrompt?.Prompt.RequestId == "pair_fixture", "stdio: pairing prompt");
        router.PairingDecided("pair_fixture", false);
        host.Signal();
        var auth = await Exchange(Req("ui_s7", "hello", "{\"clientVersion\":\"emit-auth\"}"), 2);
        run.Check(auth.OfType<RouterAction.ShowPrompt>().SingleOrDefault()?.Prompt.Experimental == true, "stdio: auth prompt with exp metadata");
        router.AuthAnswered("auth_fixture", "synthetic-credential-value");
        host.Signal();
        await Exchange("", 0);
        var oversize = router.FromRenderer(Req("ui_s8", "hello", "{\"clientVersion\":\"oversize\"}"));
        host.Signal();
        var reason = await Task.WhenAny(host.Completion, Task.Delay(5000)) == host.Completion ? await host.Completion : "TIMEOUT";
        run.Check(oversize.OfType<RouterAction.HostWrite>().Any() && reason == "HOST_LINE_TOO_LARGE", "stdio: oversize host line kills the host");
    }
}
