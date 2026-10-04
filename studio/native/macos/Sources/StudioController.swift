import AppKit
import WebKit

/// The trusted editor window. Routes the restricted renderer bridge to the managed host
/// and keeps every private native exchange (project paths, preview URLs, pairing
/// decisions, provider secrets) on the protected stdio channel only.
@MainActor
final class StudioController: NSObject {
    enum Limits {
        static let rendererMessage = 65536
        static let renderQueueCount = 64
        static let renderQueueBytes = 262144
        static let pendingCount = 128
        static let pendingSeconds: TimeInterval = 180
    }
    private enum PendingKind {
        case renderer(reply: String)
        case native
        case resolvePreview(reply: String, rect: ProtocolCodec.Rect, generation: Int)
    }
    private struct Pending { let kind: PendingKind; let expires: Date }

    let window: NSWindow
    private let container = FlippedView()
    private let statusLabel = NSTextField(labelWithString: "로컬 코어 연결 중")
    private let preview = PreviewController()
    private let dialogs = NativeDialogs()
    private var mainView: WKWebView?
    private var codec: ProtocolCodec?
    private var host: HostProcess?
    private var pending: [String: Pending] = [:]
    private var renderQueue: [String] = []
    private var renderBytes = 0
    private var rendering = false
    private var renderEpoch = 0
    private var pageReady = false
    private var picking = false
    private var openPanel: NSOpenPanel?
    private var expiryTimer: Timer?
    private var stopHandlers: [() -> Void] = []

    override init() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 880),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.title = "ZUKU Studio"
        window.minSize = NSSize(width: 960, height: 600)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.setFrameAutosaveName("ZukuStudioMain")
        layout()
        dialogs.onDecision = { [weak self] decision in self?.sendDecision(decision) }
    }

    // MARK: Launch

    func launch() {
        window.center()
        window.makeKeyAndOrderFront(nil)
        guard let resources = Installation.bundledResources(), let codec = ProtocolCodec(resources: resources),
              let handler = StudioSchemeHandler(resources: resources),
              let bridgeData = try? Data(contentsOf: resources.appendingPathComponent(Installation.bridgePath)), bridgeData.count <= 65536,
              let bridge = String(data: bridgeData, encoding: .utf8) else {
            setStatus("STUDIO_BUNDLE_UNAVAILABLE · 앱에 포함된 관리 화면 파일을 검증하지 못했습니다. ZUKU를 다시 설치해 주세요.")
            return
        }
        self.codec = codec
        createMainView(handler: handler, bridge: bridge)
        startHost()
        expiryTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.expirePending() }
        }
    }

    func handleConnectRequest() {
        focus()
        setStatus("웹 화면의 연결 요청을 기다립니다. 승인 창이 열리면 직접 확인해 주세요.")
    }

    func focus() {
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        if #available(macOS 14.0, *) { NSApp.activate() } else { NSApp.activate(ignoringOtherApps: true) }
    }

    /// Stops the host (stdin EOF → SIGTERM → SIGKILL) and calls `done` once it is gone.
    func shutdown(_ done: @escaping () -> Void) {
        expiryTimer?.invalidate(); expiryTimer = nil
        dialogs.cancelAll()
        preview.hide()
        guard let host, host.running else { done(); return }
        stopHandlers.append(done)
        host.terminate()
    }

    private func layout() {
        let root = NSView()
        container.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.translatesAutoresizingMaskIntoConstraints = false
        statusLabel.lineBreakMode = .byTruncatingTail
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
        root.addSubview(container)
        root.addSubview(statusLabel)
        NSLayoutConstraint.activate([
            container.topAnchor.constraint(equalTo: root.topAnchor),
            container.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            container.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            statusLabel.topAnchor.constraint(equalTo: container.bottomAnchor, constant: 4),
            statusLabel.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 10),
            statusLabel.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -10),
            statusLabel.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -4),
        ])
        window.contentView = root
    }

    private func createMainView(handler: StudioSchemeHandler, bridge: String) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(handler, forURLScheme: StudioSchemeHandler.scheme)
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.preferences.isElementFullscreenEnabled = false
        let controller = WKUserContentController()
        // Trusted bridge: document start, top frame only, page world (bridge.js expects
        // window.webkit.messageHandlers.zuku there). Previews never get this script.
        controller.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.add(ScriptMessageProxy(self), contentWorld: .page, name: "zuku")
        configuration.userContentController = controller
        let view = WKWebView(frame: container.bounds, configuration: configuration)
        view.autoresizingMask = [.width, .height]
        view.allowsBackForwardNavigationGestures = false
        view.allowsLinkPreview = false
        view.navigationDelegate = self
        view.uiDelegate = self
        if #available(macOS 13.3, *) { view.isInspectable = false }
        container.addSubview(view)
        container.addSubview(preview.view, positioned: .above, relativeTo: view)
        mainView = view
        view.load(URLRequest(url: StudioSchemeHandler.pageURL))
    }

    private func startHost() {
        switch Installation.locate() {
        case .failure(let failure):
            setStatus("\(failure.rawValue) · \(Self.describe(failure))")
        case .success(let installation):
            let host = HostProcess(executable: installation.node, arguments: [installation.hostEntry.path, "--stdio"], directory: installation.hostDirectory)
            host.canDeliver = { [weak self] in self?.canDeliver ?? false }
            host.onLine = { [weak self] line in self?.hostLine(line) }
            host.onStop = { [weak self] stop in self?.hostStopped(stop) }
            self.host = host
            if host.start() { setStatus("로컬 ZUKU 코어 \(installation.version) 연결됨") }
            else { setStatus("STUDIO_CORE_UNAVAILABLE · 관리된 Node 코어를 시작하지 못했습니다.") }
        }
    }

    static func describe(_ failure: Installation.Failure) -> String {
        switch failure {
        case .bundleUnavailable: return "앱 번들의 관리 파일을 확인하지 못했습니다. ZUKU를 다시 설치해 주세요."
        case .runtimeMissing: return "ZUKU CLI 런타임이 앱 옆의 zuku-runtime 폴더에 설치되어 있지 않습니다. ZUKU 설치 프로그램을 실행해 주세요."
        case .runtimeUntrusted: return "ZUKU CLI 런타임 파일의 위치나 권한을 신뢰할 수 없습니다. ZUKU를 다시 설치해 주세요."
        case .versionMismatch: return "ZUKU Studio와 ZUKU CLI 버전이 다릅니다. 두 구성 요소를 함께 업데이트해 주세요."
        case .schemaMismatch: return "ZUKU Studio와 코어의 프로토콜 정의가 다릅니다. ZUKU를 업데이트해 주세요."
        }
    }

    private func setStatus(_ text: String) { statusLabel.stringValue = text }

    // MARK: Renderer → native

    fileprivate func rendererMessage(_ message: WKScriptMessage) {
        guard let view = mainView, message.webView === view, message.frameInfo.isMainFrame,
              message.frameInfo.securityOrigin.protocol == StudioSchemeHandler.scheme,
              message.frameInfo.securityOrigin.host == StudioSchemeHandler.host,
              view.url == StudioSchemeHandler.pageURL, let text = message.body as? String,
              let request = codec?.admitRenderer(text) else { return }
        pageReady = true   // the managed page is live once its bridge talks to us
        switch request {
        case .reject(let id, let code): rendererError(id, code)
        case .forward(let id, let method, let params):
            if let code = sendHost(id: id, method: method, params: params, kind: .renderer(reply: id)) { rendererError(id, code) }
        case .pickProject(let id): pickProject(id)
        case .previewShow(let id, let handle, let rect):
            let generation = preview.nextGeneration()
            let nativeId = Self.nativeId()
            let params = "{\"previewHandle\":\(JSONText.quoted(handle))}"
            if pending[id] != nil { rendererError(id, "REQUEST_CONFLICT"); return }
            if let code = sendHost(id: nativeId, method: "native.resolvePreview", params: params, kind: .resolvePreview(reply: id, rect: rect, generation: generation)) {
                rendererError(id, code)
            }
        case .previewHide(let id):
            preview.hide()
            rendererResult(id, "{\"status\":\"hidden\"}")
        }
    }

    private static func nativeId() -> String { "native_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased() }

    /// Queues one request to the host and records where its response goes. Returns a safe
    /// error code when it cannot be queued.
    private func sendHost(id: String, method: String, params: String, kind: PendingKind) -> String? {
        guard let host, host.running else { return "HOST_UNAVAILABLE" }
        guard pending[id] == nil else { return "REQUEST_CONFLICT" }
        guard pending.count < Limits.pendingCount else { return "REQUEST_LIMIT" }
        guard host.send(Array(JSONText.request(id: id, method: method, params: params).utf8), sensitive: false) else { return "REQUEST_LIMIT" }
        pending[id] = Pending(kind: kind, expires: Date().addingTimeInterval(Limits.pendingSeconds))
        return nil
    }

    private func pickProject(_ id: String) {
        guard let host, host.running else { rendererError(id, "HOST_UNAVAILABLE"); return }
        guard !picking, pending[id] == nil else { rendererError(id, "REQUEST_LIMIT"); return }
        picking = true
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.allowsMultipleSelection = false
        panel.canCreateDirectories = true
        panel.resolvesAliases = true
        panel.treatsFilePackagesAsDirectories = false
        panel.showsHiddenFiles = false
        panel.title = "게임 프로젝트 폴더 선택"
        panel.message = "ZUKU 게임 프로젝트 폴더를 선택하세요. 사용자 홈 전체나 인증 폴더는 열 수 없습니다."
        panel.prompt = "이 폴더 열기"
        openPanel = panel
        panel.beginSheetModal(for: window) { [weak self] response in
            MainActor.assumeIsolated {
                guard let self else { return }
                let chosen = self.openPanel?.url
                self.picking = false
                self.openPanel = nil
                guard response == .OK, let url = chosen else { self.rendererError(id, "COMMAND_CANCELLED"); return }
                guard let path = ProjectPath.admit(url) else {
                    self.setStatus("개별 게임 폴더를 선택해 주세요. 사용자 홈, 시스템 폴더나 인증 폴더는 열 수 없습니다.")
                    self.rendererError(id, "PERMISSION_REQUIRED")
                    return
                }
                self.projectChosen(uiId: id, path: path)
            }
        }
    }

    /// The host answers the original renderer id; the native.projectChosen id itself is private.
    private func projectChosen(uiId: String, path: String) {
        guard let host, host.running else { rendererError(uiId, "HOST_UNAVAILABLE"); return }
        guard pending[uiId] == nil, pending.count + 2 <= Limits.pendingCount else { rendererError(uiId, "REQUEST_LIMIT"); return }
        let nativeId = Self.nativeId()
        let params = "{\"requestId\":\(JSONText.quoted(uiId)),\"localPath\":\(JSONText.quoted(path))}"
        guard host.send(Array(JSONText.request(id: nativeId, method: "native.projectChosen", params: params).utf8), sensitive: false) else {
            rendererError(uiId, "REQUEST_LIMIT"); return
        }
        let expires = Date().addingTimeInterval(Limits.pendingSeconds)
        pending[nativeId] = Pending(kind: .native, expires: expires)
        pending[uiId] = Pending(kind: .renderer(reply: uiId), expires: expires)
    }

    // MARK: Host → native

    private var canDeliver: Bool {
        renderQueue.count < Limits.renderQueueCount - 1 && renderBytes <= Limits.renderQueueBytes - Limits.rendererMessage
    }

    private func hostLine(_ line: String) {
        guard let message = codec?.admitHost(line) else {
            setStatus("코어 통신 형식이 맞지 않습니다. ZUKU 업데이트를 확인해 주세요.")
            host?.fail(.protocolViolation)
            return
        }
        switch message {
        case .response(let id, let errorCode, let result, let previewURL):
            guard let entry = pending.removeValue(forKey: id) else { return }
            switch entry.kind {
            case .native:
                if let errorCode { setStatus("코어가 네이티브 요청을 거절했습니다 (\(errorCode)).") }
            case .renderer(let reply):
                if let errorCode { rendererError(reply, errorCode) } else { rendererResult(reply, result) }
            case .resolvePreview(let reply, let rect, let generation):
                guard errorCode == nil, let text = previewURL, codec?.previewURL(text) == true, let url = PreviewController.validate(text),
                      let frame = previewFrame(rect) else { rendererError(reply, errorCode ?? "TOOL_UNAVAILABLE"); return }
                preview.show(url, frame: frame, generation: generation) { [weak self] shown in
                    if shown { self?.rendererResult(reply, "{\"status\":\"shown\"}") } else { self?.rendererError(reply, "TOOL_UNAVAILABLE") }
                }
            }
        case .deliver(let text): toRenderer(text)
        case .pairing(let requestId, let purpose, let expiresAt):
            if !dialogs.pairing(requestId: requestId, purpose: purpose, expiresAt: expiresAt, window: window) {
                sendDecision(.pairing(requestId: requestId, allow: false))
            } else { focus() }
        case .pairingInvalid(let requestId): sendDecision(.pairing(requestId: requestId, allow: false))
        case .auth(let prompt):
            if !dialogs.auth(prompt, window: window) { sendDecision(.auth(requestId: prompt.requestId, value: "")) } else { focus() }
        case .authInvalid(let requestId): sendDecision(.auth(requestId: requestId, value: ""))
        case .promptClosed(let requestId): dialogs.close(requestId: requestId)
        case .ignored: break
        }
    }

    private func previewFrame(_ rect: ProtocolCodec.Rect) -> NSRect? {
        guard let view = mainView else { return nil }
        let bounds = view.frame
        let width = min(CGFloat(rect.width), bounds.width - CGFloat(rect.x))
        let height = min(CGFloat(rect.height), bounds.height - CGFloat(rect.y))
        guard width >= 16, height >= 16 else { return nil }
        return NSRect(x: bounds.minX + CGFloat(rect.x), y: bounds.minY + CGFloat(rect.y), width: width, height: height)
    }

    private func sendDecision(_ decision: NativeDialogs.Decision) {
        guard let host, host.running else { return }
        let nativeId = Self.nativeId()
        switch decision {
        case .pairing(let requestId, let allow):
            if sendHost(id: nativeId, method: "native.pairingDecision", params: "{\"requestId\":\(JSONText.quoted(requestId)),\"allow\":\(allow)}", kind: .native) != nil {
                setStatus("연결 승인 결과를 코어에 전달하지 못했습니다.")
            }
        case .auth(let requestId, let value):
            var line = JSONText.sensitiveRequest(id: nativeId, method: "native.authResponse", requestId: requestId, value: value)
            defer { line.withUnsafeMutableBytes { raw in if let base = raw.baseAddress { _ = memset_s(base, raw.count, 0, raw.count) } } }
            guard pending.count < Limits.pendingCount, host.send(line, sensitive: true) else { setStatus("인증 응답을 코어에 전달하지 못했습니다."); return }
            pending[nativeId] = Pending(kind: .native, expires: Date().addingTimeInterval(Limits.pendingSeconds))
        }
    }

    private func hostStopped(_ stop: HostProcess.Stop) {
        switch stop {
        case .exited: setStatus("코어 연결이 종료되었습니다. ZUKU Studio를 다시 시작해 주세요.")
        case .overflow: setStatus("코어 통신 메시지의 크기 한도를 초과해 연결을 종료했습니다.")
        case .protocolViolation: setStatus("코어 통신 형식이 맞지 않아 연결을 종료했습니다. ZUKU 업데이트를 확인해 주세요.")
        case .ioError, .launchFailed: setStatus("STUDIO_CORE_UNAVAILABLE · 코어와 통신하지 못했습니다.")
        }
        dialogs.cancelAll()
        preview.hide()
        let entries = pending
        pending.removeAll()
        for (_, entry) in entries {
            switch entry.kind {
            case .renderer(let reply), .resolvePreview(let reply, _, _): rendererError(reply, "HOST_UNAVAILABLE")
            case .native: break
            }
        }
        let handlers = stopHandlers
        stopHandlers.removeAll()
        handlers.forEach { $0() }
    }

    private func expirePending() {
        let now = Date()
        for (id, entry) in pending where entry.expires <= now {
            pending.removeValue(forKey: id)
            switch entry.kind {
            case .renderer(let reply), .resolvePreview(let reply, _, _): rendererError(reply, "HOST_TIMEOUT")
            case .native: break
            }
        }
    }

    // MARK: Native → renderer

    private func rendererResult(_ id: String, _ result: String) {
        let message = JSONText.result(id: id, result: result)
        toRenderer(message.utf8.count <= Limits.rendererMessage ? message : JSONText.error(id: id, code: "BODY_TOO_LARGE"))
    }

    private func rendererError(_ id: String, _ code: String) {
        let safe = code.range(of: "^[A-Z][A-Z0-9_]{0,63}$", options: .regularExpression) != nil ? code : "CORE_OPERATION_FAILED"
        toRenderer(JSONText.error(id: id, code: safe))
    }

    /// Delivers one already-serialized JSON message as a *string argument* to
    /// window.ZukuStudioReceive; no host text is ever interpolated into script source.
    private func toRenderer(_ message: String) {
        guard pageReady, let view = mainView, view.url == StudioSchemeHandler.pageURL else { return }
        let size = message.utf8.count
        guard size <= Limits.rendererMessage else { return }
        guard renderQueue.count < Limits.renderQueueCount, renderBytes + size <= Limits.renderQueueBytes else {
            setStatus("화면 전달 대기열이 가득 차 코어 연결을 종료했습니다.")
            host?.fail(.overflow)
            return
        }
        renderQueue.append(message)
        renderBytes += size
        renderNext()
    }

    private func renderNext() {
        guard !rendering, let view = mainView, let message = renderQueue.first else { return }
        rendering = true
        let epoch = renderEpoch
        view.callAsyncJavaScript("window.ZukuStudioReceive(message); return true;", arguments: ["message": message], in: nil, in: .page) { [weak self] _ in
            MainActor.assumeIsolated { self?.rendered(epoch) }
        }
    }

    private func rendered(_ epoch: Int) {
        guard epoch == renderEpoch else { return }   // completion from before a page reset
        if let first = renderQueue.first { renderBytes -= first.utf8.count; renderQueue.removeFirst() }
        rendering = false
        renderNext()
        host?.resumeReading()
    }

    private func pageReset() {
        pageReady = false
        renderEpoch += 1
        rendering = false
        renderQueue.removeAll(); renderBytes = 0
        // Replies for the previous page have no reader; drop them (native entries stay).
        pending = pending.filter { if case .native = $0.value.kind { return true } else { return false } }
        preview.hide()
        host?.resumeReading()
    }
}

// MARK: Main view policy

extension StudioController: @preconcurrency WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, preferences: WKWebpagePreferences) async -> (WKNavigationActionPolicy, WKWebpagePreferences) {
        // Only the one managed page may load, in the top frame. Links and external
        // navigations are denied rather than opened.
        let allowed = action.targetFrame?.isMainFrame == true && action.request.url == StudioSchemeHandler.pageURL && !action.shouldPerformDownload
        return (allowed ? .allow : .cancel, preferences)
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { pageReset() }
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) { pageReady = webView.url == StudioSchemeHandler.pageURL }
    func webView(_ webView: WKWebView, respondTo challenge: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        (.cancelAuthenticationChallenge, nil)
    }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        pageReset()
        webView.load(URLRequest(url: StudioSchemeHandler.pageURL))
    }
}

extension StudioController: @preconcurrency WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo) async -> [URL]? { nil }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision { .deny }
}

/// Breaks the WKUserContentController → handler retain cycle.
@MainActor
private final class ScriptMessageProxy: NSObject, @preconcurrency WKScriptMessageHandler {
    weak var target: StudioController?
    init(_ target: StudioController) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.rendererMessage(message)
    }
}

/// Container whose origin is top-left, matching renderer CSS pixel coordinates.
final class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

/// Defense-in-depth for the native folder chooser; Agent Core applies its own policy.
enum ProjectPath {
    static let blockedComponents: Set<String> = [".ssh", ".config", ".aws", ".codex", ".claude", ".git", ".gnupg", ".Trash", "Keychains"]
    static let blockedRoots = ["/System", "/Library", "/usr", "/bin", "/sbin", "/dev", "/cores", "/private/etc", "/private/var"]

    /// Canonical absolute directory path, or nil when the choice is not a single game folder.
    static func admit(_ url: URL, home: String = NSHomeDirectory()) -> String? {
        guard url.isFileURL, let resolved = realpath(url.path, nil) else { return nil }
        let path = String(cString: resolved); free(resolved)
        var directory: ObjCBool = false
        guard FileManager.default.fileExists(atPath: path, isDirectory: &directory), directory.boolValue else { return nil }
        return admitPath(path, home: home)
    }

    static func admitPath(_ path: String, home rawHome: String) -> String? {
        var home = rawHome
        if let resolved = realpath(rawHome, nil) { home = String(cString: resolved); free(resolved) }
        guard path.hasPrefix("/"), path.utf8.count <= 4096, !path.contains("\n"), path != "/", path != home,
              !home.hasPrefix(path.trimmingTrailingSlash + "/"), !path.hasPrefix(home + "/Library/") , path != home + "/Library" else { return nil }
        if blockedRoots.contains(where: { path == $0 || path.hasPrefix($0 + "/") }) { return nil }
        if path.split(separator: "/").contains(where: { blockedComponents.contains(String($0)) }) { return nil }
        return path
    }
}
