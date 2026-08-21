---
description: "Use when changing the InvenTree multi-site importer plugin: views, models, mapping, planning, ai_assistant, migrations, or its tests/build script."
applyTo: "plugins/inventree-multi-site-importer/**"
---
# InvenTree Multi-Site Importer Plugin

- Keep API and capture contract behavior stable unless a change is explicitly requested.
- Preserve migration integrity and packaging inputs.
- Keep import planning and mapping behavior covered by tests when changed.
- Capture endpoints must use user-scoped queryset helpers (`_capture_queryset_for_request`, `_capture_or_404`) to avoid cross-user capture visibility.
- `ai_assistant.py` deterministic matching helpers must stay dependency-free for unittest portability.
- Dynamic AI learning uses persisted decision logs/lexicon entries; views must tolerate missing/migrating tables by handling DB errors and falling back to static behavior.
- Contract tests load plugin modules via `importlib.util.module_from_spec`; avoid `@dataclass` in dynamically loaded helper modules unless registered in `sys.modules` — prefer plain dict return shapes.
- Keep generated wheels under `.artifacts/plugin/` only; never commit build output, temporary package metadata, or credentials.
- `views.py` is a package (`views/`) split by capture-workflow stage (`common.py`, `gallery.py`, `captures.py`, `mapping_profiles.py`, `ai.py`, `import_plan.py`, `creation.py`, `details.py`, `images.py`, `procurement.py`, `health.py`), re-exported via `views/__init__.py`. Add new endpoints to the matching module instead of growing one file; `test_contract.py` patches `views.ai` helpers directly (not the `views` package) since patch targets must match the module where the code actually lives.
- `capture_workspace.html`'s UI logic lives in `static/capture_workspace.js` (loaded via `{% load static %}{% static 'capture_workspace.js' %}`), not inline — keep new client-side logic there so it stays visible to JS tooling. `test_plugin_loading.py` checks JS-content assertions against that file, not the template; add new files to `REQUIRED_WHEEL_FILES` in `scripts/build_plugin.py` if you add another static asset.

## Validation

- Run `just plugin-test`.
- Run `just plugin-compile`.
- Run `just plugin-build` to verify distributable output.
