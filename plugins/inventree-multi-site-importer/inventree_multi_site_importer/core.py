"""InvenTree plugin entry point.

Keeping the plugin class in a module beneath the package matches the layout
expected by AppMixin when it derives the containing Django application.
"""

from django.urls import include, path
from plugin import InvenTreePlugin
from plugin.mixins import AppMixin, SettingsMixin, UrlsMixin, UserInterfaceMixin

from . import PLUGIN_VERSION


class MultiSiteImporterPlugin(
    AppMixin,
    SettingsMixin,
    UrlsMixin,
    UserInterfaceMixin,
    InvenTreePlugin,
):
    """Stage browser captures for server-side mapping and import."""

    NAME = "MultiSiteImporter"
    SLUG = "multi-site-importer"
    TITLE = "Multi-Site Supplier Importer"
    DESCRIPTION = "Stages and maps supplier captures submitted by the browser extension."
    VERSION = PLUGIN_VERSION
    AUTHOR = "xanatos451"
    MIN_VERSION = "1.4.0"

    SETTINGS = {
        "MAX_CAPTURE_ROWS": {
            "name": "Maximum rows per capture",
            "description": "Reject captures larger than this limit.",
            "default": 5000,
            "validator": int,
        },
        "MAX_IMAGE_DOWNLOAD_BYTES": {
            "name": "Maximum remote image size",
            "description": "Maximum bytes downloaded for each product image.",
            "default": 10485760,
            "validator": int,
        },
        "MAX_DETAIL_IMAGE_DOWNLOADS": {
            "name": "Maximum images per detail import",
            "description": "Maximum remote image downloads attempted in one request.",
            "default": 100,
            "validator": int,
        },
        "IMAGE_PREFETCH_CACHE_DAYS": {
            "name": "Image prefetch cache retention",
            "description": "Days to retain cached image preflight files.",
            "default": 7,
            "validator": int,
        },
        "CAPTURE_RETENTION_DAYS": {
            "name": "Unimported capture retention",
            "description": (
                "Suggested days to retain unpinned captures which have not "
                "written any inventory. Used when configuring scheduled cleanup."
            ),
            "default": 30,
            "validator": int,
        },
        "ENABLE_PART_IMAGE_GALLERY": {
            "name": "Enable part image gallery",
            "description": (
                "Show a responsive Product Images panel on Part pages containing "
                "the primary image and imported image attachments."
            ),
            "default": True,
            "validator": bool,
        },
    }

    def setup_urls(self):
        """Expose the plugin API beneath /plugin/multi-site-importer/."""
        return [path("", include("inventree_multi_site_importer.urls"))]

    def get_ui_panels(self, request, context, **kwargs):
        """Add the responsive product-image gallery to browser Part views."""
        context = context or {}
        if (
            not self.get_setting("ENABLE_PART_IMAGE_GALLERY")
            or context.get("target_model") != "part"
            or context.get("target_id") is None
        ):
            return []

        try:
            part_id = int(context["target_id"])
        except (TypeError, ValueError):
            return []

        return [
            {
                "key": "multi-site-product-images",
                "title": "Product Images",
                "description": "Primary and gallery images for this part",
                "icon": "ti:photo:outline",
                "source": self.plugin_static_file(
                    "part_image_gallery.js:renderPartImageGallery"
                ),
                "context": {
                    "part_id": part_id,
                    "gallery_url": (
                        f"/plugin/{self.SLUG}/parts/{part_id}/image-gallery/"
                    ),
                },
            }
        ]
