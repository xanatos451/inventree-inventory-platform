"""Dependency-free checks for the documented capture contract."""

import unittest
import importlib.util
from pathlib import Path

_mapping_spec = importlib.util.spec_from_file_location(
    "supplier_mapping",
    Path(__file__).parents[1] / "inventree_multi_site_importer" / "mapping.py",
)
_mapping = importlib.util.module_from_spec(_mapping_spec)
_mapping_spec.loader.exec_module(_mapping)
map_row = _mapping.map_row

_inspection_spec = importlib.util.spec_from_file_location(
    "supplier_inspection",
    Path(__file__).parents[1] / "inventree_multi_site_importer" / "inspection.py",
)
_inspection = importlib.util.module_from_spec(_inspection_spec)
_inspection_spec.loader.exec_module(_inspection)
field_catalog = _inspection.field_catalog
inspect_field = _inspection.inspect_field

_planning_spec = importlib.util.spec_from_file_location(
    "supplier_planning",
    Path(__file__).parents[1] / "inventree_multi_site_importer" / "planning.py",
)
_planning = importlib.util.module_from_spec(_planning_spec)
_planning_spec.loader.exec_module(_planning)
build_import_plan = _planning.build_import_plan


def validate_capture(payload):
    required = ("contract_version", "capture_profile", "source", "captured_at", "page_url", "headers", "rows")
    missing = [key for key in required if key not in payload]
    if missing:
        raise ValueError(f"Missing fields: {', '.join(missing)}")
    if payload["contract_version"] != "1.0":
        raise ValueError("Unsupported contract version")
    if not isinstance(payload["rows"], list) or not payload["rows"]:
        raise ValueError("rows must be a non-empty list")


class CaptureContractTests(unittest.TestCase):
    def test_minimum_capture(self):
        validate_capture({
            "contract_version": "1.0",
            "capture_profile": "list-details",
            "source": "mcmaster-carr",
            "captured_at": "2026-07-22T12:00:00Z",
            "page_url": "https://www.mcmaster.com/products/screws",
            "headers": ["Part Number"],
            "rows": [{"Part Number": "91251A542"}],
        })

    def test_rejects_empty_rows(self):
        with self.assertRaises(ValueError):
            validate_capture({
                "contract_version": "1.0", "capture_profile": "single-item", "source": "test",
                "captured_at": "2026-07-22T12:00:00Z", "page_url": "https://example.test",
                "headers": [], "rows": [],
            })

    def test_mapping_profile_extracts_a_capture_field(self):
        mapped = map_row(
            {"Description": "1/4-20 x 2 in, zinc plated"},
            {"name": {"source_field": "Description", "regex": r"^([^,]+)"}},
        )
        self.assertEqual(mapped, {"name": "1/4-20 x 2 in"})

    def test_mapping_profile_supports_parameter_targets(self):
        mapped = map_row(
            {"Spec_Thread_Size": "M3", "Spec_Length": "4 mm"},
            {
                "parameter.Thread Size": {"source_field": "Spec_Thread_Size", "regex": ""},
                "parameter.Length": {"source_field": "Spec_Length", "regex": ""},
            },
        )
        self.assertEqual(mapped["parameter.Thread Size"], "M3")
        self.assertEqual(mapped["parameter.Length"], "4 mm")

    def test_mapping_profile_normalizes_product_image_gallery(self):
        mapped = map_row(
            {
                "Image URL": "https://images.example.test/primary.jpg",
                "Image URLs": (
                    "https://images.example.test/side.jpg\n"
                    "https://images.example.test/primary.jpg\n"
                    "https://images.example.test/package.jpg"
                ),
            },
            {
                "image_url": {"source_field": "Image URL", "regex": ""},
                "image_urls": {"source_field": "Image URLs", "regex": ""},
            },
        )
        self.assertEqual(mapped["image_url"], "https://images.example.test/primary.jpg")
        self.assertEqual(mapped["image_urls"], [
            "https://images.example.test/primary.jpg",
            "https://images.example.test/side.jpg",
            "https://images.example.test/package.jpg",
        ])

    def test_mapping_profile_promotes_first_gallery_image_to_primary(self):
        mapped = map_row(
            {"Image URLs": '["https://images.example.test/front.jpg", "https://images.example.test/back.jpg"]'},
            {"image_urls": {"source_field": "Image URLs", "regex": ""}},
        )
        self.assertEqual(mapped["image_url"], "https://images.example.test/front.jpg")
        self.assertEqual(len(mapped["image_urls"]), 2)

    def test_mapping_profile_combines_multiple_source_fields(self):
        mapped = map_row(
            {
                "ProductDetailPageTitle": "Flat Head Screw",
                "ProductDetailVariant": "M3 x 4 mm",
                "McMasterPartNumber": "92125A127",
            },
            {
                "name": {
                    "template": "{ProductDetailPageTitle} — {ProductDetailVariant}",
                    "regex": "",
                },
                "description": {
                    "template": "McMaster {McMasterPartNumber}: {ProductDetailPageTitle}",
                    "regex": r"^McMaster (.+)$",
                },
            },
        )
        self.assertEqual(mapped["name"], "Flat Head Screw — M3 x 4 mm")
        self.assertEqual(mapped["description"], "92125A127: Flat Head Screw")

    def test_import_plan_classifies_create_update_and_validation_errors(self):
        items = [
            {"part_number": "NEW-1", "name": "New Part", "category": "Fastening"},
            {
                "part_number": "EXISTING-1", "name": "Existing Part",
                "category": "Fastening", "parameter.Material": "Steel",
            },
            {"part_number": "", "name": "", "image_url": "file:///unsafe.png"},
        ]
        plan = build_import_plan(
            items,
            part_lookup=lambda value: [{"pk": 7, "IPN": value, "name": "Existing"}] if value == "EXISTING-1" else [],
        )
        self.assertEqual([row["action"] for row in plan["rows"]], ["create", "update", "error"])
        self.assertEqual(plan["rows"][1]["parameter_count"], 1)
        self.assertFalse(plan["ready"])
        self.assertEqual(plan["summary"]["create"], 1)
        self.assertEqual(plan["summary"]["update"], 1)
        self.assertEqual(plan["summary"]["error"], 1)

    def test_import_plan_marks_duplicate_identifiers_as_conflicts(self):
        plan = build_import_plan([
            {"part_number": "DUP-1", "name": "One", "category": "Fastening"},
            {"part_number": "dup-1", "name": "Two", "category": "Fastening"},
        ])
        self.assertEqual(plan["summary"]["conflict"], 2)
        self.assertTrue(all(row["errors"] for row in plan["rows"]))

    def test_import_plan_preserves_and_validates_product_image_gallery(self):
        plan = build_import_plan([{
            "part_number": "IMG-1",
            "name": "Part With Gallery",
            "category": "Fastening",
            "image_urls": [
                "https://images.example.test/front.jpg",
                "https://images.example.test/front.jpg",
                "https://images.example.test/side.jpg",
            ],
        }])
        row = plan["rows"][0]
        self.assertEqual(row["image_url"], "https://images.example.test/front.jpg")
        self.assertEqual(row["image_count"], 2)
        self.assertEqual(row["image_urls"], [
            "https://images.example.test/front.jpg",
            "https://images.example.test/side.jpg",
        ])
        self.assertEqual(row["mapped"]["image_urls"], row["image_urls"])
        self.assertEqual(row["action"], "create")

        invalid = build_import_plan([{
            "part_number": "IMG-2",
            "name": "Part With Unsafe Gallery",
            "category": "Fastening",
            "image_url": "https://images.example.test/front.jpg",
            "image_urls": "https://images.example.test/front.jpg\nfile:///unsafe.png",
        }])
        self.assertEqual(invalid["rows"][0]["action"], "error")
        self.assertIn(
            "Product image URL #2 must use HTTP or HTTPS.",
            invalid["rows"][0]["errors"],
        )

    def test_import_plan_requires_an_unambiguous_category_path(self):
        item = {"part_number": "NEW-1", "name": "New Part", "category": "Fastening"}
        missing = build_import_plan([item], category_lookup=lambda _category, _subcategory: [])
        resolved = build_import_plan(
            [item],
            category_lookup=lambda category, _subcategory: [{"pk": 12, "name": category, "path": category}],
        )
        self.assertEqual(missing["rows"][0]["action"], "error")
        self.assertFalse(missing["ready"])
        self.assertFalse(missing["can_create_categories"])
        self.assertEqual(resolved["rows"][0]["action"], "create")
        self.assertEqual(resolved["rows"][0]["category_matches"][0]["pk"], 12)

    def test_import_plan_reports_category_paths_that_can_be_created(self):
        item = {
            "part_number": "NEW-1",
            "name": "New Part",
            "category": "Fasteners",
            "subcategory": "Screws > Flat Head Screws",
        }
        plan = build_import_plan(
            [item],
            category_lookup=lambda _category, _subcategory: {
                "matches": [],
                "missing_segments": ["Screws", "Flat Head Screws"],
            },
        )
        self.assertTrue(plan["can_create_categories"])
        self.assertEqual(plan["missing_category_paths"], [{
            "path": "Fasteners > Screws > Flat Head Screws",
            "missing_segments": ["Screws", "Flat Head Screws"],
        }])

    def test_field_catalog_reports_coverage_types_and_examples(self):
        catalog = field_catalog(
            [
                {"Material": "Steel", "Quantity": 2},
                {"Material": "Steel", "Quantity": 5},
                {"Material": "Brass", "Quantity": None},
            ],
            ["Material", "Quantity"],
        )
        material = next(item for item in catalog if item["field"] == "Material")
        quantity = next(item for item in catalog if item["field"] == "Quantity")
        self.assertEqual(material["coverage_percent"], 100.0)
        self.assertEqual(material["distinct_count"], 2)
        self.assertEqual(material["top_values"][0], {"value": "Steel", "count": 2})
        self.assertEqual(quantity["types"], {"empty": 1, "number": 2})

    def test_field_inspection_filters_and_preserves_row_context(self):
        result = inspect_field(
            [
                {"Material": "Zinc-plated steel", "Part": "A1"},
                {"Material": "Brass", "Part": "B2"},
            ],
            "Material",
            contains="steel",
        )
        self.assertEqual(result["match_count"], 1)
        self.assertEqual(result["rows"][0]["row_index"], 0)
        self.assertEqual(result["rows"][0]["context"], {"Part": "A1"})


if __name__ == "__main__":
    unittest.main()
