// Extension settings, capture-progress state, and their chrome.storage.local keys.
export const DEFAULT_SETTINGS = {
  inventreeUrl: "",
  inventreeToken: "",
  inventreeEndpointPath: "/plugin/multi-site-importer/captures/",
  sourceMode: "auto",
  captureProfile: "auto",
  crawlLinkedPages: true,
  maxLinkedPages: 100
};

export const LAST_CAPTURE_KEY = "lastCapture";
export const LAST_SEND_RESPONSE_KEY = "lastSendResponse";
export const LAST_WORKSPACE_URL_KEY = "lastWorkspaceUrl";
export const CAPTURE_PROGRESS_KEY = "captureProgress";

export async function setCaptureProgress(progress) {
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
export async function getSettings() {
  const data = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  return sanitizeSettings({ ...DEFAULT_SETTINGS, ...data });
}

export function sanitizeSettings(input) {
  const sourceMode = String(input.sourceMode || "auto").trim().toLowerCase();
  const sourceModeSafe = ["auto", "mcmaster", "boltdepot", "amazon", "fastenal"].includes(sourceMode) ? sourceMode : "auto";
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

function normalizePath(value, defaultPath) {
  const fallback = String(defaultPath || "/").trim() || "/";
  const path = String(value || "").trim() || fallback;
  return path.startsWith("/") ? path : `/${path}`;
}

