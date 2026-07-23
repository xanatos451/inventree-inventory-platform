"""Read-only import planning for mapped supplier captures."""

from __future__ import annotations

from collections import Counter
from urllib.parse import urlparse


def _text(value):
    return str(value or "").strip()


def _parameters(item):
    return {
        key.removeprefix("parameter."): _text(value)
        for key, value in (item or {}).items()
        if str(key).startswith("parameter.") and _text(value)
    }


def _valid_http_url(value):
    if not value:
        return True
    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def build_import_plan(items, part_lookup=None, supplier_lookup=None, category_lookup=None):
    """Classify mapped rows without writing to InvenTree."""
    items = list(items or [])
    part_lookup = part_lookup or (lambda _identifier: [])
    supplier_lookup = supplier_lookup or (lambda _identifier: [])
    identities = [_text(item.get("part_number") or item.get("IPN")).casefold() for item in items]
    duplicate_counts = Counter(identity for identity in identities if identity)
    rows = []

    for index, item in enumerate(items):
        item = dict(item or {})
        part_number = _text(item.get("part_number") or item.get("IPN"))
        name = _text(item.get("name"))
        category = _text(item.get("category"))
        subcategory = _text(item.get("subcategory"))
        image_url = _text(item.get("image_url"))
        errors = []
        warnings = []
        existing_parts = []
        existing_supplier_parts = []
        category_matches = []
        missing_category_segments = []

        if not part_number:
            errors.append("Part number is required.")
        if not name:
            errors.append("Name is required.")
        if not category:
            warnings.append("Category is not mapped.")
        elif category_lookup:
            category_result = category_lookup(category, subcategory) or []
            if isinstance(category_result, dict):
                category_matches = list(category_result.get("matches") or [])
                missing_category_segments = list(category_result.get("missing_segments") or [])
            else:
                category_matches = list(category_result)
            if not category_matches:
                errors.append("Mapped category path does not exist in InvenTree.")
            elif len(category_matches) > 1:
                errors.append("Mapped category path is ambiguous in InvenTree.")
        if image_url and not _valid_http_url(image_url):
            errors.append("Primary image URL must use HTTP or HTTPS.")

        if part_number:
            existing_parts = list(part_lookup(part_number) or [])
            existing_supplier_parts = list(supplier_lookup(part_number) or [])
            if duplicate_counts[part_number.casefold()] > 1:
                errors.append("Part number occurs more than once in this capture.")

        matched_part_ids = {match.get("pk") for match in existing_parts if match.get("pk") is not None}
        matched_part_ids.update(
            match.get("part_id")
            for match in existing_supplier_parts
            if match.get("part_id") is not None
        )
        if len(existing_parts) > 1 or len(existing_supplier_parts) > 1 or len(matched_part_ids) > 1:
            errors.append("Part number matches multiple existing InvenTree records.")

        if errors:
            action = "conflict" if part_number and (
                duplicate_counts[part_number.casefold()] > 1
                or existing_parts
                or existing_supplier_parts
            ) else "error"
        elif existing_parts or existing_supplier_parts:
            action = "update"
        else:
            action = "create"

        rows.append({
            "row_index": index,
            "action": action,
            "part_number": part_number,
            "name": name,
            "category": category,
            "subcategory": subcategory,
            "parameter_count": len(_parameters(item)),
            "parameters": _parameters(item),
            "existing_parts": existing_parts,
            "existing_supplier_parts": existing_supplier_parts,
            "category_matches": category_matches,
            "missing_category_segments": missing_category_segments,
            "errors": errors,
            "warnings": warnings,
            "mapped": item,
        })

    counts = Counter(row["action"] for row in rows)
    missing_category_paths = []
    seen_paths = set()
    for row in rows:
        segments = row["missing_category_segments"]
        if not segments:
            continue
        path = " > ".join([
            segment.strip()
            for segment in f"{row['category']} > {row['subcategory']}".split(">")
            if segment.strip()
        ])
        key = path.casefold()
        if key not in seen_paths:
            seen_paths.add(key)
            missing_category_paths.append({
                "path": path,
                "missing_segments": segments,
            })
    return {
        "row_count": len(rows),
        "summary": {
            "create": counts["create"],
            "update": counts["update"],
            "conflict": counts["conflict"],
            "error": counts["error"],
            "warning_rows": sum(bool(row["warnings"]) for row in rows),
        },
        "missing_category_paths": missing_category_paths,
        "can_create_categories": bool(missing_category_paths),
        "ready": counts["conflict"] == 0 and counts["error"] == 0,
        "rows": rows,
    }
