using System;
using System.Collections.Frozen;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Zuku.Studio.Core;

/// <summary>Thrown with a stable code when the shared CLI installation is not usable. Never contains paths.</summary>
public sealed class InstallationException(string code) : Exception(code)
{
    public string Code { get; } = code;
}

/// <summary>The one verified CLI release Studio runs from. Assets are read into memory once.</summary>
public sealed record Installation(string ReleaseRoot, string PackageRoot, string NodePath, string HostEntry, string Bridge, FrozenDictionary<string, byte[]> Assets);

/// <summary>
/// Finds the shared installed CLI by exact layout, marker and version — never by searching
/// PATH, the working directory, the user's home or renderer input:
///   &lt;prefix&gt;\releases\cli-&lt;version&gt;-&lt;sha12&gt;\
///       install.json                       {schema:'zukujs-user-install/1', version, sha256, node}
///       runtime\node.exe                   managed Node (must equal install.json node)
///       npm\node_modules\@zukujs\cli\      package.json name '@zukujs/cli', same version
///       studio\windows\ZukuStudio.exe      this executable
/// </summary>
public static partial class InstallLocator
{
    public const string Schema = "zukujs-user-install/1";

    /// <summary>URL path (on the trusted virtual origin) → package-relative file. The finite renderer allowlist.</summary>
    public static readonly FrozenDictionary<string, string> ServedAssets = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["/studio/renderer/index.html"] = "studio/renderer/index.html",
        ["/studio/renderer/main.mjs"] = "studio/renderer/main.mjs",
        ["/studio/renderer/index.mjs"] = "studio/renderer/index.mjs",
        ["/studio/renderer/app.mjs"] = "studio/renderer/app.mjs",
        ["/studio/renderer/client.mjs"] = "studio/renderer/client.mjs",
        ["/studio/renderer/state.mjs"] = "studio/renderer/state.mjs",
        ["/studio/renderer/dom.mjs"] = "studio/renderer/dom.mjs",
        ["/studio/renderer/diff.mjs"] = "studio/renderer/diff.mjs",
        ["/studio/renderer/preview.mjs"] = "studio/renderer/preview.mjs",
        ["/studio/renderer/styles.css"] = "studio/renderer/styles.css",
        ["/lib/agent-protocol/schema.mjs"] = "lib/agent-protocol/schema.mjs",
    }.ToFrozenDictionary(StringComparer.Ordinal);

    public const string BridgeFile = "studio/native/bridge.js";
    public const string HostFile = "lib/studio-host.mjs";
    const int AssetBytes = 1 << 20;

    [GeneratedRegex("^cli-([0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.-]+)?)-([a-f0-9]{12})$", RegexOptions.CultureInvariant)]
    private static partial Regex ReleaseName();
    [GeneratedRegex("^[a-f0-9]{64}$", RegexOptions.CultureInvariant)]
    private static partial Regex Sha256();

    /// <param name="executableDirectory">Directory of the running ZukuStudio.exe (AppContext.BaseDirectory).</param>
    /// <param name="expectedVersion">CLI version compiled into this shell.</param>
    /// <param name="nodeRelative">Managed runtime path inside the release ("runtime\node.exe" on Windows).</param>
    public static Installation Locate(string executableDirectory, string expectedVersion, string nodeRelative)
    {
        var directory = new DirectoryInfo(Path.TrimEndingDirectorySeparator(Path.GetFullPath(executableDirectory)));
        if (!directory.Name.Equals("windows", StringComparison.OrdinalIgnoreCase) || directory.Parent is not { } studio
            || !studio.Name.Equals("studio", StringComparison.OrdinalIgnoreCase) || studio.Parent is not { } release)
            throw new InstallationException("STUDIO_LAYOUT_UNSUPPORTED");
        var name = ReleaseName().Match(release.Name);
        if (!name.Success || name.Groups[1].Value != expectedVersion) throw new InstallationException("STUDIO_VERSION_MISMATCH");
        var root = release.FullName;
        NoReparse(root, root);

        var marker = ReadJson(Path.Combine(root, "install.json"), root, 4096);
        var node = Path.GetFullPath(Path.Combine(root, nodeRelative));
        if (JsonSafety.String(marker, "schema") != Schema || JsonSafety.String(marker, "version") != expectedVersion
            || JsonSafety.String(marker, "sha256") is not { } sha || !Sha256().IsMatch(sha) || !sha.StartsWith(name.Groups[2].Value, StringComparison.Ordinal))
            throw new InstallationException("STUDIO_MARKER_INVALID");
        // Only the managed runtime of this same release; a system Node chosen with -NoNode is not trusted here.
        if (JsonSafety.String(marker, "node") is not { } markerNode || !SamePath(Path.GetFullPath(markerNode), node))
            throw new InstallationException("STUDIO_RUNTIME_UNMANAGED");
        RegularFile(node, root, "STUDIO_RUNTIME_MISSING");

        var package = Path.Combine(root, "npm", "node_modules", "@zukujs", "cli");
        var manifest = ReadJson(Path.Combine(package, "package.json"), root, 65536);
        if (JsonSafety.String(manifest, "name") != "@zukujs/cli" || JsonSafety.String(manifest, "version") != expectedVersion
            || !manifest.TryGetProperty("bin", out var bin) || JsonSafety.String(bin, "zuku") != "./index.mjs" || JsonSafety.String(bin, "zukujs") != "./index.mjs")
            throw new InstallationException("STUDIO_PACKAGE_INVALID");

        var host = Resolve(package, HostFile);
        RegularFile(host, root, "STUDIO_HOST_MISSING");
        var bridge = Resolve(package, BridgeFile);
        var assets = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        foreach (var (url, relative) in ServedAssets) assets[url] = ReadBounded(Resolve(package, relative), root);
        var bridgeBytes = ReadBounded(bridge, root);
        var bridgeText = System.Text.Encoding.UTF8.GetString(bridgeBytes);
        return new Installation(root, package, node, host, bridgeText, assets.ToFrozenDictionary(StringComparer.Ordinal));
    }

    static string Resolve(string package, string relative) => Path.GetFullPath(Path.Combine(package, relative.Replace('/', Path.DirectorySeparatorChar)));

    static bool SamePath(string a, string b) => string.Equals(a, b, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    /// <summary>Rejects symlinks/junctions on every component from the release root down to path.</summary>
    static void NoReparse(string path, string root)
    {
        var current = new DirectoryInfo(path) as FileSystemInfo;
        if (File.Exists(path)) current = new FileInfo(path);
        while (current is not null)
        {
            if (!current.Exists) throw new InstallationException("STUDIO_ASSETS_MISSING");
            if (current.Attributes.HasFlag(FileAttributes.ReparsePoint) || current.LinkTarget is not null) throw new InstallationException("STUDIO_LINK_REJECTED");
            if (SamePath(current.FullName.TrimEnd(Path.DirectorySeparatorChar), root.TrimEnd(Path.DirectorySeparatorChar))) return;
            current = current is FileInfo file ? file.Directory : ((DirectoryInfo)current).Parent;
            if (current is not null && !current.FullName.StartsWith(root, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal)) break;
        }
        throw new InstallationException("STUDIO_LAYOUT_UNSUPPORTED");
    }

    static void RegularFile(string path, string root, string code)
    {
        if (!File.Exists(path)) throw new InstallationException(code);
        NoReparse(path, root);
    }

    static byte[] ReadBounded(string path, string root)
    {
        RegularFile(path, root, "STUDIO_ASSETS_MISSING");
        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (stream.Length > AssetBytes) throw new InstallationException("STUDIO_ASSET_TOO_LARGE");
        var bytes = new byte[stream.Length];
        stream.ReadExactly(bytes);
        return bytes;
    }

    static JsonElement ReadJson(string path, string root, int maximum)
    {
        RegularFile(path, root, "STUDIO_MARKER_MISSING");
        var bytes = ReadBounded(path, root);
        if (bytes.Length > maximum) throw new InstallationException("STUDIO_MARKER_INVALID");
        // install.json is UTF-8 from the Windows installer; tolerate a BOM only.
        var start = bytes.Length >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF ? 3 : 0;
        using var document = JsonSafety.Parse(bytes.AsMemory(start), maximum);
        if (document is null || document.RootElement.ValueKind != JsonValueKind.Object) throw new InstallationException("STUDIO_MARKER_INVALID");
        return document.RootElement.Clone();
    }
}

/// <summary>Response policy for the trusted editor's virtual origin.</summary>
public static class TrustedOrigin
{
    /// <summary>Reserved .example name; requests never reach the network (all are answered by WebResourceRequested).</summary>
    public const string Origin = "https://zuku-studio.example";
    public const string PageUri = Origin + "/studio/renderer/index.html";

    /// <summary>Same directives as studio/renderer/index.html, plus frame-ancestors (header-only).</summary>
    public const string ContentSecurityPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'none'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

    public static string ContentType(string urlPath) => Path.GetExtension(urlPath) switch
    {
        ".html" => "text/html; charset=utf-8",
        ".mjs" or ".js" => "text/javascript; charset=utf-8",
        ".css" => "text/css; charset=utf-8",
        _ => "application/octet-stream",
    };

    public static IReadOnlyList<KeyValuePair<string, string>> Headers(string urlPath) =>
    [
        new("Content-Type", ContentType(urlPath)),
        new("Content-Security-Policy", ContentSecurityPolicy),
        new("X-Content-Type-Options", "nosniff"),
        new("Cache-Control", "no-store"),
        new("Referrer-Policy", "no-referrer"),
        new("Cross-Origin-Opener-Policy", "same-origin"),
        new("Cross-Origin-Resource-Policy", "same-origin"),
    ];

    /// <summary>Maps an exact GET URL on the trusted origin to an allowlisted asset path; anything else is null.</summary>
    public static string? AssetFor(string? method, string? uri)
    {
        if (method != "GET" || uri is null || !Uri.TryCreate(uri, UriKind.Absolute, out var parsed)) return null;
        if (parsed.Scheme != Uri.UriSchemeHttps || parsed.Host != "zuku-studio.example" || !parsed.IsDefaultPort || parsed.UserInfo.Length != 0) return null;
        if (parsed.Query.Length != 0 || uri.Contains('#') || parsed.AbsoluteUri != uri) return null;
        return InstallLocator.ServedAssets.ContainsKey(parsed.AbsolutePath) ? parsed.AbsolutePath : null;
    }

    /// <summary>
    /// bridge.js runs at document start in every document of the editor WebView2 unless guarded;
    /// the guard limits it to the top frame of the exact trusted page.
    /// </summary>
    public static string BridgeScript(string bridge) =>
        "if (window === window.top && location.href === " + JsonSerializer.Serialize(PageUri) + ") {\n" + bridge + "\n}\n";
}
