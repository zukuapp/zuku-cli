import Foundation
import WebKit

/// Serves the finite, managed renderer asset set at `zuku-studio://app/…` from the signed
/// app bundle. Assets are read once at launch; anything outside the allowlist, any other
/// host, query, fragment, credentials or non-GET method fails. Game content is never
/// served here and the preview view does not register this scheme.
@MainActor
final class StudioSchemeHandler: NSObject {
    static let scheme = "zuku-studio"
    static let host = "app"
    static let pageURL = URL(string: "zuku-studio://app/studio/renderer/index.html")!
    static let contentSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'none'; connect-src 'none'; media-src 'none'; frame-src 'none'; frame-ancestors 'none'; worker-src 'none'; manifest-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

    private let assets: [String: Data]

    init?(resources: URL) {
        var loaded: [String: Data] = [:]
        for (path, file) in Installation.rendererAssets {
            let url = resources.appendingPathComponent(file)
            guard FileTrust.regularFile(url, executable: false), let data = try? Data(contentsOf: url), data.count <= 1_048_576 else { return nil }
            loaded[path] = data
        }
        assets = loaded
    }

    /// Exact allowlisted asset path for a request URL, or nil.
    static func assetPath(_ url: URL?, known: Set<String>) -> String? {
        guard let url, let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              parts.scheme == scheme, parts.host == host, parts.port == nil, parts.user == nil, parts.password == nil,
              parts.query == nil, parts.fragment == nil, known.contains(parts.path) else { return nil }
        return parts.path
    }

    static func mimeType(_ path: String) -> String {
        if path.hasSuffix(".html") { return "text/html; charset=utf-8" }
        if path.hasSuffix(".css") { return "text/css; charset=utf-8" }
        return "text/javascript; charset=utf-8"
    }
}

extension StudioSchemeHandler: @preconcurrency WKURLSchemeHandler {
    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard task.request.httpMethod == nil || task.request.httpMethod == "GET",
              let path = StudioSchemeHandler.assetPath(task.request.url, known: Set(assets.keys)), let data = assets[path],
              let url = task.request.url else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        let headers = [
            "Content-Type": StudioSchemeHandler.mimeType(path),
            "Content-Length": String(data.count),
            "Content-Security-Policy": StudioSchemeHandler.contentSecurityPolicy,
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cache-Control": "no-store",
        ]
        guard let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) else {
            task.didFailWithError(URLError(.cannotParseResponse))
            return
        }
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
        // Responses are delivered synchronously from memory; nothing is in flight.
    }
}
