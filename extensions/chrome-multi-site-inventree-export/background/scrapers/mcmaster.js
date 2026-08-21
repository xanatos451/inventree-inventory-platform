// Injected into the active McMaster-Carr tab via chrome.scripting.executeScript; must stay self-contained
// (no closures over background-script state - it runs in the page's own execution context).
export function scrapeMcMasterCategoryData() {
  function normalizeText(value) {
    let text = String(value || "");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const repaired = text
        .replace(/Ã‚/g, "Â")
        .replace(/Ã¢â‚¬â€œ/g, "â€“")
        .replace(/Ã¢â‚¬â€/g, "â€”")
        .replace(/Ã¢â‚¬â„¢/g, "â€™")
        .replace(/Â°/g, "°")
        .replace(/Â([®©™±µ·])/g, "$1")
        .replace(/â€“/g, "–")
        .replace(/â€”/g, "—")
        .replace(/â€™/g, "’")
        .replace(/â€œ/g, "“")
        .replace(/â€/g, "”")
        .replace(/â€¦/g, "…");
      if (repaired === text) break;
      text = repaired;
    }
    return text.replace(/\s+/g, " ").trim();
  }

  function cleanImageUrl(raw) {
    if (!raw || /(?:industrial-information-icon|placeholder|image[-_ ]?not[-_ ]?found)/i.test(raw)) return "";
    try {
      const url = new URL(raw, location.href);
      if (/^imagenotfound$/i.test(url.searchParams.get("ver") || "")) {
        url.searchParams.delete("ver");
      }
      return url.toString();
    } catch {
      return raw;
    }
  }

  function firstImageSrc(container) {
    for (const image of Array.from(container?.querySelectorAll?.("img[src], img[data-src], img[data-original], source[srcset]") || [])) {
      const alt = normalizeText(image.getAttribute("alt") || "");
      if (/image\s*not\s*found|placeholder/i.test(alt)) continue;
      const srcset = image.getAttribute("srcset") || "";
      if (srcset) {
        const first = srcset.split(",")[0]?.trim().split(" ")[0];
        const cleaned = cleanImageUrl(first);
        if (cleaned) return cleaned;
      }
      const raw = image.getAttribute("src") || image.getAttribute("data-src") || image.getAttribute("data-original") || "";
      const cleaned = cleanImageUrl(raw);
      if (cleaned) return cleaned;
    }
    return "";
  }

  function buildSectionImageCandidates(table) {
    const candidates = [];
    const seen = new Set();

    // Capture image blocks near the product title area and around the table.
    const seedNodes = [
      document.querySelector("main"),
      table?.closest("section"),
      table?.parentElement,
      document.body
    ].filter(Boolean);

    for (const node of seedNodes) {
      const images = Array.from(node.querySelectorAll("img[src], img[data-src], source[srcset]"));
      for (const image of images) {
        const src = firstImageSrc(image.closest("picture") || image);
        if (!src || seen.has(src)) continue;

        const alt = normalizeText(image.getAttribute("alt") || "").toLowerCase();
        const score =
          (alt.includes("image of product") ? 4 : 0) +
          (alt.includes("socket head") ? 2 : 0) +
          (alt.includes("screw") ? 2 : 0) +
          (/imagecache|contents\/gfx|mcmaster\.com/i.test(src) ? 1 : 0);

        candidates.push({ src, score });
        seen.add(src);
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.map((item) => item.src);
  }

  function parseBreadcrumbs() {
    const breadcrumbRoot = document.querySelector("nav[aria-label*='breadcrumb' i], [aria-label*='breadcrumb' i], .breadcrumb, #breadcrumb, #breadcrumbs");
    if (breadcrumbRoot) {
      const labels = [];
      const seen = new Set();
      for (const node of Array.from(breadcrumbRoot.querySelectorAll("a, [aria-current='page'], li, span"))) {
        if (node.matches("li") && node.querySelector("a, span")) continue;
        if (node.matches("span") && (node.closest("a") || node.querySelector("a, span"))) continue;
        const text = normalizeText(node.textContent);
        const key = text.toLowerCase();
        if (!text || /^(?:>|\/|…|\.\.\.)$/.test(text) || seen.has(key)) continue;
        seen.add(key);
        labels.push(text);
      }
      if (labels.length > 0) {
        return labels.join(" > ");
      }
      const inlineText = normalizeText(breadcrumbRoot.textContent);
      if (inlineText.includes(">")) {
        return inlineText;
      }
    }

    const main = document.querySelector("main, [role='main'], #main, #maincontent, #content") || document.body;
    const candidates = Array.from(main.querySelectorAll("div, p, span"))
      .slice(0, 200)
      .map((node) => normalizeText(node.textContent))
      .filter((text) => text && text.includes(">") && text.length < 240);
    return candidates[0] || "";
  }

  function collectLeftFiltersSummary() {
    const leftRoot = document.querySelector("aside, #leftNav, #leftColumn, .leftNav, .sidebar, [class*='filter'], [id*='filter']");
    if (!leftRoot) return "";

    const selected = [];
    const seen = new Set();
    for (const node of Array.from(leftRoot.querySelectorAll("li, a, span, label, div"))) {
      const text = normalizeText(node.textContent);
      if (!text || text.length > 80) continue;
      const selectedSignal =
        /^[\u2713\u2714\u2715\u2022]/.test(text) ||
        node.classList.contains("selected") ||
        node.classList.contains("active") ||
        Boolean(node.querySelector("input[type='checkbox']:checked, input[type='radio']:checked"));
      if (!selectedSignal) continue;

      const cleaned = text.replace(/^[\u2713\u2714\u2715\u2022]\s*/, "").trim();
      if (!cleaned || seen.has(cleaned.toLowerCase())) continue;
      seen.add(cleaned.toLowerCase());
      selected.push(cleaned);
      if (selected.length >= 12) break;
    }
    return selected.join(" | ");
  }

  function collectPageContext(table, sectionImageCandidates) {
    const title = normalizeText(document.querySelector("h1")?.textContent || document.title || "McMaster Category");
    const breadcrumbs = parseBreadcrumbs();

    const mainRoot = document.querySelector("main, [role='main'], #main, #maincontent, #content") || document.body;
    const titleEl = document.querySelector("h1");
    const summaryParts = [];
    if (titleEl) {
      let sibling = titleEl.nextElementSibling;
      let depth = 0;
      while (sibling && depth < 6) {
        const text = normalizeText(sibling.textContent);
        if (text && text.length > 20 && text.length < 320) {
          summaryParts.push(text);
        }
        if (summaryParts.length >= 2) break;
        sibling = sibling.nextElementSibling;
        depth += 1;
      }
    }
    if (summaryParts.length === 0) {
      const firstParagraphs = Array.from(mainRoot.querySelectorAll("p"))
        .map((node) => normalizeText(node.textContent))
        .filter((text) => text && text.length > 20)
        .slice(0, 2);
      summaryParts.push(...firstParagraphs);
    }

    const leftRoot = document.querySelector("aside, #leftNav, #leftColumn, .leftNav, .sidebar, [class*='filter'], [id*='filter']");
    const sidebarPrimaryImageUrl = firstImageSrc(leftRoot || document.createElement("div"));
    const pagePrimaryImageUrl = sectionImageCandidates[0] || firstImageSrc(mainRoot) || "";

    return {
      pageTitle: title,
      pageBreadcrumbs: breadcrumbs,
      pageSectionSummary: summaryParts.join(" "),
      leftFiltersSummary: collectLeftFiltersSummary(),
      pagePrimaryImageUrl,
      sidebarPrimaryImageUrl,
      selectedPageImageUrl: pagePrimaryImageUrl || sidebarPrimaryImageUrl || ""
    };
  }

  function isPartNumber(value) {
    const text = String(value || "");
    return /\b\d{5}[A-Z]\d{3,4}\b/i.test(text);
  }

  function discoverChildLinks() {
    const currentPath = location.pathname.replace(/\/+$/, "");
    const links = [];
    const seen = new Set();
    for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
      const href = anchor.getAttribute("href") || "";
      if (!href) continue;

      let abs;
      try {
        abs = new URL(href, location.href);
      } catch {
        continue;
      }

      if (!/mcmaster\.com$/i.test(abs.hostname)) continue;
      const path = abs.pathname.replace(/\/+$/, "");
      if (!path || path === currentPath) continue;
      if (!path.startsWith(`${currentPath}/`)) continue;

      const pathLower = path.toLowerCase();
      const isLikelyChild =
        pathLower.includes("~") ||
        pathLower.includes("performance") ||
        pathLower.includes("material") ||
        pathLower.includes("thread") ||
        pathLower.includes("diameter") ||
        pathLower.includes("length") ||
        pathLower.includes("-2~") ||
        pathLower.includes("product");
      if (!isLikelyChild) continue;

      const finalUrl = abs.toString();
      if (seen.has(finalUrl)) continue;
      seen.add(finalUrl);
      links.push(finalUrl);
    }
    return links;
  }

  function parseHeaders(table) {
    let headerCells = [];
    if (table.tHead) {
      const headRows = Array.from(table.tHead.querySelectorAll("tr"));
      if (headRows.length > 0) {
        const lastHead = headRows[headRows.length - 1];
        headerCells = Array.from(lastHead.querySelectorAll("th, td"));
      }
    }

    if (headerCells.length === 0) {
      const firstRow = table.querySelector("tr");
      if (firstRow) {
        headerCells = Array.from(firstRow.querySelectorAll("th, td"));
      }
    }

    return headerCells.map((cell, idx) => normalizeText(cell.textContent) || `Column ${idx + 1}`);
  }

  function extractPartNumber(text, href) {
    const sample = `${text || ""} ${href || ""}`;
    const match = sample.match(/\b\d{5}[A-Z]\d{3,4}\b/i) || sample.match(/\b\d{3,}[A-Z]\d{1,}\b/i);
    return match ? match[0].toUpperCase() : "";
  }

  function extractRowsFromProductLinks(sectionImageCandidates, pageContext) {
    const out = [];
    const seen = new Set();
    const primaryRoot = document.querySelector("main, [role='main'], #main, #maincontent, #content") || document.body;
    const anchors = Array.from(primaryRoot.querySelectorAll("a[href]"));

    for (const anchor of anchors) {
      let href = "";
      try {
        href = new URL(anchor.getAttribute("href") || "", location.href).toString();
      } catch {
        continue;
      }
      if (!href || !/mcmaster\.com/i.test(href)) continue;

      const linkText = normalizeText(anchor.textContent || "");
      const partNumber = extractPartNumber(linkText, href);
      const isProductPath = /\/\d{5}[A-Z]\d{3,4}\b/i.test(href) || /\/products\//i.test(href);
      const container = anchor.closest("tr, li, article, section, div") || anchor.parentElement || anchor;
      const containerText = normalizeText(container?.textContent || "");
      const hasPartSignalNearby = isPartNumber(containerText) || /\b\d{5}[A-Z]\d{3,4}\b/i.test(href);
      if (!partNumber && (!isProductPath || !hasPartSignalNearby)) continue;

      const description = containerText.length > 500 ? containerText.slice(0, 500) : containerText;
      const name = linkText || (partNumber ? `Part ${partNumber}` : "Product");
      const rowImageUrl = firstImageSrc(container) || sectionImageCandidates[0] || "";

      const dedupeKey = `${partNumber}|${href}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      out.push({
        Product: name,
        Description: description,
        ProductURL: href,
        McMasterPartNumber: partNumber,
        RowImageURL: rowImageUrl,
        RowImageSource: rowImageUrl && rowImageUrl === sectionImageCandidates[0] ? "section-fallback" : (rowImageUrl ? "row" : "none"),
        PageBreadcrumbs: pageContext.pageBreadcrumbs,
        PageTitle: pageContext.pageTitle,
        PageSectionSummary: pageContext.pageSectionSummary,
        LeftFiltersSummary: pageContext.leftFiltersSummary,
        PagePrimaryImageURL: pageContext.pagePrimaryImageUrl,
        SidebarPrimaryImageURL: pageContext.sidebarPrimaryImageUrl,
        SelectedPageImageURL: pageContext.selectedPageImageUrl
      });
    }

    return out;
  }

  function getBodyRows(table) {
    if (table.tBodies && table.tBodies.length > 0) {
      return Array.from(table.tBodies[0].querySelectorAll("tr"));
    }
    return Array.from(table.querySelectorAll("tr"));
  }

  function scoreTable(table) {
    const badContainer = table.closest("nav, header, footer, aside, [role='navigation'], [class*='nav'], [id*='nav'], [class*='menu'], [id*='menu'], [class*='sidebar'], [id*='sidebar'], [class*='breadcrumb'], [id*='breadcrumb']");
    if (badContainer) {
      return -10000;
    }

    const inMainContent = Boolean(table.closest("main, [role='main'], #main, #maincontent, #content, .content, .main, .page-content, .product-results"));
    const inResultsContainer = Boolean(table.closest("[class*='result'], [id*='result'], [class*='product'], [id*='product']"));

    const rows = getBodyRows(table);
    const rowCount = rows.length;
    const colCount = Math.max(...rows.map((row) => row.querySelectorAll("td,th").length), 0);
    const dataRowCount = rows.filter((row) => {
      const cells = Array.from(row.querySelectorAll("td,th"));
      const nonEmpty = cells.filter((cell) => normalizeText(cell.textContent)).length;
      return nonEmpty >= 3;
    }).length;
    const partLinks = table.querySelectorAll("a[href*='/products/'], a[href*='mcmaster.com']").length;
    const headText = normalizeText(table.textContent || "").toLowerCase();
    const hasPartLikeHeader = /part\s*number|stock\s*number|mcmaster|material|thread|length|diameter/i.test(headText) ? 8 : 0;

    return (
      rowCount * colCount +
      (dataRowCount * 8) +
      hasPartLikeHeader +
      (partLinks * 5) +
      (inMainContent ? 120 : 0) +
      (inResultsContainer ? 35 : 0)
    );
  }

  const primaryRoots = Array.from(document.querySelectorAll("main, [role='main'], #main, #maincontent, #content, .content, .main, .page-content, .product-results"));
  const preferredTables = Array.from(new Set(primaryRoots.flatMap((root) => Array.from(root.querySelectorAll("table")))));
  const allTables = Array.from(document.querySelectorAll("table"));
  const tables = preferredTables.length > 0 ? preferredTables : allTables;
  const childLinks = discoverChildLinks();
  if (tables.length === 0) {
    return { ok: false, error: "No HTML tables found on page.", childLinks };
  }

  let bestTable = tables[0];
  let bestScore = scoreTable(bestTable);
  for (const table of tables.slice(1)) {
    const score = scoreTable(table);
    if (score > bestScore) {
      bestScore = score;
      bestTable = table;
    }
  }

  const headers = parseHeaders(bestTable);
  if (headers.length === 0) {
    return { ok: false, error: "Could not determine table headers." };
  }

  const sectionImageCandidates = buildSectionImageCandidates(bestTable);
  const pageContext = collectPageContext(bestTable, sectionImageCandidates);

  const rows = [];
  const tableRows = getBodyRows(bestTable);
  for (const row of tableRows) {
    const cells = Array.from(row.querySelectorAll("th, td"));
    if (cells.length === 0) continue;

    const obj = {};
    let firstHref = "";
    let bestLinkScore = -1;
    let mergedText = "";
    let nonEmptyCellCount = 0;

    const allLinks = Array.from(row.querySelectorAll("a[href]"));
    for (const link of allLinks) {
      let href = "";
      try {
        href = new URL(link.getAttribute("href"), location.href).toString();
      } catch {
        continue;
      }

      const linkText = normalizeText(link.textContent);
      let score = 0;
      if (isPartNumber(linkText) || isPartNumber(href)) score += 6;
      if (/\/\d{5}[A-Z]\d{3,4}\b/i.test(href)) score += 6;
      if (/product|part|socket-head-screws/i.test(href)) score += 1;

      if (score > bestLinkScore) {
        bestLinkScore = score;
        firstHref = href;
      }
    }

    for (let i = 0; i < cells.length; i += 1) {
      const header = headers[i] || `Column ${i + 1}`;
      const text = normalizeText(cells[i].textContent);
      obj[header] = text;
      mergedText += ` ${text}`;
      if (text) nonEmptyCellCount += 1;

      if (!firstHref) {
        const link = cells[i].querySelector("a[href]");
        if (link) {
          try {
            firstHref = new URL(link.getAttribute("href"), location.href).toString();
          } catch {
            firstHref = "";
          }
        }
      }
    }

    const partNumber = extractPartNumber(mergedText, firstHref);
    const rowImageUrl = firstImageSrc(row) || sectionImageCandidates[0] || "";

    // McMaster tables include many spacer/group rows; keep only likely product rows.
    const looksLikeDataRow = nonEmptyCellCount >= 4 || Boolean(partNumber);
    if (!looksLikeDataRow || Object.values(obj).every((value) => !value)) {
      continue;
    }

    obj.ProductURL = firstHref;
    obj.McMasterPartNumber = partNumber;
    obj.RowImageURL = rowImageUrl;
    obj.RowImageSource = rowImageUrl && rowImageUrl === sectionImageCandidates[0] ? "section-fallback" : (rowImageUrl ? "row" : "none");
    obj.PageBreadcrumbs = pageContext.pageBreadcrumbs;
    obj.PageTitle = pageContext.pageTitle;
    obj.PageSectionSummary = pageContext.pageSectionSummary;
    obj.LeftFiltersSummary = pageContext.leftFiltersSummary;
    obj.PagePrimaryImageURL = pageContext.pagePrimaryImageUrl;
    obj.SidebarPrimaryImageURL = pageContext.sidebarPrimaryImageUrl;
    obj.SelectedPageImageURL = pageContext.selectedPageImageUrl;
    rows.push(obj);
  }

  if (rows.length === 0) {
    const fallbackRows = extractRowsFromProductLinks(sectionImageCandidates, pageContext);
    if (fallbackRows.length === 0) {
      return { ok: false, error: "No product rows found in selected table." };
    }

    return {
      ok: true,
      pageType: "category-link-list",
      headers: [
        "Product",
        "Description",
        "ProductURL",
        "McMasterPartNumber",
        "RowImageURL",
        "RowImageSource",
        "PageBreadcrumbs",
        "PageTitle",
        "PageSectionSummary",
        "LeftFiltersSummary",
        "PagePrimaryImageURL",
        "SidebarPrimaryImageURL",
        "SelectedPageImageURL"
      ],
      rows: fallbackRows,
      pageTitle: pageContext.pageTitle,
      pageBreadcrumbs: pageContext.pageBreadcrumbs,
      pageSectionSummary: pageContext.pageSectionSummary,
      leftFiltersSummary: pageContext.leftFiltersSummary,
      pagePrimaryImageUrl: pageContext.pagePrimaryImageUrl,
      sidebarPrimaryImageUrl: pageContext.sidebarPrimaryImageUrl,
      selectedPageImageUrl: pageContext.selectedPageImageUrl,
      childLinks
    };
  }

  return {
    ok: true,
    pageType: "category-table",
    headers: Array.from(new Set([
      ...headers,
      "ProductURL",
      "McMasterPartNumber",
      "RowImageURL",
      "RowImageSource",
      "PageBreadcrumbs",
      "PageTitle",
      "PageSectionSummary",
      "LeftFiltersSummary",
      "PagePrimaryImageURL",
      "SidebarPrimaryImageURL",
      "SelectedPageImageURL"
    ])),
    rows,
    pageTitle: pageContext.pageTitle,
    pageBreadcrumbs: pageContext.pageBreadcrumbs,
    pageSectionSummary: pageContext.pageSectionSummary,
    leftFiltersSummary: pageContext.leftFiltersSummary,
    pagePrimaryImageUrl: pageContext.pagePrimaryImageUrl,
    sidebarPrimaryImageUrl: pageContext.sidebarPrimaryImageUrl,
    selectedPageImageUrl: pageContext.selectedPageImageUrl,
    childLinks
  };
}

export function scrapeMcMasterProductDetailData() {
  function normalizeText(value) {
    let text = String(value || "");
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const repaired = text
        .replace(/Ã‚/g, "Â")
        .replace(/Ã¢â‚¬â€œ/g, "â€“")
        .replace(/Ã¢â‚¬â€/g, "â€”")
        .replace(/Ã¢â‚¬â„¢/g, "â€™")
        .replace(/Â°/g, "°")
        .replace(/Â([®©™±µ·])/g, "$1")
        .replace(/â€“/g, "–")
        .replace(/â€”/g, "—")
        .replace(/â€™/g, "’")
        .replace(/â€œ/g, "“")
        .replace(/â€/g, "”")
        .replace(/â€¦/g, "…");
      if (repaired === text) break;
      text = repaired;
    }
    return text.replace(/\s+/g, " ").trim();
  }

  function toAbsolute(raw) {
    try {
      const url = new URL(raw, location.href);
      if (/^imagenotfound$/i.test(url.searchParams.get("ver") || "")) {
        url.searchParams.delete("ver");
      }
      if (/(?:industrial-information-icon|placeholder|image[-_ ]?not[-_ ]?found)/i.test(url.pathname)) return "";
      return url.toString();
    } catch {
      return "";
    }
  }

  function collectProductImageUrls(container, partNumber) {
    const candidates = [];
    const seen = new Set();
    const partToken = String(partNumber || "").toLowerCase();
    const imageExtension = /\.(?:png|jpe?g|gif|webp|avif|bmp|tiff?)(?:$|[?#])/i;

    function add(raw, element, sourceRank = 0) {
      const cleaned = toAbsolute(String(raw || "").trim());
      if (!cleaned || !/^https?:/i.test(cleaned) || !imageExtension.test(cleaned)) return;

      let parsed;
      try {
        parsed = new URL(cleaned);
      } catch {
        return;
      }

      const host = parsed.hostname.toLowerCase();
      const path = parsed.pathname.toLowerCase();
      const alt = normalizeText(element?.getAttribute?.("alt") || "").toLowerCase();
      if (!/(?:^|\.)mcmaster\.com$/.test(host)) return;
      if (
        /(?:mastheadlogo|browse-catalog|categorytiles|browsecatalogcategoryimages|industrial-information-icon|placeholder|image[-_]?not[-_]?found|\/gfx\/(?:cancel|spinner|loading|print|email|logo|icon))/i.test(path) ||
        /(?:mcmaster-carr\s+logo|image\s*not\s*found|placeholder|browse\s+catalog)/i.test(alt)
      ) {
        return;
      }

      const dedupeKey = `${parsed.origin}${parsed.pathname}`.toLowerCase();
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);

      let score = sourceRank;
      if (partToken && cleaned.toLowerCase().includes(partToken)) score += 100;
      if (/image\s+of\s+(?:the\s+)?product|product\s+image|item\s+image/i.test(alt)) score += 50;
      if (/\/contents\/gfx\/imagecache\//i.test(path)) score += 80;
      else if (/\/contents\/gfx\/(?:large|medium|small)\//i.test(path)) score += 30;
      if (/dimension|drawing|diagram|technical|specification/i.test(`${path} ${alt}`)) score += 10;
      candidates.push({ url: cleaned, score, order: candidates.length });
    }

    const root = container || document;
    for (const image of Array.from(root.querySelectorAll(
      "img, picture source, svg image"
    ))) {
      const srcsets = [
        image.getAttribute("srcset"),
        image.getAttribute("data-srcset")
      ].filter(Boolean);
      for (const srcset of srcsets) {
        const entries = srcset
          .split(",")
          .map((entry) => entry.trim().split(/\s+/)[0])
          .filter(Boolean);
        entries.forEach((entry, index) => add(entry, image, 20 + index));
      }

      [
        ["data-zoom-src", 45],
        ["data-large-src", 40],
        ["data-original", 35],
        ["data-src", 30],
        ["href", 25],
        ["xlink:href", 25],
        ["src", 10]
      ].forEach(([attribute, rank]) => add(image.getAttribute(attribute), image, rank));
      add(image.currentSrc, image, 15);

      const linkedImage = image.closest("a[href]");
      if (linkedImage) add(linkedImage.getAttribute("href"), image, 50);
    }

    for (const link of Array.from(root.querySelectorAll("a[href]"))) {
      add(link.getAttribute("href"), link, 5);
    }

    for (const element of Array.from(root.querySelectorAll("[style*='url(']"))) {
      const style = element.getAttribute("style") || "";
      for (const match of style.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
        add(match[2], element, 5);
      }
    }

    return candidates
      .sort((left, right) => right.score - left.score || left.order - right.order)
      .map((candidate) => candidate.url);
  }

  function parseBreadcrumbs() {
    const root = document.querySelector("nav[aria-label*='breadcrumb' i], [aria-label*='breadcrumb' i], .breadcrumb, #breadcrumb, #breadcrumbs");
    if (!root) return "";
    const labels = [];
    const seen = new Set();
    for (const node of Array.from(root.querySelectorAll("a, [aria-current='page'], li, span"))) {
      if (node.matches("li") && node.querySelector("a, span")) continue;
      if (node.matches("span") && (node.closest("a") || node.querySelector("a, span"))) continue;
      const text = normalizeText(node.textContent);
      const key = text.toLowerCase();
      if (!text || /^(?:>|\/|…|\.\.\.)$/.test(text) || seen.has(key)) continue;
      seen.add(key);
      labels.push(text);
    }
    return labels.join(" > ");
  }

  function extractPartNumber(titleText) {
    const fromUrl = String(location.href || "").match(/\b\d{5}[A-Z]\d{3,4}\b/i);
    if (fromUrl) return fromUrl[0].toUpperCase();

    const fullText = `${titleText || ""} ${normalizeText(document.body?.textContent || "")}`;
    const fromBody = fullText.match(/\b\d{5}[A-Z]\d{3,4}\b/i);
    return fromBody ? fromBody[0].toUpperCase() : "";
  }

  const headingTitle = normalizeText(document.querySelector("h1")?.textContent || "");
  const documentTitle = normalizeText(document.title || "");
  const title = headingTitle && !/^mcmaster-carr$/i.test(headingTitle)
    ? headingTitle
    : (documentTitle || headingTitle);
  const breadcrumbs = parseBreadcrumbs();
  const partNumber = extractPartNumber(title);

  const specMap = {};
  const specLines = [];
  const specRows = Array.from(document.querySelectorAll("table tr"));
  for (const row of specRows) {
    const th = normalizeText(row.querySelector("th")?.textContent || "");
    const tds = Array.from(row.querySelectorAll("td")).map((cell) => normalizeText(cell.textContent));
    if (th && tds.length > 0) {
      const value = tds.filter(Boolean).join(" ");
      if (value) {
        specMap[th] = value;
        specLines.push(`${th}: ${value}`);
      }
      continue;
    }

    if (tds.length >= 2) {
      const key = tds[0];
      const value = tds.slice(1).filter(Boolean).join(" ");
      if (key && value) {
        specMap[key] = value;
        specLines.push(`${key}: ${value}`);
      }
    }
  }

  const featureBullets = Array.from(document.querySelectorAll("main li, [role='main'] li"))
    .map((node) => normalizeText(node.textContent))
    .filter((text) => text && text.length > 8)
    .slice(0, 15);

  const specText = specLines.slice(0, 80).join("\n");
  const bulletText = featureBullets.slice(0, 20).join("\n");
  const detailNotes = [specText, bulletText]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 16000);

  const titleThreadMatch = title.match(/,\s*([^,]+?)\s+Thread Size(?:,|\s*\|)/i);
  const titleLengthMatch = title.match(/,\s*([^,]+?)\s+Long(?:,|\s*\|)/i);
  const threadSize =
    Object.entries(specMap).find(([key]) => /thread\s*size/i.test(key))?.[1] ||
    normalizeText(titleThreadMatch?.[1] || "");
  const lengthValue =
    Object.entries(specMap).find(([key]) => /(?:^|\b)(?:length|lg\.?)(?:\b|$)/i.test(key))?.[1] ||
    normalizeText(titleLengthMatch?.[1] || "");
  const variant = threadSize && lengthValue
    ? `${threadSize} x ${lengthValue}`
    : (threadSize || lengthValue || "");
  const bodyText = normalizeText(document.body?.textContent || "");
  const accessWarning = /to continue browsing,\s*please log in/i.test(bodyText)
    ? "McMaster login required for full product specifications."
    : "";

  const imageUrls = collectProductImageUrls(
    document.querySelector("main, [role='main']") || document.body,
    partNumber
  );
  const imageUrl = imageUrls[0] || "";
  const row = {
    Product: title || (partNumber ? `Part ${partNumber}` : "Product"),
    Description: title,
    ProductURL: location.href,
    McMasterPartNumber: partNumber,
    RowImageURL: imageUrl,
    RowImageSource: imageUrl ? "product-page" : "none",
    ProductDetailImageURL: imageUrl,
    ProductDetailImageURLs: imageUrls.join("\n"),
    ProductDetailImageCount: imageUrls.length,
    "Image URL": imageUrl,
    "Image URLs": imageUrls.join("\n"),
    "Image Count": imageUrls.length,
    PageBreadcrumbs: breadcrumbs,
    ProductDetailBreadcrumbs: breadcrumbs,
    ProductDetailPageTitle: title,
    PageTitle: title,
    PageSectionSummary: normalizeText(document.querySelector("main p, [role='main'] p")?.textContent || ""),
    ProductDetailThreadSize: threadSize,
    ProductDetailLength: lengthValue,
    ProductDetailVariant: variant,
    ProductDetailSpecs: specText,
    ProductDetailNotes: detailNotes,
    ProductDetailAccessWarning: accessWarning
  };

  // Flatten first-spec values for easier mapping without regex.
  for (const [key, value] of Object.entries(specMap)) {
    const normalizedKey = `Spec_${key}`.replace(/[^a-zA-Z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_|_$/g, "");
    if (!normalizedKey) continue;
    row[normalizedKey] = value;
  }

  return {
    ok: Boolean(title || partNumber),
    pageType: "product-detail",
    pageTitle: title,
    headers: Object.keys(row),
    row,
    error: title || partNumber ? undefined : "Could not extract product detail fields from this page."
  };
}

