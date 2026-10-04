using System;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using System.Windows;
using Zuku.Studio.Core;

namespace Zuku.Studio;

static class Program
{
    static string Version => typeof(Program).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>().FirstOrDefault(entry => entry.Key == "ZukuCliVersion")?.Value ?? "0.0.0";

    /// <summary>WPF and WebView2 require a single-threaded apartment UI thread.</summary>
    [STAThread]
    static int Main(string[] args)
    {
        if (args is ["--version"]) { Console(); System.Console.WriteLine($"ZUKU Studio {Version} (Windows WPF/WebView2 integration candidate)"); return 0; }
        if (args is ["--self-test"]) { Console(); return SelfTestAsync(null, null).GetAwaiter().GetResult(); }
        if (args is ["--stdio-test", "--node", var node, "--fixture", var fixture]) { Console(); return SelfTestAsync(node, fixture).GetAwaiter().GetResult(); }

        var launch = LaunchRequest.FromArguments(args);
        var instance = SingleInstance.Acquire();
        if (!instance.Primary)
        {
            var forwarded = SingleInstance.Forward(launch);
            instance.Dispose();
            if (!forwarded) MessageBox.Show("실행 중인 ZUKU Studio에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.", "ZUKU Studio", MessageBoxButton.OK, MessageBoxImage.Warning);
            return forwarded ? 0 : 1;
        }

        var application = new Application { ShutdownMode = ShutdownMode.OnMainWindowClose };
        var window = new MainWindow(instance, Version);
        application.MainWindow = window;
        instance.Listen(request => application.Dispatcher.InvokeAsync(() => window.HandleLaunch(request)));
        window.Show();
        window.HandleLaunch(launch);
        return application.Run();
    }

    static void Console() => Native.AttachConsole(Native.AttachParentProcess);

    /// <summary>Core protocol suite plus checks that need real Windows APIs. Exit code = failures.</summary>
    static async Task<int> SelfTestAsync(string? node, string? fixture)
    {
        var output = System.Console.Out;
        var failed = await SelfTest.RunAsync(output, node, fixture);
        void Check(bool condition, string label) { if (!condition) { failed++; output.WriteLine("FAIL " + label); } }

        // Pipe ACL: protected DACL, current user allowed, network logons denied; a CurrentUserOnly client round trip.
        var security = SingleInstance.Security();
        Check(security.AreAccessRulesProtected, "pipe DACL is protected from inheritance");
        var name = "ZukuStudio-selftest-" + Guid.NewGuid().ToString("N");
        await using (var server = SingleInstance.CreateServer(name))
        {
            var accept = server.WaitForConnectionAsync();
            await using (var client = new NamedPipeClientStream(".", name, PipeDirection.Out, PipeOptions.CurrentUserOnly))
            {
                await client.ConnectAsync(2000);
                await client.WriteAsync(new LaunchRequest(LaunchKind.Connect, null).Encode());
            }
            await accept;
            var buffer = new byte[LaunchRequest.WireBytes];
            var length = await server.ReadAsync(buffer);
            Check(LaunchRequest.Decode(buffer.AsSpan(0, length))?.Kind == LaunchKind.Connect, "single-instance pipe round trip");
        }

        // Job object: closing it terminates the child.
        using (var job = new ProcessJob())
        {
            var cmd = Path.Combine(Environment.SystemDirectory, "where.exe");
            var info = new ProcessStartInfo(cmd) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true };
            info.ArgumentList.Add("/?");
            using var child = Process.Start(info)!;
            try { job.Assign(child); Check(true, "job assign"); }
            catch (InstallationException) { Check(child.HasExited, "job assign (child already exited)"); }
            job.Terminate();
            Check(child.WaitForExit(5000), "job termination ends child");
        }

        var roots = FolderAccess.Roots();
        Check(FolderPolicy.Admit(roots.UserProfile, roots, out _) is null, "user profile refused as project");
        Check(FolderAccess.Canonical(Environment.SystemDirectory, out _) is { } system && FolderPolicy.Admit(system, roots, out _) is null, "system folder refused as project");
        try { output.WriteLine("WebView2 runtime: " + Microsoft.Web.WebView2.Core.CoreWebView2Environment.GetAvailableBrowserVersionString()); }
        catch (Microsoft.Web.WebView2.Core.WebView2RuntimeNotFoundException) { output.WriteLine("WebView2 runtime: not installed (Studio would show STUDIO_WEBVIEW2_MISSING)"); }
        output.WriteLine(failed == 0 ? "Windows native self-test passed (no GUI window, no real Agent Core started)." : $"Windows native self-test: {failed} failures.");
        return Math.Min(failed, 63);
    }
}
