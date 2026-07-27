const React = window.React;

function ProductImageGallery({ pluginContext }) {
  const { useCallback, useEffect, useState } = React;
  const [images, setImages] = useState([]);
  const [partName, setPartName] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);
  const galleryUrl = pluginContext.context.gallery_url;

  const loadImages = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await pluginContext.api.get(galleryUrl);
      setImages(response.data.images || []);
      setPartName(response.data.part_name || "");
    } catch (requestError) {
      setError(
        requestError?.response?.data?.detail ||
          requestError?.message ||
          "The product images could not be loaded."
      );
    } finally {
      setLoading(false);
    }
  }, [galleryUrl, pluginContext.api]);

  useEffect(() => {
    loadImages();
  }, [loadImages]);

  useEffect(() => {
    if (!selected) return undefined;
    const closeOnEscape = (event) => {
      if (event.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selected]);

  const buttonStyle = {
    border: "1px solid var(--mantine-color-default-border, #ced4da)",
    borderRadius: "var(--mantine-radius-sm, 4px)",
    background: "var(--mantine-color-body, transparent)",
    color: "var(--mantine-color-text, inherit)",
    cursor: "pointer",
    padding: "0.45rem 0.75rem",
  };

  if (loading) {
    return React.createElement(
      "div",
      { role: "status", style: { padding: "1rem" } },
      "Loading product images…"
    );
  }

  if (error) {
    return React.createElement(
      "div",
      { role: "alert", style: { padding: "1rem" } },
      React.createElement("p", null, error),
      React.createElement(
        "button",
        { type: "button", onClick: loadImages, style: buttonStyle },
        "Try again"
      )
    );
  }

  if (!images.length) {
    return React.createElement(
      "div",
      { style: { padding: "1rem" } },
      React.createElement("p", null, "No image files are attached to this part."),
      React.createElement(
        "p",
        { style: { opacity: 0.75, marginBottom: 0 } },
        "Import images or add them from the native Attachments tab."
      )
    );
  }

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem",
          marginBottom: "0.75rem",
        },
      },
      React.createElement(
        "span",
        null,
        `${images.length} image${images.length === 1 ? "" : "s"}${
          partName ? ` for ${partName}` : ""
        }`
      ),
      React.createElement(
        "button",
        { type: "button", onClick: loadImages, style: buttonStyle },
        "Reload"
      )
    ),
    React.createElement(
      "div",
      {
        style: {
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))",
          gap: "0.75rem",
        },
      },
      images.map((item) =>
        React.createElement(
          "button",
          {
            key: item.id,
            type: "button",
            onClick: () => setSelected(item),
            "aria-label": `View ${item.filename || "product image"}`,
            style: {
              position: "relative",
              minWidth: 0,
              padding: "0.5rem",
              border: "1px solid var(--mantine-color-default-border, #ced4da)",
              borderRadius: "var(--mantine-radius-md, 8px)",
              background: "var(--mantine-color-body, transparent)",
              color: "var(--mantine-color-text, inherit)",
              cursor: "zoom-in",
              textAlign: "left",
            },
          },
          React.createElement("img", {
            src: item.thumbnail_url || item.url,
            alt: item.filename || "Product image",
            loading: "lazy",
            style: {
              width: "100%",
              height: "150px",
              display: "block",
              objectFit: "contain",
              borderRadius: "var(--mantine-radius-sm, 4px)",
              background: "var(--mantine-color-gray-0, #f8f9fa)",
            },
          }),
          item.kind === "primary"
            ? React.createElement(
                "span",
                {
                  style: {
                    position: "absolute",
                    top: "0.75rem",
                    left: "0.75rem",
                    borderRadius: "999px",
                    padding: "0.15rem 0.5rem",
                    background: "var(--mantine-primary-color-filled, #228be6)",
                    color: "white",
                    fontSize: "0.75rem",
                  },
                },
                "Primary"
              )
            : null,
          React.createElement(
            "div",
            {
              title: item.filename,
              style: {
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                paddingTop: "0.4rem",
                fontSize: "0.8rem",
              },
            },
            item.filename || "Product image"
          )
        )
      )
    ),
    selected
      ? React.createElement(
          "div",
          {
            role: "dialog",
            "aria-modal": "true",
            "aria-label": selected.filename || "Product image",
            onClick: () => setSelected(null),
            style: {
              position: "fixed",
              inset: 0,
              zIndex: 10000,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "1rem",
              background: "rgba(0, 0, 0, 0.82)",
            },
          },
          React.createElement(
            "div",
            {
              onClick: (event) => event.stopPropagation(),
              style: {
                position: "relative",
                width: "min(100%, 1100px)",
                maxHeight: "95vh",
                overflow: "auto",
                borderRadius: "var(--mantine-radius-md, 8px)",
                background: "var(--mantine-color-body, white)",
                color: "var(--mantine-color-text, #212529)",
                padding: "1rem",
              },
            },
            React.createElement(
              "button",
              {
                type: "button",
                onClick: () => setSelected(null),
                "aria-label": "Close image viewer",
                style: {
                  ...buttonStyle,
                  position: "absolute",
                  top: "0.75rem",
                  right: "0.75rem",
                  zIndex: 1,
                },
              },
              "Close"
            ),
            React.createElement("img", {
              src: selected.url,
              alt: selected.filename || "Product image",
              style: {
                display: "block",
                width: "100%",
                maxHeight: "78vh",
                objectFit: "contain",
              },
            }),
            React.createElement(
              "div",
              { style: { paddingTop: "0.75rem", overflowWrap: "anywhere" } },
              React.createElement(
                "strong",
                null,
                selected.filename || "Product image"
              ),
              selected.kind === "primary"
                ? React.createElement("span", null, " — Primary image")
                : null,
              selected.source_url
                ? React.createElement(
                    "div",
                    null,
                    React.createElement(
                      "a",
                      {
                        href: selected.source_url,
                        target: "_blank",
                        rel: "noopener noreferrer",
                      },
                      "Open original source"
                    )
                  )
                : null
            )
          )
        )
      : null
  );
}

export function renderPartImageGallery(pluginContext) {
  return React.createElement(ProductImageGallery, { pluginContext });
}
