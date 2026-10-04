# ZUKU Studio for macOS (native shell)

`studio/native/macos/` is the macOS desktop host for ZUKU Studio. It is a small Swift
AppKit app with two `WKWebView`s. It does not bundle Electron or a second Node runtime,
and it has no agent of its own. Every agent, provider, auth, session and project
operation goes to the same Agent Core that `zuku`/`zukujs` use. The shell starts Core as
a child process running the shared typed stdio host:

```text
<managed node> <@zukujs/cli>/lib/studio-host.mjs --stdio
```

`Foundation.Process` starts it with a fixed executable and a fixed argv. No shell is
involved and no command string is built. `NODE_*`, `DYLD_*` and `npm_*` variables are
removed from the child environment.

> **Verification status.** The Swift sources, `build.sh`, the self-tests and the
> `.app` layout were written for Xcode on macOS, but **they have not been compiled or
> run yet**. The development host was Linux with no Swift toolchain. On Linux, only
> the JavaScript admission codec and the source-level consistency checks were run (see
> [Checks](#checks)). Do not treat any macOS GUI, build, signing or LaunchServices
> behaviour as verified until `build.sh` has run on a Mac.

## Layout

| Path | Role |
| --- | --- |
| `Sources/StudioApp.swift` | `@main` entry, `--version`/`--self-test`/`--stdio-test`, app delegate, single-instance check, `zuku://ai/connect` handling, menus |
| `Sources/StudioController.swift` | Trusted editor window: routes bridge requests between the renderer and the host, native picker, preview placement, pending/expiry, renderer delivery queue |
| `Sources/HostProcess.swift` | Child process, non-blocking stdio `DispatchSource`s, bounded framing, backpressure, stop/kill |
| `Sources/LineFramer.swift` | NDJSON framing (maximum line size) and the bounded outgoing queue (sensitive entries are zeroed) |
| `Sources/ProtocolCodec.swift` | Private JavaScriptCore context with the shared `schema.mjs` and `native-codec.js`, plus the JSON envelope builder |
| `Sources/SchemeHandler.swift` | `WKURLSchemeHandler` for `zuku-studio://app/…`, serving a finite allowlist of managed assets with a strict CSP |
| `Sources/PreviewController.swift` | Separate, unprivileged game preview `WKWebView` |
| `Sources/NativeDialogs.swift` | `NSAlert` sheets for pairing approval and secure provider input |
| `Sources/Installation.swift` | Finds the one shared CLI payload next to the app and checks file trust |
| `Sources/SelfTest.swift` | Headless native self-tests |
| `Resources/native-codec.js` | Admission logic run only in the private JSC context. Node also runs it in `tests/codec-check.mjs` |
| `Resources/Info.plist.in` | Bundle metadata, `zuku` URL type, `LSMultipleInstancesProhibited`, loopback-only ATS exception |
| `tests/stdio-fixture.mjs` | **Synthetic** stdio peer for `--stdio-test`. It is not Agent Core |
| `tests/codec-check.mjs`, `tests/static-check.mjs` | Checks that run on Linux |
| `build.sh` | Builds the `.app` for one architecture, signs it ad hoc for development, runs self-tests, can stage a runtime and register with LaunchServices |

## Installed layout and launch discovery

```text
<install dir>/                      e.g. ~/Applications/ZUKU (user bundle)
  ZUKU Studio.app/
    Contents/Info.plist             ZukuCLIVersion = CLI version this Studio was built with
    Contents/MacOS/ZukuStudio
    Contents/Resources/zuku/        signed, managed renderer + schema + bridge + codec
  zuku-runtime/                     sibling payload: the ONE shared CLI install
    install.json                    {"schema":"zukujs-user-install/1","version","sha256","node"}
    runtime/bin/node                managed Node (install.json "node" must be exactly this path)
    npm/lib/node_modules/@zukujs/cli/
```

Studio looks only at `<bundle parent>/zuku-runtime`. It never searches `PATH`, the home
directory or `/root`, and it never uses a path the renderer supplies. It starts Core
only when all of these hold:

* `install.json` has the installer schema, a SHA-256 value, `version == ZukuCLIVersion`,
  and `node` equal to the managed `runtime/bin/node`. A system Node is rejected.
* `package.json` has `name == "@zukujs/cli"`, the same version, and
  `bin.zuku == bin.zukujs == "./index.mjs"`.
* `lib/studio-host.mjs` exists, and the package's `lib/agent-protocol/schema.mjs` is
  byte-identical to the schema bundled in the app. This catches version skew between the
  renderer, the codec and the host.
* Every checked file is canonical (no symlinks) and regular, has a single link, is owned
  by the user or root, and is not group- or world-writable. The same applies to every
  parent directory. The only group-writable parent allowed is `/Applications`
  (root:admin).

Any failure is shown in the status line with a code: `STUDIO_RUNTIME_MISSING`,
`STUDIO_RUNTIME_UNTRUSTED`, `STUDIO_RUNTIME_VERSION_MISMATCH`,
`STUDIO_PROTOCOL_SCHEMA_MISMATCH` or `STUDIO_BUNDLE_UNAVAILABLE`. The renderer stays in
its offline state, and nothing falls back to another runtime.

**Integration notes for the installer and root owners:**

* On macOS, the user installer must place the release at `<dir>/zuku-runtime` next to
  `ZUKU Studio.app`, and its `zuku`/`zukujs` launchers must point into that same
  directory so there is only one install.
* `zuku studio` can launch with `/usr/bin/open -b com.zuku.Studio`. LaunchServices then
  focuses the running instance.
* The current `package.json` `files` list ships `lib/`. That covers
  `lib/studio-host.mjs` and the schema. The renderer is taken from the app bundle, not
  from the npm package.

## Renderer, bridge and IPC

* The page is `zuku-studio://app/studio/renderer/index.html`. The scheme handler serves
  only the 10 renderer modules/assets and `lib/agent-protocol/schema.mjs`, loaded into
  memory at launch from the signed bundle. It rejects any other host, path, query,
  fragment, credentials or non-GET request. Responses carry a strict CSP header
  (`default-src 'none'; script-src 'self'; … frame-ancestors 'none'`), `nosniff` and
  `no-store`. The page also keeps its own meta CSP.
* `studio/native/bridge.js` is injected as a `WKUserScript` at **document start, top
  frame only**, and exposes `window.zukuStudio`. The `zuku` message handler accepts a
  message only when all of these hold: it comes from the main view's main frame, its
  security origin is `zuku-studio://app`, the view's URL is the managed page, and the
  body is a string of at most 64 KiB.
* The main view uses a non-persistent data store. It denies all navigation except the
  managed page, refuses popups, file inputs and media capture, and is not inspectable.
* Requests are admitted by `native-codec.js` running with the **shared** `schema.mjs`
  in a private JSC context. There is no separate native schema.
  * Core methods: the renderer can call exactly the `bridge.js` allowlist, and each
    request is checked with `validateRequest(…, {native:true})`, which also rejects
    secret-named fields and secret-looking text.
  * Methods the renderer can never call: `project.grant`, `native.projectChosen`,
    `native.resolvePreview`, `native.pairingDecision`, `native.authResponse`,
    `preview.read` and `studio.open`. They return `NATIVE_PERMISSION_REQUIRED`.
  * `native.pickProject {}` opens an `NSOpenPanel` (directories only, one selection).
    The canonical path is checked locally: the home directory, its ancestors,
    `~/Library`, system roots and `.ssh`/`.git`/`.aws`/… folders are refused. The path
    is sent only on stdio as
    `native.projectChosen {requestId:<original UI id>, localPath}`. The host answers the
    original UI id, and the renderer receives only the projected result, such as
    `{projectHandle, name}`. Cancel returns `COMMAND_CANCELLED`.
  * `native.subscribe {subscriptionId, sessionId, afterSequence}` and
    `native.unsubscribe {subscriptionId}` are re-serialized and forwarded. Unsubscribe
    only detaches; it never cancels work.
  * `native.previewShow {previewHandle, rect}` becomes a private
    `native.resolvePreview {previewHandle}` request. `native.previewHide {}` is handled
    natively.
* Host → renderer:
  * Responses are projected with `projectPublicResult`. Error codes must match
    `^[A-Z][A-Z0-9_]{0,63}$`; otherwise they become `CORE_OPERATION_FAILED`.
  * `native.subscription` data is forwarded only if it is either a `validateEvent`-valid
    event or a whitelisted `{kind:'status', state, code?, minimumSequence?}`.
  * Every message is passed to `window.ZukuStudioReceive` as a **string argument**
    through `callAsyncJavaScript`. Host text is never interpolated into script source.
* Limits:

  | Direction | Limit |
  | --- | --- |
  | Host → native line | 262,144 bytes. A larger line is treated as a protocol violation and the host is stopped |
  | Native → host line | 65,536 bytes |
  | Native → host queue | 64 entries / 256 KiB |
  | Public message to the renderer | 65,536 bytes. A larger result becomes `BODY_TOO_LARGE` |
  | Renderer delivery queue | 64 entries / 256 KiB |
  | Pending requests | 128 entries, 180 s expiry (`HOST_TIMEOUT`) |

  Reading from the host pauses while the renderer delivery queue is near its limit
  (backpressure), so memory use stays bounded.

## Native-only exchanges

* **Pairing** (`native.pairing {requestId, challengeId, origin, purpose, expiresAt}`):
  * The origin must be exactly `https://ai.zuzunza.com`.
  * An `NSAlert` sheet shows fixed Korean text, plus the validated `purpose`.
  * **Return refuses**; the allow button has no key equivalent.
  * The sheet closes at the Core deadline (at most 120 s) as a refusal.
  * Only one prompt is shown at a time. A malformed or expired prompt is refused
    immediately. So is a prompt that arrives while another sheet (such as the folder
    picker) is open, so a queued sheet cannot outlive its deadline.
  * The reply is `native.pairingDecision {requestId, allow}`.
* **Provider auth** (`native.auth {requestId, providerId, methodId, question, expiresAt}`
  with optional `official`/`experimental` booleans):
  * The question is plain text of at most 1000 characters. Control and bidi-override
    characters are rejected.
  * Input goes into an `NSSecureTextField`.
  * An orange **(exp!)** badge is shown only when Core metadata has
    `experimental: true`. It is never guessed from a provider or model name, such as
    Codex.
  * The reply `native.authResponse {requestId, value}` is assembled directly into a byte
    buffer, which is zeroed after it is queued and again after it is written. Cancel or
    timeout sends `value: ""`.
* `native.pairingClosed` / `native.authClosed` dismiss the sheet without sending another
  decision.

The renderer never sees decisions, credentials, chosen paths or preview URLs.

## Game preview

* `native.resolvePreview` must return `{url}` exactly in the form
  `http://127.0.0.1:<port>/p/<32 lowercase hex>/`, with no credentials, query or
  fragment. The JS codec and Swift `URLComponents` both check it.
* The preview is a **separate** `WKWebView` with:
  * a non-persistent data store,
  * an empty `WKUserContentController` (no bridge, no message handlers, no user scripts),
  * no custom scheme.
* A compiled `WKContentRuleList` blocks every load and then re-allows only
  `^http://127\.0\.0\.1:<port>/p/<nonce>/` (case-sensitive). This covers
  subresources, fetches and WebSockets.
* The navigation policy enforces the same origin **and** nonce path prefix for frames,
  allowing only `about:blank`/`about:srcdoc` besides that.
* Popups, file inputs, downloads, media capture, auth challenges and JS
  alert/confirm/prompt are refused.
* The view is positioned at the renderer's rect in a flipped container. CSS pixels
  equal points at zoom 1. When only the rect changes, the view is moved and the page is
  not reloaded.

## Single instance and `zuku://`

* `LSMultipleInstancesProhibited` makes LaunchServices reuse the running instance. If
  another copy is executed directly, it activates the running instance and exits before
  starting a host. Reopen focuses the window.
* `CFBundleURLTypes` registers `zuku`. LaunchServices registers the URL type when the
  bundle is installed or opened (`build.sh --register` runs `lsregister -f` for
  development builds).
* Only the exact token-free `zuku://ai/connect` is accepted. It focuses Studio and
  shows that a browser connection is expected. Every other URL, including any with a
  query, only focuses the window. No credential, path or command is ever read from a
  URL. No contract currently requires an opaque challenge id, so none is accepted.

## Build, signing and distribution

```bash
bash studio/native/macos/build.sh --arch arm64       # Apple silicon
bash studio/native/macos/build.sh --arch x86_64      # Intel (separate, explicit build)
bash studio/native/macos/build.sh --arch arm64 --stage-runtime --node /abs/path/node-v22/bin/node
```

* Requirements: macOS with Xcode (Swift 6 toolchain, macOS 13+ SDK). On any other
  OS, the script exits with code 69 and builds nothing.
* Compilation uses `swiftc -swift-version 6` (complete strict concurrency checking),
  with deployment target macOS 13.0 and one architecture per build.
* The script checks the binary with `lipo` and lints `Info.plist`.
* Signing is **ad hoc** (`codesign --sign - --options runtime`). It is for **local
  development only**: the app is not notarized, and Gatekeeper on other Macs will not
  trust it.
* Official distribution is a separate release step this repository does not perform
  without credentials:
  1. Sign with a Developer ID Application identity, using the hardened runtime and a
     secure timestamp.
  2. Notarize with `xcrun notarytool submit --wait`.
  3. Run `xcrun stapler staple`.
* `--stage-runtime` writes a development `zuku-runtime/` next to the app:
  1. Copies the given Node binary (it must match the build architecture).
  2. Packs the repository (`npm pack`) and installs the tarball with
     `npm install --global --ignore-scripts --prefix …`, as the user installer does.
  3. Writes `install.json`.
  4. Runs `--stdio-test`.
* The app is not sandboxed, because it must run the managed Node child outside the
  bundle. The trust checks above and the typed-only host protocol are the boundary.

## Checks

| Command | Where | What it proves |
| --- | --- | --- |
| `node studio/native/macos/tests/codec-check.mjs` | any OS | Runs the real admission codec plus the shared schema in an isolated `vm` context: allowlist, private-method refusal, secret rejection, projection, preview URL, subscription/status and prompt shapes |
| `node studio/native/macos/tests/static-check.mjs` | any OS | Source-text consistency checks: Info.plist keys, asset list = `studio/renderer` = `build.sh`, codec allowlist = `bridge.js`, no shell/Electron/security downgrade, fixed host argv, document-start top-frame bridge, ephemeral preview, ad-hoc-only build |
| `ZukuStudio --self-test` | macOS (built app) | Native protocol admission through JavaScriptCore, framing and overflow, queue limits and partial writes, JSON escaping, scheme allowlist, preview URL/rule list, connect URI, project-path policy, prompt deadlines |
| `ZukuStudio --stdio-test` | macOS + staged runtime | A real `HostProcess` round trip with the managed Node against the **synthetic** fixture. Covers backpressure pause/resume, sensitive write delivered but never echoed, and the host being stopped on an oversized line. It does not start Agent Core or a GUI |

The GUI flows have no automated tests in this directory: window, picker, sheets,
preview placement, single-instance activation and `zuku://` delivery. They must be
checked by hand on a Mac.
