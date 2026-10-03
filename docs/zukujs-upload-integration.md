# ZukuJS `upload`: coordinator integration notes

This branch implements `commands/upload.mjs` and `lib/upload-*.mjs`. The shared files `index.mjs`, `lib/errors.mjs`, `package.json`, `tests/cli.test.mjs`, the README and the core manifest/packaging modules belong to the coordinator and are **not changed** here. Until the steps below are applied, `zuku upload ...` keeps returning `NOT_IMPLEMENTED` and performs no I/O. That happens because the legacy one-argument call `execute(args)` has no context.

## 1. Entrypoint wiring (`index.mjs`)

Replace the shared `create/validate/package/upload` branch for `upload` with:

```js
} else if (command === 'upload') {
  const { default: upload } = await import('./commands/upload.mjs');
  const core = /* coordinator's packager, see §3 */ undefined;
  const progress = !json && stderr.isTTY ? ({ sent, total }) => stderr.write(`\rZukuJS upload ${Math.floor(sent * 100 / total)}%`) : undefined;
  data = await upload(positional.slice(1), { signal, core, onProgress: progress });
  if (progress) stderr.write('\n');
}
```

- The returned `data` is printed through the existing `success()` envelope as `success/data/meta`.
- Errors are `UploadError`, a subclass of `CommandError`, so the existing catch renders them unchanged. `error` may carry the additive keys `reason`, `stage`, `http_status`, `fields` and `receipt`. `toJSON()` already restricts these to safe tokens.
- Exit codes follow the existing rules. `INVALID_INPUT` exits with 2 and `COMMAND_CANCELLED` exits with 130.
- Update the `upload` help row to read: usage `zukujs upload <path|project> [--title T] [--description D] [--game-id ID] [--genre G] [--version X.Y.Z] [--age-rating all|12|15|18] [--tag T]... [--platform pc,mobile,tablet] [--receipt-dir DIR] [--verify]`, description `ZWF2/ZIP 검증 → 업로드 → JUMP 초안 생성 (게시하지 않음)`.
- `--check-api` text and `diagnostics` capability flags (`package_upload: false`) are coordinator-owned. Set `package_upload: true` only after this wiring lands.

## 2. Tests that the coordinator must update

`tests/cli.test.mjs` contains the test "all prototype commands ... fail closed". It expects `upload /root/private/<token> --json` to fail with `NOT_IMPLEMENTED`. After wiring, the same call fails locally with `UPLOAD_INPUT_UNSAFE` (exit 1, no network, no path echo). Change that assertion for `upload` only. Its no-echo assertions still hold.

## 3. Core packager interface (directory input)

When `<path>` is a directory, upload calls an injected `core.packageProject` instead of packaging by itself:

```ts
core.packageProject(absoluteProjectDir: string, { signal?: AbortSignal }): Promise<{
  bytes: Uint8Array,            // complete ZWF2 (preferred) or ZIP bytes, in memory
  metadata?: {                  // optional draft defaults from the local CLI project manifest
    title?: string, description?: string, game_id?: string, genre?: string, version?: string,
    age_rating?: 'all'|'12'|'15'|'18', tags?: string[],
    platform?: { pc: boolean, mobile: boolean, tablet: boolean } | 'pc,mobile'
  }
}>
```

- Upload always re-validates `bytes` with its own strict validator and uploads exactly those bytes. Packager output is never trusted.
- CLI flags override `metadata`, and `metadata` overrides package defaults.
- Errors thrown as `CommandError` keep their code. Any other error becomes `COMMAND_FAILED`.
- The packager must not run project code or build commands. It must reject symlinks and path escapes. It must exclude `.zukujs/`, which is the default receipt directory, along with `*.receipt.json`, credentials, VCS and dependency directories.
- Add `.zukujs/` to `.gitignore`.

Without `core`, directory input fails with `UPLOAD_PACKAGER_UNAVAILABLE` before any credential read or network activity.

## 4. Optional public validator

`runUpload(args, { validator })` accepts the MIT `@zuku/zwf` module, which provides `inspectZwf` and `inspectZip`. When it is supplied, it runs after the built-in validator and the two must agree. The output field `package.validator` then reads `zukujs-builtin+@zuku/zwf`.

`@zuku/zwf` 0.1.0 declares Node >=22 and depends on `fflate` 0.8.3. Adding it as a dependency means raising `engines.node` to `>=22` in `package.json` and the CI matrix (currently Node 20). It also means preserving the MIT attribution.

The built-in validator in this branch has no dependencies and uses only Node 18-compatible APIs (`node:zlib` inflateRawSync with `maxOutputLength`, `node:crypto`). However, this branch has only been tested on Node 22. Do not advertise Node 18 compatibility until CI runs on it.

## 5. Branding and binary

- Errors, receipts and progress text identify the tool as **ZukuJS**. The receipt `generator.name` is `"ZukuJS"`.
- The canonical CLI is `zukujs`, from the package `@zukujs/cli`. The `bin` entry and the package name belong to the coordinator.
- The SOL license and metadata are untouched.

## 5a. Exported API (`commands/upload.mjs`)

| Export | Signature | Notes |
| --- | --- | --- |
| `default upload` | `(args: string[], context?: object) => Promise<data>` | Without `context` it throws `NOT_IMPLEMENTED` and does no I/O. |
| `runUpload` | `(args, { signal, core, validator, onProgress, credentials = readAccessToken, clientFactory = uploadClient, baseUrl = DEFAULT_BASE_URL, cwd = process.cwd(), now })` | `credentials`, `clientFactory`, `baseUrl` and `cwd` exist for tests only. Production wiring should pass only `signal`, `core`, `onProgress` and, optionally, `validator`. |
| `parseUploadArgs`, `resolveMetadata`, `buildDraftBody`, `verifyUpload` | pure helpers | |

Success `data`:

```json
{ "status": "draft_created", "published": false,
  "content": { "id": "cnt_…", "status": "draft" },
  "package": { "format": "zwf|zip", "entry_point": "index.html", "file_count": 2, "size_bytes": 904, "sha256": "<hex>", "version": "1.0.0", "validator": "zukujs-builtin" },
  "upload": { "url": "/uploads/YYYY-MM/<id>.zwf", "verified": true },
  "verification": { "performed": false },
  "receipt": { "saved": true, "path": ".zukujs/receipts/zukujs-upload-…receipt.json" } }
```

When `--verify` is given, `verification` becomes `{ performed: true, owner_visible, status }`. If the receipt could not be written, `receipt` becomes `{ saved: false, state, upload_url, content_id, package_sha256 }`.

Error codes:

- **Local, with no credentials or network used:**
  - `INVALID_INPUT` (exit 2)
  - `UPLOAD_INPUT_UNSAFE`
  - `UPLOAD_INPUT_TOO_LARGE`
  - `PACKAGE_INVALID`, where `reason` is one of `zip_*` / `zwf_*` / `validator_*` / `public_validator_rejected` / `packager_output`
  - `UPLOAD_METADATA_INVALID`, where `reason` is one of `title`, `description`, `tags`, `age_rating`, `game_id`, `genre`, `version`, `platform`
  - `UPLOAD_PACKAGER_UNAVAILABLE`
  - `UPLOAD_RECEIPT_UNSAFE`
  - `UNAUTHORIZED` (no token)
  - `COMMAND_CANCELLED` (exit 130)
- **Transport and response:**
  - `API_ORIGIN_REJECTED`
  - `API_UNAVAILABLE`: the connection was never established, so no receipt is written.
  - `API_REDIRECT_REJECTED`
  - `API_RESPONSE_INVALID`
  - `UPLOAD_OUTCOME_UNKNOWN`
  - `UPLOAD_RECEIPT_MISMATCH`
  - `DRAFT_OUTCOME_UNKNOWN`
  - `DRAFT_STATE_UNEXPECTED`
  - `API_REQUEST_FAILED`: the remote code was unknown. The HTTP status is still reported.
- **Public API codes, passed through only from an allowlist:**
  - `BAD_REQUEST`
  - `UNSAFE_PACKAGE`
  - `INVALID_PACKAGE`
  - `UNAUTHORIZED`
  - `FORBIDDEN`
  - `ACCOUNT_SUSPENDED`
  - `GAME_UPLOAD_UNSUPPORTED`
  - `CSRF_REJECTED`
  - `NOT_FOUND`
  - `PAYLOAD_TOO_LARGE`
  - `UNSUPPORTED_MEDIA_TYPE`
  - `VALIDATION_ERROR` (`fields` holds field names only)
  - `MALWARE_DETECTED`
  - `RATE_LIMITED`
  - `INTERNAL_ERROR`
  - `STORAGE_UNAVAILABLE`
  - `UPLOAD_UNAVAILABLE`
- **Additional error keys:** `reason`, `stage` (`validate|package|metadata|upload|draft|verify`), `http_status`, `fields` and `receipt`.
- **Receipt `state` values:**
  - `upload_outcome_unknown`
  - `upload_unverified`
  - `draft_not_attempted`
  - `draft_rejected`
  - `draft_outcome_unknown`
  - `draft_unexpected_state`
  - `draft_created`
- **Ambiguous outcomes.** Responses of 5xx or 408 are treated as ambiguous, so a receipt is written and nothing is retried.

New codes are defined in `lib/upload-errors.mjs` (`UploadError extends CommandError`). If the coordinator moves them into `lib/errors.mjs`, keep the same code strings.

## 6. Behaviour summary (for the README)

- **Local checks first.** These run in order:
  1. Argument parsing.
  2. An input `lstat` that rejects symlinks.
  3. A bounded single read.
  4. The strict ZWF2/ZIP validator.
  5. Draft metadata rules.
  6. A multipart length check of ≤ 524,288,000 bytes.
  7. Receipt directory safety.

  Only then is the user Bearer token read.
- **Exactly one `POST /api/v1/uploads`.** The request carries one `file` part, `game.zwf` or `game.zip`, and an exact `Content-Length`. There are no cookies, no redirects and no retries.
- **The upload response is verified.** The client checks status 201, `kind`, `mime`, `size`, `sha256`, `package.format`, `entry_point`, `scan=clean` and `file_count`. The URL must be `/uploads/YYYY-MM/<id>.(zwf|zip)` on the configured origin.
- **Exactly one `POST /api/v1/contents`.** The client sends `category=jump` and `jump.status=draft` with `publish_to_thread=false`, and the response must report `data.content.jump.status == "draft"`. Publish is never called.
- **`--verify` adds one owner `GET /api/v1/contents/{id}`.**
- **Receipts.** A receipt is written to `.zukujs/receipts/zukujs-upload-<UTC>-<random>.receipt.json` with mode 0600, using O_EXCL and O_NOFOLLOW so it never overwrites or follows links. It is written on success and after any failure that occurs once the upload request has been sent (outcome unknown, mismatch, draft rejected or unknown, unexpected state). Definite pre-acceptance rejections write no receipt.
