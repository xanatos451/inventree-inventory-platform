from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView
from django.db import transaction

from ..models import ImagePrefetch, MappingProfile
from ..remote_images import RemoteImageError, download_remote_image
from .common import _build_live_import_plan, _capture_or_404, _mapped_capture_items, _mark_inventory_write, logger


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

        capture = _capture_or_404(request, pk)
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

        # File and attachment writes below are not one database transaction.
        # Protect the capture before the first inventory mutation is attempted.
        _mark_inventory_write(capture, "part-details")

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
