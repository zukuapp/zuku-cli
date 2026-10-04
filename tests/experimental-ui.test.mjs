import test from 'node:test';
import assert from 'node:assert/strict';
import { CODEX_AUTH_METHOD, experimentalIndicator, renderAuthMethod } from '../lib/experimental.mjs';

test('auth metadata controls the orange exp indicator; official methods remain plain', () => {
  const tty = { stream: { isTTY: true }, environment: { TERM: 'xterm-256color' } };
  assert.equal(renderAuthMethod(CODEX_AUTH_METHOD, tty), 'Codex OAuth \x1b[38;5;208m(exp!)\x1b[0m');
  assert.equal(renderAuthMethod({ name: 'Experimental is a name', official: true, experimental: false }, tty), 'Experimental is a name');
  assert.equal(renderAuthMethod({ name: 'Custom OAuth', official: false, experimental: true }, tty), 'Custom OAuth \x1b[38;5;208m(exp!)\x1b[0m');
  for (const options of [{ stream: { isTTY: false }, environment: {} }, { stream: { isTTY: true }, environment: { TERM: 'dumb' } }, { stream: { isTTY: true }, environment: { NO_COLOR: '' } }]) {
    assert.equal(experimentalIndicator(CODEX_AUTH_METHOD, options), '(exp!)');
  }
});
