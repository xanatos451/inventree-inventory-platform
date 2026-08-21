// Builds the raw JSON/CSV export payloads sent to the plugin or downloaded locally.
export function buildExportFilename(format) {
  const ts = new Date().toISOString().replace(/[:]/g, "-").replace(/\..+$/, "");
  return `product-inventory-export/${ts}-captured-catalog.${format}`;
}

export function buildRawCapture(capture) {
  return {
    contract_version: "1.0",
    capture_profile: String(capture?.captureProfile || "auto"),
    source: String(capture?.source || "unknown"),
    page_type: String(capture?.pageType || ""),
    captured_at: capture?.capturedAt || new Date().toISOString(),
    page_title: String(capture?.pageTitle || ""),
    page_url: String(capture?.pageUrl || ""),
    headers: Array.isArray(capture?.headers) ? capture.headers : [],
    rows: Array.isArray(capture?.rows) ? capture.rows : [],
    pages_scraped: Number(capture?.pagesScraped || 1)
  };
}

export function buildRawCaptureCsv(capture) {
  const raw = buildRawCapture(capture);
  const headers = raw.headers.length
    ? raw.headers
    : Array.from(new Set(raw.rows.flatMap((row) => Object.keys(row || {}))));
  const lines = [headers.map(csvEscape).join(",")];
  for (const row of raw.rows) {
    lines.push(headers.map((header) => csvEscape(row?.[header] ?? "")).join(","));
  }
  return lines.join("\n");
}

export function tryParseJson(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return null;
  }
}

function csvEscape(value) {
  const text = String(value || "");
  if (/[,\"\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
