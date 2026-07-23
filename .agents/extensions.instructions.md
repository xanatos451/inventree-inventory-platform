# Extensions Rules

Scope:

- `extensions/chrome-multi-site-inventree-export`
- `extensions/chrome-svg-capture-extension`

## Expectations

- Keep changes minimal and domain-scoped.
- Preserve capture contract compatibility unless explicitly asked to change it.
- Keep browser-facing messages clear and actionable.

## Validation

- Always run `just extension-syntax`.
- For multi-site capture extension behavior changes, run `just extension-test`.

## Safety

- Do not include secrets or environment tokens in fixtures, tests, or docs.
- Do not add generated Playwright output to source directories.