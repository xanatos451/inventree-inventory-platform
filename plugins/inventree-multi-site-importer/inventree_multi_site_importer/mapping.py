"""Small, deterministic mapping engine used by preview and future imports."""

import json
import re


TEMPLATE_FIELD_RE = re.compile(r"\{([^{}]+)\}")


def normalize_image_urls(value):
    """Return an ordered, deduplicated image URL list from supported capture values."""
    if isinstance(value, (list, tuple, set)):
        candidates = list(value)
    else:
        text = str(value or "").strip()
        candidates = []
        if text.startswith("["):
            try:
                parsed = json.loads(text)
                if isinstance(parsed, list):
                    candidates = parsed
            except (TypeError, ValueError, json.JSONDecodeError):
                candidates = []
        if not candidates and text:
            candidates = text.splitlines()

    output = []
    seen = set()
    for candidate in candidates:
        url = str(candidate or "").strip()
        if not url or url in seen:
            continue
        seen.add(url)
        output.append(url)
    return output


def map_row(row, rules):
    """Map one raw row using single-field or safe multi-field template rules."""
    result = {}
    for target, rule in (rules or {}).items():
        if not isinstance(rule, dict):
            continue
        source_field = str(rule.get("source_field") or rule.get("sourceField") or "").strip()
        template = str(rule.get("template") or "")
        if template:
            value = TEMPLATE_FIELD_RE.sub(
                lambda match: str(row.get(match.group(1).strip(), "") or "").strip(),
                template,
            ).strip()
        elif source_field:
            value = str(row.get(source_field, "") or "").strip()
        else:
            continue
        pattern = str(rule.get("regex") or "").strip()
        if pattern and value:
            try:
                match = re.search(pattern, value)
            except re.error as exc:
                raise ValueError(f"Invalid regex for {target}: {exc}") from exc
            value = (match.group(1) if match and match.lastindex else match.group(0) if match else "").strip()
        result[str(target)] = value

    if "image_urls" in result or "image_url" in result:
        primary = str(result.get("image_url") or "").strip()
        gallery = normalize_image_urls(result.get("image_urls"))
        if primary:
            gallery = [primary, *[url for url in gallery if url != primary]]
        elif gallery:
            primary = gallery[0]
            result["image_url"] = primary
        result["image_urls"] = gallery
    return result


def preview_rows(rows, rules, limit=20):
    return [map_row(row, rules) for row in list(rows or [])[:limit]]
