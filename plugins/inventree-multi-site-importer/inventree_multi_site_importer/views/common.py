"""Shared helpers used across the capture-import view modules."""

import logging
from functools import lru_cache

from rest_framework import generics
from django.utils import timezone

from ..models import CaptureImport
from ..mapping import map_row
from ..planning import build_import_plan
from ..selection import select_capture_rows

logger = logging.getLogger(__name__)


def _capture_queryset_for_request(request):
    """Return captures visible to the caller.

    Staff users can inspect all captures. Non-staff users are limited to captures
    they submitted, preventing cross-account access to supplier datasets.
    """
    queryset = CaptureImport.objects.select_related("profile", "submitted_by")
    user = getattr(request, "user", None)
    if user and getattr(user, "is_staff", False):
        return queryset
    if user and getattr(user, "is_authenticated", False):
        return queryset.filter(submitted_by=user)
    return queryset.none()


def _capture_or_404(request, pk):
    """Resolve a capture within the caller's visibility scope."""
    return generics.get_object_or_404(_capture_queryset_for_request(request), pk=pk)


def _mark_inventory_write(capture, stage):
    """Conservatively protect a capture once an inventory stage writes data."""
    stages = list(capture.imported_stages or [])
    if stage not in stages:
        stages.append(stage)
    capture.inventory_written_at = capture.inventory_written_at or timezone.now()
    capture.imported_stages = stages
    capture.save(update_fields=["inventory_written_at", "imported_stages", "updated_at"])


def _field_file_url(field):
    """Return a storage-backed file URL without failing on an empty field."""
    if not field:
        return ""
    try:
        return field.url
    except (AttributeError, ValueError):
        return ""


def _thumbnail_url(instance):
    """Return the best available generated thumbnail for an image field."""
    for attribute in ("thumbnail", "preview"):
        value = getattr(instance, attribute, None)
        url = _field_file_url(value)
        if url:
            return url
    return ""


def _mapped_capture_items(capture, rules, request_data):
    pairs = select_capture_rows(
        capture.payload.get("rows", []),
        request_data.get("selected_row_indices"),
    )
    items = []
    for row_index, row in pairs:
        item = map_row(row, rules)
        item["_capture_row_index"] = row_index
        items.append(item)
    return items


def _workflow_items(request, capture):
    rules = request.data.get("rules")
    profile_id = request.data.get("profile") or capture.profile_id
    if profile_id:
        from ..models import MappingProfile

        rules = generics.get_object_or_404(
            MappingProfile, pk=profile_id, is_active=True
        ).rules
    if not isinstance(rules, dict) or not rules:
        raise ValueError("Provide a mapping profile or rules object.")
    return _mapped_capture_items(capture, rules, request.data)


def _resolved_part(row, Part):
    ids = {item["pk"] for item in row["existing_parts"] if item.get("pk")}
    ids.update(
        item["part_id"] for item in row["existing_supplier_parts"]
        if item.get("part_id")
    )
    if len(ids) != 1:
        raise ValueError("Each row must resolve to exactly one existing Part.")
    return Part.objects.get(pk=ids.pop())


def _build_live_import_plan(mapped_items, lock_parts=False):
    """Build a plan from current database state, optionally locking matches."""
    from company.models import Company, ManufacturerPart, SupplierPart
    from part.models import Part, PartCategory
    from stock.models import StockLocation

    @lru_cache(maxsize=2000)
    def part_lookup(identifier):
        queryset = Part.objects.filter(IPN__iexact=identifier)
        if lock_parts:
            queryset = queryset.select_for_update()
        return list(queryset.values("pk", "IPN", "name")[:5])

    @lru_cache(maxsize=2000)
    def supplier_lookup(company, identifier):
        queryset = SupplierPart.objects.filter(SKU__iexact=identifier)
        if company:
            queryset = queryset.filter(supplier__name__iexact=company)
        if lock_parts:
            queryset = queryset.select_for_update()
        return list(queryset.values("pk", "SKU", "part_id", "supplier_id")[:5])

    @lru_cache(maxsize=2000)
    def manufacturer_lookup(company, identifier):
        queryset = ManufacturerPart.objects.filter(MPN__iexact=identifier)
        if company:
            queryset = queryset.filter(manufacturer__name__iexact=company)
        return list(queryset.values("pk", "MPN", "part_id", "manufacturer_id")[:5])

    @lru_cache(maxsize=1000)
    def company_lookup(name, role):
        filters = {"name__iexact": name}
        filters["is_supplier" if role == "supplier" else "is_manufacturer"] = True
        return list(Company.objects.filter(**filters).values("pk", "name")[:5])

    @lru_cache(maxsize=1000)
    def location_lookup(path):
        return list(
            StockLocation.objects.filter(name__iexact=path)
            .values("pk", "name", "structural")[:5]
        )

    @lru_cache(maxsize=1000)
    def category_lookup(category, subcategory):
        segments = [
            segment.strip()
            for segment in f"{category} > {subcategory}".split(">")
            if segment.strip()
        ]
        if not segments:
            return []
        candidates = list(
            PartCategory.objects.filter(
                parent__isnull=True,
                name__iexact=segments[0],
            )[:10]
        )
        if not candidates:
            return {"matches": [], "missing_segments": segments}
        for index, segment in enumerate(segments[1:], start=1):
            parent_ids = [candidate.pk for candidate in candidates]
            if not parent_ids:
                return {"matches": [], "missing_segments": segments[index:]}
            candidates = list(
                PartCategory.objects.filter(
                    parent_id__in=parent_ids,
                    name__iexact=segment,
                )[:10]
            )
            if not candidates:
                return {"matches": [], "missing_segments": segments[index:]}
        path = " > ".join(segments)
        return {
            "matches": [
                {"pk": candidate.pk, "name": candidate.name, "path": path}
                for candidate in candidates
            ],
            "missing_segments": [],
        }

    return build_import_plan(
        mapped_items,
        part_lookup,
        supplier_lookup,
        category_lookup,
        manufacturer_lookup,
        company_lookup,
        location_lookup,
    )
