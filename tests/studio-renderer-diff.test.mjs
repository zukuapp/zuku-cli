import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, toHunks, splitLines, DIFF_LIMITS } from '../studio/renderer/diff.mjs';

const sides = ops => ({ before: ops.filter(op => op.type !== 'add').map(op => op.text), after: ops.filter(op => op.type !== 'del').map(op => op.text) });
function lcsLength(a, b) {
  const prev = new Array(b.length + 1).fill(0);
  for (const x of a) { let diag = 0; for (let j = 1; j <= b.length; j++) { const keep = prev[j]; prev[j] = x === b[j - 1] ? diag + 1 : Math.max(prev[j], prev[j - 1]); diag = keep; } }
  return prev[b.length];
}

test('line diff reconstructs both sides and is minimal inside the cell budget', () => {
  assert.deepEqual(diffLines('a\nb\nc\n', 'a\nb\nc\n'), { ops: [{ type: 'same', text: 'a', oldLine: 1, newLine: 1 }, { type: 'same', text: 'b', oldLine: 2, newLine: 2 }, { type: 'same', text: 'c', oldLine: 3, newLine: 3 }], approximate: false, truncated: false, added: 0, removed: 0 });
  const result = diffLines('a\nb\nc\nd', 'a\nx\nc\nd\ne');
  assert.deepEqual([result.added, result.removed, result.approximate], [2, 1, false]);
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let round = 0; round < 200; round++) {
    const a = Array.from({ length: Math.floor(rand() * 30) }, () => 'abcd'[Math.floor(rand() * 4)]);
    const b = Array.from({ length: Math.floor(rand() * 30) }, () => 'abcd'[Math.floor(rand() * 4)]);
    const { ops } = diffLines(a.join('\n'), b.join('\n'));
    assert.deepEqual(sides(ops), { before: a, after: b });
    assert.equal(ops.filter(op => op.type === 'same').length, lcsLength(a, b));
    for (const op of ops) if (op.type === 'same') assert.equal(splitLines(a.join('\n'))[op.oldLine - 1], splitLines(b.join('\n'))[op.newLine - 1]);
  }
});

test('large divergent inputs fall back to a linear replace block without an unbounded table', () => {
  const a = Array.from({ length: 19000 }, (_, i) => `old ${i}`).join('\n');
  const b = Array.from({ length: 19000 }, (_, i) => `new ${i}`).join('\n');
  const started = performance.now();
  const result = diffLines(`head\n${a}\ntail`, `head\n${b}\ntail`);
  assert.ok(performance.now() - started < 2000);
  assert.equal(result.approximate, true); assert.equal(result.truncated, false);
  assert.deepEqual([result.added, result.removed], [19000, 19000]);
  assert.deepEqual(sides(result.ops), { before: splitLines(`head\n${a}\ntail`), after: splitLines(`head\n${b}\ntail`) });
  const small = diffLines('a\nb\nc', 'x\ny\nz', { ...DIFF_LIMITS, cells: 4 });
  assert.equal(small.approximate, true);
  const capped = diffLines(Array.from({ length: 30 }, (_, i) => i).join('\n'), 'x', { ...DIFF_LIMITS, lines: 10 });
  assert.equal(capped.truncated, true); assert.equal(capped.removed, 10);
  assert.equal(diffLines('', 'a\nb').approximate, false);
});

test('hunks keep bounded context and clip at the row budget', () => {
  const before = Array.from({ length: 100 }, (_, i) => `l${i}`);
  const after = before.slice(); after[10] = 'changed'; after[80] = 'changed2';
  const { hunks, clipped } = toHunks(diffLines(before.join('\n'), after.join('\n')).ops);
  assert.equal(hunks.length, 2); assert.equal(clipped, false);
  assert.equal(hunks[0].oldStart, 8); assert.equal(hunks[0].lines.length, 8);
  const many = toHunks(diffLines('', Array.from({ length: 50 }, (_, i) => i).join('\n')).ops, { context: 3, rows: 20 });
  assert.equal(many.clipped, true); assert.equal(many.hunks[0].lines.length, 20);
});
