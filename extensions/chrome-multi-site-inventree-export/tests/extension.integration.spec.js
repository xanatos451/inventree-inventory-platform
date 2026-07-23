const path = require("path");
const os = require("os");
const fs = require("fs");
const http = require("http");
const { chromium, test, expect } = require("@playwright/test");

const extensionPath = path.resolve(__dirname, "..");
let context;
let extensionId;
let server;
let baseUrl;
let submissions = [];

async function openPopup(query = "") {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html${query}`);
  await expect(page.getByRole("heading", { name: "Multi-Site Inventory Capture" })).toBeVisible();
  return page;
}

test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/mock-mcmaster-detail") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><body><main>
        <nav aria-label="breadcrumb"><a>Fasteners</a><span>Screws</span></nav>
        <h1>Alloy Steel Socket Head Screw 91251A542</h1>
        <p>High-strength socket head screw.</p>
        <table><tr><th>Thread Size</th><td>1/4-20</td></tr><tr><th>Length</th><td>2 in.</td></tr></table>
      </main></body></html>`);
      return;
    }
    if (req.method === "POST" && req.url === "/plugin/multi-site-importer/captures/") {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        submissions.push({ body: JSON.parse(body), authorization: req.headers.authorization });
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ capture_id: 42, status: "queued", row_count: 1, workspace_path: "/plugin/multi-site-importer/captures/42/workspace/" }));
      });
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ detail: "Not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "inventory-capture-e2e-"));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    headless: false,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  extensionId = worker.url().split("/")[2];
  const page = await context.newPage();
  await page.goto("https://example.com/");
});

test.afterAll(async () => {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
});

test("shows capture-only workflow without direct-sync controls", async () => {
  const page = await openPopup();
  await expect(page.locator("#sourceMode")).toContainText("McMaster-Carr");
  await expect(page.locator("#captureProfile")).toContainText("List/Table Items + Detail Pages");
  await expect(page.getByRole("button", { name: "Submit to Import Queue" })).toBeVisible();
  await expect(page.locator("body")).not.toContainText("Direct InvenTree API");
  await expect(page.locator("body")).not.toContainText("Header Mapping Hints");
  await page.close();
});

test("supports a larger tab view", async () => {
  const page = await openPopup("?mode=full");
  await expect(page.locator("body")).toHaveClass(/full-mode/);
  await expect(page.locator("#openFullPageBtn")).toBeDisabled();
  await page.close();
});

test("saves only the plugin connection and capture settings", async () => {
  const page = await openPopup();
  await page.locator("#settingsPanel").evaluate((node) => { node.open = true; });
  await page.locator("#linkedPagesPanel").evaluate((node) => { node.open = true; });
  await page.fill("#inventreeUrl", baseUrl);
  await page.fill("#inventreeToken", "capture-token");
  await page.selectOption("#sourceMode", "amazon");
  await page.selectOption("#captureProfile", "list-details");
  await page.fill("#maxLinkedPages", "7");
  await page.click("#saveSettingsBtn");
  await expect(page.locator("#status")).toContainText("Connection settings saved");
  await page.reload();
  await expect(page.locator("#inventreeUrl")).toHaveValue(baseUrl);
  await expect(page.locator("#sourceMode")).toHaveValue("amazon");
  await expect(page.locator("#captureProfile")).toHaveValue("list-details");
  await expect(page.locator("#maxLinkedPages")).toHaveValue("7");
  await page.close();
});

test("submits a versioned raw capture to the plugin queue", async () => {
  submissions = [];
  const page = await openPopup();
  await page.evaluate(async ({ baseUrl }) => {
    await chrome.storage.local.set({
      inventreeUrl: baseUrl,
      inventreeToken: "capture-token",
      inventreeEndpointPath: "/plugin/multi-site-importer/captures/",
      lastCapture: {
        source: "boltdepot", pageType: "product-table", capturedAt: "2026-07-22T12:00:00.000Z",
        pageTitle: "Bolts", pageUrl: "https://boltdepot.com/Bolts.aspx", headers: ["Part Number"],
        rows: [{ "Part Number": "BD-1" }], pagesScraped: 1,
      },
    });
  }, { baseUrl });
  await page.reload();
  await page.click("#submitBtn");
  await expect(page.locator("#status")).toContainText("Queued 1 row(s). Capture #42.");
  expect(submissions).toHaveLength(1);
  expect(submissions[0].authorization).toBe("Token capture-token");
  expect(submissions[0].body.contract_version).toBe("1.0");
  expect(submissions[0].body.capture_profile).toBe("auto");
  expect(submissions[0].body.payload.rows).toEqual([{ "Part Number": "BD-1" }]);
  expect(submissions[0].body.payload).not.toHaveProperty("items");
  await expect(page.getByRole("button", { name: "Open Import Field Workspace" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Open Import Field Workspace" })).toBeVisible();
  const storedWorkspaceUrl = await page.evaluate(async () => {
    const stored = await chrome.storage.local.get("lastWorkspaceUrl");
    return stored.lastWorkspaceUrl;
  });
  expect(storedWorkspaceUrl).toBe(`${baseUrl}/plugin/multi-site-importer/captures/42/workspace/`);
  await page.close();
});

test("rejects queue submission without a capture", async () => {
  const page = await openPopup();
  await page.evaluate(() => chrome.storage.local.remove("lastCapture"));
  await page.reload();
  await page.click("#submitBtn");
  await expect(page.locator("#status")).toContainText("No captured rows");
  await page.close();
});

test("reports unsupported pages during capture", async () => {
  const page = await openPopup();
  await page.selectOption("#sourceMode", "auto");
  await page.click("#captureBtn");
  await expect(page.locator("#status")).toContainText("Unsupported page");
  await page.close();
});

test("enriches McMaster table rows from item pages while preserving list taxonomy", async () => {
  await context.route("https://www.mcmaster.com/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/mock-category-frame") {
      await route.fulfill({ contentType: "text/html", body: `
        <html><body><main>
          <nav aria-label="breadcrumb"><a>Hardware</a><span>Fasteners</span></nav>
          <h1>Socket Head Screws</h1><p>Choose a screw.</p>
          <table><thead><tr><th>Part Number</th><th>Material</th><th>Thread</th><th>Length</th></tr></thead>
            <tbody><tr><td><a href="https://www.mcmaster.com/mock-mcmaster-detail">91251A542</a></td><td>Alloy Steel</td><td>1/4-20</td><td>2 in.</td></tr></tbody>
          </table>
        </main></body></html>` });
      return;
    }
    if (path === "/mock-mcmaster-detail") {
      await route.fulfill({ contentType: "text/html", body: `
        <html><body><main>
          <nav aria-label="breadcrumb"><ul>
            <li><a>Hardware</a></li><li><a>Hardware</a></li>
            <li><a>Screws and Bolts</a></li><li><span aria-current="page">91251A542</span></li>
          </ul></nav>
          <h1>18-8 Stainless Steel Screw 91251A542, 1/4-20 Thread Size, 2 in. Long | McMaster-Carr</h1>
          <p>General purpose screw.</p>
          <img src="/mvD/gfx/IndustrialInfo/industrial-information-icon.svg?ver=ImageNotFound" alt="Industrial information">
          <img src="/mvD/Contents/gfx/ImageCache/912/91251A542.png?ver=ImageNotFound" alt="Image of product">
          <table>
            <tr><th>For Screw Size</th><td>1/4 in.</td></tr>
            <tr><th>Material</th><td>Steel</td></tr>
            <tr><th>Thread Size</th><td>1/4-20</td></tr>
            <tr><th>Length</th><td>2 in.</td></tr>
          </table>
        </main></body></html>` });
      return;
    }
    await route.fulfill({ contentType: "text/html", body: `
      <html><body><h1>McMaster-Carr</h1><iframe src="/mock-category-frame"></iframe></body></html>` });
  });

  const popup = await openPopup();
  await popup.selectOption("#sourceMode", "auto");
  const previousCapturedAt = await popup.evaluate(() =>
    chrome.storage.local.get("lastCapture").then((data) => data.lastCapture?.capturedAt || "")
  );
  const supplier = await context.newPage();
  await supplier.goto("https://www.mcmaster.com/products/socket-head-screws");
  await supplier.bringToFront();
  await popup.evaluate(() => document.querySelector("#captureBtn").click());
  await expect.poll(async () => {
    return await popup.evaluate(() => {
      return chrome.storage.local.get(["captureProgress", "lastCapture"]).then((data) => {
        const progress = data.captureProgress;
        const capture = data.lastCapture;
        return {
          status: progress?.status || "",
          hasCapture: Boolean(capture?.rows?.length),
          capturedAt: String(capture?.capturedAt || ""),
        };
      });
    });
  }, { timeout: 60000 }).toMatchObject({
    status: "complete",
    hasCapture: true,
  });
  const capture = await popup.evaluate(() => chrome.storage.local.get("lastCapture").then((data) => data.lastCapture));
  expect(String(capture.capturedAt || "")).not.toBe(previousCapturedAt);
  const progress = await popup.evaluate(() => chrome.storage.local.get("captureProgress").then((data) => data.captureProgress));
  expect(progress?.status).not.toBe("failed");
  expect(capture.pageType).toBe("category-table");
  expect(capture.pagesScraped).toBe(2);
  const threadSize = String(
    capture.rows[0].ProductDetailThreadSize
    || capture.rows[0].Spec_Thread_Size
    || capture.rows[0].Thread
    || ""
  );
  expect(threadSize).toContain("1/4-20");
  expect(capture.rows[0].ProductListBreadcrumbs).toContain("Hardware");
  expect(progress.status).toBe("complete");
  expect(progress.completed).toBe(1);
  expect(progress.total).toBe(1);
  await supplier.close();
  await popup.close();
  await context.unroute("https://www.mcmaster.com/**");
});

test("captures a McMaster single-item page directly", async () => {
  await context.route("https://www.mcmaster.com/**", (route) => route.fulfill({ contentType: "text/html", body: `
    <html><body><main>
      <nav aria-label="breadcrumb"><ul>
        <li><a>Hardware</a></li><li><a>Hardware</a></li>
        <li><a>Screws and Bolts</a></li><li><span aria-current="page">90126A029</span></li>
      </ul></nav>
      <h1>18-8 Stainless Steel Screw 90126A029, M2 x 0.4 mm Thread Size, 4 mm Long | McMaster-Carr</h1><p>General purpose screw.</p>
      <img src="/mvD/gfx/IndustrialInfo/industrial-information-icon.svg?ver=ImageNotFound" alt="Industrial information">
      <img src="/mvD/Contents/gfx/ImageCache/901/90126A029.png?ver=ImageNotFound" alt="Image of product">
      <table>
        <tr><th>For Screw Size</th><td>1/4 in.</td></tr><tr><th>Material</th><td>Steel</td></tr>
        <tr><th>Countersink Angle</th><td>90Â°</td></tr>
        <tr><th>U.S.â€“Mexicoâ€“Canada Agreement</th><td>Yes</td></tr>
      </table>
    </main></body></html>` }));
  const popup = await openPopup();
  await popup.selectOption("#sourceMode", "auto");
  const supplier = await context.newPage();
  await supplier.goto("https://www.mcmaster.com/90126A029");
  await supplier.bringToFront();
  await popup.evaluate(() => document.querySelector("#captureBtn").click());
  await expect(popup.locator("#status")).toContainText("Captured 1 row(s)");
  const capture = await popup.evaluate(() => chrome.storage.local.get("lastCapture").then((data) => data.lastCapture));
  expect(capture.pageType).toBe("product-detail");
  expect(capture.pagesScraped).toBe(1);
  expect(capture.rows[0].McMasterPartNumber).toBe("90126A029");
  expect(capture.rows[0].ProductDetailSpecs).toContain("Material: Steel");
  expect(capture.rows[0].ProductDetailThreadSize).toBe("M2 x 0.4 mm");
  expect(capture.rows[0].ProductDetailLength).toBe("4 mm");
  expect(capture.rows[0].ProductDetailBreadcrumbs).toBe("Hardware > Screws and Bolts > 90126A029");
  expect(capture.rows[0].Spec_Countersink_Angle).toBe("90°");
  expect(capture.rows[0].Spec_U_S_Mexico_Canada_Agreement).toBe("Yes");
  expect(capture.rows[0].RowImageURL).toContain("/ImageCache/901/90126A029.png");
  expect(capture.rows[0].RowImageURL).not.toContain("ImageNotFound");
  await supplier.close();
  await popup.close();
  await context.unroute("https://www.mcmaster.com/**");
});
