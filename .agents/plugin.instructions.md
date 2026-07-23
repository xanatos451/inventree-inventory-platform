# Plugin Rules

Scope:

- `plugins/inventree-multi-site-importer`

## Expectations

- Keep API and capture contract behavior stable unless change is requested.
- Preserve migration integrity and packaging inputs.
- Keep import planning and mapping behavior covered by tests when changed.

## Validation

- Run `just plugin-test`.
- Run `just plugin-compile`.
- Run `just plugin-build` to verify distributable output.

## Safety

- Keep generated wheels under `.artifacts/plugin/` only.
- Never commit build output, temporary package metadata, or credentials.