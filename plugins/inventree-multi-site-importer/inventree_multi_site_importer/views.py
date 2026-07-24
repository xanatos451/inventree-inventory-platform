import logging
from functools import lru_cache
from datetime import timedelta

from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView
from django.shortcuts import render
from django.db import transaction

from .models import CaptureImport, ImagePrefetch, MappingProfile
from .mapping import map_row, preview_rows
from .planning import build_import_plan
from .inspection import display_value, field_catalog, inspect_field, ordered_fields
from .serializers import CaptureImportSerializer, MappingProfileSerializer
from .selection import select_capture_rows
from .remote_images import RemoteImageError, download_remote_image


logger = logging.getLogger(__name__)


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


def _build_live_import_plan(mapped_items, lock_parts=False):
    """Build a plan from current database state, optionally locking matches."""
    from company.models import SupplierPart
    from part.models import Part, PartCategory

    @lru_cache(maxsize=2000)
    def part_lookup(identifier):
        queryset = Part.objects.filter(IPN__iexact=identifier)
        if lock_parts:
            queryset = queryset.select_for_update()
        return list(queryset.values("pk", "IPN", "name")[:5])

    @lru_cache(maxsize=2000)
    def supplier_lookup(identifier):
        queryset = SupplierPart.objects.filter(SKU__iexact=identifier)
        if lock_parts:
            queryset = queryset.select_for_update()
        return list(queryset.values("pk", "SKU", "part_id", "supplier_id")[:5])

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
    )


class CaptureListCreateView(generics.ListCreateAPIView):
    permission_classes = [permissions.IsAuthenticated]
    serializer_class = CaptureImportSerializer

    def get_queryset(self):
        return CaptureImport.objects.select_related("profile", "submitted_by")

    def get_serializer_context(self):
        context = super().get_serializer_context()
        plugin = getattr(self.request, "plugin", None)
        context["max_capture_rows"] = plugin.get_setting("MAX_CAPTURE_ROWS") if plugin else 5000
        return context

    def create(self, request, *args, **kwargs):
        response = super().create(request, *args, **kwargs)
        response.data = {
            "capture_id": response.data["pk"],
            "status": response.data["status"],
            "row_count": response.data["row_count"],
            "workspace_path": f"/plugin/multi-site-importer/captures/{response.data['pk']}/workspace/",
        }
        return response


class CaptureDetailView(generics.RetrieveAPIView):
    permission_classes = [permissions.IsAuthenticated]
    serializer_class = CaptureImportSerializer
    queryset = CaptureImport.objects.select_related("profile", "submitted_by")


class MappingProfileListCreateView(generics.ListCreateAPIView):
    permission_classes = [permissions.IsAuthenticated]
    serializer_class = MappingProfileSerializer
    queryset = MappingProfile.objects.all()

    def get_queryset(self):
        queryset = super().get_queryset()
        for field in ("source", "capture_profile", "page_type"):
            value = str(self.request.query_params.get(field, "")).strip()
            if value:
                queryset = queryset.filter(**{field: value})
        return queryset

    def perform_create(self, serializer):
        serializer.save(created_by=self.request.user)


class MappingProfileDetailView(generics.RetrieveUpdateDestroyAPIView):
    permission_classes = [permissions.IsAuthenticated]
    serializer_class = MappingProfileSerializer
    queryset = MappingProfile.objects.all()


class MappingPreviewView(APIView):
    """Preview a profile against stored raw rows without mutating inventory."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        capture = generics.get_object_or_404(CaptureImport, pk=pk)
        profile_id = request.data.get("profile") or capture.profile_id
        rules = request.data.get("rules")
        profile = None
        if profile_id:
            profile = generics.get_object_or_404(MappingProfile, pk=profile_id, is_active=True)
            rules = profile.rules
        if not isinstance(rules, dict) or not rules:
            return Response({"detail": "Provide a mapping profile or rules object."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            selected_rows = select_capture_rows(
                capture.payload.get("rows", []),
                request.data.get("selected_row_indices"),
            )
            items = preview_rows([row for _index, row in selected_rows], rules)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response({
            "capture_id": capture.pk,
            "profile_id": profile.pk if profile else None,
            "row_count": len(selected_rows),
            "preview_count": len(items),
            "items": items,
        })


class ImportPlanView(APIView):
    """Build a read-only plan against current InvenTree part identifiers."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        capture = generics.get_object_or_404(CaptureImport, pk=pk)
        profile_id = request.data.get("profile") or capture.profile_id
        rules = request.data.get("rules")
        profile = None
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
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        try:
            plan = _build_live_import_plan(mapped_items)
        except Exception:
            logger.exception("Failed to build import plan for capture_id=%s", capture.pk)
            return Response(
                {"detail": "Could not query existing InvenTree identifiers."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        plugin = getattr(request, "plugin", None)
        image_limit = (
            int(plugin.get_setting("MAX_DETAIL_IMAGE_DOWNLOADS"))
            if plugin else 100
        )
        return Response({
            "capture_id": capture.pk,
            "profile_id": profile.pk if profile else None,
            "detail_import_image_limit": image_limit,
            "detail_import_row_limit": 100,
            **plan,
        })


class CreateCapturePartsView(APIView):
    """Create new Part rows from a freshly validated import plan."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        if request.data.get("confirm") is not True:
            return Response(
                {"detail": "Set confirm to true to create parts."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            from part.models import Part
            from users.permissions import check_user_permission
        except Exception:
            logger.exception("Failed to load part permissions during create-parts request")
            return Response(
                {"detail": "Could not load InvenTree part permissions."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        if not check_user_permission(request.user, Part, "add"):
            return Response(
                {"detail": "Your InvenTree account does not have the Part 'add' role permission."},
                status=status.HTTP_403_FORBIDDEN,
            )

        capture = generics.get_object_or_404(CaptureImport, pk=pk)
        profile_id = request.data.get("profile") or capture.profile_id
        rules = request.data.get("rules")
        profile = None
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
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        try:
            with transaction.atomic():
                plan = _build_live_import_plan(mapped_items, lock_parts=True)
                if not plan["ready"]:
                    return Response(
                        {
                            "detail": (
                                "The live import plan contains conflicts or errors. "
                                "No parts were created."
                            ),
                            "summary": plan["summary"],
                            "rows": plan["rows"],
                        },
                        status=status.HTTP_409_CONFLICT,
                    )

                created = []
                skipped = []
                for row in plan["rows"]:
                    if row["action"] == "update":
                        skipped.append({
                            "row_index": row["row_index"],
                            "part_number": row["part_number"],
                            "reason": "An existing part or supplier part matches this identifier.",
                        })
                        continue

                    category_matches = row["category_matches"]
                    category_id = category_matches[0]["pk"] if len(category_matches) == 1 else None
                    mapped = row["mapped"]
                    part = Part(
                        name=row["name"],
                        description=str(mapped.get("description") or "").strip(),
                        IPN=row["part_number"],
                        category_id=category_id,
                        active=True,
                        purchaseable=True,
                    )
                    part.full_clean()
                    part.save()
                    created.append({
                        "row_index": row["row_index"],
                        "pk": part.pk,
                        "part_number": part.IPN,
                        "name": part.name,
                        "category_id": part.category_id,
                    })

                capture.status = CaptureImport.Status.COMPLETE
                capture.profile = profile
                capture.error = ""
                capture.save(update_fields=["status", "profile", "error", "updated_at"])
        except Exception:
            logger.exception("Failed to create parts for capture_id=%s", capture.pk)
            return Response(
                {
                    "detail": (
                        "Part creation failed model validation or database checks; "
                        "the batch was rolled back."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        return Response({
            "capture_id": capture.pk,
            "status": capture.status,
            "created_count": len(created),
            "created": created,
            "skipped_existing_count": len(skipped),
            "skipped_existing": skipped,
        })


class ImportCapturePartDetailsView(APIView):
    """Populate notes, parameters, primary images, and gallery attachments."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        if request.data.get("confirm") is not True:
            return Response(
                {"detail": "Set confirm to true to import part details."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        existing_part_mode = str(
            request.data.get("existing_part_mode") or "update"
        ).strip().lower()
        if existing_part_mode not in {"update", "overwrite"}:
            return Response(
                {"detail": "existing_part_mode must be 'update' or 'overwrite'."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            from common.models import Attachment, Parameter, ParameterTemplate
            from django.contrib.contenttypes.models import ContentType
            from django.core.files.base import ContentFile
            from django.db.models import Q
            from part.models import Part
            from users.permissions import check_user_permission
        except Exception:
            logger.exception("Failed to load part-detail models")
            return Response(
                {"detail": "Could not load InvenTree part-detail models."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        if not check_user_permission(request.user, Part, "change"):
            return Response(
                {"detail": "Your InvenTree account does not have the Part 'change' role permission."},
                status=status.HTTP_403_FORBIDDEN,
            )

        capture = generics.get_object_or_404(CaptureImport, pk=pk)
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
            plan = _build_live_import_plan(mapped_items)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except Exception:
            logger.exception("Failed to plan part details for capture_id=%s", capture.pk)
            return Response(
                {"detail": "Could not query current part details."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        if not plan["ready"] or plan["summary"]["create"]:
            return Response(
                {
                    "detail": (
                        "Create all selected new parts and resolve plan errors before "
                        "importing their details."
                    ),
                    "summary": plan["summary"],
                },
                status=status.HTTP_409_CONFLICT,
            )

        content_type = ContentType.objects.get_for_model(Part)
        parameter_names = sorted({
            name
            for row in plan["rows"]
            for name in row["parameters"]
        })
        templates = {}
        missing_templates = []
        for name in parameter_names:
            matches = list(
                ParameterTemplate.objects.filter(
                    name__iexact=name,
                ).filter(
                    Q(model_type=content_type) | Q(model_type__isnull=True)
                )[:2]
            )
            if len(matches) == 1:
                templates[name] = matches[0]
            else:
                missing_templates.append(name)
        if missing_templates:
            return Response(
                {
                    "detail": (
                        "Create unique InvenTree parameter templates for the mapped "
                        "names before importing details: "
                        + ", ".join(missing_templates)
                    ),
                    "missing_parameter_templates": missing_templates,
                },
                status=status.HTTP_409_CONFLICT,
            )

        row_parts = []
        for row in plan["rows"]:
            part_ids = {
                match["pk"] for match in row["existing_parts"] if match.get("pk")
            }
            part_ids.update(
                match["part_id"]
                for match in row["existing_supplier_parts"]
                if match.get("part_id")
            )
            if len(part_ids) != 1:
                return Response(
                    {"detail": f"Row {row['row_index'] + 1} does not resolve to one part."},
                    status=status.HTTP_409_CONFLICT,
                )
            row_parts.append((row, Part.objects.get(pk=part_ids.pop())))

        selected_image_urls = {
            url
            for row, _part in row_parts
            for url in row["image_urls"]
        }
        prefetches = {
            item.url: item
            for item in capture.image_prefetches.filter(url__in=selected_image_urls)
        }
        failed_prefetches = [
            item
            for item in prefetches.values()
            if item.status == ImagePrefetch.Status.FAILED
        ]
        if failed_prefetches:
            return Response(
                {
                    "detail": (
                        f"{len(failed_prefetches)} prefetched images failed validation. "
                        "Retry them or explicitly exclude the failures before importing."
                    ),
                    "failed_images": [
                        {"url": item.url, "error": item.error}
                        for item in failed_prefetches
                    ],
                },
                status=status.HTTP_409_CONFLICT,
            )
        excluded_urls = {
            item.url
            for item in prefetches.values()
            if item.status == ImagePrefetch.Status.EXCLUDED
        }

        plugin = getattr(request, "plugin", None)
        max_images = int(plugin.get_setting("MAX_DETAIL_IMAGE_DOWNLOADS")) if plugin else 100
        requested_images = sum(
            url not in excluded_urls
            for row, _part in row_parts
            for url in row["image_urls"]
        )
        if requested_images > max_images:
            return Response(
                {
                    "detail": (
                        f"The selected rows contain {requested_images} images; the per-request "
                        f"limit is {max_images}. Select fewer rows or raise the plugin setting."
                    )
                },
                status=status.HTTP_400_BAD_REQUEST,
            )

        parameter_count = 0
        notes_count = 0
        part_fields_count = 0
        try:
            with transaction.atomic():
                for row, part in row_parts:
                    mapped = row["mapped"]
                    changed_fields = []
                    mapped_name = str(mapped.get("name") or "").strip()
                    mapped_description = str(mapped.get("description") or "").strip()
                    if mapped_name and mapped_name != part.name:
                        part.name = mapped_name
                        changed_fields.append("name")
                    if (
                        existing_part_mode == "overwrite"
                        or mapped_description
                    ) and mapped_description != part.description:
                        part.description = mapped_description
                        changed_fields.append("description")
                    if len(row["category_matches"]) == 1:
                        category_id = row["category_matches"][0]["pk"]
                        if category_id != part.category_id:
                            part.category_id = category_id
                            changed_fields.append("category")

                    notes = str(mapped.get("notes") or "").strip()
                    if (
                        existing_part_mode == "overwrite"
                        or notes
                    ) and notes != part.notes:
                        part.notes = notes
                        changed_fields.append("notes")
                        notes_count += 1
                    if changed_fields:
                        part.full_clean()
                        part.save(update_fields=changed_fields)
                        part_fields_count += len(changed_fields)
                    for name, value in row["parameters"].items():
                        parameter, _created = Parameter.objects.get_or_create(
                            model_type=content_type,
                            model_id=part.pk,
                            template=templates[name],
                            defaults={"data": value, "updated_by": request.user},
                        )
                        parameter.data = value
                        parameter.updated_by = request.user
                        parameter.full_clean()
                        parameter.save()
                        parameter_count += 1
        except Exception:
            logger.exception("Failed to write part details for capture_id=%s", capture.pk)
            return Response(
                {"detail": "Notes or parameter validation failed; database changes were rolled back."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        max_bytes = int(plugin.get_setting("MAX_IMAGE_DOWNLOAD_BYTES")) if plugin else 10485760
        primary_count = 0
        attachment_count = 0
        cached_images_used = 0
        excluded_image_count = 0
        image_errors = []

        def image_content(url):
            nonlocal cached_images_used
            prefetched = prefetches.get(url)
            if (
                prefetched
                and prefetched.status == ImagePrefetch.Status.READY
                and prefetched.cached_file
            ):
                with prefetched.cached_file.open("rb") as stream:
                    data = stream.read()
                cached_images_used += 1
                return prefetched.original_filename, data
            filename, data, _content_type, _final_url = download_remote_image(
                url,
                max_bytes=max_bytes,
            )
            return filename, data

        for row, part in row_parts:
            excluded_image_count += sum(
                url in excluded_urls for url in row["image_urls"]
            )
            urls = [
                url for url in row["image_urls"]
                if url not in excluded_urls
            ]
            if not urls:
                continue
            primary_url = urls[0]
            if existing_part_mode == "overwrite" or not part.image:
                try:
                    filename, data = image_content(primary_url)
                    part.image.save(filename, ContentFile(data), save=True)
                    primary_count += 1
                except Exception as exc:
                    logger.warning(
                        "Primary image import failed for part_id=%s: %s",
                        part.pk,
                        exc,
                    )
                    image_errors.append({
                        "row_index": row["row_index"],
                        "url": primary_url,
                        "detail": (
                            str(exc) if isinstance(exc, RemoteImageError)
                            else "InvenTree could not store the primary image."
                        ),
                    })

            for gallery_url in urls[1:]:
                comment = f"Imported product image: {gallery_url}"[:250]
                if Attachment.objects.filter(
                    model_type="part",
                    model_id=part.pk,
                    comment=comment,
                ).exists():
                    continue
                try:
                    filename, data = image_content(gallery_url)
                    part.create_attachment(
                        attachment=ContentFile(data, name=filename),
                        comment=comment,
                        upload_user=request.user,
                    )
                    attachment_count += 1
                except Exception as exc:
                    logger.warning(
                        "Gallery image import failed for part_id=%s: %s",
                        part.pk,
                        exc,
                    )
                    image_errors.append({
                        "row_index": row["row_index"],
                        "url": gallery_url,
                        "detail": (
                            str(exc) if isinstance(exc, RemoteImageError)
                            else "InvenTree could not store the gallery attachment."
                        ),
                    })

        return Response({
            "capture_id": capture.pk,
            "part_count": len(row_parts),
            "notes_updated": notes_count,
            "part_fields_updated": part_fields_count,
            "parameters_written": parameter_count,
            "primary_images_written": primary_count,
            "gallery_attachments_written": attachment_count,
            "cached_images_used": cached_images_used,
            "excluded_image_count": excluded_image_count,
            "image_error_count": len(image_errors),
            "image_errors": image_errors,
            "existing_part_mode": existing_part_mode,
        })


class CaptureImagePrefetchView(APIView):
    """Validate and cache mapped product images for a capture."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, pk):
        capture = generics.get_object_or_404(CaptureImport, pk=pk)
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
        capture = generics.get_object_or_404(CaptureImport, pk=pk)
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
        capture = generics.get_object_or_404(CaptureImport, pk=pk)
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


class CreateCaptureCategoriesView(APIView):
    """Explicitly create category paths required by a mapped capture."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        if request.data.get("confirm") is not True:
            return Response(
                {"detail": "Set confirm to true to create categories."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        try:
            from part.models import PartCategory
            from users.permissions import check_user_permission
        except Exception:
            logger.exception("Failed to load category permissions during create-categories request")
            return Response(
                {"detail": "Could not load InvenTree category permissions."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )
        if not check_user_permission(request.user, PartCategory, "add"):
            return Response(
                {
                    "detail": (
                        "Your InvenTree account does not have the Part Category "
                        "'add' role permission."
                    )
                },
                status=status.HTTP_403_FORBIDDEN,
            )

        capture = generics.get_object_or_404(CaptureImport, pk=pk)
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
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        paths = []
        seen = set()
        for item in mapped_items:
            segments = [
                segment.strip()
                for segment in f"{item.get('category', '')} > {item.get('subcategory', '')}".split(">")
                if segment.strip()
            ]
            key = tuple(segment.casefold() for segment in segments)
            if segments and key not in seen:
                seen.add(key)
                paths.append(segments)

        try:
            created = []
            existing = []
            with transaction.atomic():
                for segments in paths:
                    parent = None
                    traversed = []
                    for segment in segments:
                        traversed.append(segment)
                        matches = list(
                            PartCategory.objects.filter(
                                parent=parent,
                                name__iexact=segment,
                            )[:2]
                        )
                        if len(matches) > 1:
                            raise ValueError(
                                f"Category path is ambiguous at {' > '.join(traversed)}."
                            )
                        if matches:
                            category = matches[0]
                            existing.append({
                                "pk": category.pk,
                                "path": " > ".join(traversed),
                            })
                        else:
                            category = PartCategory.objects.create(name=segment, parent=parent)
                            created.append({
                                "pk": category.pk,
                                "path": " > ".join(traversed),
                            })
                        parent = category
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_409_CONFLICT)
        except Exception:
            logger.exception("Failed to create categories for capture_id=%s", capture.pk)
            return Response(
                {"detail": "Could not create InvenTree categories."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        return Response({
            "capture_id": capture.pk,
            "created_count": len(created),
            "created": created,
            "existing_count": len(existing),
            "existing": existing,
        })


class CaptureFieldInspectionView(APIView):
    """Expose source-field coverage, samples, distributions, and row context."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, pk):
        capture = generics.get_object_or_404(CaptureImport, pk=pk)
        rows = capture.payload.get("rows", [])
        headers = capture.payload.get("headers", [])
        selected_field = str(request.query_params.get("field", "")).strip()
        if selected_field:
            available = ordered_fields(rows, headers)
            if selected_field not in available:
                return Response(
                    {"detail": "Unknown field.", "available_fields": available},
                    status=status.HTTP_400_BAD_REQUEST,
                )
            try:
                limit = min(100, max(1, int(request.query_params.get("limit", 50))))
            except (TypeError, ValueError):
                limit = 50
            result = inspect_field(
                rows,
                selected_field,
                contains=request.query_params.get("contains", ""),
                limit=limit,
            )
            return Response({"capture_id": capture.pk, "row_count": capture.row_count, **result})

        fields = field_catalog(rows, headers)
        return Response({
            "capture_id": capture.pk,
            "row_count": capture.row_count,
            "field_count": len(fields),
            "fields": fields,
        })


class CaptureDatasetRowsView(APIView):
    """Return one page of immutable capture rows for import selection."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, pk):
        capture = generics.get_object_or_404(CaptureImport, pk=pk)
        rows = capture.payload.get("rows", [])
        try:
            offset = max(0, int(request.query_params.get("offset", 0)))
            limit = min(200, max(1, int(request.query_params.get("limit", 100))))
        except (TypeError, ValueError):
            return Response(
                {"detail": "offset and limit must be integers."},
                status=status.HTTP_400_BAD_REQUEST,
            )
        page = [
            {"row_index": index, "values": row}
            for index, row in enumerate(rows[offset:offset + limit], start=offset)
        ]
        return Response({
            "capture_id": capture.pk,
            "row_count": len(rows),
            "offset": offset,
            "limit": limit,
            "rows": page,
        })


class CaptureWorkspaceView(APIView):
    """Human-readable field browser for mapping-profile development."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, pk):
        capture = generics.get_object_or_404(CaptureImport, pk=pk)
        rows = capture.payload.get("rows", [])
        headers = capture.payload.get("headers", [])
        fields = field_catalog(rows, headers)
        field_names = ordered_fields(rows, headers)
        field_samples = {}
        for field in field_names:
            field_samples[field] = next(
                (display_value(row.get(field)) for row in rows if display_value(row.get(field))),
                "",
            )
        selected_field = str(request.query_params.get("field", "")).strip()
        contains = str(request.query_params.get("contains", "")).strip()
        selected = None
        if selected_field in ordered_fields(rows, headers):
            selected = inspect_field(rows, selected_field, contains=contains, limit=100)
        return render(request, "inventree_multi_site_importer/capture_workspace.html", {
            "capture": capture,
            "fields": fields,
            "selected": selected,
            "selected_field": selected_field,
            "contains": contains,
            "field_names": field_names,
            "field_samples": field_samples,
        })


class HealthView(generics.GenericAPIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        return Response({"ok": True, "contract_version": "1.0"})
