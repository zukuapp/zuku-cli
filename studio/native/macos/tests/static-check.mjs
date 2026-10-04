// Source-level consistency checks for the macOS shell that run on any OS with Node 22+.
// They read the Swift sources, Info.plist template and build script as text. They do NOT
// compile Swift or prove macOS behaviour; build.sh on a Mac with Xcode does that.
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const root = new URL('../../../../', import.meta.url);
const macos = new URL('studio/native/macos/', root);
const read = path => readFileSync(new URL(path, macos), 'utf8');
const sources = readdirSync(new URL('Sources/', macos)).filter(name => name.endsWith('.swift'));
const swift = Object.fromEntries(sources.map(name => [name, read(`Sources/${name}`)]));
const all = Object.values(swift).join('\n');
const plist = read('Resources/Info.plist.in'), build = read('build.sh'), codec = read('Resources/native-codec.js');
const bridge = readFileSync(new URL('studio/native/bridge.js', root), 'utf8');
let checks = 0;
const check = (ok, label) => { assert.ok(ok, label); checks++; };

// Bundle identity, URL scheme, single instance, loopback-only ATS exception.
for (const needle of ['<key>CFBundleIdentifier</key>\n\t<string>com.zuku.Studio</string>', '<key>LSMultipleInstancesProhibited</key>\n\t<true/>', '<string>zuku</string>', '<key>NSAllowsLocalNetworking</key>\n\t\t<true/>', '<key>CFBundleExecutable</key>\n\t<string>ZukuStudio</string>', '<key>ZukuCLIVersion</key>'])
  check(plist.includes(needle), `Info.plist has ${needle.split('\n')[0]}`);
check(!/NSAllowsArbitraryLoads|NSExceptionDomains/.test(plist), 'no broad ATS exception');

// Finite renderer asset set is identical in Swift, build.sh and the repository.
const rendererFiles = readdirSync(new URL('studio/renderer/', root)).sort();
const swiftAssets = /for name in \[([^\]]+)\]/.exec(swift['Installation.swift'])[1].match(/"([^"]+)"/g).map(value => value.slice(1, -1)).sort();
const buildAssets = /for name in ([^;]+); do\n  install -m 0644 "\$repo\/studio\/renderer/.exec(build)[1].trim().split(/\s+/).sort();
check(JSON.stringify(swiftAssets) === JSON.stringify(rendererFiles), `Swift asset list matches studio/renderer (${rendererFiles.join(',')})`);
check(JSON.stringify(buildAssets) === JSON.stringify(rendererFiles), 'build.sh asset list matches studio/renderer');
check(swiftAssets.length === 10, 'ten renderer assets');

// Renderer method allowlist matches the shared bridge exactly.
const bridgeMethods = JSON.parse(`[${/const allowed = new Set\(\[([^\]]+)\]\)/.exec(bridge)[1].replace(/'/g, '"')}]`).sort();
const codecMethods = JSON.parse(`[${/const NATIVE_RENDERER_METHODS = new Set\(\[([^\]]+)\]\)/.exec(codec)[1].replace(/'/g, '"')}]`).sort();
check(JSON.stringify(bridgeMethods) === JSON.stringify(codecMethods), 'codec allowlist equals bridge.js allowlist');
check(!codecMethods.includes('project.grant'), 'project.grant is not renderer-callable');

// No shell, no Electron, no security downgrades, no script-source interpolation.
for (const [pattern, label] of [[/\/bin\/(?:ba|z)?sh\b|bash -c|launchPath|system\(|popen\(/, 'no shell invocation'], [/Electron|electron/, 'no Electron runtime'], [/--no-sandbox|NSAllowsArbitraryLoads|developerExtrasEnabled|allowFileAccessFromFileURLs|allowUniversalAccessFromFileURLs/, 'no security downgrade'], [/evaluateJavaScript\(/, 'host data never evaluated as script source']])
  check(!pattern.test(all), label);
check(/arguments: \[installation\.hostEntry\.path, "--stdio"\]/.test(swift['StudioController.swift']), 'host argv is fixed: <managed node> studio-host.mjs --stdio');
check(/callAsyncJavaScript\("window\.ZukuStudioReceive\(message\); return true;", arguments: \["message": message\]/.test(swift['StudioController.swift']), 'renderer receives JSON as a string argument');
check(/injectionTime: \.atDocumentStart, forMainFrameOnly: true/.test(swift['StudioController.swift']), 'bridge injected at document start, top frame only');
check(/message\.frameInfo\.isMainFrame/.test(swift['StudioController.swift']) && /securityOrigin\.host == StudioSchemeHandler\.host/.test(swift['StudioController.swift']), 'bridge messages checked for main frame and app origin');
check(/websiteDataStore = \.nonPersistent\(\)/.test(swift['PreviewController.swift']) && !/addUserScript|\.add\([^)]*name:/.test(swift['PreviewController.swift']) && !/setURLSchemeHandler/.test(swift['PreviewController.swift']), 'preview is ephemeral with no privileged handlers');
check(/"--self-test"/.test(swift['StudioApp.swift']) && /"--stdio-test"/.test(swift['StudioApp.swift']), 'native self-tests are wired');
check(/-swift-version 6/.test(build) && /--arch must be arm64 or x86_64/.test(build) && /--sign - /.test(build) && !/notarytool submit|Developer ID Application:/.test(build.replace(/^#.*$/gm, '')), 'Swift 6, explicit arch, ad-hoc only');
check(/uname -s\)" == Darwin \]\] \|\| fail/.test(build), 'build refuses to pretend on non-macOS hosts');
check(/^\/\/ SYNTHETIC FIXTURE/.test(read('tests/stdio-fixture.mjs')), 'stdio fixture is labeled synthetic');
console.log(`macOS native static checks: ${checks} passed (text-level only; Swift not compiled here).`);
