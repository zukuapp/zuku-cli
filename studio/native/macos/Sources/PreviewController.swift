import AppKit
import WebKit

/// Unprivileged game preview: a separate WKWebView with its own non-persistent data
/// store, no script message handlers, no user scripts and no custom schemes. It may
/// only load the readonly URL Core returned (`http://127.0.0.1:<port>/p/<32 hex>/`);
/// a compiled content rule list blocks every subresource outside that origin AND nonce
/// path prefix, and the navigation policy enforces the same rule for frames.
@MainActor
final class PreviewController: NSObject {
    let view: WKWebView
    private(set) var generation = 0
    private var allowedPrefix: String?
    private var loaded: URL?
    private static let ruleListIdentifier = "com.zuku.Studio.preview"

    override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController = WKUserContentController()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.preferences.isElementFullscreenEnabled = false
        configuration.preferences.isFraudulentWebsiteWarningEnabled = true
        configuration.suppressesIncrementalRendering = false
        view = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        view.isHidden = true
        view.allowsBackForwardNavigationGestures = false
        view.allowsMagnification = false
        view.allowsLinkPreview = false
        view.navigationDelegate = self
        view.uiDelegate = self
        if #available(macOS 13.3, *) { view.isInspectable = false }
    }

    /// Strict readonly preview URL check; returns the URL only in its exact canonical form.
    nonisolated static func validate(_ text: String) -> URL? {
        guard text.utf8.count <= 200, let parts = URLComponents(string: text), parts.scheme == "http", parts.host == "127.0.0.1",
              let port = parts.port, (1...65535).contains(port), parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil,
              parts.path.range(of: "^/p/[a-f0-9]{32}/$", options: .regularExpression) != nil,
              text == "http://127.0.0.1:\(port)\(parts.path)" else { return nil }
        return URL(string: text)
    }

    /// Prefix (origin + nonce path) a preview request must start with.
    nonisolated static func prefix(of url: URL) -> String { url.absoluteString }

    nonisolated static func admits(_ candidate: URL?, prefix: String?) -> Bool {
        guard let candidate, let prefix, let parts = URLComponents(url: candidate, resolvingAgainstBaseURL: false),
              parts.user == nil, parts.password == nil else { return false }
        return candidate.absoluteString.hasPrefix(prefix)
    }

    func nextGeneration() -> Int { generation += 1; return generation }

    /// Content rule list: block everything, then re-allow only `^<origin>/p/<nonce>/`.
    /// The validated prefix contains only [a-z0-9:/.], so escaping dots is sufficient.
    nonisolated static func ruleList(prefix: String) -> String? {
        guard prefix.range(of: "^[a-z0-9:/.]+$", options: .regularExpression) != nil else { return nil }
        let pattern = "^" + prefix.replacingOccurrences(of: ".", with: "\\.")
        let rules: [[String: Any]] = [
            ["trigger": ["url-filter": ".*"], "action": ["type": "block"]],
            ["trigger": ["url-filter": pattern, "url-filter-is-case-sensitive": true], "action": ["type": "ignore-previous-rules"]],
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: rules) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    /// Shows `url` at `rect` (container coordinates). Reuses the loaded page when only
    /// the rectangle changed. Completion reports whether the preview is visible.
    func show(_ url: URL, frame: NSRect, generation expected: Int, completion: @escaping @MainActor @Sendable (Bool) -> Void) {
        guard expected == generation else { completion(false); return }
        if loaded == url, allowedPrefix != nil {
            view.frame = frame; view.isHidden = false; completion(true); return
        }
        let prefix = PreviewController.prefix(of: url)
        clear()
        guard let rules = PreviewController.ruleList(prefix: prefix), let store = WKContentRuleListStore.default() else { completion(false); return }
        store.compileContentRuleList(forIdentifier: PreviewController.ruleListIdentifier, encodedContentRuleList: rules) { [weak self] list, error in
            MainActor.assumeIsolated {
                guard let self, expected == self.generation, error == nil, let list else { completion(false); return }
                self.view.configuration.userContentController.removeAllContentRuleLists()
                self.view.configuration.userContentController.add(list)
                self.allowedPrefix = prefix
                self.loaded = url
                self.view.frame = frame
                self.view.isHidden = false
                self.view.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))
                completion(true)
            }
        }
    }

    func hide() {
        generation += 1
        clear()
    }

    private func clear() {
        allowedPrefix = nil
        loaded = nil
        view.isHidden = true
        view.stopLoading()
        view.loadHTMLString("", baseURL: nil)
    }
}

extension PreviewController: @preconcurrency WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, preferences: WKWebpagePreferences) async -> (WKNavigationActionPolicy, WKWebpagePreferences) {
        let url = action.request.url
        // about:blank/about:srcdoc load no network content and inherit the preview origin.
        let blank = ["about:blank", "about:srcdoc"].contains(url?.absoluteString ?? "")
        let allowed = action.targetFrame != nil && !action.shouldPerformDownload && (blank || PreviewController.admits(url, prefix: allowedPrefix))
        return (allowed ? .allow : .cancel, preferences)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        let blank = ["about:blank", "about:srcdoc"].contains(response.response.url?.absoluteString ?? "")
        return blank || (response.canShowMIMEType && PreviewController.admits(response.response.url, prefix: allowedPrefix)) ? .allow : .cancel
    }

    func webView(_ webView: WKWebView, respondTo challenge: URLAuthenticationChallenge) async -> (URLSession.AuthChallengeDisposition, URLCredential?) {
        (.cancelAuthenticationChallenge, nil)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { hide() }
}

extension PreviewController: @preconcurrency WKUIDelegate {
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo) async -> [URL]? { nil }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {}
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool { false }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? { nil }
    func webView(_ webView: WKWebView, decideMediaCapturePermissionsFor origin: WKSecurityOrigin, initiatedBy frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision { .deny }
}
