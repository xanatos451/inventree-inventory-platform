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
npm run test:integration
```

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
