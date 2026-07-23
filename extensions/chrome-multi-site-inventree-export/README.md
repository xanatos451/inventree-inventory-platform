# Multi-Site Inventory Capture (Chrome Extension)

This is the browser-side capture companion for the [Multi-Site Supplier Importer InvenTree plugin](../../plugins/inventree-multi-site-importer/README.md).

The extension deliberately does not create or update InvenTree parts. It captures browser-visible supplier data and submits a versioned raw payload to the plugin's import queue. Mapping, validation, category and parameter handling, matching, images, and inventory writes are server-owned concerns.

> Current plugin scope: captures can be queued, inspected, mapped, and previewed. The plugin does not yet create or update parts.

## Prerequisites

Before configuring the extension:

1. Package and install the [InvenTree plugin](../../plugins/inventree-multi-site-importer/README.md#build-a-wheel).
2. Enable custom plugins in the InvenTree server configuration.
3. Activate **Multi-Site Supplier Importer**.
4. Enable InvenTree's **URL integration** and **app integration** global plugin settings.
5. Run InvenTree's normal update/migration process and restart its server and worker.
6. Create a dedicated InvenTree user and API token for capture submission.
7. Verify `/plugin/multi-site-importer/health/` using that token.

For Docker installations, keep the plugin in `plugins.txt` or the persistent plugin directory and enable **Check plugins on startup**. Full commands and alternatives are in the [plugin installation guide](../../plugins/inventree-multi-site-importer/README.md#installation-options).

## Install the Chrome extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Select the `extensions/chrome-multi-site-inventree-export` directory.
5. Pin **Multi-Site Inventory Capture** to the Chrome toolbar if desired.

When distributing a packaged extension, use the release artifact produced by your normal Chrome-extension signing process. Do not include an InvenTree API token in the extension source or package.

## Connect it to InvenTree

Open the extension, expand **InvenTree plugin connection**, and configure:

- **InvenTree base URL:** for example `https://inventree.example.com`
- **API token:** a token belonging to the capture-submission user
- **Capture endpoint:** `/plugin/multi-site-importer/captures/`

Select **Save Connection Settings**. The token is stored in Chrome's local extension storage; treat the browser profile as credential-bearing data.

## Supported sources

- McMaster-Carr category and product pages
- Bolt Depot product tables and parent/child catalog pages
- Amazon order and product pages

## Workflow

1. Install and enable the InvenTree plugin.
2. Configure the InvenTree base URL and a token permitted to submit captures.
3. Browse to a supported supplier page.
4. Optionally preview item links when you want to select a subset.
5. Capture the current page. Table/list pages automatically visit each selected item link for detail enrichment; a single-item page is captured directly.
6. Review the raw preview.
7. Select **Submit to Import Queue**.
8. Select **Open Import Field Workspace**.
9. Inspect field values, coverage, types, common values, and row context.
10. Create or select a mapping profile and preview the transformation in InvenTree.

## Exporter profiles

Each supported site can be captured with more than one traversal profile:

- `auto`: detect whether the current view is a list/table or a single product.
- `list-details`: require a list/table and enrich its product rows from their detail links.
- `single-item`: capture only the current product-detail view.

The effective profile is stored as `capture_profile` in the raw contract. InvenTree can therefore maintain multiple mapping profiles for the same site, scoped by capture profile, page type, host, and path pattern.

The default endpoint is `/plugin/multi-site-importer/captures/`.

List-page category context is retained alongside detail fields using `ProductListPageURL`, `ProductListPageTitle`, and `ProductListBreadcrumbs`. Detail-page taxonomy remains available in the provider detail fields.

The **Maximum item-detail pages** setting is a safety limit. If a table contains more product links than the configured limit, split the capture into selections or increase the limit within the extension's supported range.

McMaster list captures use a focused temporary browser window for product-detail enrichment. The window is reused across products, reports persistent badge progress, and closes automatically after capture.

McMaster detail rows include mapping-friendly `Spec_*` fields in addition to `ProductDetailSpecs`. The parser repairs common supplier-page character-decoding artifacts, removes duplicate breadcrumb labels, ignores placeholder images, and strips McMaster's `ver=ImageNotFound` marker from otherwise valid product-image paths.

## Raw downloads

**Download Raw JSON** preserves the complete capture contract. **Download Raw CSV** writes captured row fields using the union of detected headers. These downloads do not require the plugin and are useful for diagnostics, backups, and schema review.

## Capture contract 1.0

The plugin receives an envelope containing source/page metadata and a `payload` object. The payload contains:

```json
{
  "contract_version": "1.0",
  "capture_profile": "list-details",
  "source": "mcmaster-carr",
  "page_type": "category-table",
  "captured_at": "2026-07-22T12:34:56.000Z",
  "page_title": "Fasteners",
  "page_url": "https://www.mcmaster.com/...",
  "headers": ["Part Number", "Description"],
  "rows": [{ "Part Number": "91251A542", "Description": "..." }],
  "pages_scraped": 1
}
```

JSON and CSV downloads contain raw captured data and remain available as an escape hatch.

## Troubleshooting

- **Unsupported page:** use a supported supplier domain or force the appropriate capture source.
- **Profile requires a list/table:** change exporter profile to `auto` or open a supplier list containing product links.
- **No product details captured:** confirm product links are accessible in the same Chrome profile and reduce the selected set to isolate a failing page.
- **401/403 submitting capture:** verify the InvenTree URL, token, user status, and plugin authentication.
- **404 submitting capture:** activate the plugin, enable URL integration, restart InvenTree, and confirm the endpoint path.
- **Database-table error:** enable app integration and run InvenTree's update/migration procedure.
- **Queued successfully but workspace will not open:** sign in to the same InvenTree server in Chrome; the workspace page uses the normal InvenTree web session.
- **Capture exceeds server limit:** reduce selected items or increase the plugin's `MAX_CAPTURE_ROWS` setting.
- **Plugin disappears after Docker restart:** persist `plugins.txt` or the plugin directory and enable startup plugin checks.

## Security notes

- Prefer HTTPS for any non-loopback InvenTree server.
- Use a dedicated, low-privilege token instead of a superuser token.
- Revoke the token if the Chrome profile or workstation is compromised.
- Review captured supplier data before submission; table and detail pages can contain account- or order-specific information.
- The extension needs supplier-site access and access to the configured InvenTree origin to capture and submit data.

## Development

```bash
npm ci
npx playwright install chromium
npm run validate
```

`validate` runs JavaScript syntax checks and Playwright integration tests. Playwright loads the unpacked extension in Chromium and verifies settings, capture modes, detail enrichment, errors, and the raw plugin submission contract.

From the repository root, `just extension-test` runs the browser suite, `just check` validates both components and builds the plugin wheel, and `just ci` installs extension dependencies before performing the complete check.
