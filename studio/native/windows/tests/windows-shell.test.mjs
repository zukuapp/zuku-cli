// Static and fixture checks for the Windows Studio shell that run on any OS with Node.
// They do not compile or launch the WPF/WebView2 app; build.ps1 does that on Windows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, serialize, MANIFEST, ROOT } from '../tools/protocol-manifest.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const windows = join(here, '..');
const read = relative => readFileSync(join(windows, relative), 'utf8');
const source = ['src/ZukuStudio/MainWindow.cs', 'src/ZukuStudio/Program.cs', 'src/ZukuStudio/SingleInstance.cs', 'src/ZukuStudio/PromptWindow.cs', 'src/ZukuStudio/Win32.cs',
  'src/ZukuStudio.Core/HostConnection.cs', 'src/ZukuStudio.Core/StudioRouter.cs', 'src/ZukuStudio.Core/RendererGate.cs', 'src/ZukuStudio.Core/Installation.cs', 'src/ZukuStudio.Core/Policies.cs', 'src/ZukuStudio.Core/Json.cs']
  .map(relative => [relative, read(relative)]);

test('embedded protocol manifest matches schema.mjs and bridge.js', async () => {
  assert.equal(readFileSync(MANIFEST, 'utf8'), serialize(await buildManifest()), 'run: node studio/native/windows/tools/protocol-manifest.mjs --write');
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  for (const method of ['project.grant', 'preview.read', 'studio.open', 'native.projectChosen', 'native.resolvePreview', 'native.pairingDecision', 'native.authResponse'])
    assert.ok(!Object.hasOwn(manifest.rendererMethods, method), `${method} must not be renderer-callable`);
});

test('served assets are exactly the renderer files plus the shared schema, and imports stay inside', () => {
  const installation = read('src/ZukuStudio.Core/Installation.cs');
  const served = [...installation.matchAll(/\["(\/[^"]+)"\] = "([^"]+)"/g)].map(match => { assert.equal(match[1], '/' + match[2]); return match[2]; });
  const renderer = readdirSync(join(ROOT, 'studio', 'renderer')).filter(name => !name.startsWith('.')).map(name => `studio/renderer/${name}`);
  assert.deepEqual([...served].sort(), [...renderer, 'lib/agent-protocol/schema.mjs'].sort());
  assert.equal(served.length, 11);
  for (const file of served.filter(name => /\.(mjs|html)$/.test(name))) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    const specifiers = [...text.matchAll(/(?:import|export)\s[^'"]*?from\s+'([^']+)'|<script[^>]+src="([^"]+)"|<link[^>]+href="([^"]+)"/g)].map(match => match[1] ?? match[2] ?? match[3]);
    for (const specifier of specifiers) {
      assert.ok(specifier.startsWith('.'), `${file} imports non-relative ${specifier}`);
      assert.ok(served.includes(posix.normalize(posix.join(posix.dirname(file), specifier))), `${file} imports ${specifier} outside the allowlist`);
    }
  }
});

test('trusted origin CSP equals the renderer meta CSP plus frame-ancestors', () => {
  const html = readFileSync(join(ROOT, 'studio', 'renderer', 'index.html'), 'utf8');
  const meta = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)[1];
  const header = read('src/ZukuStudio.Core/Installation.cs').match(/ContentSecurityPolicy = "([^"]+)"/)[1];
  assert.equal(header, `${meta}; frame-ancestors 'none'`);
});

test('project pins official WebView2 1.0.4258.31 and publishes its own .NET 10 WPF runtime', () => {
  const project = read('src/ZukuStudio/ZukuStudio.csproj');
  assert.match(project, /<PackageReference Include="Microsoft\.Web\.WebView2" Version="\[1\.0\.4258\.31\]" \/>/);
  assert.match(project, /<TargetFramework>net10\.0-windows<\/TargetFramework>/);
  assert.match(project, /<UseWPF>true<\/UseWPF>/);
  assert.match(project, /<SelfContained>true<\/SelfContained>/);
  assert.match(project, /<UseAppHost>true<\/UseAppHost>/);
  assert.doesNotMatch(project, /Electron|electron/);
  assert.match(read('src/ZukuStudio/Program.cs'), /\[STAThread\]/);
  assert.match(read('src/ZukuStudio.Core/ZukuStudio.Core.csproj'), /<TargetFramework>net10\.0<\/TargetFramework>/);
  assert.match(project, /<Target Name="VerifyAppLocalRuntime" AfterTargets="Publish">/);
  assert.match(project, /\$\(SelfContained\).*!= 'true'/);
  for (const file of ['ZukuStudio.exe', 'ZukuStudio.runtimeconfig.json', 'coreclr.dll', 'hostfxr.dll', 'hostpolicy.dll', 'System.Private.CoreLib.dll', 'PresentationFramework.dll']) assert.ok(project.includes(`Exists('$(PublishDir)${file}')`));
  const publish = read('build.ps1').match(/Invoke-Checked \$dotnet @\('publish'[^\n]+/)[0];
  assert.match(publish, /'--self-contained', 'true'/);
  assert.doesNotMatch(publish, /'--self-contained', 'false'/);
  assert.match(read('src/ZukuStudio/MainWindow.cs'), /GetAvailableBrowserVersionString\(\)/);
  assert.match(read('src/ZukuStudio/MainWindow.cs'), /STUDIO_WEBVIEW2_MISSING/);
});

test('no privileged web surface, shell, sandbox downgrade or machine-wide registration', () => {
  const forbidden = [/AddHostObjectToScript/, /SetVirtualHostNameToFolderMapping/, /ExecuteScriptAsync/, /UseShellExecute\s*=\s*true/, /cmd\.exe/i, /powershell/i,
    /--no-sandbox/, /--disable-web-security/, /AdditionalBrowserArguments\s*=/, /Registry\.LocalMachine|HKEY_LOCAL_MACHINE|HKLM/, /AreDevToolsEnabled\s*=\s*true/, /IsInPrivateModeEnabled\s*=\s*false/];
  for (const [file, text] of source) for (const pattern of forbidden) assert.doesNotMatch(text, pattern, `${file} matches ${pattern}`);
  const registration = read('scripts/protocol-registration.ps1');
  assert.doesNotMatch(registration, /LocalMachine|HKLM:|HKEY_LOCAL_MACHINE/);
  assert.match(registration, /Registry\]::CurrentUser/);
  assert.match(registration, /PENDING ROOT REVIEW/);
});

test('editor is the only web-message endpoint; preview gets no bridge or messages', () => {
  const main = read('src/ZukuStudio/MainWindow.cs');
  assert.equal(main.match(/WebMessageReceived/g).length, 1);
  assert.equal(main.match(/AddScriptToExecuteOnDocumentCreatedAsync\(TrustedOrigin\.BridgeScript/g).length, 1);
  assert.match(main, /Harden\(core\.Settings, messages: true\);[\s\S]*Harden\(core\.Settings, messages: false\);/);
  assert.match(main, /settings\.AreHostObjectsAllowed = false;/);
  assert.match(main, /EnvironmentAsync\("editor"\)/);
  assert.match(main, /EnvironmentAsync\("preview"\)/);
  assert.match(main, /PostWebMessageAsJson\(render\.Json\)/);
  assert.match(read('src/ZukuStudio.Core/Installation.cs'), /window === window\.top && location\.href === /);
});

test('host child is exactly managed node + lib/studio-host.mjs --stdio without a shell', () => {
  assert.match(read('src/ZukuStudio/MainWindow.cs'), /HostConnection\.Start\(trusted\.NodePath, \[trusted\.HostEntry, "--stdio"\]/);
  const connection = read('src/ZukuStudio.Core/HostConnection.cs');
  assert.match(connection, /UseShellExecute = false/);
  assert.match(connection, /ArgumentList\.Add/);
  assert.doesNotMatch(connection, /\.Arguments\s*=/);
  assert.match(read('src/ZukuStudio.Core/Installation.cs'), /public const string HostFile = "lib\/studio-host\.mjs";/);
});

test('native limits match the Linux shell and bridge', () => {
  const limits = read('src/ZukuStudio.Core/ProtocolManifest.cs');
  const linux = readFileSync(join(ROOT, 'studio', 'native', 'linux', 'protocol.h'), 'utf8');
  const value = (pattern, text) => Number(text.match(pattern)[1]);
  assert.equal(value(/OutgoingLineBytes = (\d+)/, limits), value(/STUDIO_LINE_BYTES (\d+)u/, linux));
  assert.equal(value(/IncomingLineBytes = (\d+)/, limits), value(/STUDIO_RESPONSE_BYTES (\d+)u/, linux));
  assert.equal(value(/OutgoingQueueBytes = (\d+)/, limits), value(/STUDIO_QUEUE_BYTES (\d+)u/, linux));
  assert.equal(value(/OutgoingQueueCount = (\d+)/, limits), value(/STUDIO_QUEUE_COUNT (\d+)u/, linux));
  assert.match(readFileSync(join(ROOT, 'studio', 'native', 'bridge.js'), 'utf8'), /length>65536/);
});

function fixture() {
  const child = spawn(process.execPath, [join(here, 'stdio-fixture.mjs')], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buffer = '';
  const waiters = [];
  const lines = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) { lines.push(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
    while (waiters.length && lines.length >= waiters[0].count) { const waiter = waiters.shift(); waiter.resolve(lines.splice(0, waiter.count)); }
  });
  return {
    child,
    send: value => child.stdin.write(JSON.stringify({ protocolVersion: 1, ...value }) + '\n'),
    next: count => new Promise(resolve => {
      if (lines.length >= count) resolve(lines.splice(0, count));
      else waiters.push({ count, resolve });
    }),
  };
}

test('SYNTHETIC stdio fixture speaks the native host contract', async () => {
  const host = fixture();
  try {
    host.send({ id: 'native_1', method: 'native.projectChosen', params: { requestId: 'ui_pick', localPath: 'C:\\Games\\Dash' } });
    const [picked] = await host.next(1);
    assert.equal(JSON.parse(picked).id, 'ui_pick', 'host answers the original picker id');
    host.send({ id: 'native_2', method: 'native.resolvePreview', params: { previewHandle: 'preview_ok' } });
    assert.match(JSON.parse((await host.next(1))[0]).result.url, /^http:\/\/127\.0\.0\.1:\d+\/p\/[a-f0-9]{32}\/$/);
    host.send({ id: 'native_3', method: 'native.authResponse', params: { requestId: 'auth_fixture', value: 'synthetic-credential-value' } });
    assert.doesNotMatch((await host.next(1))[0], /synthetic-credential-value/);
    host.send({ id: 'ui_1', method: 'hello', params: { clientVersion: 'oversize' } });
    const [oversize] = await host.next(1);
    assert.ok(Buffer.byteLength(oversize) > 262144, 'fixture emits an over-limit line for the native overflow test');
  } finally {
    host.child.stdin.end();
  }
});
