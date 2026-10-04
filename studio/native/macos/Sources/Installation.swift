import Foundation

/// Locates the one shared ZUKU CLI payload next to the app bundle. The shell never
/// searches PATH, the user's home, /root or anything a renderer supplies; it accepts
/// only `<bundle parent>/zuku-runtime` written by the installer (or by build.sh for a
/// local development staging) and fails honestly when that payload is unavailable.
struct Installation: Sendable {
    static let runtimeDirectoryName = "zuku-runtime"
    static let installSchema = "zukujs-user-install/1"
    static let packageName = "@zuku/cli"
    static let legacyPackageName = "@zukujs/cli"

    let bundleResources: URL   // <App>/Contents/Resources/zuku (signed, managed assets)
    let node: URL              // <runtime>/runtime/bin/node (managed Node, one install)
    let hostEntry: URL         // <package>/lib/studio-host.mjs
    let hostDirectory: URL
    let version: String

    enum Failure: String, Error, Sendable {
        case bundleUnavailable = "STUDIO_BUNDLE_UNAVAILABLE"
        case runtimeMissing = "STUDIO_RUNTIME_MISSING"
        case runtimeUntrusted = "STUDIO_RUNTIME_UNTRUSTED"
        case versionMismatch = "STUDIO_RUNTIME_VERSION_MISMATCH"
        case schemaMismatch = "STUDIO_PROTOCOL_SCHEMA_MISMATCH"
    }

    /// Finite, managed renderer asset map: URL path under zuku-studio://app/ → bundle path.
    static let rendererAssets: [String: String] = {
        var map: [String: String] = [:]
        for name in ["index.html", "main.mjs", "index.mjs", "app.mjs", "client.mjs", "state.mjs", "dom.mjs", "diff.mjs", "preview.mjs", "styles.css"] {
            map["/studio/renderer/\(name)"] = "studio/renderer/\(name)"
        }
        map["/lib/agent-protocol/schema.mjs"] = "lib/agent-protocol/schema.mjs"
        return map
    }()
    static let bridgePath = "studio/native/bridge.js"
    static let codecPath = "studio/native/macos/native-codec.js"
    static let schemaPath = "lib/agent-protocol/schema.mjs"
    static let fixturePath = "studio/native/macos/tests/stdio-fixture.mjs"

    static func bundledResources() -> URL? {
        guard let resources = Bundle.main.resourceURL?.appendingPathComponent("zuku", isDirectory: true),
              FileTrust.canonical(resources) else { return nil }
        for path in Array(rendererAssets.values) + [bridgePath, codecPath, schemaPath] {
            guard FileTrust.regularFile(resources.appendingPathComponent(path), executable: false) else { return nil }
        }
        return resources
    }

    static var expectedVersion: String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "ZukuCLIVersion") as? String,
              value.range(of: #"^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$"#, options: .regularExpression) != nil else { return nil }
        return value
    }

    static func locate() -> Result<Installation, Failure> {
        guard let resources = bundledResources(), let version = expectedVersion else { return .failure(.bundleUnavailable) }
        let bundle = Bundle.main.bundleURL
        guard FileTrust.canonical(bundle) else { return .failure(.bundleUnavailable) }
        let runtime = bundle.deletingLastPathComponent().appendingPathComponent(runtimeDirectoryName, isDirectory: true)
        let marker = runtime.appendingPathComponent("install.json")
        guard FileManager.default.fileExists(atPath: marker.path) else { return .failure(.runtimeMissing) }
        guard FileTrust.regularFile(marker, executable: false), let install = FileTrust.jsonObject(marker) else { return .failure(.runtimeUntrusted) }

        let node = runtime.appendingPathComponent("runtime/bin/node")
        let canonical = runtime.appendingPathComponent("npm/lib/node_modules/@zuku/cli", isDirectory: true)
        var packageInfo = stat()
        // A present but invalid canonical package must not fall back to a legacy payload.
        let canonicalPresent = lstat(canonical.path, &packageInfo) == 0 || errno != ENOENT
        let selectedPackageName = canonicalPresent ? packageName : legacyPackageName
        let package = canonicalPresent ? canonical : runtime.appendingPathComponent("npm/lib/node_modules/@zukujs/cli", isDirectory: true)
        guard install["schema"] as? String == installSchema,
              (install["sha256"] as? String)?.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
              install["node"] as? String == node.path else { return .failure(.runtimeUntrusted) }
        guard install["version"] as? String == version else { return .failure(.versionMismatch) }

        let manifest = package.appendingPathComponent("package.json")
        guard FileTrust.regularFile(manifest, executable: false), let pkg = FileTrust.jsonObject(manifest) else { return .failure(.runtimeUntrusted) }
        let bin = pkg["bin"] as? [String: Any]
        guard pkg["name"] as? String == selectedPackageName, bin?["zuku"] as? String == "./index.mjs", bin?["zukujs"] as? String == "./index.mjs" else { return .failure(.runtimeUntrusted) }
        guard pkg["version"] as? String == version else { return .failure(.versionMismatch) }

        let hostEntry = package.appendingPathComponent("lib/studio-host.mjs")
        let hostSchema = package.appendingPathComponent(schemaPath)
        guard FileTrust.regularFile(node, executable: true), FileTrust.regularFile(hostEntry, executable: false),
              FileTrust.regularFile(hostSchema, executable: false) else { return .failure(.runtimeUntrusted) }
        // The renderer, the private codec and the host must speak byte-identical schema.
        guard let bundled = try? Data(contentsOf: resources.appendingPathComponent(schemaPath)),
              let shared = try? Data(contentsOf: hostSchema), bundled == shared else { return .failure(.schemaMismatch) }
        return .success(Installation(bundleResources: resources, node: node, hostEntry: hostEntry,
                                     hostDirectory: hostEntry.deletingLastPathComponent(), version: version))
    }
}

/// Ownership/permission checks for managed files: canonical path (no symlink component),
/// regular file, single link, owned by the user or root, not group/world writable, and the
/// same for every parent directory. `/Applications` (root:admin, 0775) is the only
/// group-writable parent accepted, because admin members can already replace its apps.
enum FileTrust {
    static func canonical(_ url: URL) -> Bool {
        guard url.isFileURL, url.path.hasPrefix("/"), let resolved = realpath(url.path, nil) else { return false }
        defer { free(resolved) }
        return String(cString: resolved) == url.standardizedFileURL.path.trimmingTrailingSlash
    }

    static func regularFile(_ url: URL, executable: Bool) -> Bool {
        guard canonical(url) else { return false }
        var info = stat()
        guard lstat(url.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG, info.st_nlink == 1,
              (info.st_mode & 0o022) == 0, owned(info) else { return false }
        if executable && access(url.path, X_OK) != 0 { return false }
        var directory = url.deletingLastPathComponent()
        while directory.path != "/" {
            guard lstat(directory.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR, owned(info) else { return false }
            let applications = directory.path == "/Applications" && info.st_uid == 0 && info.st_gid == 80
            if (info.st_mode & 0o002) != 0 || ((info.st_mode & 0o020) != 0 && !applications) { return false }
            directory = directory.deletingLastPathComponent()
        }
        return true
    }

    static func jsonObject(_ url: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: url), data.count <= 65536,
              let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return value
    }

    private static func owned(_ info: stat) -> Bool { info.st_uid == geteuid() || info.st_uid == 0 }
}

extension String {
    var trimmingTrailingSlash: String {
        var value = self
        while value.count > 1 && value.hasSuffix("/") { value.removeLast() }
        return value
    }
}
