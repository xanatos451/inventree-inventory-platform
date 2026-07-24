const $ = (id) => document.getElementById(id);
const els = {
  sourceMode: $("sourceMode"), captureProfile: $("captureProfile"), maxLinkedPages: $("maxLinkedPages"),
  previewLinksBtn: $("previewLinksBtn"), selectAllLinksBtn: $("selectAllLinksBtn"), clearAllLinksBtn: $("clearAllLinksBtn"),
  linkedPagesFilter: $("linkedPagesFilter"), linkedPagesSummary: $("linkedPagesSummary"), linkedPagesList: $("linkedPagesList"),
  inventreeUrl: $("inventreeUrl"), inventreeToken: $("inventreeToken"), inventreeEndpointPath: $("inventreeEndpointPath"),
  saveSettingsBtn: $("saveSettingsBtn"), captureBtn: $("captureBtn"), submitBtn: $("submitBtn"), jsonBtn: $("jsonBtn"),
  csvBtn: $("csvBtn"), openFullPageBtn: $("openFullPageBtn"), captureMeta: $("captureMeta"), preview: $("preview"), status: $("status"),
  datasetFile: $("datasetFile"), datasetSource: $("datasetSource"), datasetSourceUrl: $("datasetSourceUrl"),
  datasetTitle: $("datasetTitle"), datasetCategory: $("datasetCategory"), datasetSubcategory: $("datasetSubcategory"),
  importDatasetBtn: $("importDatasetBtn")
};
els.openWorkspaceBtn = $("openWorkspaceBtn");
let lastWorkspaceUrl = "";

let lastCapture = null;
let linkedPages = [];
let itemLabels = {};
const selectedLinks = new Set();

function sendMessage(payload) {
  return new Promise((resolve, reject) => chrome.runtime.sendMessage(payload, (response) => {
    if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
    else resolve(response);
  }));
}

function settings() {
  return {
    inventreeUrl: els.inventreeUrl.value.trim(),
    inventreeToken: els.inventreeToken.value.trim(),
    inventreeEndpointPath: els.inventreeEndpointPath.value.trim() || "/plugin/multi-site-importer/captures/",
    sourceMode: ["auto", "mcmaster", "boltdepot", "amazon"].includes(els.sourceMode.value) ? els.sourceMode.value : "auto",
    captureProfile: ["auto", "list-details", "single-item"].includes(els.captureProfile.value) ? els.captureProfile.value : "auto",
    crawlLinkedPages: true,
    maxLinkedPages: Number(els.maxLinkedPages.value || 100)
  };
}

function providerForUrl(url) {
  try {
    const host = new URL(String(url || "")).hostname.toLowerCase();
    if (host.includes("mcmaster.com")) return "mcmaster";
    if (host.includes("boltdepot.com")) return "boltdepot";
    if (host.includes("amazon.")) return "amazon";
  } catch {
    // Ignore browser-internal, extension, and malformed URLs.
  }
  return "";
}

async function captureTargetTabId() {
  const configuredSource = settings().sourceMode;
  const matchesSource = (tab) => {
    const provider = providerForUrl(tab?.url);
    return provider && (configuredSource === "auto" || configuredSource === provider);
  };

  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTab?.id && matchesSource(activeTab)) return activeTab.id;

  // Full-page mode makes the extension page itself active. In that case, use the
  // most recently accessed supported supplier tab in the same browser window.
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const recentSupplierTab = tabs
    .filter((tab) => tab?.id && matchesSource(tab))
    .sort((left, right) => Number(right.lastAccessed || 0) - Number(left.lastAccessed || 0))[0];
  return recentSupplierTab?.id || null;
}

function setStatus(message, kind = "") {
  els.status.textContent = message;
  els.status.className = `status visible ${kind}`.trim();
}

function renderCaptureProgress(progress) {
  if (!progress?.message) return;
  const kind = progress.status === "failed"
    ? "error"
    : (progress.status === "complete" ? "ok" : "");
  setStatus(progress.message, kind);
}

function renderCapture() {
  if (!lastCapture?.rows?.length) return;
  els.captureMeta.textContent = `${lastCapture.rows.length} row(s) from ${lastCapture.source}; ${lastCapture.pagesScraped || 1} page(s) scraped.`;
  els.preview.textContent = JSON.stringify(lastCapture.rows.slice(0, 5), null, 2);
}

function visibleLinks() {
  const query = els.linkedPagesFilter.value.trim().toLowerCase();
  return linkedPages.filter((url) => !query || `${itemLabels[url] || ""} ${url}`.toLowerCase().includes(query));
}

function renderLinks() {
  const visible = visibleLinks();
  els.linkedPagesSummary.textContent = `${linkedPages.length} found; ${visible.length} visible; ${selectedLinks.size} selected.`;
  els.linkedPagesList.replaceChildren(...visible.map((url) => {
    const label = document.createElement("label");
    label.className = "link-item";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedLinks.has(url);
    checkbox.addEventListener("change", () => { checkbox.checked ? selectedLinks.add(url) : selectedLinks.delete(url); renderLinks(); });
    const text = document.createElement("span");
    text.textContent = itemLabels[url] ? `${itemLabels[url]} — ${url}` : url;
    label.append(checkbox, text);
    return label;
  }));
}

async function saveSettings(showStatus = true) {
  const response = await sendMessage({ type: "saveSettings", settings: settings() });
  if (!response?.ok) throw new Error(response?.error || "Could not save settings");
  if (showStatus) setStatus("Connection settings saved.", "ok");
}

async function loadState() {
  const response = await sendMessage({ type: "getState" });
  if (!response?.ok) throw new Error(response?.error || "Could not load extension state");
  const saved = response.settings || {};
  els.inventreeUrl.value = saved.inventreeUrl || "";
  els.inventreeToken.value = saved.inventreeToken || "";
  els.inventreeEndpointPath.value = saved.inventreeEndpointPath || "/plugin/multi-site-importer/captures/";
  els.sourceMode.value = saved.sourceMode || "auto";
  els.captureProfile.value = saved.captureProfile || "auto";
  els.maxLinkedPages.value = String(saved.maxLinkedPages || 100);
  lastCapture = response.lastCapture;
  lastWorkspaceUrl = response.lastWorkspaceUrl || "";
  els.openWorkspaceBtn.hidden = !lastWorkspaceUrl;
  renderCapture();
  renderCaptureProgress(response.captureProgress);
}

async function capturePage() {
  setStatus("Capturing supplier page…");
  const targetTabId = await captureTargetTabId();
  const response = await sendMessage({
    type: "capturePage",
    settings: settings(),
    selectedChildLinks: [...selectedLinks],
    targetTabId
  });
  if (!response?.ok) throw new Error(response?.error || "Capture failed");
  lastCapture = response.capture;
  renderCapture();
  setStatus(`Captured ${lastCapture.rows.length} row(s).`, "ok");
}

async function previewLinkedPages() {
  setStatus("Finding linked pages…");
  const targetTabId = await captureTargetTabId();
  const response = await sendMessage({
    type: "previewLinkedPages",
    settings: settings(),
    targetTabId
  });
  if (!response?.ok) throw new Error(response?.error || "Could not preview linked pages");
  linkedPages = response.links || [];
  itemLabels = response.itemLabels || {};
  selectedLinks.clear();
  linkedPages.forEach((url) => selectedLinks.add(url));
  renderLinks();
  setStatus(`Linked page preview loaded (${linkedPages.length} found).`, "ok");
}

async function importDataset() {
  const file = els.datasetFile.files?.[0];
  if (!file) throw new Error("Select a JSON or CSV dataset file first.");
  if (file.size > 25 * 1024 * 1024) throw new Error("Dataset files are limited to 25 MB.");

  setStatus(`Loading ${file.name}…`);
  const response = await sendMessage({
    type: "importDataset",
    fileName: file.name,
    text: await file.text(),
    metadata: {
      source: els.datasetSource.value,
      sourceUrl: els.datasetSourceUrl.value,
      title: els.datasetTitle.value,
      category: els.datasetCategory.value,
      subcategory: els.datasetSubcategory.value
    }
  });
  if (!response?.ok) throw new Error(response?.error || "Could not import dataset");
  lastCapture = response.capture;
  linkedPages = [];
  itemLabels = {};
  selectedLinks.clear();
  renderLinks();
  renderCapture();
  const warnings = Array.isArray(response.warnings) && response.warnings.length
    ? `\n${response.warnings.join("\n")}`
    : "";
  setStatus(`Loaded ${lastCapture.rows.length} dataset row(s).${warnings}`, warnings ? "" : "ok");
}

async function submitCapture() {
  if (!lastCapture?.rows?.length) throw new Error("No captured rows. Capture a page first.");
  await saveSettings(false);
  setStatus("Submitting raw capture to the import queue…");
  const response = await sendMessage({ type: "submitCapture", capture: lastCapture, settings: settings() });
  if (!response?.ok) throw new Error(response?.error || "Capture submission failed");
  const id = response.captureId ? ` Capture #${response.captureId}.` : "";
  lastWorkspaceUrl = response.workspaceUrl || (response.workspacePath
    ? new URL(response.workspacePath, settings().inventreeUrl).toString()
    : "");
  els.openWorkspaceBtn.hidden = !lastWorkspaceUrl;
  setStatus(`Queued ${response.rowCount} row(s).${id}`, "ok");
}

async function download(format) {
  if (!lastCapture?.rows?.length) throw new Error("No captured rows. Capture a page first.");
  const response = await sendMessage({ type: "downloadExport", format, capture: lastCapture, settings: settings() });
  if (!response?.ok) throw new Error(response?.error || "Download failed");
  setStatus(`Downloaded ${response.filename}.`, "ok");
}

function run(action) { return action().catch((error) => setStatus(error.message || String(error), "error")); }

els.captureBtn.addEventListener("click", () => run(capturePage));
els.importDatasetBtn.addEventListener("click", () => run(importDataset));
els.previewLinksBtn.addEventListener("click", () => run(previewLinkedPages));
els.saveSettingsBtn.addEventListener("click", () => run(saveSettings));
els.submitBtn.addEventListener("click", () => run(submitCapture));
els.jsonBtn.addEventListener("click", () => run(() => download("json")));
els.csvBtn.addEventListener("click", () => run(() => download("csv")));
els.linkedPagesFilter.addEventListener("input", renderLinks);
els.selectAllLinksBtn.addEventListener("click", () => { visibleLinks().forEach((url) => selectedLinks.add(url)); renderLinks(); });
els.clearAllLinksBtn.addEventListener("click", () => { selectedLinks.clear(); renderLinks(); });
els.openFullPageBtn.addEventListener("click", () => chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?mode=full") }));
els.openWorkspaceBtn.addEventListener("click", () => {
  if (lastWorkspaceUrl) chrome.tabs.create({ url: lastWorkspaceUrl });
});

if (new URLSearchParams(location.search).get("mode") === "full") {
  document.body.classList.add("full-mode");
  els.openFullPageBtn.disabled = true;
}
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.captureProgress?.newValue) {
    renderCaptureProgress(changes.captureProgress.newValue);
  }
});
run(loadState);
