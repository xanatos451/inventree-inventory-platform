"""InvenTree plugin entry point.

Keeping the plugin class in a module beneath the package matches the layout
expected by AppMixin when it derives the containing Django application.
"""

from django.urls import include, path
from plugin import InvenTreePlugin
from plugin.mixins import AppMixin, SettingsMixin, UrlsMixin

from . import PLUGIN_VERSION


class MultiSiteImporterPlugin(AppMixin, SettingsMixin, UrlsMixin, InvenTreePlugin):
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
    }

    def setup_urls(self):
        """Expose the plugin API beneath /plugin/multi-site-importer/."""
        return [path("", include("inventree_multi_site_importer.urls"))]
