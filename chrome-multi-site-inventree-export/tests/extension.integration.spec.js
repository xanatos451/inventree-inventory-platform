const path = require("path");
const os = require("os");
const fs = require("fs");
const { chromium, test, expect } = require("@playwright/test");

const extensionPath = path.resolve(__dirname, "..");

let context;
let page;
let extensionId;

async function openPopupPage() {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popupPage.getByRole("heading", { name: "Multi-Site Inventory Exporter" })).toBeVisible();
  return popupPage;
}

test.beforeAll(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "inventory-exporter-e2e-"));

  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });

  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker");
  }

  const serviceWorkerUrl = serviceWorker.url();
  extensionId = serviceWorkerUrl.split("/")[2];

  page = await context.newPage();
  await page.goto("https://example.com/");
});

test.afterAll(async () => {
  await context?.close();
});

test("loads popup UI and source options", async () => {
  const popupPage = await openPopupPage();

  await expect(popupPage.locator("#sourceMode")).toContainText("Auto Detect");
  await expect(popupPage.locator("#sourceMode")).toContainText("McMaster-Carr");
  await expect(popupPage.locator("#sourceMode")).toContainText("Bolt Depot");
  await expect(popupPage.locator("#sourceMode")).toContainText("Amazon Orders");

  await popupPage.close();
});

test("saves and reloads settings from extension storage", async () => {
  const popupPage = await openPopupPage();

  await popupPage.fill("#inventreeUrl", "https://inventree.test");
  await popupPage.fill("#inventreeToken", "token-123");
  await popupPage.fill("#inventreeEndpointPath", "/api/plugin/product-import/");
  await popupPage.selectOption("#sourceMode", "amazon");
  await popupPage.fill("#maxLinkedPages", "7");

  await popupPage.click("#saveSettingsBtn");
  await expect(popupPage.locator("#status")).toContainText("Settings saved.");

  await popupPage.reload();

  await expect(popupPage.locator("#inventreeUrl")).toHaveValue("https://inventree.test");
  await expect(popupPage.locator("#inventreeToken")).toHaveValue("token-123");
  await expect(popupPage.locator("#inventreeEndpointPath")).toHaveValue("/api/plugin/product-import/");
  await expect(popupPage.locator("#sourceMode")).toHaveValue("amazon");
  await expect(popupPage.locator("#maxLinkedPages")).toHaveValue("7");

  await popupPage.close();
});

test("sanitizes saved settings in background handler", async () => {
  const popupPage = await openPopupPage();

  const result = await popupPage.evaluate(async () => {
    const save = await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "saveSettings",
          settings: {
            sourceMode: "not-a-provider",
            maxLinkedPages: 999,
            inventreeEndpointPath: "api/custom-import",
          },
        },
        resolve,
      );
    });

    const state = await new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "getState" }, resolve);
    });

    return { save, state };
  });

  expect(result.save?.ok).toBeTruthy();
  expect(result.state?.ok).toBeTruthy();
  expect(result.state.settings.sourceMode).toBe("auto");
  expect(result.state.settings.maxLinkedPages).toBe(80);
  expect(result.state.settings.inventreeEndpointPath).toBe("/api/custom-import");

  await popupPage.close();
});

test("shows validation error when sending without capture", async () => {
  const popupPage = await openPopupPage();

  await popupPage.click("#sendBtn");
  await expect(popupPage.locator("#status")).toContainText("No captured rows. Capture a page first.");

  await popupPage.close();
});

test("shows unsupported page error for capture on non-supported site", async () => {
  const popupPage = await openPopupPage();

  await popupPage.click("#captureBtn");
  await expect(popupPage.locator("#status")).toContainText("Unsupported page");

  await popupPage.close();
});

test("shows provider-specific error when source is forced to McMaster", async () => {
  const popupPage = await openPopupPage();

  await popupPage.selectOption("#sourceMode", "mcmaster");
  await popupPage.click("#captureBtn");
  await expect(popupPage.locator("#status")).toContainText("Active tab is not a McMaster-Carr page.");

  await popupPage.close();
});

test("previews zero linked pages on non-supported site", async () => {
  const popupPage = await openPopupPage();

  await popupPage.click("#previewLinksBtn");
  await expect(popupPage.locator("#status")).toContainText("Linked page preview loaded (0 found).");
  await expect(popupPage.locator("#linkedPagesSummary")).toContainText("Items/pages: 0. Visible: 0. Selected: 0.");

  await popupPage.close();
});

test("opens help docs and shows quick start content", async () => {
  const popupPage = await openPopupPage();

  await popupPage.click("#helpBtn");
  await expect(popupPage.locator("#helpPanel")).toHaveAttribute("open", "");
  await expect(popupPage.locator("#helpPanel")).toContainText("Quick Start");
  await expect(popupPage.locator("#helpPanel")).toContainText("Direct Mode Dry-Run Validation");

  await popupPage.close();
});

test("direct mode dry-run reports missing required settings", async () => {
  const popupPage = await openPopupPage();

  await popupPage.selectOption("#inventreeSyncMode", "direct");
  await popupPage.fill("#inventreeUrl", "");
  await popupPage.fill("#inventreeToken", "");
  await popupPage.fill("#inventreeDefaultCategoryId", "");
  await popupPage.click("#dryRunBtn");

  await expect(popupPage.locator("#status")).toContainText("Dry-run found issues");
  await expect(popupPage.locator("#status")).toContainText("InvenTree Base URL");
  await expect(popupPage.locator("#status")).toContainText("Default Category ID");
  await expect(popupPage.locator("#status")).toContainText("PASS: Default Supplier ID");
  await expect(popupPage.locator("#dryRunDetails")).toHaveClass(/visible/);
  await expect(popupPage.locator("#dryRunDetailsList")).toContainText("FAIL: InvenTree Base URL");
  await expect(popupPage.locator("#dryRunDetailsList")).toContainText("FAIL: Default Category ID");
  await expect(popupPage.locator("#dryRunDetailsList")).toContainText("PASS: Default Supplier ID");

  await popupPage.close();
});

test("dry-run requires direct mode", async () => {
  const popupPage = await openPopupPage();

  await popupPage.selectOption("#inventreeSyncMode", "plugin");
  await popupPage.click("#dryRunBtn");
  await expect(popupPage.locator("#status")).toContainText("Dry-run found issues");
  await expect(popupPage.locator("#status")).toContainText("Sync mode");

  await popupPage.close();
});
