import { captureAmazonTab, captureBoltDepotTab, captureFastenalTab, captureMcmasterTab } from "./site-captures.js";
import { scrapeAmazonOrderItems } from "./scrapers/amazon.js";
import { scrapeBoltDepotPageData } from "./scrapers/boltdepot.js";
import { scrapeFastenalPageData } from "./scrapers/fastenal.js";
import { scrapeMcMasterCategoryData, scrapeMcMasterProductDetailData } from "./scrapers/mcmaster.js";

async function resolveCaptureTab(targetTabId) {
  const requestedId = Number(targetTabId);
  if (Number.isInteger(requestedId) && requestedId > 0) {
    try {
      const requested = await chrome.tabs.get(requestedId);
      if (requested?.id && requested.url) return requested;
    } catch {
      // The selected tab may have closed between the popup request and capture.
    }
  }

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return activeTab || null;
}

export async function captureCurrentTabData(settings, selectedChildLinks, targetTabId) {
  const tab = await resolveCaptureTab(targetTabId);
  if (!tab?.id || !tab.url) {
    throw new Error("No active tab available.");
  }

  const provider = detectProvider(tab.url, settings.sourceMode);

  if (provider === "mcmaster") {
    return await captureMcmasterTab(tab, settings, selectedChildLinks);
  }

  if (provider === "boltdepot") {
    return await captureBoltDepotTab(tab, settings, selectedChildLinks);
  }

  if (provider === "amazon") {
    return await captureAmazonTab(tab, settings, selectedChildLinks);
  }

  if (provider === "fastenal") {
    return await captureFastenalTab(tab, settings, selectedChildLinks);
  }

  throw new Error("Unsupported page. Open a McMaster-Carr, Bolt Depot, Amazon, or Fastenal page.");
}

export async function previewLinkedPages(settings, targetTabId) {
  const tab = await resolveCaptureTab(targetTabId);
  if (!tab?.id || !tab.url) {
    throw new Error("No active tab available.");
  }

  const provider = detectProvider(tab.url, settings.sourceMode);
  const maxLinks = Math.min(500, Math.max(1, Number(settings.maxLinkedPages || 100)));

  if (provider === "amazon") {
    const data = await executeScraperOnTab(tab.id, scrapeAmazonOrderItems);
    const items = Array.isArray(data?.items) ? data.items : [];
    const sliced = items.slice(0, maxLinks);
    const links = sliced.map((item) => item.url);
    const itemLabels = {};
    for (const item of sliced) {
      itemLabels[item.url] = item.label || (item.asin ? `ASIN: ${item.asin}` : item.url);
    }
    return { links, itemLabels };
  }

  if (provider !== "boltdepot" && provider !== "mcmaster" && provider !== "fastenal") {
    return { links: [], itemLabels: {} };
  }

  const data = provider === "boltdepot"
    ? await executeScraperOnTab(tab.id, scrapeBoltDepotPageData)
    : provider === "fastenal"
      ? await executeScraperOnTab(tab.id, scrapeFastenalPageData)
      : await executeScraperOnTab(tab.id, scrapeMcMasterCategoryData);
  const links = itemDetailTargets(data?.rows || [], data?.childLinks || [], [], maxLinks);
  const itemLabels = {};
  for (const row of data?.rows || []) {
    const url = String(row?.ProductURL || row?.["Product URL"] || "").trim();
    if (!url) continue;
    itemLabels[url] = String(
      row?.Product ||
      row?.Description ||
      row?.McMasterPartNumber ||
      row?.BoltDepotPartNumber ||
      row?.FastenalPartNumber ||
      url
    );
  }
  return { links, itemLabels };
}

function detectProvider(url, sourceMode) {
  const mode = String(sourceMode || "auto").toLowerCase();
  if (mode === "mcmaster" || mode === "boltdepot" || mode === "amazon" || mode === "fastenal") {
    return mode;
  }

  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }

  if (host.includes("mcmaster.com")) return "mcmaster";
  if (host.includes("boltdepot.com")) return "boltdepot";
  if (host.includes("amazon.")) return "amazon";
  if (host === "fastenal.com" || host.endsWith(".fastenal.com")) return "fastenal";
  return "";
}

export async function executeScraperOnTab(tabId, scraper) {
  const injected = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    func: scraper
  });
  const results = (injected || []).map((entry) => entry?.result).filter(Boolean);
  if (results.length === 0) return null;

  function resultScore(result) {
    let score = result?.ok ? 100 : 0;
    const rows = Array.isArray(result?.rows) ? result.rows : (result?.row ? [result.row] : []);
    const pageType = String(result?.pageType || "").toLowerCase();
    const title = String(result?.pageTitle || result?.row?.ProductDetailPageTitle || result?.row?.PageTitle || "").trim();
    const partNumber = String(
      result?.row?.McMasterPartNumber ||
      result?.row?.BoltDepotPartNumber ||
      result?.row?.FastenalPartNumber ||
      result?.row?.PartNumber ||
      result?.row?.ProductURL ||
      ""
    ).trim();

    if (["category-table", "category-link-list", "catalog-table", "variant-list", "catalog-list", "order-items"].includes(pageType)) {
      score += 2000;
    } else if (pageType === "product-detail") {
      score -= 1000;
    }

    score += rows.length * 1000;
    for (const row of rows.slice(0, 10)) {
      for (const value of Object.values(row || {})) {
        const text = String(value || "").trim();
        if (text) score += Math.min(40, text.length);
      }
      score += String(row?.ProductDetailSpecs || "").length * 4;
      score += String(row?.ProductDetailBreadcrumbs || "").length * 2;
      score += String(row?.PageBreadcrumbs || "").length * 2;
      if (row?.McMasterPartNumber || row?.PartNumber || row?.BoltDepotPartNumber || row?.FastenalPartNumber) score += 250;
    }

    if (title && !/^mcmaster-carr$/i.test(title)) score += 500;
    if (/^mcmaster-carr$/i.test(title) && !partNumber && pageType === "product-detail") score -= 4000;
    if (pageType === "product-detail" && !partNumber && !String(result?.row?.ProductDetailSpecs || "").trim()) score -= 1500;

    return score;
  }

  return results.sort((left, right) => resultScore(right) - resultScore(left))[0];
}

export async function waitForMcMasterDetailResult(tabId, timeoutMs = 12000) {
  const startedAt = Date.now();
  let best = null;
  while (Date.now() - startedAt < timeoutMs) {
    const current = await executeScraperOnTab(tabId, scrapeMcMasterProductDetailData);
    if (current?.row) {
      const currentTitle = String(current.row.ProductDetailPageTitle || current.pageTitle || "").trim();
      const bestTitle = String(best?.row?.ProductDetailPageTitle || best?.pageTitle || "").trim();
      const currentRichness =
        String(current.row.ProductDetailSpecs || "").length +
        String(current.row.ProductDetailNotes || "").length +
        (currentTitle && !/^mcmaster-carr$/i.test(currentTitle) ? 1000 : 0);
      const bestRichness =
        String(best?.row?.ProductDetailSpecs || "").length +
        String(best?.row?.ProductDetailNotes || "").length +
        (bestTitle && !/^mcmaster-carr$/i.test(bestTitle) ? 1000 : 0);
      if (!best || currentRichness > bestRichness) best = current;
      const hasProductDetails =
        String(current.row.ProductDetailSpecs || "").trim() ||
        String(current.row.ProductDetailThreadSize || "").trim() ||
        String(current.row.ProductDetailLength || "").trim() ||
        Object.entries(current.row).some(([key, value]) =>
          key.startsWith("Spec_") && String(value || "").trim()
        );
      if (hasProductDetails) return current;
      if (currentTitle && !/^mcmaster-carr$/i.test(currentTitle)) return current;
      if (String(current.row.ProductDetailAccessWarning || "").trim()) return current;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return best;
}

export async function mapWithConcurrency(items, concurrency, worker) {
  const values = Array.from(items || []);
  const results = new Array(values.length);
  let nextIndex = 0;

  async function runWorker(workerIndex) {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index], index, workerIndex);
    }
  }

  const workerCount = Math.min(Math.max(1, concurrency), values.length);
  await Promise.all(Array.from({ length: workerCount }, (_, index) => runWorker(index)));
  return results;
}

export function normalizedUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.toString().replace(/\/$/, "").toLowerCase();
  } catch {
    return raw.replace(/\/$/, "").toLowerCase();
  }
}

export function itemDetailTargets(rows, fallbackLinks, selectedLinks, maxLinks) {
  const selected = new Set((selectedLinks || []).map(normalizedUrl).filter(Boolean));
  const candidates = [];
  const seen = new Set();
  const rowLinks = (rows || [])
    .map((row) => row?.ProductURL || row?.["Product URL"])
    .filter((value) => normalizedUrl(value));
  const sourceLinks = rowLinks.length > 0 ? rowLinks : (fallbackLinks || []);
  for (const value of sourceLinks) {
    const key = normalizedUrl(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    candidates.push(String(value).trim());
  }
  const filtered = selected.size > 0
    ? candidates.filter((url) => selected.has(normalizedUrl(url)))
    : candidates;
  return filtered.slice(0, maxLinks);
}

export function mergeRowsWithDetails(baseRows, detailRows, partField) {
  const detailsByUrl = new Map();
  const detailsByPart = new Map();
  for (const detail of detailRows || []) {
    const url = normalizedUrl(detail?.ProductURL);
    const part = String(detail?.[partField] || "").trim().toLowerCase();
    if (url) detailsByUrl.set(url, detail);
    if (part) detailsByPart.set(part, detail);
  }

  return (baseRows || []).map((base) => {
    const url = normalizedUrl(base?.ProductURL);
    const part = String(base?.[partField] || "").trim().toLowerCase();
    const detail = detailsByUrl.get(url) || detailsByPart.get(part);
    if (!detail) return base;
    return {
      ...base,
      ...detail,
      SourcePageURL: base.SourcePageURL || base.ProductListPageURL || "",
      SourcePageTitle: base.SourcePageTitle || base.PageTitle || "",
      SourcePageBreadcrumbs: base.SourcePageBreadcrumbs || base.PageBreadcrumbs || "",
      ProductListPageURL: base.ProductListPageURL || base.SourcePageURL || "",
      ProductListPageTitle: base.ProductListPageTitle || base.PageTitle || "",
      ProductListBreadcrumbs: base.ProductListBreadcrumbs || base.PageBreadcrumbs || ""
    };
  });
}

export function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = [
      String(row?.McMasterPartNumber || row?.BoltDepotPartNumber || row?.FastenalPartNumber || row?.PartNumber || row?.ASIN || "").trim(),
      String(row?.ProductURL || row?.["Product URL"] || "").trim(),
      String(row?.SourcePageURL || "").trim(),
      String(row?.Description || row?.Product || row?.["Product Name"] || "").trim()
    ].join("|");

    const safeKey = key === "|||" ? JSON.stringify(row) : key;
    if (seen.has(safeKey)) continue;
    seen.add(safeKey);
    out.push(row);
  }
  return out;
}

export async function waitForTabLoaded(tabId, timeoutMs) {
  try {
    const current = await chrome.tabs.get(tabId);
    if (current?.status === "complete") return;
  } catch {
    throw new Error("Tab closed before load complete");
  }

  await new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      cleanup();
      reject(new Error("Timed out waiting for tab load"));
    }, timeoutMs);

    const onUpdated = (updatedTabId, info) => {
      if (updatedTabId !== tabId) return;
      if (info.status === "complete") {
        if (done) return;
        done = true;
        cleanup();
        resolve();
      }
    };

    const onRemoved = (removedTabId) => {
      if (removedTabId !== tabId) return;
      if (done) return;
      done = true;
      cleanup();
      reject(new Error("Tab closed before load complete"));
    };

    function cleanup() {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.get(tabId).then((current) => {
      if (!done && current?.status === "complete") {
        done = true;
        cleanup();
        resolve();
      }
    }).catch(() => {
      if (!done) {
        done = true;
        cleanup();
        reject(new Error("Tab closed before load complete"));
      }
    });
  });
}

