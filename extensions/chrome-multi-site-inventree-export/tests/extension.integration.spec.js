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

test("imports an independently collected JSON dataset with provenance and category fallbacks", async () => {
  const page = await openPopup();
  await page.locator("#datasetImportPanel").evaluate((node) => { node.open = true; });
  await page.locator("#datasetFile").setInputFiles({
    name: "supplier-catalog.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({
      contract_version: "1.0",
      source: "embedded-source",
      payload: {
        contract_version: "1.0",
        capture_profile: "catalog-research",
        source: "embedded-source",
        page_type: "product-variation-table",
        page_title: "Embedded title",
        page_url: "https://embedded.example/catalog",
        headers: ["Part Number", "Product Name", "Category", "Image URLs"],
        rows: [
          {
            "Part Number": "INS-1",
            "Product Name": "Insert One",
            "Category": "",
            "Image URLs": "https://images.example/front.jpg\nhttps://images.example/side.jpg"
          },
          {
            "Part Number": "INS-2",
            "Product Name": "Insert Two",
            "Category": "Existing Category"
          }
        ]
      }
    }))
  });
  await page.fill("#datasetSource", "Ruthex Research");
  await page.fill("#datasetSourceUrl", "https://www.ruthex.de/collections/gewindeeinsatze");
  await page.fill("#datasetTitle", "Ruthex insert catalog");
  await page.fill("#datasetCategory", "Fasteners");
  await page.fill("#datasetSubcategory", "Threaded Inserts");
  await page.click("#importDatasetBtn");
  await expect(page.locator("#status")).toContainText("Loaded 2 dataset row(s)");

  const capture = await page.evaluate(() =>
    chrome.storage.local.get("lastCapture").then((data) => data.lastCapture)
  );
  expect(capture.source).toBe("ruthex-research");
  expect(capture.captureProfile).toBe("catalog-research");
  expect(capture.pageType).toBe("product-variation-table");
  expect(capture.pageTitle).toBe("Ruthex insert catalog");
  expect(capture.pageUrl).toBe("https://www.ruthex.de/collections/gewindeeinsatze");
  expect(capture.rows[0].Category).toBe("Fasteners");
  expect(capture.rows[0].Subcategory).toBe("Threaded Inserts");
  expect(capture.rows[1].Category).toBe("Existing Category");
  expect(capture.headers).toContain("Subcategory");
  await page.close();
});

test("imports quoted multiline CSV and warns when provenance URL is omitted", async () => {
  const page = await openPopup();
  await page.locator("#datasetImportPanel").evaluate((node) => { node.open = true; });
  await page.locator("#datasetFile").setInputFiles({
    name: "inserts.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      '\uFEFFPart Number,Product Name,Description,Image URLs\r\n' +
      'CSV-1,"Insert, Brass","Line one\r\nLine two","https://images.example/front.jpg\r\nhttps://images.example/side.jpg"\r\n'
    )
  });
  await page.fill("#datasetSource", "offline-measurements");
  await page.fill("#datasetCategory", "Fasteners");
  await page.click("#importDatasetBtn");
  await expect(page.locator("#status")).toContainText("Loaded 1 dataset row(s)");
  await expect(page.locator("#status")).toContainText("No source URL was supplied");

  const capture = await page.evaluate(() =>
    chrome.storage.local.get("lastCapture").then((data) => data.lastCapture)
  );
  expect(capture.source).toBe("offline-measurements");
  expect(capture.captureProfile).toBe("dataset-import");
  expect(capture.pageType).toBe("imported-table");
  expect(capture.rows[0]["Product Name"]).toBe("Insert, Brass");
  expect(capture.rows[0].Description).toBe("Line one\r\nLine two");
  expect(capture.rows[0]["Image URLs"]).toContain("side.jpg");
  expect(capture.rows[0].Category).toBe("Fasteners");
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

test("captures inventory fields and the image gallery from an Amazon product page", async () => {
  await context.route("https://www.amazon.com/**", (route) => route.fulfill({
    contentType: "text/html",
    body: `
      <html><head>
        <title>Example Cordless Tool</title>
        <link rel="canonical" href="https://www.amazon.com/dp/B0FJLZ9L9P">
        <script type="application/ld+json">
          {
            "@type": "Product",
            "name": "Example Cordless Tool",
            "sku": "B0FJLZ9L9P",
            "mpn": "TOOL-20V",
            "brand": {"@type": "Brand", "name": "Example Tools"},
            "manufacturer": {"@type": "Organization", "name": "Example Manufacturing"},
            "gtin12": "012345678905",
            "description": "A compact cordless tool.",
            "image": ["https://images.example.test/tool-main.jpg"],
            "offers": {
              "@type": "Offer",
              "price": "79.99",
              "priceCurrency": "USD",
              "availability": "https://schema.org/InStock",
              "seller": {"@type": "Organization", "name": "Example Seller"}
            }
          }
        </script>
      </head><body>
        <nav id="wayfinding-breadcrumbs_feature_div">
          <a>Tools &amp; Home Improvement</a><a>Power Tools</a>
        </nav>
        <h1><span id="productTitle">Example Cordless Tool Kit</span></h1>
        <a id="bylineInfo">Visit the Example Tools Store</a>
        <div id="variation_size_name" class="a-row">
          <span class="a-form-label">Size:</span><span class="selection">20V Kit</span>
        </div>
        <div id="feature-bullets"><ul>
          <li><span class="a-list-item">Brushless motor for efficient operation and long service life.</span></li>
          <li><span class="a-list-item">Includes battery, charger, belt hook, and carrying case.</span></li>
        </ul></div>
        <div id="productDescription"><p>Product-page description.</p></div>
        <div id="availability"><span>In Stock</span></div>
        <a id="sellerProfileTriggerId">Example Seller</a>
        <div id="fulfillerInfoFeature_feature_div">
          <span class="offer-display-feature-text-message">Amazon.com</span>
        </div>
        <span class="a-price"><span class="a-offscreen">$79.99</span></span>
        <div id="main-image-container">
          <img id="landingImage"
            data-old-hires="https://images.example.test/tool-main.jpg"
            data-a-dynamic-image='{"https://images.example.test/tool-main-large.jpg":[1600,1600]}'
            src="https://images.example.test/tool-main-small.jpg">
        </div>
        <div id="altImages">
          <img data-old-hires="https://images.example.test/tool-side.jpg"
            src="https://images.example.test/tool-side-thumb.jpg">
        </div>
        <table id="productDetails_techSpec_section_1">
          <tr><th>Part Number</th><td>TOOL-20V</td></tr>
          <tr><th>Item model number</th><td>XT-200</td></tr>
          <tr><th>Manufacturer</th><td>Example Manufacturing</td></tr>
          <tr><th>Item Weight</th><td>4.2 pounds</td></tr>
          <tr><th>Product Dimensions</th><td>12 x 8 x 4 inches</td></tr>
        </table>
      </body></html>`
  }));

  const popup = await openPopup();
  await popup.selectOption("#sourceMode", "auto");
  await popup.selectOption("#captureProfile", "single-item");
  const supplier = await context.newPage();
  await supplier.goto("https://www.amazon.com/dp/B0FJLZ9L9P?ref=order&th=1");
  await supplier.bringToFront();
  await popup.evaluate(() => document.querySelector("#captureBtn").click());
  await expect(popup.locator("#status")).toContainText("Captured 1 row(s)");

  const capture = await popup.evaluate(() =>
    chrome.storage.local.get("lastCapture").then((data) => data.lastCapture)
  );
  expect(capture.source).toBe("amazon");
  expect(capture.pageType).toBe("product-detail");
  expect(capture.rows).toHaveLength(1);
  expect(capture.rows[0]["Product Name"]).toBe("Example Cordless Tool Kit");
  expect(capture.rows[0].ASIN).toBe("B0FJLZ9L9P");
  expect(capture.rows[0]["Supplier SKU"]).toBe("B0FJLZ9L9P");
  expect(capture.rows[0]["Manufacturer Part Number"]).toBe("TOOL-20V");
  expect(capture.rows[0]["Model Number"]).toBe("XT-200");
  expect(capture.rows[0].UPC).toBe("012345678905");
  expect(capture.rows[0].Category).toBe("Tools & Home Improvement > Power Tools");
  expect(capture.rows[0]["Selected Variations"]).toBe("Size: 20V Kit");
  expect(capture.rows[0].Availability).toBe("In Stock");
  expect(capture.rows[0]["Sold By"]).toBe("Example Seller");
  expect(capture.rows[0]["Ships From"]).toBe("Amazon.com");
  expect(capture.rows[0]["About This Item"]).toContain("Brushless motor");
  expect(capture.rows[0]["Product Detail Specs"]).toContain("Item Weight: 4.2 pounds");
  expect(capture.rows[0]["Product URL"]).toBe("https://www.amazon.com/dp/B0FJLZ9L9P");
  expect(capture.rows[0]["Image URL"]).toBe("https://images.example.test/tool-main-large.jpg");
  expect(capture.rows[0]["Image URLs"]).toContain("https://images.example.test/tool-side.jpg");
  expect(capture.rows[0]["Image Count"]).toBeGreaterThanOrEqual(2);

  const amazonTabId = await popup.evaluate(() =>
    chrome.tabs.query({}).then((tabs) =>
      tabs.find((tab) => tab.url?.includes("/dp/B0FJLZ9L9P"))?.id
    )
  );
  const decoy = await context.newPage();
  await decoy.goto("https://example.com/");
  await decoy.bringToFront();
  const targetedResponse = await popup.evaluate((targetTabId) =>
    chrome.runtime.sendMessage({
      type: "capturePage",
      settings: { sourceMode: "auto", captureProfile: "single-item" },
      targetTabId
    }), amazonTabId
  );
  expect(targetedResponse.ok).toBe(true);
  expect(targetedResponse.capture.source).toBe("amazon");
  expect(targetedResponse.capture.rows[0].ASIN).toBe("B0FJLZ9L9P");

  await decoy.close();
  await supplier.close();
  await popup.close();
  await context.unroute("https://www.amazon.com/**");
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
