# ZUKU Studio native distribution

ZUKU Studio ships as **one npm payload plus one small native asset per platform**.
It is not a second product and does not carry a second CLI, agent or Node runtime.

| Piece | What it is | Who delivers it |
| --- | --- | --- |
| `@zuku/cli` tarball | `zuku`/`zukujs` aliases (one `index.mjs`), Agent Core, provider/auth/session store, Browser Adapter, `lib/studio-host.mjs`, renderer (`studio/renderer/`), `studio/native/bridge.js`, the shared protocol schema and the five mandatory skills | npm source package; native installer release requires separate matching SHA-pinned assets |
| Managed Node `22.22.3` | the one runtime every frontend uses | existing official installer (official nodejs.org archive + SHA) |
| `zuku-studio-<version>-<platform>.<tar.gz\|zip>` | only the compiled native shell and its `source-manifest.json` | built here; fetching/installing is root installer integration (below) |

The native shell starts exactly `<managed node> <cli root>/lib/studio-host.mjs --stdio`
from the installed release. It loads only the trusted renderer files of that payload.
It never runs a shell or a string command, and it never takes paths from a renderer,
a game or a `zuku://` URI.

## Build matrix

`scripts/platform-build/matrix.mjs` is a finite matrix. A host may build only its own
OS and architecture; there is no cross-building.

| Platform | Native source (owner) | Build step (executable + argv, no shell) | Placement of shipped files |
| --- | --- | --- | --- |
| `linux-x64`, `linux-arm64` | `studio/native/linux` (Makefile, C, GTK 3 + WebKitGTK 4.1) | `make -C studio/native/linux NODE_EXECUTABLE=<abs> all`, then `… check` | `build/zuku-studio` → `<release>/studio/linux/zuku-studio`, `zuku-studio.desktop.in` → `<release>/studio/linux/`; the source locator checks the release marker and managed Node |
| `darwin-x64`, `darwin-arm64` | `studio/native/macos` (Swift) | `bash studio/native/macos/build.sh --arch x86_64\|arm64 --stage-runtime --node <managed abs>` | `build/<swift arch>/ZUKU Studio.app` → `<release parent>/ZUKU Studio.app`; executable `Contents/MacOS/ZukuStudio`; the sibling release directory must be named `zuku-runtime` (`Installation.swift`) |
| `win-x64`, `win-arm64` | `studio/native/windows` (.NET 10 WPF) | `dotnet publish <the WinExe csproj> -c Release -r win-<arch> --self-contained true -p:ZukuCliVersion=<package.json version> -o studio/native/windows/build/win-<arch>` | Entire `build/win-<arch>/` including .NET/WPF → `<release>/studio/windows/`; WebView2 Evergreen remains separate |

Archive paths are **install-relative**, so the installer copies archive entries without
any mapping. Each manifest records the placement's `relativeTo`, any required
`releaseDirectoryName`, and `ownerConfirmed`, which says whether the shell's own
locator already reads that layout.

The default output names match the actual `build.sh`, `Info.plist.in` and Windows
WinExe source. On macOS, build staging copies the already selected managed Node and
installs the real packed CLI in a sibling `zuku-runtime`, so the native stdio test
can pass the same locator checks as an installed app. That staging folder is
excluded from the native asset and from npm packing: it is a test copy, not a second
product runtime. `package` still fails with `ARTIFACT_MISSING` if outputs differ.
`--artifact` (repeatable) and `--executable` can override the defaults, but only
within the platform's placement map. Every shell must implement `--self-test`
(protocol checks) and `--stdio-test` (labelled synthetic stdio fixture), as the Linux
shell does. Windows receives `--stdio-test --node <managed abs> --fixture <fixed
checkout fixture abs>`, matching the actual test branch in `Program.Main`; plain
`--stdio-test` would instead enter its GUI launch path and is never used by the helper.

A missing compiler or SDK fails `build` with `TOOL_MISSING`, and missing sources fail
it with `SOURCE_MISSING`/`BUILD_UNAVAILABLE`. No placeholder binary is ever produced.

## Commands

```sh
node scripts/platform-build/cli.mjs plan      --platform linux-x64
node scripts/platform-build/cli.mjs build     --platform linux-x64 [--node-executable /abs/node]
node scripts/platform-build/cli.mjs self-test --platform linux-x64 [--executable REL]
node scripts/platform-build/cli.mjs package   --platform linux-x64 --out /abs/dir [--require-clean] [--artifact REL]... [--executable REL] [--source-date-epoch N]
node scripts/platform-build/cli.mjs verify    (--record /abs/x.asset.json | --out /abs/dir) [--cli-root /abs/installed/cli]
```

Options are parsed strictly; unknown options are errors. `package` writes three new
files and never overwrites:

- `zuku-studio-<v>-<platform>.<tar.gz|zip>`: the asset.
- `zuku-studio-<v>-<platform>.source-manifest.json`: an identical copy of the archived manifest.
- `zuku-studio-<v>-<platform>.asset.json`: the external record. It holds the archive `size`/`sha256`, `manifestSHA256`, `gitCommit` and `treeState`.

`--require-clean` is release-candidate mode. Any bound modification is an error, and
the packager itself must be Node `22.22.3`, so the archive comes from the same
bundled zlib.

`node scripts/platform-build/tests/native-snapshot-check.mjs` runs the real sequence
for the host platform: build, self-test, package, verify, then repackage and compare
hashes. It works inside a temporary git snapshot, so the platform owners' `build/`
directories are never written.

## `source-manifest.json` (`zuku-studio-native-asset/1`)

- `version`, `cli`: the real `package.json` version and SHA-256. Both aliases must point to `./index.mjs`.
- `source.gitCommit` / `commitTime`: the actual `HEAD`, read with `git`. Creation fails outside a checkout.
- `source.nativeSources[]` + `nativeSourcesSHA256`: sizes and SHA-256 of the **git-tracked** files under the platform `nativeDir`, excluding `build/`, `bin/` and `obj/` outputs at any depth.
- `source.treeState` / `modifiedPaths`: `modified` if a bound file differs from the commit. Bound files are the native sources, the shared payload and `package.json`. Untracked **or ignored** non-output files in those paths count too, because they could feed a build. On Windows a checkout with `core.autocrlf=true` is refused, since its hashes would not match the LF npm payload.
- `sharedPayload[]`: SHA-256 of the fixed 12-file allowlist the shell trusts: the renderer modules/assets, `bridge.js` and `lib/agent-protocol/schema.mjs`.
- `node`: `{version: "22.22.3", bundled: false, owner: "official-installer"}`.
- `launcher`: paths relative to the installed release directory.
  - `install.json`, schema `zukujs-user-install/1`.
  - `managedNode`: `runtime/bin/node` or `runtime\node.exe`, with `requiresManagedNode: true`. The macOS and Windows locators both reject an `install.json` whose `node` is not that managed runtime.
  - `<cliRoot>/package.json`, `<cliRoot>/index.mjs` and `<cliRoot>/lib/studio-host.mjs` with `hostArgs: ["--stdio"]`.
  - `<cliRoot>` is `npm/lib/node_modules/@zuku/cli` on Unix and `npm/node_modules/@zuku/cli` on Windows, the layout the existing installers create.
- `placement`, `executable`, `artifacts[]`: install-relative path, size, SHA-256 and executable bit of every shipped file.
- `publication`: always `{released: false, signed: false, notarized: false}`.

Manifests contain no build-machine absolute path, username, secret or token.

## Safety rules enforced by the helpers

- **Processes.** Every child runs as `spawnSync(executable, argv, {shell: false})`. Tools resolve from `PATH` to absolute files, and on Windows only `.exe` qualifies (no `.cmd`/`cmd.exe`). `NODE_OPTIONS` and `NODE_PATH` are removed. The Linux `NODE_EXECUTABLE` value may only contain `[A-Za-z0-9/._+-]`, because the Makefile puts it into a compiler define.
- **Paths.** Paths are repository-relative and checked against a strict segment pattern. The check rejects `..`, `.`, empty segments, backslashes, drive letters, control characters and a leading `-`.
- **Files.** Every path component is checked with `lstat`, so a symlink or junction anywhere is rejected. Only regular files and directories are accepted, and hard-linked files are rejected. Files open with `O_NOFOLLOW|O_NONBLOCK` where available, and the inode is rechecked. The bytes that get hashed are the bytes that get archived. Size and count limits are finite.
- **Reproducibility.** Archives are reproducible:
  - Entries are sorted, owner is 0/0 with no names, and modes are `0755`/`0644`.
  - Timestamps come from the commit time or `--source-date-epoch`.
  - The gzip header uses mtime 0 and OS 255.
  - Zip DOS date/time fields are rewritten from UTC after compression, so time zone and DST have no effect.
  - The same bytes, timestamp and Node 22.22.3 zlib always produce the same SHA-256.

  This covers packaging only. Separate compiler runs are not claimed to give identical binaries.
- **Verification.** `verify` rejects any of the following:
  - a size/SHA mismatch or a modified manifest
  - a shared-payload list that isn't exactly the allowlist
  - wrong Node/host references
  - unlisted or missing files
  - links or special entries in tar and zip, including Unix `S_IFLNK` zip attributes
  - path traversal, duplicate entries or mode mismatches

  With `--cli-root`, it also confirms the installed `@zuku/cli` version, the presence of `lib/studio-host.mjs`, and the shared-payload bytes.

## CI: `.github/workflows/studio-platform.yml`

The workflow declares all six native targets using the standard labels listed in
[GitHub's runner reference](https://docs.github.com/en/actions/reference/runners/github-hosted-runners#standard-github-hosted-runners-for-public-repositories):

| Target | Runner label | Node architecture |
| --- | --- | --- |
| `linux-x64` | `ubuntu-24.04` | `x64` |
| `linux-arm64` | `ubuntu-24.04-arm` | `arm64` |
| `darwin-x64` | `macos-15-intel` | `x64` |
| `darwin-arm64` | `macos-15` | `arm64` |
| `win-x64` | `windows-2025` | `x64` |
| `win-arm64` | `windows-11-arm` | `arm64` |

The runner labels were verified on 2026-10-04; their existence does not establish a
successful workflow run. Windows ARM's image lists .NET 10 SDK/Windows Desktop,
but a real job still has to compile and execute the native tests. It has
`permissions: contents: read`, no repository secrets and a
checkout with no persisted credentials. It does not deploy, release, publish or
do network OAuth. The macOS source applies an ad-hoc development signature; the
asset is not Developer ID signed or notarized. Per platform it:

1. disables `core.autocrlf` before checkout, then installs Node `22.22.3` with an explicit matrix architecture; it checks both the exact version and native OS/architecture before building; installs dependencies with `npm ci --ignore-scripts`
2. runs the helper tests (synthetic fixtures) and the alias, protocol, Agent Core, Browser Adapter and Studio test files
3. on Windows, runs the real DPAPI/ACL tests and fails if the DPAPI round-trip, or any Windows test other than the explicit non-Windows fallback, was skipped
4. installs GTK/WebKit dev packages (Linux) or the .NET 10 SDK (Windows), compiles the shell from source, then runs `--self-test`/`--stdio-test` (Linux under `xvfb-run`)
5. packages with `--require-clean` and verifies against the checkout **and against the real `npm pack` output**, then repackages and requires an identical hash
6. uploads the unsigned asset as a 7-day workflow artifact

All six are configured; this source update has not run the new workflow. In
particular no actual macOS/Windows build or GUI pass is claimed here. Actions remain
pinned by major tag rather than commit SHA.

## Verified here vs. not

On this Linux host, `node --test scripts/platform-build/tests/platform-build.test.mjs`
checks executable/argv plans and reproducible source/payload/archive binding for
all six targets using synthetic binaries and real git repositories. These checks
never compile Swift or .NET. Independent actual Linux GTK/WebKit GUI, shared Core,
locator and preview evidence is documented in [verification.md](verification.md);
its ordinary-user run kept the browser sandbox enabled. Nothing about Windows or
macOS has been compiled or run on this Linux host. Workflow source configuration
and native self-tests do not themselves prove a GUI run on those systems.

## Integration boundaries (open, owned elsewhere)

1. **Installer publication (root, `scripts/installers/**`).** Real published native assets and their per-platform `{url, sha256, size}` must be verified before offering them. The installer has to:
   - check the SHA and apply the `verify` rules before extracting (regular files under `zuku-studio/` only)
   - copy the entries to the manifest's `placement` (macOS: the release directory must be `zuku-runtime`, beside `ZUKU Studio.app`)
   - install the one managed runtime whenever Studio is installed; native locators reject a system Node marker.
2. **npm payload.** `files` includes `studio/`, and the shared host exists. `.npmignore` excludes native `build/bin/obj` outputs, including macOS test staging; CI verifies the actual packed shared payload against the asset's hashes.
3. **Native release verification.** macOS needs distribution signing/notarization and an actual native GUI check. Windows needs actual published output and GUI verification, including no preinstalled .NET and the separate WebView2 availability cases. Source-defined self-contained publishing does not count as those passes.
4. **Line endings.** Local Windows checkout bytes must preserve LF. The packager rejects `core.autocrlf=true`, and CI sets it false before checkout.
5. **`zuku://ai/connect` registration, single instance, update and uninstall** are per-OS installer and shell work, not done by these helpers.
6. **Distribution signing, notarization and live GUI tests** are neither performed nor claimed by these helpers.
