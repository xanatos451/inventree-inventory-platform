const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");
const { chromium, test, expect } = require("@playwright/test");

const extensionPath = path.resolve(__dirname, "..");

let context;
let page;
let extensionId;
let mockInventreeBaseUrl;
let mockInventreeServer;

async function startMockInventreeServer() {
  const categories = [
    { pk: 12, name: "Hardware", parent: null },
    { pk: 21, name: "Fasteners", parent: 12 },
    { pk: 37, name: "Washers", parent: 21 },
  ];

  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && reqUrl.pathname === "/api/part/category/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ count: categories.length, next: null, previous: null, results: categories }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ detail: "Not found" }));
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    server,
    baseUrl: `http://127.0.0.1:${port}`,
  };
}

async function openPopupPage() {
  const popupPage = await context.newPage();
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popupPage.getByRole("heading", { name: "Multi-Site Inventory Exporter" })).toBeVisible();
  return popupPage;
}

async function openDetailsById(popupPage, id) {
  const details = popupPage.locator(`#${id}`);
  if (await details.count()) {
    const isOpen = await details.evaluate((node) => node.hasAttribute("open"));
    if (!isOpen) {
      await details.locator(":scope > summary").click();
      await expect(details).toHaveAttribute("open", "");
    }
  }
}

async function openSettingsPanel(popupPage) {
  await openDetailsById(popupPage, "settingsPanel");
}

async function openLinkedPagesPanel(popupPage) {
  await openDetailsById(popupPage, "linkedPagesPanel");
}

async function openDirectDefaultsPanel(popupPage) {
  await openSettingsPanel(popupPage);
  await openDetailsById(popupPage, "directDefaultsPanel");
}

async function openConnectionPathsPanel(popupPage) {
  await openSettingsPanel(popupPage);
  await openDetailsById(popupPage, "connectionPathsPanel");
}

async function openHeaderMappingPanel(popupPage) {
  await openSettingsPanel(popupPage);
  await openDetailsById(popupPage, "headerMappingPanel");
}

test.beforeAll(async () => {
  const mockServer = await startMockInventreeServer();
  mockInventreeServer = mockServer.server;
  mockInventreeBaseUrl = mockServer.baseUrl;

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
  if (mockInventreeServer) {
    await new Promise((resolve) => mockInventreeServer.close(resolve));
  }
});

test("loads popup UI and source options", async () => {
  const popupPage = await openPopupPage();

  await expect(popupPage.locator("#sourceMode")).toContainText("Auto Detect");
  await expect(popupPage.locator("#sourceMode")).toContainText("McMaster-Carr");
  await expect(popupPage.locator("#sourceMode")).toContainText("Bolt Depot");
  await expect(popupPage.locator("#sourceMode")).toContainText("Amazon Orders");

  await popupPage.close();
});

test("supports larger full-view mode in a tab", async () => {
  const fullPage = await context.newPage();
  await fullPage.goto(`chrome-extension://${extensionId}/popup.html?mode=full`);

  await expect(fullPage.locator("body")).toHaveClass(/full-mode/);
  await expect(fullPage.locator("#openFullPageBtn")).toBeDisabled();
  await expect(fullPage.locator("#preview")).toBeVisible();

  await fullPage.close();
});

test("saves and reloads settings from extension storage", async () => {
  const popupPage = await openPopupPage();
  await openSettingsPanel(popupPage);
  await openConnectionPathsPanel(popupPage);
  await openLinkedPagesPanel(popupPage);

  await popupPage.fill("#inventreeUrl", "https://inventree.test");
  await popupPage.fill("#inventreeToken", "token-123");
  await popupPage.fill("#inventreeEndpointPath", "/api/plugin/product-import/");
  await popupPage.selectOption("#sourceMode", "amazon");
  await popupPage.fill("#maxLinkedPages", "7");

  await popupPage.click("#saveSettingsBtn");
  await expect(popupPage.locator("#status")).toContainText("Settings and templates saved.");

  await popupPage.reload();
  await openSettingsPanel(popupPage);
  await openConnectionPathsPanel(popupPage);
  await openLinkedPagesPanel(popupPage);

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
  await openLinkedPagesPanel(popupPage);

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

test("fetches existing categories and updates default category picker", async () => {
  const popupPage = await openPopupPage();
  await openDirectDefaultsPanel(popupPage);

  await popupPage.fill("#inventreeUrl", mockInventreeBaseUrl);
  await popupPage.fill("#inventreeToken", "token-abc");
  await popupPage.click("#fetchCategoriesBtn");

  await expect(popupPage.locator("#status")).toContainText("Fetched 3 categories.");
  await expect(popupPage.locator("#existingCategorySelect option")).toHaveCount(4);
  await expect(popupPage.locator("#existingCategorySelect")).toContainText("Hardware > Fasteners (#21)");

  await popupPage.selectOption("#existingCategorySelect", "21");
  await expect(popupPage.locator("#inventreeDefaultCategoryId")).toHaveValue("21");

  await popupPage.close();
});

test("previews category assignment plan with existing and create steps", async () => {
  const popupPage = await openPopupPage();

  await popupPage.evaluate(async ({ mockInventreeBaseUrl }) => {
    const mappingTemplates = {
      "boltdepot:order-details": {
        name: { sourceField: "Name", regex: "" },
        description: { sourceField: "", regex: "" },
        quantity: { sourceField: "", regex: "" },
        category: { sourceField: "Category", regex: "" },
        subcategory: { sourceField: "Subcategory", regex: "" },
        variant: { sourceField: "", regex: "" },
      },
    };

    await new Promise((resolve) => {
      chrome.runtime.sendMessage(
        {
          type: "saveSettings",
          settings: {
            inventreeSyncMode: "direct",
            inventreeUrl: mockInventreeBaseUrl,
            inventreeToken: "token-abc",
            inventreeDefaultCategoryId: "12",
            enableCategoryBuilder: true,
            mappingTemplates,
          },
        },
        resolve,
      );
    });

    await chrome.storage.local.set({
      lastCapture: {
        source: "boltdepot",
        pageType: "order-details",
        capturedAt: "2026-01-01T00:00:00.000Z",
        pageTitle: "Order 2556509",
        pageUrl: "https://boltdepot.com/Account/Order-Details?orderId=2556509",
        headers: ["Name", "Category", "Subcategory"],
        rows: [
          {
            Name: "Hex Cap Screw",
            Category: "Fasteners",
            Subcategory: "Nuts",
          },
          {
            Name: "Flat Washer",
            Category: "Fasteners",
            Subcategory: "Washers",
          },
        ],
        pagesScraped: 1,
      },
    });
  }, { mockInventreeBaseUrl });

  await popupPage.reload();
  await openDirectDefaultsPanel(popupPage);
  await openHeaderMappingPanel(popupPage);
  await popupPage.selectOption('select[data-map-source="name"]', "Name");
  await popupPage.selectOption('select[data-map-source="category"]', "Category");
  await popupPage.selectOption('select[data-map-source="subcategory"]', "Subcategory");
  await popupPage.click("#previewCategoryAssignmentsBtn");

  await expect(popupPage.locator("#status")).toContainText("Category preview ready for 2 item(s).");
  await expect(popupPage.locator("#status")).toContainText("Planned category creates: 1.");
  await expect(popupPage.locator("#categoryPreviewDetails")).toHaveClass(/visible/);
  await expect(popupPage.locator("#categoryPreviewSummary")).toContainText("Would create segments: 1");
  await expect(popupPage.locator("#categoryPreviewList")).toContainText("existing: Fasteners");
  await expect(popupPage.locator("#categoryPreviewList")).toContainText("create: Nuts");
  await expect(popupPage.locator("#categoryPreviewList")).toContainText("Hardware > Fasteners > Nuts");

  await popupPage.close();
});

test("direct mode dry-run reports missing required settings", async () => {
  const popupPage = await openPopupPage();
  await openDirectDefaultsPanel(popupPage);

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
