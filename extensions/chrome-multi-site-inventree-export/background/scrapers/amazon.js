// Injected into the active Amazon tab to collect order item links.
export function scrapeAmazonOrderItems() {
  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  const items = [];
  const seen = new Set();

  for (const link of Array.from(document.querySelectorAll("a[href]"))) {
    const href = link.getAttribute("href") || "";

    let parsed;
    try {
      parsed = new URL(href, location.href);
    } catch {
      continue;
    }

    if (!parsed.hostname.includes("amazon.")) continue;

    // Require a recognisable Amazon product path.
    const asinMatch = parsed.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    if (!asinMatch) continue;

    const asin = asinMatch[1].toUpperCase();
    if (seen.has(asin)) continue;
    seen.add(asin);

    // Canonical product URL – strip query / hash.
    const productUrl = `${parsed.origin}/dp/${asin}`;

    // Best available display label.
    let label = normalizeText(link.textContent);
    if (!label || label.length < 5) {
      label = normalizeText(link.getAttribute("title") || "");
    }
    if (!label || label.length < 5) {
      const container = link.closest(
        "[data-asin], .a-fixed-right-grid, .item-container, .shipment-container, li"
      );
      if (container) {
        const titleEl = container.querySelector(
          ".a-link-normal[title], .a-text-bold, .product-title"
        );
        label = normalizeText(
          titleEl?.getAttribute("title") || titleEl?.textContent || ""
        );
      }
    }
    if (!label || label.length < 3) {
      label = `ASIN: ${asin}`;
    }

    // Optional thumbnail.
    let imageUrl = "";
    const container =
      link.closest("[data-asin], .a-fixed-right-grid, .item-container, li") ||
      link.parentElement;
    if (container) {
      const img = container.querySelector("img[src]");
      const src = img?.getAttribute("src") || "";
      if (src && !src.includes("transparent-pixel") && !src.startsWith("data:")) {
        imageUrl = src;
      }
    }

    items.push({ url: productUrl, label, asin, imageUrl });
  }

  return {
    ok: items.length > 0,
    items,
    pageType: /\/orders?/i.test(location.pathname) ? "order-items" : "order-items",
    pageTitle: normalizeText(
      document.querySelector("h1")?.textContent || document.title || "Amazon Orders"
    ),
    error:
      items.length === 0
        ? "No Amazon product links found. Navigate to an order history or order details page."
        : undefined
  };
}

// Injected into an individual Amazon product page to extract spec data.
export function scrapeAmazonProductPage() {
  function normalizeText(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function firstText(selectors) {
    for (const selector of selectors) {
      const value = normalizeText(document.querySelector(selector)?.textContent || "");
      if (value) return value;
    }
    return "";
  }

  function absoluteHttpUrl(value) {
    const raw = String(value || "").trim();
    if (!raw || raw.startsWith("data:")) return "";
    try {
      const parsed = new URL(raw, location.href);
      return /^https?:$/i.test(parsed.protocol) ? parsed.href : "";
    } catch {
      return "";
    }
  }

  function addImage(value, output, seen) {
    const url = absoluteHttpUrl(value);
    if (
      !url ||
      seen.has(url) ||
      /transparent-pixel|grey-pixel|sprite|loading/i.test(url)
    ) return;
    seen.add(url);
    output.push(url);
  }

  function addSpec(target, rawKey, rawValue) {
    const key = normalizeText(rawKey).replace(/[\s:]+$/, "");
    const value = normalizeText(rawValue);
    if (!key || !value || key.length > 120 || key === value) return;
    if (!target[key]) target[key] = value;
  }

  function specValue(specs, labels) {
    const entries = Object.entries(specs);
    for (const label of labels) {
      const wanted = label.toLowerCase();
      const match = entries.find(
        ([key]) => normalizeText(key).toLowerCase() === wanted
      );
      if (match) return match[1];
    }
    return "";
  }

  function parseJsonLd() {
    const products = [];
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const parsed = JSON.parse(script.textContent || "null");
        const pending = Array.isArray(parsed) ? [...parsed] : [parsed];
        while (pending.length) {
          const value = pending.shift();
          if (!value || typeof value !== "object") continue;
          if (Array.isArray(value)) {
            pending.push(...value);
            continue;
          }
          const type = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
          if (type.some((item) => String(item).toLowerCase() === "product")) products.push(value);
          if (Array.isArray(value["@graph"])) pending.push(...value["@graph"]);
        }
      } catch {
        // Ignore malformed structured data and continue with the visible page.
      }
    }
    return products[0] || {};
  }

  const structured = parseJsonLd();
  const canonicalAsinMatch = (
    location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i) ||
    String(document.querySelector("input#ASIN")?.value || "").match(/([A-Z0-9]{10})/i) ||
    String(structured.sku || "").match(/^([A-Z0-9]{10})$/i)
  );
  const asin = canonicalAsinMatch ? canonicalAsinMatch[1].toUpperCase() : "";

  const titleEl =
    document.getElementById("productTitle") ||
    document.querySelector("span#productTitle") ||
    document.querySelector("h1.a-size-large") ||
    document.querySelector("h1");
  const title = normalizeText(
    titleEl?.textContent ||
    structured.name ||
    document.querySelector('meta[property="og:title"]')?.content ||
    document.title ||
    ""
  );

  const brandEl =
    document.getElementById("bylineInfo") ||
    document.querySelector("#brand") ||
    document.querySelector("a#bylineInfo_feature_div a");
  const visibleBrand = normalizeText(
    (brandEl?.textContent || "")
      .replace(/^Visit the\s+/i, "")
      .replace(/\s+Store$/i, "")
  );
  const structuredBrand = typeof structured.brand === "object"
    ? structured.brand?.name
    : structured.brand;

  // Capture the complete product gallery, preferring original/high-resolution URLs.
  const imageUrls = [];
  const seenImages = new Set();
  const landingImg =
    document.getElementById("landingImage") ||
    document.getElementById("imgBlkFront") ||
    document.querySelector("#main-image-container img");
  const imageElements = [
    ...(landingImg ? [landingImg] : []),
    ...document.querySelectorAll(
      "#altImages img, #imageBlock img, #main-image-container img, " +
      "#aplus img, #aplus_feature_div img"
    )
  ];
  for (const image of imageElements) {
    const dynamicData = image.getAttribute("data-a-dynamic-image");
    if (dynamicData) {
      try {
        const imgMap = JSON.parse(dynamicData);
        Object.entries(imgMap)
          .sort((left, right) => {
            const area = (entry) => Array.isArray(entry[1])
              ? Number(entry[1][0] || 0) * Number(entry[1][1] || 0)
              : 0;
            return area(right) - area(left);
          })
          .forEach(([url]) => addImage(url, imageUrls, seenImages));
      } catch {
        // Continue with the normal image attributes.
      }
    }
    addImage(image.getAttribute("data-old-hires"), imageUrls, seenImages);
    addImage(image.getAttribute("data-a-hires"), imageUrls, seenImages);
    addImage(image.currentSrc, imageUrls, seenImages);
    addImage(image.getAttribute("src"), imageUrls, seenImages);
  }
  const structuredImages = Array.isArray(structured.image) ? structured.image : [structured.image];
  for (const image of structuredImages) {
    addImage(typeof image === "object" ? image?.url : image, imageUrls, seenImages);
  }
  addImage(document.querySelector('meta[property="og:image"]')?.content, imageUrls, seenImages);
  const imageUrl = imageUrls[0] || "";

  const priceEl =
    document.querySelector(".a-price .a-offscreen") ||
    document.querySelector(".apexPriceToPay .a-offscreen") ||
    document.querySelector("#priceblock_ourprice") ||
    document.querySelector("#priceblock_dealprice") ||
    document.querySelector(".a-price");
  const offer = Array.isArray(structured.offers) ? structured.offers[0] : (structured.offers || {});
  const price = normalizeText(
    priceEl?.textContent ||
    offer.price ||
    document.querySelector('meta[property="product:price:amount"]')?.content ||
    ""
  );
  const priceCurrency = normalizeText(
    offer.priceCurrency ||
    document.querySelector('meta[property="product:price:currency"]')?.content ||
    ""
  );

  const specsObj = {};
  const specRows = Array.from(
    document.querySelectorAll(
      "#productDetails_techSpec_section_1 tr, " +
        "#productDetails_techSpec_section_2 tr, " +
        "#productDetails_detailBullets_sections1 tr, " +
        "#productDetails_db_sections tr, " +
        "#prodDetails tr, " +
        "#tech-specs-table tr, " +
        ".product-specs-table tr, " +
        "[id^='productDetails'] tr"
    )
  );
  for (const row of specRows) {
    const th = normalizeText(row.querySelector("th")?.textContent || "");
    const td = normalizeText(row.querySelector("td")?.textContent || "");
    addSpec(specsObj, th, td);
  }

  const bulletItems = Array.from(
    document.querySelectorAll(
      "#detailBullets_feature_div .a-list-item, " +
        "#detail-bullets .a-list-item, " +
        ".detail-bullet-list .a-list-item"
    )
  );
  for (const item of bulletItems) {
    const spans = item.querySelectorAll("span");
    if (spans.length >= 2) {
      addSpec(specsObj, spans[0].textContent, spans[spans.length - 1].textContent);
    } else {
      const text = normalizeText(item.textContent);
      const colonIdx = text.indexOf(":");
      if (colonIdx > 0 && colonIdx < 80) {
        addSpec(specsObj, text.slice(0, colonIdx), text.slice(colonIdx + 1));
      }
    }
  }

  const featureBullets = Array.from(
    document.querySelectorAll(
      "#feature-bullets ul li span.a-list-item, " +
        "#feature-bullets .a-unordered-list li span, " +
        "#featurebullets_feature_div li span.a-list-item"
    )
  )
    .map((el) => normalizeText(el.textContent))
    .filter((text, index, values) => text && text.length > 10 && values.indexOf(text) === index)
    .slice(0, 10);

  const description =
    normalizeText(
      document.querySelector("#productDescription p, #productDescription")?.textContent || ""
    ) ||
    normalizeText(structured.description || "") ||
    featureBullets.join("; ");

  const aboutItem = featureBullets.join("\n");
  const modelNumber = specValue(specsObj, [
    "Item model number", "Model Number", "Model", "Part Number"
  ]) || normalizeText(structured.model || "");
  const manufacturerPartNumber = specValue(specsObj, [
    "Part Number", "Manufacturer Part Number", "Manufacturer reference"
  ]) || normalizeText(structured.mpn || modelNumber);
  const manufacturer = specValue(specsObj, ["Manufacturer"]) || normalizeText(
    typeof structured.manufacturer === "object"
      ? structured.manufacturer?.name
      : structured.manufacturer
  );
  const brand = visibleBrand || normalizeText(structuredBrand || manufacturer);
  const upc = specValue(specsObj, ["UPC"]) || normalizeText(structured.gtin12 || "");
  const ean = specValue(specsObj, ["EAN"]) || normalizeText(structured.gtin13 || "");

  const breadcrumbs = Array.from(
    document.querySelectorAll(
      "#wayfinding-breadcrumbs_feature_div a, .a-breadcrumb a"
    )
  )
    .map((el) => normalizeText(el.textContent))
    .filter((text, index, values) => text && values.indexOf(text) === index);
  const category = breadcrumbs.join(" > ");

  const selectedVariations = [];
  for (const container of document.querySelectorAll(
    "#twister .a-row, #twister_feature_div .a-row, [id^='variation_']"
  )) {
    const label = normalizeText(
      container.querySelector(".a-form-label, label")?.textContent || ""
    ).replace(/:\s*$/, "");
    const value = normalizeText(
      container.querySelector(".selection, .a-dropdown-prompt, .swatchSelect")?.textContent ||
      container.querySelector("[aria-checked='true']")?.getAttribute("title") ||
      container.querySelector(".selected")?.getAttribute("title") ||
      ""
    ).replace(/^Click to select\s*/i, "");
    if (label && value) selectedVariations.push(`${label}: ${value}`);
  }

  const availability = firstText([
    "#availability span", "#outOfStock", "#availabilityInsideBuyBox_feature_div"
  ]) || normalizeText(offer.availability || "").replace(/^https?:\/\/schema\.org\//i, "");
  const seller = firstText([
    "#sellerProfileTriggerId", "#merchant-info a", "#merchantInfoFeature_feature_div a"
  ]) || normalizeText(typeof offer.seller === "object" ? offer.seller?.name : offer.seller);
  const shipsFrom = firstText([
    "#fulfillerInfoFeature_feature_div .offer-display-feature-text-message",
    "#tabular-buybox-truncate-0 .tabular-buybox-text"
  ]);
  const condition = firstText([
    "#newAccordionRow .header-price", "#usedAccordionRow .header-price", "#condition"
  ]) || normalizeText(offer.itemCondition || "").replace(/^https?:\/\/schema\.org\//i, "");
  const canonicalUrl = asin ? `${location.origin}/dp/${asin}` : (
    document.querySelector('link[rel="canonical"]')?.href || location.href
  );

  const specLines = Object.entries(specsObj).map(([key, value]) => `${key}: ${value}`);
  const row = {
    ...specsObj,
    "Product Name": title,
    "Brand": brand,
    "Manufacturer": manufacturer,
    "ASIN": asin,
    "Supplier SKU": asin,
    "Model Number": modelNumber,
    "Manufacturer Part Number": manufacturerPartNumber,
    "UPC": upc,
    "EAN": ean,
    "Category": category,
    "Description": description,
    "About This Item": aboutItem,
    "Selected Variations": selectedVariations.join("\n"),
    "Price": price,
    "Price Currency": priceCurrency,
    "Availability": availability,
    "Condition": condition,
    "Sold By": seller,
    "Ships From": shipsFrom,
    "Product URL": canonicalUrl,
    "Source Page URL": location.href,
    "Image URL": imageUrl,
    "Image URLs": imageUrls.join("\n"),
    "Image Count": imageUrls.length,
    "Product Detail Specs": specLines.join("\n")
  };

  return {
    ok: Boolean(title && (asin || modelNumber || imageUrl)),
    title,
    pageTitle: title,
    pageBreadcrumbs: category,
    asin,
    headers: Object.keys(row),
    row,
    imageUrl,
    imageUrls,
    productUrl: canonicalUrl,
    error: title
      ? "Product title was found, but no ASIN, model number, or product image could be extracted."
      : "Could not extract product title from this Amazon product page."
  };
}

// ─────────────────────────────────────────────────────────────────────────────

