"""Conservative cleanup helpers for raw captures and prefetched images."""

from datetime import timedelta

from django.db import transaction
from django.db.models import Count, Sum
from django.utils import timezone

from .models import CaptureImport, ImagePrefetch


def cleanup_eligible_captures():
    """Return captures which have no evidence of inventory writes."""
    return (
        CaptureImport.objects.filter(
            inventory_written_at__isnull=True,
            pinned=False,
        )
        .annotate(stock_write_count=Count("stock_import_records"))
        .filter(stock_write_count=0)
    )


def capture_cleanup_catalog():
    """Return cleanup candidates with cache usage for manual selection."""
    return list(
        cleanup_eligible_captures()
        .annotate(
            prefetch_count=Count("image_prefetches"),
            prefetch_bytes=Sum("image_prefetches__file_size"),
        )
        .values(
            "pk", "source", "page_title", "page_url", "row_count", "status",
            "created_at", "pinned", "prefetch_count", "prefetch_bytes",
        )
        .order_by("-created_at")
    )


def cleanup_selected(capture_ids, *, action, user=None):
    """Delete eligible captures or only their prefetch cache."""
    ids = sorted({int(value) for value in capture_ids})
    eligible = cleanup_eligible_captures().filter(pk__in=ids)
    eligible_ids = set(eligible.values_list("pk", flat=True))
    rejected_ids = [value for value in ids if value not in eligible_ids]
    prefetches = ImagePrefetch.objects.filter(capture_id__in=eligible_ids)
    prefetch_count = prefetches.count()
    prefetch_bytes = prefetches.aggregate(total=Sum("file_size"))["total"] or 0

    with transaction.atomic():
        if action == "delete_captures":
            capture_count = eligible.count()
            eligible.delete()
        elif action == "clear_prefetch":
            capture_count = 0
            prefetches.delete()
        else:
            raise ValueError("action must be 'delete_captures' or 'clear_prefetch'.")

    return {
        "action": action,
        "capture_count": capture_count,
        "prefetch_count": prefetch_count,
        "prefetch_bytes": int(prefetch_bytes),
        "rejected_capture_ids": rejected_ids,
    }


def cleanup_expired(*, capture_days=30, prefetch_days=7, execute=False):
    """Plan or execute age-based cleanup using the same eligibility rules."""
    now = timezone.now()
    capture_cutoff = now - timedelta(days=max(0, int(capture_days)))
    prefetch_cutoff = now - timedelta(days=max(0, int(prefetch_days)))
    captures = cleanup_eligible_captures().filter(created_at__lt=capture_cutoff)
    capture_ids = list(captures.values_list("pk", flat=True))
    expired_prefetches = ImagePrefetch.objects.filter(updated_at__lt=prefetch_cutoff)
    # Prefetch records belonging to captures which will be deleted are counted once.
    standalone_prefetches = expired_prefetches.exclude(capture_id__in=capture_ids)
    result = {
        "dry_run": not execute,
        "capture_count": len(capture_ids),
        "capture_ids": capture_ids,
        "standalone_prefetch_count": standalone_prefetches.count(),
        "standalone_prefetch_bytes": int(
            standalone_prefetches.aggregate(total=Sum("file_size"))["total"] or 0
        ),
    }
    if execute:
        with transaction.atomic():
            standalone_prefetches.delete()
            captures.delete()
    return result
