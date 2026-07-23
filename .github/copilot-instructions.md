# Copilot Instructions for InvenTree Inventory Platform

## Repository Shape

This repository is a multi-component workspace:

- `extensions/chrome-multi-site-inventree-export`: Chrome extension with Playwright integration tests.
- `extensions/chrome-svg-capture-extension`: Utility Chrome extension with syntax-only validation.
- `plugins/inventree-multi-site-importer`: InvenTree plugin with Python unittest coverage and wheel build checks.
- `scripts`: Shared maintenance scripts, including secret scanning.

Prefer focused, component-scoped changes. Do not perform broad cross-component refactors unless requested.

## Validation Requirements

Run validation from repository root according to scope:

- Extension capture changes: `just extension-syntax` and `just extension-test`
- Plugin changes: `just plugin-test`, `just plugin-compile`, and `just plugin-build`
- Mixed or uncertain scope: `just check`

If dependencies are not installed on a clean machine, run `just ci`.

## Artifact and Output Rules

- Generated outputs belong in `.artifacts/` only.
- Never commit generated artifacts, captured data dumps, keys, or transient build output.
- Follow `ARTIFACTS.md` for output locations and sensitive file handling.

## Security and Secrets

- Run `just security-scan` when touching integration, auth, config, or export logic.
- Never introduce provider tokens, private keys, or credential assignments in tracked files.

## Documentation and Tests

- When behavior changes, update relevant docs (`README.md`, component README, or `CONTRIBUTING.md`).
- Add or update tests whenever behavior changes.
- Keep pull requests scoped and include testing notes.

## Safe Editing Expectations

- Preserve existing action pinning and CI structure unless explicitly asked.
- Avoid unrelated reformatting and file churn.
- Keep changes minimal, readable, and easy to review.