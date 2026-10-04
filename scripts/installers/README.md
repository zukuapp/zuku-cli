# Official ZukuJS user installers

`zuku` and `zukujs` launch the same installed `index.mjs`, managed runtime,
configuration and accounts. The installers preserve the existing CLI-only contract
and accept an optional complete Studio release contract. A Studio contract enables
installation of the native shell and browser adapter already contained in the same
CLI package; it never installs a second agent or a second Node runtime.

The public script locations are `https://zuzunza.com/install.sh` and
`https://zuzunza.com/install.ps1`. Their production HTTPS deployment is pending.
Do not describe them as deployed based on fixture tests or generated files.

## Produce a release contract

Freeze the shared source and build the native shell on its actual operating system
and architecture. Use the package version and the pinned Node.js 22.22.3 runtime.
For example, the platform helper accepts:

```sh
node scripts/platform-build/cli.mjs build --platform linux-x64
node scripts/platform-build/cli.mjs self-test --platform linux-x64
node scripts/platform-build/cli.mjs package --platform linux-x64 --out /absolute/release-directory --require-clean
node scripts/platform-build/cli.mjs verify --record /absolute/release-directory/zuku-studio-0.3.0-linux-x64.asset.json --cli-root /absolute/installed-cli
```

`--require-clean` requires Node.js 22.22.3 and tracked, clean source. Native assets
must carry protocol version 1, a confirmed platform placement, the source commit,
shared-source hashes, their manifest hash, exact byte size and archive SHA-256.
Regenerate old candidates lacking this metadata. Windows and macOS must be built
and tested on their own platforms; another platform's fixtures are not execution
evidence.

Create JSON with schema `zukujs-installer/1`, using:

| Field | Required source |
| --- | --- |
| `cli.name` | `@zuku/cli` |
| `cli.version` | Actual package version |
| `cli.url` | Fixed, versioned `.tgz` URL on `zuzunza.com` or `www.zuzunza.com` |
| `cli.sha256` | SHA-256 of the final packed CLI archive |
| `node.version` | `22.22.3` for a Studio release |
| `node.artifacts[platform].url` | Exact official `https://nodejs.org/dist/v22.22.3/node-v22.22.3-<platform>.<format>` |
| `node.artifacts[platform].sha256` | Verified official checksum for that archive |

For a complete release add `studio` with schema `zukujs-studio-installer/1`,
`repository: "zukuapp/zukujs-cli"`, `tag: "v0.3.0"`, `protocolVersion: 1`, and
`assets`. The tag must always equal `v` plus the actual CLI version. Each entry
`assets[platform]` contains the unmodified actual `*.asset.json` as `record` and
`url: https://github.com/zukuapp/zukujs-cli/releases/download/<tag>/<record.file>`.
Only add platforms for which the complete native asset and official Node checksum
exist. Missing records, unknown versions, modified source and external release
hosts are rejected. Never synthesize checksums or advertise missing release URLs.

The supported finite platform keys are `linux-x64`, `linux-arm64`, `darwin-x64`,
`darwin-arm64`, `win-x64`, and `win-arm64`. GitHub downloads start at the fixed
release URL and permit at most three HTTPS redirects to its official signed
release CDN hosts. Archive size and checksum are still checked before extraction.

Generate both scripts from that same contract:

```sh
node scripts/installers/render-installers.mjs /absolute/contract.json /absolute/generated-directory
```

The generated scripts embed the exact contract and the native verification helper.
The helper loads the source-bound platform verifier from the installed CLI package.
Install the frozen archive without lifecycle scripts or network dependency fetches;
verify both aliases, then commit the complete staged release and aliases together.
Failure restores the previous release and both launchers. The macOS installer
also accepts the existing CLI-only marker when switching to the adjacent app and
`zuku-runtime` layout without changing a release's version or archive checksum.

## Installation layout

Linux and Windows native assets live at `release/studio/linux/zuku-studio` and
`release/studio/windows/ZukuStudio.exe`, respectively. The same release holds
`install.json`, `runtime`, and the one npm package. macOS places `ZUKU Studio.app`
beside `zuku-runtime`, which holds those three items. The installation marker's
`studio` member records `protocolVersion`, `platform`, `relativeTo`, `executable`,
`sha256`, `manifestSHA256`, and `gitCommit`; paths come only from the finite native
manifest layout. Both command aliases select this installed package.

Full Studio always uses the managed Node runtime. `--no-node` / `-NoNode` remain
compatible for CLI-only contracts and explicitly fail with a Studio contract.
System packages, user profiles and system Node installations are left under the
user's own management.

## Verification

```sh
node --test scripts/installers/tests/native-installers.test.mjs scripts/platform-build/tests/platform-build.test.mjs
node tests/installer-smoke.mjs --skip-bootstrap
```

The first command covers finite release metadata, native download redirects and
byte verification, archive source/protocol/layout validation, symlink rejection,
and complete Bash rollback after a second-alias failure. Its native binary and
Node bootstrap are fixtures. The second builds and installs the actual CLI
archive, preserving the existing CLI-only checks. Neither proves official HTTPS
deployment, actual native GUI operation, or live provider authentication.
PowerShell execution requires Windows CI with an actual PowerShell parser;
balanced strings and delimiters alone must not be recorded as a parsed installer.
