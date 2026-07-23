# Contributing

Thanks for contributing to this repository.

## Workflow

1. Create a branch from `main`.
2. Make focused changes and include tests when behavior changes.
3. Run local checks before opening a pull request.
4. Open a pull request to `main` with a clear summary and testing notes.

## Local Validation

From `chrome-multi-site-inventree-export`:

```bash
npm ci
npx playwright install chromium
npm run validate
```

The InvenTree plugin has dependency-free contract and mapping tests:

```bash
cd inventree-multi-site-importer
python -m unittest discover -s tests -v
python scripts/build_plugin.py --clean
```

CI also installs the plugin package without optional dependencies and compiles all Python sources on Python 3.10 and 3.12.

## Just recipes

With [`just`](https://github.com/casey/just) installed, run common workspace tasks from the repository root:

```powershell
just --list
just extension-install
just extension-test
just plugin-test
just plugin-build
just check
just ci
```

- `just check` runs extension syntax/integration checks, plugin tests, Python compilation, and the verified wheel build.
- `just security-scan` checks source files for common secret material; it is also included in `just check`.
- `just ci` first installs extension dependencies and Chromium, then runs `check`.
- `just plugin-artifact` rebuilds the plugin and prints the resulting wheel path.

The legacy `ci-install`, `ci-test`, and `validate` recipe names remain as aliases.

Generated output locations and signing-key handling are documented in [ARTIFACTS.md](ARTIFACTS.md). Do not add build output or captured data directly to a project source directory.

## Pull Request Expectations

- Keep changes scoped and easy to review.
- Update documentation when behavior or setup changes.
- Reference related issues using keywords like `Fixes #123` when applicable.
- Include screenshots/GIFs for UI changes to popup behavior.

## Commit Guidance

- Use descriptive commit messages.
- Prefer small commits that can be reviewed independently.

## Reporting Issues

Please use the issue templates and include:

- Steps to reproduce
- Expected result
- Actual result
- Browser/OS details
- Relevant logs or screenshots
