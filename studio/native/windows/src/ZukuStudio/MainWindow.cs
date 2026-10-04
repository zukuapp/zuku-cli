using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Threading;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Zuku.Studio.Core;

namespace Zuku.Studio;

/// <summary>
/// ZUKU Studio window. Two WebView2 environments with separate user-data folders (separate
/// browser processes), both InPrivate:
///  - editor: the trusted renderer served from in-memory installed assets on a virtual origin;
///    bridge.js at document start in the top frame only; the only web-message endpoint.
///  - preview: the game, unprivileged — no host objects, no web messages, no bridge, navigation and
///    every request confined to the exact loopback origin + nonce path the host resolved.
/// All protocol decisions live in Core's StudioRouter; this class performs the side effects.
/// </summary>
sealed class MainWindow : Window
{
    const string PreviewGuard = """
        (() => {
          'use strict';
          // Defense in depth only; the hard boundary is the request filter and missing bridge.
          const denied = () => Promise.reject(new DOMException('ZUKU preview: file access is disabled', 'NotAllowedError'));
          for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker'])
            try { Object.defineProperty(window, name, { value: denied, writable: false, configurable: false }); } catch {}
          const showPicker = HTMLInputElement.prototype.showPicker;
          try {
            Object.defineProperty(HTMLInputElement.prototype, 'showPicker', { writable: false, configurable: false, value: function () {
              if (String(this.type).toLowerCase() === 'file') throw new DOMException('ZUKU preview: file access is disabled', 'NotAllowedError');
              return showPicker.call(this);
            } });
          } catch {}
          const block = event => {
            const target = event.target;
            if (target instanceof HTMLInputElement && String(target.type).toLowerCase() === 'file') { event.preventDefault(); event.stopImmediatePropagation(); }
          };
          for (const type of ['click', 'keydown', 'drop']) window.addEventListener(type, block, true);
        })();
        """;

    readonly SingleInstance instance;
    readonly string version;
    readonly WebView2 editor = new() { DefaultBackgroundColor = System.Drawing.Color.FromArgb(255, 15, 23, 42) };
    readonly Canvas overlay = new() { ClipToBounds = true };
    readonly TextBlock status = new() { Margin = new Thickness(12, 4, 12, 4), TextTrimming = TextTrimming.CharacterEllipsis };
    readonly Grid content = new();
    readonly StudioRouter router = new(ProtocolManifest.Current, () => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    readonly DispatcherTimer expiry;
    WebView2? preview;
    Uri? previewBase;
    Installation? installation;
    HostConnection? host;
    ProcessJob? job;
    PromptWindow? prompt;
    string? projectHint;
    long previewTicket;
    bool closed;

    public MainWindow(SingleInstance instance, string version)
    {
        this.instance = instance;
        this.version = version;
        Title = "ZUKU Studio " + version;
        Width = 1440;
        Height = 880;
        MinWidth = 720;
        MinHeight = 480;
        Background = new SolidColorBrush(Color.FromRgb(15, 23, 42));

        var root = new Grid();
        root.RowDefinitions.Add(new RowDefinition { Height = new GridLength(1, GridUnitType.Star) });
        root.RowDefinitions.Add(new RowDefinition { Height = GridLength.Auto });
        content.Children.Add(editor);
        content.Children.Add(overlay);       // preview is positioned above the editor at the renderer's rect
        root.Children.Add(content);
        var bar = new Border { Background = new SolidColorBrush(Color.FromRgb(30, 41, 59)), Child = status };
        status.Foreground = Brushes.Gainsboro;
        Grid.SetRow(bar, 1);
        root.Children.Add(bar);
        Content = root;

        expiry = new DispatcherTimer(TimeSpan.FromSeconds(5), DispatcherPriority.Background, (_, _) => Apply(router.Tick()), Dispatcher);
        Loaded += async (_, _) => await StartAsync();
        Closed += (_, _) => Shutdown();
    }

    void Status(string text) => status.Text = text;

    // ---------------------------------------------------------------- startup
    async Task StartAsync()
    {
        try { _ = CoreWebView2Environment.GetAvailableBrowserVersionString(); }
        catch (WebView2RuntimeNotFoundException)
        {
            Status("STUDIO_WEBVIEW2_MISSING · Microsoft Edge WebView2 런타임이 필요합니다. ZUKU 설치 도구를 다시 실행해 주세요.");
            return;
        }
        try
        {
            installation = InstallLocator.Locate(AppContext.BaseDirectory, version, @"runtime\node.exe");
            TrustedFiles.Verify(installation);
        }
        catch (Exception error) when (error is InstallationException or IOException or UnauthorizedAccessException)
        {
            var code = error is InstallationException known ? known.Code : "STUDIO_INSTALL_UNREADABLE";
            Status(code + " · 설치된 ZUKU CLI와 Studio 구성 요소를 확인하지 못했습니다. `zuku doctor`로 확인하거나 다시 설치해 주세요.");
            return;
        }

        try
        {
            await InitializeEditorAsync(installation);
        }
        catch (Exception error) when (error is System.Runtime.InteropServices.COMException or InvalidOperationException or ArgumentException)
        {
            Status("STUDIO_WEBVIEW2_FAILED · 화면 구성 요소를 시작하지 못했습니다. 다시 실행해 주세요.");
            return;
        }
        StartHost(installation);
        editor.CoreWebView2.Navigate(TrustedOrigin.PageUri);
        expiry.Start();
    }

    static string DataFolder(string name)
    {
        var folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ZUKU", "Studio", "WebView2", name);
        Directory.CreateDirectory(folder);
        return folder;
    }

    static async Task<(CoreWebView2Environment, CoreWebView2ControllerOptions)> EnvironmentAsync(string name)
    {
        // No extra browser arguments: the Chromium sandbox and site isolation stay at their defaults.
        var options = new CoreWebView2EnvironmentOptions
        {
            AllowSingleSignOnUsingOSPrimaryAccount = false,
            AreBrowserExtensionsEnabled = false,
            EnableTrackingPrevention = true,
        };
        var environment = await CoreWebView2Environment.CreateAsync(null, DataFolder(name), options);
        var controller = environment.CreateCoreWebView2ControllerOptions();
        controller.ProfileName = name;
        controller.IsInPrivateModeEnabled = true;
        return (environment, controller);
    }

    static void Harden(CoreWebView2Settings settings, bool messages)
    {
        settings.AreDevToolsEnabled = false;
        settings.AreDefaultContextMenusEnabled = false;
        settings.AreHostObjectsAllowed = false;
        settings.IsWebMessageEnabled = messages;
        settings.IsStatusBarEnabled = false;
        settings.IsZoomControlEnabled = false;
        settings.IsPinchZoomEnabled = false;
        settings.IsSwipeNavigationEnabled = false;
        settings.IsGeneralAutofillEnabled = false;
        settings.IsPasswordAutosaveEnabled = false;
        settings.AreBrowserAcceleratorKeysEnabled = false;
        settings.AreDefaultScriptDialogsEnabled = false;
    }

    static void DenyCommon(CoreWebView2 core)
    {
        core.NewWindowRequested += (_, e) => e.Handled = true;                 // no popups, no new windows
        core.PermissionRequested += (_, e) => { e.State = CoreWebView2PermissionState.Deny; e.Handled = true; };
        core.DownloadStarting += (_, e) => { e.Cancel = true; e.Handled = true; };
        core.LaunchingExternalUriScheme += (_, e) => e.Cancel = true;
        core.BasicAuthenticationRequested += (_, e) => e.Cancel = true;
        core.ClientCertificateRequested += (_, e) => { e.Cancel = true; e.Handled = true; };
        core.ContextMenuRequested += (_, e) => e.Handled = true;
    }

    async Task InitializeEditorAsync(Installation trusted)
    {
        var (environment, controller) = await EnvironmentAsync("editor");
        await editor.EnsureCoreWebView2Async(environment, controller);
        editor.AllowExternalDrop = false;
        editor.ZoomFactor = 1.0;
        var core = editor.CoreWebView2;
        Harden(core.Settings, messages: true);
        DenyCommon(core);
        core.NavigationStarting += (_, e) => { if (e.Uri != TrustedOrigin.PageUri) e.Cancel = true; };
        core.FrameNavigationStarting += (_, e) => e.Cancel = true;         // the renderer has no frames (frame-src 'none')
        core.ProcessFailed += (_, _) => Status("STUDIO_RENDERER_FAILED · 화면 프로세스가 종료되었습니다. Studio를 다시 실행해 주세요.");

        // Constrained virtual origin: exactly the allowlisted, already-verified in-memory assets.
        // Every other request (any origin, any frame, workers) is answered locally and never reaches the network.
        core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All);
        core.WebResourceRequested += (_, e) =>
        {
            var asset = TrustedOrigin.AssetFor(e.Request.Method, e.Request.Uri);
            if (asset is not null && trusted.Assets.TryGetValue(asset, out var bytes))
            {
                var headers = string.Join("\r\n", TrustedOrigin.Headers(asset).Select(pair => pair.Key + ": " + pair.Value));
                e.Response = environment.CreateWebResourceResponse(new MemoryStream(bytes, writable: false), 200, "OK", headers);
            }
            else e.Response = environment.CreateWebResourceResponse(null, 404, "Not Found", "Cache-Control: no-store");
        };

        // window.zukuStudio: root bridge.js, document start, guarded to the trusted top frame.
        await core.AddScriptToExecuteOnDocumentCreatedAsync(TrustedOrigin.BridgeScript(trusted.Bridge));
        core.WebMessageReceived += (_, e) =>
        {
            if (e.Source != TrustedOrigin.PageUri || core.Source != TrustedOrigin.PageUri) return;
            string message;
            try { message = e.TryGetWebMessageAsString(); }
            catch (ArgumentException) { return; }
            Apply(router.FromRenderer(message));
        };
    }

    // ---------------------------------------------------------------- stdio host
    void StartHost(Installation trusted)
    {
        try
        {
            job = new ProcessJob();
            host = HostConnection.Start(trusted.NodePath, [trusted.HostEntry, "--stdio"], Path.GetDirectoryName(trusted.HostEntry)!, router.Outgoing, job.Assign);
        }
        catch (Exception error) when (error is InstallationException or System.ComponentModel.Win32Exception or IOException)
        {
            Status("STUDIO_CORE_UNAVAILABLE · 로컬 ZUKU 코어를 시작하지 못했습니다. `zuku doctor`로 확인해 주세요.");
            Apply(router.HostUnavailable());
            return;
        }
        Status("로컬 ZUKU 코어에 연결했습니다.");
        _ = PumpAsync(host);
    }

    async Task PumpAsync(HostConnection connection)
    {
        // Runs on the UI dispatcher; the bounded channel back-pressures the reader while we render.
        try
        {
            await foreach (var line in connection.Lines.ReadAllAsync())
            {
                Apply(router.FromHost(line));
                if (closed) return;
            }
        }
        catch (InvalidOperationException) { }
        var reason = await connection.Completion;
        if (closed) return;
        Apply(router.HostUnavailable());
        Status(reason switch
        {
            "HOST_LINE_TOO_LARGE" or "HOST_PROTOCOL_MISMATCH" => reason + " · 코어 통신 형식이 맞지 않아 연결을 종료했습니다. 업데이트를 확인해 주세요.",
            _ => "STUDIO_CORE_STOPPED · 로컬 ZUKU 코어 연결이 종료되었습니다. Studio를 다시 실행해 주세요.",
        });
    }

    // ---------------------------------------------------------------- router side effects
    void Apply(System.Collections.Generic.IEnumerable<RouterAction> actions)
    {
        foreach (var action in actions)
        {
            if (closed) return;
            switch (action)
            {
                case RouterAction.ToRenderer render:
                    // Structured message to the bridge's chrome.webview listener (= ZukuStudioReceive). No script evaluation.
                    if (editor.CoreWebView2 is { } core && core.Source == TrustedOrigin.PageUri) core.PostWebMessageAsJson(render.Json);
                    break;
                case RouterAction.HostWrite:
                    host?.Signal();
                    break;
                case RouterAction.HostFault fault:
                    host?.Fault(fault.Code);
                    break;
                case RouterAction.OpenPicker picker:
                    _ = Dispatcher.InvokeAsync(() => PickFolder(picker.RequestId));
                    break;
                case RouterAction.ShowPreview show:
                    _ = ShowPreviewAsync(show.Url, show.Rect);
                    break;
                case RouterAction.HidePreview:
                    HidePreview();
                    break;
                case RouterAction.ShowPrompt show:
                    OpenPrompt(show.Prompt);
                    break;
                case RouterAction.ClosePrompt close:
                    if (prompt?.RequestId == close.RequestId) { prompt.Dismiss(); PromptClosed(); }
                    break;
            }
        }
    }

    void PickFolder(string requestId)
    {
        var dialog = new Microsoft.Win32.OpenFolderDialog { Title = "게임 프로젝트 폴더 선택", Multiselect = false };
        if (projectHint is not null && Directory.Exists(projectHint)) dialog.InitialDirectory = projectHint;
        string? canonical = null, reason = null;
        if (dialog.ShowDialog(this) == true)
        {
            canonical = FolderAccess.Canonical(dialog.FolderName, out reason);
            if (canonical is not null) canonical = FolderPolicy.Admit(canonical, FolderAccess.Roots(), out reason);
            if (canonical is null) Status((reason ?? "PROJECT_PATH_INVALID") + " · 개별 게임 폴더를 선택해 주세요. 드라이브 루트, 사용자 홈, 시스템·인증 폴더와 링크는 열 수 없습니다.");
        }
        Apply(router.PickerCompleted(requestId, canonical, canonical is null ? reason : null));
    }

    void OpenPrompt(PromptRequest request)
    {
        prompt = new PromptWindow(this, request, (answered, allow, value) =>
        {
            if (answered.Kind == PromptKind.Pairing) Apply(router.PairingDecided(answered.RequestId, allow));
            else Apply(router.AuthAnswered(answered.RequestId, allow ? value : ""));
            PromptClosed();
        });
        content.IsEnabled = false;      // modal over the editor without blocking the dispatcher pump
        prompt.Show();
        prompt.Activate();
    }

    void PromptClosed()
    {
        prompt = null;
        content.IsEnabled = true;
    }

    // ---------------------------------------------------------------- game preview
    async Task ShowPreviewAsync(Uri url, PreviewRect rect)
    {
        var ticket = ++previewTicket;
        var width = Math.Min(rect.Width, editor.ActualWidth - rect.X);
        var height = Math.Min(rect.Height, editor.ActualHeight - rect.Y);
        if (width < 16 || height < 16) { HidePreview(); return; }
        if (preview is null)
        {
            var view = new WebView2 { DefaultBackgroundColor = System.Drawing.Color.Black };
            preview = view;
            overlay.Children.Add(view);
            try
            {
                var (environment, controller) = await EnvironmentAsync("preview");
                await view.EnsureCoreWebView2Async(environment, controller);
            }
            catch (Exception error) when (error is System.Runtime.InteropServices.COMException or InvalidOperationException or ArgumentException)
            {
                overlay.Children.Remove(view);
                preview = null;
                Status("STUDIO_PREVIEW_FAILED · 게임 미리보기 화면을 시작하지 못했습니다.");
                return;
            }
            view.AllowExternalDrop = false;
            var core = view.CoreWebView2;
            Harden(core.Settings, messages: false);
            DenyCommon(core);
            bool Allowed(string? uri) => uri == "about:blank" || previewBase is not null && PreviewPolicy.Within(previewBase, uri);
            core.NavigationStarting += (_, e) => { if (!Allowed(e.Uri)) e.Cancel = true; };
            core.FrameNavigationStarting += (_, e) => { if (!Allowed(e.Uri)) e.Cancel = true; };
            core.AddWebResourceRequestedFilter("*", CoreWebView2WebResourceContext.All, CoreWebView2WebResourceRequestSourceKinds.All);
            core.WebResourceRequested += (_, e) =>
            {
                if (!Allowed(e.Request.Uri)) e.Response = core.Environment.CreateWebResourceResponse(null, 403, "Forbidden", "Cache-Control: no-store");
            };
            await core.AddScriptToExecuteOnDocumentCreatedAsync(PreviewGuard);
            core.ProcessFailed += (_, _) => HidePreview();
        }
        // A later show/hide superseded this one while the preview environment was starting.
        if (closed || ticket != previewTicket || preview?.CoreWebView2 is not { } previewCore) return;
        Canvas.SetLeft(preview, rect.X);
        Canvas.SetTop(preview, rect.Y);
        preview.Width = width;
        preview.Height = height;
        preview.Visibility = Visibility.Visible;
        if (previewBase != url)
        {
            previewBase = url;
            previewCore.Navigate(url.AbsoluteUri);
        }
    }

    void HidePreview()
    {
        previewTicket++;
        previewBase = null;
        if (preview is null) return;
        preview.Visibility = Visibility.Collapsed;
        if (preview.CoreWebView2 is { } core) { core.Stop(); core.Navigate("about:blank"); }
    }

    // ---------------------------------------------------------------- launches and shutdown
    public void HandleLaunch(LaunchRequest request)
    {
        if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
        Show();
        Activate();
        Topmost = true;
        Topmost = false;
        Focus();
        switch (request.Kind)
        {
            case LaunchKind.Connect:
                Status("ai.zuzunza.com 연결 요청을 기다립니다. 승인은 이 Studio의 확인 창에서만 할 수 있습니다.");
                break;
            case LaunchKind.Project when request.ProjectPath is not null:
                projectHint = request.ProjectPath;
                Status("요청한 폴더를 열려면 Studio에서 ‘프로젝트 열기’를 눌러 직접 선택해 주세요.");
                break;
        }
    }

    void Shutdown()
    {
        if (closed) return;
        closed = true;
        expiry.Stop();
        prompt?.Dismiss();
        try { host?.StopAsync(TimeSpan.FromSeconds(2)).GetAwaiter().GetResult(); }
        catch (Exception error) when (error is InvalidOperationException or IOException) { }
        job?.Terminate();
        job?.Dispose();
        instance.Dispose();
    }
}
