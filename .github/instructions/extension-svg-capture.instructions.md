---
description: "Use when changing the SVG capture utility Chrome extension (syntax-only validation, no integration tests)."
applyTo: "extensions/chrome-svg-capture-extension/**"
---
# SVG Capture Extension

- Keep changes minimal and domain-scoped.
- Keep browser-facing messages clear and actionable.
- Do not include secrets or environment tokens in fixtures, tests, or docs.
- ESLint (`no-unused-vars`, `max-lines`/`max-lines-per-function`) guards against dead code and file growth — fix lint findings rather than suppressing them. No integration tests exist here, so be extra conservative about behavior changes.

## Validation

- Run `just extension-syntax` (includes `npm run lint`; this component has no integration test suite).
