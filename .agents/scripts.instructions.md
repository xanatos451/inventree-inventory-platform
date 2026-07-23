# Scripts Rules

Scope:

- `scripts`

## Expectations

- Keep scripts dependency-light and cross-platform where practical.
- Favor deterministic checks with clear failure messages.

## Validation

- If script behavior changed, run the relevant script directly.
- For repository-wide impact, run `just check`.

## Safety

- Never log secrets in plain text.
- Keep secret-detection patterns conservative to avoid false negatives.