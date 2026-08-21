# AGENTS Guide

This file defines repository standards for AI coding agents.

## Goals

- Keep changes component-scoped and reviewable.
- Enforce repository validation before proposing completion.
- Protect artifact boundaries and prevent secret leakage.

## Project Structure

Component-scoped rules and validation commands auto-attach from `.github/instructions/` when a file in that component is edited; consult them directly if you need the full detail without editing first.

- `extensions/chrome-multi-site-inventree-export`: primary capture extension. See [.github/instructions/extension-capture.instructions.md](.github/instructions/extension-capture.instructions.md).
- `extensions/chrome-svg-capture-extension`: SVG capture utility extension. See [.github/instructions/extension-svg-capture.instructions.md](.github/instructions/extension-svg-capture.instructions.md).
- `plugins/inventree-multi-site-importer`: InvenTree importer plugin. See [.github/instructions/plugin-importer.instructions.md](.github/instructions/plugin-importer.instructions.md).
- `scripts`: repo-level maintenance scripts. See [.github/instructions/scripts.instructions.md](.github/instructions/scripts.instructions.md).

## Validation

- Mixed changes, shared tooling updates, or uncertain scope: `just check`.
- Use `just ci` on first setup when dependencies are missing.

## Rules and Boundaries

- Do not commit generated outputs from `.artifacts/`.
- Do not commit secrets, keys, or captured sensitive data.
- Respect existing CI action pinning unless update is requested.
- Avoid broad refactors and formatting-only edits unless requested.

## Documentation Expectations

- Update docs when setup, behavior, or workflows change.
- Include concise testing notes in pull request summaries.

## Reference Files

- `.github/copilot-instructions.md`
- `CONTRIBUTING.md`
- `ARTIFACTS.md`
- `justfile`