# AGENTS.md

Guidance for AI agents working in this repository.

## Repository Structure

```
chrome_extensions/
├── chrome-multi-site-inventree-export/   # Extension: capture supplier catalog data and export/sync to InvenTree
│   ├── manifest.json
│   ├── background.js                     # Service worker (module)
│   ├── popup.html / popup.js             # Extension popup UI
│   ├── package.json                      # Node/Playwright test dependencies
│   ├── playwright.config.js
│   └── tests/
│       └── extension.integration.spec.js # Playwright integration tests
├── chrome-svg-capture-extension/         # Extension: capture image assets from browsed pages
│   ├── manifest.json
│   ├── background.js
│   ├── popup.html / popup.js
│   └── README.md
├── .github/
│   ├── workflows/integration-tests.yml   # CI: runs Playwright tests on Ubuntu and Windows
│   └── ISSUE_TEMPLATE/
├── justfile                              # Workspace-level automation (PowerShell-based)
├── CONTRIBUTING.md
└── AGENTS.md
```

## Extensions Overview

### chrome-multi-site-inventree-export
Captures product table rows from supplier catalog pages (McMaster-Carr, Bolt Depot, Amazon Orders) and lets the user export them as JSON/CSV or sync them to an InvenTree instance. The extension uses Manifest V3 with a service worker (`background.js`) and a popup UI. All settings are persisted via `chrome.storage.local`.

### chrome-svg-capture-extension
Captures image assets (SVG, PNG, JPEG, and others) from pages a user browses. Organizes downloaded files into domain-based subfolders under Chrome's configured download location. No test suite; no Node dependencies.

## Development Setup

Only `chrome-multi-site-inventree-export` has automated tests. All commands below run from that subdirectory unless stated otherwise.

```bash
cd chrome-multi-site-inventree-export
npm ci
npx playwright install chromium
```

On Linux, also install browser system dependencies:

```bash
npx playwright install-deps chromium
```

## Running Tests

Integration tests launch a real Chromium instance with the extension loaded.

```bash
# From chrome-multi-site-inventree-export
npm run test:integration

# Headed (explicit, same as default since headless is disabled in config)
npm run test:integration:headed
```

On Linux, wrap with `xvfb-run` (as CI does):

```bash
xvfb-run --auto-servernum npm run test:integration
```

From the workspace root using `just` (Windows PowerShell):

```bash
just ci-install   # npm ci + playwright install chromium
just ci-test      # npm run test:integration
just validate     # alias for ci-test
just ci           # ci-install + ci-test
```

## CI

The workflow at `.github/workflows/integration-tests.yml` runs the integration test suite on both `ubuntu-latest` and `windows-latest` for pushes and pull requests to `main` that touch either extension directory or the workflow file itself.

## Making Changes

### chrome-multi-site-inventree-export

- **Background logic** lives in `background.js` (service worker). It handles `chrome.runtime.onMessage` for `saveSettings`, `getState`, capture, send, and related actions.
- **Popup UI** is driven by `popup.js` and rendered by `popup.html`. Settings panels are `<details>` elements toggled by summary clicks.
- **Tests** in `tests/extension.integration.spec.js` use Playwright and cover popup rendering, settings persistence, validation errors, capture error handling, category fetch, dry-run, and category assignment preview. Always run tests after modifying `background.js`, `popup.js`, or `popup.html`.
- Settings are sanitized in the background handler; invalid `sourceMode` values fall back to `"auto"` and `maxLinkedPages` is capped at `80`.

### chrome-svg-capture-extension

- No automated tests exist for this extension.
- Changes should be manually validated by loading the extension in developer mode.

## Code Conventions

- Plain JavaScript (no build step, no TypeScript, no bundler).
- Manifest V3 — use service workers, not background pages.
- Tests use `@playwright/test` assertions (`expect`). Follow the existing patterns for opening panels (`openDetailsById` helpers) and opening popup pages (`openPopupPage`).
- Do not introduce new runtime dependencies without a strong reason; the extension files are loaded directly by Chrome.

## Pull Request Guidelines

- Branch from `main`.
- Keep changes focused and easy to review.
- Update documentation when behavior or setup changes.
- Include screenshots or GIFs for UI changes.
- Reference related issues with keywords like `Fixes #123`.
- Run `npm run test:integration` (with `xvfb-run` on Linux) before opening a PR.
