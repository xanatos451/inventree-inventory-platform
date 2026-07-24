# Multi-Site Supplier Importer for InvenTree

Server-side companion to the [Multi-Site Inventory Capture Chrome extension](../../extensions/chrome-multi-site-inventree-export/README.md). The extension reads supplier pages; this plugin stores raw captures, exposes field-inspection and mapping tools, and provides the boundary for future inventory writes.

> Current scope: version `0.1.12` queues captures, provides a visual mapping-profile editor with multi-field templates and image galleries, builds read-only import plans against existing InvenTree identifiers, and can explicitly create missing mapped category hierarchies. It deliberately does **not yet create or update InvenTree parts**.

## Requirements

- InvenTree with custom plugin support enabled.
- Python 3.10 or newer when building the package locally.
- An InvenTree administrator for installation and activation.
- The following InvenTree global plugin settings enabled:
  - **Enable URL integration** — required for the plugin API and workspace routes.
  - **Enable app integration** — required for the plugin's capture and mapping-profile database tables.
  - **Check plugins on startup** — recommended for Docker/container deployments.

In the server configuration, custom plugins must also be enabled with either:

```yaml
plugins_enabled: true
```

or the environment variable:

```text
INVENTREE_PLUGINS_ENABLED=true
```

See InvenTree's official [plugin installation guide](https://docs.inventree.org/en/stable/plugins/install/) and [plugin configuration options](https://docs.inventree.org/en/stable/start/config/#plugin-options).

## Build a wheel

Run these commands from `plugins/inventree-multi-site-importer` on a development machine, not inside the browser-extension directory:

```bash
python scripts/build_plugin.py --clean
```

The build script is the canonical packaging command used locally and in CI. It:

1. Builds a platform-independent wheel from `pyproject.toml` with `python -m pip wheel`.
2. Writes it to the repository-level `.artifacts/plugin/` directory by default.
3. Verifies that both migrations and the field-workspace template are present.
4. Prints the wheel path, byte size, and SHA-256 checksum.

Use another output directory inside the plugin project if needed:

```bash
python scripts/build_plugin.py --output-dir ../.artifacts/plugin-candidate
```

Omit `--clean` to retain existing artifacts. The script only permits output below the plugin project or the workspace `.artifacts` directory and never deletes either project root.

The distributable artifact is created under the consolidated repository output directory:

```text
.artifacts/plugin/inventree_multi_site_importer-0.1.12-py3-none-any.whl
```

Before distributing it, run:

```bash
python -m unittest discover -s tests -v
python scripts/build_plugin.py --clean
```

The wheel includes the Django models, migrations, API views, and field-workspace template.

GitHub Actions runs the same script and publishes the Python 3.12 build as the `inventree-multi-site-importer-wheel` workflow artifact for 14 days.

From the repository root, the equivalent convenience commands are:

```powershell
just plugin-test
just plugin-build
just plugin-artifact
```

Run `just check` to test both the extension and plugin and produce the wheel, or `just ci` on a fresh checkout to install extension dependencies first.

## Installation options

### Option A: install from Git with `plugins.txt` (recommended during development)

Once the repository is available from your InvenTree server, add a pinned VCS requirement to InvenTree's `plugins.txt`:

```text
inventree-multi-site-importer @ git+https://github.com/xanatos451/inventree-inventory-platform.git@<commit-or-tag>#subdirectory=plugins/inventree-multi-site-importer
```

Replace `<commit-or-tag>` with a release tag or commit hash. Pinning prevents an unreviewed branch update from being installed automatically.

Run InvenTree's plugin installation command from its normal environment:

```bash
invoke plugins
```

Then run the deployment's normal InvenTree update/migration process:

```bash
invoke update
```

Finally restart both the InvenTree web server and background worker. InvenTree discovers plugins at process startup.

### Option B: install a wheel with `plugins.txt`

Copy the wheel to a persistent path that is visible inside the InvenTree server and worker environments. Add a PEP 508 file requirement to `plugins.txt`:

```text
inventree-multi-site-importer @ file:///absolute/path/visible/to/inventree_multi_site_importer-0.1.12-py3-none-any.whl
```

For Docker, the wheel must be placed in a bind-mounted or persistent data path and the path in `plugins.txt` must be the path **inside the container**, not the host-only path. Run `invoke plugins`, the normal update/migration process, and restart the server and worker.

### Option C: install through the InvenTree web interface

As an InvenTree superuser:

1. Open **Admin → Plugin Settings**.
2. Choose the plugin installation action.
3. Enter package name `inventree-multi-site-importer`.
4. Supply a reachable VCS source or package source. For this monorepo, use the Git URL with `#subdirectory=plugins/inventree-multi-site-importer` shown above.
5. Confirm installation.
6. Run the normal update/migration process if your deployment does not do so automatically.
7. Restart both server and worker processes.

The web installer is available only to superusers and may be disabled with `INVENTREE_PLUGIN_NOINSTALL`.

### Option D: local source directory (development only)

InvenTree can discover source under its external plugin directory. With the standard Docker setup, this is the `plugins/` directory inside the persistent InvenTree data volume. Copy the `inventree_multi_site_importer` Python package there and restart InvenTree.

This is useful for development but InvenTree recommends pip-based installation for production because upgrades and dependencies are repeatable.

## Activate and initialize

After installation and restart:

1. Sign in as an InvenTree administrator.
2. Open **Admin → Plugin Settings**.
3. Find **Multi-Site Supplier Importer** (`multi-site-importer`).
4. Activate it.
5. Confirm **Enable URL integration** and **Enable app integration** are enabled in global plugin settings.
6. Restart the web server and worker once more if prompted or if the routes do not appear.
7. Confirm the database migrations `0001_initial` and `0002_capture_profiles` were applied by checking the update output and server logs.

Test the authenticated health endpoint:

```bash
curl -H "Authorization: Token YOUR_TOKEN" \
  https://inventree.example.com/plugin/multi-site-importer/health/
```

Expected response:

```json
{"ok": true, "contract_version": "1.0"}
```

An HTTP `401` or `403` indicates an authentication/permission issue. An HTTP `404` normally means the plugin is inactive, URL integration is disabled, the server was not restarted, or the mounted route differs in your InvenTree version.

## Create an extension API token

Create or select an InvenTree user for browser capture submission and generate an API token for that user. A dedicated, low-privilege account is preferable to reusing a superuser token.

The current capture endpoint requires an authenticated InvenTree user. The token is sent as:

```text
Authorization: Token YOUR_TOKEN
```

The extension stores its connection settings in Chrome local extension storage. Treat the token as a credential and do not share browser profiles containing it.

## Configure the Chrome extension

Open the extension's **InvenTree plugin connection** panel and enter:

- **InvenTree base URL:** `https://inventree.example.com`
- **API token:** the token created above
- **Capture endpoint:** `/plugin/multi-site-importer/captures/`

Save the connection settings. The base URL should not include the endpoint path.

## Day-to-day use

1. Open a supported supplier page.
2. Select the supplier or leave **Auto Detect** enabled.
3. Choose an exporter profile:
   - `auto` detects a list/table or individual-product page.
   - `list-details` follows product links and enriches each list row.
   - `single-item` exports only the current product page.
4. On a list view, optionally preview product links and select a subset.
5. Select **Capture Current Page**.
6. Review the raw capture preview.
7. Select **Submit to Import Queue**.
8. Select **Open Import Field Workspace** after submission.

The workspace includes a visual mapping-profile editor and the detailed source-field catalog. Choose source fields for standard targets, add parameter mappings for `Spec_*` fields, optionally enter extraction regexes, and select **Preview Mapping** for an immediate transformation preview. Previewing and saving profiles do not modify inventory.

To create a profile visually:

1. Enter a profile name and confirm its source, capture-profile, and page-type scope.
2. Map standard targets such as part number, name, category, variant, notes, primary image URL, and product image gallery. Choose **Template** to combine fields, for example `{ProductDetailPageTitle} — {ProductDetailVariant}`.
3. Select **Add Parameter Mapping** for each desired InvenTree parameter. Enter the future parameter name and select its captured source field.
4. Use the sample-result column to confirm the first-row value and add a regex only when extraction is needed.
5. Select **Preview Mapping** and review up to 20 transformed rows.
6. Select **Save Profile**.

Saved profiles matching the capture scope appear in the profile selector. Load one to edit it, save changes in place, start a new profile, or delete an obsolete profile. The source-field catalog remains available below the editor for coverage, distributions, filtering, and row context.

Mapped `image_url` values using HTTP(S) and a common raster extension (`png`, `jpg`, `jpeg`, `gif`, `webp`, `bmp`, or `avif`) are shown as lazy-loaded thumbnails in both the live preview and import plan. Each thumbnail links to the original image. Other URL and file types remain text links and are not embedded. Previewing does not download an image into InvenTree storage.

## Build a read-only import plan

After previewing a mapping, select **Build Import Plan**. The planner maps every captured row and performs read-only exact identifier checks against:

- InvenTree `Part.IPN`
- InvenTree `SupplierPart.SKU`

Each row is classified as:

- `create` — no existing exact identifier match was found.
- `update` — one unambiguous existing part or supplier-part match was found.
- `conflict` — the capture repeats a part number or the identifier matches multiple existing records.
- `error` — required mapped data is missing or invalid.

The plan also resolves mapped category/subcategory chains against `PartCategory`, reports unmapped categories as warnings, validates every primary and gallery image URL, counts `parameter.*` mappings, and shows existing record IDs. A missing or ambiguous mapped category path is an error. Planning performs no database writes and does not download images. A plan is marked ready only when it contains no conflicts or errors.

Map the captured `Image URL` field to **Primary Image URL** (`image_url`) and `Image URLs` to **Product Image Gallery** (`image_urls`). Gallery input may be a newline-delimited value or a JSON array. The mapper converts it to an ordered, deduplicated list, places the mapped primary image first, and promotes the first gallery image to primary when no separate primary mapping is configured. The normalized list is retained in previews and import plans for future part-image and attachment writes.

If one or more mapped paths are missing, the workspace enables **Create Missing Categories**. Review the paths shown by the plan and confirm the prompt. The plugin creates only the absent hierarchy segments, reuses existing segments, and then rebuilds the read-only plan. A persistent result panel lists each created and reused category with its database ID and confirms whether every mapped path was resolved. The signed-in user must have InvenTree's native **Part Category: Add** role permission; the plugin checks this through InvenTree's role-aware permission system. This action does not create or update parts.

For example, these mappings:

```text
Category: Fasteners
Subcategory: Screws and Bolts > Flat Head Screws
```

produce the hierarchy `Fasteners > Screws and Bolts > Flat Head Screws`. If `Fasteners` already exists, only its missing descendants are created.

## Mapping profiles

Multiple profiles can coexist for a supplier. A profile can be scoped by `source`, `capture_profile`, `page_type`, `host_pattern`, and `path_pattern`, and ordered by `priority`.

Create a profile with the authenticated API:

```bash
curl -X POST \
  -H "Authorization: Token YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  https://inventree.example.com/plugin/multi-site-importer/mapping-profiles/ \
  -d '{
    "name": "McMaster list products",
    "source": "mcmaster-carr",
    "capture_profile": "list-details",
    "page_type": "category-table",
    "priority": 100,
    "rules": {
      "name": {"source_field": "Product", "regex": ""},
      "thread_size": {"source_field": "ProductDetailThreadSize", "regex": ""},
      "material": {"source_field": "Material", "regex": "^([^,]+)"}
    }
  }'
```

Preview a stored profile against capture `42`:

```bash
curl -X POST \
  -H "Authorization: Token YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  https://inventree.example.com/plugin/multi-site-importer/captures/42/preview/ \
  -d '{"profile": 3}'
```

The mapping rule shape is:

```json
{
  "target_field": {
    "source_field": "Captured Field Name",
    "regex": "optional extraction expression"
  }
}
```

If the regular expression contains a capture group, group 1 becomes the mapped value. Otherwise the complete match is used.

A template rule safely combines multiple captured fields:

```json
{
  "name": {
    "template": "{ProductDetailPageTitle} — {ProductDetailVariant}",
    "regex": ""
  }
}
```

Placeholders use exact captured field names. Missing fields become empty strings. Optional regex extraction runs after the template has been rendered. Templates perform substitution only; they do not execute Python or JavaScript.

## API reference

All routes require normal InvenTree authentication and are mounted under:

```text
/plugin/multi-site-importer/
```

| Method | Route | Purpose |
|---|---|---|
| `GET` | `health/` | Verify plugin routing and authentication |
| `GET`, `POST` | `captures/` | List or submit raw captures |
| `GET` | `captures/{id}/` | Retrieve a queued capture |
| `GET` | `captures/{id}/workspace/` | Open the human-readable field workspace |
| `GET` | `captures/{id}/fields/` | Retrieve the field catalog |
| `GET` | `captures/{id}/fields/?field=Material` | Inspect one field in row context |
| `POST` | `captures/{id}/preview/` | Preview rules or a stored mapping profile |
| `POST` | `captures/{id}/plan/` | Build a read-only import plan against existing identifiers |
| `POST` | `captures/{id}/categories/` | Explicitly create missing mapped category paths (`confirm: true` required) |
| `GET`, `POST` | `mapping-profiles/` | List or create mapping profiles |
| `GET`, `PATCH`, `PUT`, `DELETE` | `mapping-profiles/{id}/` | Retrieve, edit, or delete one mapping profile |

The mapping-profile list accepts `source`, `capture_profile`, and `page_type` query filters.

## Plugin setting

`MAX_CAPTURE_ROWS` defaults to `5000`. Captures beyond this limit are rejected. Change it from the plugin settings page if necessary, considering request size, database capacity, and field-workspace performance.

## Upgrade

1. Back up the InvenTree database and persistent data.
2. Build or obtain the new wheel, or update the pinned VCS tag/commit in `plugins.txt`.
3. Run `invoke plugins`.
4. Run the normal InvenTree update/migration process (`invoke update` in standard installations).
5. Restart both server and worker.
6. Check plugin registry and migration errors before submitting new captures.

## Uninstall

Deactivating or uninstalling a plugin with `AppMixin` does not automatically mean its database tables and capture data should be deleted. Before uninstalling:

1. Back up the database.
2. Export any captures or mapping profiles you need.
3. Deactivate the plugin.
4. Remove its entry from `plugins.txt` or uninstall the package.
5. Restart server and worker.

Do not manually drop plugin tables unless you intentionally want to destroy queued captures and mapping profiles and have verified the exact migration state.

## Troubleshooting

- **Plugin is not listed:** confirm `plugins_enabled`, package installation, and restart both server and worker.
- **Registry import error:** inspect server startup logs; confirm the installed wheel matches your InvenTree/Python version.
- **404 on plugin endpoints:** activate the plugin and enable URL integration.
- **Database-table errors:** enable app integration and run the normal InvenTree migrations/update.
- **401/403 from the extension:** regenerate the token and confirm the user is active.
- **Capture rejected as too large:** adjust `MAX_CAPTURE_ROWS` or lower the extension's item-detail limit.
- **Workspace HTML is missing after wheel installation:** confirm package data was included in the wheel and reinstall the current package version.
- **Docker loses the plugin after restart:** use persistent `plugins.txt`, enable **Check plugins on startup**, and verify the external data volume is mounted correctly.

Official references: [Installing Plugins](https://docs.inventree.org/en/stable/plugins/install/), [Docker Plugins](https://docs.inventree.org/en/stable/start/docker/#plugins), [Global Plugin Settings](https://docs.inventree.org/en/stable/settings/global/#plugin-settings).

## Development tests

```bash
python -m unittest discover -s tests -v
python -m compileall -q inventree_multi_site_importer
```
