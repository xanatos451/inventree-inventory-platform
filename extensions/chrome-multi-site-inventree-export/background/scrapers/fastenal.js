export function scrapeFastenalPageData() {
  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function toAbsolute(raw) {
    try {
      return new URL(raw, location.href).toString();
    } catch {
      return "";
    }
  }

  function parseBreadcrumbs() {
    const root = document.querySelector("nav[aria-label*='breadcrumb' i], [aria-label*='breadcrumb' i], .breadcrumb, #breadcrumb, #breadcrumbs");
    if (!root) return "";
    return Array.from(root.querySelectorAll("a, span, li"))
      .map((node) => normalizeText(node.textContent))
      .filter(Boolean)
      .join(" > ");
  }

  function firstImageSrc(container) {
    for (const image of Array.from(container?.querySelectorAll?.("img[src], img[data-src], source[srcset]") || [])) {
      const srcset = image.getAttribute("srcset") || "";
      if (srcset) {
        const first = srcset.split(",")[0]?.trim().split(" ")[0] || "";
        const abs = toAbsolute(first);
        if (abs && /^https?:/i.test(abs)) return abs;
      }
      const abs = toAbsolute(image.getAttribute("src") || image.getAttribute("data-src") || "");
      if (abs && /^https?:/i.test(abs)) return abs;
    }
    return "";
  }

  function extractPartNumber(sample) {
    const text = normalizeText(sample);
    const match = text.match(/\b(?:SKU|Part\s*(?:Number|No\.?))\s*[:#-]?\s*([A-Z0-9][A-Z0-9._-]{2,})\b/i);
    if (match) return match[1].toUpperCase();
    const fallback = text.match(/\b(?=[A-Z0-9._-]*\d)[A-Z0-9]{2,}[._-][A-Z0-9._-]{2,}\b/i);
    if (!fallback) return "";
    const candidate = fallback[0].toUpperCase();
    if (candidate.includes(".COM") || candidate.startsWith("WWW.")) return "";
    return candidate;
  }

  function isLikelyProductUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      if (host !== "fastenal.com" && !host.endsWith(".fastenal.com")) return false;
      return /\/product\/detail\//i.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  const pageTitle = normalizeText(document.querySelector("h1")?.textContent || document.title || "Fastenal");
  const pageBreadcrumbs = parseBreadcrumbs();
  const childLinks = [];
  const childSeen = new Set();

  for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
    const url = toAbsolute(anchor.getAttribute("href") || "");
    if (!isLikelyProductUrl(url)) continue;
    if (childSeen.has(url)) continue;
    childSeen.add(url);
    childLinks.push(url);
  }

  const rows = [];
  const rowSeen = new Set();
  const cards = Array.from(document.querySelectorAll(
    "[data-testid*='product' i], [class*='product' i], li, article, tr"
  ));

  for (const card of cards) {
    const anchor = card.querySelector("a[href]");
    const productUrl = toAbsolute(anchor?.getAttribute("href") || "");
    if (!isLikelyProductUrl(productUrl)) continue;

    const product = normalizeText(
      card.querySelector("h2, h3, [class*='title' i], [class*='name' i]")?.textContent ||
      anchor?.textContent ||
      ""
    );
    const description = normalizeText(
      card.querySelector("p, [class*='description' i], [class*='subtitle' i]")?.textContent ||
      card.textContent ||
      ""
    ).slice(0, 800);
    const partNumber = extractPartNumber(`${product} ${description} ${productUrl}`);
    const rowImage = firstImageSrc(card);
    const dedupeKey = `${productUrl}|${partNumber}|${product}`;
    if (rowSeen.has(dedupeKey)) continue;
    rowSeen.add(dedupeKey);

    rows.push({
      Product: product || (partNumber ? `Part ${partNumber}` : "Product"),
      Description: description,
      ProductURL: productUrl,
      FastenalPartNumber: partNumber,
      RowImageURL: rowImage,
      SourcePageURL: location.href,
      PageTitle: pageTitle,
      PageBreadcrumbs: pageBreadcrumbs
    });
  }

  if (rows.length === 0 && childLinks.length > 0) {
    for (const link of childLinks) {
      const partNumber = extractPartNumber(link);
      rows.push({
        Product: partNumber ? `Part ${partNumber}` : "Product",
        Description: pageTitle,
        ProductURL: link,
        FastenalPartNumber: partNumber,
        RowImageURL: "",
        SourcePageURL: location.href,
        PageTitle: pageTitle,
        PageBreadcrumbs: pageBreadcrumbs
      });
    }
  }

  return {
    ok: rows.length > 0,
    pageType: rows.length > 0 ? "catalog-list" : "catalog-empty",
    pageTitle,
    pageBreadcrumbs,
    headers: Array.from(new Set([
      "Product",
      "Description",
      "ProductURL",
      "FastenalPartNumber",
      "RowImageURL",
      "SourcePageURL",
      "PageTitle",
      "PageBreadcrumbs"
    ])),
    rows,
    childLinks,
    error: rows.length ? undefined : "No Fastenal product rows were detected on this page."
  };
}

export function scrapeFastenalProductDetailData() {
  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function toAbsolute(raw) {
    try {
      const url = new URL(raw, location.href);
      return /^https?:/i.test(url.protocol) ? url.toString() : "";
    } catch {
      return "";
    }
  }

  function parseBreadcrumbs() {
    const root = document.querySelector("nav[aria-label*='breadcrumb' i], [aria-label*='breadcrumb' i], .breadcrumb, #breadcrumb, #breadcrumbs");
    if (!root) return "";
    return Array.from(root.querySelectorAll("a, span, li"))
      .map((node) => normalizeText(node.textContent))
      .filter(Boolean)
      .join(" > ");
  }

  function looksLikePartToken(value) {
    const token = String(value || "").trim().toUpperCase();
    if (!token) return false;
    if (token.includes(".COM") || token.startsWith("WWW.")) return false;
    if (!/[A-Z]/.test(token) || !/\d/.test(token)) return false;
    return /^[A-Z0-9][A-Z0-9._-]{2,}$/.test(token);
  }

  function firstLabeledPartToken(text) {
    const source = String(text || "");
    const patterns = [
      /(?:SKU|Part\s*(?:Number|No\.?)|Catalog\s*Number)\s*[:#-]?\s*([A-Z0-9][A-Z0-9._-]{2,})/ig,
      /([A-Z0-9]{2,}[._-][A-Z0-9._-]{2,})/ig
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(source))) {
        const candidate = String(match[1] || "").toUpperCase();
        if (looksLikePartToken(candidate)) return candidate;
      }
    }
    return "";
  }

  function collectImages() {
    const output = [];
    const seen = new Set();
    function add(raw) {
      const url = toAbsolute(raw);
      if (!url || seen.has(url)) return;
      if (/logo|sprite|icon|placeholder/i.test(url)) return;
      seen.add(url);
      output.push(url);
    }
    for (const image of Array.from(document.querySelectorAll("img[src], img[data-src], source[srcset]"))) {
      const srcset = image.getAttribute("srcset") || "";
      if (srcset) {
        for (const entry of srcset.split(",")) {
          add(entry.trim().split(/\s+/)[0]);
        }
      }
      add(image.getAttribute("data-src"));
      add(image.getAttribute("src"));
    }
    add(document.querySelector("meta[property='og:image']")?.getAttribute("content"));
    return output;
  }

  const title = normalizeText(
    document.querySelector("h1")?.textContent ||
    document.querySelector("meta[property='og:title']")?.getAttribute("content") ||
    document.title ||
    ""
  );
  const breadcrumbs = parseBreadcrumbs();
  const bodyText = normalizeText(document.querySelector("main, [role='main'], #content")?.textContent || document.body?.textContent || "");
  const combined = `${title}\n${bodyText}`;
  let partNumber = firstLabeledPartToken(combined);

  const specs = {};
  const specLines = [];
  for (const row of Array.from(document.querySelectorAll("table tr"))) {
    const key = normalizeText(row.querySelector("th")?.textContent || row.querySelector("td")?.textContent || "");
    const cells = Array.from(row.querySelectorAll("td")).map((cell) => normalizeText(cell.textContent)).filter(Boolean);
    const value = cells.length > 0 ? cells.join(" ") : "";
    if (!key || !value || key === value) continue;
    if (!specs[key]) {
      specs[key] = value;
      specLines.push(`${key}: ${value}`);
    }
  }
  for (const dl of Array.from(document.querySelectorAll("dl"))) {
    const dts = Array.from(dl.querySelectorAll("dt"));
    const dds = Array.from(dl.querySelectorAll("dd"));
    const count = Math.min(dts.length, dds.length);
    for (let index = 0; index < count; index += 1) {
      const key = normalizeText(dts[index].textContent || "");
      const value = normalizeText(dds[index].textContent || "");
      if (!key || !value || specs[key]) continue;
      specs[key] = value;
      specLines.push(`${key}: ${value}`);
    }
  }

  if (!partNumber) {
    for (const [key, value] of Object.entries(specs)) {
      if (!/sku|part\s*(?:number|no\.?)|catalog\s*number/i.test(String(key))) continue;
      const candidate = firstLabeledPartToken(`${key}: ${value}`) || String(value || "").trim().toUpperCase();
      if (looksLikePartToken(candidate)) {
        partNumber = candidate;
        break;
      }
    }
  }

  const images = collectImages();
  const imageUrl = images[0] || "";
  const description = normalizeText(
    document.querySelector("main p, [role='main'] p, #content p, meta[name='description']")?.textContent ||
    document.querySelector("meta[name='description']")?.getAttribute("content") ||
    ""
  ).slice(0, 3000);

  const row = {
    Product: title || (partNumber ? `Part ${partNumber}` : "Product"),
    Description: description || title,
    ProductURL: location.href,
    FastenalPartNumber: partNumber,
    RowImageURL: imageUrl,
    "Image URL": imageUrl,
    "Image URLs": images.join("\n"),
    "Image Count": images.length,
    PageTitle: title,
    PageBreadcrumbs: breadcrumbs,
    ProductDetailPageTitle: title,
    ProductDetailBreadcrumbs: breadcrumbs,
    ProductDetailSpecs: specLines.slice(0, 120).join("\n")
  };

  for (const [key, value] of Object.entries(specs)) {
    const field = `Spec_${key}`
      .replace(/[^a-zA-Z0-9_]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_|_$/g, "");
    if (!field) continue;
    row[field] = value;
  }

  return {
    ok: Boolean(title || partNumber),
    pageType: "product-detail",
    pageTitle: title,
    pageBreadcrumbs: breadcrumbs,
    headers: Object.keys(row),
    row,
    error: title || partNumber ? undefined : "Could not extract Fastenal product-detail fields from this page."
  };
}

