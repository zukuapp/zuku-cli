import AppKit

/// Headless native checks, run from the built app binary:
///   ZukuStudio --self-test   protocol admission, framing, queues, URLs, paths (no GUI, no host)
///   ZukuStudio --stdio-test  real HostProcess round trip against the SYNTHETIC stdio fixture
///                            using the staged managed Node (no Agent Core, no GUI, no network)
@MainActor
enum SelfTest {
    nonisolated static var architecture: String {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return "unknown"
        #endif
    }

    private final class Checker {
        var passed = 0, failed: [String] = []
        func expect(_ condition: Bool, _ label: String) { if condition { passed += 1 } else { failed.append(label) } }
        func finish(_ title: String) -> Int32 {
            if failed.isEmpty { print("\(title): \(passed) checks passed (\(architecture))."); return 0 }
            for label in failed { print("FAIL \(label)") }
            print("\(title): \(failed.count) of \(passed + failed.count) checks failed (\(architecture)).")
            return 1
        }
    }

    private static func request(_ method: String, _ params: String, id: String = "ui_1") -> String {
        "{\"protocolVersion\":1,\"id\":\"\(id)\",\"method\":\"\(method)\",\"params\":\(params)}"
    }

    static func protocolChecks() -> Int32 {
        let t = Checker()
        guard let resources = Installation.bundledResources() else { print("FAIL bundled managed resources unavailable"); return 1 }
        guard let codec = ProtocolCodec(resources: resources) else { print("FAIL shared schema/codec did not load"); return 1 }

        // Renderer admission.
        t.expect(codec.admitRenderer(request("project.list", "{}")) == .forward(id: "ui_1", method: "project.list", params: "{}"), "core method forwarded")
        let input = request("session.input", #"{"sessionId":"session_1","requestId":"input_1","operation":"game.maintain","request":"플레이어 대시 추가","experimental":false}"#)
        if case .forward = codec.admitRenderer(input) { t.expect(true, "") } else { t.expect(false, "session.input forwarded") }
        for method in ["project.grant", "native.projectChosen", "native.resolvePreview", "native.pairingDecision", "native.authResponse", "preview.read", "studio.open"] {
            t.expect(codec.admitRenderer(request(method, #"{"requestId":"x","allow":true}"#)) == .reject(id: "ui_1", code: "NATIVE_PERMISSION_REQUIRED"), "\(method) refused")
        }
        t.expect(codec.admitRenderer(request("pair.decide", "{}")) == .reject(id: "ui_1", code: "METHOD_NOT_ALLOWED"), "unknown method refused")
        if case .reject = codec.admitRenderer(request("auth.request", #"{"providerId":"codex","experimental":true,"apiKey":"x"}"#)) { t.expect(true, "") } else { t.expect(false, "secret field refused") }
        if case .reject = codec.admitRenderer(request("session.input", #"{"sessionId":"s","requestId":"r","operation":"game.maintain","request":"x","command":"cat /etc/passwd"}"#)) { t.expect(true, "") } else { t.expect(false, "extra command field refused") }
        t.expect(codec.admitRenderer("[]") == nil && codec.admitRenderer("{") == nil, "non-object dropped")
        t.expect(codec.admitRenderer(String(repeating: "x", count: 65537)) == nil, "oversized request dropped")
        t.expect(codec.admitRenderer(request("native.pickProject", "{}")) == .pickProject(id: "ui_1"), "picker admitted")
        if case .reject = codec.admitRenderer(request("native.pickProject", #"{"localPath":"/etc"}"#)) { t.expect(true, "") } else { t.expect(false, "picker path refused") }
        t.expect(codec.admitRenderer(request("native.previewShow", #"{"previewHandle":"preview_1","rect":{"x":0,"y":8,"width":320,"height":240}}"#))
                 == .previewShow(id: "ui_1", handle: "preview_1", rect: .init(x: 0, y: 8, width: 320, height: 240)), "previewShow admitted")
        if case .reject = codec.admitRenderer(request("native.previewShow", #"{"previewHandle":"preview_1","url":"http://evil","rect":{"x":0,"y":0,"width":80,"height":80}}"#)) { t.expect(true, "") } else { t.expect(false, "previewShow url refused") }
        t.expect(codec.admitRenderer(request("native.previewHide", "{}")) == .previewHide(id: "ui_1"), "previewHide admitted")

        // Host messages.
        let sensitive = #"{"protocolVersion":1,"id":"ui_1","result":{"projectHandle":"project_1","name":"게임","path":"/Users/me/game","apiKey":"synthetic-secret","url":"http://127.0.0.1:4000/p/0123456789abcdef0123456789abcdef/"}}"#
        if case .response(_, nil, let result, let url)? = codec.admitHost(sensitive) {
            t.expect(!result.contains("synthetic-secret") && !result.contains("/Users") && !result.contains("127.0.0.1"), "result projected")
            t.expect(url == "http://127.0.0.1:4000/p/0123456789abcdef0123456789abcdef/", "preview URL kept native-only")
        } else { t.expect(false, "host response admitted") }
        t.expect(codec.admitHost(#"{"protocolVersion":1,"id":"ui_1","error":{"code":"lower"}}"#) == .response(id: "ui_1", errorCode: "CORE_OPERATION_FAILED", result: "null", previewURL: nil), "unsafe error code replaced")
        t.expect(codec.admitHost(#"{"protocolVersion":2,"id":"ui_1","result":{}}"#) == nil && codec.admitHost("nope") == nil, "protocol violation detected")
        let pairing = #"{"protocolVersion":1,"type":"native.pairing","data":{"requestId":"pair_1","challengeId":"challenge_1","origin":"https://ai.zuzunza.com","purpose":"browser.connect","expiresAt":1}}"#
        t.expect(codec.admitHost(pairing) == .pairing(requestId: "pair_1", purpose: "browser.connect", expiresAt: 1), "pairing prompt admitted")
        t.expect(codec.admitHost(pairing.replacingOccurrences(of: "https://ai.zuzunza.com", with: "https://evil.example")) == .pairingInvalid(requestId: "pair_1"), "foreign origin refused")
        let auth = #"{"protocolVersion":1,"type":"native.auth","data":{"requestId":"auth_1","providerId":"codex","methodId":"chatgpt","question":"코드를 입력하세요","expiresAt":1,"official":false,"experimental":true}}"#
        if case .auth(let prompt)? = codec.admitHost(auth) { t.expect(prompt.experimental, "(exp!) from metadata") } else { t.expect(false, "auth prompt admitted") }
        if case .auth(let prompt)? = codec.admitHost(auth.replacingOccurrences(of: #","official":false,"experimental":true"#, with: "")) { t.expect(!prompt.experimental, "no badge without metadata") } else { t.expect(false, "auth prompt without metadata admitted") }

        // Preview URL and content rules.
        let good = "http://127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/"
        t.expect(PreviewController.validate(good) != nil && codec.previewURL(good), "preview URL accepted")
        for bad in ["https://127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/", "http://localhost:45678/p/0123456789abcdef0123456789abcdef/", good + "?token=x", good + "#x",
                    "http://user@127.0.0.1:45678/p/0123456789abcdef0123456789abcdef/", "http://127.0.0.1:45678/private", "http://127.0.0.1:45678/p/0123456789ABCDEF0123456789abcdef/", "file:///etc/passwd"] {
            t.expect(PreviewController.validate(bad) == nil && !codec.previewURL(bad), "preview URL refused: \(bad)")
        }
        let rules = PreviewController.ruleList(prefix: good) ?? ""
        t.expect(rules.contains(#"^http://127\\.0\\.0\\.1:45678/p/0123456789abcdef0123456789abcdef/"#) && rules.contains("ignore-previous-rules") && rules.contains("url-filter-is-case-sensitive"), "preview rule list")
        t.expect(PreviewController.admits(URL(string: good + "game.js"), prefix: good) && !PreviewController.admits(URL(string: "http://127.0.0.1:45678/p/ffffffffffffffffffffffffffffffff/"), prefix: good), "preview prefix")
        t.expect(ConnectURI.matches(URL(string: "zuku://ai/connect")!) && !ConnectURI.matches(URL(string: "zuku://ai/connect?token=secret")!) && !ConnectURI.matches(URL(string: "zuku://ai/connect/x")!), "connect URI exact")

        // Framing and bounded queues.
        var framer = LineFramer(maxLine: 16)
        framer.append(Array("{\"a\":1}\n\n{\"b\":2}\r\n".utf8))
        t.expect(framer.next() == .line("{\"a\":1}") && framer.next() == .line("{\"b\":2}\r") && framer.next() == .none, "line framing")
        framer.append(Array(repeating: UInt8(0x78), count: 17))
        t.expect(framer.next() == .overflow, "line overflow")
        var bad = LineFramer(maxLine: 16); bad.append([0xFF, 0x0A])
        t.expect(bad.next() == .invalidUTF8, "invalid UTF-8")
        var queue = OutgoingQueue(maxCount: 64, maxBytes: 262144, maxLine: 65536)
        t.expect(!queue.push(Array(repeating: 0x78, count: 65537), sensitive: false), "outgoing line limit")
        for _ in 0..<64 { _ = queue.push([0x7B, 0x7D], sensitive: false) }
        t.expect(!queue.push([0x7B, 0x7D], sensitive: false), "outgoing count limit")
        var big = OutgoingQueue(maxCount: 64, maxBytes: 262144, maxLine: 65536)
        for _ in 0..<4 { _ = big.push(Array(repeating: 0x78, count: 65535), sensitive: false) }
        t.expect(!big.push([0x78], sensitive: false), "outgoing byte limit")
        var partial = OutgoingQueue(maxCount: 4, maxBytes: 1024, maxLine: 512)
        _ = partial.push(Array("{\"x\":\"secret\"}".utf8), sensitive: true)
        var sink: [UInt8] = [], calls = 0
        let drained = partial.drain { buffer in calls += 1; if calls % 2 == 0 { return 0 }; sink.append(contentsOf: buffer.prefix(3)); return min(3, buffer.count) }
        _ = partial.drain { buffer in sink.append(contentsOf: buffer); return buffer.count }
        t.expect(drained && partial.isEmpty && partial.bytes == 0 && sink == Array("{\"x\":\"secret\"}\n".utf8), "partial writes reassemble")

        // JSON assembly.
        let tricky = "a\"b\\c\n\u{1}\u{2028}한"
        let decoded = (try? JSONSerialization.jsonObject(with: Data("[\(JSONText.quoted(tricky))]".utf8))) as? [String]
        t.expect(decoded == [tricky], "JSON string escaping")
        let secretLine = JSONText.sensitiveRequest(id: "native_1", method: "native.authResponse", requestId: "auth_1", value: "p\"w\\d\u{7}")
        let parsed = (try? JSONSerialization.jsonObject(with: Data(secretLine))) as? [String: Any]
        t.expect((parsed?["params"] as? [String: Any])?["value"] as? String == "p\"w\\d\u{7}" && parsed?["method"] as? String == "native.authResponse", "sensitive envelope")

        // Scheme allowlist and project chooser policy.
        let known = Set(Installation.rendererAssets.keys)
        t.expect(known.count == 11, "finite renderer asset set")
        t.expect(StudioSchemeHandler.assetPath(StudioSchemeHandler.pageURL, known: known) == "/studio/renderer/index.html", "page asset")
        for refused in ["zuku-studio://app/studio/native/bridge.js", "zuku-studio://evil/studio/renderer/index.html", "zuku-studio://app/studio/renderer/index.html?x=1",
                        "zuku-studio://app/studio/renderer/../renderer/index.html", "zuku-studio://app/package.json", "https://app/studio/renderer/index.html"] {
            t.expect(StudioSchemeHandler.assetPath(URL(string: refused), known: known) == nil, "asset refused: \(refused)")
        }
        let home = "/Users/zuku-selftest-home"
        t.expect(ProjectPath.admitPath("\(home)/Games/Jump", home: home) == "\(home)/Games/Jump", "game folder admitted")
        for refused in ["/", home, "/Users", "\(home)/.ssh/keys", "\(home)/Library/Keychains", "/System/Library", "\(home)/work/.git", "/private/var/db"] {
            t.expect(ProjectPath.admitPath(refused, home: home) == nil, "project path refused: \(refused)")
        }
        let now = Date(timeIntervalSince1970: 1000)
        t.expect(NativeDialogs.remaining(1_060_000, now: now) == 60_000 && NativeDialogs.remaining(999_000, now: now) == nil && NativeDialogs.remaining(1_200_000, now: now) == nil, "prompt deadline window")
        return t.finish("ZUKU Studio macOS native protocol")
    }

    private final class Collector {
        var lines: [String] = [], stop: HostProcess.Stop?, gate = false
    }

    static func stdioRoundTrip() -> Int32 {
        let t = Checker()
        let installation: Installation
        switch Installation.locate() {
        case .success(let value): installation = value
        case .failure(let failure):
            print("UNAVAILABLE \(failure.rawValue): --stdio-test needs the managed zuku-runtime next to the app (build.sh --stage-runtime).")
            return 2
        }
        let fixture = installation.bundleResources.appendingPathComponent(Installation.fixturePath)
        guard FileTrust.regularFile(fixture, executable: false), let codec = ProtocolCodec(resources: installation.bundleResources) else {
            print("FAIL synthetic fixture or codec unavailable"); return 1
        }
        let collector = Collector()
        let host = HostProcess(executable: installation.node, arguments: [fixture.path], directory: fixture.deletingLastPathComponent())
        host.canDeliver = { collector.gate }
        host.onLine = { collector.lines.append($0) }
        host.onStop = { collector.stop = $0 }
        guard host.start() else { print("FAIL managed Node could not start"); return 1 }
        let secret = "synthetic-fixture-secret"
        let requests = [
            request("project.list", "{}", id: "request_001"),
            request("session.create", #"{"projectHandle":"project_fixture"}"#, id: "request_002"),
            request("native.subscribe", #"{"subscriptionId":"sub_1","sessionId":"session_fixture","afterSequence":0}"#, id: "request_003"),
        ]
        for line in requests { t.expect(host.send(Array(line.utf8), sensitive: false), "queued \(line.prefix(48))") }
        var secretLine = JSONText.sensitiveRequest(id: "request_004", method: "native.authResponse", requestId: "auth_fixture", value: secret)
        t.expect(host.send(secretLine, sensitive: true), "queued sensitive response")
        secretLine.withUnsafeMutableBytes { raw in if let base = raw.baseAddress { _ = memset_s(base, raw.count, 0, raw.count) } }
        t.expect(host.send(Array(request("hello", #"{"clientVersion":"overflow"}"#, id: "request_005").utf8), sensitive: false), "queued overflow trigger")

        let start = Date()
        while collector.stop == nil && Date().timeIntervalSince(start) < 8 {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(0.05))
            // Hold the reader closed for 300 ms so the pipe fills while the "renderer" is busy.
            if !collector.gate && Date().timeIntervalSince(start) > 0.3 { collector.gate = true; host.resumeReading() }
        }
        if collector.stop == nil { host.terminate(); t.expect(false, "host stopped within deadline") }
        t.expect(collector.stop == .overflow, "oversized host line stops the host (got \(String(describing: collector.stop)))")
        t.expect(collector.lines.count == 6, "six framed host lines before overflow (got \(collector.lines.count))")
        t.expect(!collector.lines.contains { $0.contains(secret) }, "secret never echoed")
        t.expect(collector.lines.contains { $0.contains("\"id\":\"request_004\"") && $0.contains("\"accepted\":true") }, "sensitive value delivered intact")
        var responses = 0, delivered = 0, prompts = 0
        for line in collector.lines {
            switch codec.admitHost(line) {
            case .response(let id, nil, _, _)? where id.hasPrefix("request_"): responses += 1
            case .deliver?: delivered += 1
            case .pairing?: prompts += 1
            default: t.expect(false, "unexpected host line \(line.prefix(80))")
            }
        }
        t.expect(responses == 4 && delivered == 1 && prompts == 1, "responses/subscription/pairing admitted (\(responses)/\(delivered)/\(prompts))")
        return t.finish("ZUKU Studio macOS native stdio (synthetic fixture, not Agent Core)")
    }
}
