# InvenTree Inventory Platform

Monorepo for inventory-capture and import tooling centered on InvenTree integration.

## Repository Components

- `extensions/chrome-multi-site-inventree-export/`
  - Browser capture extension for supplier pages.
  - Queues normalized raw captures to the InvenTree importer plugin.
- `plugins/inventree-multi-site-importer/`
  - InvenTree plugin for capture ingestion, field inspection, mapping profiles, and import planning.
- `extensions/chrome-svg-capture-extension/`
  - Utility extension for domain-based SVG/image capture workflows.
- `scripts/`
  - Shared maintenance scripts (for example secret scanning).

## Validation

Run repository checks from the root:

```powershell
just check
```

For first-time setup on a clean machine:

```powershell
just ci
```

## VS Code Workspace

Use the shared workspace file to keep a consistent IDE layout and test/editor settings across contributors:

- `inventree-inventory-platform.code-workspace`

It groups components by type (extensions, plugin, scripts) and includes recommended extensions plus baseline editor/test settings.

## Artifacts

Generated outputs are stored under `.artifacts/` and are excluded from source control. See `ARTIFACTS.md` for layout and handling guidance.
