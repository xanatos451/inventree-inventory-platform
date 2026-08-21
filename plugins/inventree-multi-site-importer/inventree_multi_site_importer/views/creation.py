"""Creates new Parts and Part Categories from a validated import plan."""

from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView
from django.db import transaction

from ..models import CaptureImport, MappingProfile
from .common import _build_live_import_plan, _capture_or_404, _mapped_capture_items, _mark_inventory_write, logger


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

        capture = _capture_or_404(request, pk)
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
                if created:
                    _mark_inventory_write(capture, "parts")
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

        if created:
            _mark_inventory_write(capture, "categories")

        return Response({
            "capture_id": capture.pk,
            "created_count": len(created),
            "created": created,
            "existing_count": len(existing),
            "existing": existing,
        })
