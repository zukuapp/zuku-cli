import test from 'node:test';
import assert from 'node:assert/strict';
import { run } from '../index.mjs';
import account from '../commands/account.mjs';

async function capture(args, context) {
  let out = '', err = '';
  const code = await run(args, { stdout: { write: v => { out += v; } }, stderr: { write: v => { err += v; } }, ...context });
  return { code, out, err };
}
test('default and explicit agent route once with bounded CLI context, never framework dispatch', async () => {
  for (const [args, expected] of [[[], []], [['agent', '점프 게임', '--yolo', '--json'], ['점프 게임', '--yolo']], [['--yolo'], ['--yolo']]]) {
    let calls = 0;
    const result = await capture(args, { agent: async (values, context) => { calls++; assert.deepEqual(values, expected); assert.equal(typeof context.cwd, 'string'); return { status: 'fixture-only' }; } });
    assert.equal(result.code, 0); assert.equal(calls, 1); assert.equal(result.err, '');
  }
});
test('provider login and deploy keep original argument intent and use separate routes', async () => {
  for (const [args, provider, expected] of [[['login', 'zuku', '--no-browser', '--json'], 'zuku', ['--no-browser']], [['login', 'codex', '--experimental', '--json'], 'codex', ['--experimental']], [['deploy', 'game', '--yolo', '--json'], 'deploy', ['game', '--yolo']]]) {
    const handler = async values => { assert.deepEqual(values, expected); return { provider }; };
    const result = await capture(args, { loginZuku: handler, loginCodex: handler, deploy: handler });
    assert.equal(result.code, 0); assert.equal(JSON.parse(result.out).data.provider, provider); assert.equal(result.err, '');
  }
  const bad = await capture(['login', 'unknown', '--json'], {});
  assert.equal(bad.code, 2); assert.equal(JSON.parse(bad.err).error.code, 'INVALID_INPUT');
});
test('command help resolves before login, model calls or publishing', async () => {
  for (const command of ['agent', 'login', 'deploy']) {
    const unexpected = async () => { throw Error('must not execute'); };
    const result = await capture([command, '--help'], { agent: unexpected, loginZuku: unexpected, deploy: unexpected });
    assert.equal(result.code, 0); assert.match(result.out, /6시간/); assert.equal(result.err, '');
  }
});
test('confirmed production success remains visible if cancellation arrives after commit', async () => {
  const controller = new AbortController();
  const result = await capture(['deploy', 'game', '--yolo', '--json'], { signal: controller.signal, deploy: async () => { controller.abort(); return { status: 'published', published: true, content: { id: 'cnt_fixture' }, receipt: { saved: true } }; } });
  assert.equal(result.code, 0); assert.equal(result.err, ''); assert.equal(JSON.parse(result.out).data.published, true);
});
test('account projection omits tokens and secrets; quota is an explicit server read', async () => {
  let reads = 0;
  const context = { loadAccount: async () => ({ access_token: 'private-bearer', refresh_token: 'private-refresh', email: 'private-email', scope: 'games:read games:write games:publish' }), readQuota: async () => { reads++; return { limit: 3, remaining: 2 }; } };
  const status = await account([], context);
  assert.equal(reads, 0); assert.equal(status.connected, true); assert.doesNotMatch(JSON.stringify(status), /private/);
  const quota = await account(['--quota'], context); assert.equal(reads, 1); assert.equal(quota.quota.remaining, 2);
  await assert.rejects(account(['--unknown'], context), { code: 'INVALID_INPUT' }); assert.equal(reads, 1);
});
