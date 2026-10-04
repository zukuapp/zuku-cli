# Linux Studio native shell

This GTK3/WebKitGTK 4.1 shell loads the shared `studio/renderer` UI. It starts the installation's managed Node process with `lib/studio-host.mjs --stdio`; that facade connects to the single shared AgentCore. The shell does not implement an agent or use a second configuration store.

Build from this directory:

```sh
make
make check
```

The build needs a C11 compiler, `pkg-config`, GTK3, WebKitGTK 4.1, JavaScriptCoreGTK 4.1 and GIO development files. `NODE_EXECUTABLE=/absolute/path/to/node` selects a managed Node executable at build time. The default is `/usr/bin/node`. `--managed-node /absolute/path/to/node` is a development-source override; installed full Studio always uses its single managed runtime and rejects that override. Executables and installation files must pass ownership and permission checks. Node must satisfy the CLI's Node 22 or newer requirement.

`build/zuku-studio` finds the `@zukujs/cli` package marker above its development-source location. The installed binary lives at `release/studio/linux/zuku-studio` and validates `release/install.json`, `release/runtime/bin/node` and `release/npm/lib/node_modules/@zukujs/cli`. An invalid installation marker fails closed instead of falling back to an external Node runtime. The trusted renderer is served from a finite custom-scheme asset list; the bridge is injected at document start only into its top-level page. There are no compiled source-workspace paths.

The validated Linux x64 binary requires glibc 2.34 or newer and the GTK3/WebKitGTK 4.1 system libraries; the managed Node requirement alone does not cover these native dependencies.

The desktop entry is a packaging template. The installer must replace `@STUDIO_EXECUTABLE@` with the safely quoted installed executable before registering the token-free `zuku://ai/connect` handler. This source build does not register a desktop entry automatically.

`--self-test` checks native protocol admission and public projection without creating a GUI. `--stdio-test` performs three synthetic C/Node pipe round trips, without starting AgentCore. `--validate-request` accepts a bounded JSON request on stdin and emits only `ACCEPT` or `REJECT`; it creates no host or GUI. These diagnostic checks do not replace an ordinary-user GUI run.

The adapted shell starts from a SHA-verified frozen native implementation. It retains no original limited renderer, compiled workspace paths or old independent protocol contract. See [the Linux Studio documentation](../../../docs/studio-linux.md) for the native boundaries and verification limits.
