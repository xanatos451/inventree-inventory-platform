const DEFAULT_SETTINGS = {
  enabled: true,
  captureNetwork: true,
  captureInline: true,
  rootFolder: "svg-capture",
  allowlistEnabled: false,
  allowlistDomains: [],
  denylistDomains: [],
  captureFileTypes: ["svg", "png", "jpg", "jpeg", "webp", "gif"]
};

const COMMON_IMAGE_TYPES = ["svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "tif", "tiff"];
const RUNTIME_STATS_KEY = "runtimeStats";

const COMMON_SECOND_LEVEL_TLDS = new Set([
  "co.uk",
  "org.uk",
  "gov.uk",
  "ac.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.jp",
  "com.br",
  "com.mx"
]);

const networkSeen = new Set();
const inlineSeenByTab = new Map();

async function readRuntimeStats() {
  const data = await chrome.storage.local.get([RUNTIME_STATS_KEY]);
  const stats = data[RUNTIME_STATS_KEY] || {};
  return {
    attempted: Number(stats.attempted || 0),
    downloaded: Number(stats.downloaded || 0),
    failed: Number(stats.failed || 0),
    skipped: Number(stats.skipped || 0),
    lastUrl: String(stats.lastUrl || ""),
    lastSavedPath: String(stats.lastSavedPath || ""),
    lastError: String(stats.lastError || "")
  };
}

async function updateRuntimeStats(patch) {
  const current = await readRuntimeStats();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [RUNTIME_STATS_KEY]: next });
  return next;
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
  await chrome.storage.local.set({
    [RUNTIME_STATS_KEY]: {
      attempted: 0,
      downloaded: 0,
      failed: 0,
      skipped: 0,
      lastUrl: "",
      lastSavedPath: "",
      lastError: ""
    }
  });
});

function sanitizeFilePart(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120);
}

function sanitizeHumanLabel(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
}

function normalizeDomainRule(raw) {
  let value = String(raw || "").trim().toLowerCase();
  if (!value) return "";
  value = value.replace(/^https?:\/\//, "");
  value = value.replace(/^\*\./, "");
  value = value.replace(/^www\./, "");
  value = value.split("/")[0].split(":")[0].trim();
  return value;
}

function sanitizeDomainList(rawList) {
  const input = Array.isArray(rawList)
    ? rawList
    : String(rawList || "")
      .split(/[\n,]/)
      .map((item) => item.trim());

  const seen = new Set();
  const output = [];
  for (const entry of input) {
    const normalized = normalizeDomainRule(entry);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function sanitizeCaptureFileTypes(rawList) {
  const input = Array.isArray(rawList) ? rawList : [];
  const seen = new Set();
  const output = [];
  for (const value of input) {
    const item = String(value || "").trim().toLowerCase();
    if (!COMMON_IMAGE_TYPES.includes(item)) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    output.push(item);
  }
  if (output.length === 0) {
    return ["svg"];
  }
  return output;
}

function domainMatchesRule(host, primaryDomain, rule) {
  if (!rule) return false;
  return (
    host === rule ||
    host.endsWith(`.${rule}`) ||
    primaryDomain === rule ||
    primaryDomain.endsWith(`.${rule}`)
  );
}

function shouldCaptureForUrl(rawUrl, settings) {
  let host = "";
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  const primaryDomain = getPrimaryDomain(host);
  const allowlist = sanitizeDomainList(settings.allowlistDomains);
  const denylist = sanitizeDomainList(settings.denylistDomains);

  for (const rule of denylist) {
    if (domainMatchesRule(host, primaryDomain, rule)) {
      return false;
    }
  }

  if (settings.allowlistEnabled) {
    if (allowlist.length === 0) {
      return true;
    }
    for (const rule of allowlist) {
      if (domainMatchesRule(host, primaryDomain, rule)) {
        return true;
      }
    }
    return false;
  }

  return true;
}

function getPrimaryDomain(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (!host) return "unknown-domain";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;

  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;

  const lastTwo = parts.slice(-2).join(".");
  const lastThree = parts.slice(-3).join(".");
  if (COMMON_SECOND_LEVEL_TLDS.has(lastTwo) && parts.length >= 3) {
    return lastThree;
  }
  return lastTwo;
}

function normalizeSvgUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.hash = "";
    return u.toString();
  } catch {
    return "";
  }
}

function getUrlImageType(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const path = u.pathname.toLowerCase();
    const query = u.search.toLowerCase();
    const match = path.match(/\.([a-z0-9]+)$/i);
    if (match && match[1]) {
      const ext = match[1].toLowerCase();
      if (COMMON_IMAGE_TYPES.includes(ext)) {
        return ext;
      }
    }

    const queryMatch = query.match(/[?&](?:format|type|ext)=([a-z0-9]+)/i);
    if (queryMatch && queryMatch[1]) {
      const q = queryMatch[1].toLowerCase();
      if (COMMON_IMAGE_TYPES.includes(q)) {
        return q;
      }
    }

    if (query.includes("format=svg") || query.includes("type=svg")) {
      return "svg";
    }

    return "";
  } catch {
    return "";
  }
}

function getResponseHeaderValue(responseHeaders, headerName) {
  if (!Array.isArray(responseHeaders)) return "";
  const wanted = String(headerName || "").toLowerCase();
  for (const header of responseHeaders) {
    if (String(header?.name || "").toLowerCase() === wanted) {
      return String(header?.value || "").toLowerCase();
    }
  }
  return "";
}

function getImageTypeFromContentType(contentType) {
  const value = String(contentType || "").toLowerCase();
  if (!value.startsWith("image/")) return "";
  if (value.includes("svg")) return "svg";
  if (value.includes("jpeg")) return "jpeg";
  if (value.includes("jpg")) return "jpg";
  if (value.includes("png")) return "png";
  if (value.includes("gif")) return "gif";
  if (value.includes("webp")) return "webp";
  if (value.includes("avif")) return "avif";
  if (value.includes("bmp")) return "bmp";
  if (value.includes("icon") || value.includes("x-icon")) return "ico";
  if (value.includes("tiff") || value.includes("tif")) return "tiff";
  return "";
}

async function getSettings() {
  const settings = await chrome.storage.local.get(Object.keys(DEFAULT_SETTINGS));
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  // Backward compatibility with previous setting name.
  merged.rootFolder = sanitizeFilePart(merged.rootFolder || merged.baseFolder || DEFAULT_SETTINGS.rootFolder) || DEFAULT_SETTINGS.rootFolder;
  merged.captureFileTypes = sanitizeCaptureFileTypes(merged.captureFileTypes);
  return merged;
}

function getDomainFromUrl(rawUrl) {
  try {
    return getPrimaryDomain(new URL(rawUrl).hostname);
  } catch {
    return "unknown-domain";
  }
}

function toDataUrl(svgText) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
}

async function enqueueDownload({ url, filename }) {
  return new Promise((resolve) => {
    chrome.downloads.download(
      {
        url,
        filename,
        conflictAction: "uniquify",
        saveAs: false
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          console.warn("Download skipped:", chrome.runtime.lastError.message, filename);
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve({ ok: true, downloadId });
      }
    );
  });
}

async function captureNetworkSvg(details) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.captureNetwork) return;
  let imageType = getUrlImageType(details.url);
  if (!imageType) {
    const contentType = getResponseHeaderValue(details.responseHeaders, "content-type");
    imageType = getImageTypeFromContentType(contentType);
  }
  if (!imageType) return;
  if (!settings.captureFileTypes.includes(imageType)) return;

  let contextUrl = details.url;
  try {
    if (details.tabId >= 0) {
      const tab = await chrome.tabs.get(details.tabId);
      if (tab?.url) {
        contextUrl = tab.url;
      }
    }
  } catch {
    contextUrl = details.url;
  }

  if (!shouldCaptureForUrl(contextUrl, settings)) return;

  const normalized = normalizeSvgUrl(details.url);
  if (!normalized) return;
  if (networkSeen.has(normalized)) {
    const stats = await readRuntimeStats();
    await updateRuntimeStats({ skipped: stats.skipped + 1, lastUrl: normalized });
    return;
  }
  networkSeen.add(normalized);
  const startStats = await readRuntimeStats();
  await updateRuntimeStats({ attempted: startStats.attempted + 1, lastUrl: normalized, lastError: "" });

  let pageDomain = "unknown-domain";
  try {
    pageDomain = getDomainFromUrl(contextUrl);
  } catch {
    pageDomain = getDomainFromUrl(details.url);
  }

  const assetName = sanitizeFilePart(normalized.split("/").pop() || `network.${imageType}`) || `network.${imageType}`;
  const fileName = `${settings.rootFolder}/${pageDomain}/network/${imageType}/${Date.now()}_${assetName}`;
  const result = await enqueueDownload({ url: normalized, filename: fileName });
  if (result.ok) {
    const stats = await readRuntimeStats();
    await updateRuntimeStats({ downloaded: stats.downloaded + 1, lastSavedPath: fileName, lastError: "" });
  } else {
    const stats = await readRuntimeStats();
    await updateRuntimeStats({ failed: stats.failed + 1, lastError: result.error || "Download failed" });
  }
}

function collectDomAssetUrls() {
  const urls = new Map();

  const firstMeaningful = (...values) => {
    for (const value of values) {
      const text = String(value || "").replace(/\s+/g, " ").trim();
      if (text && text.length > 1) return text;
    }
    return "";
  };

  const labelForNode = (node) => {
    if (!node || !node.getAttribute) return "";
    const anchor = node.closest ? node.closest("a") : null;
    const anchorTitle = anchor ? anchor.getAttribute("title") : "";
    const anchorText = anchor ? anchor.textContent : "";
    const childTitle = node.querySelector ? node.querySelector("title") : null;
    return firstMeaningful(
      node.getAttribute("alt"),
      node.getAttribute("title"),
      node.getAttribute("aria-label"),
      node.getAttribute("data-name"),
      node.getAttribute("data-title"),
      childTitle ? childTitle.textContent : "",
      anchorTitle,
      anchorText
    );
  };

  const addUrl = (value, label = "") => {
    if (!value) return;
    try {
      const abs = new URL(value, location.href).toString();
      const existing = urls.get(abs) || "";
      if (!existing || (label && label.length > existing.length)) {
        urls.set(abs, label || existing);
      }
    } catch {
      // ignore bad values
    }
  };

  const addSrcSet = (srcset, label = "") => {
    if (!srcset) return;
    const parts = String(srcset).split(",");
    for (const part of parts) {
      const candidate = part.trim().split(/\s+/)[0];
      addUrl(candidate, label);
    }
  };

  for (const node of document.querySelectorAll("img,source")) {
    const label = labelForNode(node);
    addUrl(node.getAttribute("src"), label);
    addUrl(node.getAttribute("data-src"), label);
    addSrcSet(node.getAttribute("srcset"), label);
    addSrcSet(node.getAttribute("data-srcset"), label);
    if (node.currentSrc) addUrl(node.currentSrc, label);
  }

  for (const node of document.querySelectorAll("link[rel='preload'],link[rel='prefetch'],link[rel='icon'],link[rel='apple-touch-icon']")) {
    const label = firstMeaningful(node.getAttribute("title"), node.getAttribute("as"), node.getAttribute("rel"));
    addUrl(node.getAttribute("href"), label);
  }

  for (const node of document.querySelectorAll("[style]")) {
    const style = node.getAttribute("style") || "";
    const matches = style.matchAll(/url\((['"]?)(.*?)\1\)/gi);
    for (const match of matches) {
      addUrl(match[2], "style_asset");
    }
  }

  // Page source/script fallback for assets referenced in JS state blobs.
  const sourceText = `${document.documentElement?.outerHTML || ""}\n${Array.from(document.scripts).map((s) => s.textContent || "").join("\n")}`;
  const patterns = [
    /https?:\/\/[^\s"'<>]+\/mv[a-z]\/Contents\/[^\s"'<>]+\.(?:svg|png|jpe?g|gif|webp|avif|bmp|ico|tiff?)/gi,
    /\/mv[a-z]\/Contents\/[^\s"'<>]+\.(?:svg|png|jpe?g|gif|webp|avif|bmp|ico|tiff?)/gi,
    /https?:\/\/[^\s"'<>]+\.(?:svg|png|jpe?g|gif|webp|avif|bmp|ico|tiff?)(?:[?#][^\s"'<>]*)?/gi
  ];

  for (const pattern of patterns) {
    const matches = sourceText.match(pattern) || [];
    for (const match of matches) {
      addUrl(match, "source_asset");
    }
  }

  // Include URLs from Performance entries if available.
  try {
    const entries = performance.getEntriesByType("resource") || [];
    for (const entry of entries) {
      if (entry?.name) {
        addUrl(entry.name, "resource_asset");
      }
    }
  } catch {
    // ignore
  }

  return Array.from(urls.entries()).map(([url, label]) => ({ url, label }));
}

function extractAssetUrlsFromText(text, baseUrl) {
  const urls = new Set();
  const addUrl = (value) => {
    if (!value) return;
    try {
      const abs = new URL(value, baseUrl).toString();
      urls.add(abs);
    } catch {
      // ignore invalid urls
    }
  };

  const source = String(text || "");
  const patterns = [
    /https?:\/\/[^\s"'<>]+\/mv[a-z]\/Contents\/[^\s"'<>]+\.(?:svg|png|jpe?g|gif|webp|avif|bmp|ico|tiff?)/gi,
    /\/mv[a-z]\/Contents\/[^\s"'<>]+\.(?:svg|png|jpe?g|gif|webp|avif|bmp|ico|tiff?)/gi,
    /https?:\/\/[^\s"'<>]+\.(?:svg|png|jpe?g|gif|webp|avif|bmp|ico|tiff?)(?:[?#][^\s"'<>]*)?/gi
  ];

  for (const pattern of patterns) {
    const matches = source.match(pattern) || [];
    for (const match of matches) {
      addUrl(match);
    }
  }

  return Array.from(urls);
}

async function processCandidateUrls(candidateUrls, pageDomain, folderName, settings) {
  let attempted = 0;
  let downloaded = 0;
  let failed = 0;

  for (const candidate of candidateUrls) {
    const rawUrl = typeof candidate === "string" ? candidate : candidate?.url;
    const rawLabel = typeof candidate === "string" ? "" : (candidate?.label || "");
    const normalized = normalizeSvgUrl(rawUrl);
    if (!normalized || networkSeen.has(normalized)) continue;

    const imageType = getUrlImageType(normalized);
    if (!imageType) continue;
    if (!settings.captureFileTypes.includes(imageType)) continue;

    networkSeen.add(normalized);
    attempted += 1;
    const stats = await readRuntimeStats();
    await updateRuntimeStats({ attempted: stats.attempted + 1, lastUrl: normalized, lastError: "" });

    const fallbackName = `${folderName}.${imageType}`;
    const assetName = sanitizeFilePart(normalized.split("/").pop() || fallbackName) || fallbackName;
    const labelPart = sanitizeHumanLabel(rawLabel);
    const composedName = labelPart ? `${labelPart}_${assetName}` : assetName;
    const fileName = `${settings.rootFolder}/${pageDomain}/${folderName}/${imageType}/${Date.now()}_${composedName}`;
    const downloadResult = await enqueueDownload({ url: normalized, filename: fileName });

    if (downloadResult.ok) {
      downloaded += 1;
      const doneStats = await readRuntimeStats();
      await updateRuntimeStats({ downloaded: doneStats.downloaded + 1, lastSavedPath: fileName, lastError: "" });
    } else {
      failed += 1;
      const failStats = await readRuntimeStats();
      await updateRuntimeStats({ failed: failStats.failed + 1, lastError: downloadResult.error || "Download failed" });
    }
  }

  return { attempted, downloaded, failed };
}

async function captureDomAssetsFromTab(tabId, tabUrl) {
  const settings = await getSettings();
  if (!settings.enabled || tabId < 0 || !tabUrl) return;
  if (!/^https?:/i.test(tabUrl)) return;
  if (!shouldCaptureForUrl(tabUrl, settings)) return;

  let execution;
  try {
    execution = await chrome.scripting.executeScript({
      target: { tabId },
      func: collectDomAssetUrls
    });
  } catch {
    return;
  }

  const resultUrls = execution?.[0]?.result;
  if (!Array.isArray(resultUrls) || resultUrls.length === 0) return;

  const pageDomain = getDomainFromUrl(tabUrl);
  return processCandidateUrls(resultUrls, pageDomain, "dom", settings);
}

async function captureFromFetchedPageSource(tabUrl) {
  const settings = await getSettings();
  if (!settings.enabled || !tabUrl) return { attempted: 0, downloaded: 0, failed: 0 };
  if (!/^https?:/i.test(tabUrl)) return { attempted: 0, downloaded: 0, failed: 0 };
  if (!shouldCaptureForUrl(tabUrl, settings)) return { attempted: 0, downloaded: 0, failed: 0 };

  let html = "";
  try {
    const response = await fetch(tabUrl, { credentials: "include", cache: "no-store" });
    html = await response.text();
  } catch {
    return { attempted: 0, downloaded: 0, failed: 0 };
  }

  const candidates = extractAssetUrlsFromText(html, tabUrl);
  if (candidates.length === 0) {
    return { attempted: 0, downloaded: 0, failed: 0 };
  }

  const pageDomain = getDomainFromUrl(tabUrl);
  return processCandidateUrls(candidates, pageDomain, "source", settings);
}

function collectInlineSvgs() {
  const nodes = Array.from(document.querySelectorAll("svg"));
  return nodes
    .map((node) => {
      try {
        return new XMLSerializer().serializeToString(node);
      } catch {
        return "";
      }
    })
    .filter(Boolean);
}

async function captureInlineFromTab(tabId, tabUrl) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.captureInline || tabId < 0 || !tabUrl) return;
  if (!/^https?:/i.test(tabUrl)) return;
  if (!shouldCaptureForUrl(tabUrl, settings)) return;
  if (!settings.captureFileTypes.includes("svg")) return;

  let execution;
  try {
    execution = await chrome.scripting.executeScript({
      target: { tabId },
      func: collectInlineSvgs
    });
  } catch {
    return;
  }

  const results = execution?.[0]?.result;
  if (!Array.isArray(results) || results.length === 0) return;

  const domain = getDomainFromUrl(tabUrl);
  const perTabSeen = inlineSeenByTab.get(tabId) || new Set();
  let downloaded = 0;

  for (let i = 0; i < results.length; i += 1) {
    const svgText = results[i];
    const fingerprint = `${tabUrl}|${svgText.slice(0, 200)}`;
    if (perTabSeen.has(fingerprint)) continue;
    perTabSeen.add(fingerprint);

    const name = `${Date.now()}_inline_${i + 1}.svg`;
    const fileName = `${settings.rootFolder}/${domain}/inline/svg/${name}`;
    await enqueueDownload({ url: toDataUrl(svgText), filename: fileName });
    downloaded += 1;
    if (downloaded >= 20) break;
  }

  inlineSeenByTab.set(tabId, perTabSeen);
}

chrome.webRequest.onCompleted.addListener(
  (details) => {
    captureNetworkSvg(details).catch(() => {});
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab?.url) {
    captureInlineFromTab(tabId, tab.url).catch(() => {});
    captureDomAssetsFromTab(tabId, tab.url).catch(() => {});
    captureFromFetchedPageSource(tab.url).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  inlineSeenByTab.delete(tabId);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message?.type === "getSettings") {
      const settings = await getSettings();
      sendResponse({ ok: true, settings });
      return;
    }

    if (message?.type === "getRuntimeStats") {
      const stats = await readRuntimeStats();
      sendResponse({ ok: true, stats });
      return;
    }

    if (message?.type === "saveSettings" && message.settings) {
      const next = {
        enabled: Boolean(message.settings.enabled),
        captureNetwork: Boolean(message.settings.captureNetwork),
        captureInline: Boolean(message.settings.captureInline),
        rootFolder: sanitizeFilePart(message.settings.rootFolder || message.settings.baseFolder || DEFAULT_SETTINGS.rootFolder) || DEFAULT_SETTINGS.rootFolder,
        allowlistEnabled: Boolean(message.settings.allowlistEnabled),
        allowlistDomains: sanitizeDomainList(message.settings.allowlistDomains),
        denylistDomains: sanitizeDomainList(message.settings.denylistDomains),
        captureFileTypes: sanitizeCaptureFileTypes(message.settings.captureFileTypes)
      };
      next.baseFolder = next.rootFolder;
      await chrome.storage.local.set(next);
      sendResponse({ ok: true, settings: next });
      return;
    }

    if (message?.type === "captureNow") {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      let totals = { attempted: 0, downloaded: 0, failed: 0 };
      if (tab?.id !== undefined && tab.url) {
        await captureInlineFromTab(tab.id, tab.url);
        const domTotals = await captureDomAssetsFromTab(tab.id, tab.url);
        const sourceTotals = await captureFromFetchedPageSource(tab.url);
        totals = {
          attempted: (domTotals?.attempted || 0) + (sourceTotals?.attempted || 0),
          downloaded: (domTotals?.downloaded || 0) + (sourceTotals?.downloaded || 0),
          failed: (domTotals?.failed || 0) + (sourceTotals?.failed || 0)
        };
      }
      sendResponse({ ok: true, totals });
      return;
    }

    sendResponse({ ok: false, error: "Unknown message" });
  })().catch((err) => {
    sendResponse({ ok: false, error: String(err) });
  });

  return true;
});
