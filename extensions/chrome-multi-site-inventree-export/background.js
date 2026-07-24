const DEFAULT_SETTINGS = {
  inventreeUrl: "",
  inventreeToken: "",
  inventreeEndpointPath: "/plugin/multi-site-importer/captures/",
  sourceMode: "auto",
  captureProfile: "auto",
  crawlLinkedPages: true,
  maxLinkedPages: 100
};

const MAPPING_TARGET_KEYS = ["name", "description", "quantity", "category", "subcategory", "variant", "notes"];

const LAST_CAPTURE_KEY = "lastCapture";
const LAST_SEND_RESPONSE_KEY = "lastSendResponse";
const LAST_WORKSPACE_URL_KEY = "lastWorkspaceUrl";
const CAPTURE_PROGRESS_KEY = "captureProgress";

async function setCaptureProgress(progress) {
  const state = {
    status: String(progress?.status || "idle"),
    completed: Number(progress?.completed || 0),
    total: Number(progress?.total || 0),
    message: String(progress?.message || ""),
    updatedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ [CAPTURE_PROGRESS_KEY]: state });

  let badgeText = "";
  let badgeColor = "#176f91";
  if (state.status === "running") {
    badgeText = state.total > 0 ? `${state.completed}/${state.total}` : "…";
  } else if (state.status === "complete") {
    badgeText = "✓";
    badgeColor = "#237a3b";
  } else if (state.status === "failed") {
    badgeText = "!";
    badgeColor = "#a12c24";
  }
  await chrome.action.setBadgeBackgroundColor({ color: badgeColor });
  await chrome.action.setBadgeText({ text: badgeText });
  await chrome.action.setTitle({
    title: state.message || "Multi-Site Inventory Capture"
  });
  return state;
}

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
      const data = await chrome.storage.local.get([LAST_CAPTURE_KEY, LAST_WORKSPACE_URL_KEY, CAPTURE_PROGRESS_KEY]);
      return {
        ok: true,
        settings,
        lastCapture: data[LAST_CAPTURE_KEY] || null,
        lastWorkspaceUrl: data[LAST_WORKSPACE_URL_KEY] || "",
        captureProgress: data[CAPTURE_PROGRESS_KEY] || null
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
      await setCaptureProgress({
        status: "running",
        message: "Preparing supplier capture…"
      });
      try {
        const capture = await captureCurrentTabData(
          merged,
          message?.selectedChildLinks || [],
          message?.targetTabId
        );
        await chrome.storage.local.set({ [LAST_CAPTURE_KEY]: capture });
        await setCaptureProgress({
          status: "complete",
          completed: Number(capture.linkedPagesCrawled || capture.pagesScraped || 1),
          total: Number(capture.linkedPagesCrawled || capture.pagesScraped || 1),
          message: `Capture complete: ${capture.rows?.length || 0} row(s).`
        });
        return { ok: true, capture };
      } catch (error) {
        await setCaptureProgress({
          status: "failed",
          message: `Capture failed: ${String(error?.message || error)}`
        });
        throw error;
      }
    }

    case "previewLinkedPages": {
      const incoming = sanitizeSettings(message?.settings || {});
      const persisted = await getSettings();
      const merged = { ...persisted, ...incoming };
      const { links, itemLabels } = await previewLinkedPages(merged, message?.targetTabId);
      return { ok: true, links, itemLabels };
    }

    case "importDataset": {
      const capture = buildImportedDatasetCapture({
        fileName: message?.fileName,
        text: message?.text,
        metadata: message?.metadata
      });
      await chrome.storage.local.set({ [LAST_CAPTURE_KEY]: capture });
      await setCaptureProgress({
        status: "complete",
        completed: capture.rows.length,
        total: capture.rows.length,
        message: `Dataset imported: ${capture.rows.length} row(s).`
      });
      return {
        ok: true,
        capture,
        warnings: capture.importWarnings || []
      };
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
        payload = JSON.stringify(buildRawCapture(message.capture), null, 2);
        mimeType = "application/json";
      } else {
        payload = buildRawCaptureCsv(message.capture);
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

    case "submitCapture": {
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

      const result = await submitCaptureToPlugin(capture, merged);
      if (result.ok && result.workspacePath) {
        result.workspaceUrl = new URL(result.workspacePath, merged.inventreeUrl).toString();
        await chrome.storage.local.set({ [LAST_WORKSPACE_URL_KEY]: result.workspaceUrl });
      }
      return result;
    }

    default:
      return { ok: false, error: "Unknown message type." };
  }
}

async function submitCaptureToPlugin(capture, merged) {
  const rawCapture = {
    contract_version: "1.0",
    capture_profile: String(capture.captureProfile || "auto"),
    source: String(capture.source || "unknown"),
    page_type: String(capture.pageType || ""),
    captured_at: capture.capturedAt || new Date().toISOString(),
    page_title: String(capture.pageTitle || ""),
    page_url: String(capture.pageUrl || ""),
    headers: Array.isArray(capture.headers) ? capture.headers : [],
    rows: Array.isArray(capture.rows) ? capture.rows : [],
    pages_scraped: Number(capture.pagesScraped || 1)
  };
  const payload = {
    contract_version: rawCapture.contract_version,
    capture_profile: rawCapture.capture_profile,
    source: rawCapture.source,
    page_type: rawCapture.page_type,
    page_title: rawCapture.page_title,
    page_url: rawCapture.page_url,
    captured_at: rawCapture.captured_at,
    payload: rawCapture
  };
  const url = new URL(merged.inventreeEndpointPath || "/plugin/multi-site-importer/captures/", merged.inventreeUrl).toString();

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

  const responseJson = tryParseJson(text) || {};
  return {
    ok: true,
    status: response.status,
    rowCount: rawCapture.rows.length,
    captureId: responseJson.capture_id ?? null,
    workspacePath: responseJson.workspace_path || "",
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
  const sourceMode = String(input.sourceMode || "auto").trim().toLowerCase();
  const sourceModeSafe = ["auto", "mcmaster", "boltdepot", "amazon"].includes(sourceMode) ? sourceMode : "auto";
  const captureProfile = String(input.captureProfile || "auto").trim().toLowerCase();
  return {
    inventreeUrl: String(input.inventreeUrl || "").trim(),
    inventreeToken: String(input.inventreeToken || "").trim(),
    inventreeEndpointPath: normalizePath(input.inventreeEndpointPath, "/plugin/multi-site-importer/captures/"),
    sourceMode: sourceModeSafe,
    captureProfile: ["auto", "list-details", "single-item"].includes(captureProfile) ? captureProfile : "auto",
    crawlLinkedPages: Boolean(input.crawlLinkedPages),
    maxLinkedPages: Math.min(500, Math.max(1, Number(input.maxLinkedPages || 100)))
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

function buildImportedDatasetCapture({ fileName, text, metadata }) {
  const safeName = String(fileName || "imported-dataset").trim().slice(0, 240);
  const contents = String(text || "");
  if (!contents.trim()) throw new Error("The selected dataset file is empty.");
  if (contents.length > 25 * 1024 * 1024) {
    throw new Error("Dataset files are limited to 25 MB.");
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

async function captureCurrentTabData(settings, selectedChildLinks, targetTabId) {
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

  throw new Error("Unsupported page. Open a McMaster-Carr, Bolt Depot, or Amazon orders/order-detail page.");
}

async function previewLinkedPages(settings, targetTabId) {
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

  if (provider !== "boltdepot" && provider !== "mcmaster") {
    return { links: [], itemLabels: {} };
  }

  const data = provider === "boltdepot"
    ? await executeScraperOnTab(tab.id, scrapeBoltDepotPageData)
    : await executeScraperOnTab(tab.id, scrapeMcMasterCategoryData);
  const links = itemDetailTargets(data?.rows || [], data?.childLinks || [], [], maxLinks);
  const itemLabels = {};
  for (const row of data?.rows || []) {
    const url = String(row?.ProductURL || row?.["Product URL"] || "").trim();
    if (!url) continue;
    itemLabels[url] = String(row?.Product || row?.Description || row?.McMasterPartNumber || row?.BoltDepotPartNumber || url);
  }
  return { links, itemLabels };
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
    target: { tabId, allFrames: true },
    func: scraper
  });
  const results = (injected || []).map((entry) => entry?.result).filter(Boolean);
  if (results.length === 0) return null;

  function resultScore(result) {
    let score = result?.ok ? 100 : 0;
    const rows = Array.isArray(result?.rows) ? result.rows : (result?.row ? [result.row] : []);
    score += rows.length * 1000;
    for (const row of rows.slice(0, 10)) {
      for (const value of Object.values(row || {})) {
        const text = String(value || "").trim();
        if (text) score += Math.min(40, text.length);
      }
      score += String(row?.ProductDetailSpecs || "").length * 4;
      score += String(row?.ProductDetailBreadcrumbs || "").length * 2;
    }
    const title = String(result?.pageTitle || result?.row?.ProductDetailPageTitle || "").trim();
    if (title && !/^mcmaster-carr$/i.test(title)) score += 500;
    return score;
  }

  return results.sort((left, right) => resultScore(right) - resultScore(left))[0];
}

async function waitForMcMasterDetailResult(tabId, timeoutMs = 12000) {
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

async function mapWithConcurrency(items, concurrency, worker) {
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

function normalizedUrl(value) {
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

function itemDetailTargets(rows, fallbackLinks, selectedLinks, maxLinks) {
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

function mergeRowsWithDetails(baseRows, detailRows, partField) {
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

async function captureMcmasterTab(tab, settings, selectedChildLinks) {
  if (!/mcmaster\.com/i.test(tab.url || "")) {
    throw new Error("Active tab is not a McMaster-Carr page.");
  }

  if (settings.captureProfile === "single-item") {
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

async function captureBoltDepotTab(tab, settings, selectedChildLinks) {
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

async function captureAmazonTab(tab, settings, selectedOrderItems) {
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

  function firstText(selectors) {
    for (const selector of selectors) {
      const value = normalizeText(document.querySelector(selector)?.textContent || "");
      if (value) return value;
    }
    return "";
  }

  function absoluteHttpUrl(value) {
    const raw = String(value || "").trim();
    if (!raw || raw.startsWith("data:")) return "";
    try {
      const parsed = new URL(raw, location.href);
      return /^https?:$/i.test(parsed.protocol) ? parsed.href : "";
    } catch {
      return "";
    }
  }

  function addImage(value, output, seen) {
    const url = absoluteHttpUrl(value);
    if (
      !url ||
      seen.has(url) ||
      /transparent-pixel|grey-pixel|sprite|loading/i.test(url)
    ) return;
    seen.add(url);
    output.push(url);
  }

  function addSpec(target, rawKey, rawValue) {
    const key = normalizeText(rawKey).replace(/[\s:]+$/, "");
    const value = normalizeText(rawValue);
    if (!key || !value || key.length > 120 || key === value) return;
    if (!target[key]) target[key] = value;
  }

  function specValue(specs, labels) {
    const entries = Object.entries(specs);
    for (const label of labels) {
      const wanted = label.toLowerCase();
      const match = entries.find(
        ([key]) => normalizeText(key).toLowerCase() === wanted
      );
      if (match) return match[1];
    }
    return "";
  }

  function parseJsonLd() {
    const products = [];
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent || "null");
        const pending = Array.isArray(parsed) ? [...parsed] : [parsed];
        while (pending.length) {
          const value = pending.shift();
          if (!value || typeof value !== "object") continue;
          if (Array.isArray(value)) {
            pending.push(...value);
            continue;
          }
          const type = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
          if (type.some((item) => String(item).toLowerCase() === "product")) products.push(value);
          if (Array.isArray(value["@graph"])) pending.push(...value["@graph"]);
        }
      } catch {
        // Ignore malformed structured data and continue with the visible page.
      }
    }
    return products[0] || {};
  }

  const structured = parseJsonLd();
  const canonicalAsinMatch = (
    location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i) ||
    String(document.querySelector("input#ASIN")?.value || "").match(/([A-Z0-9]{10})/i) ||
    String(structured.sku || "").match(/^([A-Z0-9]{10})$/i)
  );
  const asin = canonicalAsinMatch ? canonicalAsinMatch[1].toUpperCase() : "";

  const titleEl =
    document.getElementById("productTitle") ||
    document.querySelector("span#productTitle") ||
    document.querySelector("h1.a-size-large") ||
    document.querySelector("h1");
  const title = normalizeText(
    titleEl?.textContent ||
    structured.name ||
    document.querySelector('meta[property="og:title"]')?.content ||
    document.title ||
    ""
  );

  const brandEl =
    document.getElementById("bylineInfo") ||
    document.querySelector("#brand") ||
    document.querySelector("a#bylineInfo_feature_div a");
  const visibleBrand = normalizeText(
    (brandEl?.textContent || "")
      .replace(/^Visit the\s+/i, "")
      .replace(/\s+Store$/i, "")
  );
  const structuredBrand = typeof structured.brand === "object"
    ? structured.brand?.name
    : structured.brand;

  // Capture the complete product gallery, preferring original/high-resolution URLs.
  const imageUrls = [];
  const seenImages = new Set();
  const landingImg =
    document.getElementById("landingImage") ||
    document.getElementById("imgBlkFront") ||
    document.querySelector("#main-image-container img");
  const imageElements = [
    ...(landingImg ? [landingImg] : []),
    ...document.querySelectorAll(
      "#altImages img, #imageBlock img, #main-image-container img, " +
      "#aplus img, #aplus_feature_div img"
    )
  ];
  for (const image of imageElements) {
    const dynamicData = image.getAttribute("data-a-dynamic-image");
    if (dynamicData) {
      try {
        const imgMap = JSON.parse(dynamicData);
        Object.entries(imgMap)
          .sort((left, right) => {
            const area = (entry) => Array.isArray(entry[1])
              ? Number(entry[1][0] || 0) * Number(entry[1][1] || 0)
              : 0;
            return area(right) - area(left);
          })
          .forEach(([url]) => addImage(url, imageUrls, seenImages));
      } catch {
        // Continue with the normal image attributes.
      }
    }
    addImage(image.getAttribute("data-old-hires"), imageUrls, seenImages);
    addImage(image.getAttribute("data-a-hires"), imageUrls, seenImages);
    addImage(image.currentSrc, imageUrls, seenImages);
    addImage(image.getAttribute("src"), imageUrls, seenImages);
  }
  const structuredImages = Array.isArray(structured.image) ? structured.image : [structured.image];
  for (const image of structuredImages) {
    addImage(typeof image === "object" ? image?.url : image, imageUrls, seenImages);
  }
  addImage(document.querySelector('meta[property="og:image"]')?.content, imageUrls, seenImages);
  const imageUrl = imageUrls[0] || "";

  const priceEl =
    document.querySelector(".a-price .a-offscreen") ||
    document.querySelector(".apexPriceToPay .a-offscreen") ||
    document.querySelector("#priceblock_ourprice") ||
    document.querySelector("#priceblock_dealprice") ||
    document.querySelector(".a-price");
  const offer = Array.isArray(structured.offers) ? structured.offers[0] : (structured.offers || {});
  const price = normalizeText(
    priceEl?.textContent ||
    offer.price ||
    document.querySelector('meta[property="product:price:amount"]')?.content ||
    ""
  );
  const priceCurrency = normalizeText(
    offer.priceCurrency ||
    document.querySelector('meta[property="product:price:currency"]')?.content ||
    ""
  );

  const specsObj = {};
  const specRows = Array.from(
    document.querySelectorAll(
      "#productDetails_techSpec_section_1 tr, " +
        "#productDetails_techSpec_section_2 tr, " +
        "#productDetails_detailBullets_sections1 tr, " +
        "#productDetails_db_sections tr, " +
        "#prodDetails tr, " +
        "#tech-specs-table tr, " +
        ".product-specs-table tr, " +
        "[id^='productDetails'] tr"
    )
  );
  for (const row of specRows) {
    const th = normalizeText(row.querySelector("th")?.textContent || "");
    const td = normalizeText(row.querySelector("td")?.textContent || "");
    addSpec(specsObj, th, td);
  }

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
      addSpec(specsObj, spans[0].textContent, spans[spans.length - 1].textContent);
    } else {
      const text = normalizeText(item.textContent);
      const colonIdx = text.indexOf(":");
      if (colonIdx > 0 && colonIdx < 80) {
        addSpec(specsObj, text.slice(0, colonIdx), text.slice(colonIdx + 1));
      }
    }
  }

  const featureBullets = Array.from(
    document.querySelectorAll(
      "#feature-bullets ul li span.a-list-item, " +
        "#feature-bullets .a-unordered-list li span, " +
        "#featurebullets_feature_div li span.a-list-item"
    )
  )
    .map((el) => normalizeText(el.textContent))
    .filter((text, index, values) => text && text.length > 10 && values.indexOf(text) === index)
    .slice(0, 10);

  const description =
    normalizeText(
      document.querySelector("#productDescription p, #productDescription")?.textContent || ""
    ) ||
    normalizeText(structured.description || "") ||
    featureBullets.join("; ");

  const aboutItem = featureBullets.join("\n");
  const modelNumber = specValue(specsObj, [
    "Item model number", "Model Number", "Model", "Part Number"
  ]) || normalizeText(structured.model || "");
  const manufacturerPartNumber = specValue(specsObj, [
    "Part Number", "Manufacturer Part Number", "Manufacturer reference"
  ]) || normalizeText(structured.mpn || modelNumber);
  const manufacturer = specValue(specsObj, ["Manufacturer"]) || normalizeText(
    typeof structured.manufacturer === "object"
      ? structured.manufacturer?.name
      : structured.manufacturer
  );
  const brand = visibleBrand || normalizeText(structuredBrand || manufacturer);
  const upc = specValue(specsObj, ["UPC"]) || normalizeText(structured.gtin12 || "");
  const ean = specValue(specsObj, ["EAN"]) || normalizeText(structured.gtin13 || "");

  const breadcrumbs = Array.from(
    document.querySelectorAll(
      "#wayfinding-breadcrumbs_feature_div a, .a-breadcrumb a"
    )
  )
    .map((el) => normalizeText(el.textContent))
    .filter((text, index, values) => text && values.indexOf(text) === index);
  const category = breadcrumbs.join(" > ");

  const selectedVariations = [];
  for (const container of document.querySelectorAll(
    "#twister .a-row, #twister_feature_div .a-row, [id^='variation_']"
  )) {
    const label = normalizeText(
      container.querySelector(".a-form-label, label")?.textContent || ""
    ).replace(/:\s*$/, "");
    const value = normalizeText(
      container.querySelector(".selection, .a-dropdown-prompt, .swatchSelect")?.textContent ||
      container.querySelector("[aria-checked='true']")?.getAttribute("title") ||
      container.querySelector(".selected")?.getAttribute("title") ||
      ""
    ).replace(/^Click to select\s*/i, "");
    if (label && value) selectedVariations.push(`${label}: ${value}`);
  }

  const availability = firstText([
    "#availability span", "#outOfStock", "#availabilityInsideBuyBox_feature_div"
  ]) || normalizeText(offer.availability || "").replace(/^https?:\/\/schema\.org\//i, "");
  const seller = firstText([
    "#sellerProfileTriggerId", "#merchant-info a", "#merchantInfoFeature_feature_div a"
  ]) || normalizeText(typeof offer.seller === "object" ? offer.seller?.name : offer.seller);
  const shipsFrom = firstText([
    "#fulfillerInfoFeature_feature_div .offer-display-feature-text-message",
    "#tabular-buybox-truncate-0 .tabular-buybox-text"
  ]);
  const condition = firstText([
    "#newAccordionRow .header-price", "#usedAccordionRow .header-price", "#condition"
  ]) || normalizeText(offer.itemCondition || "").replace(/^https?:\/\/schema\.org\//i, "");
  const canonicalUrl = asin ? `${location.origin}/dp/${asin}` : (
    document.querySelector('link[rel="canonical"]')?.href || location.href
  );

  const specLines = Object.entries(specsObj).map(([key, value]) => `${key}: ${value}`);
  const row = {
    ...specsObj,
    "Product Name": title,
    "Brand": brand,
    "Manufacturer": manufacturer,
    "ASIN": asin,
    "Supplier SKU": asin,
    "Model Number": modelNumber,
    "Manufacturer Part Number": manufacturerPartNumber,
    "UPC": upc,
    "EAN": ean,
    "Category": category,
    "Description": description,
    "About This Item": aboutItem,
    "Selected Variations": selectedVariations.join("\n"),
    "Price": price,
    "Price Currency": priceCurrency,
    "Availability": availability,
    "Condition": condition,
    "Sold By": seller,
    "Ships From": shipsFrom,
    "Product URL": canonicalUrl,
    "Source Page URL": location.href,
    "Image URL": imageUrl,
    "Image URLs": imageUrls.join("\n"),
    "Image Count": imageUrls.length,
    "Product Detail Specs": specLines.join("\n")
  };

  return {
    ok: Boolean(title && (asin || modelNumber || imageUrl)),
    title,
    pageTitle: title,
    pageBreadcrumbs: category,
    asin,
    headers: Object.keys(row),
    row,
    imageUrl,
    imageUrls,
    productUrl: canonicalUrl,
    error: title
      ? "Product title was found, but no ASIN, model number, or product image could be extracted."
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

function scrapeBoltDepotPageData() {
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

function scrapeBoltDepotProductDetailData() {
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

function scrapeMcMasterCategoryData() {
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

function scrapeMcMasterProductDetailData() {
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

  function firstImageSrc(container) {
    for (const image of Array.from(container?.querySelectorAll?.("img[src], img[data-src], img[data-original], source[srcset]") || [])) {
      const alt = normalizeText(image.getAttribute("alt") || "");
      if (/image\s*not\s*found|placeholder/i.test(alt)) continue;
      const srcset = image.getAttribute("srcset") || "";
      if (srcset) {
        const first = srcset.split(",")[0]?.trim().split(" ")[0] || "";
        const cleaned = toAbsolute(first);
        if (cleaned) return cleaned;
      }
      const cleaned = toAbsolute(image.getAttribute("src") || image.getAttribute("data-src") || image.getAttribute("data-original") || "");
      if (cleaned) return cleaned;
    }
    return "";
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

  const imageUrl = firstImageSrc(document.querySelector("main, [role='main']") || document.body);
  const row = {
    Product: title || (partNumber ? `Part ${partNumber}` : "Product"),
    Description: title,
    ProductURL: location.href,
    McMasterPartNumber: partNumber,
    RowImageURL: imageUrl,
    RowImageSource: imageUrl ? "product-page" : "none",
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

function buildExportFilename(format) {
  const ts = new Date().toISOString().replace(/[:]/g, "-").replace(/\..+$/, "");
  return `product-inventory-export/${ts}-captured-catalog.${format}`;
}

function buildRawCapture(capture) {
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

function buildRawCaptureCsv(capture) {
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
