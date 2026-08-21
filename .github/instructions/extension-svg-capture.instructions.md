---
description: "Use when changing the SVG capture utility Chrome extension (syntax-only validation, no integration tests)."
applyTo: "extensions/chrome-svg-capture-extension/**"
---
# SVG Capture Extension

- Keep changes minimal and domain-scoped.
- Keep browser-facing messages clear and actionable.
- Do not include secrets or environment tokens in fixtures, tests, or docs.

## Validation

- Run `just extension-syntax` (this component has no integration test suite).
