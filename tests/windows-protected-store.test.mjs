import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, link, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readProtectedStore, writeProtectedStore, removeProtectedStore, withProtectedStoreLock } from '../lib/accounts/windows-protected-store.mjs';

const windows = process.platform === 'win32';
const unsafe = error => error.code === 'ZUKU_ACCOUNT_UNSAFE';
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'zukujs-dpapi-'));
  t.after(() => rm(root, { force: true, recursive: true }));
  return { root, file: path.join(root, 'private', 'account.dpapi') };
}

test('Windows protected store fails safely on unsupported platforms', { skip: windows }, async () => {
  await assert.rejects(readProtectedStore('/tmp/unused'), unsafe);
  await assert.rejects(writeProtectedStore('/tmp/unused', 'fixture'), unsafe);
  await assert.rejects(withProtectedStoreLock('/tmp/unused', () => {}), unsafe);
});

test('protected-store cancellation is distinct from unsafe credentials and starts no operation', async () => {
  const controller = new AbortController(); controller.abort(); let invoked = false;
  await assert.rejects(withProtectedStoreLock(windows ? 'C:\\unused\\fixture.dpapi' : '/tmp/unused', () => { invoked = true; }, { signal: controller.signal }), error => error.code === 'COMMAND_CANCELLED');
  assert.equal(invoked, false);
});

test('Windows DPAPI round-trip, atomic replacement, opaque disk and removal', { skip: !windows }, async t => {
  const f = await fixture(t), first = JSON.stringify({ fixture: 'secret-mock-value', title: '게임 🎮' });
  assert.equal(await readProtectedStore(f.file), null);
  await writeProtectedStore(f.file, first);
  assert.equal(await readProtectedStore(f.file), first);
  assert.ok(!(await readFile(f.file)).includes(Buffer.from('secret-mock-value')));
  await writeProtectedStore(f.file, '{"replacement":true}');
  assert.equal(await readProtectedStore(f.file), '{"replacement":true}');
  await removeProtectedStore(f.file); assert.equal(await readProtectedStore(f.file), null);
});

test('Windows DPAPI rejects tampered ciphertext without a plaintext fallback', { skip: !windows }, async t => {
  const f = await fixture(t); await writeProtectedStore(f.file, '{"fixture":true}');
  const bytes = await readFile(f.file); bytes[Math.floor(bytes.length / 2)] ^= 1; await writeFile(f.file, bytes);
  await assert.rejects(readProtectedStore(f.file), unsafe);
  // Ciphertext corruption does not change ownership; replacement is explicitly allowed.
  await writeProtectedStore(f.file, '{"next":true}');
  assert.equal(await readProtectedStore(f.file), '{"next":true}');
});

test('Windows hard-linked files and directory junctions are rejected', { skip: !windows }, async t => {
  const f = await fixture(t); await writeProtectedStore(f.file, '{"fixture":true}');
  const alias = path.join(f.root, 'alias.dpapi'); await link(f.file, alias);
  await assert.rejects(readProtectedStore(f.file), unsafe); await rm(alias);
  const junction = path.join(f.root, 'junction'); await symlink(path.dirname(f.file), junction, 'junction');
  await assert.rejects(readProtectedStore(path.join(junction, 'account.dpapi')), unsafe);
});

const WEAKEN_ACL = String.raw`
$ErrorActionPreference = 'Stop'
$p = [Console]::In.ReadToEnd()
$acl = Get-Acl -LiteralPath $p
$sid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-545')
$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Allow)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $p -AclObject $acl
`;
test('Windows ACLs granting another SID access are refused', { skip: !windows }, async t => {
  const f = await fixture(t); await writeProtectedStore(f.file, '{"fixture":true}');
  await new Promise((resolve, reject) => {
    const executable = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const environment = { ...process.env, PSModulePath: path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') };
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WEAKEN_ACL, 'utf16le').toString('base64')], { env: environment, windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('Fixture ACL setup failed'))); child.stdin.end(f.file);
  });
  await assert.rejects(readProtectedStore(f.file), unsafe);
  await assert.rejects(writeProtectedStore(f.file, '{"next":true}'), unsafe);
});

test('Windows protected lock serializes operations and preserves callback errors', { skip: !windows }, async t => {
  const f = await fixture(t), seen = [];
  await Promise.all([1, 2].map(id => withProtectedStoreLock(f.file, async () => { seen.push(`start${id}`); await new Promise(resolve => setTimeout(resolve, 30)); seen.push(`end${id}`); return id; })));
  assert.ok(seen.join(',') === 'start1,end1,start2,end2' || seen.join(',') === 'start2,end2,start1,end1');
  await assert.rejects(withProtectedStoreLock(f.file, () => { throw new Error('fixture-only-error'); }), { message: 'fixture-only-error' });
  assert.equal(await withProtectedStoreLock(f.file, async () => 'unlocked'), 'unlocked');
});

test('Windows default ZUKU login store is read from isolated LOCALAPPDATA without forwarding implicit home', { skip: !windows }, async t => {
  const f = await fixture(t), appData = path.join(f.root, 'isolated-local-app-data');
  // Only this child changes LOCALAPPDATA. The actual user's account path is never touched.
  const program = String.raw`
    import assert from 'node:assert/strict';
    import { lstat, readFile } from 'node:fs/promises';
    import path from 'node:path';
    import { saveZukuAccount, removeZukuAccount } from './lib/accounts/store.mjs';
    import { GAME_SCOPES } from './lib/accounts/client.mjs';
    import { readAccessToken } from './lib/credentials.mjs';
    const target = path.join(process.env.LOCALAPPDATA, 'ZukuJS', 'account.dpapi');
    await assert.rejects(lstat(target), { code: 'ENOENT' });
    const access = 'zuku_oa_' + 'a'.repeat(64);
    await saveZukuAccount({ access_token: access, refresh_token: 'zuku_or_' + 'b'.repeat(64), scope: GAME_SCOPES.join(' '), expires_at: Date.now() + 3600000 });
    assert.equal(await readAccessToken({ environment: {} }), access);
    assert.ok(!(await readFile(target)).includes(Buffer.from(access)));
    await removeZukuAccount();
    assert.equal(await readAccessToken({ environment: {} }), undefined);
    assert.ok(!(await readFile(target)).includes(Buffer.from(access)));
    console.log('isolated-default-store PASS');
  `;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', program], { cwd: new URL('../', import.meta.url), env: { ...process.env, LOCALAPPDATA: appData, PSMODULEPATH: 'C:\\unused\\zuku-untrusted-fixture-modules' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Fixture child timed out')); }, 60000);
    child.stdout.on('data', data => { output += data.toString(); });
    child.stderr.on('data', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); code === 0 && output.trim() === 'isolated-default-store PASS' ? resolve() : reject(new Error('Isolated default Windows OAuth store regression failed')); });
  });
});
