# AGENTS Guide

This file defines repository standards for AI coding agents.

## Goals

- Keep changes component-scoped and reviewable.
- Enforce repository validation before proposing completion.
- Protect artifact boundaries and prevent secret leakage.

## Project Structure

- `extensions/chrome-multi-site-inventree-export`: primary capture extension.
- `extensions/chrome-svg-capture-extension`: SVG capture utility extension.
- `plugins/inventree-multi-site-importer`: InvenTree importer plugin.
- `scripts`: repo-level maintenance scripts.

## Required Validation by Scope

- For `extensions/chrome-multi-site-inventree-export` changes:
  - `just extension-syntax`
  - `just extension-test`
- For `extensions/chrome-svg-capture-extension` changes:
  - `just extension-syntax`
- For `plugins/inventree-multi-site-importer` changes:
  - `just plugin-test`
  - `just plugin-compile`
  - `just plugin-build`
- For mixed changes or shared tooling updates:
  - `just check`

Use `just ci` on first setup when dependencies are missing.

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