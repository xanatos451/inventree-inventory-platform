const DEFAULT_SETTINGS = {
  inventreeSyncMode: "plugin",
  inventreeUrl: "",
  inventreeToken: "",
  inventreeEndpointPath: "/api/plugin/product-import/",
  inventreePartApiPath: "/api/part/",
  inventreeSupplierPartApiPath: "/api/company/part/",
  inventreeStockItemApiPath: "/api/stock/",
  inventreePartParameterApiPath: "/api/part/parameter/",
  inventreeParameterTemplateApiPath: "/api/part/parameter/template/",
  inventreeDefaultCategoryId: "",
  enableCategoryBuilder: false,
  inventreeDefaultSupplierId: "",
  inventreeDefaultLocationId: "",
  stockQuantityHeaderHint: "",
  defaultStockQuantity: "",
  mappingTemplatePathPattern: "",
  syncSupplierParts: true,
  syncStockRecords: false,
  syncPartParameters: false,
  autoCreateMissingParameterTemplates: false,
  parameterMappingsText: "",
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
  nameComposeFields: "",
  nameComposeDelimiter: " - ",
  globalImageSourceField: "",
  partImageUploadPath: "/api/part/{id}/upload/",
  partIdResponsePath: "",
  existingMatchStrategy: "skip"
};

const MAPPING_TARGET_KEYS = ["name", "description", "quantity", "category", "subcategory", "variant", "notes"];

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

    case "previewMappedItems": {
      const capture = message?.capture;
      if (!capture?.rows?.length) {
        return { ok: false, error: "No rows available to preview." };
      }

      const incoming = sanitizeSettings(message?.settings || {});
      const persisted = await getSettings();
      const merged = { ...persisted, ...incoming };
      const exportObj = buildExportObject(capture, merged);
      return {
        ok: true,
        templateKey: getTemplateKey(capture, merged),
        items: exportObj.items.slice(0, 8)
      };
    }

    case "previewCategoryAssignments": {
      const capture = message?.capture;
      if (!capture?.rows?.length) {
        return { ok: false, error: "No rows available to preview." };
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
      const categoryId = parsePositiveInt(merged.inventreeDefaultCategoryId);
      if (!categoryId) {
        return { ok: false, error: "Default Category ID is required for category preview." };
      }

      return await previewCategoryAssignments(capture, merged, categoryId);
    }

    case "fetchInventreeCategories": {
      const incoming = sanitizeSettings(message?.settings || {});
      const persisted = await getSettings();
      const merged = { ...persisted, ...incoming };
      if (!merged.inventreeUrl) {
        return { ok: false, error: "InvenTree Base URL is required." };
      }
      if (!merged.inventreeToken) {
        return { ok: false, error: "API token is required." };
      }
      const categories = await fetchInventreeCategories(merged);
      return { ok: true, categories };
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
      return await runDirectSyncDryRun(merged, message?.capture);
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
  const categoryCache = { list: null, byParent: new Map() };
  const parameterTemplateCache = { list: null, byName: new Map() };

  let createdParts = 0;
  let updatedParts = 0;
  let failedParts = 0;
  let syncedSupplierParts = 0;
  let createdStockItems = 0;
  let syncedPartParameters = 0;
  let createdParameterTemplates = 0;
  let firstIssue = "";

  const imageItems = [];
  const imagePartIds = [];

  for (const item of items) {
    try {
      const resolvedCategoryId = await resolveDirectCategoryIdForItem(item, settings, categoryId, categoryCache);
      const result = await createOrUpdatePartInDirectMode(item, settings, resolvedCategoryId);
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

      if (settings.syncPartParameters) {
        const parameterResult = await upsertPartParametersForDirectMode({
          partId: result.partId,
          categoryId: resolvedCategoryId,
          item,
          settings,
          templateCache: parameterTemplateCache
        });
        syncedPartParameters += Number(parameterResult?.upserted || 0);
        createdParameterTemplates += Number(parameterResult?.createdTemplates || 0);
        if (parameterResult?.error && !firstIssue) {
          firstIssue = parameterResult.error;
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
    syncedPartParameters,
    createdParameterTemplates,
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

function parseParameterMappingRules(rawText) {
  const text = String(rawText || "");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const idx = line.indexOf("=");
      if (idx <= 0) return null;
      const parameterName = line.slice(0, idx).trim();
      const sourceField = line.slice(idx + 1).trim();
      if (!parameterName || !sourceField) return null;
      return { parameterName, sourceField };
    })
    .filter(Boolean);
}

function resolveItemSourceValue(item, sourceField) {
  const key = String(sourceField || "").trim();
  if (!key) return "";
  if (Object.prototype.hasOwnProperty.call(item || {}, key)) {
    return String(item?.[key] || "").trim();
  }

  const keyLc = key.toLowerCase();
  for (const [itemKey, itemValue] of Object.entries(item || {})) {
    if (String(itemKey || "").trim().toLowerCase() === keyLc) {
      return String(itemValue || "").trim();
    }
  }

  for (const [rawKey, rawValue] of Object.entries(item?.raw || {})) {
    if (String(rawKey || "").trim().toLowerCase() === keyLc) {
      return String(rawValue || "").trim();
    }
  }

  return "";
}

async function ensureParameterTemplateCache(settings, cache) {
  if (Array.isArray(cache.list)) {
    return cache.list;
  }

  const templatePathResult = await resolveParameterTemplateApiPath(settings);
  if (!templatePathResult.ok) {
    throw new Error(templatePathResult.error || "Parameter template API path is not reachable.");
  }
  const templateApiPath = templatePathResult.path;

  const all = [];
  let nextUrl = new URL(`${templateApiPath}?limit=250`, settings.inventreeUrl).toString();
  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        Authorization: `Token ${settings.inventreeToken}`
      }
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Parameter template fetch failed (${response.status}): ${text.slice(0, 200)}`);
    }

    const payload = await response.json();
    const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [];
    all.push(...rows);
    nextUrl = typeof payload?.next === "string" && payload.next ? payload.next : "";
  }

  cache.list = all;
  cache.byName = new Map();
  for (const row of all) {
    const name = String(row?.name || "").trim().toLowerCase();
    if (!name) continue;
    const list = cache.byName.get(name) || [];
    list.push(row);
    cache.byName.set(name, list);
  }

  return all;
}

function resolveTemplateIdForRule(cache, parameterName, categoryId) {
  const nameKey = String(parameterName || "").trim().toLowerCase();
  if (!nameKey) return null;

  const candidates = cache.byName.get(nameKey) || [];
  if (candidates.length === 0) return null;

  const exactCategory = candidates.find((row) => parsePositiveInt(row?.part_category) === categoryId);
  if (exactCategory) {
    return parsePositiveInt(exactCategory?.pk ?? exactCategory?.id);
  }

  const globalCandidate = candidates.find((row) => !parsePositiveInt(row?.part_category));
  if (globalCandidate) {
    return parsePositiveInt(globalCandidate?.pk ?? globalCandidate?.id);
  }

  return parsePositiveInt(candidates[0]?.pk ?? candidates[0]?.id);
}

async function createParameterTemplateForRule(settings, cache, parameterName, categoryId) {
  const templatePathResult = await resolveParameterTemplateApiPath(settings);
  if (!templatePathResult.ok) {
    return { ok: false, templateId: null, error: templatePathResult.error || "Parameter template API path is not reachable." };
  }
  const templateApiPath = templatePathResult.path;

  const trimmedName = String(parameterName || "").trim();
  if (!trimmedName) {
    return { ok: false, templateId: null, error: "Parameter template name is empty." };
  }

  const attempts = [
    { name: trimmedName, part_category: categoryId || undefined },
    { name: trimmedName }
  ];

  let firstError = "";
  for (const body of attempts) {
    const response = await inventreeApiRequest(settings, "POST", templateApiPath, body);
    if (!response.ok) {
      const text = await response.text();
      if (!firstError) {
        firstError = `Parameter template create failed (${response.status}): ${text.slice(0, 180)}`;
      }
      continue;
    }

    const created = await response.json();
    const templateId = parsePositiveInt(created?.pk ?? created?.id);
    if (!templateId) {
      if (!firstError) {
        firstError = "Parameter template create succeeded but no template ID was returned.";
      }
      continue;
    }

    const row = {
      ...created,
      pk: templateId,
      id: templateId,
      name: created?.name || trimmedName,
      part_category: created?.part_category ?? body.part_category ?? null
    };

    cache.list = Array.isArray(cache.list) ? cache.list : [];
    cache.list.push(row);
    const nameKey = String(row.name || "").trim().toLowerCase();
    if (nameKey) {
      const list = cache.byName.get(nameKey) || [];
      list.push(row);
      cache.byName.set(nameKey, list);
    }

    return { ok: true, templateId, created: true };
  }

  return {
    ok: false,
    templateId: null,
    error: firstError || `Failed to create parameter template: ${trimmedName}`
  };
}

async function upsertPartParametersForDirectMode({ partId, categoryId, item, settings, templateCache }) {
  const rules = parseParameterMappingRules(settings.parameterMappingsText);
  if (rules.length === 0) {
    return { ok: true, upserted: 0 };
  }

  const partParameterPathResult = await resolvePartParameterApiPath(settings);
  if (!partParameterPathResult.ok) {
    return { ok: false, upserted: 0, createdTemplates: 0, error: partParameterPathResult.error || "Part parameter API path is not reachable." };
  }
  const partParameterApiPath = partParameterPathResult.path;

  try {
    await ensureParameterTemplateCache(settings, templateCache);
  } catch (error) {
    return { ok: false, upserted: 0, error: String(error?.message || error) };
  }

  let upserted = 0;
  let createdTemplates = 0;
  let firstError = "";

  for (const rule of rules) {
    const value = resolveItemSourceValue(item, rule.sourceField);
    if (!value) continue;

    let templateId = resolveTemplateIdForRule(templateCache, rule.parameterName, categoryId);
    if (!templateId) {
      if (settings.autoCreateMissingParameterTemplates) {
        const createResult = await createParameterTemplateForRule(settings, templateCache, rule.parameterName, categoryId);
        if (createResult.ok && createResult.templateId) {
          templateId = createResult.templateId;
          createdTemplates += 1;
        } else if (!firstError) {
          firstError = createResult.error || `Parameter template not found: ${rule.parameterName}`;
        }
      } else if (!firstError) {
        firstError = `Parameter template not found: ${rule.parameterName}`;
      }
      if (!templateId) continue;
    }

    try {
      const searchUrl = new URL(partParameterApiPath, settings.inventreeUrl);
      searchUrl.searchParams.set("part", String(partId));
      searchUrl.searchParams.set("template", String(templateId));

      const lookup = await fetch(searchUrl.toString(), {
        headers: {
          Authorization: `Token ${settings.inventreeToken}`
        }
      });
      if (!lookup.ok) {
        const text = await lookup.text();
        if (!firstError) {
          firstError = `Parameter lookup failed (${lookup.status}): ${text.slice(0, 160)}`;
        }
        continue;
      }

      const lookupJson = await lookup.json();
      const existingList = Array.isArray(lookupJson) ? lookupJson : Array.isArray(lookupJson?.results) ? lookupJson.results : [];
      const existing = existingList[0] || null;

      if (existing?.pk || existing?.id) {
        const existingId = parsePositiveInt(existing.pk ?? existing.id);
        if (existingId) {
          const patch = await inventreeApiRequest(
            settings,
            "PATCH",
            `${trimTrailingSlash(partParameterApiPath)}/${existingId}/`,
            { data: String(value) }
          );
          if (patch.ok) {
            upserted += 1;
          } else if (!firstError) {
            const text = await patch.text();
            firstError = `Parameter update failed (${patch.status}): ${text.slice(0, 160)}`;
          }
          continue;
        }
      }

      const create = await inventreeApiRequest(settings, "POST", partParameterApiPath, {
        part: partId,
        template: templateId,
        data: String(value)
      });
      if (create.ok) {
        upserted += 1;
      } else if (!firstError) {
        const text = await create.text();
        firstError = `Parameter create failed (${create.status}): ${text.slice(0, 160)}`;
      }
    } catch (error) {
      if (!firstError) {
        firstError = String(error?.message || error);
      }
    }
  }

  return {
    ok: !firstError,
    upserted,
    createdTemplates,
    error: firstError
  };
}

async function runDirectSyncDryRun(settings, capture) {
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

  const parameterRules = parseParameterMappingRules(settings.parameterMappingsText);
  if (settings.syncPartParameters) {
    checks.push({
      ok: parameterRules.length > 0,
      label: "Part parameter mapping rules",
      message: parameterRules.length > 0
        ? `${parameterRules.length} rule(s) configured`
        : "Add at least one mapping rule: Parameter Name = SourceField"
    });
    checks.push({
      ok: true,
      label: "Auto-create missing parameter templates",
      message: settings.autoCreateMissingParameterTemplates
        ? "Enabled"
        : "Disabled (missing templates will be skipped)"
    });
  }

  if (capture?.rows?.length) {
    const exportObj = buildExportObject(capture, settings);
    const items = Array.isArray(exportObj.items) ? exportObj.items : [];
    const total = items.length;
    const mappingTemplate = getMappingTemplateForCapture(capture, settings);
    const countNonEmpty = (field) => items.filter((item) => String(item?.[field] || "").trim()).length;
    const firstNonEmpty = (field) => {
      for (const item of items) {
        const value = String(item?.[field] || "").trim();
        if (value) return value;
      }
      return "";
    };
    const sampleText = (value, maxLen = 140) => {
      const oneLine = String(value || "").replace(/\s+/g, " ").trim();
      if (!oneLine) return "[[empty]]";
      return oneLine.length > maxLen
        ? `[[${oneLine.slice(0, maxLen - 3)}...]]`
        : `[[${oneLine}]]`;
    };

    checks.push({
      ok: total > 0,
      label: "Capture rows",
      message: `${total} row(s) available for mapping preview`
    });

    const mappedFieldChecks = [
      { targetKey: "name", itemField: "name", label: "Mapped name population" },
      { targetKey: "variant", itemField: "variant_text", label: "Mapped variant_text population" },
      { targetKey: "notes", itemField: "notes", label: "Mapped notes population" },
      { targetKey: "category", itemField: "category_text", label: "Mapped category_text population" },
      { targetKey: "subcategory", itemField: "subcategory_text", label: "Mapped subcategory_text population" }
    ];

    for (const fieldCheck of mappedFieldChecks) {
      const configuredSource = String(mappingTemplate?.[fieldCheck.targetKey]?.sourceField || "").trim();
      const populated = countNonEmpty(fieldCheck.itemField);
      const isConfigured = Boolean(configuredSource);
      checks.push({
        ok: isConfigured ? populated > 0 : true,
        label: fieldCheck.label,
        message: `${populated}/${total} rows non-empty${isConfigured ? ` (source: ${configuredSource})` : " (auto/not explicitly mapped)"}`
      });
    }

    const variantSample = firstNonEmpty("variant_text");
    checks.push({
      ok: Boolean(variantSample),
      label: "Sample variant_text value",
      message: sampleText(variantSample)
    });

    const categorySample = firstNonEmpty("category_text");
    checks.push({
      ok: Boolean(categorySample),
      label: "Sample category_text value",
      message: sampleText(categorySample)
    });

    const subcategorySample = firstNonEmpty("subcategory_text");
    checks.push({
      ok: Boolean(subcategorySample),
      label: "Sample subcategory_text value",
      message: sampleText(subcategorySample)
    });

    const chainPreviewRows = items
      .map((item, index) => {
        const chain = buildCategoryChainFromItem(item);
        if (chain.length === 0) return "";
        const itemName = String(item?.name || "").replace(/\s+/g, " ").trim();
        const safeName = itemName ? itemName.slice(0, 42) : `Row ${index + 1}`;
        return `${safeName}: [[${chain.join(" > ")}]]`;
      })
      .filter(Boolean)
      .slice(0, 3);

    checks.push({
      ok: chainPreviewRows.length > 0,
      label: "Sample merged category chains",
      message: chainPreviewRows.length > 0
        ? chainPreviewRows.join(" | ")
        : "No category/subcategory chain values detected in mapped rows."
    });

    const notesSample = firstNonEmpty("notes");
    checks.push({
      ok: Boolean(notesSample),
      label: "Sample notes value",
      message: sampleText(notesSample, 220)
    });
  } else {
    checks.push({
      ok: true,
      label: "Capture rows",
      message: "No capture provided to dry-run. Run capture first to validate mapped field population."
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
  let shouldCheckParameterPaths = false;
  if (settings.syncPartParameters && (parameterRules.length > 0 || settings.autoCreateMissingParameterTemplates)) {
    shouldCheckParameterPaths = true;
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

  if (shouldCheckParameterPaths) {
    const partParameterPathResult = await resolvePartParameterApiPath(settings);
    checks.push({
      ok: partParameterPathResult.ok,
      label: "Part Parameter API path",
      message: partParameterPathResult.ok
        ? `Reachable (auto-resolved to ${partParameterPathResult.path})`
        : String(partParameterPathResult.error || "Could not resolve a reachable part parameter API path")
    });

    const templatePathResult = await resolveParameterTemplateApiPath(settings);
    checks.push({
      ok: templatePathResult.ok,
      label: "Parameter Template API path",
      message: templatePathResult.ok
        ? `Reachable (auto-resolved to ${templatePathResult.path})`
        : String(templatePathResult.error || "Could not resolve a reachable parameter template API path")
    });
  }

  return { ok: true, checks };
}

function toPathCandidate(path, fallbackPath) {
  const raw = String(path || "").trim() || String(fallbackPath || "").trim();
  if (!raw) return "";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function uniquePathCandidates(paths) {
  const seen = new Set();
  const out = [];
  for (const item of paths || []) {
    const normalized = toPathCandidate(item, "");
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

async function resolveReachableApiPath(settings, cacheKey, fallbackPath, candidates) {
  const key = String(cacheKey || "").trim();
  if (!key) {
    return { ok: false, path: toPathCandidate(fallbackPath, "/"), error: "Invalid API path cache key." };
  }

  settings.__resolvedApiPaths = settings.__resolvedApiPaths && typeof settings.__resolvedApiPaths === "object"
    ? settings.__resolvedApiPaths
    : {};

  const cached = String(settings.__resolvedApiPaths[key] || "").trim();
  if (cached) {
    return { ok: true, path: cached, fromCache: true };
  }

  const pathCandidates = uniquePathCandidates([fallbackPath, ...(candidates || [])]);
  let firstError = "";

  for (const path of pathCandidates) {
    try {
      const endpoint = new URL(path, settings.inventreeUrl);
      endpoint.searchParams.set("limit", "1");
      const response = await fetch(endpoint.toString(), {
        method: "GET",
        headers: {
          Authorization: `Token ${settings.inventreeToken}`
        }
      });

      if (response.ok) {
        settings.__resolvedApiPaths[key] = path;
        return { ok: true, path, status: response.status };
      }

      if (!firstError) {
        firstError = `${path} returned HTTP ${response.status}`;
      }
    } catch (error) {
      if (!firstError) {
        firstError = `${path} failed: ${String(error?.message || error)}`;
      }
    }
  }

  return {
    ok: false,
    path: toPathCandidate(fallbackPath, "/"),
    error: firstError || "No reachable API path found."
  };
}

async function resolvePartParameterApiPath(settings) {
  return await resolveReachableApiPath(
    settings,
    "partParameter",
    settings.inventreePartParameterApiPath,
    [
      settings.inventreePartParameterApiPath,
      "/api/part/parameter/",
      "/api/part/parameters/",
      "/api/part/partparameter/",
      "/api/part/part-parameter/"
    ]
  );
}

async function resolveParameterTemplateApiPath(settings) {
  return await resolveReachableApiPath(
    settings,
    "parameterTemplate",
    settings.inventreeParameterTemplateApiPath,
    [
      settings.inventreeParameterTemplateApiPath,
      "/api/part/parameter/template/",
      "/api/part/parametertemplate/",
      "/api/part/parameter-template/",
      "/api/part/partparametertemplate/",
      "/api/part/part-parameter-template/"
    ]
  );
}

async function createOrUpdatePartInDirectMode(item, settings, categoryId) {
  const existingPartId = parsePositiveInt(item.existing_part_id);
  const shouldUpdate = item.sync_action === "update" && existingPartId;
  const ipn = String(item.supplier_part_number || item.mpn || "").trim();
  const partBody = {
    name: String(item.name || "").trim() || "Imported Product",
    description: String(item.description || "").trim(),
    notes: String(item.notes || "").trim(),
    category: categoryId,
    IPN: ipn
  };

  if (shouldUpdate) {
    const patchBody = {
      name: partBody.name,
      description: partBody.description,
      notes: partBody.notes,
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

function splitCategorySegments(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return [];
  return text
    // Support common breadcrumb delimiters while avoiding raw fractions like 18/8.
    .split(/\s*(?:>|»|->|\|)\s*|\s+\/\s+/)
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function buildCategoryChainFromItem(item) {
  const categorySegments = splitCategorySegments(item?.category_text);
  const subcategorySegments = splitCategorySegments(item?.subcategory_text);

  const chain = [...categorySegments];
  if (subcategorySegments.length > 0) {
    let overlap = 0;
    const limit = Math.min(chain.length, subcategorySegments.length);
    while (overlap < limit) {
      if (chain[overlap].toLowerCase() !== subcategorySegments[overlap].toLowerCase()) {
        break;
      }
      overlap += 1;
    }
    chain.push(...subcategorySegments.slice(overlap));
  }

  const normalized = [];
  for (const segment of chain) {
    const current = String(segment || "").trim();
    if (!current) continue;
    const prev = normalized[normalized.length - 1];
    if (prev && prev.toLowerCase() === current.toLowerCase()) continue;
    normalized.push(current);
  }

  return normalized;
}

async function resolveDirectCategoryIdForItem(item, settings, defaultCategoryId, categoryCache) {
  if (!settings.enableCategoryBuilder) {
    return defaultCategoryId;
  }

  const chain = buildCategoryChainFromItem(item);
  if (chain.length === 0) {
    return defaultCategoryId;
  }

  let currentParentId = defaultCategoryId;

  for (const name of chain) {
    const resolved = await resolveOrCreateCategoryByName(settings, currentParentId, name, categoryCache);
    if (!resolved) {
      return currentParentId;
    }
    currentParentId = resolved;
  }

  return currentParentId;
}

async function resolveOrCreateCategoryByName(settings, parentId, name, categoryCache) {
  const trimmedName = String(name || "").trim();
  if (!trimmedName) return parentId;

  const categories = await ensureCategoryCache(settings, categoryCache);
  const parentKey = String(parentId || "root");
  const siblings = categoryCache.byParent.get(parentKey) || [];
  const existing = siblings.find((item) => String(item?.name || "").trim().toLowerCase() === trimmedName.toLowerCase());
  if (existing) {
    return parsePositiveInt(existing.pk ?? existing.id);
  }

  const response = await inventreeApiRequest(settings, "POST", "/api/part/category/", {
    name: trimmedName,
    parent: parentId
  });
  if (!response.ok) {
    return parentId;
  }

  const created = await response.json();
  const categoryId = parsePositiveInt(created?.pk ?? created?.id);
  if (!categoryId) {
    return parentId;
  }

  const createdRow = { ...created, pk: categoryId, id: categoryId, name: trimmedName, parent: parentId };
  categories.push(createdRow);
  const nextSiblings = categoryCache.byParent.get(parentKey) || [];
  nextSiblings.push(createdRow);
  categoryCache.byParent.set(parentKey, nextSiblings);
  return categoryId;
}

async function ensureCategoryCache(settings, categoryCache) {
  if (Array.isArray(categoryCache.list)) {
    return categoryCache.list;
  }

  const categories = await fetchInventreeCategories(settings);
  categoryCache.list = categories;
  categoryCache.byParent = new Map();
  for (const category of categories) {
    const parentKey = String(parsePositiveInt(category?.parent) || "root");
    const list = categoryCache.byParent.get(parentKey) || [];
    list.push(category);
    categoryCache.byParent.set(parentKey, list);
  }
  return categories;
}

async function fetchInventreeCategories(settings) {
  const all = [];
  let nextUrl = new URL("/api/part/category/?limit=250", settings.inventreeUrl).toString();

  while (nextUrl) {
    const response = await fetch(nextUrl, {
      headers: {
        Authorization: `Token ${settings.inventreeToken}`
      }
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Category fetch failed (${response.status}): ${text.slice(0, 200)}`);
    }

    const payload = await response.json();
    const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.results) ? payload.results : [];
    all.push(...rows);
    nextUrl = typeof payload?.next === "string" && payload.next ? payload.next : "";
  }

  const byId = new Map();
  for (const row of all) {
    const id = parsePositiveInt(row?.pk ?? row?.id);
    if (id) byId.set(id, row);
  }

  return all.map((row) => {
    const id = parsePositiveInt(row?.pk ?? row?.id);
    const parts = [String(row?.name || "").trim()].filter(Boolean);
    let parentId = parsePositiveInt(row?.parent);
    let guard = 0;
    while (parentId && byId.has(parentId) && guard < 10) {
      const parent = byId.get(parentId);
      parts.unshift(String(parent?.name || "").trim());
      parentId = parsePositiveInt(parent?.parent);
      guard += 1;
    }
    return {
      ...row,
      display_path: parts.filter(Boolean).join(" > ")
    };
  });
}

async function previewCategoryAssignments(capture, settings, defaultCategoryId) {
  const exportObj = buildExportObject(capture, settings);
  const items = Array.isArray(exportObj.items) ? exportObj.items : [];
  const categories = await fetchInventreeCategories(settings);

  const byId = new Map();
  const byParent = new Map();

  for (const row of categories) {
    const id = parsePositiveInt(row?.pk ?? row?.id);
    if (!id) continue;
    byId.set(id, row);
    const parentKey = String(parsePositiveInt(row?.parent) || "root");
    const list = byParent.get(parentKey) || [];
    list.push(row);
    byParent.set(parentKey, list);
  }

  const defaultRow = byId.get(defaultCategoryId) || null;
  const defaultLabel = String(defaultRow?.display_path || defaultRow?.name || `#${defaultCategoryId}`);

  let simulatedId = -1;
  let existingSegments = 0;
  let createSegments = 0;
  let usedDefaultOnly = 0;

  const plans = items.slice(0, 25).map((item, idx) => {
    let currentParentId = defaultCategoryId;
    let currentPath = defaultLabel;
    const steps = [];

    const categoryText = String(item?.category_text || "").trim();
    const subcategoryText = String(item?.subcategory_text || "").trim();
    const chain = buildCategoryChainFromItem(item);

    for (const segmentName of chain) {
      const siblings = byParent.get(String(currentParentId)) || [];
      const existing = siblings.find((row) => String(row?.name || "").trim().toLowerCase() === segmentName.toLowerCase());

      if (existing) {
        const existingId = parsePositiveInt(existing?.pk ?? existing?.id) || currentParentId;
        currentParentId = existingId;
        currentPath = String(existing?.display_path || `${currentPath} > ${segmentName}`);
        steps.push({
          action: "existing",
          name: segmentName,
          categoryId: existingId,
          categoryPath: currentPath
        });
        existingSegments += 1;
        continue;
      }

      simulatedId -= 1;
      currentPath = currentPath ? `${currentPath} > ${segmentName}` : segmentName;
      const createdRow = {
        pk: simulatedId,
        id: simulatedId,
        name: segmentName,
        parent: currentParentId,
        display_path: currentPath
      };
      const siblingsAfterCreate = byParent.get(String(currentParentId)) || [];
      siblingsAfterCreate.push(createdRow);
      byParent.set(String(currentParentId), siblingsAfterCreate);
      byId.set(simulatedId, createdRow);
      currentParentId = simulatedId;

      steps.push({
        action: "create",
        name: segmentName,
        parentId: createdRow.parent,
        categoryId: simulatedId,
        categoryPath: currentPath
      });
      createSegments += 1;
    }

    if (chain.length === 0) {
      usedDefaultOnly += 1;
    }

    return {
      index: idx + 1,
      itemName: String(item?.name || "").trim() || "Imported Product",
      categoryText,
      subcategoryText,
      targetCategoryId: currentParentId,
      targetCategoryPath: currentPath,
      steps
    };
  });

  return {
    ok: true,
    summary: {
      totalItems: items.length,
      previewedItems: plans.length,
      existingSegments,
      createSegments,
      usedDefaultOnly,
      defaultCategoryId,
      defaultCategoryPath: defaultLabel
    },
    items: plans,
    truncated: items.length > plans.length
  };
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
  const mapped = Number(String(item?.quantity || "").replace(/[^0-9.\-]/g, ""));
  if (Number.isFinite(mapped) && mapped > 0) {
    return mapped;
  }

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
    inventreePartParameterApiPath: normalizePath(input.inventreePartParameterApiPath, "/api/part/parameter/"),
    inventreeParameterTemplateApiPath: normalizePath(input.inventreeParameterTemplateApiPath, "/api/part/parameter/template/"),
    inventreeDefaultCategoryId: String(input.inventreeDefaultCategoryId || "").trim(),
    enableCategoryBuilder: Boolean(input.enableCategoryBuilder),
    inventreeDefaultSupplierId: String(input.inventreeDefaultSupplierId || "").trim(),
    inventreeDefaultLocationId: String(input.inventreeDefaultLocationId || "").trim(),
    stockQuantityHeaderHint: String(input.stockQuantityHeaderHint || "").trim(),
    defaultStockQuantity: String(input.defaultStockQuantity || "").trim(),
    mappingTemplatePathPattern: String(input.mappingTemplatePathPattern || "").trim(),
    mappingTemplates: sanitizeMappingTemplates(input.mappingTemplates),
    syncSupplierParts: input.syncSupplierParts !== false,
    syncStockRecords: Boolean(input.syncStockRecords),
    syncPartParameters: Boolean(input.syncPartParameters),
    autoCreateMissingParameterTemplates: Boolean(input.autoCreateMissingParameterTemplates),
    parameterMappingsText: String(input.parameterMappingsText || ""),
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
    nameComposeFields: String(input.nameComposeFields || "").trim(),
    nameComposeDelimiter: String(input.nameComposeDelimiter || " - "),
    globalImageSourceField: String(input.globalImageSourceField || "").trim(),
    partImageUploadPath: normalizePath(input.partImageUploadPath, "/api/part/{id}/upload/"),
    partIdResponsePath: String(input.partIdResponsePath || "").trim(),
    existingMatchStrategy: input.existingMatchStrategy === "update" ? "update" : "skip"
  };
}

function sanitizeMappingTemplates(input) {
  const templates = input && typeof input === "object" ? input : {};
  const cleaned = {};

  for (const [key, value] of Object.entries(templates)) {
    if (!value || typeof value !== "object") continue;
    const template = {};
    for (const targetKey of MAPPING_TARGET_KEYS) {
      const source = value?.[targetKey]?.sourceField;
      const regex = value?.[targetKey]?.regex;
      template[targetKey] = {
        sourceField: String(source || "").trim(),
        regex: String(regex || "").trim()
      };
    }
    const createdAt = String(value?._meta?.createdAt || "").trim();
    const lastUsedAt = String(value?._meta?.lastUsedAt || "").trim();
    if (createdAt || lastUsedAt) {
      template._meta = {
        ...(createdAt ? { createdAt } : {}),
        ...(lastUsedAt ? { lastUsedAt } : {})
      };
    }
    cleaned[String(key).trim() || "default"] = template;
  }

  return cleaned;
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

  function mergeRowWithDetail(baseRow, detailRow) {
    const merged = { ...baseRow };
    for (const [key, value] of Object.entries(detailRow || {})) {
      const text = String(value ?? "").trim();
      if (!text) continue;
      merged[key] = value;
    }
    return merged;
  }

  function mergeMcmasterRowsWithDetails(baseRows, detailRows) {
    const byUrl = new Map();
    const byPart = new Map();
    const usedDetails = new Set();

    for (const detail of detailRows || []) {
      const detailUrl = String(detail?.ProductURL || "").trim().toLowerCase();
      const detailPart = String(detail?.McMasterPartNumber || "").trim().toLowerCase();
      if (detailUrl) byUrl.set(detailUrl, detail);
      if (detailPart) byPart.set(detailPart, detail);
    }

    const merged = [];
    for (const row of baseRows || []) {
      const rowUrl = String(row?.ProductURL || "").trim().toLowerCase();
      const rowPart = String(row?.McMasterPartNumber || "").trim().toLowerCase();
      const detail = (rowUrl && byUrl.get(rowUrl)) || (rowPart && byPart.get(rowPart)) || null;
      if (!detail) {
        merged.push(row);
        continue;
      }

      usedDetails.add(detail);
      merged.push(mergeRowWithDetail(row, detail));
    }

    for (const detail of detailRows || []) {
      if (!usedDetails.has(detail)) {
        merged.push(detail);
      }
    }

    return merged;
  }

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

  const detailRows = [];
  if (shouldCrawl && crawlTargets.length > 0) {
    for (const url of crawlTargets) {
      const childTab = await chrome.tabs.create({ url, active: false });
      try {
        await waitForTabLoaded(childTab.id, 30000);

        const detail = await executeScraperOnTab(childTab.id, scrapeMcMasterProductDetailData);
        if (detail?.ok && detail.row) {
          detailRows.push(detail.row);
          for (const header of detail.headers || []) {
            headerSet.add(header);
          }
          pagesScraped += 1;
          continue;
        }

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

  if (detailRows.length > 0) {
    const mergedWithDetails = mergeMcmasterRowsWithDetails(allRows, detailRows);
    allRows.length = 0;
    allRows.push(...mergedWithDetails);
  }

  const dedupedRows = dedupeRows(allRows);
  if (dedupedRows.length === 0) {
    throw new Error("No product rows found on this McMaster page or linked child pages.");
  }

  return {
    source: "mcmaster-carr",
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
    pageType: primary.pageType || "catalog",
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
    pageType: /\/orders?/i.test(location.pathname) ? "order-items" : "order-items",
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

  const isOrderDetailsPage = /\/Account\/Order-Details/i.test(location.pathname);

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
      pageTitle: normalizeText(document.querySelector("h1")?.textContent || document.title || "Bolt Depot"),
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
    dataRows.push(rowObj);
  }

  if (dataRows.length === 0 && isOrderDetailsPage) {
    const fallbackRows = extractOrderFallbackRows(fallbackImage);
    if (fallbackRows.length > 0) {
      return {
        ok: true,
        pageType: "order-details",
        pageTitle: normalizeText(document.querySelector("h1")?.textContent || document.title || "Bolt Depot"),
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
        pageTitle: normalizeText(document.querySelector("h1")?.textContent || document.title || "Bolt Depot"),
        headers: ["Product", "Description", "ProductURL", "BoltDepotPartNumber", "RowImageURL", "SourcePageURL"],
        rows: childRows,
        childLinks
      };
    }
  }

  return {
    ok: true,
    pageType: isOrderDetailsPage ? "order-details" : "catalog-table",
    pageTitle: normalizeText(document.querySelector("h1")?.textContent || document.title || "Bolt Depot"),
    headers: Array.from(new Set([...headers, "ProductURL", "BoltDepotPartNumber", "Quantity", "RowImageURL", "SourcePageURL"])),
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

  function parseBreadcrumbs() {
    const breadcrumbRoot = document.querySelector("nav[aria-label*='breadcrumb' i], [aria-label*='breadcrumb' i], .breadcrumb, #breadcrumb, #breadcrumbs");
    if (breadcrumbRoot) {
      const links = Array.from(breadcrumbRoot.querySelectorAll("a, span, li"))
        .map((node) => normalizeText(node.textContent))
        .filter(Boolean);
      if (links.length > 1) {
        return links.join(" > ");
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

function scrapeMcMasterProductDetailData() {
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
    const image = container?.querySelector("img[src], img[data-src], img[data-original], source[srcset]");
    if (!image) return "";

    const srcset = image.getAttribute("srcset") || "";
    if (srcset) {
      const first = srcset.split(",")[0]?.trim().split(" ")[0] || "";
      if (first) return toAbsolute(first) || first;
    }

    return toAbsolute(image.getAttribute("src") || image.getAttribute("data-src") || image.getAttribute("data-original") || "");
  }

  function parseBreadcrumbs() {
    const root = document.querySelector("nav[aria-label*='breadcrumb' i], [aria-label*='breadcrumb' i], .breadcrumb, #breadcrumb, #breadcrumbs");
    if (!root) return "";
    return Array.from(root.querySelectorAll("a, span, li"))
      .map((node) => normalizeText(node.textContent))
      .filter(Boolean)
      .join(" > ");
  }

  function extractPartNumber(titleText) {
    const fromUrl = String(location.href || "").match(/\b\d{5}[A-Z]\d{3,4}\b/i);
    if (fromUrl) return fromUrl[0].toUpperCase();

    const fullText = `${titleText || ""} ${normalizeText(document.body?.textContent || "")}`;
    const fromBody = fullText.match(/\b\d{5}[A-Z]\d{3,4}\b/i);
    return fromBody ? fromBody[0].toUpperCase() : "";
  }

  const title = normalizeText(document.querySelector("h1")?.textContent || document.title || "");
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

  const threadSize = Object.entries(specMap).find(([key]) => /thread\s*size/i.test(key))?.[1] || "";
  const lengthValue = Object.entries(specMap).find(([key]) => /(?:^|\b)(?:length|lg\.?)(?:\b|$)/i.test(key))?.[1] || "";
  const variant = threadSize && lengthValue
    ? `${threadSize} x ${lengthValue}`
    : (threadSize || lengthValue || "");

  const imageUrl = firstImageSrc(document.querySelector("main, [role='main']") || document.body);
  const row = {
    Product: title || (partNumber ? `Part ${partNumber}` : "Product"),
    Description: title,
    ProductURL: location.href,
    McMasterPartNumber: partNumber,
    RowImageURL: imageUrl,
    RowImageSource: imageUrl ? "product-page" : "none",
    PageBreadcrumbs: breadcrumbs,
    PageTitle: title,
    PageSectionSummary: normalizeText(document.querySelector("main p, [role='main'] p")?.textContent || ""),
    ProductDetailThreadSize: threadSize,
    ProductDetailLength: lengthValue,
    ProductDetailVariant: variant,
    ProductDetailSpecs: specText,
    ProductDetailNotes: detailNotes
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

function buildExportFilename(format) {
  const ts = new Date().toISOString().replace(/[:]/g, "-").replace(/\..+$/, "");
  return `product-inventory-export/${ts}-captured-catalog.${format}`;
}

function buildExportPayload(capture, hints) {
  return JSON.stringify(buildExportObject(capture, hints), null, 2);
}

function buildExportObject(capture, hints) {
  const templateResolution = resolveTemplateForCapture(capture, hints);
  const items = capture.rows.map((row) => toInventreeItem(row, hints, capture, templateResolution.template));
  return {
    source: capture.source || "catalog",
    page_type: capture.pageType || "default",
    captured_at: capture.capturedAt,
    page_title: capture.pageTitle,
    page_url: capture.pageUrl,
    pages_scraped: Number(capture.pagesScraped || 1),
    header_list: capture.headers,
    item_count: items.length,
    items
  };
}

function getTemplateKey(capture, hints) {
  const resolution = resolveTemplateForCapture(capture, hints);
  return resolution.resolvedKey || resolution.requestedKey;
}

function normalizeTemplatePathPattern(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.startsWith("/") ? raw : `/${raw}`;
}

function getCaptureHost(capture) {
  const pageUrl = String(capture?.pageUrl || "").trim();
  if (!pageUrl) return "";
  try {
    return String(new URL(pageUrl).hostname || "").trim().toLowerCase();
  } catch {
    return "";
  }
}

function getCapturePathname(capture) {
  const pageUrl = String(capture?.pageUrl || "").trim();
  if (!pageUrl) return "";
  try {
    return String(new URL(pageUrl).pathname || "").trim() || "/";
  } catch {
    return "";
  }
}

function buildTemplateScopeKey({ source, pageType, host, pathPattern }) {
  if (host) {
    const base = `host:${host}|page:${pageType}`;
    return pathPattern ? `${base}|path:${pathPattern}` : base;
  }
  return `${source}:${pageType}`;
}

function normalizeTemplateKey(value) {
  const key = String(value || "default").trim().toLowerCase();
  return key === "mcmaster-carr" ? "mcmaster" : key;
}

function parseHostTemplateKey(key) {
  const match = String(key || "").match(/^host:([^|]+)\|page:([^|]+)(?:\|path:(.+))?$/i);
  if (!match) return null;
  return {
    host: String(match[1] || "").trim().toLowerCase(),
    pageType: String(match[2] || "").trim().toLowerCase(),
    pathPattern: String(match[3] || "").trim()
  };
}

function wildcardPathMatches(pathPattern, pathname) {
  const pattern = normalizeTemplatePathPattern(pathPattern);
  const path = String(pathname || "").trim() || "/";
  if (!pattern) return false;
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  try {
    return new RegExp(`^${escaped}$`, "i").test(path);
  } catch {
    return false;
  }
}

function buildTemplateCandidateKeys(capture, hints, templates) {
  const source = normalizeTemplateKey(capture?.source || hints?.sourceMode || "default");
  const pageType = normalizeTemplateKey(capture?.pageType || "default");
  const host = getCaptureHost(capture);
  const pathname = getCapturePathname(capture);
  const pathPattern = normalizeTemplatePathPattern(hints?.mappingTemplatePathPattern || "");
  const context = { source, pageType, host, pathPattern };

  const keys = [];
  const seen = new Set();

  function push(key) {
    const normalized = String(key || "").trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    keys.push(normalized);
  }

  push(buildTemplateScopeKey(context));

  if (host) {
    if (pathPattern) {
      push(buildTemplateScopeKey({ ...context, pathPattern: "" }));
    }

    if (pathname) {
      const scoredOverrides = [];
      for (const key of Object.keys(templates || {})) {
        const parsed = parseHostTemplateKey(key);
        if (!parsed || !parsed.pathPattern) continue;
        if (parsed.host !== host || parsed.pageType !== pageType) continue;
        if (!wildcardPathMatches(parsed.pathPattern, pathname)) continue;
        const wildcardPenalty = (parsed.pathPattern.match(/\*/g) || []).length * 100;
        const score = parsed.pathPattern.length - wildcardPenalty;
        scoredOverrides.push({ key, score });
      }

      scoredOverrides
        .sort((a, b) => b.score - a.score)
        .forEach((item) => push(item.key));
    }

    push(buildTemplateScopeKey({ ...context, pageType: "default", pathPattern: "" }));
  }

  push(`${source}:${pageType}`);
  push(`${source}:default`);
  push(source);

  return keys;
}

function resolveTemplateForCapture(capture, hints) {
  const templates = hints?.mappingTemplates && typeof hints.mappingTemplates === "object" ? hints.mappingTemplates : {};
  const candidates = buildTemplateCandidateKeys(capture, hints, templates);
  const resolvedKey = candidates.find((key) => templates[key] && typeof templates[key] === "object") || "";
  const rawTemplate = resolvedKey ? templates[resolvedKey] : {};

  const normalized = {};
  for (const targetKey of MAPPING_TARGET_KEYS) {
    normalized[targetKey] = {
      sourceField: String(rawTemplate?.[targetKey]?.sourceField || "").trim(),
      regex: String(rawTemplate?.[targetKey]?.regex || "").trim()
    };
  }

  return {
    requestedKey: candidates[0] || `${normalizeTemplateKey(capture?.source || hints?.sourceMode || "default")}:${normalizeTemplateKey(capture?.pageType || "default")}`,
    resolvedKey,
    template: normalized
  };
}

function firstNonEmpty(values) {
  for (const value of values || []) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function findRowValueByRegex(row, regex) {
  const pattern = regex instanceof RegExp ? regex : null;
  if (!pattern) return "";
  for (const [key, value] of Object.entries(row || {})) {
    if (!pattern.test(String(key || ""))) continue;
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function deriveVariantFallback(row) {
  const direct = firstNonEmpty([
    row?.ProductDetailVariant,
    row?.Variant,
    row?.Size,
    row?.ThreadSize
  ]);
  if (direct) return direct;

  const threadSize = firstNonEmpty([
    row?.ProductDetailThreadSize,
    findRowValueByRegex(row, /^Spec_.*Thread.*Size/i),
    findRowValueByRegex(row, /^Spec_.*Thread/i)
  ]);

  const length = firstNonEmpty([
    row?.ProductDetailLength,
    findRowValueByRegex(row, /^Spec_.*(?:Length|Lg)_?/i),
    findRowValueByRegex(row, /^Spec_.*Length/i)
  ]);

  if (threadSize && length) return `${threadSize} x ${length}`;
  if (threadSize || length) return threadSize || length;

  const titleText = firstNonEmpty([row?.Product, row?.Description, row?.PageTitle]);
  const sizeMatch = titleText.match(/((?:M\d+(?:\.\d+)?|#\d+|\d+\/\d+(?:-\d+)?)\s*x\s*(?:\d+(?:\.\d+)?|\d+\/\d+)\s*(?:mm|cm|m|in|["'])?)/i);
  return sizeMatch ? String(sizeMatch[1] || "").trim() : "";
}

function deriveNotesFallback(row, mappedDescription) {
  const direct = firstNonEmpty([
    row?.ProductDetailNotes,
    row?.ProductDetailSpecs,
    row?.DetailedSpecs,
    row?.Specifications,
    row?.Specs
  ]);
  if (direct) return direct;

  const specPairs = [];
  for (const [key, value] of Object.entries(row || {})) {
    const keyText = String(key || "");
    if (!/^Spec_/i.test(keyText)) continue;
    const val = String(value || "").trim();
    if (!val) continue;
    const label = keyText.replace(/^Spec_/i, "").replace(/_/g, " ").trim();
    specPairs.push(`${label}: ${val}`);
    if (specPairs.length >= 20) break;
  }
  if (specPairs.length > 0) {
    return specPairs.join("\n").slice(0, 16000);
  }

  return String(mappedDescription || "").trim();
}

function toInventreeItem(row, hints, capture, mappingTemplateOverride) {
  const mappingTemplate = mappingTemplateOverride || getMappingTemplateForCapture(capture, hints);
  const rowKeys = Object.keys(row || {});
  const mappedName = pickMappedValue(row, capture, mappingTemplate.name);
  const mappedDescription = pickMappedValue(row, capture, mappingTemplate.description);
  const mappedQuantity = pickMappedValue(row, capture, mappingTemplate.quantity);
  const mappedCategory = pickMappedValue(row, capture, mappingTemplate.category);
  const mappedSubcategory = pickMappedValue(row, capture, mappingTemplate.subcategory);
  const mappedVariant = pickMappedValue(row, capture, mappingTemplate.variant);
  const mappedNotes = pickMappedValue(row, capture, mappingTemplate.notes);

  const fallbackName = pickValue(row, [
    hints.nameHeaderHint,
    "Product Name",
    "Product",
    "Description",
    "Name"
  ]) || row.McMasterPartNumber || row.ASIN || "Product";
  const composedName = buildComposedName(row, capture, hints);
  const name = composedName || mappedName || fallbackName;

  const description = mappedDescription || pickValue(row, [
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
    ? pickImageUrl(row, hints, capture)
    : "";

  const variantText = mappedVariant || deriveVariantFallback(row);
  const notesText = mappedNotes || deriveNotesFallback(row, description);

  return {
    name,
    description,
    mpn,
    supplier_part_number: supplierPn,
    quantity: mappedQuantity || pickValue(row, ["Quantity", "Qty", "Order Quantity"]),
    category_text: mappedCategory,
    subcategory_text: mappedSubcategory,
    variant_text: variantText,
    notes: notesText,
    supplier_link: row.ProductURL || row["Product URL"] || "",
    image_url: imageUrl,
    source_fields: rowKeys,
    raw: row
  };
}

function buildComposedName(row, capture, hints) {
  const rawFields = String(hints?.nameComposeFields || "").trim();
  if (!rawFields) return "";

  const fields = rawFields
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (fields.length === 0) return "";

  const delimiter = String(hints?.nameComposeDelimiter || " - ");
  const parts = fields
    .map((field) => resolveNamedSourceField(row, capture, field))
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  return parts.length > 0 ? parts.join(delimiter) : "";
}

function resolveNamedSourceField(row, capture, fieldName) {
  const field = String(fieldName || "").trim();
  if (!field) return "";

  switch (field) {
    case "__page_title":
      return String(capture?.pageTitle || "");
    case "__page_url":
      return String(capture?.pageUrl || "");
    case "__page_breadcrumbs":
      return String(capture?.pageBreadcrumbs || "");
    case "__page_section_summary":
      return String(capture?.pageSectionSummary || "");
    case "__left_filters":
      return String(capture?.leftFiltersSummary || "");
    case "__page_primary_image":
      return String(capture?.pagePrimaryImageUrl || "");
    case "__sidebar_primary_image":
      return String(capture?.sidebarPrimaryImageUrl || "");
    case "__selected_page_image":
      return String(capture?.selectedPageImageUrl || "");
    default:
      break;
  }

  const keyLc = field.toLowerCase();
  for (const [key, value] of Object.entries(row || {})) {
    if (String(key || "").trim().toLowerCase() === keyLc) {
      return String(value || "");
    }
  }
  return "";
}

function getMappingTemplateForCapture(capture, hints) {
  return resolveTemplateForCapture(capture, hints).template;
}

function pickMappedValue(row, capture, config) {
  const sourceField = String(config?.sourceField || "").trim();
  if (!sourceField) return "";

  const value = String(resolveNamedSourceField(row, capture, sourceField) || "");

  const trimmedValue = value.trim();
  if (!trimmedValue) return "";

  const regexText = String(config?.regex || "").trim();
  if (!regexText) return trimmedValue;

  try {
    const match = trimmedValue.match(buildUserRegex(regexText));
    if (!match) return "";
    return String(match[1] || match[0] || "").trim();
  } catch {
    return trimmedValue;
  }
}

function buildUserRegex(value) {
  const text = String(value || "").trim();
  const slashMatch = text.match(/^\/(.*)\/([a-z]*)$/i);
  if (slashMatch) {
    return new RegExp(slashMatch[1], slashMatch[2]);
  }
  return new RegExp(text, "i");
}

function pickImageUrl(row, hints, capture) {
  const globalSourceField = String(hints?.globalImageSourceField || "").trim();
  if (globalSourceField) {
    const forcedValue = resolveNamedSourceField(row, capture, globalSourceField);
    const forcedImage = firstImageUrlInText(forcedValue);
    if (forcedImage) return forcedImage;
  }

  const hint = String(hints?.imageHeaderHint || "").trim().toLowerCase();
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
    "notes",
    "mpn",
    "supplier_part_number",
    "quantity",
    "category_text",
    "subcategory_text",
    "variant_text",
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
        case "notes":
          return csvEscape(item.notes);
        case "mpn":
          return csvEscape(item.mpn);
        case "supplier_part_number":
          return csvEscape(item.supplier_part_number);
        case "quantity":
          return csvEscape(item.quantity);
        case "category_text":
          return csvEscape(item.category_text);
        case "subcategory_text":
          return csvEscape(item.subcategory_text);
        case "variant_text":
          return csvEscape(item.variant_text);
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
