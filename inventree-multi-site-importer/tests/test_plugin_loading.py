"""Regression tests for InvenTree's early plugin-registry loading pass."""

import importlib
import sys
import types
import unittest
from unittest.mock import patch


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

        self.assertEqual(package.PLUGIN_VERSION, "0.1.11")
        self.assertEqual(patterns[0][1][0], f"{package_name}.urls")
        self.assertNotIn(f"{package_name}.urls", sys.modules)
        self.assertNotIn(f"{package_name}.models", sys.modules)

    def test_models_declare_the_appmixin_label(self):
        models_source = (
            __import__("pathlib").Path(__file__).parents[1]
            / "inventree_multi_site_importer"
            / "models.py"
        ).read_text(encoding="utf-8")
        self.assertEqual(models_source.count('app_label = "inventree_multi_site_importer"'), 2)

    def test_views_use_inventree_configured_authentication(self):
        views_source = (
            __import__("pathlib").Path(__file__).parents[1]
            / "inventree_multi_site_importer"
            / "views.py"
        ).read_text(encoding="utf-8")
        self.assertNotIn("rest_framework.authentication", views_source)
        self.assertNotIn("authentication_classes =", views_source)
        self.assertIn("check_user_permission(request.user, PartCategory, \"add\")", views_source)
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
        self.assertIn("Verification succeeded: all mapped category paths now exist.", template)
        self.assertIn('key === "image_url" ? imagePreview(item[key])', template)
        self.assertIn('referrerpolicy="no-referrer"', template)
        self.assertIn("def validate_rules", serializers)


if __name__ == "__main__":
    unittest.main()
