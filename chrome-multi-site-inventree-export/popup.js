const els = {
  inventreeSyncMode: document.getElementById("inventreeSyncMode"),
  inventreeUrl: document.getElementById("inventreeUrl"),
  inventreeToken: document.getElementById("inventreeToken"),
  inventreeEndpointPath: document.getElementById("inventreeEndpointPath"),
  inventreePartApiPath: document.getElementById("inventreePartApiPath"),
  inventreeSupplierPartApiPath: document.getElementById("inventreeSupplierPartApiPath"),
  inventreeStockItemApiPath: document.getElementById("inventreeStockItemApiPath"),
  inventreePartParameterApiPath: document.getElementById("inventreePartParameterApiPath"),
  inventreeParameterTemplateApiPath: document.getElementById("inventreeParameterTemplateApiPath"),
  inventreeDefaultCategoryId: document.getElementById("inventreeDefaultCategoryId"),
  enableCategoryBuilder: document.getElementById("enableCategoryBuilder"),
  inventreeDefaultSupplierId: document.getElementById("inventreeDefaultSupplierId"),
  inventreeDefaultLocationId: document.getElementById("inventreeDefaultLocationId"),
  stockQuantityHeaderHint: document.getElementById("stockQuantityHeaderHint"),
  defaultStockQuantity: document.getElementById("defaultStockQuantity"),
  syncSupplierParts: document.getElementById("syncSupplierParts"),
  syncStockRecords: document.getElementById("syncStockRecords"),
  syncPartParameters: document.getElementById("syncPartParameters"),
  autoCreateMissingParameterTemplates: document.getElementById("autoCreateMissingParameterTemplates"),
  parameterMappingsText: document.getElementById("parameterMappingsText"),
  generateParameterMappingsBtn: document.getElementById("generateParameterMappingsBtn"),
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
  nameComposeFields: document.getElementById("nameComposeFields"),
  nameComposeDelimiter: document.getElementById("nameComposeDelimiter"),
  globalImageSourceField: document.getElementById("globalImageSourceField"),
  nameComposeFieldSearch: document.getElementById("nameComposeFieldSearch"),
  selectAllNameComposeFieldsBtn: document.getElementById("selectAllNameComposeFieldsBtn"),
  clearNameComposeFieldsBtn: document.getElementById("clearNameComposeFieldsBtn"),
  nameComposeFieldPicker: document.getElementById("nameComposeFieldPicker"),
  testPathBtn: document.getElementById("testPathBtn"),
  mappingTemplateScope: document.getElementById("mappingTemplateScope"),
  mappingTemplatePathPattern: document.getElementById("mappingTemplatePathPattern"),
  savedTemplateSelect: document.getElementById("savedTemplateSelect"),
  loadTemplateBtn: document.getElementById("loadTemplateBtn"),
  deleteTemplateBtn: document.getElementById("deleteTemplateBtn"),
  fetchCategoriesBtn: document.getElementById("fetchCategoriesBtn"),
  previewCategoryAssignmentsBtn: document.getElementById("previewCategoryAssignmentsBtn"),
  existingCategorySelect: document.getElementById("existingCategorySelect"),
  categoryPickerMeta: document.getElementById("categoryPickerMeta"),
  helpBtn: document.getElementById("helpBtn"),
  openSettingsBtn: document.getElementById("openSettingsBtn"),
  openFullPageBtn: document.getElementById("openFullPageBtn"),
  helpPanel: document.getElementById("helpPanel"),
  copyPluginExampleBtn: document.getElementById("copyPluginExampleBtn"),
  copyDirectExampleBtn: document.getElementById("copyDirectExampleBtn"),
  dryRunBtn: document.getElementById("dryRunBtn"),
  dryRunDetails: document.getElementById("dryRunDetails"),
  dryRunDetailsList: document.getElementById("dryRunDetailsList"),
  categoryPreviewDetails: document.getElementById("categoryPreviewDetails"),
  categoryPreviewSummary: document.getElementById("categoryPreviewSummary"),
  categoryPreviewList: document.getElementById("categoryPreviewList"),
  saveSettingsBtn: document.getElementById("saveSettingsBtn"),
  captureBtn: document.getElementById("captureBtn"),
  sendBtn: document.getElementById("sendBtn"),
  jsonBtn: document.getElementById("jsonBtn"),
  csvBtn: document.getElementById("csvBtn"),
  captureMeta: document.getElementById("captureMeta"),
  preview: document.getElementById("preview"),
  mappedPreview: document.getElementById("mappedPreview"),
  mappedPreviewMeta: document.getElementById("mappedPreviewMeta"),
  sourceFieldSamplesPanel: document.getElementById("sourceFieldSamplesPanel"),
  sourceFieldSamplesMeta: document.getElementById("sourceFieldSamplesMeta"),
  sourceFieldSamples: document.getElementById("sourceFieldSamples"),
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
const MAPPING_TARGET_KEYS = ["name", "description", "quantity", "category", "subcategory", "variant", "notes"];
const COLLAPSIBLE_STATE_KEY = "popupCollapsibleStateV1";
const NAME_COMPOSE_PSEUDO_FIELDS = [
  { value: "__page_title", label: "Page Title" },
  { value: "__page_breadcrumbs", label: "Page Breadcrumbs" },
  { value: "__page_section_summary", label: "Page Section Summary" },
  { value: "__left_filters", label: "Left Filters Summary" },
  { value: "__page_url", label: "Page URL" },
  { value: "__selected_page_image", label: "Selected Page Image URL" },
  { value: "__page_primary_image", label: "Page Primary Image URL" },
  { value: "__sidebar_primary_image", label: "Sidebar Primary Image URL" }
];

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

function readCollapsibleState() {
  try {
    const raw = localStorage.getItem(COLLAPSIBLE_STATE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function writeCollapsibleState(key, isOpen) {
  if (!key) return;
  const state = readCollapsibleState();
  state[key] = Boolean(isOpen);
  try {
    localStorage.setItem(COLLAPSIBLE_STATE_KEY, JSON.stringify(state));
  } catch (_error) {
    // Ignore storage write errors in restricted contexts.
  }
}

function initializeCollapsibleState() {
  const state = readCollapsibleState();
  const collapsibles = Array.from(document.querySelectorAll("details[data-collapse-key]"));

  for (const element of collapsibles) {
    const key = String(element.getAttribute("data-collapse-key") || "").trim();
    if (!key) continue;

    if (typeof state[key] === "boolean") {
      element.open = state[key];
    }

    element.addEventListener("toggle", () => {
      writeCollapsibleState(key, element.open);
    });
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

function normalizeTemplatePathPattern(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("/")) return raw;
  return `/${raw}`;
}

function getCapturedHost() {
  const pageUrl = String(lastCapture?.pageUrl || "").trim();
  if (!pageUrl) return "";
  try {
    return String(new URL(pageUrl).hostname || "").trim().toLowerCase();
  } catch {
    return "";
  }
}

function getCapturedPathname() {
  const pageUrl = String(lastCapture?.pageUrl || "").trim();
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

function getCurrentTemplateContext() {
  const source = normalizeTemplateKey(lastCapture?.source || els.sourceMode?.value || "default");
  const pageType = normalizeTemplateKey(lastCapture?.pageType || "default");
  const host = getCapturedHost();
  const pathname = getCapturedPathname();
  const pathPattern = normalizeTemplatePathPattern(els.mappingTemplatePathPattern?.value || "");
  return { source, pageType, host, pathname, pathPattern };
}

function getCurrentTemplateKey() {
  const context = getCurrentTemplateContext();
  return buildTemplateScopeKey(context);
}

function buildTemplateCandidateKeys(context) {
  const keys = [];
  const seen = new Set();

  function push(key) {
    const normalized = String(key || "").trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    keys.push(normalized);
  }

  push(buildTemplateScopeKey(context));

  if (context.host) {
    if (context.pathPattern) {
      push(buildTemplateScopeKey({ ...context, pathPattern: "" }));
    }

    if (context.pathname) {
      const scoredOverrides = [];
      for (const key of Object.keys(storedMappingTemplates || {})) {
        const parsed = parseHostTemplateKey(key);
        if (!parsed || !parsed.pathPattern) continue;
        if (parsed.host !== context.host || parsed.pageType !== context.pageType) continue;
        if (!wildcardPathMatches(parsed.pathPattern, context.pathname)) continue;
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

  push(`${context.source}:${context.pageType}`);
  push(`${context.source}:default`);
  push(context.source);

  return keys;
}

function getCurrentTemplateResolution() {
  const context = getCurrentTemplateContext();
  const candidates = buildTemplateCandidateKeys(context);
  const resolvedKey = candidates.find((key) => storedMappingTemplates[key] && typeof storedMappingTemplates[key] === "object") || "";
  const template = resolvedKey ? storedMappingTemplates[resolvedKey] : {};
  return { context, candidates, resolvedKey, template };
}

function getCurrentTemplate() {
  const { template } = getCurrentTemplateResolution();
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
    { value: "__page_url", label: "Page URL" },
    { value: "__page_breadcrumbs", label: "Page Breadcrumbs" },
    { value: "__page_section_summary", label: "Page Section Summary" },
    { value: "__left_filters", label: "Left Filters Summary" },
    { value: "__page_primary_image", label: "Page Primary Image URL" },
    { value: "__sidebar_primary_image", label: "Sidebar Primary Image URL" },
    { value: "__selected_page_image", label: "Selected Page Image URL" }
  ];

  const headers = Array.isArray(lastCapture?.headers) ? lastCapture.headers : [];
  for (const header of headers) {
    options.push({ value: header, label: header });
  }
  return options;
}

function parseNameComposeFields() {
  return String(els.nameComposeFields?.value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getNameComposePickerFields() {
  const output = [];
  const seen = new Set();

  for (const item of NAME_COMPOSE_PSEUDO_FIELDS) {
    const value = String(item.value || "").trim();
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    output.push({ value, label: item.label, kind: "page" });
  }

  const headers = Array.isArray(lastCapture?.headers) ? lastCapture.headers : [];
  for (const header of headers) {
    const value = String(header || "").trim();
    if (!value || seen.has(value.toLowerCase())) continue;
    seen.add(value.toLowerCase());
    output.push({ value, label: value, kind: "field" });
  }

  for (const current of parseNameComposeFields()) {
    const key = current.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push({ value: current, label: `${current} (custom)`, kind: "custom" });
  }

  return output;
}

function renderNameComposeFieldPicker() {
  if (!els.nameComposeFieldPicker) return;

  const selected = new Set(parseNameComposeFields().map((item) => item.toLowerCase()));
  const query = String(els.nameComposeFieldSearch?.value || "").trim().toLowerCase();
  const fields = getNameComposePickerFields();
  const visible = query
    ? fields.filter((item) => item.value.toLowerCase().includes(query) || item.label.toLowerCase().includes(query))
    : fields;

  if (visible.length === 0) {
    els.nameComposeFieldPicker.innerHTML = '<div class="field-picker-empty">No fields match this search.</div>';
    return;
  }

  const html = visible
    .map((item) => {
      const checked = selected.has(item.value.toLowerCase()) ? "checked" : "";
      const hint = item.kind === "page" ? "Page" : item.kind === "custom" ? "Custom" : "Field";
      return `<label class="field-picker-item"><input type="checkbox" data-name-compose-field="${encodeURIComponent(item.value)}" ${checked} /><span>${escapeHtml(item.label)} <span style="color:#667981;">(${escapeHtml(hint)})</span></span></label>`;
    })
    .join("");
  els.nameComposeFieldPicker.innerHTML = html;

  const checkboxes = Array.from(els.nameComposeFieldPicker.querySelectorAll("input[type='checkbox'][data-name-compose-field]"));
  for (const checkbox of checkboxes) {
    checkbox.addEventListener("change", () => {
      const current = parseNameComposeFields();
      const currentSet = new Set(current.map((item) => item.toLowerCase()));
      const encoded = checkbox.getAttribute("data-name-compose-field") || "";
      const field = decodeURIComponent(encoded);
      if (!field) return;

      if (checkbox.checked) {
        if (!currentSet.has(field.toLowerCase())) {
          current.push(field);
        }
      } else {
        const next = current.filter((item) => item.toLowerCase() !== field.toLowerCase());
        els.nameComposeFields.value = next.join(", ");
        renderNameComposeFieldPicker();
        renderMappedPreview().catch(() => {});
        return;
      }

      els.nameComposeFields.value = current.join(", ");
      renderNameComposeFieldPicker();
      renderMappedPreview().catch(() => {});
    });
  }
}

function renderMappingTemplateEditors() {
  const options = buildFieldOptionsForTemplate();
  const template = getCurrentTemplate();
  const resolution = getCurrentTemplateResolution();
  const scopeLabel = getCurrentTemplateKey();
  const loadedLabel = resolution.resolvedKey || "none (new scope)";

  if (els.mappingTemplateScope) {
    const sourceCount = Math.max(0, options.length - 9);
    els.mappingTemplateScope.textContent = `Template scope: ${scopeLabel}. Loaded template: ${loadedLabel}. Captured source fields available: ${sourceCount}.`; 
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

  renderSavedTemplatePicker(resolution.resolvedKey || "");
}

function renderSavedTemplatePicker(preferredKey = "") {
  if (!els.savedTemplateSelect) return;

  const previous = String(els.savedTemplateSelect.value || "").trim();
  const keys = Object.keys(storedMappingTemplates || {});
  const selectedKey = keys.includes(previous)
    ? previous
    : (keys.includes(preferredKey) ? preferredKey : "");

  const keysSorted = [...keys].sort((a, b) => {
    const aMeta = parseTemplateMeta(storedMappingTemplates?.[a]);
    const bMeta = parseTemplateMeta(storedMappingTemplates?.[b]);
    const aScore = new Date(aMeta.lastUsedAt || aMeta.createdAt || 0).getTime() || 0;
    const bScore = new Date(bMeta.lastUsedAt || bMeta.createdAt || 0).getTime() || 0;
    if (bScore !== aScore) return bScore - aScore;
    return a.localeCompare(b);
  });

  const options = [
    `<option value="">${keys.length > 0 ? "Select saved template" : "No saved templates"}</option>`,
    ...keysSorted.map((key) => {
      const meta = parseTemplateMeta(storedMappingTemplates?.[key]);
      const created = formatTemplateTimestamp(meta.createdAt);
      const lastUsed = formatTemplateTimestamp(meta.lastUsedAt);
      const label = `${key} | used: ${lastUsed} | created: ${created}`;
      return `<option value="${escapeHtml(key)}">${escapeHtml(label)}</option>`;
    })
  ];
  els.savedTemplateSelect.innerHTML = options.join("");
  els.savedTemplateSelect.value = selectedKey;

  if (els.loadTemplateBtn) {
    els.loadTemplateBtn.disabled = !selectedKey;
  }
  if (els.deleteTemplateBtn) {
    els.deleteTemplateBtn.disabled = !selectedKey;
  }
}

function normalizeTemplateRecord(rawTemplate) {
  const output = {};
  for (const targetKey of MAPPING_TARGET_KEYS) {
    output[targetKey] = {
      sourceField: String(rawTemplate?.[targetKey]?.sourceField || "").trim(),
      regex: String(rawTemplate?.[targetKey]?.regex || "").trim()
    };
  }
  return output;
}

function applyTemplateToCurrentEditors(template) {
  const normalized = normalizeTemplateRecord(template);

  for (const select of mappingSourceInputs) {
    const targetKey = select.getAttribute("data-map-source") || "";
    const selectedValue = normalized?.[targetKey]?.sourceField || "";
    if (selectedValue && !Array.from(select.options).some((option) => option.value === selectedValue)) {
      const option = document.createElement("option");
      option.value = selectedValue;
      option.textContent = `${selectedValue} (saved)`;
      select.appendChild(option);
    }
    select.value = selectedValue;
  }

  for (const input of mappingRegexInputs) {
    const targetKey = input.getAttribute("data-map-regex") || "";
    input.value = normalized?.[targetKey]?.regex || "";
  }
}

function loadSelectedTemplateIntoCurrent() {
  const key = String(els.savedTemplateSelect?.value || "").trim();
  if (!key) {
    setStatus("Select a saved template to load.");
    return;
  }

  const template = storedMappingTemplates?.[key];
  if (!template || typeof template !== "object") {
    setStatus("Selected template could not be loaded.", "error");
    return;
  }

  applyTemplateToCurrentEditors(template);
  renderMappedPreview().catch(() => {});
  setStatus(`Loaded template into current mapping: ${key}`, "ok");
}

async function deleteSelectedTemplate() {
  const key = String(els.savedTemplateSelect?.value || "").trim();
  if (!key) {
    setStatus("Select a saved template to delete.");
    return;
  }

  const confirmed = window.confirm(`Delete saved template?\n\n${key}`);
  if (!confirmed) return;

  const nextTemplates = { ...storedMappingTemplates };
  delete nextTemplates[key];

  const response = await sendMessage({
    type: "saveSettings",
    settings: {
      ...collectSettingsFromForm(),
      mappingTemplates: nextTemplates
    }
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Failed to delete template");
  }

  storedMappingTemplates = response.settings?.mappingTemplates && typeof response.settings.mappingTemplates === "object"
    ? response.settings.mappingTemplates
    : nextTemplates;
  renderMappingTemplateEditors();
  await renderMappedPreview();
  setStatus(`Deleted saved template: ${key}`, "ok");
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

function parseTemplateMeta(record) {
  const createdAt = String(record?._meta?.createdAt || "").trim();
  const lastUsedAt = String(record?._meta?.lastUsedAt || "").trim();
  return {
    createdAt,
    lastUsedAt
  };
}

function withTemplateMeta(template, previousRecord, nowIso) {
  const previousMeta = parseTemplateMeta(previousRecord);
  const createdAt = previousMeta.createdAt || nowIso;
  return {
    ...template,
    _meta: {
      createdAt,
      lastUsedAt: nowIso
    }
  };
}

function formatTemplateTimestamp(value) {
  const text = String(value || "").trim();
  if (!text) return "-";
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) return text;
  return date.toLocaleString();
}

function clearDryRunDetails() {
  if (!els.dryRunDetails || !els.dryRunDetailsList) return;
  els.dryRunDetailsList.innerHTML = "";
  els.dryRunDetails.classList.remove("visible");
}

function clearCategoryPreviewDetails() {
  if (!els.categoryPreviewDetails || !els.categoryPreviewSummary || !els.categoryPreviewList) return;
  els.categoryPreviewSummary.textContent = "";
  els.categoryPreviewList.innerHTML = "";
  els.categoryPreviewDetails.classList.remove("visible");
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

function renderCategoryPreviewDetails(payload) {
  if (!els.categoryPreviewDetails || !els.categoryPreviewSummary || !els.categoryPreviewList) return;
  const summary = payload?.summary || {};
  const items = Array.isArray(payload?.items) ? payload.items : [];

  const summaryText = [
    `Default root: ${summary.defaultCategoryPath || "-"} (#${summary.defaultCategoryId || "-"})`,
    `Items previewed: ${summary.previewedItems || 0}${summary.totalItems > summary.previewedItems ? ` of ${summary.totalItems}` : ""}`,
    `Existing segments: ${summary.existingSegments || 0}`,
    `Would create segments: ${summary.createSegments || 0}`,
    `Items using default only: ${summary.usedDefaultOnly || 0}`
  ].join(" | ");
  els.categoryPreviewSummary.textContent = summaryText;

  if (items.length === 0) {
    els.categoryPreviewList.innerHTML = '<div class="category-preview-item">No category plan rows to preview.</div>';
    els.categoryPreviewDetails.classList.add("visible");
    return;
  }

  const html = items
    .map((item) => {
      const steps = Array.isArray(item?.steps) ? item.steps : [];
      const stepText = steps.length
        ? steps.map((step) => `${step.action === "create" ? "create" : "existing"}: ${step.name}`).join(" -> ")
        : "No mapped category/subcategory values; default root will be used.";
      const itemName = escapeHtml(item?.itemName || "Imported Product");
      const path = escapeHtml(item?.targetCategoryPath || "");
      const targetId = escapeHtml(item?.targetCategoryId || "");
      return `<div class="category-preview-item"><strong>${itemName}</strong><br/>Path: ${path}${targetId ? ` (#${targetId})` : ""}<br/>Steps: ${escapeHtml(stepText)}</div>`;
    })
    .join("");

  els.categoryPreviewList.innerHTML = html;
  els.categoryPreviewDetails.classList.add("visible");
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
    inventreePartParameterApiPath: els.inventreePartParameterApiPath.value.trim() || "/api/part/parameter/",
    inventreeParameterTemplateApiPath: els.inventreeParameterTemplateApiPath.value.trim() || "/api/part/parameter/template/",
    inventreeDefaultCategoryId: els.inventreeDefaultCategoryId.value.trim(),
    enableCategoryBuilder: Boolean(els.enableCategoryBuilder.checked),
    inventreeDefaultSupplierId: els.inventreeDefaultSupplierId.value.trim(),
    inventreeDefaultLocationId: els.inventreeDefaultLocationId.value.trim(),
    stockQuantityHeaderHint: els.stockQuantityHeaderHint.value.trim(),
    defaultStockQuantity: els.defaultStockQuantity.value.trim(),
    mappingTemplatePathPattern: String(els.mappingTemplatePathPattern?.value || "").trim(),
    syncSupplierParts: Boolean(els.syncSupplierParts.checked),
    syncStockRecords: Boolean(els.syncStockRecords.checked),
    syncPartParameters: Boolean(els.syncPartParameters.checked),
    autoCreateMissingParameterTemplates: Boolean(els.autoCreateMissingParameterTemplates.checked),
    parameterMappingsText: String(els.parameterMappingsText?.value || ""),
    includeImageUrls: Boolean(els.includeImageUrls.checked),
    uploadImagesIfSupported: Boolean(els.uploadImagesIfSupported.checked),
    nameComposeFields: els.nameComposeFields.value.trim(),
    nameComposeDelimiter: els.nameComposeDelimiter.value,
    globalImageSourceField: els.globalImageSourceField.value.trim(),
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
  els.inventreePartParameterApiPath.value = settings.inventreePartParameterApiPath || "/api/part/parameter/";
  els.inventreeParameterTemplateApiPath.value = settings.inventreeParameterTemplateApiPath || "/api/part/parameter/template/";
  els.inventreeDefaultCategoryId.value = settings.inventreeDefaultCategoryId || "";
  els.enableCategoryBuilder.checked = Boolean(settings.enableCategoryBuilder);
  els.inventreeDefaultSupplierId.value = settings.inventreeDefaultSupplierId || "";
  els.inventreeDefaultLocationId.value = settings.inventreeDefaultLocationId || "";
  els.stockQuantityHeaderHint.value = settings.stockQuantityHeaderHint || "";
  els.defaultStockQuantity.value = settings.defaultStockQuantity || "";
  if (els.mappingTemplatePathPattern) {
    els.mappingTemplatePathPattern.value = settings.mappingTemplatePathPattern || "";
  }
  els.syncSupplierParts.checked = settings.syncSupplierParts !== false;
  els.syncStockRecords.checked = Boolean(settings.syncStockRecords);
  els.syncPartParameters.checked = Boolean(settings.syncPartParameters);
  els.autoCreateMissingParameterTemplates.checked = Boolean(settings.autoCreateMissingParameterTemplates);
  els.parameterMappingsText.value = settings.parameterMappingsText || "";
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
  els.nameComposeFields.value = settings.nameComposeFields || "";
  els.nameComposeDelimiter.value = settings.nameComposeDelimiter || " - ";
  els.globalImageSourceField.value = settings.globalImageSourceField || "";
  renderFetchedCategories();
  renderMappingTemplateEditors();
  renderNameComposeFieldPicker();
}

function collectSettingsFromForm() {
  const context = getCurrentTemplateContext();
  const currentTemplateKey = buildTemplateScopeKey(context);
  const template = collectMappingTemplateFromForm();
  const nowIso = new Date().toISOString();
  const currentRecord = withTemplateMeta(template, storedMappingTemplates?.[currentTemplateKey], nowIso);
  const mappingTemplates = {
    ...storedMappingTemplates,
    [currentTemplateKey]: currentRecord
  };

  const fallbackKeys = [];
  if (context.host) {
    if (context.pathPattern) {
      fallbackKeys.push(buildTemplateScopeKey({ ...context, pathPattern: "" }));
    }
    fallbackKeys.push(buildTemplateScopeKey({ ...context, pageType: "default", pathPattern: "" }));
  }
  fallbackKeys.push(`${context.source}:${context.pageType}`);
  fallbackKeys.push(`${context.source}:default`);
  fallbackKeys.push(context.source);

  for (const key of fallbackKeys) {
    const normalized = String(key || "").trim();
    if (!normalized || mappingTemplates[normalized]) continue;
    mappingTemplates[normalized] = withTemplateMeta(template, storedMappingTemplates?.[normalized], nowIso);
  }

  return {
    inventreeSyncMode: els.inventreeSyncMode.value === "direct" ? "direct" : "plugin",
    inventreeUrl: els.inventreeUrl.value.trim(),
    inventreeToken: els.inventreeToken.value.trim(),
    inventreeEndpointPath: els.inventreeEndpointPath.value.trim() || "/api/plugin/product-import/",
    inventreePartApiPath: els.inventreePartApiPath.value.trim() || "/api/part/",
    inventreeSupplierPartApiPath: els.inventreeSupplierPartApiPath.value.trim() || "/api/company/part/",
    inventreeStockItemApiPath: els.inventreeStockItemApiPath.value.trim() || "/api/stock/",
    inventreePartParameterApiPath: els.inventreePartParameterApiPath.value.trim() || "/api/part/parameter/",
    inventreeParameterTemplateApiPath: els.inventreeParameterTemplateApiPath.value.trim() || "/api/part/parameter/template/",
    inventreeDefaultCategoryId: els.inventreeDefaultCategoryId.value.trim(),
    enableCategoryBuilder: Boolean(els.enableCategoryBuilder.checked),
    inventreeDefaultSupplierId: els.inventreeDefaultSupplierId.value.trim(),
    inventreeDefaultLocationId: els.inventreeDefaultLocationId.value.trim(),
    stockQuantityHeaderHint: els.stockQuantityHeaderHint.value.trim(),
    defaultStockQuantity: els.defaultStockQuantity.value.trim(),
    mappingTemplatePathPattern: String(els.mappingTemplatePathPattern?.value || "").trim(),
    mappingTemplates,
    syncSupplierParts: Boolean(els.syncSupplierParts.checked),
    syncStockRecords: Boolean(els.syncStockRecords.checked),
    syncPartParameters: Boolean(els.syncPartParameters.checked),
    autoCreateMissingParameterTemplates: Boolean(els.autoCreateMissingParameterTemplates.checked),
    parameterMappingsText: String(els.parameterMappingsText?.value || ""),
    ...getHints()
  };
}

function toParameterLabelFromField(fieldName) {
  const source = String(fieldName || "").trim();
  if (!source) return "";

  const directMap = {
    ProductDetailThreadSize: "Thread Size",
    ProductDetailLength: "Length",
    ProductDetailVariant: "Variant",
    ProductDetailSpecs: "Detailed Specs",
    ProductDetailNotes: "Extended Notes"
  };
  if (directMap[source]) return directMap[source];

  const specPrefix = "Spec_";
  const normalized = source.startsWith(specPrefix) ? source.slice(specPrefix.length) : source;
  return normalized
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((word) => {
      const upper = word.toUpperCase();
      if (upper === "ID" || upper === "IPN" || upper === "MPN") return upper;
      if (upper === "MM") return "mm";
      return `${word.charAt(0).toUpperCase()}${word.slice(1).toLowerCase()}`;
    })
    .join(" ");
}

function parseParameterRuleLines(rawText) {
  return String(rawText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function buildSuggestedParameterRuleLines() {
  if (!lastCapture?.rows?.length) return [];

  const headerSet = new Set(Array.isArray(lastCapture?.headers) ? lastCapture.headers : []);
  for (const row of lastCapture.rows) {
    for (const key of Object.keys(row || {})) {
      headerSet.add(String(key || ""));
    }
  }

  const fields = Array.from(headerSet)
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  const preferred = [
    "ProductDetailThreadSize",
    "ProductDetailLength",
    "ProductDetailVariant",
    "Spec_Material",
    "Spec_Thread_Pitch",
    "Spec_Head_Type",
    "Spec_Drive_Style"
  ];

  const preferredPresent = preferred.filter((name) => fields.includes(name));
  const specFields = fields.filter((name) => /^Spec_/i.test(name));
  const detailFields = fields.filter((name) => /^ProductDetail(?:ThreadSize|Length|Variant|Specs|Notes)$/i.test(name));
  const ordered = Array.from(new Set([...preferredPresent, ...detailFields, ...specFields]));

  return ordered
    .map((field) => {
      const label = toParameterLabelFromField(field);
      if (!label) return "";
      return `${label} = ${field}`;
    })
    .filter(Boolean);
}

function generateParameterMappingsFromCapture() {
  if (!lastCapture?.rows?.length) {
    setStatus("Capture a page before generating parameter mapping rules.", "error");
    return;
  }

  const suggestions = buildSuggestedParameterRuleLines();
  if (suggestions.length === 0) {
    setStatus("No ProductDetail or Spec fields found to generate parameter mappings.");
    return;
  }

  const existingLines = parseParameterRuleLines(els.parameterMappingsText.value);
  const existingSet = new Set(existingLines.map((line) => line.toLowerCase()));
  const additions = suggestions.filter((line) => !existingSet.has(line.toLowerCase()));

  if (additions.length === 0) {
    setStatus("Parameter mapping rules are already up to date.", "ok");
    return;
  }

  const next = [...existingLines, ...additions];
  els.parameterMappingsText.value = next.join("\n");
  setStatus(`Added ${additions.length} parameter mapping rule(s) from captured fields.`, "ok");
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
  setStatus("Saving settings and templates...");
  const scopeKey = getCurrentTemplateKey();
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
  setStatus(`Settings and templates saved. Active scope: ${scopeKey}.`, "ok");
}

function renderCapture(capture) {
  if (!capture || !Array.isArray(capture.rows)) {
    els.captureMeta.textContent = "No capture yet.";
    els.preview.innerHTML = "";
    if (els.mappedPreview) els.mappedPreview.innerHTML = "";
    if (els.mappedPreviewMeta) els.mappedPreviewMeta.textContent = "Capture a page to preview transformed fields.";
    renderSourceFieldSamples(null);
    renderNameComposeFieldPicker();
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
  renderSourceFieldSamples(capture);
  renderNameComposeFieldPicker();
}

function formatSourceSample(value) {
  const raw = String(value ?? "");
  if (!raw) {
    return { html: "(empty)", length: 0 };
  }

  const compact = raw.replace(/\s+/g, " ").trim();
  if (!compact) {
    return { html: "(whitespace only)", length: raw.length };
  }

  const clipped = compact.length > 180 ? `${compact.slice(0, 177)}...` : compact;
  return {
    html: `[[${escapeHtml(clipped)}]]`,
    length: raw.length
  };
}

function renderSourceFieldSamples(capture) {
  if (!els.sourceFieldSamples || !els.sourceFieldSamplesMeta) return;

  if (!capture || !Array.isArray(capture.rows) || capture.rows.length === 0) {
    els.sourceFieldSamplesMeta.textContent = "Capture a page to inspect field samples.";
    els.sourceFieldSamples.innerHTML = "";
    return;
  }

  const rows = capture.rows;
  const headerSet = new Set(Array.isArray(capture.headers) ? capture.headers : []);
  for (const row of rows) {
    for (const key of Object.keys(row || {})) {
      headerSet.add(key);
    }
  }

  const fields = Array.from(headerSet)
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  if (fields.length === 0) {
    els.sourceFieldSamplesMeta.textContent = "No source fields found in capture.";
    els.sourceFieldSamples.innerHTML = "";
    return;
  }

  const sampleRows = fields.map((field) => {
    const firstRowValue = rows[0]?.[field] ?? "";
    let firstNonEmptyValue = "";
    let nonEmptyCount = 0;

    for (const row of rows) {
      const value = String(row?.[field] ?? "");
      if (value.trim()) {
        nonEmptyCount += 1;
        if (!firstNonEmptyValue) {
          firstNonEmptyValue = value;
        }
      }
    }

    const firstRowSample = formatSourceSample(firstRowValue);
    const nonEmptySample = formatSourceSample(firstNonEmptyValue);
    const populatedPct = rows.length > 0 ? Math.round((nonEmptyCount / rows.length) * 100) : 0;

    return `
      <tr>
        <td>${escapeHtml(field)}</td>
        <td>${firstRowSample.html}<br><span style="color:#677b84;">len=${firstRowSample.length}</span></td>
        <td>${nonEmptySample.html}<br><span style="color:#677b84;">len=${nonEmptySample.length}</span></td>
        <td>${nonEmptyCount}/${rows.length} (${populatedPct}%)</td>
      </tr>
    `;
  });

  els.sourceFieldSamplesMeta.textContent = `Showing ${fields.length} field(s). Values are wrapped as [[value]] so boundaries are easy to see.`;
  els.sourceFieldSamples.innerHTML = `
    <table>
      <thead>
        <tr>
          <th>Field</th>
          <th>First Row Value</th>
          <th>First Non-empty Value</th>
          <th>Populated</th>
        </tr>
      </thead>
      <tbody>
        ${sampleRows.join("")}
      </tbody>
    </table>
  `;
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

  const columns = ["name", "description", "quantity", "category_text", "subcategory_text", "variant_text", "notes"];
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
  clearCategoryPreviewDetails();
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
  clearCategoryPreviewDetails();
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
  clearCategoryPreviewDetails();
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
  clearCategoryPreviewDetails();
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
    const msg = `Direct sync complete. Created: ${response.createdParts || 0}, updated: ${response.updatedParts || 0}, failed: ${response.failedParts || 0}, supplier records: ${response.syncedSupplierParts || 0}, stock records: ${response.createdStockItems || 0}, parameter writes: ${response.syncedPartParameters || 0}, parameter templates created: ${response.createdParameterTemplates || 0}.${imageMsg}${note}`;
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
  clearCategoryPreviewDetails();
  await saveSettings();
  setStatus("Running direct mode dry-run validation...");
  const response = await sendMessage({
    type: "dryRunDirectSync",
    settings: collectSettingsFromForm(),
    capture: lastCapture
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
  clearCategoryPreviewDetails();
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
  clearCategoryPreviewDetails();
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

async function previewCategoryAssignments() {
  clearDryRunDetails();
  if (!lastCapture || !lastCapture.rows?.length) {
    throw new Error("No captured rows. Capture a page first.");
  }

  await saveSettings();
  setStatus("Generating category assignment preview...");
  const response = await sendMessage({
    type: "previewCategoryAssignments",
    capture: lastCapture,
    settings: collectSettingsFromForm()
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Category preview failed");
  }

  renderCategoryPreviewDetails(response);
  const creates = response?.summary?.createSegments || 0;
  const previewed = response?.summary?.previewedItems || 0;
  setStatus(`Category preview ready for ${previewed} item(s). Planned category creates: ${creates}.`, "ok");
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
  els.openSettingsBtn.addEventListener("click", () => {
    const settingsPanel = document.getElementById("settingsPanel");
    if (settingsPanel) {
      settingsPanel.open = true;
      writeCollapsibleState("settingsPanel", true);
      settingsPanel.scrollIntoView({ behavior: "smooth", block: "start" });
      setStatus("Settings panel opened. API and mapping options are grouped there.");
    }
  });

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
      writeCollapsibleState("helpPanel", true);
      els.helpPanel.scrollIntoView({ behavior: "smooth", block: "start" });
      setStatus("Help opened below. Review settings and examples.");
    }
  });

  els.sourceMode.addEventListener("change", () => {
    renderMappingTemplateEditors();
    renderNameComposeFieldPicker();
    renderMappedPreview().catch(() => {});
  });

  els.mappingTemplatePathPattern.addEventListener("input", () => {
    renderMappingTemplateEditors();
    renderMappedPreview().catch(() => {});
  });

  if (els.savedTemplateSelect) {
    els.savedTemplateSelect.addEventListener("change", () => {
      const hasSelection = Boolean(String(els.savedTemplateSelect.value || "").trim());
      if (els.loadTemplateBtn) {
        els.loadTemplateBtn.disabled = !hasSelection;
      }
      if (els.deleteTemplateBtn) {
        els.deleteTemplateBtn.disabled = !hasSelection;
      }
    });
  }

  if (els.loadTemplateBtn) {
    els.loadTemplateBtn.addEventListener("click", () => {
      loadSelectedTemplateIntoCurrent();
    });
  }

  if (els.deleteTemplateBtn) {
    els.deleteTemplateBtn.addEventListener("click", async () => {
      try {
        await deleteSelectedTemplate();
      } catch (error) {
        setStatus(String(error.message || error), "error");
      }
    });
  }

  els.nameComposeFields.addEventListener("input", () => {
    renderNameComposeFieldPicker();
    renderMappedPreview().catch(() => {});
  });

  els.nameComposeDelimiter.addEventListener("input", () => {
    renderMappedPreview().catch(() => {});
  });

  els.globalImageSourceField.addEventListener("input", () => {
    renderMappedPreview().catch(() => {});
  });

  els.nameComposeFieldSearch.addEventListener("input", () => {
    renderNameComposeFieldPicker();
  });

  els.selectAllNameComposeFieldsBtn.addEventListener("click", () => {
    const fields = getNameComposePickerFields();
    const query = String(els.nameComposeFieldSearch?.value || "").trim().toLowerCase();
    const visible = query
      ? fields.filter((item) => item.value.toLowerCase().includes(query) || item.label.toLowerCase().includes(query))
      : fields;

    if (visible.length === 0) {
      setStatus("No matching fields to select.");
      return;
    }

    const current = parseNameComposeFields();
    const currentSet = new Set(current.map((item) => item.toLowerCase()));
    for (const item of visible) {
      if (!currentSet.has(item.value.toLowerCase())) {
        current.push(item.value);
        currentSet.add(item.value.toLowerCase());
      }
    }
    els.nameComposeFields.value = current.join(", ");
    renderNameComposeFieldPicker();
    renderMappedPreview().catch(() => {});
    setStatus(`Selected ${visible.length} visible name fields.`);
  });

  els.clearNameComposeFieldsBtn.addEventListener("click", () => {
    els.nameComposeFields.value = "";
    renderNameComposeFieldPicker();
    renderMappedPreview().catch(() => {});
    setStatus("Cleared name composition fields.");
  });

  els.generateParameterMappingsBtn.addEventListener("click", () => {
    generateParameterMappingsFromCapture();
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

  els.previewCategoryAssignmentsBtn.addEventListener("click", async () => {
    try {
      await previewCategoryAssignments();
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
initializeCollapsibleState();
wireEvents();
renderLinkedPagesSelection();
renderNameComposeFieldPicker();
loadState().catch((error) => {
  setStatus(String(error.message || error), "error");
});
