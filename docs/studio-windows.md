# ZUKU Studio for Windows (native shell)

`studio/native/windows/` is the Windows desktop shell for ZUKU Studio: a small WPF
window hosting Microsoft Edge WebView2. Like the Linux GTK/WebKit shell, it owns no
agent, provider, credential or project logic. It does three things:

1. Starts the one shared Agent Core as a typed stdio child: the release's managed
   `node.exe` running `lib/studio-host.mjs --stdio`.
2. Shows the shared renderer (`studio/renderer/`) and connects it to that child
   through the root `studio/native/bridge.js`.
3. Provides the native-only pieces: the folder picker, the pairing and credential
   dialogs, the isolated game preview, single-instance handling and `zuku://ai/connect`.

`zuku` and `zukujs` stay one CLI. Studio uses the same installed package, Core,
configuration, credentials and sessions. There is no Electron and no second Node runtime.

## Verification status (2026-10-04)

| Check | Where | Status |
| --- | --- | --- |
| `node --test studio/native/windows/tests/windows-shell.test.mjs`: manifest drift, asset allowlist and renderer imports, CSP equality, bundled .NET/WPF publish guards, WebView2 pin and missing-runtime check, forbidden APIs, single message endpoint, managed host argv, limits and synthetic fixture contract | Linux, Node 22.23.2 | **9/9 pass** |
| `scripts/platform-build/tests/platform-build.test.mjs`: all six native recipes; both Windows RIDs publish self-contained; explicit stdio peer, managed Node, full output-directory placement and package/archive boundaries | Linux, Node 22.23.2 | **24/24 pass**, synthetic packaging fixtures |
| C# compile (`dotnet build`), `ZukuStudio.Core.Tests` (protocol, routing, prompts, bounds, policies, install locator, stdio vs synthetic fixture) | needs .NET 10 SDK | **Not run: no .NET SDK on this host** |
| `ZukuStudio.exe --self-test` / `--stdio-test` (pipe ACL round trip, Job Object, folder policy on real paths) | Windows | **Not run** |
| GUI: window, WebView2, picker, dialogs, preview, single instance, protocol launch | Windows 10/11 | **Not run. No Windows GUI or build was checked here.** |

Run `build.ps1` on Windows to do the rest. A Linux job can also run the Core test
runner and compile the WPF project (`EnableWindowsTargeting`), but it cannot run it.

## Runtime choice and installer contract

- **.NET 10**, `net10.0-windows`, WPF. Official `win-x64` and `win-arm64` assets
  use `SelfContained=true` and explicit `dotnet publish --self-contained true`
  in both `build.ps1` and the platform build matrix. The complete publish folder
  includes its .NET Windows Desktop runtime; the user does not need a separate
  .NET installation. Building still needs the .NET SDK. The project rejects a
  framework-dependent or incomplete publish folder before it can become an asset.
  Its default RID is `win-x64`; `-r win-arm64` overrides it. This does not bundle
  another Node: the shared Agent Core still uses the installer's managed `node.exe`.
  Bundled .NET security updates require rebuilding and replacing the Studio asset;
  it does not roll forward to a globally installed runtime. See Microsoft's
  [self-contained deployment documentation](https://learn.microsoft.com/en-us/dotnet/core/deploying/#publish-as-self-contained).
- **Microsoft Edge WebView2 Runtime (Evergreen)** remains a separate prerequisite;
  self-contained .NET does not include it. Studio checks the actual runtime with
  `GetAvailableBrowserVersionString()`. If missing, it shows `STUDIO_WEBVIEW2_MISSING`.
  The installer may run Microsoft's Evergreen Bootstrapper, which supports a
  per-user install. The Fixed Version runtime is not used. See Microsoft's
  [WebView2 distribution guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution).
- **NuGet `Microsoft.Web.WebView2` exactly `[1.0.4258.31]`** is the source pin.
  `WebView2Loader.dll` ships in the publish output for the chosen RID.

## Installed layout and discovery

Studio does not search PATH, the working directory, the user's home or anything the
renderer supplies. It accepts exactly the per-user release layout that
`scripts/installers/templates/install.ps1.in` already produces, with Studio added at
`studio\windows\`:

```text
%LOCALAPPDATA%\ZukuJS\releases\cli-<version>-<sha12>\
  install.json                      {schema:'zukujs-user-install/1', version, sha256, node}
  runtime\node.exe                  managed Node; must equal install.json "node"
  npm\node_modules\@zukujs\cli\     package.json name '@zukujs/cli', same version, bin zuku/zukujs
  studio\windows\ZukuStudio.exe     (+ its DLLs)   <- installer must place the publish output here
```

`InstallLocator` checks all of the following and otherwise fails with a stable code
shown in the status bar, never a path:

- the directory names;
- `cli-<version>-<sha12>` equals the version compiled into the exe (`ZukuCliVersion`,
  passed from `package.json`), and `<sha12>` matches `install.json` `sha256`;
- `install.json` schema and version;
- `install.json` `node` equals this release's `runtime\node.exe` (`-NoNode` installs
  that use a system Node fail with `STUDIO_RUNTIME_UNMANAGED`);
- `package.json` identity;
- no reparse point (symlink or junction) on any component inside the release;
- every asset is a regular file of at most 1 MiB.

`TrustedFiles` then checks the Windows DACLs. Only the current user, SYSTEM,
Administrators and TrustedInstaller may write the files and directories Studio loads
or executes. Ancestors of the release must not be renamable or re-permissionable by
anyone else. A failure gives `STUDIO_ACL_UNSAFE`, for example a custom `-Prefix` on a
drive where Authenticated Users have Modify.

The served assets and `bridge.js` are read into memory once, after verification.
Later file changes are never served.

## Process model

```text
ZukuStudio.exe (WPF, STA UI thread)
 ├─ editor WebView2  (environment "editor", InPrivate)   trusted renderer + bridge.js
 ├─ preview WebView2 (environment "preview", InPrivate)  game only, unprivileged
 └─ node.exe lib\studio-host.mjs --stdio   (Job Object: KILL_ON_JOB_CLOSE)
```

- The host is started with `ProcessStartInfo`: `UseShellExecute=false`, the
  `ArgumentList` exactly `[<package>\lib\studio-host.mjs, --stdio]`, no shell and no
  command strings. `NODE_OPTIONS`, `NODE_PATH` and `NODE_REPL_EXTERNAL_MODULE` are
  removed from its environment, and the working directory is `<package>\lib`.
- The child goes into a kill-on-close Job Object, so if Studio exits or crashes,
  Windows ends the host and everything it started (builds, game servers). A normal
  close first closes stdin, waits 2 s, then terminates the job.
- stdout is framed by `\n`. A line over **262,144 bytes** ends the host
  (`HOST_LINE_TOO_LARGE`). Lines pass through a bounded channel of 64, so a busy UI
  slows the reader instead of growing memory.
- stdin is one writer draining a bounded queue: at most **64 lines / 256 KiB**, each
  line **≤ 65,536 bytes** including the newline. A full queue answers the renderer
  `HOST_QUEUE_FULL`.
- stderr is drained and discarded. Studio logs no protocol content.
- Up to 128 pending requests, each expiring after 180 s (`HOST_TIMEOUT`). If the
  host exits, every open request fails with `HOST_UNAVAILABLE`, prompts close, the
  preview hides and no new work is accepted.

## Protocol between renderer, shell and host

All routing is in the platform-neutral `ZukuStudio.Core` (`StudioRouter`,
`RendererGate`). WPF only performs the side effects, so the same logic is
unit-tested on any OS.

Renderer → shell messages are `window.zukuStudio` envelopes
`{protocolVersion:1, id, method, params}`, each at most 64 KiB, with exact keys, no
duplicate keys, no secret-like keys or text, no control characters and depth ≤ 12.
Ids starting with `native_` are reserved for the shell.

| Method from the renderer | Shell behaviour |
| --- | --- |
| Core RPC on the `bridge.js` allowlist (27 methods) | Key shape checked against `schema.mjs` `METHODS`, then forwarded under the renderer's id. The host validates values again with the same schema. |
| `native.subscribe {subscriptionId, sessionId, afterSequence}` / `native.unsubscribe {subscriptionId}` | Forwarded. Unsubscribe only detaches; it never cancels agent work. |
| `native.pickProject {}` | Intercepted. Opens the OS folder picker (`OpenFolderDialog`). The choice is canonicalized and policy-checked (below), then sent as `native.projectChosen {requestId:<picker id>, localPath}` with a `native_` id over protected stdio. The host's answer to the original picker id, or to the native id, goes back to the renderer. Cancel gives `COMMAND_CANCELLED`. |
| `native.previewShow {previewHandle, rect:{x,y,width,height}}` | Intercepted. Sends `native.resolvePreview {previewHandle}`. The read-only URL is used natively only; the renderer just gets `{status:'shown'}`. |
| `native.previewHide {}` | Handled locally. Hides the preview and loads `about:blank`. |
| `project.grant`, `preview.read`, `studio.open`, `native.projectChosen`, `native.resolvePreview`, `native.pairingDecision`, `native.authResponse`, any other `native.*` or unknown method | Dropped (never forwarded). |

Host → shell messages:

- Responses go back to the renderer through the public projection, a C# port of
  `projectPublicResult` with the same key vocabulary and `sanitizeText` patterns.
  Errors are reduced to `{code, action?, retryAfterMs?}`.
- `native.subscription {subscriptionId, event}` passes only if it matches the event
  envelope, the per-type key shape from `EVENTS`, `inspect`, and ≤ 32 KiB. The status
  form `{subscriptionId, status}` is rebuilt from `{kind:'status', state ∈ connected|disconnected|cursor_expired|closed, minimumSequence?}`.
- `native.pairing` / `native.auth` open native dialogs.
  `native.pairingClosed` / `native.authClosed` close them.
- Anything that is not a v1 JSON object ends the host (`HOST_PROTOCOL_MISMATCH`).

Everything reaches the editor by `PostWebMessageAsJson` with JSON the shell
serialized itself. `bridge.js`'s `chrome.webview` message listener is the same
function as `window.ZukuStudioReceive`. No script is evaluated with host input.

`tools/protocol-manifest.mjs` generates `src/ZukuStudio.Core/protocol-manifest.json`
(embedded resource) from `schema.mjs` and `bridge.js`. The Node test fails when they
drift; regenerate with
`node studio/native/windows/tools/protocol-manifest.mjs --write`.

## WebView2 isolation

Two `CoreWebView2Environment`s with separate user-data folders
(`%LOCALAPPDATA%\ZUKU\Studio\WebView2\{editor,preview}`) mean separate browser
process groups. Both run InPrivate (ephemeral). No extra browser arguments are
passed, so the Chromium sandbox and site isolation stay at their defaults. Single
sign-on with the OS account, extensions, DevTools, context menus, autofill, password
saving, zoom, swipe and browser accelerator keys are off. New windows, permissions,
downloads, external URI schemes, basic auth and client certificates are refused.
External drop is disabled.

**Editor (trusted):**

- Virtual origin `https://zuku-studio.example`. A `WebResourceRequested` filter `*`
  covers every context and source kind (documents, frames, workers). It answers only
  exact `GET`s for the 11 allowlisted paths (10 renderer files plus
  `lib/agent-protocol/schema.mjs`) from memory, with `Content-Security-Policy` (the
  `index.html` policy plus `frame-ancestors 'none'`), `nosniff`, `no-store`,
  `no-referrer` and COOP/CORP. Everything else gets a local 404. There is no
  `SetVirtualHostNameToFolderMapping` and nothing reaches the network.
- Navigation is allowed only to the exact page URI. Frame navigation is refused.
- `bridge.js` is added with `AddScriptToExecuteOnDocumentCreatedAsync` (document
  start), wrapped in `if (window === window.top && location.href === <page>)`, since
  WebView2 would otherwise also inject it into child frames.
- `WebMessageReceived` is the only message endpoint. It is accepted only when both
  `e.Source` and `CoreWebView2.Source` equal the page URI. Host objects are disabled.

**Preview (unprivileged game):**

- No bridge, no host objects, `IsWebMessageEnabled=false`, no message handler.
- Shows only a URL the host returned that matches
  `^http://127\.0\.0\.1:<port>/p/<32 lowercase hex>/$` (no userinfo, query or
  fragment), and only for the latest show/hide generation.
- Navigations, frame navigations and every resource request must be same-origin and
  under the `/p/<nonce>/` path prefix. Encoded separators are refused. Anything else
  gets a local 403 or is cancelled.
- File pickers: a document-start script blocks `showOpenFilePicker`, related APIs
  and file-input activation. This is defense in depth, not a hard boundary; the hard
  boundary is the request filter. **WebSocket and WebRTC traffic is not visible to
  `WebResourceRequested`**, so the preview server should send `Content-Security-Policy: connect-src 'self'`
  (root-owned, see below).
- The preview sits in a WPF overlay at the renderer's rect. CSS px equal DIPs
  because the editor zoom is fixed at 1.0 and zoom control is disabled.

## Native dialogs

- A project folder is canonicalized with `GetFinalPathNameByHandle`. Studio refuses
  network paths (`PROJECT_PATH_NETWORK`) and selections that resolve elsewhere, such
  as junctions, symlinks or short names (`PROJECT_PATH_LINK`). `FolderPolicy` also
  refuses:
  - drive roots;
  - the user profile and its ancestors;
  - Windows, Program Files and ProgramData;
  - any `.ssh`, `.gnupg`, `.config`, `.aws`, `.azure`, `.kube`, `.docker`, `.codex`,
    `.claude`, `.git` or `AppData` component.

  The refusal code goes to the renderer and the status bar.
- **Pairing (`native.pairing {requestId, challengeId, origin, purpose, expiresAt}`)**
  - Keys must be exact, `origin` must equal `https://ai.zuzunza.com`, and `expiresAt`
    must be 0–125 s ahead.
  - The text is fixed; no host or web text is rendered.
  - "거절" (refuse) is both the default and the cancel button. A countdown refuses
    automatically at the deadline.
  - A second concurrent, invalid or expired request is refused immediately with
    `native.pairingDecision {requestId, allow:false}`.
- **Credentials (`native.auth {requestId, providerId, methodId, question, expiresAt[, experimental, official]}`)**
  - The question is plain text (≤ 1000 chars, no control characters or secret-like
    text) and the entry is a masked `PasswordBox` (≤ 4096 chars).
  - **`(exp!)`** is shown in orange `#FF8700` (ANSI 208, as in the CLI) only when
    the host sends `experimental: true`. It is never inferred from the provider or
    model name, so Codex compatibility login shows `(exp!)` only via metadata.
  - The answer is `native.authResponse {requestId, value}`, with an empty value for
    refusal or timeout. The serialized line is marked sensitive and zeroed after it
    is written or dropped, and the box is cleared. The .NET string from
    `PasswordBox.Password` cannot be zeroed.
- Dialogs are modeless WPF windows over a disabled editor, so the host pump keeps
  running and `native.*Closed` can dismiss them. None of these values ever reach the
  renderer.

## Single instance and `zuku://ai/connect`

- The session-local mutex is `Local\ZukuStudio-<sha256(user SID) prefix>`.
- The first instance listens on the named pipe `ZukuStudio-<same>`. The pipe uses a
  protected DACL (current user read/write, `NETWORK` denied, no inheritance), one
  instance at a time, and reads one ≤ 8 KiB message with a 2 s timeout.
- A second launch connects with `PipeOptions.CurrentUserOnly`, which checks that the
  server runs as the same user. It grants the server foreground rights
  (`AllowSetForegroundWindow`), sends one strict JSON message
  `{protocolVersion:1, type:'activate'|'connect'|'project'[, projectPath]}` and exits.
- Accepted arguments:
  - nothing (activate);
  - exactly `zuku://ai/connect` (activate + "waiting for the web connection"; the
    approval itself is the pairing dialog);
  - one absolute drive path from `zuku studio .`. This is only a hint for the next
    folder picker. It grants nothing, and the user still confirms in the OS dialog.
  - Any other `zuku:` URI, query, token or flag just activates the window.
- Protocol registration is **per-user HKCU only**:
  `scripts/protocol-registration.ps1 -Register|-Unregister -Executable <ZukuStudio.exe>`
  writes `HKCU\Software\Classes\zuku` with `"<exe>" "%1"`. It never writes HKLM and
  refuses to take over a handler that belongs to another program. **Pending root
  review: the installer must not call it until that is approved.**

## Build and tests

```powershell
# Windows, .NET SDK 10, Node 22+
pwsh studio/native/windows/build.ps1 -Runtime win-x64    # or win-arm64
```

`build.ps1` does the following:

1. Checks the manifest for drift.
2. Runs `ZukuStudio.Core.Tests`, including the stdio group against the **synthetic**
   fixture `tests/stdio-fixture.mjs`. The fixture is labeled; it is not the real
   Agent Core and is deliberately hostile (absolute paths, secret-like keys, an
   oversize line).
3. Publishes self-contained `build/<rid>/ZukuStudio.exe` with its .NET/WPF runtime.
   The project verifies the apphost, `coreclr.dll`, `hostfxr.dll`, `hostpolicy.dll`,
   `System.Private.CoreLib.dll` and `PresentationFramework.dll` in that folder.
4. On a matching host, runs `ZukuStudio.exe --self-test` and `--stdio-test`. These
   cover the real pipe-ACL round trip, Job Object termination and folder policy on
   real system paths.

It installs, registers and signs nothing.

On any OS:

```sh
node --test studio/native/windows/tests/windows-shell.test.mjs
dotnet run -c Release --project studio/native/windows/tests/ZukuStudio.Core.Tests -- --node "$(command -v node)" --fixture studio/native/windows/tests/stdio-fixture.mjs
```

`ZukuStudio.exe --version` prints the compiled CLI version.

## Remaining release verification

`package.json` includes the shared `studio/` payload, and the Windows asset maps
the complete publish directory to `<release>\studio\windows\`. Keep every
runtime DLL beside the executable; copying only `ZukuStudio.exe` is insufficient.

The checked-in `windows-2025` (x64) and `windows-11-arm` (ARM64) jobs use .NET SDK
10, explicitly select the matching Node architecture and use the same native build
matrix. This local Linux verification did not run those jobs, compile Windows output,
or exercise a Windows GUI. Before shipping, verify a real published asset on a
Windows PC without .NET preinstalled, with WebView2 present, then verify the
missing-WebView2 diagnostic separately. Runtime bundling does not prove either
scenario has been exercised.

Authenticode signing, release publication and HKCU protocol-registration approval
remain separate release steps. WebView2 bootstrap installation must use Microsoft's
official distribution and preserve its per-user installation behavior.
