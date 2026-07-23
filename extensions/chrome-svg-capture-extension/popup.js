const enabledEl = document.getElementById("enabled");
const captureNetworkEl = document.getElementById("captureNetwork");
const captureInlineEl = document.getElementById("captureInline");
const rootFolderEl = document.getElementById("rootFolder");
const allowlistEnabledEl = document.getElementById("allowlistEnabled");
const allowlistDomainsEl = document.getElementById("allowlistDomains");
const denylistDomainsEl = document.getElementById("denylistDomains");
const fileTypeEls = Array.from(document.querySelectorAll('input[name="captureFileTypes"]'));
const saveBtn = document.getElementById("saveBtn");
const captureBtn = document.getElementById("captureBtn");
const refreshStatsBtn = document.getElementById("refreshStatsBtn");
const statusEl = document.getElementById("status");
const statsEl = document.getElementById("stats");

function listToMultiline(value) {
  if (!Array.isArray(value) || value.length === 0) return "";
  return value.join("\n");
}

function multilineToList(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function selectedFileTypes() {
  return fileTypeEls.filter((el) => el.checked).map((el) => el.value);
}

function applySelectedFileTypes(values) {
  const selected = new Set(Array.isArray(values) ? values : []);
  for (const el of fileTypeEls) {
    el.checked = selected.has(el.value);
  }
}

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "#b00020" : "#2f3d57";
}

function renderStats(stats) {
  if (!statsEl) return;
  const lines = [
    `attempted: ${stats?.attempted ?? 0}`,
    `downloaded: ${stats?.downloaded ?? 0}`,
    `failed: ${stats?.failed ?? 0}`,
    `skipped: ${stats?.skipped ?? 0}`,
    `lastUrl: ${stats?.lastUrl || "-"}`,
    `lastSavedPath: ${stats?.lastSavedPath || "-"}`,
    `lastError: ${stats?.lastError || "-"}`
  ];
  statsEl.textContent = lines.join("\n");
}

async function loadRuntimeStats() {
  try {
    const response = await sendMessage({ type: "getRuntimeStats" });
    if (!response?.ok) throw new Error(response?.error || "Could not load runtime stats");
    renderStats(response.stats || {});
  } catch (err) {
    renderStats({ lastError: String(err) });
  }
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

async function loadSettings() {
  try {
    const response = await sendMessage({ type: "getSettings" });
    if (!response?.ok) throw new Error(response?.error || "Could not load settings");
    const { settings } = response;
    enabledEl.checked = Boolean(settings.enabled);
    captureNetworkEl.checked = Boolean(settings.captureNetwork);
    captureInlineEl.checked = Boolean(settings.captureInline);
    rootFolderEl.value = settings.rootFolder || settings.baseFolder || "svg-capture";
    allowlistEnabledEl.checked = Boolean(settings.allowlistEnabled);
    allowlistDomainsEl.value = listToMultiline(settings.allowlistDomains);
    denylistDomainsEl.value = listToMultiline(settings.denylistDomains);
    applySelectedFileTypes(settings.captureFileTypes || ["svg"]);
  } catch (err) {
    setStatus(String(err), true);
  }
}

async function saveSettings() {
  setStatus("Saving...");
  try {
    const response = await sendMessage({
      type: "saveSettings",
      settings: {
        enabled: enabledEl.checked,
        captureNetwork: captureNetworkEl.checked,
        captureInline: captureInlineEl.checked,
        rootFolder: rootFolderEl.value.trim(),
        allowlistEnabled: allowlistEnabledEl.checked,
        allowlistDomains: multilineToList(allowlistDomainsEl.value),
        denylistDomains: multilineToList(denylistDomainsEl.value),
        captureFileTypes: selectedFileTypes()
      }
    });
    if (!response?.ok) throw new Error(response?.error || "Save failed");
    setStatus("Saved");
  } catch (err) {
    setStatus(String(err), true);
  }
}

async function captureNow() {
  setStatus("Capturing inline SVG from current page...");
  try {
    const response = await sendMessage({ type: "captureNow" });
    if (!response?.ok) throw new Error(response?.error || "Capture failed");
    const totals = response?.totals || {};
    setStatus(
      `Capture done: attempted ${totals.attempted || 0}, downloaded ${totals.downloaded || 0}, failed ${totals.failed || 0}`
    );
    await loadRuntimeStats();
  } catch (err) {
    setStatus(String(err), true);
  }
}

saveBtn.addEventListener("click", saveSettings);
captureBtn.addEventListener("click", captureNow);
refreshStatsBtn.addEventListener("click", loadRuntimeStats);
loadSettings();
loadRuntimeStats();
