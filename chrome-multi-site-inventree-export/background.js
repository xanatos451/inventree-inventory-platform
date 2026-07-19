const DEFAULT_SETTINGS = {
  inventreeSyncMode: "plugin",
  inventreeUrl: "",
  inventreeToken: "",
  inventreeEndpointPath: "/api/plugin/product-import/",
  inventreePartApiPath: "/api/part/",
  inventreeSupplierPartApiPath: "/api/company/part/",
  inventreeStockItemApiPath: "/api/stock/",
  inventreeDefaultCategoryId: "",
  inventreeDefaultSupplierId: "",
  inventreeDefaultLocationId: "",
  stockQuantityHeaderHint: "",
  defaultStockQuantity: "",
  syncSupplierParts: true,
  syncStockRecords: false,
  sourceMode: "auto",
  crawlLinkedPages: true,
  maxLinkedPages: 20,
  nameHeaderHint: "",
  descriptionHeaderHint: "",
  mpnHeaderHint: "",
  supplierPnHeaderHint: "",
  imageHeaderHint: "",
  includeImageUrls: false,
  uploadImagesIfSupported: false,
  partImageUploadPath: "/api/part/{id}/upload/",
  partIdResponsePath: "",
  existingMatchStrategy: "skip"
};

const LAST_CAPTURE_KEY = "lastCapture";
const LAST_SEND_RESPONSE_KEY = "lastSendResponse";

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const missing = {};
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (existing[key] === undefined) {
      missing[key] = value;
    }
  }
  if (Object.keys(missing).length > 0) {
    await chrome.storage.local.set(missing);
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "getState": {
      const settings = await getSettings();
      const data = await chrome.storage.local.get([LAST_CAPTURE_KEY]);
      return {
        ok: true,
        settings,
        lastCapture: data[LAST_CAPTURE_KEY] || null
      };
    }

    case "saveSettings": {
      const settings = sanitizeSettings(message?.settings || {});
      await chrome.storage.local.set(settings);
      return { ok: true, settings };
    }

    case "capturePage": {
      const incoming = sanitizeSettings(message?.settings || {});
      const persisted = await getSettings();
      const merged = { ...persisted, ...incoming };
      const capture = await captureCurrentTabData(merged, message?.selectedChildLinks || []);
      await chrome.storage.local.set({ [LAST_CAPTURE_KEY]: capture });
      return { ok: true, capture };
    }

    case "previewLinkedPages": {
      const incoming = sanitizeSettings(message?.settings || {});
      const persisted = await getSettings();
      const merged = { ...persisted, ...incoming };
      const { links, itemLabels } = await previewLinkedPages(merged);
      return { ok: true, links, itemLabels };
    }

    case "downloadExport": {
      const format = String(message?.format || "").toLowerCase();
      if (!message?.capture?.rows?.length) {
        return { ok: false, error: "No rows available for export." };
      }

      if (format !== "json" && format !== "csv") {
        return { ok: false, error: "Unsupported export format." };
      }

      const hints = sanitizeSettings(message?.settings || message?.hints || {});
      const filename = buildExportFilename(format);
      let payload;
      let mimeType;

      if (format === "json") {
        payload = buildExportPayload(message.capture, hints);
        mimeType = "application/json";
      } else {
        payload = buildCsvText(message.capture, hints);
        mimeType = "text/csv";
      }

      const url = `data:${mimeType};charset=utf-8,${encodeURIComponent(payload)}`;
      await chrome.downloads.download({
        url,
        filename,
        saveAs: false,
        conflictAction: "uniquify"
      });

      return { ok: true, filename };
    }

    case "sendToInventree": {
      const capture = message?.capture;
      if (!capture?.rows?.length) {
        return { ok: false, error: "No rows available to send." };
      }

      const incoming = sanitizeSettings(message?.settings || {});
      const persisted = await getSettings();
      const merged = { ...persisted, ...incoming };

      if (!merged.inventreeUrl) {
        return { ok: false, error: "InvenTree Base URL is required." };
      }

      if (!merged.inventreeToken) {
        return { ok: false, error: "API token is required." };
      }

      const syncMode = merged.inventreeSyncMode === "direct" ? "direct" : "plugin";
      const result = syncMode === "direct"
        ? await sendDirectToInventree(capture, merged)
        : await sendToInventreePluginEndpoint(capture, merged);

      return result;
    }

    case "dryRunDirectSync": {
      const incoming = sanitizeSettings(message?.settings || {});
      const persisted = await getSettings();
      const merged = { ...persisted, ...incoming };
      return await runDirectSyncDryRun(merged);
    }

    case "testPartIdPath": {
      const settings = sanitizeSettings(message?.settings || {});
      const state = await chrome.storage.local.get([LAST_SEND_RESPONSE_KEY]);
      const saved = state[LAST_SEND_RESPONSE_KEY];
      if (!saved?.bodyText) {
        return { ok: false, error: "No saved API response yet. Send once, then test path." };
      }

      const parsed = tryParseJson(saved.bodyText);
      if (!parsed) {
        return { ok: false, error: "Last response is not valid JSON." };
      }

      const partIds = extractIdsByPath(parsed, settings.partIdResponsePath);
      return {
        ok: true,
        partIds,
        responseStatus: saved.status,
        endpoint: saved.endpoint
      };
    }

    default:
      return { ok: false, error: "Unknown message type." };
  }
}

async function sendToInventreePluginEndpoint(capture, merged) {
  const payload = buildExportObject(capture, merged);
  const filtered = await applyExistingMatchStrategy(payload.items, merged);
  payload.items = filtered.items;
  payload.item_count = payload.items.length;
  payload.options = {
    existing_match_strategy: merged.existingMatchStrategy,
    skipped_existing: filtered.skippedExisting,
    matched_for_update: filtered.matchedForUpdate
  };
  const url = new URL(merged.inventreeEndpointPath || "/api/plugin/product-import/", merged.inventreeUrl).toString();

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${merged.inventreeToken}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  const text = await response.text();
  await chrome.storage.local.set({
    [LAST_SEND_RESPONSE_KEY]: {
      capturedAt: new Date().toISOString(),
      endpoint: url,
      status: response.status,
      ok: response.ok,
      bodyText: String(text || "").slice(0, 500000)
    }
  });
  if (!response.ok) {
    const snippet = (text || "").slice(0, 300);
    return {
      ok: false,
      error: `HTTP ${response.status}: ${snippet || "request failed"}`
    };
  }

  let uploadedImages = 0;
  let skippedImages = 0;
  let imageUploadNote = "";

  if (merged.uploadImagesIfSupported && merged.includeImageUrls) {
    const responseJson = tryParseJson(text);
    const partIds = extractCreatedPartIds(responseJson, merged.partIdResponsePath);
    if (partIds.length === 0) {
      imageUploadNote = "No part IDs found in response, skipped image upload.";
    } else {
      const result = await tryUploadImagesToParts({
        baseUrl: merged.inventreeUrl,
        token: merged.inventreeToken,
        uploadPathTemplate: merged.partImageUploadPath,
        partIds,
        items: payload.items
      });
      uploadedImages = result.uploaded;
      skippedImages = result.skipped;
      if (result.firstError) {
        imageUploadNote = `Image upload issue: ${result.firstError}`;
      }
    }
  }

  return {
    ok: true,
    mode: "plugin",
    status: response.status,
    sentCount: payload.items.length,
    skippedExisting: filtered.skippedExisting,
    matchedForUpdate: filtered.matchedForUpdate,
    uploadedImages,
    skippedImages,
    imageUploadNote,
    responsePreview: (text || "").slice(0, 300)
  };
}

async function sendDirectToInventree(capture, settings) {
  const payload = buildExportObject(capture, settings);
  const filtered = await applyExistingMatchStrategy(payload.items, settings);
  const items = filtered.items;

  if (items.length === 0) {
    return {
      ok: true,
      mode: "direct",
      status: 200,
      sentCount: 0,
      skippedExisting: filtered.skippedExisting,
      matchedForUpdate: filtered.matchedForUpdate,
      createdParts: 0,
      updatedParts: 0,
      failedParts: 0,
      syncedSupplierParts: 0,
      createdStockItems: 0,
      uploadedImages: 0,
      skippedImages: 0,
      imageUploadNote: ""
    };
  }

  const categoryId = parsePositiveInt(settings.inventreeDefaultCategoryId);
  if (!categoryId) {
    return { ok: false, error: "Direct API mode requires a Default Category ID." };
  }

  const supplierId = parsePositiveInt(settings.inventreeDefaultSupplierId);
  const locationId = parsePositiveInt(settings.inventreeDefaultLocationId);

  let createdParts = 0;
  let updatedParts = 0;
  let failedParts = 0;
  let syncedSupplierParts = 0;
  let createdStockItems = 0;
  let firstIssue = "";

  const imageItems = [];
  const imagePartIds = [];

  for (const item of items) {
    try {
      const result = await createOrUpdatePartInDirectMode(item, settings, categoryId);
      if (!result.ok || !result.partId) {
        failedParts += 1;
        if (!firstIssue && result.error) firstIssue = result.error;
        continue;
      }

      if (result.action === "update") {
        updatedParts += 1;
      } else {
        createdParts += 1;
      }

      if (settings.syncSupplierParts && supplierId) {
        const syncResult = await upsertSupplierPartForDirectMode(result.partId, supplierId, item, settings);
        if (syncResult.ok) {
          syncedSupplierParts += 1;
        } else if (!firstIssue && syncResult.error) {
          firstIssue = syncResult.error;
        }
      }

      if (settings.syncStockRecords && locationId) {
        const stockResult = await createStockItemForDirectMode(result.partId, locationId, item, settings);
        if (stockResult.created) {
          createdStockItems += 1;
        } else if (stockResult.error && !firstIssue) {
          firstIssue = stockResult.error;
        }
      }

      imagePartIds.push(result.partId);
      imageItems.push(item);
    } catch (error) {
      failedParts += 1;
      if (!firstIssue) {
        firstIssue = String(error?.message || error);
      }
    }
  }

  let uploadedImages = 0;
  let skippedImages = 0;
  let imageUploadNote = "";
  if (settings.uploadImagesIfSupported && settings.includeImageUrls && imagePartIds.length > 0) {
    const uploadResult = await tryUploadImagesToParts({
      baseUrl: settings.inventreeUrl,
      token: settings.inventreeToken,
      uploadPathTemplate: settings.partImageUploadPath,
      partIds: imagePartIds,
      items: imageItems
    });
    uploadedImages = uploadResult.uploaded;
    skippedImages = uploadResult.skipped;
    if (uploadResult.firstError) {
      imageUploadNote = uploadResult.firstError;
    }
  }

  const status = failedParts > 0 ? 207 : 200;
  const responseSummary = {
    mode: "direct",
    status,
    sentCount: items.length,
    skippedExisting: filtered.skippedExisting,
    matchedForUpdate: filtered.matchedForUpdate,
    createdParts,
    updatedParts,
    failedParts,
    syncedSupplierParts,
    createdStockItems,
    uploadedImages,
    skippedImages,
    imageUploadNote,
    issue: firstIssue
  };

  await chrome.storage.local.set({
    [LAST_SEND_RESPONSE_KEY]: {
      capturedAt: new Date().toISOString(),
      endpoint: "direct-api",
      status,
      ok: true,
      bodyText: JSON.stringify(responseSummary)
    }
  });

  return {
    ok: true,
    ...responseSummary
  };
}

async function runDirectSyncDryRun(settings) {
  const checks = [];

  if (settings.inventreeSyncMode !== "direct") {
    checks.push({ ok: false, label: "Sync mode", message: "Dry-run is only for Direct InvenTree API mode." });
    return { ok: true, checks };
  }

  checks.push({ ok: Boolean(settings.inventreeUrl), label: "InvenTree Base URL", message: settings.inventreeUrl ? "Configured" : "Required" });
  checks.push({ ok: Boolean(settings.inventreeToken), label: "API token", message: settings.inventreeToken ? "Configured" : "Required" });

  const categoryId = parsePositiveInt(settings.inventreeDefaultCategoryId);
  checks.push({
    ok: Boolean(categoryId),
    label: "Default Category ID",
    message: categoryId ? `Configured (${categoryId})` : "Required for direct part creation"
  });

  const supplierId = parsePositiveInt(settings.inventreeDefaultSupplierId);
  if (settings.syncSupplierParts) {
    checks.push({
      ok: true,
      label: "Default Supplier ID",
      message: supplierId
        ? `Configured (${supplierId})`
        : "Optional. Supplier-part sync is skipped when no default supplier ID is set."
    });
  }

  const locationId = parsePositiveInt(settings.inventreeDefaultLocationId);
  if (settings.syncStockRecords) {
    checks.push({
      ok: Boolean(locationId),
      label: "Default Stock Location ID",
      message: locationId ? `Configured (${locationId})` : "Required when stock sync is enabled"
    });
  }

  const quantity = Number(String(settings.defaultStockQuantity || "").trim());
  if (settings.syncStockRecords) {
    checks.push({
      ok: Number.isFinite(quantity) ? quantity > 0 : Boolean(String(settings.stockQuantityHeaderHint || "").trim()),
      label: "Stock quantity source",
      message: "Provide a positive default stock quantity or stock quantity header hint"
    });
  }

  if (!settings.inventreeUrl || !settings.inventreeToken) {
    return { ok: true, checks };
  }

  const probeTargets = [
    { label: "Part API path", path: settings.inventreePartApiPath }
  ];
  if (settings.syncSupplierParts && supplierId) {
    probeTargets.push({ label: "Supplier Part API path", path: settings.inventreeSupplierPartApiPath });
  }
  if (settings.syncStockRecords && locationId) {
    probeTargets.push({ label: "Stock Item API path", path: settings.inventreeStockItemApiPath });
  }

  for (const target of probeTargets) {
    const endpoint = new URL(target.path, settings.inventreeUrl);
    endpoint.searchParams.set("limit", "1");
    try {
      const response = await fetch(endpoint.toString(), {
        method: "GET",
        headers: {
          Authorization: `Token ${settings.inventreeToken}`
        }
      });
      checks.push({
        ok: response.ok,
        label: target.label,
        message: response.ok ? `Reachable (${response.status})` : `HTTP ${response.status}`
      });
    } catch (error) {
      checks.push({
        ok: false,
        label: target.label,
        message: String(error?.message || error)
      });
    }
  }

  return { ok: true, checks };
}

async function createOrUpdatePartInDirectMode(item, settings, categoryId) {
  const existingPartId = parsePositiveInt(item.existing_part_id);
  const shouldUpdate = item.sync_action === "update" && existingPartId;
  const ipn = String(item.supplier_part_number || item.mpn || "").trim();
  const partBody = {
    name: String(item.name || "").trim() || "Imported Product",
    description: String(item.description || "").trim(),
    category: categoryId,
    IPN: ipn
  };

  if (shouldUpdate) {
    const patchBody = {
      name: partBody.name,
      description: partBody.description,
      IPN: partBody.IPN
    };
    const response = await inventreeApiRequest(settings, "PATCH", `${trimTrailingSlash(settings.inventreePartApiPath)}/${existingPartId}/`, patchBody);
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, error: `Part update failed (${response.status}): ${text.slice(0, 200)}` };
    }
    return { ok: true, action: "update", partId: existingPartId };
  }

  const response = await inventreeApiRequest(settings, "POST", settings.inventreePartApiPath, partBody);
  if (!response.ok) {
    const text = await response.text();
    return { ok: false, error: `Part create failed (${response.status}): ${text.slice(0, 200)}` };
  }

  const created = await response.json();
  const partId = parsePositiveInt(created?.pk ?? created?.id);
  if (!partId) {
    return { ok: false, error: "Part create succeeded but no part ID was returned." };
  }

  return { ok: true, action: "create", partId };
}

async function upsertSupplierPartForDirectMode(partId, supplierId, item, settings) {
  const sku = String(item.supplier_part_number || "").trim();
  if (!sku) {
    return { ok: false, error: "Supplier part sync skipped because supplier part number is empty." };
  }

  const searchUrl = new URL(settings.inventreeSupplierPartApiPath, settings.inventreeUrl);
  searchUrl.searchParams.set("part", String(partId));
  searchUrl.searchParams.set("supplier", String(supplierId));
  const lookup = await fetch(searchUrl.toString(), {
    headers: {
      Authorization: `Token ${settings.inventreeToken}`
    }
  });

  if (!lookup.ok) {
    const text = await lookup.text();
    return { ok: false, error: `Supplier part lookup failed (${lookup.status}): ${text.slice(0, 200)}` };
  }

  const lookupJson = await lookup.json();
  const existingList = Array.isArray(lookupJson) ? lookupJson : Array.isArray(lookupJson?.results) ? lookupJson.results : [];
  const existing = existingList.find((row) => String(row?.SKU || "").trim() === sku) || existingList[0];

  const body = {
    part: partId,
    supplier: supplierId,
    SKU: sku,
    MPN: String(item.mpn || "").trim(),
    link: String(item.supplier_link || "").trim(),
    description: String(item.description || "").trim()
  };

  const endpoint = existing?.pk || existing?.id
    ? `${trimTrailingSlash(settings.inventreeSupplierPartApiPath)}/${existing.pk ?? existing.id}/`
    : settings.inventreeSupplierPartApiPath;
  const method = existing?.pk || existing?.id ? "PATCH" : "POST";
  const response = await inventreeApiRequest(settings, method, endpoint, body);
  if (!response.ok) {
    const text = await response.text();
    return { ok: false, error: `Supplier part sync failed (${response.status}): ${text.slice(0, 200)}` };
  }

  return { ok: true };
}

async function createStockItemForDirectMode(partId, locationId, item, settings) {
  const quantity = parseQuantityForDirectMode(item, settings);
  if (!(quantity > 0)) {
    return { created: false };
  }

  const body = {
    part: partId,
    location: locationId,
    quantity
  };
  const response = await inventreeApiRequest(settings, "POST", settings.inventreeStockItemApiPath, body);
  if (!response.ok) {
    const text = await response.text();
    return { created: false, error: `Stock item create failed (${response.status}): ${text.slice(0, 200)}` };
  }

  return { created: true };
}

function parseQuantityForDirectMode(item, settings) {
  const hinted = pickValue(item.raw || {}, [settings.stockQuantityHeaderHint]);
  const hintedNumber = Number(String(hinted || "").replace(/[^0-9.\-]/g, ""));
  if (Number.isFinite(hintedNumber) && hintedNumber > 0) {
    return hintedNumber;
  }

  const fallback = Number(String(settings.defaultStockQuantity || "").trim());
  if (Number.isFinite(fallback) && fallback > 0) {
    return fallback;
  }

  return 0;
}

async function inventreeApiRequest(settings, method, path, body) {
  const url = new URL(path, settings.inventreeUrl).toString();
  const options = {
    method,
    headers: {
      Authorization: `Token ${settings.inventreeToken}`,
      "Content-Type": "application/json"
    }
  };

  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  return await fetch(url, options);
}

function parsePositiveInt(value) {
  const num = Number(String(value ?? "").trim());
  return Number.isInteger(num) && num > 0 ? num : null;
}

function trimTrailingSlash(path) {
  return String(path || "").replace(/\/+$/, "");
}

async function getSettings() {
  const data = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return sanitizeSettings({ ...DEFAULT_SETTINGS, ...data });
}

function sanitizeSettings(input) {
  const inventreeSyncMode = String(input.inventreeSyncMode || "plugin").trim().toLowerCase();
  const sourceMode = String(input.sourceMode || "auto").trim().toLowerCase();
  const sourceModeSafe = ["auto", "mcmaster", "boltdepot", "amazon"].includes(sourceMode) ? sourceMode : "auto";
  return {
    inventreeSyncMode: inventreeSyncMode === "direct" ? "direct" : "plugin",
    inventreeUrl: String(input.inventreeUrl || "").trim(),
    inventreeToken: String(input.inventreeToken || "").trim(),
    inventreeEndpointPath: normalizePath(input.inventreeEndpointPath, "/api/plugin/product-import/"),
    inventreePartApiPath: normalizePath(input.inventreePartApiPath, "/api/part/"),
    inventreeSupplierPartApiPath: normalizePath(input.inventreeSupplierPartApiPath, "/api/company/part/"),
    inventreeStockItemApiPath: normalizePath(input.inventreeStockItemApiPath, "/api/stock/"),
    inventreeDefaultCategoryId: String(input.inventreeDefaultCategoryId || "").trim(),
    inventreeDefaultSupplierId: String(input.inventreeDefaultSupplierId || "").trim(),
    inventreeDefaultLocationId: String(input.inventreeDefaultLocationId || "").trim(),
    stockQuantityHeaderHint: String(input.stockQuantityHeaderHint || "").trim(),
    defaultStockQuantity: String(input.defaultStockQuantity || "").trim(),
    syncSupplierParts: input.syncSupplierParts !== false,
    syncStockRecords: Boolean(input.syncStockRecords),
    sourceMode: sourceModeSafe,
    crawlLinkedPages: Boolean(input.crawlLinkedPages),
    maxLinkedPages: Math.min(80, Math.max(1, Number(input.maxLinkedPages || 20))),
    nameHeaderHint: String(input.nameHeaderHint || "").trim(),
    descriptionHeaderHint: String(input.descriptionHeaderHint || "").trim(),
    mpnHeaderHint: String(input.mpnHeaderHint || "").trim(),
    supplierPnHeaderHint: String(input.supplierPnHeaderHint || "").trim(),
    imageHeaderHint: String(input.imageHeaderHint || "").trim(),
    includeImageUrls: Boolean(input.includeImageUrls),
    uploadImagesIfSupported: Boolean(input.uploadImagesIfSupported),
    partImageUploadPath: normalizePath(input.partImageUploadPath, "/api/part/{id}/upload/"),
    partIdResponsePath: String(input.partIdResponsePath || "").trim(),
    existingMatchStrategy: input.existingMatchStrategy === "update" ? "update" : "skip"
  };
}

function normalizePath(value, defaultPath) {
  const fallback = String(defaultPath || "/").trim() || "/";
  const path = String(value || "").trim() || fallback;
  return path.startsWith("/") ? path : `/${path}`;
}

async function captureCurrentTabData(settings, selectedChildLinks) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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

  throw new Error("Unsupported page. Open a McMaster-Carr, Bolt Depot, or Amazon orders/order-detail page.");
}

async function previewLinkedPages(settings) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    throw new Error("No active tab available.");
  }

  const provider = detectProvider(tab.url, settings.sourceMode);
  const maxLinks = Math.min(80, Math.max(1, Number(settings.maxLinkedPages || 20)));

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

  if (provider !== "boltdepot" && provider !== "mcmaster") {
    return { links: [], itemLabels: {} };
  }

  const data = provider === "boltdepot"
    ? await executeScraperOnTab(tab.id, scrapeBoltDepotPageData)
    : await executeScraperOnTab(tab.id, scrapeMcMasterCategoryData);
  const links = Array.isArray(data?.childLinks) ? data.childLinks : [];
  return { links: links.slice(0, maxLinks), itemLabels: {} };
}

function detectProvider(url, sourceMode) {
  const mode = String(sourceMode || "auto").toLowerCase();
  if (mode === "mcmaster" || mode === "boltdepot" || mode === "amazon") {
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
  return "";
}

async function executeScraperOnTab(tabId, scraper) {
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: scraper
  });
  return injected?.[0]?.result || null;
}

async function captureMcmasterTab(tab, settings, selectedChildLinks) {
  if (!/mcmaster\.com/i.test(tab.url || "")) {
    throw new Error("Active tab is not a McMaster-Carr page.");
  }

  const primary = await executeScraperOnTab(tab.id, scrapeMcMasterCategoryData);
  if (!primary?.ok) {
    throw new Error(primary?.error || "Could not parse McMaster table data on this page.");
  }

  const allRows = Array.isArray(primary.rows) ? [...primary.rows] : [];
  const headerSet = new Set(Array.isArray(primary.headers) ? primary.headers : []);
  let pagesScraped = 1;

  const links = Array.isArray(primary.childLinks) ? primary.childLinks : [];
  const shouldCrawl = Boolean(settings.crawlLinkedPages);
  const maxLinks = Math.min(80, Math.max(1, Number(settings.maxLinkedPages || 20)));
  const selected = Array.isArray(selectedChildLinks)
    ? selectedChildLinks.map((item) => String(item || "").trim()).filter(Boolean)
    : [];

  let crawlTargets = links.slice(0, maxLinks);
  if (selected.length > 0) {
    const selectedSet = new Set(selected);
    crawlTargets = crawlTargets.filter((url) => selectedSet.has(url));
  }

  if (shouldCrawl && crawlTargets.length > 0) {
    for (const url of crawlTargets) {
      const childTab = await chrome.tabs.create({ url, active: false });
      try {
        await waitForTabLoaded(childTab.id, 30000);
        const child = await executeScraperOnTab(childTab.id, scrapeMcMasterCategoryData);
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
        // Continue with remaining pages on one-off failures.
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

  const dedupedRows = dedupeRows(allRows);
  if (dedupedRows.length === 0) {
    throw new Error("No product rows found on this McMaster page or linked child pages.");
  }

  return {
    source: "mcmaster-carr",
    capturedAt: new Date().toISOString(),
    pageTitle: primary.pageTitle,
    pageUrl: tab.url,
    headers: Array.from(headerSet),
    rows: dedupedRows,
    pagesScraped,
    linkedPagesFound: links.length,
    linkedPagesCrawled: shouldCrawl ? crawlTargets.length : 0
  };
}

async function captureBoltDepotTab(tab, settings, selectedChildLinks) {
  if (!/boltdepot\.com/i.test(tab.url || "")) {
    throw new Error("Active tab is not a Bolt Depot page.");
  }

  const primary = await executeScraperOnTab(tab.id, scrapeBoltDepotPageData);
  if (!primary?.ok) {
    throw new Error(primary?.error || "Could not parse Bolt Depot page data.");
  }

  const allRows = Array.isArray(primary.rows) ? [...primary.rows] : [];
  const headerSet = new Set(Array.isArray(primary.headers) ? primary.headers : []);
  let pagesScraped = 1;

  const links = Array.isArray(primary.childLinks) ? primary.childLinks : [];
  const shouldCrawl = Boolean(settings.crawlLinkedPages);
  const maxLinks = Math.min(80, Math.max(1, Number(settings.maxLinkedPages || 20)));
  const selected = Array.isArray(selectedChildLinks)
    ? selectedChildLinks.map((item) => String(item || "").trim()).filter(Boolean)
    : [];

  let crawlTargets = links.slice(0, maxLinks);
  if (selected.length > 0) {
    const selectedSet = new Set(selected);
    crawlTargets = crawlTargets.filter((url) => selectedSet.has(url));
  }

  if (shouldCrawl && crawlTargets.length > 0) {
    for (const url of crawlTargets) {
      const childTab = await chrome.tabs.create({ url, active: false });
      try {
        await waitForTabLoaded(childTab.id, 30000);
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

  const dedupedRows = dedupeRows(allRows);
  if (dedupedRows.length === 0) {
    throw new Error("No product rows found on this Bolt Depot page or linked child pages.");
  }

  return {
    source: "boltdepot",
    capturedAt: new Date().toISOString(),
    pageTitle: primary.pageTitle,
    pageUrl: tab.url,
    headers: Array.from(headerSet),
    rows: dedupedRows,
    pagesScraped,
    linkedPagesFound: links.length,
    linkedPagesCrawled: shouldCrawl ? crawlTargets.length : 0
  };
}

// ─── Amazon order-page + product-page capture ────────────────────────────────

async function captureAmazonTab(tab, settings, selectedOrderItems) {
  if (!/amazon\./i.test(tab.url || "")) {
    throw new Error("Active tab is not an Amazon page.");
  }

  const primary = await executeScraperOnTab(tab.id, scrapeAmazonOrderItems);
  if (!primary?.ok) {
    throw new Error(
      primary?.error ||
        "Could not find Amazon product links on this page. Navigate to an order history or order details page."
    );
  }

  const allItems = Array.isArray(primary.items) ? primary.items : [];

  const selected = Array.isArray(selectedOrderItems)
    ? selectedOrderItems.map((url) => String(url || "").trim()).filter(Boolean)
    : [];

  const maxLinks = Math.min(80, Math.max(1, Number(settings.maxLinkedPages || 20)));

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

      allRows.push(product.row);
      for (const header of product.headers || []) {
        headerSet.add(header);
      }
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

// Injected into the active Amazon tab to collect order item links.
function scrapeAmazonOrderItems() {
  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  const items = [];
  const seen = new Set();

  for (const link of Array.from(document.querySelectorAll("a[href]"))) {
    const href = link.getAttribute("href") || "";

    let parsed;
    try {
      parsed = new URL(href, location.href);
    } catch {
      continue;
    }

    if (!parsed.hostname.includes("amazon.")) continue;

    // Require a recognisable Amazon product path.
    const asinMatch = parsed.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    if (!asinMatch) continue;

    const asin = asinMatch[1].toUpperCase();
    if (seen.has(asin)) continue;
    seen.add(asin);

    // Canonical product URL – strip query / hash.
    const productUrl = `${parsed.origin}/dp/${asin}`;

    // Best available display label.
    let label = normalizeText(link.textContent);
    if (!label || label.length < 5) {
      label = normalizeText(link.getAttribute("title") || "");
    }
    if (!label || label.length < 5) {
      const container = link.closest(
        "[data-asin], .a-fixed-right-grid, .item-container, .shipment-container, li"
      );
      if (container) {
        const titleEl = container.querySelector(
          ".a-link-normal[title], .a-text-bold, .product-title"
        );
        label = normalizeText(
          titleEl?.getAttribute("title") || titleEl?.textContent || ""
        );
      }
    }
    if (!label || label.length < 3) {
      label = `ASIN: ${asin}`;
    }

    // Optional thumbnail.
    let imageUrl = "";
    const container =
      link.closest("[data-asin], .a-fixed-right-grid, .item-container, li") ||
      link.parentElement;
    if (container) {
      const img = container.querySelector("img[src]");
      const src = img?.getAttribute("src") || "";
      if (src && !src.includes("transparent-pixel") && !src.startsWith("data:")) {
        imageUrl = src;
      }
    }

    items.push({ url: productUrl, label, asin, imageUrl });
  }

  return {
    ok: items.length > 0,
    items,
    pageTitle: normalizeText(
      document.querySelector("h1")?.textContent || document.title || "Amazon Orders"
    ),
    error:
      items.length === 0
        ? "No Amazon product links found. Navigate to an order history or order details page."
        : undefined
  };
}

// Injected into an individual Amazon product page to extract spec data.
function scrapeAmazonProductPage() {
  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  // ASIN
  let asin = "";
  const asinMatch = location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
  if (asinMatch) asin = asinMatch[1].toUpperCase();

  // Title
  const titleEl =
    document.getElementById("productTitle") ||
    document.querySelector("span#productTitle") ||
    document.querySelector("h1.a-size-large") ||
    document.querySelector("h1");
  const title = normalizeText(titleEl?.textContent || document.title || "");

  // Brand
  const brandEl =
    document.getElementById("bylineInfo") ||
    document.querySelector("#brand") ||
    document.querySelector("a#bylineInfo_feature_div a");
  const brand = normalizeText(
    (brandEl?.textContent || "")
      .replace(/^Visit the\s+/i, "")
      .replace(/\s+Store$/i, "")
  );

  // Main image – prefer the highest-resolution entry in data-a-dynamic-image.
  let imageUrl = "";
  const landingImg =
    document.getElementById("landingImage") ||
    document.getElementById("imgBlkFront");
  if (landingImg) {
    const dynamicData = landingImg.getAttribute("data-a-dynamic-image");
    if (dynamicData) {
      try {
        const imgMap = JSON.parse(dynamicData);
        let bestUrl = "";
        let bestArea = 0;
        for (const [url, dims] of Object.entries(imgMap)) {
          const area = Array.isArray(dims) ? (dims[0] || 0) * (dims[1] || 0) : 0;
          if (area > bestArea) {
            bestArea = area;
            bestUrl = url;
          }
        }
        imageUrl = bestUrl;
      } catch {
        // fall through
      }
    }
    if (!imageUrl) {
      imageUrl =
        landingImg.getAttribute("data-old-hires") ||
        landingImg.getAttribute("src") ||
        "";
    }
  }

  // Price
  const priceEl =
    document.querySelector(".a-price .a-offscreen") ||
    document.querySelector(".apexPriceToPay .a-offscreen") ||
    document.querySelector("#priceblock_ourprice") ||
    document.querySelector("#priceblock_dealprice") ||
    document.querySelector(".a-price");
  const price = normalizeText(priceEl?.textContent || "");

  // Technical specs table (new and old Amazon layouts).
  const specsObj = {};

  const specRows = Array.from(
    document.querySelectorAll(
      "#productDetails_techSpec_section_1 tr, " +
        "#productDetails_detailBullets_sections1 tr, " +
        "#productDetails_db_sections tr, " +
        "#tech-specs-table tr, " +
        ".product-specs-table tr"
    )
  );
  for (const row of specRows) {
    const th = normalizeText(row.querySelector("th")?.textContent || "");
    const td = normalizeText(row.querySelector("td")?.textContent || "");
    if (th && td) specsObj[th] = td;
  }

  // Detail-bullets list (older Amazon layout).
  const bulletItems = Array.from(
    document.querySelectorAll(
      "#detailBullets_feature_div .a-list-item, " +
        "#detail-bullets .a-list-item, " +
        ".detail-bullet-list .a-list-item"
    )
  );
  for (const item of bulletItems) {
    const spans = item.querySelectorAll("span");
    if (spans.length >= 2) {
      const key = normalizeText(spans[0].textContent).replace(/:$/, "").trim();
      const value = normalizeText(spans[1].textContent).trim();
      if (key && value && key.length < 80) specsObj[key] = value;
    } else {
      const text = normalizeText(item.textContent);
      const colonIdx = text.indexOf(":");
      if (colonIdx > 0 && colonIdx < 80) {
        const key = text.slice(0, colonIdx).trim();
        const value = text.slice(colonIdx + 1).trim();
        if (key && value) specsObj[key] = value;
      }
    }
  }

  // Feature bullets (description).
  const featureBullets = Array.from(
    document.querySelectorAll(
      "#feature-bullets ul li span.a-list-item, " +
        "#feature-bullets .a-unordered-list li span"
    )
  )
    .map((el) => normalizeText(el.textContent))
    .filter((text) => text && text.length > 10)
    .slice(0, 5);

  const description =
    featureBullets.join("; ") ||
    normalizeText(
      document.querySelector("#productDescription p, #productDescription")?.textContent || ""
    );

  // Model number (common Amazon spec labels).
  const modelNumber =
    specsObj["Item model number"] ||
    specsObj["Model Number"] ||
    specsObj["Model"] ||
    specsObj["Part Number"] ||
    "";

  // Category breadcrumbs.
  const breadcrumbs = Array.from(
    document.querySelectorAll(
      "#wayfinding-breadcrumbs_feature_div a, .a-breadcrumb a"
    )
  )
    .map((el) => normalizeText(el.textContent))
    .filter(Boolean);
  const category = breadcrumbs.join(" > ");

  const row = {
    "Product Name": title,
    "Brand": brand,
    "ASIN": asin,
    "Model Number": modelNumber,
    "Category": category,
    "Description": description,
    "Price": price,
    "Product URL": location.href,
    "Image URL": imageUrl,
    ...specsObj
  };

  const headers = Object.keys(row);

  return {
    ok: Boolean(title),
    title,
    asin,
    headers,
    row,
    imageUrl,
    productUrl: location.href,
    error: title
      ? undefined
      : "Could not extract product title from this Amazon product page."
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const key = [
      String(row?.McMasterPartNumber || row?.BoltDepotPartNumber || row?.PartNumber || row?.ASIN || "").trim(),
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

async function waitForTabLoaded(tabId, timeoutMs) {
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
  });
}

function scrapeBoltDepotPageData() {
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
    const currentPath = location.pathname.replace(/\/+$/, "");
    const links = [];
    const seen = new Set();
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
      if (!path.startsWith(`${currentPath}_`)) continue;
      if (seen.has(abs)) continue;
      seen.add(abs);
      links.push(abs);
    }
    return links;
  }

  function scoreTable(table) {
    const rows = table.querySelectorAll("tr").length;
    const cells = table.querySelectorAll("td,th").length;
    const text = normalizeText(table.textContent || "").toLowerCase();
    const keywordBoost = /part|price|diameter|thread|length|qty|quantity/.test(text) ? 25 : 0;
    return rows * 3 + cells + keywordBoost;
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

  const childLinks = getChildLinks();
  const tables = Array.from(document.querySelectorAll("table"));
  if (tables.length === 0) {
    return {
      ok: true,
      pageTitle: normalizeText(document.querySelector("h1")?.textContent || document.title || "Bolt Depot"),
      headers: ["SourcePageURL"],
      rows: [],
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

    const looksData = nonEmpty >= 3 || Boolean(partGuess) || Boolean(rowUrl);
    if (!looksData) continue;

    rowObj.ProductURL = rowUrl;
    rowObj.BoltDepotPartNumber = partGuess;
    rowObj.RowImageURL = rowImage;
    rowObj.SourcePageURL = location.href;
    dataRows.push(rowObj);
  }

  return {
    ok: true,
    pageTitle: normalizeText(document.querySelector("h1")?.textContent || document.title || "Bolt Depot"),
    headers: Array.from(new Set([...headers, "ProductURL", "BoltDepotPartNumber", "RowImageURL", "SourcePageURL"])),
    rows: dataRows,
    childLinks
  };
}

function scrapeMcMasterCategoryData() {
  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function firstImageSrc(container) {
    const image = container?.querySelector("img[src], img[data-src], img[data-original], source[srcset]");
    if (!image) return "";

    const srcset = image.getAttribute("srcset") || "";
    if (srcset) {
      const first = srcset.split(",")[0]?.trim().split(" ")[0];
      if (first) {
        try {
          return new URL(first, location.href).toString();
        } catch {
          return first;
        }
      }
    }

    const raw = image.getAttribute("src") || image.getAttribute("data-src") || image.getAttribute("data-original") || "";
    if (!raw) return "";
    try {
      return new URL(raw, location.href).toString();
    } catch {
      return raw;
    }
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

  function extractRowsFromProductLinks(sectionImageCandidates) {
    const out = [];
    const seen = new Set();
    const anchors = Array.from(document.querySelectorAll("a[href]"));

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
      if (!partNumber && !isProductPath) continue;

      const container = anchor.closest("tr, li, article, section, div") || anchor.parentElement || anchor;
      const containerText = normalizeText(container?.textContent || "");
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
        RowImageSource: rowImageUrl && rowImageUrl === sectionImageCandidates[0] ? "section-fallback" : (rowImageUrl ? "row" : "none")
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
    const rows = getBodyRows(table);
    const rowCount = rows.length;
    const colCount = Math.max(...rows.map((row) => row.querySelectorAll("td,th").length), 0);
    const partLinks = table.querySelectorAll("a[href*='/products/'], a[href*='mcmaster.com']").length;
    const headText = normalizeText(table.textContent || "").toLowerCase();
    const hasPartLikeHeader = /part\s*number|stock\s*number|mcmaster/i.test(headText) ? 4 : 0;
    return rowCount * colCount + hasPartLikeHeader + (partLinks * 5);
  }

  const tables = Array.from(document.querySelectorAll("table"));
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
    rows.push(obj);
  }

  if (rows.length === 0) {
    const fallbackRows = extractRowsFromProductLinks(sectionImageCandidates);
    if (fallbackRows.length === 0) {
      return { ok: false, error: "No product rows found in selected table." };
    }

    return {
      ok: true,
      headers: ["Product", "Description", "ProductURL", "McMasterPartNumber", "RowImageURL", "RowImageSource"],
      rows: fallbackRows,
      pageTitle: normalizeText(document.querySelector("h1")?.textContent || document.title || "McMaster Category"),
      childLinks
    };
  }

  const titleEl = document.querySelector("h1");
  const pageTitle = normalizeText(titleEl?.textContent || document.title || "McMaster Category");
  return {
    ok: true,
    headers: Array.from(new Set([...headers, "ProductURL", "McMasterPartNumber", "RowImageURL", "RowImageSource"])),
    rows,
    pageTitle,
    childLinks
  };
}

function buildExportFilename(format) {
  const ts = new Date().toISOString().replace(/[:]/g, "-").replace(/\..+$/, "");
  return `product-inventory-export/${ts}-captured-catalog.${format}`;
}

function buildExportPayload(capture, hints) {
  return JSON.stringify(buildExportObject(capture, hints), null, 2);
}

function buildExportObject(capture, hints) {
  const items = capture.rows.map((row) => toInventreeItem(row, hints));
  return {
    source: capture.source || "catalog",
    captured_at: capture.capturedAt,
    page_title: capture.pageTitle,
    page_url: capture.pageUrl,
    pages_scraped: Number(capture.pagesScraped || 1),
    header_list: capture.headers,
    item_count: items.length,
    items
  };
}

function toInventreeItem(row, hints) {
  const rowKeys = Object.keys(row || {});
  const name = pickValue(row, [
    hints.nameHeaderHint,
    "Product Name",
    "Product",
    "Description",
    "Name"
  ]) || row.McMasterPartNumber || row.ASIN || "Product";

  const description = pickValue(row, [
    hints.descriptionHeaderHint,
    "Description",
    "Product",
    "Product Name"
  ]);

  const mpn = pickValue(row, [
    hints.mpnHeaderHint,
    "MPN",
    "Mfr. Part No.",
    "Manufacturer Part Number",
    "McMasterPartNumber",
    "ASIN"
  ]);

  const supplierPn = pickValue(row, [
    hints.supplierPnHeaderHint,
    "McMasterPartNumber",
    "BoltDepotPartNumber",
    "Part #",
    "Part Number",
    "Item model number",
    "Model Number"
  ]);

  const imageUrl = hints.includeImageUrls
    ? pickImageUrl(row, hints.imageHeaderHint)
    : "";

  return {
    name,
    description,
    mpn,
    supplier_part_number: supplierPn,
    supplier_link: row.ProductURL || row["Product URL"] || "",
    image_url: imageUrl,
    source_fields: rowKeys,
    raw: row
  };
}

function pickImageUrl(row, imageHeaderHint) {
  const hint = String(imageHeaderHint || "").trim().toLowerCase();
  if (hint) {
    for (const [key, value] of Object.entries(row || {})) {
      if (String(key).trim().toLowerCase() === hint) {
        const found = firstImageUrlInText(value);
        if (found) return found;
      }
    }
  }

  for (const [key, value] of Object.entries(row || {})) {
    const keyLc = String(key || "").toLowerCase();
    if (keyLc.includes("image") || keyLc.includes("photo") || keyLc.includes("thumbnail") || keyLc.includes("picture")) {
      const found = firstImageUrlInText(value);
      if (found) return found;
    }
  }

  for (const value of Object.values(row || {})) {
    const found = firstImageUrlInText(value);
    if (found) return found;
  }

  return "";
}

function firstImageUrlInText(value) {
  const text = String(value || "");
  const urlMatch = text.match(/https?:\/\/[^\s"'<>]+/i);
  if (!urlMatch) return "";
  const url = urlMatch[0];
  const lower = url.toLowerCase();
  if (/(\.png|\.jpe?g|\.gif|\.webp|\.avif|\.bmp|\.svg|\.tiff?)(\?|#|$)/.test(lower)) {
    return url;
  }
  if (lower.includes("image") || lower.includes("photo") || lower.includes("thumbnail")) {
    return url;
  }
  return "";
}

function pickValue(row, candidates) {
  const candidateSet = new Set(
    candidates
      .map((item) => String(item || "").trim().toLowerCase())
      .filter(Boolean)
  );

  for (const [key, value] of Object.entries(row || {})) {
    if (candidateSet.has(String(key).trim().toLowerCase())) {
      const text = String(value || "").trim();
      if (text) return text;
    }
  }

  return "";
}

function buildCsvText(capture, hints) {
  const exportObj = buildExportObject(capture, hints);
  const rowFieldUnion = new Set();
  for (const item of exportObj.items) {
    Object.keys(item.raw || {}).forEach((key) => rowFieldUnion.add(key));
  }

  const columns = [
    "name",
    "description",
    "mpn",
    "supplier_part_number",
    "supplier_link",
    "image_url",
    "source_page_title",
    "source_page_url",
    ...Array.from(rowFieldUnion)
  ];

  const lines = [];
  lines.push(columns.map(csvEscape).join(","));

  for (const item of exportObj.items) {
    const line = columns.map((column) => {
      switch (column) {
        case "name":
          return csvEscape(item.name);
        case "description":
          return csvEscape(item.description);
        case "mpn":
          return csvEscape(item.mpn);
        case "supplier_part_number":
          return csvEscape(item.supplier_part_number);
        case "supplier_link":
          return csvEscape(item.supplier_link);
        case "image_url":
          return csvEscape(item.image_url);
        case "source_page_title":
          return csvEscape(exportObj.page_title);
        case "source_page_url":
          return csvEscape(exportObj.page_url);
        default:
          return csvEscape(item.raw?.[column] || "");
      }
    });
    lines.push(line.join(","));
  }

  return lines.join("\n");
}

function tryParseJson(text) {
  try {
    return JSON.parse(String(text || ""));
  } catch {
    return null;
  }
}

function extractCreatedPartIds(responseJson, partIdResponsePath) {
  if (!responseJson || typeof responseJson !== "object") return [];

  const mappedIds = extractIdsByPath(responseJson, partIdResponsePath);
  if (mappedIds.length > 0) {
    return mappedIds;
  }

  if (Number.isInteger(responseJson.id)) {
    return [responseJson.id];
  }

  if (Array.isArray(responseJson.created_part_ids)) {
    return responseJson.created_part_ids.filter((id) => Number.isInteger(id));
  }

  if (Array.isArray(responseJson.created_parts)) {
    return responseJson.created_parts
      .map((item) => (item && Number.isInteger(item.id) ? item.id : null))
      .filter((id) => id !== null);
  }

  if (Array.isArray(responseJson.parts)) {
    return responseJson.parts
      .map((item) => (item && Number.isInteger(item.id) ? item.id : null))
      .filter((id) => id !== null);
  }

  return [];
}

function extractIdsByPath(source, rawPath) {
  const path = String(rawPath || "").trim();
  if (!path) return [];

  const tokens = path
    .split(".")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((token) => {
      const isArrayToken = token.endsWith("[]");
      return {
        key: isArrayToken ? token.slice(0, -2) : token,
        isArrayToken
      };
    });

  if (tokens.length === 0) return [];

  let current = [source];
  for (const token of tokens) {
    const next = [];
    for (const item of current) {
      if (!item || typeof item !== "object") continue;
      const value = item[token.key];
      if (value === undefined || value === null) continue;

      if (token.isArrayToken) {
        if (Array.isArray(value)) {
          next.push(...value);
        }
        continue;
      }

      next.push(value);
    }
    current = next;
    if (current.length === 0) {
      return [];
    }
  }

  return current
    .map((value) => {
      if (Number.isInteger(value)) return value;
      if (typeof value === "string" && /^\d+$/.test(value.trim())) {
        return Number(value.trim());
      }
      return null;
    })
    .filter((value) => value !== null);
}

async function applyExistingMatchStrategy(items, settings) {
  if (!Array.isArray(items) || items.length === 0) {
    return { items: [], skippedExisting: 0, matchedForUpdate: 0 };
  }

  const strategy = settings.existingMatchStrategy === "update" ? "update" : "skip";
  const output = [];
  let skippedExisting = 0;
  let matchedForUpdate = 0;

  for (const item of items) {
    const matchId = await findExistingPartId(item, settings);
    if (matchId) {
      if (strategy === "skip") {
        skippedExisting += 1;
        continue;
      }

      matchedForUpdate += 1;
      output.push({
        ...item,
        existing_part_id: matchId,
        sync_action: "update"
      });
      continue;
    }

    output.push({
      ...item,
      sync_action: "create"
    });
  }

  return { items: output, skippedExisting, matchedForUpdate };
}

async function findExistingPartId(item, settings) {
  const token = String(settings.inventreeToken || "").trim();
  const base = String(settings.inventreeUrl || "").trim();
  if (!token || !base) return null;

  const candidates = [
    String(item.supplier_part_number || "").trim(),
    String(item.mpn || "").trim(),
    String(item.name || "").trim()
  ].filter(Boolean);

  for (const queryText of candidates) {
    const existingId = await searchPartIdByText(base, token, queryText, item);
    if (existingId) return existingId;
  }

  return null;
}

async function searchPartIdByText(baseUrl, token, queryText, item) {
  try {
    const searchUrl = new URL("/api/part/", baseUrl);
    searchUrl.searchParams.set("search", queryText);

    const response = await fetch(searchUrl.toString(), {
      headers: {
        Authorization: `Token ${token}`
      }
    });

    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.results)
        ? payload.results
        : [];

    const wantedName = String(item.name || "").trim().toLowerCase();
    const wantedSupplierPn = String(item.supplier_part_number || "").trim().toLowerCase();
    const wantedMpn = String(item.mpn || "").trim().toLowerCase();

    for (const candidate of list) {
      const id = Number(candidate?.pk ?? candidate?.id);
      if (!Number.isInteger(id)) continue;

      const candidateName = String(candidate?.name || "").trim().toLowerCase();
      const candidateIpn = String(candidate?.IPN || candidate?.ipn || "").trim().toLowerCase();

      if (wantedSupplierPn && candidateIpn && candidateIpn === wantedSupplierPn) {
        return id;
      }
      if (wantedMpn && candidateIpn && candidateIpn === wantedMpn) {
        return id;
      }
      if (wantedName && candidateName && candidateName === wantedName) {
        return id;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function inferImageFilename(imageUrl) {
  try {
    const parsed = new URL(imageUrl);
    const last = parsed.pathname.split("/").filter(Boolean).pop() || "part-image";
    const clean = last.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);
    return clean || "part-image";
  } catch {
    return "part-image";
  }
}

async function tryUploadImagesToParts({ baseUrl, token, uploadPathTemplate, partIds, items }) {
  let uploaded = 0;
  let skipped = 0;
  let firstError = "";

  for (let i = 0; i < partIds.length; i += 1) {
    const partId = partIds[i];
    const imageUrl = String(items?.[i]?.image_url || "").trim();
    if (!imageUrl) {
      skipped += 1;
      continue;
    }

    try {
      const imageResponse = await fetch(imageUrl);
      if (!imageResponse.ok) {
        skipped += 1;
        if (!firstError) {
          firstError = `Could not download ${imageUrl} (${imageResponse.status})`;
        }
        continue;
      }

      const imageBlob = await imageResponse.blob();
      const filename = inferImageFilename(imageUrl);
      const form = new FormData();
      form.append("image", imageBlob, filename);

      const path = String(uploadPathTemplate || "/api/part/{id}/upload/").replace("{id}", String(partId));
      const uploadUrl = new URL(path, baseUrl).toString();
      const uploadResponse = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `Token ${token}`
        },
        body: form
      });

      if (!uploadResponse.ok) {
        skipped += 1;
        if (!firstError) {
          const body = await uploadResponse.text();
          firstError = `Upload failed for part ${partId}: ${uploadResponse.status} ${body.slice(0, 180)}`;
        }
        continue;
      }

      uploaded += 1;
    } catch (err) {
      skipped += 1;
      if (!firstError) {
        firstError = String(err?.message || err);
      }
    }
  }

  return { uploaded, skipped, firstError };
}

function csvEscape(value) {
  const text = String(value || "");
  if (/[,\"\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
