    // Capture workspace UI logic. Reads capture/field data from the DOM (body dataset
// attributes and json_script elements rendered by capture_workspace.html).
(() => {
      const body = document.body;
      const captureId = body.dataset.captureId;
      const source = body.dataset.source;
      const captureProfile = body.dataset.captureProfile;
      const pageType = body.dataset.pageType;
      const rowCount = Number(body.dataset.rowCount || 0);
      let currentCapturePinned = body.dataset.pinned === "true";
      const fields = JSON.parse(document.getElementById("source-fields-data").textContent);
      const samples = JSON.parse(document.getElementById("source-samples-data").textContent);
      const csrfToken = document.querySelector("[name=csrfmiddlewaretoken]")?.value || "";
      const basePath = "/plugin/multi-site-importer/";
      const standardTargets = [
        ["part.ipn", "Part · IPN"], ["part.name", "Part · Name"],
        ["part.description", "Part · Description"], ["part.category", "Part · Category"],
        ["part.subcategory", "Part · Subcategory"], ["part.notes", "Part · Notes"],
        ["part.image_url", "Part · Primary Image URL"], ["part.image_urls", "Part · Image Gallery"],
        ["supplier.company", "Supplier · Company"], ["supplier.sku", "Supplier · SKU"],
        ["supplier.description", "Supplier · Description"], ["supplier.link", "Supplier · Product URL"],
        ["supplier.packaging", "Supplier · Packaging"], ["supplier.pack_quantity", "Supplier · Pack Quantity"],
        ["supplier.notes", "Supplier · Notes"], ["supplier.active", "Supplier · Active"],
        ["supplier.primary", "Supplier · Primary"],
        ["supplier.price", "Supplier · Unit Price"], ["supplier.price_quantity", "Supplier · Price-Break Quantity"],
        ["supplier.price_currency", "Supplier · Price Currency"],
        ["manufacturer.company", "Manufacturer · Company"], ["manufacturer.mpn", "Manufacturer · MPN"],
        ["manufacturer.description", "Manufacturer · Description"], ["manufacturer.link", "Manufacturer · Product URL"],
        ["stock.quantity", "Stock · Quantity"], ["stock.location", "Stock · Location"],
        ["stock.batch", "Stock · Batch"], ["stock.serial", "Stock · Serial"],
        ["stock.status", "Stock · Status Code"], ["stock.packaging", "Stock · Packaging"],
        ["stock.purchase_price", "Stock · Unit Purchase Price"], ["stock.price_currency", "Stock · Price Currency"],
        ["stock.link", "Stock · Source URL"], ["stock.notes", "Stock · Notes"]
      ];
      const legacyTargets = {
        part_number:"part.ipn", IPN:"part.ipn", name:"part.name",
        description:"part.description", category:"part.category",
        subcategory:"part.subcategory", notes:"part.notes",
        image_url:"part.image_url", image_urls:"part.image_urls"
      };
      const suggestedProfileTemplates = {
        "mcmaster-carr|single-item|product-detail": {
          "part.ipn": {source_field:"McMasterPartNumber", regex:""},
          "part.name": {source_field:"ProductDetailPageTitle", regex:""},
          "part.description": {source_field:"Description", regex:""},
          "part.category": {source_field:"ProductDetailBreadcrumbs", regex:"^([^>]+)"},
          "part.subcategory": {source_field:"ProductDetailBreadcrumbs", regex:"^[^>]+ > (.+)$"},
          "part.notes": {source_field:"ProductDetailNotes", regex:""},
          "part.image_url": {source_field:"Image URL", regex:""},
          "part.image_urls": {source_field:"Image URLs", regex:""},
          "supplier.company": {template:"McMaster-Carr", regex:""},
          "supplier.sku": {source_field:"McMasterPartNumber", regex:""},
          "supplier.description": {source_field:"ProductDetailPageTitle", regex:""},
          "supplier.link": {source_field:"ProductURL", regex:""},
          "manufacturer.company": {template:"McMaster-Carr", regex:""},
          "manufacturer.mpn": {source_field:"McMasterPartNumber", regex:""},
          "parameter.Thread Size": {source_field:"ProductDetailThreadSize", regex:""},
          "parameter.Length": {source_field:"ProductDetailLength", regex:""},
          "parameter.Material": {source_field:"Spec_Material", regex:""},
          "parameter.Canonical Type": {source_field:"ProductDetailPageTitle", regex:""},
          "parameter.Canonical Size": {source_field:"ProductDetailVariant", regex:""},
          "parameter.Canonical Material": {source_field:"Spec_Material", regex:""},
          "parameter.Canonical Fingerprint": {template:"{ProductDetailPageTitle}|{ProductDetailVariant}|{Spec_Material}", regex:""}
        },
        "mcmaster-carr|list-details|category-table": {
          "part.ipn": {source_field:"McMasterPartNumber", regex:""},
          "part.name": {source_field:"Product", regex:""},
          "part.description": {source_field:"Description", regex:""},
          "part.category": {source_field:"ProductListBreadcrumbs", regex:"^([^>]+)"},
          "part.subcategory": {source_field:"ProductListBreadcrumbs", regex:"^[^>]+ > (.+)$"},
          "part.image_url": {source_field:"Image URL", regex:""},
          "part.image_urls": {source_field:"Image URLs", regex:""},
          "supplier.company": {template:"McMaster-Carr", regex:""},
          "supplier.sku": {source_field:"McMasterPartNumber", regex:""},
          "supplier.description": {source_field:"Product", regex:""},
          "supplier.link": {source_field:"ProductURL", regex:""},
          "manufacturer.company": {template:"McMaster-Carr", regex:""},
          "manufacturer.mpn": {source_field:"McMasterPartNumber", regex:""},
          "parameter.Thread Size": {source_field:"Thread", regex:""},
          "parameter.Length": {source_field:"Length", regex:""},
          "parameter.Material": {source_field:"Material", regex:""},
          "parameter.Canonical Type": {source_field:"Product", regex:""},
          "parameter.Canonical Size": {template:"{Thread} x {Length}", regex:""},
          "parameter.Canonical Material": {source_field:"Material", regex:""},
          "parameter.Canonical Fingerprint": {template:"{Product}|{Thread} x {Length}|{Material}", regex:""}
        },
        "boltdepot|single-item|product-detail": {
          "part.ipn": {source_field:"BoltDepotPartNumber", regex:""},
          "part.name": {source_field:"ProductDetailPageTitle", regex:""},
          "part.description": {source_field:"Description", regex:""},
          "part.category": {source_field:"ProductDetailBreadcrumbs", regex:"^([^>]+)"},
          "part.subcategory": {source_field:"ProductDetailBreadcrumbs", regex:"^[^>]+ > (.+)$"},
          "part.notes": {source_field:"ProductDetailSpecs", regex:""},
          "part.image_url": {source_field:"RowImageURL", regex:""},
          "supplier.company": {template:"Bolt Depot", regex:""},
          "supplier.sku": {source_field:"BoltDepotPartNumber", regex:""},
          "supplier.description": {source_field:"ProductDetailPageTitle", regex:""},
          "supplier.link": {source_field:"ProductURL", regex:""},
          "parameter.Canonical Type": {source_field:"ProductDetailPageTitle", regex:""},
          "parameter.Canonical Size": {template:"{Spec_Thread_Size} x {Spec_Length}", regex:""},
          "parameter.Canonical Material": {source_field:"Spec_Material", regex:""},
          "parameter.Canonical Fingerprint": {template:"{ProductDetailPageTitle}|{Spec_Thread_Size} x {Spec_Length}|{Spec_Material}", regex:""}
        },
        "boltdepot|list-details|catalog-table": {
          "part.ipn": {source_field:"BoltDepotPartNumber", regex:""},
          "part.name": {source_field:"Product", regex:""},
          "part.description": {source_field:"Description", regex:""},
          "part.category": {source_field:"ProductListBreadcrumbs", regex:"^([^>]+)"},
          "part.subcategory": {source_field:"ProductListBreadcrumbs", regex:"^[^>]+ > (.+)$"},
          "part.image_url": {source_field:"RowImageURL", regex:""},
          "supplier.company": {template:"Bolt Depot", regex:""},
          "supplier.sku": {source_field:"BoltDepotPartNumber", regex:""},
          "supplier.description": {source_field:"Product", regex:""},
          "supplier.link": {source_field:"ProductURL", regex:""},
          "parameter.Canonical Type": {source_field:"Product", regex:""},
          "parameter.Canonical Size": {template:"{Thread} x {Length}", regex:""},
          "parameter.Canonical Material": {source_field:"Material", regex:""},
          "parameter.Canonical Fingerprint": {template:"{Product}|{Thread} x {Length}|{Material}", regex:""}
        },
        "boltdepot|list-details|order-details": {
          "part.ipn": {source_field:"BoltDepotPartNumber", regex:""},
          "part.name": {source_field:"Product", regex:""},
          "part.description": {source_field:"Description", regex:""},
          "supplier.company": {template:"Bolt Depot", regex:""},
          "supplier.sku": {source_field:"BoltDepotPartNumber", regex:""},
          "supplier.description": {source_field:"Description", regex:""},
          "supplier.link": {source_field:"ProductURL", regex:""},
          "stock.quantity": {source_field:"Quantity", regex:""},
          "stock.link": {source_field:"SourcePageURL", regex:""},
          "parameter.Canonical Type": {source_field:"Product", regex:""},
          "parameter.Canonical Fingerprint": {template:"{Product}|{BoltDepotPartNumber}", regex:""}
        },
        "amazon|single-item|product-detail": {
          "part.ipn": {source_field:"Manufacturer Part Number", regex:""},
          "part.name": {source_field:"Product Name", regex:""},
          "part.description": {source_field:"Description", regex:""},
          "part.category": {source_field:"Category", regex:"^([^>]+)"},
          "part.subcategory": {source_field:"Category", regex:"^[^>]+ > (.+)$"},
          "part.notes": {source_field:"About This Item", regex:""},
          "part.image_url": {source_field:"Image URL", regex:""},
          "part.image_urls": {source_field:"Image URLs", regex:""},
          "supplier.company": {source_field:"Sold By", regex:""},
          "supplier.sku": {source_field:"ASIN", regex:""},
          "supplier.description": {source_field:"Product Name", regex:""},
          "supplier.link": {source_field:"Product URL", regex:""},
          "supplier.price": {source_field:"Price", regex:"([0-9]+(?:\\.[0-9]+)?)"},
          "supplier.price_currency": {source_field:"Price Currency", regex:""},
          "manufacturer.company": {source_field:"Manufacturer", regex:""},
          "manufacturer.mpn": {source_field:"Manufacturer Part Number", regex:""},
          "parameter.Brand": {source_field:"Brand", regex:""},
          "parameter.Model Number": {source_field:"Model Number", regex:""},
          "parameter.Canonical Type": {source_field:"Product Name", regex:""},
          "parameter.Canonical Size": {source_field:"Selected Variations", regex:""},
          "parameter.Canonical Material": {source_field:"Material", regex:""},
          "parameter.Canonical Fingerprint": {template:"{Product Name}|{Selected Variations}|{Brand}|{Manufacturer Part Number}", regex:""}
        },
        "amazon|list-details|order-items": {
          "part.ipn": {source_field:"Manufacturer Part Number", regex:""},
          "part.name": {source_field:"Product Name", regex:""},
          "part.description": {source_field:"Description", regex:""},
          "part.category": {source_field:"Category", regex:"^([^>]+)"},
          "part.subcategory": {source_field:"Category", regex:"^[^>]+ > (.+)$"},
          "part.image_url": {source_field:"Image URL", regex:""},
          "supplier.company": {source_field:"Sold By", regex:""},
          "supplier.sku": {source_field:"ASIN", regex:""},
          "supplier.description": {source_field:"Product Name", regex:""},
          "supplier.link": {source_field:"Product URL", regex:""},
          "parameter.Canonical Type": {source_field:"Product Name", regex:""},
          "parameter.Canonical Size": {source_field:"Selected Variations", regex:""},
          "parameter.Canonical Fingerprint": {template:"{Product Name}|{Selected Variations}|{Brand}|{ASIN}", regex:""}
        },
        "fastenal|single-item|product-detail": {
          "part.ipn": {source_field:"FastenalPartNumber", regex:""},
          "part.name": {source_field:"ProductDetailPageTitle", regex:""},
          "part.description": {source_field:"Description", regex:""},
          "part.category": {source_field:"ProductDetailBreadcrumbs", regex:"^([^>]+)"},
          "part.subcategory": {source_field:"ProductDetailBreadcrumbs", regex:"^[^>]+ > (.+)$"},
          "part.notes": {source_field:"ProductDetailSpecs", regex:""},
          "part.image_url": {source_field:"Image URL", regex:""},
          "part.image_urls": {source_field:"Image URLs", regex:""},
          "supplier.company": {template:"Fastenal", regex:""},
          "supplier.sku": {source_field:"FastenalPartNumber", regex:""},
          "supplier.description": {source_field:"ProductDetailPageTitle", regex:""},
          "supplier.link": {source_field:"ProductURL", regex:""},
          "manufacturer.company": {template:"Fastenal", regex:""},
          "manufacturer.mpn": {source_field:"FastenalPartNumber", regex:""},
          "parameter.Thread Size": {source_field:"Spec_Thread_Size", regex:""},
          "parameter.Length": {source_field:"Spec_Length", regex:""},
          "parameter.Material": {source_field:"Spec_Material", regex:""},
          "parameter.Canonical Type": {source_field:"ProductDetailPageTitle", regex:""},
          "parameter.Canonical Size": {template:"{Spec_Thread_Size} x {Spec_Length}", regex:""},
          "parameter.Canonical Material": {source_field:"Spec_Material", regex:""},
          "parameter.Canonical Fingerprint": {template:"{ProductDetailPageTitle}|{Spec_Thread_Size} x {Spec_Length}|{Spec_Material}", regex:""}
        },
        "fastenal|list-details|catalog-list": {
          "part.ipn": {source_field:"FastenalPartNumber", regex:""},
          "part.name": {source_field:"Product", regex:""},
          "part.description": {source_field:"Description", regex:""},
          "part.category": {source_field:"ProductListBreadcrumbs", regex:"^([^>]+)"},
          "part.subcategory": {source_field:"ProductListBreadcrumbs", regex:"^[^>]+ > (.+)$"},
          "part.image_url": {source_field:"RowImageURL", regex:""},
          "supplier.company": {template:"Fastenal", regex:""},
          "supplier.sku": {source_field:"FastenalPartNumber", regex:""},
          "supplier.description": {source_field:"Product", regex:""},
          "supplier.link": {source_field:"ProductURL", regex:""},
          "manufacturer.company": {template:"Fastenal", regex:""},
          "manufacturer.mpn": {source_field:"FastenalPartNumber", regex:""},
          "parameter.Canonical Type": {source_field:"Product", regex:""},
          "parameter.Canonical Fingerprint": {template:"{Product}|{FastenalPartNumber}", regex:""}
        }
      };

      function normalizeTemplateScopeValue(value) {
        return String(value || "").trim().toLowerCase();
      }

      function suggestedTemplateRules() {
        const src = normalizeTemplateScopeValue(source);
        const profile = normalizeTemplateScopeValue(captureProfile);
        const page = normalizeTemplateScopeValue(pageType);
        const exact = `${src}|${profile}|${page}`;
        if (suggestedProfileTemplates[exact]) return suggestedProfileTemplates[exact];
        const profileWildcard = `${src}|${profile}|*`;
        if (suggestedProfileTemplates[profileWildcard]) return suggestedProfileTemplates[profileWildcard];
        const pageWildcard = `${src}|*|${page}`;
        if (suggestedProfileTemplates[pageWildcard]) return suggestedProfileTemplates[pageWildcard];
        const sourceWildcard = `${src}|*|*`;
        return suggestedProfileTemplates[sourceWildcard] || null;
      }
      let selectedProfileId = null;
      let profiles = [];
      let lastPlan = null;
      let lastPrefetchFailures = [];
      let datasetOffset = 0;
      const datasetPageSize = 100;
      let visibleDatasetIndices = [];
      const selectedRowIndices = new Set(Array.from({length:rowCount}, (_value, index) => index));
      const selectedCleanupCaptureIds = new Set();

      const $ = (id) => document.getElementById(id);
      const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
      }[char]));

      function formatBytes(value) {
        let bytes = Number(value || 0);
        const units = ["B", "KB", "MB", "GB"];
        let unit = 0;
        while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit += 1; }
        return `${bytes.toFixed(unit ? 1 : 0)} ${units[unit]}`;
      }

      function cleanupSelectionChanged() {
        for (const id of ["clearSelectedPrefetchBtn", "deleteSelectedCapturesBtn"]) {
          if ($(id)) $(id).disabled = !selectedCleanupCaptureIds.size;
        }
      }

      async function loadCleanupCatalog() {
        if (!$("cleanupTable")) return;
        const result = await api("captures/cleanup/");
        const captures = result.captures || [];
        selectedCleanupCaptureIds.clear();
        cleanupSelectionChanged();
        $("cleanupTable").innerHTML = captures.length ? `<table><thead><tr>
          <th>Select</th><th>Capture</th><th>Source</th><th>Created</th><th>Rows</th><th>Prefetch cache</th><th>Page</th>
        </tr></thead><tbody>${captures.map((item) => `<tr>
          <td><input class="cleanup-select" type="checkbox" data-id="${item.pk}" /></td>
          <td>#${item.pk}</td><td>${escapeHtml(item.source)}</td>
          <td>${escapeHtml(new Date(item.created_at).toLocaleString())}</td>
          <td>${item.row_count}</td><td>${item.prefetch_count} files · ${formatBytes(item.prefetch_bytes)}</td>
          <td><a href="${escapeHtml(item.page_url)}" target="_blank" rel="noreferrer">${escapeHtml(item.page_title || item.page_url)}</a></td>
        </tr>`).join("")}</tbody></table>` : "<p>No captures are currently eligible for cleanup.</p>";
        for (const checkbox of document.querySelectorAll(".cleanup-select")) {
          checkbox.addEventListener("change", () => {
            const id = Number(checkbox.dataset.id);
            if (checkbox.checked) selectedCleanupCaptureIds.add(id);
            else selectedCleanupCaptureIds.delete(id);
            cleanupSelectionChanged();
          });
        }
      }

      async function runManualCleanup(action) {
        const ids = Array.from(selectedCleanupCaptureIds);
        if (!ids.length) throw new Error("Select at least one eligible capture.");
        const label = action === "delete_captures"
          ? "permanently delete the selected raw captures and cached prefetch files"
          : "delete cached prefetch files for the selected captures";
        if (!confirm(`Really ${label}? Imported inventory records and Part attachments are not affected.`)) return;
        const result = await api("captures/cleanup/", {
          method:"POST", body:JSON.stringify({capture_ids:ids, action, confirm:true})
        });
        $("cleanupResult").className = "status visible ok";
        $("cleanupResult").textContent = `${result.capture_count} captures and ${result.prefetch_count} cached files removed (${formatBytes(result.prefetch_bytes)}).` +
          (result.rejected_capture_ids.length ? ` Protected or ineligible captures skipped: ${result.rejected_capture_ids.join(", ")}.` : "");
        await loadCleanupCatalog();
      }

      function selectedRowsPayload() {
        return Array.from(selectedRowIndices).sort((left, right) => left - right);
      }

      function selectionChanged() {
        lastPlan = null;
        lastPrefetchFailures = [];
        $("createCategoriesBtn").disabled = true;
        $("createPartsBtn").disabled = true;
        $("importDetailsBtn").disabled = true;
        $("importProcurementBtn").disabled = true;
        $("createStockBtn").disabled = true;
        $("prefetchImagesBtn").disabled = true;
        $("retryFailedImagesBtn").disabled = true;
        $("excludeFailedImagesBtn").disabled = true;
        $("selectionCount").textContent = `${selectedRowIndices.size} of ${rowCount} selected`;
        $("planMeta").textContent = "Dataset selection changed. Build a new plan before creating inventory.";
      }

      async function loadDatasetPage(offset=datasetOffset) {
        datasetOffset = Math.max(0, Math.min(offset, Math.max(0, rowCount - 1)));
        const result = await api(`captures/${captureId}/rows/?offset=${datasetOffset}&limit=${datasetPageSize}`);
        const rows = result.rows || [];
        visibleDatasetIndices = rows.map((item) => item.row_index);
        const keys = Array.from(new Set(rows.flatMap((item) => Object.keys(item.values || {})))).slice(0, 8);
        $("datasetTable").innerHTML = rows.length ? `<table><thead><tr><th>Import</th><th>Row</th>${
          keys.map((key) => `<th>${escapeHtml(key)}</th>`).join("")
        }</tr></thead><tbody>${rows.map((item) => `<tr>
          <td><input class="dataset-row-checkbox" type="checkbox" data-row-index="${item.row_index}" ${selectedRowIndices.has(item.row_index) ? "checked" : ""} /></td>
          <td>#${item.row_index + 1}</td>${keys.map((key) =>
            `<td><code>${escapeHtml(typeof item.values?.[key] === "object" ? JSON.stringify(item.values[key]) : item.values?.[key] ?? "")}</code></td>`
          ).join("")}</tr>`).join("")}</tbody></table>` : "<p>No dataset rows.</p>";
        document.querySelectorAll(".dataset-row-checkbox").forEach((checkbox) => {
          checkbox.addEventListener("change", () => {
            const index = Number(checkbox.dataset.rowIndex);
            if (checkbox.checked) selectedRowIndices.add(index); else selectedRowIndices.delete(index);
            selectionChanged();
          });
        });
        const pageEnd = Math.min(rowCount, datasetOffset + rows.length);
        $("datasetPageMeta").textContent = rowCount ? `Rows ${datasetOffset + 1}–${pageEnd} of ${rowCount}` : "No rows";
        $("previousDatasetPageBtn").disabled = datasetOffset === 0;
        $("nextDatasetPageBtn").disabled = datasetOffset + datasetPageSize >= rowCount;
        $("selectionCount").textContent = `${selectedRowIndices.size} of ${rowCount} selected`;
      }

      function imagePreview(value) {
        const raw = String(value ?? "").trim();
        if (!raw) return "—";
        try {
          const url = new URL(raw);
          if (!["http:", "https:"].includes(url.protocol)) throw new Error("Unsupported protocol");
          const href = escapeHtml(url.href);
          const commonRasterImage = /\.(?:avif|bmp|gif|jpe?g|png|webp)$/i.test(url.pathname);
          if (!commonRasterImage) {
            return `<a href="${href}" target="_blank" rel="noopener noreferrer"><code>${href}</code></a>`;
          }
          return `<span class="image-preview">
            <img src="${href}" alt="Mapped part image preview" loading="lazy" decoding="async" referrerpolicy="no-referrer" />
            <a href="${href}" target="_blank" rel="noopener noreferrer" title="${href}">Open image</a>
          </span>`;
        } catch {
          return `<code>${escapeHtml(raw)}</code>`;
        }
      }

      function imageGalleryPreview(value) {
        let urls = Array.isArray(value) ? value : [];
        if (!urls.length) {
          const raw = String(value ?? "").trim();
          if (raw.startsWith("[")) {
            try {
              const parsed = JSON.parse(raw);
              if (Array.isArray(parsed)) urls = parsed;
            } catch {}
          }
          if (!urls.length && raw) urls = raw.split(/\r?\n/);
        }
        urls = [...new Set(urls.map((url) => String(url ?? "").trim()).filter(Boolean))];
        if (!urls.length) return "—";
        const visible = urls.slice(0, 8).map((url) => imagePreview(url)).join("");
        const remainder = urls.length > 8 ? `<span>+${urls.length - 8} more</span>` : "";
        return `<div class="image-gallery-preview">${visible}${remainder}<strong>${urls.length} image${urls.length === 1 ? "" : "s"}</strong></div>`;
      }

      function setStatus(message, kind="") {
        const node = $("mappingStatus");
        node.textContent = message;
        node.className = `status visible ${kind}`.trim();
      }

      async function api(path, options={}) {
        const method = String(options.method || "GET").toUpperCase();
        const response = await fetch(`${basePath}${path}`, {
          credentials: "same-origin",
          ...options,
          headers: {
            "Accept":"application/json",
            ...(options.body ? {"Content-Type":"application/json"} : {}),
            ...(method !== "GET" && method !== "HEAD" ? {"X-CSRFToken":csrfToken} : {}),
            ...(options.headers || {})
          }
        });
        const text = await response.text();
        let data = {};
        try { data = text ? JSON.parse(text) : {}; } catch { data = {detail:text}; }
        if (!response.ok) throw new Error(data.detail || JSON.stringify(data) || `HTTP ${response.status}`);
        return data;
      }

      function sourceOptions(selected="") {
        return `<option value="">— Select source field —</option>` + fields.map((field) =>
          `<option value="${escapeHtml(field)}"${field === selected ? " selected" : ""}>${escapeHtml(field)}</option>`
        ).join("");
      }

      function createRuleRow({target="", label="", sourceField="", template="", regex="", removable=false, parameter=false}={}) {
        const row = document.createElement("div");
        row.className = "rule-row";
        row.dataset.parameter = parameter ? "true" : "false";
        const mode = template ? "template" : "single";
        const targetControl = removable
          ? `<input class="rule-target" value="${escapeHtml(target)}" placeholder="${parameter ? "Parameter name" : "Target field"}" />`
          : `<input class="rule-target" value="${escapeHtml(target)}" readonly title="${escapeHtml(label)}" />`;
        row.innerHTML = `
          <label>${escapeHtml(label || (parameter ? "Parameter" : "Custom target"))}${targetControl}</label>
          <label>Mode<select class="rule-mode"><option value="single"${mode === "single" ? " selected" : ""}>Single Field</option><option value="template"${mode === "template" ? " selected" : ""}>Template</option></select></label>
          <div>
            <label class="single-control">Source<select class="rule-source">${sourceOptions(sourceField)}</select></label>
            <div class="template-control" hidden>
              <label>Template<textarea class="rule-template" placeholder="{ProductDetailPageTitle} — {ProductDetailVariant}">${escapeHtml(template)}</textarea></label>
              <div class="insert-controls">
                <select class="insert-field">${sourceOptions()}</select>
                <button type="button" class="secondary insert-field-btn">Insert</button>
              </div>
            </div>
          </div>
          <label>Regex<input class="rule-regex" value="${escapeHtml(regex)}" placeholder="Optional extraction regex" /></label>
          <output class="rule-sample"></output>
          ${removable ? '<button type="button" class="danger remove-rule">Remove</button>' : "<span></span>"}
        `;
        row.querySelector(".remove-rule")?.addEventListener("click", () => row.remove());
        row.querySelector(".rule-mode").addEventListener("change", () => {
          toggleRuleMode(row);
          updateSample(row);
        });
        row.querySelector(".insert-field-btn").addEventListener("click", () => insertTemplateField(row));
        row.querySelectorAll("input,select,textarea").forEach((node) => node.addEventListener("input", () => updateSample(row)));
        toggleRuleMode(row);
        updateSample(row);
        return row;
      }

      function toggleRuleMode(row) {
        const templateMode = row.querySelector(".rule-mode").value === "template";
        row.querySelector(".single-control").hidden = templateMode;
        row.querySelector(".template-control").hidden = !templateMode;
      }

      function insertTemplateField(row) {
        const field = row.querySelector(".insert-field").value;
        if (!field) return;
        const textarea = row.querySelector(".rule-template");
        const placeholder = `{${field}}`;
        const start = textarea.selectionStart ?? textarea.value.length;
        const end = textarea.selectionEnd ?? start;
        textarea.value = `${textarea.value.slice(0, start)}${placeholder}${textarea.value.slice(end)}`;
        textarea.focus();
        textarea.setSelectionRange(start + placeholder.length, start + placeholder.length);
        updateSample(row);
      }

      function updateSample(row) {
        const templateMode = row.querySelector(".rule-mode").value === "template";
        const sourceField = row.querySelector(".rule-source").value;
        const pattern = row.querySelector(".rule-regex").value;
        let value = templateMode
          ? row.querySelector(".rule-template").value.replace(/\{([^{}]+)\}/g, (_match, field) => String(samples[field.trim()] ?? "").trim()).trim()
          : String(samples[sourceField] ?? "");
        if (pattern && value) {
          try {
            const match = value.match(new RegExp(pattern));
            value = match ? String(match[1] ?? match[0] ?? "") : "";
          } catch {
            value = "Invalid regex";
          }
        }
        row.querySelector(".rule-sample").textContent = value || "—";
      }

      function resetRules() {
        $("standardRules").replaceChildren(...standardTargets.map(([target,label]) => createRuleRow({target,label})));
        $("parameterRules").replaceChildren();
      }

      function collectRules() {
        const rules = {};
        for (const row of document.querySelectorAll(".rule-row:not(.header)")) {
          let target = row.querySelector(".rule-target")?.value.trim();
          const templateMode = row.querySelector(".rule-mode").value === "template";
          const sourceField = row.querySelector(".rule-source")?.value.trim();
          const template = row.querySelector(".rule-template")?.value || "";
          const regex = row.querySelector(".rule-regex")?.value.trim() || "";
          if (!target || (templateMode ? !template.trim() : !sourceField)) continue;
          if (row.dataset.parameter === "true" && !target.startsWith("parameter.")) target = `parameter.${target}`;
          rules[target] = templateMode ? {template, regex} : {source_field:sourceField, regex};
        }
        return rules;
      }

      function applyRules(rules={}) {
        resetRules();
        for (const [rawTarget, rule] of Object.entries(rules || {})) {
          const target = legacyTargets[rawTarget] || rawTarget;
          const standard = Array.from($("standardRules").children).find((row) => row.querySelector(".rule-target").value === target);
          if (standard) {
            standard.querySelector(".rule-mode").value = rule.template ? "template" : "single";
            standard.querySelector(".rule-source").value = rule.source_field || rule.sourceField || "";
            standard.querySelector(".rule-template").value = rule.template || "";
            standard.querySelector(".rule-regex").value = rule.regex || "";
            toggleRuleMode(standard);
            updateSample(standard);
            continue;
          }
          const parameter = target.startsWith("parameter.");
          const displayTarget = parameter ? target.slice("parameter.".length) : target;
          $("parameterRules").append(createRuleRow({
            target:displayTarget, sourceField:rule.source_field || rule.sourceField || "",
            template:rule.template || "", regex:rule.regex || "", removable:true, parameter
          }));
        }
      }

      function applySuggestedTemplate() {
        const rules = suggestedTemplateRules();
        if (!rules) {
          throw new Error(
            `No suggested template is available for ${source} / ${captureProfile} / ${pageType}.`
          );
        }
        const hasExistingRules = Object.keys(collectRules()).length > 0;
        if (hasExistingRules && !confirm("Replace current mapping rules with the suggested template for this capture scope?")) {
          return;
        }
        applyRules(rules);
        setStatus(
          `Applied suggested template for ${source} / ${captureProfile} / ${pageType}. ` +
          "Review canonical fingerprint fields before saving.",
          "ok"
        );
      }

      function profilePayload() {
        const name = $("profileName").value.trim();
        if (!name) throw new Error("Profile name is required.");
        const rules = collectRules();
        if (!Object.keys(rules).length) throw new Error("Map at least one source field.");
        return {
          name, source, capture_profile:captureProfile, page_type:pageType,
          host_pattern:$("hostPattern").value.trim(), path_pattern:$("pathPattern").value.trim(),
          priority:Number($("profilePriority").value || 100),
          is_active:$("profileActive").value === "true", rules
        };
      }

      function renderProfiles() {
        $("profileSelect").innerHTML = '<option value="">New profile</option>' + profiles.map((profile) =>
          `<option value="${profile.pk}">${escapeHtml(profile.name)} (#${profile.pk})</option>`
        ).join("");
        if (selectedProfileId) $("profileSelect").value = String(selectedProfileId);
      }

      function loadProfile(profile) {
        selectedProfileId = profile?.pk || null;
        $("profileName").value = profile?.name || `${source} ${captureProfile} mapping`;
        $("profilePriority").value = profile?.priority ?? 100;
        $("hostPattern").value = profile?.host_pattern || "";
        $("pathPattern").value = profile?.path_pattern || "";
        $("profileActive").value = String(profile?.is_active ?? true);
        applyRules(profile?.rules || {});
        $("deleteProfileBtn").disabled = !selectedProfileId;
        renderProfiles();
        setStatus(profile ? `Loaded profile #${profile.pk}.` : "New profile ready.");
      }

      async function refreshProfiles() {
        const query = new URLSearchParams({source, capture_profile:captureProfile, page_type:pageType});
        const result = await api(`mapping-profiles/?${query}`);
        profiles = Array.isArray(result) ? result : (result.results || []);
        renderProfiles();
      }

      function renderPreview(items) {
        const container = $("previewTable");
        if (!items?.length) { container.innerHTML = "<p>No preview rows returned.</p>"; return; }
        const keys = Array.from(new Set(items.flatMap((item) => Object.keys(item))));
        container.innerHTML = `<table><thead><tr><th>Row</th>${keys.map((key) => `<th>${escapeHtml(key)}</th>`).join("")}</tr></thead>
          <tbody>${items.map((item,index) => `<tr><td>${index + 1}</td>${keys.map((key) =>
            `<td>${key === "image_url" ? imagePreview(item[key]) : key === "image_urls" ? imageGalleryPreview(item[key]) : `<code>${escapeHtml(item[key] ?? "")}</code>`}</td>`
          ).join("")}</tr>`).join("")}</tbody></table>`;
      }

      function renderPlan(plan) {
        lastPlan = plan;
        const summary = plan.summary || {};
        $("planSummary").innerHTML = [
          ["Create", summary.create || 0], ["Update", summary.update || 0],
          ["Conflict", summary.conflict || 0], ["Error", summary.error || 0],
          ["Rows with warnings", summary.warning_rows || 0]
        ].map(([label,value]) => `<span class="scope"><strong>${escapeHtml(label)}:</strong> ${value}</span>`).join("");
        $("planMeta").textContent = plan.ready
          ? `Plan is ready: ${plan.row_count} rows checked. No inventory was modified.`
          : `Plan requires attention: ${plan.row_count} rows checked. Resolve conflicts and errors before execution.`;
        const missingPaths = plan.missing_category_paths || [];
        $("createCategoriesBtn").disabled = !plan.can_create_categories;
        $("createCategoriesBtn").title = missingPaths.length
          ? missingPaths.map((item) => item.path).join("\n")
          : "No mapped category paths are missing.";
        $("createPartsBtn").disabled = !plan.ready || !(summary.create || summary.update);
        $("createPartsBtn").title = plan.ready
          ? `${summary.create || 0} new part(s) will be created; ${summary.update || 0} existing match(es) will be skipped.`
          : "Resolve every plan conflict and error before creating parts.";
        $("importDetailsBtn").disabled = !plan.ready || !!summary.create || !summary.update;
        $("importDetailsBtn").title = summary.create
          ? "Create the selected new parts first."
          : "Write mapped notes and parameters, then download primary and gallery images.";
        const procurementRows = (plan.rows || []).filter(
          (row) => row.supplier_action !== "none" || row.manufacturer_action !== "none"
        );
        $("importProcurementBtn").disabled = !plan.ready || !!summary.create || !procurementRows.length;
        const stockRows = (plan.rows || []).filter((row) => row.stock_action !== "none");
        $("createStockBtn").disabled = (
          !plan.ready || !!summary.create || !stockRows.length || !$("enableStockImport").checked
        );
        const plannedImageCount = (plan.rows || []).reduce(
          (total, row) => total + Number(row.image_count || 0), 0
        );
        $("prefetchImagesBtn").disabled = !plan.ready || !plannedImageCount;
        $("prefetchImagesBtn").title = `${plannedImageCount} mapped image URL${plannedImageCount === 1 ? "" : "s"} will be validated and cached.`;
        $("retryFailedImagesBtn").disabled = !lastPrefetchFailures.length;
        $("excludeFailedImagesBtn").disabled = (
          !lastPrefetchFailures.length || !plan.ready || !!summary.create
        );
        const rows = plan.rows || [];
        $("planTable").innerHTML = `<table><thead><tr>
          <th>Row</th><th>Action</th><th>Part Number</th><th>Name</th><th>Category</th>
          <th>Image</th><th>Parameters</th><th>Existing matches</th><th>Messages</th>
        </tr></thead><tbody>${rows.map((row) => {
          const partMatches = (row.existing_parts || []).map((item) => `Part #${item.pk}: ${item.IPN || ""} ${item.name || ""}`);
          const supplierMatches = (row.existing_supplier_parts || []).map((item) => `Supplier part #${item.pk}: ${item.SKU || ""} → Part #${item.part_id || ""}`);
          const categoryMatches = (row.category_matches || []).map((item) => `Category #${item.pk}: ${item.path || item.name || ""}`);
          const messages = [
            ...(row.errors || []).map((item) => `ERROR: ${item}`),
            ...(row.warnings || []).map((item) => `Warning: ${item}`)
          ];
          const category = [row.category, row.subcategory].filter(Boolean).join(" > ");
          return `<tr><td>${row.row_index + 1}</td><td><strong>${escapeHtml(row.action)}</strong></td>
            <td><code>${escapeHtml(row.part_number)}</code></td><td>${escapeHtml(row.name)}</td>
            <td>${escapeHtml(category)}</td><td>${imageGalleryPreview(row.image_urls || row.mapped?.image_urls || row.mapped?.image_url)}</td><td>${row.parameter_count || 0}</td>
            <td><code>${escapeHtml([...partMatches,...supplierMatches,...categoryMatches].join("\n") || "—")}</code></td>
            <td><code>${escapeHtml(messages.join("\n") || "—")}</code></td></tr>`;
        }).join("")}</tbody></table>`;
      }

      async function preview() {
        const rules = collectRules();
        if (!Object.keys(rules).length) throw new Error("Map at least one source field before previewing.");
        const result = await api(`captures/${captureId}/preview/`, {
          method:"POST", body:JSON.stringify({rules, selected_row_indices:selectedRowsPayload()})
        });
        renderPreview(result.items);
        $("previewMeta").textContent = `Showing ${result.preview_count} of ${result.row_count} captured rows. Preview only; inventory was not modified.`;
        setStatus("Mapping preview updated.", "ok");
      }

      async function buildPlan({announce=true}={}) {
        const rules = collectRules();
        if (!Object.keys(rules).length) throw new Error("Map at least one source field before building a plan.");
        if (announce) setStatus("Building read-only import plan…");
        const result = await api(`captures/${captureId}/plan/`, {
          method:"POST", body:JSON.stringify({rules, selected_row_indices:selectedRowsPayload()})
        });
        renderPlan(result);
        if (announce) {
          setStatus(result.ready ? "Import plan is ready." : "Import plan contains issues to resolve.", result.ready ? "ok" : "error");
        }
        return result;
      }

      async function createMissingCategories() {
        const missingPaths = lastPlan?.missing_category_paths || [];
        if (!missingPaths.length) throw new Error("Build a plan containing missing categories first.");
        const pathList = missingPaths.map((item) => `• ${item.path}`).join("\n");
        if (!confirm(`Create these missing InvenTree category paths?\n\n${pathList}\n\nNo parts will be created.`)) return;
        const rules = collectRules();
        const button = $("createCategoriesBtn");
        const resultNode = $("categoryCreationResult");
        button.disabled = true;
        button.textContent = "Creating Categories…";
        resultNode.className = "status visible";
        resultNode.textContent = `Creating ${missingPaths.length} mapped category path${missingPaths.length === 1 ? "" : "s"}…`;
        try {
          const result = await api(`captures/${captureId}/categories/`, {
            method:"POST",
            body:JSON.stringify({rules, selected_row_indices:selectedRowsPayload(), confirm:true})
          });
          const createdPaths = (result.created || []).map((item) => `Created: ${item.path} (#${item.pk})`);
          const reusedPaths = (result.existing || []).map((item) => `Reused: ${item.path} (#${item.pk})`);
          const rebuiltPlan = await buildPlan({announce:false});
          const unresolved = rebuiltPlan.missing_category_paths || [];
          resultNode.className = `status visible ${unresolved.length ? "error" : "ok"}`;
          resultNode.textContent = [
            `Category creation finished: ${result.created_count} created, ${result.existing_count} existing segments reused.`,
            ...createdPaths,
            ...reusedPaths,
            unresolved.length
              ? `Still unresolved: ${unresolved.map((item) => item.path).join(", ")}`
              : "Verification succeeded: all mapped category paths now exist."
          ].join("\n");
          setStatus(
            unresolved.length ? "Category creation completed, but some paths remain unresolved." : "Categories created and verified.",
            unresolved.length ? "error" : "ok"
          );
        } catch (error) {
          resultNode.className = "status visible error";
          resultNode.textContent = `Category creation failed: ${error.message}`;
          throw error;
        } finally {
          button.textContent = "Create Missing Categories";
          button.disabled = !(lastPlan?.can_create_categories);
        }
      }

      async function createParts() {
        if (!lastPlan?.ready) throw new Error("Build a ready import plan first.");
        const createCount = lastPlan.summary?.create || 0;
        const skipCount = lastPlan.summary?.update || 0;
        if (!confirm(
          `Create ${createCount} new InvenTree part${createCount === 1 ? "" : "s"}?\n\n` +
          `${skipCount} existing match${skipCount === 1 ? "" : "es"} will be skipped. ` +
          "The server will rebuild the live plan before writing. Images, parameters, supplier parts, and stock will not be created in this step."
        )) return;
        const button = $("createPartsBtn");
        const resultNode = $("partCreationResult");
        button.disabled = true;
        button.textContent = "Creating Parts…";
        resultNode.className = "status visible";
        resultNode.textContent = "Revalidating the plan and creating new parts…";
        try {
          const result = await api(`captures/${captureId}/parts/`, {
            method:"POST",
            body:JSON.stringify({
              rules:collectRules(), selected_row_indices:selectedRowsPayload(), confirm:true
            })
          });
          const created = (result.created || []).map((item) =>
            `Created Part #${item.pk}: ${item.part_number} — ${item.name}`
          );
          resultNode.className = "status visible ok";
          resultNode.textContent = [
            `Part creation finished: ${result.created_count} created, ${result.skipped_existing_count} existing skipped.`,
            ...created,
            "Images, parameters, supplier parts, and stock were not modified."
          ].join("\n");
          await buildPlan({announce:false});
          setStatus("New parts created and the import plan was refreshed.", "ok");
        } catch (error) {
          resultNode.className = "status visible error";
          resultNode.textContent = `Part creation failed: ${error.message}`;
          throw error;
        } finally {
          button.textContent = "Create New Parts";
          button.disabled = !lastPlan?.ready || !(
            (lastPlan?.summary?.create || 0) + (lastPlan?.summary?.update || 0)
          );
        }
      }

      function selectedPlanImageUrls() {
        return Array.from(new Set(
          (lastPlan?.rows || []).flatMap((row) => row.image_urls || [])
        ));
      }

      async function prefetchImages(urls=selectedPlanImageUrls()) {
        if (!lastPlan?.ready) throw new Error("Build a ready plan before prefetching images.");
        if (!urls.length) throw new Error("The selected plan contains no image URLs.");
        const rules = collectRules();
        const selectedIndices = (lastPlan.rows || []).map((row) => row.row_index);
        const batches = [];
        for (let index = 0; index < urls.length; index += 25) {
          batches.push(urls.slice(index, index + 25));
        }
        const button = $("prefetchImagesBtn");
        const resultNode = $("imagePrefetchResult");
        button.disabled = true;
        lastPrefetchFailures = [];
        resultNode.className = "status visible";
        let readyCount = 0;
        try {
          for (let index = 0; index < batches.length; index += 1) {
            button.textContent = `Prefetching ${index + 1}/${batches.length}…`;
            resultNode.textContent = `Validating and caching image batch ${index + 1} of ${batches.length}…`;
            const result = await api(`captures/${captureId}/images/prefetch/`, {
              method:"POST",
              body:JSON.stringify({
                rules,
                selected_row_indices:selectedIndices,
                image_urls:batches[index],
                confirm:true
              })
            });
            readyCount += Number(result.ready_count || 0);
            lastPrefetchFailures.push(
              ...(result.items || []).filter((item) => item.status === "failed")
            );
          }
          resultNode.className = `status visible ${lastPrefetchFailures.length ? "error" : "ok"}`;
          resultNode.textContent = [
            `${readyCount} images are validated and cached; ${lastPrefetchFailures.length} failed.`,
            ...lastPrefetchFailures.map((item) => `FAILED: ${item.error} (${item.url})`),
            lastPrefetchFailures.length
              ? "Retry the failures or explicitly exclude them to proceed."
              : "All selected images are ready for import."
          ].join("\n");
          $("retryFailedImagesBtn").disabled = !lastPrefetchFailures.length;
          $("excludeFailedImagesBtn").disabled = (
            !lastPrefetchFailures.length || !!lastPlan?.summary?.create
          );
          setStatus(
            lastPrefetchFailures.length ? "Image preflight found failures." : "Image preflight completed.",
            lastPrefetchFailures.length ? "error" : "ok"
          );
        } finally {
          button.textContent = "Validate & Prefetch Images";
          button.disabled = !lastPlan?.ready || !selectedPlanImageUrls().length;
        }
      }

      async function excludeFailedImagesAndProceed() {
        if (!lastPrefetchFailures.length) throw new Error("There are no failed images to exclude.");
        if (lastPlan?.summary?.create) throw new Error("Create the selected parts before proceeding.");
        const failedUrls = lastPrefetchFailures.map((item) => item.url);
        if (!confirm(
          `Exclude ${failedUrls.length} failed image${failedUrls.length === 1 ? "" : "s"} and continue the detail import?\n\n` +
          "The failed images will not be attached. Cached successful images will still be imported."
        )) return;
        await api(`captures/${captureId}/images/exclude-failures/`, {
          method:"POST",
          body:JSON.stringify({image_urls:failedUrls, confirm:true})
        });
        lastPrefetchFailures = [];
        $("retryFailedImagesBtn").disabled = true;
        $("excludeFailedImagesBtn").disabled = true;
        $("imagePrefetchResult").className = "status visible ok";
        $("imagePrefetchResult").textContent = `${failedUrls.length} failed images were explicitly excluded.`;
        await importPartDetails();
      }

      async function importPartDetails() {
        if (!lastPlan?.ready || lastPlan.summary?.create) {
          throw new Error("Create all selected parts and build a ready plan first.");
        }
        const partCount = lastPlan.summary?.update || 0;
        const existingPartMode = $("existingPartMode").value;
        const importRules = collectRules();
        const imageLimit = Math.max(1, Number(lastPlan.detail_import_image_limit || 100));
        const rowLimit = Math.max(1, Number(lastPlan.detail_import_row_limit || 100));
        const batches = [];
        let batch = [];
        let batchImages = 0;
        for (const row of (lastPlan.rows || [])) {
          const rowImages = Number(row.image_count || 0);
          if (rowImages > imageLimit) {
            throw new Error(
              `Row ${row.row_index + 1} contains ${rowImages} images, exceeding the per-request limit of ${imageLimit}.`
            );
          }
          if (batch.length && (batchImages + rowImages > imageLimit || batch.length >= rowLimit)) {
            batches.push(batch);
            batch = [];
            batchImages = 0;
          }
          batch.push(row.row_index);
          batchImages += rowImages;
        }
        if (batch.length) batches.push(batch);
        const modeExplanation = existingPartMode === "overwrite"
          ? "Mapped description and notes may be cleared, and a mapped primary image replaces the current primary image."
          : "Blank mapped values and an existing primary image are preserved.";
        if (!confirm(
          `Import mapped fields, notes, parameters, and images for ${partCount} part${partCount === 1 ? "" : "s"} in ${batches.length} batch${batches.length === 1 ? "" : "es"} using ${existingPartMode} mode?\n\n` +
          `${modeExplanation} Parameters with matching InvenTree templates are created or updated. ` +
          "Unrelated parameters and user-created attachments are preserved."
        )) return;
        const button = $("importDetailsBtn");
        const resultNode = $("detailImportResult");
        button.disabled = true;
        button.textContent = "Importing Details…";
        resultNode.className = "status visible";
        resultNode.textContent = `Starting ${batches.length} detail-import batch${batches.length === 1 ? "" : "es"}…`;
        try {
          const total = {
            part_count:0, part_fields_updated:0, parameters_written:0,
            primary_images_written:0, gallery_attachments_written:0,
            cached_images_used:0, excluded_image_count:0,
            image_error_count:0, image_errors:[]
          };
          for (let index = 0; index < batches.length; index += 1) {
            button.textContent = `Importing Batch ${index + 1}/${batches.length}…`;
            resultNode.textContent = `Processing batch ${index + 1} of ${batches.length}…`;
            const result = await api(`captures/${captureId}/details/`, {
              method:"POST",
              body:JSON.stringify({
                rules:importRules,
                selected_row_indices:batches[index],
                existing_part_mode:existingPartMode,
                confirm:true
              })
            });
            for (const key of [
              "part_count", "part_fields_updated", "parameters_written",
              "primary_images_written", "gallery_attachments_written",
              "cached_images_used", "excluded_image_count", "image_error_count"
            ]) total[key] += Number(result[key] || 0);
            total.image_errors.push(...(result.image_errors || []));
          }
          resultNode.className = `status visible ${total.image_error_count ? "error" : "ok"}`;
          resultNode.textContent = [
            `Completed ${batches.length} batches covering ${total.part_count} parts.`,
            `Mode: ${existingPartMode}. ${total.part_fields_updated} part fields updated; ${total.parameters_written} parameters written.`,
            `${total.primary_images_written} primary images and ${total.gallery_attachments_written} gallery attachments written.`,
            `${total.cached_images_used} cached images reused; ${total.excluded_image_count} explicitly excluded.`,
            ...(total.image_errors || []).map((item) =>
              `Row ${item.row_index + 1}: ${item.detail} (${item.url})`
            )
          ].join("\n");
          setStatus(
            total.image_error_count ? "Batched details imported with image download errors." : "Batched part details imported.",
            total.image_error_count ? "error" : "ok"
          );
        } catch (error) {
          resultNode.className = "status visible error";
          resultNode.textContent = `Detail import failed: ${error.message}`;
          throw error;
        } finally {
          button.textContent = "Import Notes, Parameters & Images";
          button.disabled = !lastPlan?.ready || !!lastPlan?.summary?.create || !lastPlan?.summary?.update;
        }
      }

      async function importProcurement() {
        if (!lastPlan?.ready || lastPlan.summary?.create) throw new Error("Create all selected Parts first.");
        if (!confirm("Create or update the mapped Supplier Parts and Manufacturer Parts? Companies must already exist in InvenTree.")) return;
        const node = $("procurementImportResult");
        node.className = "status visible";
        node.textContent = "Importing procurement records…";
        const result = await api(`captures/${captureId}/procurement/`, {
          method:"POST", body:JSON.stringify({
            rules:collectRules(), selected_row_indices:selectedRowsPayload(),
            existing_part_mode:$("existingPartMode").value, confirm:true
          })
        });
        node.className = "status visible ok";
        node.textContent = `Supplier Parts: ${result.supplier_created} created, ${result.supplier_updated} updated. Manufacturer Parts: ${result.manufacturer_created} created, ${result.manufacturer_updated} updated.`;
        await buildPlan({announce:false});
      }

      async function createStock() {
        if (!$("enableStockImport").checked) throw new Error("Enable physical stock creation first.");
        if (!confirm("Create physical Stock Items for mapped positive quantities? This is idempotent per capture row and does not update existing stock.")) return;
        const node = $("stockImportResult");
        node.className = "status visible";
        node.textContent = "Creating stock items…";
        const result = await api(`captures/${captureId}/stock/`, {
          method:"POST", body:JSON.stringify({
            rules:collectRules(), selected_row_indices:selectedRowsPayload(),
            enable_stock:true, confirm:true
          })
        });
        node.className = "status visible ok";
        node.textContent = `${result.created_count} Stock Items created; ${result.skipped_count} previously imported rows skipped.`;
      }

      async function saveProfile() {
        const payload = profilePayload();
        const path = selectedProfileId ? `mapping-profiles/${selectedProfileId}/` : "mapping-profiles/";
        const profile = await api(path, {method:selectedProfileId ? "PATCH" : "POST", body:JSON.stringify(payload)});
        selectedProfileId = profile.pk;
        await refreshProfiles();
        loadProfile(profile);
        setStatus(`Profile #${profile.pk} saved.`, "ok");
      }

      $("addParameterBtn").addEventListener("click", () => $("parameterRules").append(createRuleRow({removable:true,parameter:true})));
      $("selectAllRowsBtn").addEventListener("click", async () => {
        for (let index = 0; index < rowCount; index += 1) selectedRowIndices.add(index);
        selectionChanged();
        await loadDatasetPage();
      });
      $("deselectAllRowsBtn").addEventListener("click", async () => {
        selectedRowIndices.clear();
        selectionChanged();
        await loadDatasetPage();
      });
      $("selectPageRowsBtn").addEventListener("click", async () => {
        visibleDatasetIndices.forEach((index) => selectedRowIndices.add(index));
        selectionChanged();
        await loadDatasetPage();
      });
      $("deselectPageRowsBtn").addEventListener("click", async () => {
        visibleDatasetIndices.forEach((index) => selectedRowIndices.delete(index));
        selectionChanged();
        await loadDatasetPage();
      });
      $("previousDatasetPageBtn").addEventListener("click", () => loadDatasetPage(datasetOffset - datasetPageSize));
      $("nextDatasetPageBtn").addEventListener("click", () => loadDatasetPage(datasetOffset + datasetPageSize));
      $("addCustomBtn").addEventListener("click", () => $("parameterRules").append(createRuleRow({removable:true})));
      $("applySuggestedProfileBtn").addEventListener("click", () => {
        try {
          applySuggestedTemplate();
        } catch (error) {
          setStatus(error.message, "error");
        }
      });
      $("previewBtn").addEventListener("click", () => preview().catch((error) => setStatus(error.message, "error")));
      $("buildPlanBtn").addEventListener("click", () => buildPlan().catch((error) => setStatus(error.message, "error")));
      $("createCategoriesBtn").addEventListener("click", () => createMissingCategories().catch((error) => setStatus(error.message, "error")));
      $("createPartsBtn").addEventListener("click", () => createParts().catch((error) => setStatus(error.message, "error")));
      $("prefetchImagesBtn").addEventListener("click", () => prefetchImages().catch((error) => setStatus(error.message, "error")));
      $("retryFailedImagesBtn").addEventListener("click", () => prefetchImages(lastPrefetchFailures.map((item) => item.url)).catch((error) => setStatus(error.message, "error")));
      $("excludeFailedImagesBtn").addEventListener("click", () => excludeFailedImagesAndProceed().catch((error) => setStatus(error.message, "error")));
      $("importDetailsBtn").addEventListener("click", () => importPartDetails().catch((error) => setStatus(error.message, "error")));
      $("importProcurementBtn").addEventListener("click", () => importProcurement().catch((error) => setStatus(error.message, "error")));
      $("createStockBtn").addEventListener("click", () => createStock().catch((error) => setStatus(error.message, "error")));
      $("enableStockImport").addEventListener("change", () => {
        const rows = lastPlan?.rows || [];
        $("createStockBtn").disabled = !lastPlan?.ready || !!lastPlan?.summary?.create ||
          !rows.some((row) => row.stock_action !== "none") || !$("enableStockImport").checked;
      });
      $("refreshCleanupBtn")?.addEventListener("click", () =>
        loadCleanupCatalog().catch((error) => setStatus(error.message, "error"))
      );
      $("clearSelectedPrefetchBtn")?.addEventListener("click", () =>
        runManualCleanup("clear_prefetch").catch((error) => setStatus(error.message, "error"))
      );
      $("deleteSelectedCapturesBtn")?.addEventListener("click", () =>
        runManualCleanup("delete_captures").catch((error) => setStatus(error.message, "error"))
      );
      $("pinCurrentCaptureBtn")?.addEventListener("click", async () => {
        try {
          const result = await api(`captures/${captureId}/pin/`, {
            method:"POST", body:JSON.stringify({pinned:!currentCapturePinned})
          });
          currentCapturePinned = result.pinned;
          $("pinCurrentCaptureBtn").textContent = `${currentCapturePinned ? "Unpin" : "Pin"} Current Capture`;
          await loadCleanupCatalog();
        } catch (error) { setStatus(error.message, "error"); }
      });
      $("saveProfileBtn").addEventListener("click", () => saveProfile().catch((error) => setStatus(error.message, "error")));
      $("newProfileBtn").addEventListener("click", () => loadProfile(null));
      $("loadProfileBtn").addEventListener("click", () => {
        const profile = profiles.find((item) => String(item.pk) === $("profileSelect").value);
        if (profile) loadProfile(profile); else loadProfile(null);
      });
      $("deleteProfileBtn").addEventListener("click", async () => {
        if (!selectedProfileId || !confirm("Delete this mapping profile?")) return;
        try {
          await api(`mapping-profiles/${selectedProfileId}/`, {method:"DELETE"});
          await refreshProfiles();
          loadProfile(null);
          setStatus("Profile deleted.", "ok");
        } catch (error) { setStatus(error.message, "error"); }
      });

      resetRules();
      refreshProfiles().catch((error) => setStatus(`Could not load profiles: ${error.message}`, "error"));
      loadDatasetPage().catch((error) => setStatus(`Could not load dataset rows: ${error.message}`, "error"));
      loadCleanupCatalog().catch((error) => {
        if ($("cleanupResult")) {
          $("cleanupResult").className = "status visible error";
          $("cleanupResult").textContent = `Could not load cleanup candidates: ${error.message}`;
        }
      });
    })();
