const els = {
  inventreeSyncMode: document.getElementById("inventreeSyncMode"),
  inventreeUrl: document.getElementById("inventreeUrl"),
  inventreeToken: document.getElementById("inventreeToken"),
  inventreeEndpointPath: document.getElementById("inventreeEndpointPath"),
  inventreePartApiPath: document.getElementById("inventreePartApiPath"),
  inventreeSupplierPartApiPath: document.getElementById("inventreeSupplierPartApiPath"),
  inventreeStockItemApiPath: document.getElementById("inventreeStockItemApiPath"),
  inventreeDefaultCategoryId: document.getElementById("inventreeDefaultCategoryId"),
  enableCategoryBuilder: document.getElementById("enableCategoryBuilder"),
  inventreeDefaultSupplierId: document.getElementById("inventreeDefaultSupplierId"),
  inventreeDefaultLocationId: document.getElementById("inventreeDefaultLocationId"),
  stockQuantityHeaderHint: document.getElementById("stockQuantityHeaderHint"),
  defaultStockQuantity: document.getElementById("defaultStockQuantity"),
  syncSupplierParts: document.getElementById("syncSupplierParts"),
  syncStockRecords: document.getElementById("syncStockRecords"),
  sourceMode: document.getElementById("sourceMode"),
  crawlLinkedPages: document.getElementById("crawlLinkedPages"),
  maxLinkedPages: document.getElementById("maxLinkedPages"),
  previewLinksBtn: document.getElementById("previewLinksBtn"),
  selectAllLinksBtn: document.getElementById("selectAllLinksBtn"),
  selectFilteredLinksBtn: document.getElementById("selectFilteredLinksBtn"),
  clearFilteredLinksBtn: document.getElementById("clearFilteredLinksBtn"),
  invertFilteredLinksBtn: document.getElementById("invertFilteredLinksBtn"),
  clearAllLinksBtn: document.getElementById("clearAllLinksBtn"),
  linkedPagesFilter: document.getElementById("linkedPagesFilter"),
  linkedPagesSummary: document.getElementById("linkedPagesSummary"),
  linkedPagesList: document.getElementById("linkedPagesList"),
  nameHeaderHint: document.getElementById("nameHeaderHint"),
  descriptionHeaderHint: document.getElementById("descriptionHeaderHint"),
  mpnHeaderHint: document.getElementById("mpnHeaderHint"),
  supplierPnHeaderHint: document.getElementById("supplierPnHeaderHint"),
  imageHeaderHint: document.getElementById("imageHeaderHint"),
  partImageUploadPath: document.getElementById("partImageUploadPath"),
  partIdResponsePath: document.getElementById("partIdResponsePath"),
  existingMatchStrategy: document.getElementById("existingMatchStrategy"),
  includeImageUrls: document.getElementById("includeImageUrls"),
  uploadImagesIfSupported: document.getElementById("uploadImagesIfSupported"),
  testPathBtn: document.getElementById("testPathBtn"),
  mappingTemplateScope: document.getElementById("mappingTemplateScope"),
  fetchCategoriesBtn: document.getElementById("fetchCategoriesBtn"),
  existingCategorySelect: document.getElementById("existingCategorySelect"),
  categoryPickerMeta: document.getElementById("categoryPickerMeta"),
  helpBtn: document.getElementById("helpBtn"),
  openFullPageBtn: document.getElementById("openFullPageBtn"),
  helpPanel: document.getElementById("helpPanel"),
  copyPluginExampleBtn: document.getElementById("copyPluginExampleBtn"),
  copyDirectExampleBtn: document.getElementById("copyDirectExampleBtn"),
  dryRunBtn: document.getElementById("dryRunBtn"),
  dryRunDetails: document.getElementById("dryRunDetails"),
  dryRunDetailsList: document.getElementById("dryRunDetailsList"),
  saveSettingsBtn: document.getElementById("saveSettingsBtn"),
  captureBtn: document.getElementById("captureBtn"),
  sendBtn: document.getElementById("sendBtn"),
  jsonBtn: document.getElementById("jsonBtn"),
  csvBtn: document.getElementById("csvBtn"),
  captureMeta: document.getElementById("captureMeta"),
  preview: document.getElementById("preview"),
  mappedPreview: document.getElementById("mappedPreview"),
  mappedPreviewMeta: document.getElementById("mappedPreviewMeta"),
  status: document.getElementById("status")
};

let lastCapture = null;
let previewLinkedPages = [];
let itemLabels = {};
const selectedLinkedPages = new Set();
let storedMappingTemplates = {};
let fetchedInventreeCategories = [];
const mappingSourceInputs = Array.from(document.querySelectorAll("select[data-map-source]"));
const mappingRegexInputs = Array.from(document.querySelectorAll("input[data-map-regex]"));
const MAPPING_TARGET_KEYS = ["name", "description", "quantity", "category", "subcategory", "variant"];

function isFullMode() {
  return new URLSearchParams(window.location.search).get("mode") === "full";
}

function initializeLayoutMode() {
  if (!isFullMode()) return;
  document.body.classList.add("full-mode");
  document.title = "Multi-Site Inventory Exporter - Full View";
  if (els.openFullPageBtn) {
    els.openFullPageBtn.textContent = "Full View Open";
    els.openFullPageBtn.disabled = true;
  }
}

function setStatus(message, kind = "") {
  els.status.textContent = message;
  els.status.className = `status ${kind}`.trim();
}

function renderFetchedCategories() {
  if (!els.existingCategorySelect) return;
  const options = ['<option value="">Select existing category for default/root</option>'];
  for (const category of fetchedInventreeCategories) {
    const id = String(category?.pk ?? category?.id ?? "").trim();
    const label = String(category?.display_path || category?.name || id);
    if (!id) continue;
    options.push(`<option value="${escapeHtml(id)}">${escapeHtml(`${label} (#${id})`)}</option>`);
  }
  els.existingCategorySelect.innerHTML = options.join("");
  if (els.inventreeDefaultCategoryId.value) {
    els.existingCategorySelect.value = els.inventreeDefaultCategoryId.value;
  }
}

function normalizeTemplateKey(value) {
  const key = String(value || "default").trim().toLowerCase();
  return key === "mcmaster-carr" ? "mcmaster" : key;
}

function getCurrentTemplateKey() {
  if (lastCapture?.source) {
    const source = normalizeTemplateKey(lastCapture.source);
    const pageType = normalizeTemplateKey(lastCapture.pageType || "default");
    return `${source}:${pageType}`;
  }
  return `${normalizeTemplateKey(els.sourceMode?.value || "default")}:default`;
}

function getCurrentTemplate() {
  const key = getCurrentTemplateKey();
  const fallbackKey = `${normalizeTemplateKey(lastCapture?.source || els.sourceMode?.value || "default")}:default`;
  const legacyKey = normalizeTemplateKey(lastCapture?.source || els.sourceMode?.value || "default");
  const template = storedMappingTemplates[key] && typeof storedMappingTemplates[key] === "object"
    ? storedMappingTemplates[key]
    : storedMappingTemplates[fallbackKey] && typeof storedMappingTemplates[fallbackKey] === "object"
      ? storedMappingTemplates[fallbackKey]
      : storedMappingTemplates[legacyKey] && typeof storedMappingTemplates[legacyKey] === "object"
        ? storedMappingTemplates[legacyKey]
        : {};
  const output = {};
  for (const targetKey of MAPPING_TARGET_KEYS) {
    output[targetKey] = {
      sourceField: String(template?.[targetKey]?.sourceField || "").trim(),
      regex: String(template?.[targetKey]?.regex || "").trim()
    };
  }
  return output;
}

function buildFieldOptionsForTemplate() {
  const options = [
    { value: "", label: "Auto / None" },
    { value: "__page_title", label: "Page Title" },
    { value: "__page_url", label: "Page URL" }
  ];

  const headers = Array.isArray(lastCapture?.headers) ? lastCapture.headers : [];
  for (const header of headers) {
    options.push({ value: header, label: header });
  }
  return options;
}

function renderMappingTemplateEditors() {
  const options = buildFieldOptionsForTemplate();
  const template = getCurrentTemplate();
  const scopeLabel = getCurrentTemplateKey();

  if (els.mappingTemplateScope) {
    const sourceCount = Math.max(0, options.length - 3);
    els.mappingTemplateScope.textContent = `Template scope: ${scopeLabel}. Captured source fields available: ${sourceCount}. Templates can vary by source and page type.`;
  }

  for (const select of mappingSourceInputs) {
    const targetKey = select.getAttribute("data-map-source") || "";
    const selectedValue = template?.[targetKey]?.sourceField || "";
    const finalOptions = [...options];
    if (selectedValue && !finalOptions.some((item) => item.value === selectedValue)) {
      finalOptions.push({ value: selectedValue, label: `${selectedValue} (saved)` });
    }
    select.innerHTML = finalOptions
      .map((item) => `<option value="${escapeHtml(item.value)}">${escapeHtml(item.label)}</option>`)
      .join("");
    select.value = selectedValue;
  }

  for (const input of mappingRegexInputs) {
    const targetKey = input.getAttribute("data-map-regex") || "";
    input.value = template?.[targetKey]?.regex || "";
  }
}

function collectMappingTemplateFromForm() {
  const template = {};
  for (const targetKey of MAPPING_TARGET_KEYS) {
    const select = mappingSourceInputs.find((item) => item.getAttribute("data-map-source") === targetKey);
    const regexInput = mappingRegexInputs.find((item) => item.getAttribute("data-map-regex") === targetKey);
    template[targetKey] = {
      sourceField: String(select?.value || "").trim(),
      regex: String(regexInput?.value || "").trim()
    };
  }
  return template;
}

function clearDryRunDetails() {
  if (!els.dryRunDetails || !els.dryRunDetailsList) return;
  els.dryRunDetailsList.innerHTML = "";
  els.dryRunDetails.classList.remove("visible");
}

function renderDryRunDetails(checks) {
  if (!els.dryRunDetails || !els.dryRunDetailsList) return;
  if (!Array.isArray(checks) || checks.length === 0) {
    clearDryRunDetails();
    return;
  }

  const html = checks
    .map((item) => {
      const ok = Boolean(item?.ok);
      const label = escapeHtml(item?.label || "Unnamed check");
      const message = escapeHtml(item?.message || "");
      return `<div class="dryrun-item ${ok ? "pass" : "fail"}">${ok ? "PASS" : "FAIL"}: ${label}${message ? ` - ${message}` : ""}</div>`;
    })
    .join("");

  els.dryRunDetailsList.innerHTML = html;
  els.dryRunDetails.classList.add("visible");
}

function sendMessage(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function getHints() {
  return {
    inventreeSyncMode: els.inventreeSyncMode.value === "direct" ? "direct" : "plugin",
    nameHeaderHint: els.nameHeaderHint.value.trim(),
    descriptionHeaderHint: els.descriptionHeaderHint.value.trim(),
    mpnHeaderHint: els.mpnHeaderHint.value.trim(),
    supplierPnHeaderHint: els.supplierPnHeaderHint.value.trim(),
    imageHeaderHint: els.imageHeaderHint.value.trim(),
    inventreePartApiPath: els.inventreePartApiPath.value.trim() || "/api/part/",
    inventreeSupplierPartApiPath: els.inventreeSupplierPartApiPath.value.trim() || "/api/company/part/",
    inventreeStockItemApiPath: els.inventreeStockItemApiPath.value.trim() || "/api/stock/",
    inventreeDefaultCategoryId: els.inventreeDefaultCategoryId.value.trim(),
    enableCategoryBuilder: Boolean(els.enableCategoryBuilder.checked),
    inventreeDefaultSupplierId: els.inventreeDefaultSupplierId.value.trim(),
    inventreeDefaultLocationId: els.inventreeDefaultLocationId.value.trim(),
    stockQuantityHeaderHint: els.stockQuantityHeaderHint.value.trim(),
    defaultStockQuantity: els.defaultStockQuantity.value.trim(),
    syncSupplierParts: Boolean(els.syncSupplierParts.checked),
    syncStockRecords: Boolean(els.syncStockRecords.checked),
    includeImageUrls: Boolean(els.includeImageUrls.checked),
    uploadImagesIfSupported: Boolean(els.uploadImagesIfSupported.checked),
    partImageUploadPath: els.partImageUploadPath.value.trim() || "/api/part/{id}/upload/",
    partIdResponsePath: els.partIdResponsePath.value.trim(),
    existingMatchStrategy: els.existingMatchStrategy.value === "update" ? "update" : "skip",
    sourceMode: ["auto", "mcmaster", "boltdepot", "amazon"].includes(els.sourceMode.value) ? els.sourceMode.value : "auto",
    crawlLinkedPages: Boolean(els.crawlLinkedPages.checked),
    maxLinkedPages: Number(els.maxLinkedPages.value || 20)
  };
}

function applySettings(settings) {
  storedMappingTemplates = settings.mappingTemplates && typeof settings.mappingTemplates === "object"
    ? settings.mappingTemplates
    : {};
  els.inventreeSyncMode.value = settings.inventreeSyncMode === "direct" ? "direct" : "plugin";
  els.inventreeUrl.value = settings.inventreeUrl || "";
  els.inventreeToken.value = settings.inventreeToken || "";
  els.inventreeEndpointPath.value = settings.inventreeEndpointPath || "/api/plugin/product-import/";
  els.inventreePartApiPath.value = settings.inventreePartApiPath || "/api/part/";
  els.inventreeSupplierPartApiPath.value = settings.inventreeSupplierPartApiPath || "/api/company/part/";
  els.inventreeStockItemApiPath.value = settings.inventreeStockItemApiPath || "/api/stock/";
  els.inventreeDefaultCategoryId.value = settings.inventreeDefaultCategoryId || "";
  els.enableCategoryBuilder.checked = Boolean(settings.enableCategoryBuilder);
  els.inventreeDefaultSupplierId.value = settings.inventreeDefaultSupplierId || "";
  els.inventreeDefaultLocationId.value = settings.inventreeDefaultLocationId || "";
  els.stockQuantityHeaderHint.value = settings.stockQuantityHeaderHint || "";
  els.defaultStockQuantity.value = settings.defaultStockQuantity || "";
  els.syncSupplierParts.checked = settings.syncSupplierParts !== false;
  els.syncStockRecords.checked = Boolean(settings.syncStockRecords);
  els.sourceMode.value = ["auto", "mcmaster", "boltdepot", "amazon"].includes(settings.sourceMode) ? settings.sourceMode : "auto";
  els.crawlLinkedPages.checked = Boolean(settings.crawlLinkedPages);
  els.maxLinkedPages.value = String(settings.maxLinkedPages || 20);
  els.nameHeaderHint.value = settings.nameHeaderHint || "";
  els.descriptionHeaderHint.value = settings.descriptionHeaderHint || "";
  els.mpnHeaderHint.value = settings.mpnHeaderHint || "";
  els.supplierPnHeaderHint.value = settings.supplierPnHeaderHint || "";
  els.imageHeaderHint.value = settings.imageHeaderHint || "";
  els.partImageUploadPath.value = settings.partImageUploadPath || "/api/part/{id}/upload/";
  els.partIdResponsePath.value = settings.partIdResponsePath || "";
  els.existingMatchStrategy.value = settings.existingMatchStrategy === "update" ? "update" : "skip";
  els.includeImageUrls.checked = Boolean(settings.includeImageUrls);
  els.uploadImagesIfSupported.checked = Boolean(settings.uploadImagesIfSupported);
  renderFetchedCategories();
  renderMappingTemplateEditors();
}

function collectSettingsFromForm() {
  const mappingTemplates = {
    ...storedMappingTemplates,
    [getCurrentTemplateKey()]: collectMappingTemplateFromForm()
  };
  return {
    inventreeSyncMode: els.inventreeSyncMode.value === "direct" ? "direct" : "plugin",
    inventreeUrl: els.inventreeUrl.value.trim(),
    inventreeToken: els.inventreeToken.value.trim(),
    inventreeEndpointPath: els.inventreeEndpointPath.value.trim() || "/api/plugin/product-import/",
    inventreePartApiPath: els.inventreePartApiPath.value.trim() || "/api/part/",
    inventreeSupplierPartApiPath: els.inventreeSupplierPartApiPath.value.trim() || "/api/company/part/",
    inventreeStockItemApiPath: els.inventreeStockItemApiPath.value.trim() || "/api/stock/",
    inventreeDefaultCategoryId: els.inventreeDefaultCategoryId.value.trim(),
    enableCategoryBuilder: Boolean(els.enableCategoryBuilder.checked),
    inventreeDefaultSupplierId: els.inventreeDefaultSupplierId.value.trim(),
    inventreeDefaultLocationId: els.inventreeDefaultLocationId.value.trim(),
    stockQuantityHeaderHint: els.stockQuantityHeaderHint.value.trim(),
    defaultStockQuantity: els.defaultStockQuantity.value.trim(),
    mappingTemplates,
    syncSupplierParts: Boolean(els.syncSupplierParts.checked),
    syncStockRecords: Boolean(els.syncStockRecords.checked),
    ...getHints()
  };
}

function renderLinkedPagesSelection() {
  const filter = String(els.linkedPagesFilter?.value || "").trim().toLowerCase();

  function getLabelForUrl(url) {
    return itemLabels[url] || url;
  }

  const visibleLinks = filter
    ? previewLinkedPages.filter((url) => {
        const label = getLabelForUrl(url);
        return url.toLowerCase().includes(filter) || label.toLowerCase().includes(filter);
      })
    : previewLinkedPages;

  const total = previewLinkedPages.length;
  const selectedCount = Array.from(selectedLinkedPages).filter((url) => previewLinkedPages.includes(url)).length;
  els.linkedPagesSummary.textContent = `Items/pages: ${total}. Visible: ${visibleLinks.length}. Selected: ${selectedCount}.`;

  if (total === 0) {
    els.linkedPagesList.innerHTML = "<div style=\"font-size:11px;color:#51646b;padding:4px;\">No items or linked pages discovered yet.</div>";
    return;
  }

  if (visibleLinks.length === 0) {
    els.linkedPagesList.innerHTML = "<div style=\"font-size:11px;color:#51646b;padding:4px;\">No items match the current filter.</div>";
    return;
  }

  const html = visibleLinks
    .map((url) => {
      const checked = selectedLinkedPages.has(url) ? "checked" : "";
      const label = getLabelForUrl(url);
      const displayText = label !== url
        ? `${escapeHtml(label)}<br><span style="color:#697c85;font-size:10px;word-break:break-all;">${escapeHtml(url)}</span>`
        : escapeHtml(url);
      return `<label class="link-item"><input data-link-url="${encodeURIComponent(url)}" type="checkbox" ${checked} /><span>${displayText}</span></label>`;
    })
    .join("");
  els.linkedPagesList.innerHTML = html;

  const checkboxes = Array.from(els.linkedPagesList.querySelectorAll("input[type='checkbox'][data-link-url]"));
  for (const checkbox of checkboxes) {
    checkbox.addEventListener("change", () => {
      const encoded = checkbox.getAttribute("data-link-url") || "";
      const url = decodeURIComponent(encoded);
      if (!url) return;
      if (checkbox.checked) {
        selectedLinkedPages.add(url);
      } else {
        selectedLinkedPages.delete(url);
      }
      renderLinkedPagesSelection();
    });
  }
}

function selectedLinkedPageList() {
  return previewLinkedPages.filter((url) => selectedLinkedPages.has(url));
}

function getVisibleLinkedPages() {
  const filter = String(els.linkedPagesFilter?.value || "").trim().toLowerCase();
  return filter
    ? previewLinkedPages.filter((url) => {
        const label = itemLabels[url] || url;
        return url.toLowerCase().includes(filter) || label.toLowerCase().includes(filter);
      })
    : [...previewLinkedPages];
}

async function saveSettings() {
  setStatus("Saving settings...");
  const response = await sendMessage({
    type: "saveSettings",
    settings: collectSettingsFromForm()
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Failed to save settings");
  }
  storedMappingTemplates = response.settings?.mappingTemplates && typeof response.settings.mappingTemplates === "object"
    ? response.settings.mappingTemplates
    : storedMappingTemplates;
  renderMappingTemplateEditors();
  await renderMappedPreview();
  setStatus("Settings saved.", "ok");
}

function renderCapture(capture) {
  if (!capture || !Array.isArray(capture.rows)) {
    els.captureMeta.textContent = "No capture yet.";
    els.preview.innerHTML = "";
    if (els.mappedPreview) els.mappedPreview.innerHTML = "";
    if (els.mappedPreviewMeta) els.mappedPreviewMeta.textContent = "Capture a page to preview transformed fields.";
    return;
  }

  const lines = [
    `Source: ${capture.source || "-"}`,
    `Page Type: ${capture.pageType || "-"}`,
    `Title: ${capture.pageTitle || "-"}`,
    `URL: ${capture.pageUrl || "-"}`,
    `Rows: ${capture.rows.length}`,
    `Columns: ${capture.headers?.length || 0}`,
    `Pages Scraped: ${capture.pagesScraped || 1}`,
    `Captured At: ${capture.capturedAt || "-"}`
  ];
  els.captureMeta.textContent = lines.join("\n");

  const previewRows = capture.rows.slice(0, 5);
  const previewHeaders = capture.headers.slice(0, 6);

  if (previewHeaders.length === 0 || previewRows.length === 0) {
    els.preview.innerHTML = "<div style=\"padding:8px;\">No rows found in the selected table.</div>";
    return;
  }

  const headerHtml = previewHeaders.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const bodyHtml = previewRows
    .map((row) => {
      const cells = previewHeaders.map((h) => `<td>${escapeHtml(row[h] || "")}</td>`).join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  els.preview.innerHTML = `<table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
}

async function renderMappedPreview() {
  if (!lastCapture?.rows?.length) {
    if (els.mappedPreview) els.mappedPreview.innerHTML = "";
    if (els.mappedPreviewMeta) els.mappedPreviewMeta.textContent = "Capture a page to preview transformed fields.";
    return;
  }

  const response = await sendMessage({
    type: "previewMappedItems",
    capture: lastCapture,
    settings: collectSettingsFromForm()
  });

  if (!response?.ok) {
    if (els.mappedPreviewMeta) els.mappedPreviewMeta.textContent = response?.error || "Could not generate mapped preview.";
    if (els.mappedPreview) els.mappedPreview.innerHTML = "";
    return;
  }

  const items = Array.isArray(response.items) ? response.items : [];
  if (els.mappedPreviewMeta) {
    els.mappedPreviewMeta.textContent = `Template key: ${response.templateKey || getCurrentTemplateKey()}. Showing first ${items.length} transformed item(s).`;
  }

  if (items.length === 0) {
    if (els.mappedPreview) els.mappedPreview.innerHTML = "<div style=\"padding:8px;\">No mapped items available.</div>";
    return;
  }

  const columns = ["name", "description", "quantity", "category_text", "subcategory_text", "variant_text"];
  const headerHtml = columns.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const bodyHtml = items
    .map((item) => {
      const cells = columns.map((column) => `<td>${escapeHtml(item?.[column] || "")}</td>`).join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");

  if (els.mappedPreview) {
    els.mappedPreview.innerHTML = `<table><thead><tr>${headerHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`;
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function capturePage() {
  clearDryRunDetails();
  setStatus("Capturing product table from current page...");
  const response = await sendMessage({
    type: "capturePage",
    settings: collectSettingsFromForm(),
    selectedChildLinks: selectedLinkedPageList()
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Capture failed");
  }

  lastCapture = response.capture;
  renderCapture(lastCapture);
  renderMappingTemplateEditors();
  await renderMappedPreview();
  setStatus(`Captured ${lastCapture.rows.length} rows.`, "ok");
}

async function previewLinkedPagesForCurrentPage() {
  clearDryRunDetails();
  setStatus("Discovering linked pages from current tab...");
  const response = await sendMessage({
    type: "previewLinkedPages",
    settings: collectSettingsFromForm()
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Could not preview linked pages");
  }

  previewLinkedPages = Array.isArray(response.links) ? response.links : [];
  itemLabels = (response.itemLabels && typeof response.itemLabels === "object") ? response.itemLabels : {};
  selectedLinkedPages.clear();
  for (const url of previewLinkedPages) {
    selectedLinkedPages.add(url);
  }
  renderLinkedPagesSelection();
  setStatus(`Linked page preview loaded (${previewLinkedPages.length} found).`, "ok");
}

async function exportData(format) {
  clearDryRunDetails();
  if (!lastCapture || !lastCapture.rows?.length) {
    throw new Error("No captured rows. Capture a page first.");
  }

  setStatus(`Preparing ${format.toUpperCase()} download...`);
  const response = await sendMessage({
    type: "downloadExport",
    format,
    capture: lastCapture,
    settings: collectSettingsFromForm()
  });

  if (!response?.ok) {
    throw new Error(response?.error || `Could not export ${format}`);
  }

  setStatus(`Downloaded ${response.filename}`, "ok");
}

async function sendToInventree() {
  clearDryRunDetails();
  if (!lastCapture || !lastCapture.rows?.length) {
    throw new Error("No captured rows. Capture a page first.");
  }

  await saveSettings();
  setStatus("Sending data to InvenTree...");

  const response = await sendMessage({
    type: "sendToInventree",
    capture: lastCapture,
    settings: collectSettingsFromForm()
  });

  if (!response?.ok) {
    throw new Error(response?.error || "InvenTree request failed");
  }

  if (response.mode === "direct") {
    const imageMsg = response.uploadedImages || response.skippedImages
      ? ` Images uploaded: ${response.uploadedImages || 0}, skipped: ${response.skippedImages || 0}.`
      : "";
    const note = response.imageUploadNote ? ` ${response.imageUploadNote}` : "";
    const msg = `Direct sync complete. Created: ${response.createdParts || 0}, updated: ${response.updatedParts || 0}, failed: ${response.failedParts || 0}, supplier records: ${response.syncedSupplierParts || 0}, stock records: ${response.createdStockItems || 0}.${imageMsg}${note}`;
    setStatus(msg, response.failedParts ? "" : "ok");
    return;
  }

  const imageMsg = response.uploadedImages || response.skippedImages
    ? ` Images uploaded: ${response.uploadedImages || 0}, skipped: ${response.skippedImages || 0}.`
    : "";
  const matchMsg = ` Existing matches -> skipped: ${response.skippedExisting || 0}, marked for update: ${response.matchedForUpdate || 0}.`;
  const note = response.imageUploadNote ? ` ${response.imageUploadNote}` : "";
  const msg = `Sent ${response.sentCount} item(s). HTTP ${response.status}.${matchMsg}${imageMsg}${note}`;
  setStatus(msg, "ok");
}

async function runDirectDryRun() {
  await saveSettings();
  setStatus("Running direct mode dry-run validation...");
  const response = await sendMessage({
    type: "dryRunDirectSync",
    settings: collectSettingsFromForm()
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Dry-run validation failed");
  }

  if (!Array.isArray(response.checks) || response.checks.length === 0) {
    clearDryRunDetails();
    setStatus("Dry-run complete. No checks returned.");
    return;
  }

  renderDryRunDetails(response.checks);

  const failed = response.checks.filter((item) => item && item.ok === false).length;
  const summary = response.checks
    .map((item) => `${item.ok ? "PASS" : "FAIL"}: ${item.label}${item.message ? ` (${item.message})` : ""}`)
    .join(" | ");
  setStatus(`Dry-run ${failed === 0 ? "passed" : "found issues"}. ${summary}`, failed === 0 ? "ok" : "error");
}

async function copySampleConfig(mode) {
  clearDryRunDetails();
  const pluginSample = [
    "Sync Mode: Plugin Endpoint",
    "InvenTree Base URL: https://inventree.local",
    "API Token: <token>",
    "Plugin Endpoint Path: /api/plugin/product-import/",
    "Include image URL: true",
    "Upload images: true"
  ].join("\n");

  const directSample = [
    "Sync Mode: Direct InvenTree API",
    "InvenTree Base URL: https://inventree.local",
    "API Token: <token>",
    "Part API Path: /api/part/",
    "Supplier Part API Path: /api/company/part/",
    "Stock Item API Path: /api/stock/",
    "Default Category ID: 12",
    "Default Supplier ID: 4",
    "Default Stock Location ID: 7",
    "Default Stock Quantity: 1",
    "Sync supplier-part records: true",
    "Create stock items: false"
  ].join("\n");

  const content = mode === "direct" ? directSample : pluginSample;
  await navigator.clipboard.writeText(content);
  setStatus(`${mode === "direct" ? "Direct" : "Plugin"} sample config copied to clipboard.`, "ok");
}

async function fetchInventreeCategoriesForPicker() {
  setStatus("Fetching InvenTree categories...");
  const response = await sendMessage({
    type: "fetchInventreeCategories",
    settings: collectSettingsFromForm()
  });
  if (!response?.ok) {
    throw new Error(response?.error || "Could not fetch categories");
  }
  fetchedInventreeCategories = Array.isArray(response.categories) ? response.categories : [];
  renderFetchedCategories();
  if (els.categoryPickerMeta) {
    els.categoryPickerMeta.textContent = `Fetched ${fetchedInventreeCategories.length} categories. Select one to set the default/root category.`;
  }
  setStatus(`Fetched ${fetchedInventreeCategories.length} categories.`, "ok");
}

async function testPartIdPath() {
  clearDryRunDetails();
  setStatus("Testing part ID response path against last response...");
  const response = await sendMessage({
    type: "testPartIdPath",
    settings: collectSettingsFromForm()
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Path test failed");
  }

  const ids = Array.isArray(response.partIds) ? response.partIds : [];
  const preview = ids.slice(0, 8).join(", ") || "none";
  const msg = `Path test: found ${ids.length} part ID(s). Sample: ${preview}`;
  setStatus(msg, ids.length > 0 ? "ok" : "");
}

async function loadState() {
  const response = await sendMessage({ type: "getState" });
  if (!response?.ok) {
    throw new Error(response?.error || "Could not load extension state");
  }
  applySettings(response.settings || {});
  lastCapture = response.lastCapture || null;
  renderCapture(lastCapture);
  renderMappingTemplateEditors();
  await renderMappedPreview();
}

function wireEvents() {
  els.openFullPageBtn.addEventListener("click", async () => {
    try {
      const fullPageUrl = chrome.runtime.getURL("popup.html?mode=full");
      await chrome.tabs.create({ url: fullPageUrl });
      setStatus("Opened larger view in a new tab.", "ok");
    } catch (error) {
      setStatus(String(error.message || error), "error");
    }
  });

  els.helpBtn.addEventListener("click", () => {
    if (els.helpPanel) {
      els.helpPanel.open = true;
      els.helpPanel.scrollIntoView({ behavior: "smooth", block: "start" });
      setStatus("Help opened below. Review settings and examples.");
    }
  });

  els.sourceMode.addEventListener("change", () => {
    renderMappingTemplateEditors();
    renderMappedPreview().catch(() => {});
  });

  els.existingCategorySelect.addEventListener("change", () => {
    const value = String(els.existingCategorySelect.value || "").trim();
    if (value) {
      els.inventreeDefaultCategoryId.value = value;
    }
  });

  els.fetchCategoriesBtn.addEventListener("click", async () => {
    try {
      await fetchInventreeCategoriesForPicker();
    } catch (error) {
      setStatus(String(error.message || error), "error");
    }
  });

  for (const select of mappingSourceInputs) {
    select.addEventListener("change", () => {
      renderMappedPreview().catch(() => {});
    });
  }

  for (const input of mappingRegexInputs) {
    input.addEventListener("input", () => {
      renderMappedPreview().catch(() => {});
    });
  }

  els.copyPluginExampleBtn.addEventListener("click", async () => {
    try {
      await copySampleConfig("plugin");
    } catch (error) {
      setStatus(String(error.message || error), "error");
    }
  });

  els.copyDirectExampleBtn.addEventListener("click", async () => {
    try {
      await copySampleConfig("direct");
    } catch (error) {
      setStatus(String(error.message || error), "error");
    }
  });

  els.saveSettingsBtn.addEventListener("click", async () => {
    try {
      await saveSettings();
    } catch (error) {
      setStatus(String(error.message || error), "error");
    }
  });

  els.captureBtn.addEventListener("click", async () => {
    try {
      await capturePage();
    } catch (error) {
      setStatus(String(error.message || error), "error");
    }
  });

  els.jsonBtn.addEventListener("click", async () => {
    try {
      await exportData("json");
    } catch (error) {
      setStatus(String(error.message || error), "error");
    }
  });

  els.csvBtn.addEventListener("click", async () => {
    try {
      await exportData("csv");
    } catch (error) {
      setStatus(String(error.message || error), "error");
    }
  });

  els.sendBtn.addEventListener("click", async () => {
    try {
      await sendToInventree();
    } catch (error) {
      setStatus(String(error.message || error), "error");
    }
  });

  els.dryRunBtn.addEventListener("click", async () => {
    try {
      await runDirectDryRun();
    } catch (error) {
      setStatus(String(error.message || error), "error");
    }
  });

  els.testPathBtn.addEventListener("click", async () => {
    try {
      await testPartIdPath();
    } catch (error) {
      setStatus(String(error.message || error), "error");
    }
  });

  els.previewLinksBtn.addEventListener("click", async () => {
    try {
      await previewLinkedPagesForCurrentPage();
    } catch (error) {
      setStatus(String(error.message || error), "error");
    }
  });

  els.selectAllLinksBtn.addEventListener("click", () => {
    for (const url of previewLinkedPages) {
      selectedLinkedPages.add(url);
    }
    renderLinkedPagesSelection();
    setStatus(`Selected ${selectedLinkedPages.size} linked page(s).`);
  });

  els.selectFilteredLinksBtn.addEventListener("click", () => {
    const visible = getVisibleLinkedPages();
    for (const url of visible) {
      selectedLinkedPages.add(url);
    }
    renderLinkedPagesSelection();
    setStatus(`Selected ${visible.length} filtered linked page(s).`);
  });

  els.clearFilteredLinksBtn.addEventListener("click", () => {
    const visible = getVisibleLinkedPages();
    for (const url of visible) {
      selectedLinkedPages.delete(url);
    }
    renderLinkedPagesSelection();
    setStatus(`Cleared ${visible.length} filtered linked page(s).`);
  });

  els.invertFilteredLinksBtn.addEventListener("click", () => {
    const visible = getVisibleLinkedPages();
    for (const url of visible) {
      if (selectedLinkedPages.has(url)) {
        selectedLinkedPages.delete(url);
      } else {
        selectedLinkedPages.add(url);
      }
    }
    renderLinkedPagesSelection();
    setStatus(`Inverted selection for ${visible.length} visible linked page(s).`);
  });

  els.clearAllLinksBtn.addEventListener("click", () => {
    selectedLinkedPages.clear();
    renderLinkedPagesSelection();
    setStatus("Cleared linked-page selection.");
  });

  els.linkedPagesFilter.addEventListener("input", () => {
    renderLinkedPagesSelection();
  });
}

initializeLayoutMode();
wireEvents();
renderLinkedPagesSelection();
loadState().catch((error) => {
  setStatus(String(error.message || error), "error");
});
