# Vendored @zuku/zwf

- Source: https://github.com/zukuapp/zwf (`src/format.mjs`, `LICENSE`)
- Commit: `ac091fb8d24ef247e631d723c0d93f54c58bbde5`
- License: MIT, Copyright (c) 2026 ZUKU (see `LICENSE` in this directory)
- `format.mjs` SHA-256: `41f2a4fc79b125af6cdd7c0b1166818ce8ba1c8b227719fd237ca9c7c2f8a275`
- Modifications: none. The file is byte-identical to upstream; it imports `fflate`,
  pinned to `0.8.3` exactly as upstream `package.json` does.
- Reason: `@zuku/zwf` is not published to the npm registry (`npm view @zuku/zwf` → 404 on 2026-10-03).
  Replace this copy with the registry package once it is published.
