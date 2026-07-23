# SVG Domain Capture (Chrome Extension)

Captures image assets from pages you open and stores them in domain-based subfolders.

The extension also attempts to infer a human-readable name from the page reference
that points to the image (for example: `alt`, `title`, `aria-label`, and nearby link text)
and prepends that label to downloaded file names when available.

## What It Captures

- Network image URLs requested while browsing (`.../network/...`)
- Inline SVG elements on fully loaded pages (`.../inline/...`)
- DOM-discovered image URLs from page elements (`.../dom/...`)
- HTML/script/performance-discovered asset URLs (`.../dom/...`)
- Extension-fetched page source URL discovery (`.../source/...`)

Supported selectable network file types:

- `svg`, `png`, `jpg`, `jpeg`, `gif`, `webp`, `avif`, `bmp`, `ico`, `tif`, `tiff`

## Domain Filters

- `Allowlist mode` off: capture all domains except denylisted domains.
- `Allowlist mode` on: capture only allowlisted domains, then remove any denylisted domains.
- Rules are domain-based and support root or subdomain matching.
  - `mcmaster.com` matches `www.mcmaster.com` and subdomains.
- If allowlist mode is enabled but no allowlist domains are set, capture falls back to all domains (denylist still applies).

Enter one domain per line in the popup.

## Folder Layout

Chrome extensions can only save under Chrome's configured download location.
This extension writes files as:

- `<download_dir>/<rootFolder>/<primary-domain>/network/<imageType>/...`
- `<download_dir>/<rootFolder>/<primary-domain>/dom/<imageType>/...`
- `<download_dir>/<rootFolder>/<primary-domain>/source/<imageType>/...`
- `<download_dir>/<rootFolder>/<primary-domain>/inline/svg/...`

Default `rootFolder` is `svg-capture`.

`rootFolder` is configurable in the popup.

## To Save Into Images/Pictures

Set Chrome download location to your Pictures/Images folder:

1. Chrome Settings
2. Downloads
3. Change Location

Then extension files will be saved under that folder automatically.

Note: Chrome extensions cannot pick an arbitrary absolute folder path directly.
The extension controls the folder path relative to Chrome's configured download directory.

## Install (Developer Mode)

1. Open `chrome://extensions`
2. Enable Developer mode
3. Click **Load unpacked**
4. Select this folder: `extensions/chrome-svg-capture-extension`

## Notes

- Domain grouping is based on a best-effort primary-domain parser.
- Some pages block script injection; inline capture may skip those pages.
- Browser or site policy can still block certain asset downloads.

## Troubleshooting

If files are not appearing:

1. Reload the extension in `chrome://extensions`.
2. Open the extension popup and click `Refresh Capture Stats`.
3. Check whether `attempted` increases while browsing image-heavy pages.
  - You can also use `Capture Current Page Inline SVG Now` and read per-run totals in the status line.
4. If `failed` increases, inspect `lastError` in the popup.
5. Ensure Chrome setting `Ask where to save each file before downloading` is disabled.
