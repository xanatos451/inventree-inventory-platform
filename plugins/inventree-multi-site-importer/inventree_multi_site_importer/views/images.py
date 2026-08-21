from datetime import timedelta

from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from ..models import ImagePrefetch, MappingProfile
from ..planning import build_import_plan
from ..remote_images import RemoteImageError, download_remote_image
from .common import _capture_or_404, _mapped_capture_items


class CaptureImagePrefetchView(APIView):
    """Validate and cache mapped product images for a capture."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, pk):
        capture = _capture_or_404(request, pk)
        items = list(
            capture.image_prefetches.values(
                "url",
                "status",
                "original_filename",
                "content_type",
                "file_size",
                "error",
                "updated_at",
            )
        )
        counts = {}
        for item in items:
            counts[item["status"]] = counts.get(item["status"], 0) + 1
        return Response({
            "capture_id": capture.pk,
            "count": len(items),
            "summary": counts,
            "items": items,
        })

    def post(self, request, pk):
        if request.data.get("confirm") is not True:
            return Response(
                {"detail": "Set confirm to true to prefetch images."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        capture = _capture_or_404(request, pk)
        urls = request.data.get("image_urls")
        if not isinstance(urls, list) or not urls:
            return Response(
                {"detail": "Provide a non-empty image_urls list."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        if len(urls) > 25:
            return Response(
                {"detail": "Prefetch batches may contain at most 25 image URLs."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        profile_id = request.data.get("profile") or capture.profile_id
        rules = request.data.get("rules")
        if profile_id:
            profile = generics.get_object_or_404(MappingProfile, pk=profile_id, is_active=True)
            rules = profile.rules
        if not isinstance(rules, dict) or not rules:
            return Response(
                {"detail": "Provide a mapping profile or rules object."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            mapped_items = _mapped_capture_items(capture, rules, request.data)
            mapped_plan = build_import_plan(mapped_items)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        allowed_urls = {
            url
            for row in mapped_plan["rows"]
            for url in row["image_urls"]
        }
        requested_urls = []
        seen = set()
        for value in urls:
            url = str(value or "").strip()
            if url and url not in seen:
                seen.add(url)
                requested_urls.append(url)
        disallowed = [url for url in requested_urls if url not in allowed_urls]
        if disallowed:
            return Response(
                {"detail": "Every prefetch URL must be mapped by the selected capture rows."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        from django.core.files.base import ContentFile

        plugin = getattr(request, "plugin", None)
        max_bytes = int(plugin.get_setting("MAX_IMAGE_DOWNLOAD_BYTES")) if plugin else 10485760
        cache_days = int(plugin.get_setting("IMAGE_PREFETCH_CACHE_DAYS")) if plugin else 7
        if cache_days > 0:
            from django.utils import timezone

            ImagePrefetch.objects.filter(
                updated_at__lt=timezone.now() - timedelta(days=cache_days)
            ).delete()
        results = []
        for url in requested_urls:
            item, _created = ImagePrefetch.objects.get_or_create(
                capture=capture,
                url=url,
                defaults={"status": ImagePrefetch.Status.FAILED},
            )
            if item.status == ImagePrefetch.Status.READY and item.cached_file:
                results.append({
                    "url": url,
                    "status": item.status,
                    "cached": True,
                    "error": "",
                })
                continue
            if item.cached_file:
                item.cached_file.delete(save=False)
            try:
                filename, data, content_type, _final_url = download_remote_image(
                    url,
                    max_bytes=max_bytes,
                )
                item.cached_file.save(filename, ContentFile(data), save=False)
                item.status = ImagePrefetch.Status.READY
                item.original_filename = filename
                item.content_type = content_type
                item.file_size = len(data)
                item.error = ""
            except RemoteImageError as exc:
                item.status = ImagePrefetch.Status.FAILED
                item.original_filename = ""
                item.content_type = ""
                item.file_size = 0
                item.error = str(exc)[:500]
            item.save()
            results.append({
                "url": url,
                "status": item.status,
                "cached": item.status == ImagePrefetch.Status.READY,
                "error": item.error,
            })

        return Response({
            "capture_id": capture.pk,
            "processed_count": len(results),
            "ready_count": sum(item["status"] == ImagePrefetch.Status.READY for item in results),
            "failed_count": sum(item["status"] == ImagePrefetch.Status.FAILED for item in results),
            "items": results,
        })


class ExcludeCapturePrefetchFailuresView(APIView):
    """Explicitly mark failed image URLs as excluded from detail import."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        if request.data.get("confirm") is not True:
            return Response(
                {"detail": "Set confirm to true to exclude failed images."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        capture = _capture_or_404(request, pk)
        urls = request.data.get("image_urls")
        if not isinstance(urls, list):
            return Response(
                {"detail": "image_urls must be a list."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        queryset = capture.image_prefetches.filter(
            status=ImagePrefetch.Status.FAILED,
        )
        if urls:
            queryset = queryset.filter(url__in=urls)
        updated = queryset.update(status=ImagePrefetch.Status.EXCLUDED)
        return Response({
            "capture_id": capture.pk,
            "excluded_count": updated,
        })
