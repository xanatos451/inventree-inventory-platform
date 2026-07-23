# Local artifacts and generated data

Generated packages, reports, signed extension bundles, and local output belong under the repository-level `.artifacts/` directory. The entire directory is ignored by Git.

```text
.artifacts/
├── extension/             # CRX packages and private signing keys
├── playwright/
│   ├── report/            # Current HTML report
│   ├── test-results/      # Traces, screenshots, and failure context
│   ├── legacy-report/     # Report moved from the former project-local path
│   └── legacy-test-results/
└── plugin/                # Verified InvenTree plugin wheels
```

## What stays project-local

- `node_modules/` remains beside the extension `package.json`, because Node resolves dependencies from that location. It is ignored.
- Python `__pycache__/`, `build/`, `dist/`, and `*.egg-info/` directories are transient and ignored. The plugin build script removes its normal `build/` and egg-info output after packaging.
- Playwright browser binaries remain in Playwright's user cache rather than the repository.

## Sensitive files

The extension `.pem` file is a private signing key. Keep it only in `.artifacts/extension/` or another protected secret store. Never commit, publish, attach, or send it with the CRX. Losing it prevents future updates from retaining the same extension identity; exposing it lets another party sign packages with that identity.

## Commands

```powershell
just plugin-build      # .artifacts/plugin/*.whl
just extension-test    # .artifacts/playwright/...
just check             # tests both components and produces the wheel
```

CI uploads selected artifacts explicitly; it does not commit `.artifacts/`.

Run `just security-scan` before committing. CI runs the same dependency-free scan and rejects private-key markers, secret-bearing filenames, credential assignments, and common provider-token formats.
