---
description: "Use when changing the multi-site InvenTree capture Chrome extension: background/popup scripts, manifest, or Playwright integration tests."
applyTo: "extensions/chrome-multi-site-inventree-export/**"
---
# Multi-Site Capture Extension

- Keep changes minimal and domain-scoped; preserve capture contract compatibility unless explicitly asked to change it.
- Keep browser-facing messages clear and actionable.
- Do not include secrets or environment tokens in fixtures, tests, or docs.
- Do not add generated Playwright output (reports, traces, `.pem` keys) to this directory; it belongs under `.artifacts/` (see [ARTIFACTS.md](../../ARTIFACTS.md)).
- `background.js` is a thin ES-module entry point; feature code lives under `background/` (`storage.js`, `csv-import.js`, `capture-orchestration.js`, `site-captures.js`, `mapping.js`, `scrapers/*.js`). Add new logic to the matching module instead of growing `background.js`.
- ESLint (`no-unused-vars`, `max-lines`, `max-lines-per-function`) guards against orphaned/dead code and monolithic files regrowing — fix lint findings rather than suppressing them.

## Validation

- Always run `just extension-syntax` (includes `npm run lint`).
- For behavior changes, also run `just extension-test`.
