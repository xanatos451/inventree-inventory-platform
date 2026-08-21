// Per-site capture orchestrators (McMaster, Bolt Depot, Amazon, Fastenal). Imports shared
// tab/scrape helpers back from capture-orchestration.js - see the circular-import note there.
import {
  dedupeRows,
  executeScraperOnTab,
  itemDetailTargets,
  mapWithConcurrency,
  mergeRowsWithDetails,
  normalizedUrl,
  waitForMcMasterDetailResult,
  waitForTabLoaded
} from "./capture-orchestration.js";
import { setCaptureProgress } from "./storage.js";
import { scrapeAmazonOrderItems, scrapeAmazonProductPage } from "./scrapers/amazon.js";
import { scrapeBoltDepotPageData, scrapeBoltDepotProductDetailData } from "./scrapers/boltdepot.js";
import { scrapeFastenalPageData, scrapeFastenalProductDetailData } from "./scrapers/fastenal.js";
import { scrapeMcMasterCategoryData, scrapeMcMasterProductDetailData } from "./scrapers/mcmaster.js";

export async function captureMcmasterTab(tab, settings, selectedChildLinks) {
  if (!/mcmaster\.com/i.test(tab.url || "")) {
    throw new Error("Active tab is not a McMaster-Carr page.");
  }

  const directPartUrl = /\/\d{5}[A-Z]\d{3,4}\/?(?:[?#]|$)/i.test(tab.url || "");
  if (settings.captureProfile === "single-item" || directPartUrl) {
    const detail = await executeScraperOnTab(tab.id, scrapeMcMasterProductDetailData);
    if (!detail?.ok || !detail.row) throw new Error(detail?.error || "This is not a McMaster product-detail view.");
    return {
      source: "mcmaster-carr", captureProfile: "single-item", pageType: "product-detail",
      capturedAt: new Date().toISOString(), pageTitle: detail.pageTitle,
      pageBreadcrumbs: detail.row.ProductDetailBreadcrumbs || "", pageUrl: tab.url,
      headers: detail.headers || Object.keys(detail.row), rows: [detail.row], pagesScraped: 1,
      linkedPagesFound: 0, linkedPagesCrawled: 0
    };
  }

  let primary = await executeScraperOnTab(tab.id, scrapeMcMasterCategoryData);
  if (!primary?.ok) {
    const detail = await executeScraperOnTab(tab.id, scrapeMcMasterProductDetailData);
    if (!detail?.ok || !detail.row) {
      throw new Error(primary?.error || detail?.error || "Could not parse this McMaster page.");
    }
    return {
      source: "mcmaster-carr",
      captureProfile: "single-item",
      pageType: "product-detail",
      capturedAt: new Date().toISOString(),
      pageTitle: detail.pageTitle,
      pageBreadcrumbs: detail.pageBreadcrumbs || detail.row.ProductDetailBreadcrumbs || "",
      pageUrl: tab.url,
      headers: detail.headers || Object.keys(detail.row),
      rows: [detail.row],
      pagesScraped: 1,
      linkedPagesFound: 0,
      linkedPagesCrawled: 0
    };
  }

  const allRows = Array.isArray(primary.rows) ? [...primary.rows] : [];
  if (settings.captureProfile === "list-details" && !allRows.some((row) => normalizedUrl(row?.ProductURL))) {
    throw new Error("The selected exporter profile requires a list/table containing product links.");
  }
  for (const row of allRows) {
    row.ProductListPageURL = tab.url;
    row.ProductListPageTitle = primary.pageTitle || row.PageTitle || "";
    row.ProductListBreadcrumbs = primary.pageBreadcrumbs || row.PageBreadcrumbs || "";
    row.SourcePageURL = tab.url;
    row.SourcePageTitle = primary.pageTitle || row.PageTitle || "";
    row.SourcePageBreadcrumbs = primary.pageBreadcrumbs || row.PageBreadcrumbs || "";
  }
  const headerSet = new Set(Array.isArray(primary.headers) ? primary.headers : []);
  let pagesScraped = 1;

  const links = Array.isArray(primary.childLinks) ? primary.childLinks : [];
  const maxLinks = Math.min(500, Math.max(1, Number(settings.maxLinkedPages || 100)));
  const crawlTargets = itemDetailTargets(allRows, links, selectedChildLinks, maxLinks);

  const detailRows = [];
  if (crawlTargets.length > 0) {
    let crawlCompleted = 0;
    await setCaptureProgress({
      status: "running",
      completed: 0,
      total: crawlTargets.length,
      message: `Capturing McMaster detail pages: 0 of ${crawlTargets.length}.`
    });
    const captureWindows = new Map();
    let crawlResults;
    try {
      crawlResults = await mapWithConcurrency(crawlTargets, 1, async (url, _index, workerIndex) => {
        let captureWindow = captureWindows.get(workerIndex);
        let childTab;
        if (!captureWindow) {
          captureWindow = await chrome.windows.create({
            url,
            type: "popup",
            focused: true,
            width: 1100,
            height: 800
          });
          childTab = captureWindow.tabs?.[0];
          captureWindows.set(workerIndex, {
            windowId: captureWindow.id,
            tabId: childTab?.id
          });
        } else {
          await chrome.windows.update(captureWindow.windowId, { focused: true });
          childTab = await chrome.tabs.update(captureWindow.tabId, { url, active: true });
        }

        if (!childTab?.id) return null;

        try {
        await waitForTabLoaded(childTab.id, 30000);

        const detail = await waitForMcMasterDetailResult(childTab.id);
        if (detail?.ok && detail.row) {
          return { detail };
        }

        const child = await executeScraperOnTab(childTab.id, scrapeMcMasterCategoryData);
        if (!child?.ok || !Array.isArray(child.rows)) {
          return null;
        }
        return { child };
      } catch {
        // Continue with remaining pages on one-off failures.
        return null;
        } finally {
          crawlCompleted += 1;
          await setCaptureProgress({
            status: "running",
            completed: crawlCompleted,
            total: crawlTargets.length,
            message: `Capturing McMaster detail pages: ${crawlCompleted} of ${crawlTargets.length}.`
          });
        }
      });
    } finally {
      await Promise.all(Array.from(captureWindows.values(), async ({ windowId }) => {
        if (windowId) {
          try {
            await chrome.windows.remove(windowId);
          } catch {
            // no-op
          }
        }
      }));
    }

    for (const result of crawlResults || []) {
      if (result?.detail?.row) {
        detailRows.push(result.detail.row);
        for (const header of result.detail.headers || []) {
          headerSet.add(header);
        }
        pagesScraped += 1;
      } else if (Array.isArray(result?.child?.rows)) {
        allRows.push(...result.child.rows);
        for (const header of result.child.headers || []) {
          headerSet.add(header);
        }
        pagesScraped += 1;
      }
    }
  }

  if (detailRows.length > 0) {
    const mergedWithDetails = mergeRowsWithDetails(allRows, detailRows, "McMasterPartNumber");
    allRows.length = 0;
    allRows.push(...mergedWithDetails);
  }

  for (const row of allRows) {
    for (const key of Object.keys(row || {})) headerSet.add(key);
  }

  const dedupedRows = dedupeRows(allRows);
  if (dedupedRows.length === 0) {
    throw new Error("No product rows found on this McMaster page or linked child pages.");
  }

  return {
    source: "mcmaster-carr",
    captureProfile: "list-details",
    pageType: primary.pageType || "category",
    capturedAt: new Date().toISOString(),
    pageTitle: primary.pageTitle,
    pageBreadcrumbs: primary.pageBreadcrumbs || "",
    pageSectionSummary: primary.pageSectionSummary || "",
    leftFiltersSummary: primary.leftFiltersSummary || "",
    pagePrimaryImageUrl: primary.pagePrimaryImageUrl || "",
    sidebarPrimaryImageUrl: primary.sidebarPrimaryImageUrl || "",
    selectedPageImageUrl: primary.selectedPageImageUrl || "",
    pageUrl: tab.url,
    headers: Array.from(headerSet),
    rows: dedupedRows,
    pagesScraped,
    linkedPagesFound: links.length,
    linkedPagesCrawled: crawlTargets.length
  };
}

export async function captureBoltDepotTab(tab, settings, selectedChildLinks) {
  if (!/boltdepot\.com/i.test(tab.url || "")) {
    throw new Error("Active tab is not a Bolt Depot page.");
  }

  if (settings.captureProfile === "single-item") {
    const detail = await executeScraperOnTab(tab.id, scrapeBoltDepotProductDetailData);
    if (!detail?.ok || !detail.row) throw new Error(detail?.error || "This is not a Bolt Depot product-detail view.");
    return {
      source: "boltdepot", captureProfile: "single-item", pageType: "product-detail",
      capturedAt: new Date().toISOString(), pageTitle: detail.pageTitle,
      pageBreadcrumbs: detail.pageBreadcrumbs || "", pageUrl: tab.url,
      headers: detail.headers || Object.keys(detail.row), rows: [detail.row], pagesScraped: 1,
      linkedPagesFound: 0, linkedPagesCrawled: 0
    };
  }

  let primary = await executeScraperOnTab(tab.id, scrapeBoltDepotPageData);
  const primaryRows = Array.isArray(primary?.rows) ? primary.rows : [];
  const hasLinkedItems = primaryRows.some((row) => {
    const url = normalizedUrl(row?.ProductURL);
    return url && url !== normalizedUrl(tab.url);
  });
  if (!primary?.ok || (!hasLinkedItems && primary?.pageType !== "order-details")) {
    const detail = await executeScraperOnTab(tab.id, scrapeBoltDepotProductDetailData);
    if (detail?.ok && detail.row) {
      return {
        source: "boltdepot",
        captureProfile: "single-item",
        pageType: "product-detail",
        capturedAt: new Date().toISOString(),
        pageTitle: detail.pageTitle,
        pageBreadcrumbs: detail.pageBreadcrumbs || detail.row.ProductDetailBreadcrumbs || "",
        pageUrl: tab.url,
        headers: detail.headers || Object.keys(detail.row),
        rows: [detail.row],
        pagesScraped: 1,
        linkedPagesFound: 0,
        linkedPagesCrawled: 0
      };
    }
    if (!primary?.ok) {
      throw new Error(primary?.error || detail?.error || "Could not parse this Bolt Depot page.");
    }
  }

  const allRows = Array.isArray(primary.rows) ? [...primary.rows] : [];
  if (settings.captureProfile === "list-details" && !allRows.some((row) => normalizedUrl(row?.ProductURL))) {
    throw new Error("The selected exporter profile requires a list/table containing product links.");
  }
  for (const row of allRows) {
    row.ProductListPageURL = tab.url;
    row.ProductListPageTitle = primary.pageTitle || row.PageTitle || "";
    row.ProductListBreadcrumbs = primary.pageBreadcrumbs || row.PageBreadcrumbs || "";
    row.SourcePageURL = tab.url;
    row.SourcePageTitle = primary.pageTitle || row.PageTitle || "";
    row.SourcePageBreadcrumbs = primary.pageBreadcrumbs || row.PageBreadcrumbs || "";
  }
  const headerSet = new Set(Array.isArray(primary.headers) ? primary.headers : []);
  let pagesScraped = 1;

  const links = Array.isArray(primary.childLinks) ? primary.childLinks : [];
  const maxLinks = Math.min(500, Math.max(1, Number(settings.maxLinkedPages || 100)));
  const crawlTargets = itemDetailTargets(allRows, links, selectedChildLinks, maxLinks);
  const detailRows = [];

  if (crawlTargets.length > 0) {
    for (const url of crawlTargets) {
      const childTab = await chrome.tabs.create({ url, active: false });
      try {
        await waitForTabLoaded(childTab.id, 30000);
        const detail = await executeScraperOnTab(childTab.id, scrapeBoltDepotProductDetailData);
        if (detail?.ok && detail.row) {
          detailRows.push(detail.row);
          for (const header of detail.headers || []) headerSet.add(header);
          pagesScraped += 1;
          continue;
        }
        const child = await executeScraperOnTab(childTab.id, scrapeBoltDepotPageData);
        if (!child?.ok || !Array.isArray(child.rows)) {
          continue;
        }
        for (const row of child.rows) {
          allRows.push(row);
        }
        for (const header of child.headers || []) {
          headerSet.add(header);
        }
        pagesScraped += 1;
      } catch {
        // Ignore one-off child page failures and continue the crawl.
      } finally {
        if (childTab.id) {
          try {
            await chrome.tabs.remove(childTab.id);
          } catch {
            // no-op
          }
        }
      }
    }
  }

  if (detailRows.length > 0) {
    const merged = mergeRowsWithDetails(allRows, detailRows, "BoltDepotPartNumber");
    allRows.length = 0;
    allRows.push(...merged);
  }

  for (const row of allRows) {
    for (const key of Object.keys(row || {})) headerSet.add(key);
  }

  const dedupedRows = dedupeRows(allRows);
  if (dedupedRows.length === 0) {
    throw new Error("No product rows found on this Bolt Depot page or linked child pages.");
  }

  return {
    source: "boltdepot",
    captureProfile: "list-details",
    pageType: primary.pageType || "catalog",
    capturedAt: new Date().toISOString(),
    pageTitle: primary.pageTitle,
    pageBreadcrumbs: primary.pageBreadcrumbs || "",
    pageUrl: tab.url,
    headers: Array.from(headerSet),
    rows: dedupedRows,
    pagesScraped,
    linkedPagesFound: links.length,
    linkedPagesCrawled: crawlTargets.length
  };
}

// ─── Amazon order-page + product-page capture ────────────────────────────────

export async function captureAmazonTab(tab, settings, selectedOrderItems) {
  if (!/amazon\./i.test(tab.url || "")) {
    throw new Error("Active tab is not an Amazon page.");
  }

  if (settings.captureProfile === "single-item") {
    const detail = await executeScraperOnTab(tab.id, scrapeAmazonProductPage);
    if (!detail?.ok || !detail.row) throw new Error(detail?.error || "This is not an Amazon product-detail view.");
    return {
      source: "amazon", captureProfile: "single-item", pageType: "product-detail",
      capturedAt: new Date().toISOString(), pageTitle: detail.pageTitle,
      pageBreadcrumbs: detail.pageBreadcrumbs || "", pageUrl: tab.url,
      headers: detail.headers || Object.keys(detail.row), rows: [detail.row], pagesScraped: 1,
      linkedPagesFound: 0, linkedPagesCrawled: 0
    };
  }

  const primary = await executeScraperOnTab(tab.id, scrapeAmazonOrderItems);
  if (!primary?.ok) {
    const detail = await executeScraperOnTab(tab.id, scrapeAmazonProductPage);
    if (detail?.ok && detail.row) {
      return {
        source: "amazon",
        captureProfile: "single-item",
        pageType: "product-detail",
        capturedAt: new Date().toISOString(),
        pageTitle: detail.pageTitle,
        pageBreadcrumbs: detail.pageBreadcrumbs || detail.row.Category || "",
        pageUrl: tab.url,
        headers: detail.headers || Object.keys(detail.row),
        rows: [detail.row],
        pagesScraped: 1,
        linkedPagesFound: 0,
        linkedPagesCrawled: 0
      };
    }
    throw new Error(primary?.error || detail?.error || "Could not parse this Amazon page.");
  }

  const allItems = Array.isArray(primary.items) ? primary.items : [];

  const selected = Array.isArray(selectedOrderItems)
    ? selectedOrderItems.map((url) => String(url || "").trim()).filter(Boolean)
    : [];

  const maxLinks = Math.min(500, Math.max(1, Number(settings.maxLinkedPages || 100)));

  let targetItems = allItems.slice(0, maxLinks);
  if (selected.length > 0) {
    const selectedSet = new Set(selected);
    targetItems = allItems.filter((item) => selectedSet.has(item.url)).slice(0, maxLinks);
  }

  const allRows = [];
  const headerSet = new Set();
  let pagesScraped = 0;

  for (const item of targetItems) {
    const childTab = await chrome.tabs.create({ url: item.url, active: false });
    try {
      await waitForTabLoaded(childTab.id, 30000);
      const product = await executeScraperOnTab(childTab.id, scrapeAmazonProductPage);
      if (!product?.ok || !product.row) continue;

      const enrichedRow = {
        ...product.row,
        SourcePageURL: tab.url,
        SourcePageTitle: primary.pageTitle || "",
        ProductListPageURL: tab.url,
        ProductListPageTitle: primary.pageTitle || "",
        SourceItemLabel: item.label || "",
        SourceItemImageURL: item.imageUrl || "",
        SourceItemIdentifier: item.asin || ""
      };
      allRows.push(enrichedRow);
      for (const header of Object.keys(enrichedRow)) headerSet.add(header);
      pagesScraped += 1;
    } catch {
      // Continue on one-off failures.
    } finally {
      if (childTab.id) {
        try {
          await chrome.tabs.remove(childTab.id);
        } catch {
          // no-op
        }
      }
    }
  }

  if (allRows.length === 0) {
    throw new Error("No product details could be extracted from the selected Amazon product pages.");
  }

  return {
    source: "amazon",
    captureProfile: "list-details",
    pageType: primary.pageType || "order-items",
    capturedAt: new Date().toISOString(),
    pageTitle: primary.pageTitle,
    pageUrl: tab.url,
    headers: Array.from(headerSet),
    rows: allRows,
    pagesScraped,
    linkedPagesFound: allItems.length,
    linkedPagesCrawled: targetItems.length
  };
}

export async function captureFastenalTab(tab, settings, selectedChildLinks) {
  let host = "";
  try {
    host = new URL(tab.url || "").hostname.toLowerCase();
  } catch {
    throw new Error("Active tab is not a Fastenal page.");
  }
  if (host !== "fastenal.com" && !host.endsWith(".fastenal.com")) {
    throw new Error("Active tab is not a Fastenal page.");
  }

  if (settings.captureProfile === "single-item") {
    const detail = await executeScraperOnTab(tab.id, scrapeFastenalProductDetailData);
    if (!detail?.ok || !detail.row) {
      throw new Error(detail?.error || "This is not a Fastenal product-detail view.");
    }
    return {
      source: "fastenal",
      captureProfile: "single-item",
      pageType: "product-detail",
      capturedAt: new Date().toISOString(),
      pageTitle: detail.pageTitle,
      pageBreadcrumbs: detail.pageBreadcrumbs || detail.row.ProductDetailBreadcrumbs || "",
      pageUrl: tab.url,
      headers: detail.headers || Object.keys(detail.row),
      rows: [detail.row],
      pagesScraped: 1,
      linkedPagesFound: 0,
      linkedPagesCrawled: 0
    };
  }

  const primary = await executeScraperOnTab(tab.id, scrapeFastenalPageData);
  if (!primary?.ok || !Array.isArray(primary.rows)) {
    const detail = await executeScraperOnTab(tab.id, scrapeFastenalProductDetailData);
    if (detail?.ok && detail.row) {
      return {
        source: "fastenal",
        captureProfile: "single-item",
        pageType: "product-detail",
        capturedAt: new Date().toISOString(),
        pageTitle: detail.pageTitle,
        pageBreadcrumbs: detail.pageBreadcrumbs || detail.row.ProductDetailBreadcrumbs || "",
        pageUrl: tab.url,
        headers: detail.headers || Object.keys(detail.row),
        rows: [detail.row],
        pagesScraped: 1,
        linkedPagesFound: 0,
        linkedPagesCrawled: 0
      };
    }
    throw new Error(primary?.error || detail?.error || "Could not parse this Fastenal page.");
  }

  const allRows = [...primary.rows];
  if (settings.captureProfile === "list-details" && !allRows.some((row) => normalizedUrl(row?.ProductURL))) {
    throw new Error("The selected exporter profile requires a list/table containing product links.");
  }

  for (const row of allRows) {
    row.ProductListPageURL = tab.url;
    row.ProductListPageTitle = primary.pageTitle || row.PageTitle || "";
    row.ProductListBreadcrumbs = primary.pageBreadcrumbs || row.PageBreadcrumbs || "";
    row.SourcePageURL = tab.url;
    row.SourcePageTitle = primary.pageTitle || row.PageTitle || "";
    row.SourcePageBreadcrumbs = primary.pageBreadcrumbs || row.PageBreadcrumbs || "";
  }

  const headerSet = new Set(Array.isArray(primary.headers) ? primary.headers : []);
  let pagesScraped = 1;

  const links = Array.isArray(primary.childLinks) ? primary.childLinks : [];
  const maxLinks = Math.min(500, Math.max(1, Number(settings.maxLinkedPages || 100)));
  const crawlTargets = itemDetailTargets(allRows, links, selectedChildLinks, maxLinks);
  const detailRows = [];

  if (crawlTargets.length > 0) {
    for (const url of crawlTargets) {
      const childTab = await chrome.tabs.create({ url, active: false });
      try {
        await waitForTabLoaded(childTab.id, 30000);
        const detail = await executeScraperOnTab(childTab.id, scrapeFastenalProductDetailData);
        if (detail?.ok && detail.row) {
          detailRows.push(detail.row);
          for (const header of detail.headers || []) headerSet.add(header);
          pagesScraped += 1;
          continue;
        }
        const child = await executeScraperOnTab(childTab.id, scrapeFastenalPageData);
        if (!child?.ok || !Array.isArray(child.rows)) {
          continue;
        }
        for (const row of child.rows) allRows.push(row);
        for (const header of child.headers || []) headerSet.add(header);
        pagesScraped += 1;
      } catch {
        // Continue on one-off linked-page failures.
      } finally {
        if (childTab.id) {
          try {
            await chrome.tabs.remove(childTab.id);
          } catch {
            // no-op
          }
        }
      }
    }
  }

  if (detailRows.length > 0) {
    const merged = mergeRowsWithDetails(allRows, detailRows, "FastenalPartNumber");
    allRows.length = 0;
    allRows.push(...merged);
  }

  for (const row of allRows) {
    for (const key of Object.keys(row || {})) headerSet.add(key);
  }

  const dedupedRows = dedupeRows(allRows);
  if (dedupedRows.length === 0) {
    throw new Error("No product rows found on this Fastenal page or linked child pages.");
  }

  return {
    source: "fastenal",
    captureProfile: "list-details",
    pageType: primary.pageType || "catalog-list",
    capturedAt: new Date().toISOString(),
    pageTitle: primary.pageTitle,
    pageBreadcrumbs: primary.pageBreadcrumbs || "",
    pageUrl: tab.url,
    headers: Array.from(headerSet),
    rows: dedupedRows,
    pagesScraped,
    linkedPagesFound: links.length,
    linkedPagesCrawled: crawlTargets.length
  };
}

