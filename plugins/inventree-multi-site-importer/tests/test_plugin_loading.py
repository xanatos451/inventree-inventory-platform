"""Regression tests for InvenTree's early plugin-registry loading pass."""

import importlib
import sys
import types
import unittest
from pathlib import Path
from unittest.mock import patch


def _views_source(root):
    """Concatenate the views/ package source; views.py is split across modules."""
    views_dir = root / "inventree_multi_site_importer" / "views"
    return "\n".join(
        path.read_text(encoding="utf-8") for path in sorted(views_dir.glob("*.py"))
    )


class PluginLoadingTests(unittest.TestCase):
    def test_setup_urls_does_not_import_models_during_registry_init(self):
        plugin_module = types.ModuleType("plugin")
        mixins_module = types.ModuleType("plugin.mixins")
        django_module = types.ModuleType("django")
        django_urls_module = types.ModuleType("django.urls")

        plugin_module.InvenTreePlugin = type("InvenTreePlugin", (), {})
        mixins_module.AppMixin = type("AppMixin", (), {})
        mixins_module.SettingsMixin = type("SettingsMixin", (), {})
        mixins_module.UrlsMixin = type("UrlsMixin", (), {})
        mixins_module.UserInterfaceMixin = type("UserInterfaceMixin", (), {})
        django_urls_module.include = lambda module_name: (module_name, None, None)
        django_urls_module.path = lambda route, view: (route, view)

        fake_modules = {
            "plugin": plugin_module,
            "plugin.mixins": mixins_module,
            "django": django_module,
            "django.urls": django_urls_module,
        }

        package_name = "inventree_multi_site_importer"
        with patch.dict(sys.modules, fake_modules):
            sys.modules.pop(package_name, None)
            sys.modules.pop(f"{package_name}.urls", None)
            sys.modules.pop(f"{package_name}.models", None)
            package = importlib.import_module(package_name)
            core = importlib.import_module(f"{package_name}.core")
            patterns = core.MultiSiteImporterPlugin().setup_urls()

        self.assertEqual(package.PLUGIN_VERSION, "0.2.3")
        self.assertEqual(patterns[0][1][0], f"{package_name}.urls")
        self.assertNotIn(f"{package_name}.urls", sys.modules)

    def test_models_declare_the_appmixin_label(self):
        models_source = (
            __import__("pathlib").Path(__file__).parents[1]
            / "inventree_multi_site_importer"
            / "models.py"
        ).read_text(encoding="utf-8")
        self.assertEqual(models_source.count('app_label = "inventree_multi_site_importer"'), 6)

    def test_views_use_inventree_configured_authentication(self):
        root = Path(__file__).parents[1]
        views_source = _views_source(root)
        self.assertNotIn("rest_framework.authentication", views_source)
        self.assertNotIn("authentication_classes =", views_source)
        self.assertIn("check_user_permission(request.user, PartCategory, \"add\")", views_source)
        self.assertIn("check_user_permission(request.user, Part, \"add\")", views_source)
        self.assertNotIn('has_perm("part.add_partcategory")', views_source)

    def test_visual_mapping_workspace_and_profile_update_route_are_packaged(self):
        root = __import__("pathlib").Path(__file__).parents[1]
        template = (
            root
            / "inventree_multi_site_importer"
            / "templates"
            / "inventree_multi_site_importer"
            / "capture_workspace.html"
        ).read_text(encoding="utf-8")
        urls = (root / "inventree_multi_site_importer" / "urls.py").read_text(encoding="utf-8")
        serializers = (root / "inventree_multi_site_importer" / "serializers.py").read_text(encoding="utf-8")
        for control in (
            'id="standardRules"',
            'id="parameterRules"',
            'id="previewBtn"',
            'id="buildPlanBtn"',
            'id="categoryCreationResult"',
            'id="createPartsBtn"',
            'id="partCreationResult"',
            'id="datasetTable"',
            'id="selectAllRowsBtn"',
            'id="deselectAllRowsBtn"',
            'id="importDetailsBtn"',
            'id="detailImportResult"',
            'id="existingPartMode"',
            'id="prefetchImagesBtn"',
            'id="retryFailedImagesBtn"',
            'id="excludeFailedImagesBtn"',
            'id="imagePrefetchResult"',
            'id="saveProfileBtn"',
            'id="profileSelect"',
            'class="rule-mode"',
            'class="rule-template"',
            'json_script:"source-fields-data"',
        ):
            self.assertIn(control, template)
        self.assertIn('path("mapping-profiles/<int:pk>/"', urls)
        self.assertIn('path("captures/<int:pk>/plan/"', urls)
        self.assertIn('path("captures/<int:pk>/categories/"', urls)
        self.assertIn('path("captures/<int:pk>/parts/"', urls)
        self.assertIn('path("captures/<int:pk>/rows/"', urls)
        self.assertIn('path("captures/<int:pk>/ai/decisions/"', urls)
        self.assertIn('path("captures/<int:pk>/details/"', urls)
        self.assertIn('path("captures/<int:pk>/images/prefetch/"', urls)
        self.assertIn('path("captures/<int:pk>/images/exclude-failures/"', urls)
        self.assertIn("selected_row_indices:selectedRowsPayload()", template)
        self.assertIn("existing_part_mode:existingPartMode", template)
        self.assertIn("lastPlan.detail_import_image_limit", template)
        self.assertIn("Importing Batch ${index + 1}/${batches.length}", template)
        views_source = _views_source(root)
        self.assertIn('"detail_import_image_limit": image_limit', views_source)
        self.assertIn('request.data.get("existing_part_mode") or "update"', views_source)
        self.assertIn("download_remote_image(", views_source)
        self.assertIn("cached_images_used", template)
        self.assertIn("explicitly excluded", template)
        self.assertIn("Verification succeeded: all mapped category paths now exist.", template)
        self.assertIn("The server will rebuild the live plan before writing.", template)
        self.assertIn("part.full_clean()", views_source)
        self.assertIn('key === "image_url" ? imagePreview(item[key])', template)
        self.assertIn('referrerpolicy="no-referrer"', template)
        self.assertIn("def validate_rules", serializers)

    def test_part_image_gallery_panel_and_static_asset_are_packaged(self):
        root = __import__("pathlib").Path(__file__).parents[1]
        core = (root / "inventree_multi_site_importer" / "core.py").read_text(
            encoding="utf-8"
        )
        urls = (root / "inventree_multi_site_importer" / "urls.py").read_text(
            encoding="utf-8"
        )
        gallery = (
            root
            / "inventree_multi_site_importer"
            / "static"
            / "part_image_gallery.js"
        ).read_text(encoding="utf-8")
        self.assertIn("UserInterfaceMixin", core)
        self.assertIn("ENABLE_PART_IMAGE_GALLERY", core)
        self.assertIn("part_image_gallery.js:renderPartImageGallery", core)
        self.assertIn('parts/<int:pk>/image-gallery/', urls)
        self.assertIn("export function renderPartImageGallery", gallery)
        self.assertIn("gridTemplateColumns", gallery)
        self.assertIn('role: "dialog"', gallery)

    def test_retention_cleanup_is_conservative_and_packaged(self):
        root = __import__("pathlib").Path(__file__).parents[1]
        models_source = (
            root / "inventree_multi_site_importer" / "models.py"
        ).read_text(encoding="utf-8")
        cleanup_source = (
            root / "inventree_multi_site_importer" / "cleanup.py"
        ).read_text(encoding="utf-8")
        command_source = (
            root / "inventree_multi_site_importer" / "management"
            / "commands" / "cleanup_multi_site_importer.py"
        ).read_text(encoding="utf-8")
        urls = (root / "inventree_multi_site_importer" / "urls.py").read_text(
            encoding="utf-8"
        )
        self.assertIn("inventory_written_at", models_source)
        self.assertIn("imported_stages", models_source)
        self.assertIn("pinned", models_source)
        self.assertIn("inventory_written_at__isnull=True", cleanup_source)
        self.assertIn("stock_write_count=0", cleanup_source)
        self.assertIn("--execute", command_source)
        self.assertIn('path("captures/cleanup/"', urls)

    def test_generated_id_migration_branch_is_canonicalized_and_merged(self):
        root = __import__("pathlib").Path(__file__).parents[1]
        migrations = root / "inventree_multi_site_importer" / "migrations"
        generated = (
            migrations
            / "0005_alter_captureimport_id_alter_imageprefetch_id_and_more.py"
        ).read_text(encoding="utf-8")
        merge = (
            migrations
            / "0007_merge_0005_generated_0006_capture_retention.py"
        ).read_text(encoding="utf-8")
        models_source = (
            root / "inventree_multi_site_importer" / "models.py"
        ).read_text(encoding="utf-8")
        self.assertEqual(generated.count("models.AutoField("), 3)
        self.assertIn("0006_capture_retention", merge)
        self.assertIn(
            "0005_alter_captureimport_id_alter_imageprefetch_id_and_more",
            merge,
        )
        self.assertIn('model_name="stockimportrecord"', merge)
        self.assertEqual(models_source.count("id = models.AutoField(primary_key=True)"), 6)


if __name__ == "__main__":
    unittest.main()
