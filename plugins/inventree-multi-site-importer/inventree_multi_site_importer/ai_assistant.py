"""Deterministic helpers for AI-assistant Phase 1 normalization and matching.

These functions are intentionally dependency-free so they can be unit-tested
without a Django runtime.
"""

from __future__ import annotations

import re
from typing import Any


_MATERIAL_KEYWORDS = [
    "stainless steel",
    "alloy steel",
    "carbon steel",
    "steel",
    "brass",
    "aluminum",
    "nylon",
    "zinc",
]

_DRIVE_KEYWORDS = [
    ("hex socket", "hex-socket"),
    ("phillips", "phillips"),
    ("slotted", "slotted"),
    ("torx", "torx"),
    ("pozidriv", "pozidriv"),
]

_TYPE_KEYWORDS = [
    ("socket head cap screw", "socket-head-cap-screw"),
    ("machine screw", "machine-screw"),
    ("set screw", "set-screw"),
    ("hex bolt", "hex-bolt"),
    ("nut", "nut"),
    ("washer", "washer"),
]

_FINISH_KEYWORDS = [
    "black oxide",
    "zinc plated",
    "plain",
    "passivated",
    "hot dip galvanized",
]

_THREAD_RE = re.compile(
    r"\b("
    r"m\s*\d+(?:\.\d+)?\s*(?:x|-)\s*\d+(?:\.\d+)?"
    r"|\d+\s*/\s*\d+\s*-\s*\d+"
    r"|\d+(?:\.\d+)?\s*-\s*\d+"
    r")\b",
    re.IGNORECASE,
)

_LENGTH_RE = re.compile(
    r"\b(\d+(?:\.\d+)?)\s*(mm|millimeter(?:s)?|in|inch(?:es)?|\")\b",
    re.IGNORECASE,
)

_DYNAMIC_KEYWORD_CATEGORIES = {
    "type",
    "drive",
    "material",
    "finish",
}


def _norm_text(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _norm_slug(value: str) -> str:
    text = _norm_text(value).lower()
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


def _tokenize(value: str) -> set[str]:
    return set(re.findall(r"[a-z0-9]+", _norm_text(value).lower()))


def _first_present(mapping: dict[str, Any], names: list[str]) -> str:
    for name in names:
        value = _norm_text(mapping.get(name, ""))
        if value:
            return value
    return ""


def _to_mm(number: float, unit: str) -> float:
    unit_lc = unit.lower()
    if unit_lc.startswith("mm") or unit_lc.startswith("millimeter"):
        return number
    return number * 25.4


def _extract_thread(text: str) -> str:
    match = _THREAD_RE.search(text or "")
    if not match:
        return ""
    value = match.group(1).lower()
    value = re.sub(r"\s+", "", value)
    value = value.replace("-", "x") if value.startswith("m") and "-" in value else value
    return value


def _extract_length_mm(text: str) -> float | None:
    match = _LENGTH_RE.search(text or "")
    if not match:
        return None
    number = float(match.group(1))
    unit = match.group(2)
    return round(_to_mm(number, unit), 3)


def _extract_keyword(text: str, keywords: list[str]) -> str:
    lower = (text or "").lower()
    for keyword in keywords:
        if keyword in lower:
            return _norm_slug(keyword)
    return ""


def _extract_keyword_pairs(text: str, keywords: list[tuple[str, str]]) -> str:
    lower = (text or "").lower()
    for needle, canonical in keywords:
        if needle in lower:
            return canonical
    return ""


def _dynamic_entries(
    dynamic_keywords: dict[str, Any] | None,
    category: str,
) -> list[tuple[str, str]]:
    if not isinstance(dynamic_keywords, dict):
        return []
    if category not in _DYNAMIC_KEYWORD_CATEGORIES:
        return []

    raw_entries = dynamic_keywords.get(category)
    pairs: list[tuple[str, str]] = []

    if isinstance(raw_entries, dict):
        for needle, canonical in raw_entries.items():
            needle_text = _norm_text(needle).lower()
            canonical_text = _norm_slug(canonical or needle)
            if needle_text and canonical_text:
                pairs.append((needle_text, canonical_text))
    elif isinstance(raw_entries, list):
        for entry in raw_entries:
            if isinstance(entry, dict):
                needle_text = _norm_text(entry.get("term", "")).lower()
                canonical_text = _norm_slug(entry.get("canonical", "") or needle_text)
            else:
                needle_text = _norm_text(entry).lower()
                canonical_text = _norm_slug(needle_text)
            if needle_text and canonical_text:
                pairs.append((needle_text, canonical_text))

    # Prefer longer terms first so specific matches win over generic ones.
    return sorted(set(pairs), key=lambda item: len(item[0]), reverse=True)


def _extract_keyword_with_dynamic(
    text: str,
    static_keywords: list[str],
    dynamic_keywords: dict[str, Any] | None,
    category: str,
) -> str:
    lower = (text or "").lower()
    for needle, canonical in _dynamic_entries(dynamic_keywords, category):
        if needle in lower:
            return canonical
    return _extract_keyword(text, static_keywords)


def _extract_keyword_pairs_with_dynamic(
    text: str,
    static_keywords: list[tuple[str, str]],
    dynamic_keywords: dict[str, Any] | None,
    category: str,
) -> str:
    lower = (text or "").lower()
    for needle, canonical in _dynamic_entries(dynamic_keywords, category):
        if needle in lower:
            return canonical
    return _extract_keyword_pairs(text, static_keywords)


def _combine_text(raw_row: dict[str, Any], mapped_item: dict[str, Any]) -> str:
    chunks = []
    for value in list((raw_row or {}).values()) + list((mapped_item or {}).values()):
        if isinstance(value, (dict, list, tuple, set)):
            continue
        text = _norm_text(value)
        if text:
            chunks.append(text)
    return " | ".join(chunks)


def normalize_captured_row(
    raw_row: dict[str, Any],
    mapped_item: dict[str, Any] | None = None,
    source: str = "",
    capture_id: int | None = None,
    row_index: int | None = None,
    dynamic_keywords: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Normalize one capture row into canonical attributes for matching."""
    mapped_item = mapped_item or {}
    combined = _combine_text(raw_row, mapped_item)

    product_name = _first_present(
        mapped_item,
        ["part.name", "name", "part_number", "part.ipn"],
    ) or _first_present(
        raw_row,
        ["Product", "Product Name", "Description", "Part Number", "McMasterPartNumber", "BoltDepotPartNumber", "FastenalPartNumber", "ASIN"],
    )

    description = _first_present(
        mapped_item,
        ["part.description", "description"],
    ) or _first_present(raw_row, ["Description", "Product Detail Specs", "ProductDetailSpecs"])

    part_ipn = _first_present(mapped_item, ["part.ipn", "part_number", "IPN"])
    supplier_sku = _first_present(mapped_item, ["supplier.sku"]) or _first_present(
        raw_row,
        ["Supplier SKU", "McMasterPartNumber", "BoltDepotPartNumber", "FastenalPartNumber", "ASIN"],
    )

    canonical_type = _extract_keyword_pairs_with_dynamic(
        combined,
        _TYPE_KEYWORDS,
        dynamic_keywords,
        "type",
    )
    canonical_thread = _extract_thread(combined)
    canonical_length_mm = _extract_length_mm(combined)
    canonical_drive = _extract_keyword_pairs_with_dynamic(
        combined,
        _DRIVE_KEYWORDS,
        dynamic_keywords,
        "drive",
    )
    canonical_material = _extract_keyword_with_dynamic(
        combined,
        _MATERIAL_KEYWORDS,
        dynamic_keywords,
        "material",
    )
    canonical_finish = _extract_keyword_with_dynamic(
        combined,
        _FINISH_KEYWORDS,
        dynamic_keywords,
        "finish",
    )

    fingerprint_parts = [
        canonical_type,
        canonical_thread,
        str(canonical_length_mm) if canonical_length_mm is not None else "",
        canonical_drive,
        canonical_material,
        canonical_finish,
    ]
    fingerprint = "|".join(fingerprint_parts).strip("|")

    return {
        "capture_id": capture_id,
        "row_index": row_index,
        "source": _norm_slug(source),
        "raw": dict(raw_row or {}),
        "mapped": dict(mapped_item or {}),
        "canonical": {
            "type": canonical_type,
            "thread": canonical_thread,
            "length_mm": canonical_length_mm,
            "drive": canonical_drive,
            "material": canonical_material,
            "finish": canonical_finish,
            "fingerprint": fingerprint,
        },
        "identity": {
            "part_ipn": part_ipn,
            "supplier_sku": supplier_sku,
            "product_name": product_name,
            "description": description,
        },
    }


def _score_text_similarity(left: str, right: str) -> float:
    left_tokens = _tokenize(left)
    right_tokens = _tokenize(right)
    if not left_tokens or not right_tokens:
        return 0.0
    intersect = len(left_tokens & right_tokens)
    union = len(left_tokens | right_tokens)
    return intersect / union if union else 0.0


def _part_text(part: dict[str, Any]) -> str:
    return " ".join(
        _norm_text(part.get(key, "")) for key in ("name", "description", "IPN")
    ).strip()


def score_candidate_part(
    normalized_item: dict[str, Any],
    candidate_part: dict[str, Any],
    dynamic_keywords: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Score one candidate part against a normalized incoming row."""
    incoming = dict(normalized_item or {})
    incoming_canonical = dict(incoming.get("canonical") or {})
    candidate_normalized = normalize_captured_row(
        {
            "Product": candidate_part.get("name", ""),
            "Description": candidate_part.get("description", ""),
            "Part Number": candidate_part.get("IPN", ""),
        },
        {},
        source="existing-part",
        dynamic_keywords=dynamic_keywords,
    )
    candidate_canonical = candidate_normalized.get("canonical") or {}

    exact = []
    conflicts = []
    compared_keys = ["type", "thread", "drive", "material", "finish"]
    for key in compared_keys:
        left = _norm_text(incoming_canonical.get(key, ""))
        right = _norm_text(candidate_canonical.get(key, ""))
        if not left or not right:
            continue
        if left == right:
            exact.append(f"canonical.{key}")
        else:
            conflicts.append(f"canonical.{key}")

    length_left = incoming_canonical.get("length_mm")
    length_right = candidate_canonical.get("length_mm")
    if isinstance(length_left, (int, float)) and isinstance(length_right, (int, float)):
        if abs(float(length_left) - float(length_right)) <= 0.5:
            exact.append("canonical.length_mm")
        else:
            conflicts.append("canonical.length_mm")

    incoming_identity = incoming.get("identity") or {}
    incoming_text = " ".join(
        _norm_text(incoming_identity.get(key, ""))
        for key in ("product_name", "description", "supplier_sku")
    ).strip()
    candidate_text = _part_text(candidate_part)
    text_similarity = _score_text_similarity(incoming_text, candidate_text)
    fuzzy = ["description_similarity"] if text_similarity >= 0.2 else []

    ipn_boost = 0.0
    incoming_ipn = _norm_text(incoming_identity.get("part_ipn", "")).casefold()
    candidate_ipn = _norm_text(candidate_part.get("IPN", "")).casefold()
    if incoming_ipn and candidate_ipn and incoming_ipn == candidate_ipn:
        ipn_boost = 0.2
        exact.append("ipn_exact")

    overlap_ratio = len(exact) / 6.0
    conflict_penalty = 0.35 if any(
        key in conflicts
        for key in ("canonical.type", "canonical.thread", "canonical.length_mm")
    ) else 0.0
    score = (
        (overlap_ratio * 0.75)
        + (text_similarity * 0.15)
        + ipn_boost
        - conflict_penalty
    )
    score = max(0.0, min(1.0, score))

    return {
        "score": round(score, 4),
        "exact": sorted(set(exact)),
        "fuzzy": fuzzy,
        "conflicts": sorted(set(conflicts)),
    }


def build_candidate_matches(
    normalized_item: dict[str, Any],
    candidate_parts: list[dict[str, Any]],
    limit: int = 5,
    min_score: float = 0.35,
    dynamic_keywords: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Build ranked candidate part matches for one normalized capture row."""
    ranked = []
    for part in candidate_parts or []:
        scored = score_candidate_part(
            normalized_item,
            part,
            dynamic_keywords=dynamic_keywords,
        )
        if scored["score"] < float(min_score):
            continue
        ranked.append(
            {
                "part_id": part.get("pk"),
                "part_name": _norm_text(part.get("name", "")),
                "part_ipn": _norm_text(part.get("IPN", "")),
                "score": scored["score"],
                "evidence": {
                    "exact": scored["exact"],
                    "fuzzy": scored["fuzzy"],
                    "conflicts": scored["conflicts"],
                },
            }
        )

    ranked.sort(key=lambda item: item.get("score", 0.0), reverse=True)
    return ranked[: max(1, int(limit))]
