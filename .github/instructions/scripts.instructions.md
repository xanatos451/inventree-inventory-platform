---
description: "Use when changing shared maintenance scripts such as the secret scanner in scripts/."
applyTo: "scripts/**"
---
# Shared Scripts

- Keep scripts dependency-light and cross-platform where practical.
- Favor deterministic checks with clear failure messages.
- Never log secrets in plain text; keep secret-detection patterns conservative to avoid false negatives.

## Validation

- If script behavior changed, run the relevant script directly.
- For repository-wide impact, run `just check`.
