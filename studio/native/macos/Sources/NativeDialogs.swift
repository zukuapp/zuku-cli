import AppKit

/// Native approval and secret-entry sheets. They are AppKit NSAlert sheets with plain
/// text only (no HTML/WebView), default to refusal (Return refuses), close themselves at
/// the Core deadline, and report decisions only to the native shell. Nothing here is
/// ever visible to the renderer page.
@MainActor
final class NativeDialogs {
    enum Decision: Sendable { case pairing(requestId: String, allow: Bool), auth(requestId: String, value: String) }

    var onDecision: (Decision) -> Void = { _ in }
    private var alert: NSAlert?
    private var requestId: String?
    private var secretField: NSSecureTextField?
    private var deadline: Timer?
    private var isAuth = false

    var isActive: Bool { alert != nil }

    /// Milliseconds remaining before `expiresAt` (ms since epoch), when within (0, 125 s].
    static func remaining(_ expiresAt: Double, now: Date = Date()) -> Double? {
        let remaining = expiresAt - now.timeIntervalSince1970 * 1000
        return remaining > 0 && remaining <= 125_000 ? remaining : nil
    }

    /// Returns false (caller refuses immediately) when busy, expired or windowless.
    func pairing(requestId: String, purpose: String, expiresAt: Double, window: NSWindow?) -> Bool {
        guard let window, window.isVisible, window.attachedSheet == nil, !isActive, let remaining = NativeDialogs.remaining(expiresAt) else { return false }
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "ai.zuzunza.com 연결 승인"
        alert.informativeText = "https://ai.zuzunza.com 웹 화면을 이 Mac의 ZUKU Studio와 연결하시겠습니까?\n\n허용하면 웹 화면이 선택한 게임 프로젝트와 등록된 제공자로 ZUKU 게임 개발 작업을 요청할 수 있습니다. 직접 연결을 시작하지 않았다면 거절하세요.\n\n요청 목적: \(purpose)"
        present(alert, requestId: requestId, auth: false, accept: "연결 허용", remaining: remaining, window: window)
        return true
    }

    func auth(_ prompt: ProtocolCodec.AuthPrompt, window: NSWindow?) -> Bool {
        // A queued sheet (e.g. behind the folder picker) could outlive its deadline; refuse instead.
        guard let window, window.isVisible, window.attachedSheet == nil, !isActive, let remaining = NativeDialogs.remaining(prompt.expiresAt) else { return false }
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = "제공자 인증"
        alert.informativeText = "제공자: \(prompt.providerId)\n\n\(prompt.question)"
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        let method = NSMutableAttributedString(string: "인증 방식: \(prompt.methodId)", attributes: [.foregroundColor: NSColor.labelColor])
        if prompt.experimental {
            // Experimental state comes only from Core auth-method metadata.
            method.append(NSAttributedString(string: " "))
            method.append(NSAttributedString(string: "(exp!)", attributes: [.foregroundColor: NSColor.systemOrange, .font: NSFont.boldSystemFont(ofSize: NSFont.systemFontSize)]))
        }
        stack.addArrangedSubview(NSTextField(labelWithAttributedString: method))
        let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 320, height: 24))
        field.translatesAutoresizingMaskIntoConstraints = false
        field.widthAnchor.constraint(equalToConstant: 320).isActive = true
        stack.addArrangedSubview(field)
        stack.frame = NSRect(x: 0, y: 0, width: 320, height: 56)
        alert.accessoryView = stack
        secretField = field
        alert.window.initialFirstResponder = field
        present(alert, requestId: prompt.requestId, auth: true, accept: "확인", remaining: remaining, window: window)
        alert.window.makeFirstResponder(field)
        return true
    }

    /// Core closed the prompt (expired or cancelled); dismiss without another decision.
    func close(requestId: String) {
        guard requestId == self.requestId, let alert else { return }
        self.requestId = nil
        alert.window.sheetParent?.endSheet(alert.window, returnCode: .abort)
    }

    /// Host is gone: dismiss silently.
    func cancelAll() {
        guard let alert else { return }
        requestId = nil
        alert.window.sheetParent?.endSheet(alert.window, returnCode: .abort)
    }

    private func present(_ alert: NSAlert, requestId: String, auth: Bool, accept: String, remaining: Double, window: NSWindow) {
        // First button is the default (Return): refusal. The accept button has no key equivalent.
        alert.addButton(withTitle: "거절")
        let allow = alert.addButton(withTitle: accept)
        allow.keyEquivalent = ""
        self.alert = alert
        self.requestId = requestId
        self.isAuth = auth
        deadline = Timer.scheduledTimer(withTimeInterval: min(remaining, 120_000) / 1000, repeats: false) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, let alert = self.alert else { return }
                alert.window.sheetParent?.endSheet(alert.window, returnCode: .abort)
            }
        }
        alert.beginSheetModal(for: window) { [weak self] response in
            MainActor.assumeIsolated { self?.finish(response) }
        }
    }

    private func finish(_ response: NSApplication.ModalResponse) {
        deadline?.invalidate(); deadline = nil
        let accepted = response == .alertSecondButtonReturn
        let request = requestId
        var value = ""
        if isAuth, let field = secretField {
            if accepted { value = field.stringValue }
            field.stringValue = ""
        }
        alert = nil; secretField = nil; requestId = nil
        guard let request else { return }   // closed by Core or host: no decision is sent.
        onDecision(isAuth ? .auth(requestId: request, value: value) : .pairing(requestId: request, allow: accepted))
    }
}
