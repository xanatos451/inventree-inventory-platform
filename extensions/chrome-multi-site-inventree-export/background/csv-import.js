// Parses a user-imported CSV/JSON dataset file into a capture object (bypasses page scraping).
function parseImportedCsv(text) {
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  const source = String(text || "").replace(/^\uFEFF/, "");

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\n") {
      record.push(field.replace(/\r$/, ""));
      records.push(record);
      record = [];
      field = "";
    } else {
      field += char;
    }
  }
  if (quoted) throw new Error("CSV contains an unterminated quoted field.");
  if (field || record.length) {
    record.push(field.replace(/\r$/, ""));
    records.push(record);
  }
  const nonEmpty = records.filter((row) => row.some((value) => String(value).trim()));
  if (nonEmpty.length < 2) throw new Error("CSV must contain a header row and at least one data row.");

  const headers = nonEmpty[0].map((value, index) => String(value || "").trim() || `Column ${index + 1}`);
  if (new Set(headers).size !== headers.length) {
    throw new Error("CSV header names must be unique.");
  }
  const rows = nonEmpty.slice(1).map((values) => {
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    return row;
  });
  return { headers, rows };
}

function importedFieldKey(row, expected) {
  const wanted = String(expected || "").trim().toLowerCase();
  return Object.keys(row || {}).find((key) => String(key).trim().toLowerCase() === wanted) || "";
}

function applyImportedFallback(row, field, value) {
  const fallback = String(value || "").trim();
  if (!fallback) return;
  const existingKey = importedFieldKey(row, field);
  if (!existingKey) {
    row[field] = fallback;
  } else if (!String(row[existingKey] ?? "").trim()) {
    row[existingKey] = fallback;
  }
}

export function buildImportedDatasetCapture({ fileName, text, metadata }) {
  const safeName = String(fileName || "imported-dataset").trim().slice(0, 240);
  const contents = String(text || "");
  if (!contents.trim()) throw new Error("The selected dataset file is empty.");
  if (contents.length > 8 * 1024 * 1024) {
    throw new Error("Dataset files are limited to 8 MiB.");
  }

  let input = {};
  let headers = [];
  let rows = [];
  const looksJson = /\.json$/i.test(safeName) || /^[\s\uFEFF]*[\[{]/.test(contents);
  if (looksJson) {
    try {
      input = JSON.parse(contents.replace(/^\uFEFF/, ""));
    } catch (error) {
      throw new Error(`Invalid JSON dataset: ${String(error?.message || error)}`);
    }
    const rawCapture = input?.payload?.rows ? input.payload : input;
    if (Array.isArray(rawCapture)) {
      rows = rawCapture;
      input = {};
    } else {
      rows = rawCapture?.rows;
      headers = Array.isArray(rawCapture?.headers) ? rawCapture.headers : [];
      input = rawCapture || {};
    }
  } else {
    const parsed = parseImportedCsv(contents);
    headers = parsed.headers;
    rows = parsed.rows;
  }

  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("Dataset must contain at least one row.");
  }
  if (rows.length > 5000) {
    throw new Error("Dataset exceeds the extension import limit of 5,000 rows.");
  }
  if (!rows.every((row) => row && typeof row === "object" && !Array.isArray(row))) {
    throw new Error("Every imported dataset row must be an object.");
  }

  const options = metadata && typeof metadata === "object" ? metadata : {};
  const category = String(options.category || "").trim();
  const subcategory = String(options.subcategory || "").trim();
  const normalizedRows = rows.map((row) => {
    const normalized = { ...row };
    applyImportedFallback(normalized, "Category", category);
    applyImportedFallback(normalized, "Subcategory", subcategory);
    return normalized;
  });
  const headerSet = new Set(headers.map((header) => String(header || "").trim()).filter(Boolean));
  for (const row of normalizedRows) {
    for (const key of Object.keys(row)) headerSet.add(String(key));
  }

  const enteredSource = String(options.source || "").trim().toLowerCase();
  const source = (enteredSource || String(input.source || "imported-dataset").trim().toLowerCase())
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "imported-dataset";
  const enteredUrl = String(options.sourceUrl || "").trim();
  const sourceUrl = enteredUrl || String(input.page_url || input.pageUrl || "").trim();
  if (sourceUrl) {
    let parsed;
    try {
      parsed = new URL(sourceUrl);
    } catch {
      throw new Error("Dataset source URL must be a valid HTTP or HTTPS URL.");
    }
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Dataset source URL must use HTTP or HTTPS.");
    }
  }

  const warnings = [];
  if (!sourceUrl) {
    warnings.push("No source URL was supplied; provenance and URL-scoped mapping profiles will be limited.");
  }
  if (!category && !normalizedRows.some((row) => String(row[importedFieldKey(row, "Category")] || "").trim())) {
    warnings.push("No category was supplied or found in the dataset.");
  }

  return {
    source,
    captureProfile: String(input.capture_profile || input.captureProfile || "dataset-import"),
    pageType: String(input.page_type || input.pageType || "imported-table"),
    capturedAt: new Date().toISOString(),
    pageTitle: String(options.title || input.page_title || input.pageTitle || safeName.replace(/\.[^.]+$/, "")).trim(),
    pageUrl: sourceUrl,
    headers: Array.from(headerSet),
    rows: normalizedRows,
    pagesScraped: Number(input.pages_scraped || input.pagesScraped || 1),
    linkedPagesFound: 0,
    linkedPagesCrawled: 0,
    importedFileName: safeName,
    importWarnings: warnings
  };
}

