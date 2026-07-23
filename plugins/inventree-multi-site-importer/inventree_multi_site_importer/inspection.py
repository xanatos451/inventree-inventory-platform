"""Field discovery and contextual sampling for queued raw captures."""

from collections import Counter
import json


def display_value(value):
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return str(value).strip()


def value_type(value):
    if value is None or display_value(value) == "":
        return "empty"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, list):
        return "list"
    if isinstance(value, dict):
        return "object"
    return "string"


def ordered_fields(rows, declared_headers=None):
    fields = []
    seen = set()
    for field in declared_headers or []:
        name = str(field).strip()
        if name and name not in seen:
            seen.add(name)
            fields.append(name)
    for row in rows or []:
        for field in (row or {}).keys():
            name = str(field).strip()
            if name and name not in seen:
                seen.add(name)
                fields.append(name)
    return fields


def field_catalog(rows, declared_headers=None, sample_limit=8, top_limit=10):
    rows = list(rows or [])
    output = []
    for field in ordered_fields(rows, declared_headers):
        values = [row.get(field) for row in rows]
        rendered = [display_value(value) for value in values]
        non_empty = [value for value in rendered if value]
        type_counts = Counter(value_type(value) for value in values)
        common = Counter(non_empty).most_common(top_limit)
        samples = []
        sampled_values = set()
        for index, value in enumerate(rendered):
            if not value or value in sampled_values:
                continue
            sampled_values.add(value)
            samples.append({"row_index": index, "value": value})
            if len(samples) >= sample_limit:
                break
        output.append({
            "field": field,
            "row_count": len(rows),
            "non_empty_count": len(non_empty),
            "empty_count": len(rows) - len(non_empty),
            "coverage_percent": round((len(non_empty) / len(rows) * 100), 1) if rows else 0.0,
            "distinct_count": len(set(non_empty)),
            "types": dict(sorted(type_counts.items())),
            "max_length": max((len(value) for value in non_empty), default=0),
            "samples": samples,
            "top_values": [{"value": value, "count": count} for value, count in common],
        })
    return output


def inspect_field(rows, field, contains="", limit=50):
    needle = str(contains or "").strip().casefold()
    matches = []
    total_matching = 0
    for index, row in enumerate(rows or []):
        value = display_value((row or {}).get(field))
        if needle and needle not in value.casefold():
            continue
        total_matching += 1
        if len(matches) >= limit:
            continue
        context = {}
        for key, context_value in (row or {}).items():
            if str(key) == field:
                continue
            rendered = display_value(context_value)
            if rendered:
                context[str(key)] = rendered
            if len(context) >= 12:
                break
        matches.append({"row_index": index, "value": value, "context": context})
    return {"field": field, "contains": contains, "match_count": total_matching, "rows": matches}

