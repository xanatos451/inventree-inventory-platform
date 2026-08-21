import {
  CAPTURE_PROGRESS_KEY,
  DEFAULT_SETTINGS,
  LAST_CAPTURE_KEY,
  LAST_SEND_RESPONSE_KEY,
  LAST_WORKSPACE_URL_KEY,
  getSettings,
  sanitizeSettings,
  setCaptureProgress
} from "./background/storage.js";
import { buildImportedDatasetCapture } from "./background/csv-import.js";
import { captureCurrentTabData, previewLinkedPages } from "./background/capture-orchestration.js";
import { buildExportFilename, buildRawCapture, buildRawCaptureCsv, tryParseJson } from "./background/mapping.js";

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

