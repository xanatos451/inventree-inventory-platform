export function scrapeBoltDepotPageData() {
  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  const isOrderDetailsPage = /\/Account\/Order-Details/i.test(location.pathname);

  function parseBreadcrumbs() {
    const root = document.querySelector("nav[aria-label*='breadcrumb' i], [aria-label*='breadcrumb' i], .breadcrumb, #breadcrumb, #breadcrumbs");
    if (!root) return "";
    return Array.from(root.querySelectorAll("a, span, li"))
      .map((node) => normalizeText(node.textContent))
      .filter(Boolean)
      .join(" > ");
  }

  const pageTitle = normalizeText(document.querySelector("h1")?.textContent || document.title || "Bolt Depot");
  const pageBreadcrumbs = parseBreadcrumbs();

  function toAbsolute(raw) {
    try {
      return new URL(raw, location.href).toString();
    } catch {
      return "";
    }
  }

  function firstImageSrc(container) {
    const image = container?.querySelector("img[src], img[data-src], source[srcset]");
    if (!image) return "";
    const srcset = image.getAttribute("srcset") || "";
    if (srcset) {
      const first = srcset.split(",")[0]?.trim().split(" ")[0] || "";
      return toAbsolute(first);
    }
    return toAbsolute(image.getAttribute("src") || image.getAttribute("data-src") || "");
  }

  function getChildLinks() {
    if (isOrderDetailsPage) return [];

    const currentPath = location.pathname.replace(/\/+$/, "");
    const links = [];
    const seen = new Set();

    function isLikelyVariantLabel(text) {
      const value = normalizeText(text || "");
      if (!value || value.length > 80) return false;
      return (
        /\d/.test(value) && (
          /\bmm\b/i.test(value) ||
          /\bx\b/i.test(value) ||
          /\bM\d+\b/i.test(value) ||
          /\b\d+\/\d+(?:-\d+)?\b/.test(value)
        )
      );
    }

    function getNearbyHeadingText(node) {
      let current = node?.parentElement || null;
      for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
        const heading = current.querySelector("h1, h2, h3, h4, h5, strong");
        const text = normalizeText(heading?.textContent || "");
        if (text) return text.toLowerCase();
      }
      return "";
    }

    function isIgnoredPath(path) {
      return /\/(?:Service|About|Sign-In|ShoppingCart|Quick-Add|Catalog(?:-Tabs)?|Fastener-Information|Accessibility-Statement|Legal-Summary|Contact|Privacy-Policy)\b/i.test(path);
    }

    for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
      const abs = toAbsolute(anchor.getAttribute("href"));
      if (!abs) continue;
      let parsed;
      try {
        parsed = new URL(abs);
      } catch {
        continue;
      }
      if (!/boltdepot\.com$/i.test(parsed.hostname)) continue;
      const path = parsed.pathname.replace(/\/+$/, "");
      if (!path || path === currentPath) continue;
      if (isIgnoredPath(path)) continue;

      const label = normalizeText(anchor.textContent || "");
      const nearbyHeading = getNearbyHeadingText(anchor);
      const isDirectChild = path.startsWith(`${currentPath}_`);
      const isVariantChild = !isDirectChild
        && isLikelyVariantLabel(label)
        && (/diameter|thread|pitch|length|size|dimension|options/i.test(nearbyHeading) || Boolean(anchor.closest("table, tbody, tr, td, li, ul, ol")));
      if (!isDirectChild && !isVariantChild) continue;

      if (seen.has(abs)) continue;
      seen.add(abs);
      links.push(abs);
    }
    return links;
  }

  function scoreTable(table) {
    const rows = table.querySelectorAll("tr").length;
    const cells = table.querySelectorAll("td,th").length;
    const productLinks = table.querySelectorAll("a[href]").length;
    const text = normalizeText(table.textContent || "").toLowerCase();
    const keywordBoost = /part|price|diameter|thread|length|qty|quantity|item|description|subtotal|sku|order/.test(text) ? 25 : 0;
    const orderBoost = isOrderDetailsPage && /qty|quantity|item|description|subtotal|price/.test(text) ? 80 : 0;
    return rows * 3 + cells + keywordBoost + (productLinks * 4) + orderBoost;
  }

  function parseHeaders(table) {
    const headCells = table.querySelectorAll("thead tr:last-child th, thead tr:last-child td");
    if (headCells.length > 0) {
      return Array.from(headCells).map((cell, i) => normalizeText(cell.textContent) || `Column ${i + 1}`);
    }

    const firstRow = table.querySelector("tr");
    if (!firstRow) return [];
    const firstCells = Array.from(firstRow.querySelectorAll("th,td"));
    if (firstCells.length === 0) return [];

    const hasTh = firstCells.some((cell) => cell.tagName.toLowerCase() === "th");
    if (hasTh) {
      return firstCells.map((cell, i) => normalizeText(cell.textContent) || `Column ${i + 1}`);
    }

    return firstCells.map((_, i) => `Column ${i + 1}`);
  }

  function extractPartNumberByHeaders(rowObj) {
    for (const [key, value] of Object.entries(rowObj || {})) {
      const keyLc = String(key).toLowerCase();
      if (keyLc.includes("part") || keyLc.includes("item")) {
        const text = normalizeText(value);
        if (text) return text;
      }
    }
    return "";
  }

  function extractRowsFromChildLinks(childLinkList, fallbackImage) {
    const output = [];
    const allowed = new Set((childLinkList || []).map((item) => String(item || "").trim()).filter(Boolean));
    const seen = new Set();
    const pageTitle = normalizeText(document.querySelector("h1")?.textContent || document.title || "Bolt Depot");

    function isLikelyItemLabel(text) {
      const value = normalizeText(text || "");
      return /\bmm\b/i.test(value) || /\bx\b/i.test(value) || /\bM\d+\b/i.test(value) || /\b\d+\/\d+(?:-\d+)?\b/.test(value) || /\d+/.test(value);
    }

    for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
      const rowUrl = toAbsolute(anchor.getAttribute("href"));
      if (!rowUrl || !allowed.has(rowUrl)) continue;

      const linkText = normalizeText(anchor.textContent || "");
      if (!linkText || !isLikelyItemLabel(linkText)) continue;

      const container = anchor.closest("li, tr, div, section") || anchor.parentElement || anchor;
      const containerText = normalizeText(container?.textContent || "");
      const description = containerText && containerText !== linkText
        ? containerText.slice(0, 500)
        : `${pageTitle} - ${linkText}`;
      const rowImage = firstImageSrc(container) || fallbackImage;
      const dedupeKey = `${rowUrl}|${linkText}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      output.push({
        Product: linkText,
        Description: description,
        ProductURL: rowUrl,
        BoltDepotPartNumber: extractPartNumberByHeaders({ Product: linkText, Description: description }),
        RowImageURL: rowImage,
        SourcePageURL: location.href
      });
    }

    return output;
  }

  function looksLikeBoltDepotProductUrl(url) {
    if (!url) return false;
    try {
      const parsed = new URL(url);
      if (!/boltdepot\.com$/i.test(parsed.hostname)) return false;
      return !/^\/Account\//i.test(parsed.pathname);
    } catch {
      return false;
    }
  }

  function extractQuantity(rowObj, text) {
    for (const [key, value] of Object.entries(rowObj || {})) {
      const keyLc = String(key || "").toLowerCase();
      if (keyLc.includes("qty") || keyLc.includes("quantity")) {
        const raw = normalizeText(value);
        if (/^\d+(?:\.\d+)?$/.test(raw)) return raw;
      }
    }

    const textMatch = String(text || "").match(/(?:qty|quantity)\s*[:#-]?\s*(\d+(?:\.\d+)?)/i);
    return textMatch ? textMatch[1] : "";
  }

  function extractOrderFallbackRows(fallbackImage) {
    const output = [];
    const seen = new Set();
    const anchors = Array.from(document.querySelectorAll("a[href]"));

    for (const anchor of anchors) {
      const rowUrl = toAbsolute(anchor.getAttribute("href"));
      if (!looksLikeBoltDepotProductUrl(rowUrl)) continue;

      const container = anchor.closest("tr, li, article, section, div") || anchor.parentElement || anchor;
      const text = normalizeText(container?.textContent || anchor.textContent || "");
      if (text.length < 8) continue;

      const partGuess = extractPartNumberByHeaders({ Product: anchor.textContent, Description: text, URL: rowUrl }) || "";
      const quantity = extractQuantity({}, text);
      const productName = normalizeText(anchor.textContent || "") || partGuess || "Bolt Depot Item";
      const imageUrl = firstImageSrc(container) || fallbackImage;

      const dedupeKey = `${rowUrl}|${partGuess}|${productName}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      output.push({
        Product: productName,
        Description: text,
        Quantity: quantity,
        ProductURL: rowUrl,
        BoltDepotPartNumber: partGuess,
        RowImageURL: imageUrl,
        SourcePageURL: location.href
      });
    }

    return output;
  }

  const childLinks = getChildLinks();
  const tables = Array.from(document.querySelectorAll("table"));
  if (tables.length === 0) {
    const fallbackImage = firstImageSrc(document.querySelector("main") || document.body);
    const childRows = extractRowsFromChildLinks(childLinks, fallbackImage);
    return {
      ok: childRows.length > 0,
      pageType: childRows.length > 0 ? "variant-list" : "catalog-empty",
      pageTitle,
      pageBreadcrumbs,
      headers: childRows.length > 0
        ? ["Product", "Description", "ProductURL", "BoltDepotPartNumber", "RowImageURL", "SourcePageURL"]
        : ["SourcePageURL"],
      rows: childRows,
      childLinks
    };
  }

  let best = tables[0];
  let bestScore = scoreTable(best);
  for (const table of tables.slice(1)) {
    const score = scoreTable(table);
    if (score > bestScore) {
      best = table;
      bestScore = score;
    }
  }

  const headers = parseHeaders(best);
  const fallbackImage = firstImageSrc(document.querySelector("main") || document.body);
  const dataRows = [];
  const rows = Array.from(best.querySelectorAll("tr"));

  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll("td,th"));
    if (cells.length === 0) continue;

    const isHeaderRow = cells.every((cell) => cell.tagName.toLowerCase() === "th");
    if (isHeaderRow) continue;

    const rowObj = {};
    let nonEmpty = 0;
    let rowText = "";
    for (let i = 0; i < cells.length; i += 1) {
      const key = headers[i] || `Column ${i + 1}`;
      const value = normalizeText(cells[i].textContent);
      rowObj[key] = value;
      if (value) nonEmpty += 1;
      rowText += ` ${value}`;
    }

    const link = row.querySelector("a[href]");
    const rowUrl = link ? toAbsolute(link.getAttribute("href")) : "";
    const rowImage = firstImageSrc(row) || fallbackImage;
    const partGuess = extractPartNumberByHeaders(rowObj);
    const quantity = extractQuantity(rowObj, rowText);

    const looksOrderItem = isOrderDetailsPage && (Boolean(quantity) || Boolean(rowUrl) || Boolean(partGuess)) && nonEmpty >= 2;
    const looksData = nonEmpty >= 3 || Boolean(partGuess) || Boolean(rowUrl) || looksOrderItem;
    if (!looksData) continue;

    rowObj.ProductURL = rowUrl;
    rowObj.BoltDepotPartNumber = partGuess;
    if (quantity && !rowObj.Quantity) {
      rowObj.Quantity = quantity;
    }
    rowObj.RowImageURL = rowImage;
    rowObj.SourcePageURL = location.href;
    rowObj.PageTitle = pageTitle;
    rowObj.PageBreadcrumbs = pageBreadcrumbs;
    dataRows.push(rowObj);
  }

  if (dataRows.length === 0 && isOrderDetailsPage) {
    const fallbackRows = extractOrderFallbackRows(fallbackImage);
    if (fallbackRows.length > 0) {
      return {
        ok: true,
        pageType: "order-details",
        pageTitle,
        pageBreadcrumbs,
        headers: ["Product", "Description", "Quantity", "ProductURL", "BoltDepotPartNumber", "RowImageURL", "SourcePageURL"],
        rows: fallbackRows,
        childLinks
      };
    }
  }

  if (!isOrderDetailsPage && childLinks.length > 1 && dataRows.length <= 1) {
    const childRows = extractRowsFromChildLinks(childLinks, fallbackImage);
    if (childRows.length > 1) {
      return {
        ok: true,
        pageType: "variant-list",
        pageTitle,
        pageBreadcrumbs,
        headers: ["Product", "Description", "ProductURL", "BoltDepotPartNumber", "RowImageURL", "SourcePageURL"],
        rows: childRows,
        childLinks
      };
    }
  }

  return {
    ok: true,
    pageType: isOrderDetailsPage ? "order-details" : "catalog-table",
    pageTitle,
    pageBreadcrumbs,
    headers: Array.from(new Set([...headers, "ProductURL", "BoltDepotPartNumber", "Quantity", "RowImageURL", "SourcePageURL", "PageTitle", "PageBreadcrumbs"])),
    rows: dataRows,
    childLinks
  };
}

export function scrapeBoltDepotProductDetailData() {
  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function absoluteUrl(raw) {
    try { return new URL(raw, location.href).toString(); } catch { return ""; }
  }

  function parseBreadcrumbs() {
    const root = document.querySelector("nav[aria-label*='breadcrumb' i], [aria-label*='breadcrumb' i], .breadcrumb, #breadcrumb, #breadcrumbs");
    if (!root) return "";
    return Array.from(root.querySelectorAll("a, span, li"))
      .map((node) => normalizeText(node.textContent))
      .filter(Boolean)
      .join(" > ");
  }

  const headingTitle = normalizeText(document.querySelector("h1")?.textContent || "");
  const documentTitle = normalizeText(document.title || "");
  const title = headingTitle && !/^mcmaster-carr$/i.test(headingTitle)
    ? headingTitle
    : (documentTitle || headingTitle);
  const breadcrumbs = parseBreadcrumbs();
  const specMap = {};
  const specLines = [];
  for (const row of Array.from(document.querySelectorAll("table tr, dl"))) {
    const cells = Array.from(row.querySelectorAll("th, td, dt, dd")).map((cell) => normalizeText(cell.textContent));
    if (cells.length < 2) continue;
    const key = cells[0];
    const value = cells.slice(1).filter(Boolean).join(" ");
    if (!key || !value || key === value) continue;
    specMap[key] = value;
    specLines.push(`${key}: ${value}`);
  }

  const bodyText = normalizeText(document.querySelector("main, [role='main'], #content")?.textContent || "");
  const partMatch = `${title} ${bodyText} ${location.pathname}`.match(/(?:part|item|sku|product)\s*(?:number|#|no\.?)*\s*[:#-]?\s*([A-Z0-9][A-Z0-9._-]{2,})/i);
  const partNumber = partMatch?.[1] || "";
  const image = document.querySelector("main img[src], [role='main'] img[src], #content img[src]");
  const imageUrl = absoluteUrl(image?.getAttribute("src") || image?.getAttribute("data-src") || "");
  const row = {
    Product: title,
    Description: normalizeText(document.querySelector("main p, [role='main'] p, #content p")?.textContent || title),
    ProductURL: location.href,
    BoltDepotPartNumber: partNumber,
    RowImageURL: imageUrl,
    PageTitle: title,
    PageBreadcrumbs: breadcrumbs,
    ProductDetailPageTitle: title,
    ProductDetailBreadcrumbs: breadcrumbs,
    ProductDetailSpecs: specLines.slice(0, 80).join("\n")
  };
  for (const [key, value] of Object.entries(specMap)) {
    const field = `Spec_${key}`.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
    if (field) row[field] = value;
  }
  return {
    ok: Boolean(title && (specLines.length > 0 || bodyText.length > 20)),
    pageType: "product-detail",
    pageTitle: title,
    pageBreadcrumbs: breadcrumbs,
    headers: Object.keys(row),
    row,
    error: title ? "Could not identify product details on this page." : "Could not identify a product title."
  };
}

