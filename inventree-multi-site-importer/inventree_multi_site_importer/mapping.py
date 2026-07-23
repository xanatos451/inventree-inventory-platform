"""Small, deterministic mapping engine used by preview and future imports."""

import re


TEMPLATE_FIELD_RE = re.compile(r"\{([^{}]+)\}")


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
    return result


def preview_rows(rows, rules, limit=20):
    return [map_row(row, rules) for row in list(rows or [])[:limit]]
