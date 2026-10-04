# ZUKU Studio renderer UI

`studio/renderer/` is the desktop workspace view for ZUKU Studio: a games IDE for
the same local Agent Core that `zuku`/`zukujs` use. It is a pure view. It owns no
agent loop, provider client, credential store, filesystem or process access. Every
action is a typed Agent Core method sent through the preload bridge, and every status
it shows comes from Core results or `zuku-agent/1` events.

Electron main/preload, the native auth prompt, the project picker, preview hosting
and packaging belong to the native host owner. This document covers only the renderer.

## Layout

| Area | Content |
| --- | --- |
| Status bar (navy) | Agent Core connection, project, active provider (with `(exp!)` when the active auth method is experimental), model, event cursor `이벤트 #N` and subscription state |
| Project/session rail (navy) | Granted projects, native **프로젝트 열기**, sessions with state, new session (optional per-session `provider/model`), close (Core rejects closing a running session) |
| Game stage | Build / Test / Run / Stop (typed `session.input` operations), **미리보기**, and the registered GamePreview slot |
| Work tabs | 소스 (read/search/edit), 변경 사항 (bounded diff + agent file-change log), 로그 (build output, host build/game state), 제공자·모델 |
| Chat/activity | Session state, safe phase, gap/drop notices, auth/permission/error banners, completion card, transcript, tool activity, composer |

Responsive behaviour: three columns on desktop. At 1100px or narrower the chat column
moves below the work area. At 720px or narrower only one pane shows, and a bottom bar
switches between 프로젝트 / 게임 / 작업 / 대화.

Theme tokens: `--zk-night` (navigation), `--zk-paper` (canvas), `--zk-sheet`
(panels), `--zk-sprout` (game green: ready/run/verified), `--zk-ember`
(`(exp!)` only), `--zk-ink` (text). Body text is 15px with system fonts, focus rings
are visible, there are no loading animations, `prefers-reduced-motion` and
`forced-colors` are honoured, and all assets are bundled.

## Native bridge contract (preload → renderer)

```js
window.zukuStudio = {
  call(method, params): Promise<result>,          // unwrapped Core result; rejects with {code, action?, retryAfterMs?}
  subscribe({ sessionId, afterSequence }, onMessage): () => void,
  pickProject(): Promise<{ projectHandle, name }>,  // reject {code:'COMMAND_CANCELLED'} when the user cancels
  showPreview({ previewHandle, rect: { x, y, width, height } }): Promise<void>,
  hidePreview(): Promise<void>,
};
```

- `call` is limited to `RENDERER_METHODS` in `client.mjs`. Params are checked with the
  shared `validateRequest` from `lib/agent-protocol/schema.mjs` before the bridge sees
  them, and main must validate again. `project.grant`, `provider.add/remove`,
  `preview.read` and `studio.open` are not callable from the renderer.
- `onMessage` receives `zuku-agent/1` event envelopes. Each one is checked with
  `validateEvent`; invalid events are counted and dropped, never shown. The relay may
  also send `{kind:'status', state:'connected'|'disconnected'|'cursor_expired'|'closed', code?, minimumSequence?}`.
  This status shape is a renderer proposal for root main to confirm.
- `rect` is in CSS pixels relative to the renderer viewport: finite, integer, clamped to
  the viewport, and at least 16px in each dimension. It is re-sent after resize, scroll
  or pane changes. `hidePreview` is called when the slot is hidden, the handle fails, or
  the view unmounts. Main must check that `previewHandle` was registered by Core.

## Behaviour guarantees

- **Sessions:** a subscription starts at the last seen `sequence`. Duplicates are ignored.
  Gaps (including `CURSOR_EXPIRED` → `minimumSequence`) are shown as missing ranges and
  never replayed or invented. Reconnects use bounded backoff (6 attempts), then offer a
  manual **이벤트 다시 연결** button. Unmounting or switching session only detaches the
  subscriber; it never sends `session.cancel`/`session.close`. Cancelling requires the
  explicit **작업 취소** button.
- **Input:** `session.input` carries `sessionId`, a `requestId` from
  `crypto.getRandomValues` (`input_` + 24 base64url characters), an `operation` from the
  closed enum, and `request` (at most 4,000 chars, no control characters, refused locally
  if it looks like a secret). If the transport fails, the user can retry with the **same**
  requestId and body so Core can de-duplicate.
- **Verification:** "호스트 검증됨" appears only for `agent.completed {status:'completed', verified:true}`.
  Build pass/fail comes only from `build.completed`. Model text such as "tests passed"
  has no effect on either.
- **Text safety:** all text goes into text nodes. The DOM helper has no HTML sink and
  accepts no `href`/`src`/`style` attributes. Fenced code renders as `<pre>`, and there
  is no markdown linkification. Event text also passes through shared `sanitizeText`
  (paths → `[local path]`, ANSI/control characters removed, secrets dropped). Errors show
  fixed Korean messages keyed by safe code and never `error.message`.
- **Editing:** `project.read` takes an admitted relative path. Saving uses
  `project.patch {projectHandle, path, content, expectedSha256}`, where `expectedSha256`
  comes from Core's read result. Without a Core digest the Save button is disabled.
  `PROJECT_CHANGED` marks the file stale and offers a reload. Agent `tool.completed` events
  for the open file also mark it stale. Content is capped at 48 KiB.
- **Diff:** common prefix/suffix trimming, then an LCS table only while
  `(n+1)(m+1) ≤ 1,000,000` cells (Uint16). Beyond that it falls back to a linear
  delete-then-add block, labelled as approximate. Input is capped at 20,000 lines and
  display at 5,000 rows.
- **Providers/auth/models:** read from Core on every load and after
  `provider.changed`/`model.changed`. Nothing is cached in browser storage. `(exp!)`
  (orange) appears only when metadata has `experimental:true`, `unofficial:true` or
  `official:false`. Missing metadata is shown as "공식 여부 미확인", not as official.
  Logging in to an experimental method requires a consent checkbox and sends
  `auth.request {providerId, methodId, experimental:true}`. The native host then runs the
  credential prompt; the renderer never accepts keys or tokens. The model catalog shows
  unknown context/capabilities as "알 수 없음", and `model.use` accepts any well-formed
  `provider/model` address so Core can decide whether it is available.
- **Offline states:** no bridge, Core not running/unavailable, protocol mismatch, auth
  required, local permission required and preview unavailable each have a distinct,
  actionable banner.

## Reuse by another frontend

`studio/renderer/index.mjs` exports `mountStudio({ client, nativeActions, root })`
plus the pure helpers. It has no Node imports. Any client exposing `call`/`subscribe`
with the same semantics works. If `nativeActions` is omitted, or `client.native === false`,
the native-only controls (project picker, preview, provider enable/disable) are hidden.

## Tests

- `tests/studio-renderer-state.test.mjs`: event sequence/gap/duplicate handling, verification gating, redaction, bounds, error mapping, input admission, `(exp!)` metadata, catalog normalisation.
- `tests/studio-renderer-diff.test.mjs`: reconstruction, minimality against a reference LCS, cell-budget fallback, hunk bounds.
- `tests/studio-renderer-client.test.mjs`: requestId randomness, method/param admission via the shared schema, error redaction, timeout, subscription detach semantics, preview rect/controller, static source scan (no HTML sinks/network/storage/Node imports/external URLs, strict CSP).
- `tests/studio-renderer-dom.test.mjs`: real sandboxed Chrome via `playwright-core` against `index.html` with a fixture bridge. It skips under uid 0 (no `--no-sandbox` fallback) or when Chrome is missing. Run as an ordinary user:

  ```sh
  ZUKU_STUDIO_CHROME=/opt/zuku-thumbnail-browser/chrome-linux64/chrome node --test tests/studio-renderer-dom.test.mjs
  ```

The DOM test validates the renderer only. It does not test the Electron launch,
preload or Core integration.

## Integration notes for root

1. `main.mjs` imports `../../lib/agent-protocol/schema.mjs`. The packaged app must serve
   `studio/renderer/**` and that file from one origin that satisfies the page CSP
   (`script-src 'self'`). `package.json#files` does not currently include `studio/`.
2. `scripts/check-syntax.mjs` scans only `commands`, `lib` and `scripts`. Add `studio` if lint should cover the renderer.
3. Assumed result shapes (all parsed defensively): list methods return arrays or
   `{projects|sessions|providers|models|matches}`; `session.create` → `{sessionId}`;
   `project.read` → `{content, sha256, encoding?}`; `project.patch` → `{sha256}`;
   `game.preview` → `{previewHandle}`; `hello` → `{protocolVersion}`. Today
   `projectPublicResult` strips `discovery`, `envVar` and `missingConfiguration`, so
   those appear as unknown.
4. No `lib/agent-protocol/client.mjs` exists yet. When it lands, `client.mjs` can delegate to it as long as the bridge contract above stays the same.
5. Main must check `auth.request.experimental` and `session.input.experimental` against Core policy. The renderer flag is only the user's opt-in, not an authority.
