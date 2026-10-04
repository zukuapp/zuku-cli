// Bounded line diff: common prefix/suffix trimming, then an LCS table only while
// the middle region fits DIFF_LIMITS.cells; otherwise a linear replace block.
export const DIFF_LIMITS = Object.freeze({ lines: 20000, cells: 1000000, rows: 5000, context: 3 });

export function splitLines(text) {
  if (typeof text !== 'string' || text === '') return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function diffLines(before, after, limits = DIFF_LIMITS) {
  let a = splitLines(before), b = splitLines(after), truncated = false;
  if (a.length > limits.lines) { a = a.slice(0, limits.lines); truncated = true; }
  if (b.length > limits.lines) { b = b.slice(0, limits.lines); truncated = true; }
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ type: 'same', text: a[i], oldLine: i + 1, newLine: i + 1 });
  const n = endA - start, m = endB - start;
  let approximate = false;
  if (n && m && (n + 1) * (m + 1) <= limits.cells) middleLcs(a, b, start, n, m, ops);
  else {
    approximate = n > 0 && m > 0;
    for (let i = 0; i < n; i++) ops.push({ type: 'del', text: a[start + i], oldLine: start + i + 1, newLine: null });
    for (let j = 0; j < m; j++) ops.push({ type: 'add', text: b[start + j], oldLine: null, newLine: start + j + 1 });
  }
  for (let k = 0; endA + k < a.length; k++) ops.push({ type: 'same', text: a[endA + k], oldLine: endA + k + 1, newLine: endB + k + 1 });
  let added = 0, removed = 0;
  for (const op of ops) { if (op.type === 'add') added++; else if (op.type === 'del') removed++; }
  return { ops, approximate, truncated, added, removed };
}

function middleLcs(a, b, offset, n, m, ops) {
  // min(n,m) <= sqrt(cells) so every LCS length fits a Uint16 cell.
  const width = m + 1, table = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
    table[i * width + j] = a[offset + i] === b[offset + j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
  }
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[offset + i] === b[offset + j]) { ops.push({ type: 'same', text: a[offset + i], oldLine: offset + i + 1, newLine: offset + j + 1 }); i++; j++; }
    else if (i < n && (j === m || table[(i + 1) * width + j] >= table[i * width + j + 1])) { ops.push({ type: 'del', text: a[offset + i], oldLine: offset + i + 1, newLine: null }); i++; }
    else { ops.push({ type: 'add', text: b[offset + j], oldLine: null, newLine: offset + j + 1 }); j++; }
  }
}

/** Collapses unchanged runs into display hunks, bounded to limits.rows rows. */
export function toHunks(ops, { context = DIFF_LIMITS.context, rows = DIFF_LIMITS.rows } = {}) {
  const keep = new Uint8Array(ops.length);
  ops.forEach((op, index) => { if (op.type !== 'same') for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k++) keep[k] = 1; });
  const hunks = [];
  let current = null, count = 0, clipped = false;
  for (let index = 0; index < ops.length; index++) {
    if (!keep[index]) { current = null; continue; }
    if (count >= rows) { clipped = true; break; }
    if (!current) { current = { oldStart: ops[index].oldLine, newStart: ops[index].newLine, lines: [] }; hunks.push(current); }
    current.lines.push(ops[index]); count++;
  }
  return { hunks, clipped };
}
