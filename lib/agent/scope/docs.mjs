import { readdir, readFile } from 'node:fs/promises';
import { ScopeError } from './errors.mjs';
import { boundText } from './redact.mjs';

// query_zuku_docs: the CLI's own shipped docs (always available, offline) plus, only when
// the root supplies them, fixed official public HTTPS documents. Requests are anonymous
// GETs: no credentials, cookies or custom headers, redirects refused, bodies bounded.
// Results are reference data for the model, never instructions or authority.
export const DOCS_LIMITS = Object.freeze({ remoteBytes: 256 * 1024, timeoutMs: 10_000, excerpts: 5, excerptChars: 1200, sources: 16 });
const LOCAL_DOCS = new URL('../../../docs/', import.meta.url);

export function admitDocSources(sources = []) {
  if (!Array.isArray(sources) || sources.length > DOCS_LIMITS.sources) throw new ScopeError('DOCS_UNAVAILABLE');
  return Object.freeze(sources.map(source => {
    let url;
    try { url = new URL(source); } catch { throw new ScopeError('DOCS_UNAVAILABLE'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port) throw new ScopeError('DOCS_UNAVAILABLE');
    return url.href;
  }));
}

async function localDocs() {
  const out = [];
  let names = [];
  try { names = (await readdir(LOCAL_DOCS)).filter(name => /^[a-z0-9-]+\.md$/.test(name)).sort(); } catch { return out; }
  for (const name of names.slice(0, 64)) {
    try { out.push({ source: `zukujs-cli:docs/${name}`, text: await readFile(new URL(name, LOCAL_DOCS), 'utf8') }); } catch { /* skip unreadable */ }
  }
  return out;
}

async function remoteDoc(href, { fetchImpl, signal }) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, DOCS_LIMITS.timeoutMs);
  try {
    const response = await fetchImpl(href, { method: 'GET', redirect: 'error', credentials: 'omit', headers: { accept: 'text/markdown, text/plain, text/html' }, signal: controller.signal });
    if (!response.ok || !response.body || !/^text\/(?:markdown|plain|html)\b/.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel().catch(() => {}); return undefined; }
    const reader = response.body.getReader();
    const chunks = []; let size = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > DOCS_LIMITS.remoteBytes) { await reader.cancel(); return undefined; }
      chunks.push(value);
    }
    return { source: href, text: Buffer.concat(chunks).toString('utf8').replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, ' ') };
  } catch { return undefined; } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
}

export function createDocsTool({ sources = [], fetchImpl = globalThis.fetch } = {}) {
  const remote = admitDocSources(sources);
  return {
    remote: remote.length > 0,
    async query(query, { signal } = {}) {
      const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_.-]+/u).filter(term => term.length >= 2))].slice(0, 12);
      if (!terms.length) return { untrusted_reference: true, excerpts: [] };
      const docs = await localDocs();
      for (const href of remote) {
        if (signal?.aborted) throw new ScopeError('COMMAND_CANCELLED');
        const doc = await remoteDoc(href, { fetchImpl, signal });
        if (doc) docs.push(doc);
      }
      const scored = [];
      for (const doc of docs) {
        for (const block of doc.text.split(/\n\s*\n/)) {
          const lower = block.toLowerCase();
          const score = terms.reduce((sum, term) => sum + (lower.includes(term) ? 1 : 0), 0);
          if (score) scored.push({ source: doc.source, score, text: boundText(block.trim(), DOCS_LIMITS.excerptChars).text });
        }
      }
      scored.sort((a, b) => b.score - a.score || (a.source < b.source ? -1 : 1));
      return { untrusted_reference: true, excerpts: scored.slice(0, DOCS_LIMITS.excerpts) };
    },
  };
}
