import logging
import re
from functools import lru_cache
from datetime import timedelta

from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView
from django.shortcuts import render
from django.db import DatabaseError, transaction
from django.utils import timezone

from .cleanup import capture_cleanup_catalog, cleanup_selected
from .models import AIAssistantDecisionLog, AIAssistantLexiconEntry, CaptureImport, ImagePrefetch, MappingProfile, StockImportRecord
from .mapping import map_row, preview_rows
from .planning import build_import_plan
from .inspection import display_value, field_catalog, inspect_field, ordered_fields
from .serializers import CaptureImportSerializer, MappingProfileSerializer
from .selection import select_capture_rows
from .remote_images import RemoteImageError, download_remote_image
from .ai_assistant import build_candidate_matches, normalize_captured_row


logger = logging.getLogger(__name__)

_AI_LEXICON_CATEGORIES = {
    "type",
    "drive",
    "material",
    "finish",
}


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


class PartImageGalleryView(APIView):
    """Return primary and attached images for a Part gallery panel."""

    permission_classes = [permissions.IsAuthenticated]

    def get(self, request, pk):
        from part.models import Part

        try:
            part = Part.objects.get(pk=pk)
        except Part.DoesNotExist:
            return Response(
                {"detail": "Part not found."},
                status=status.HTTP_404_NOT_FOUND,
            )

        images = []
        seen_urls = set()
        primary_url = _field_file_url(part.image)
        if primary_url:
            seen_urls.add(primary_url)
            images.append(
                {
                    "id": "primary",
                    "kind": "primary",
                    "url": primary_url,
                    "thumbnail_url": _thumbnail_url(part.image) or primary_url,
                    "filename": getattr(part.image, "name", "").rsplit("/", 1)[-1],
                    "comment": "Primary image",
                    "source_url": "",
                }
            )

        for attachment in part.attachments.all().order_by("pk"):
            is_image = getattr(attachment, "is_image", False)
            if callable(is_image):
                is_image = is_image()
            if not is_image:
                continue

            image_url = _field_file_url(attachment.attachment)
            if not image_url or image_url in seen_urls:
                continue
            seen_urls.add(image_url)

            comment = attachment.comment or ""
            source_url = ""
            prefix = "Imported product image: "
            if comment.startswith(prefix):
                source_url = comment[len(prefix) :].strip()

            images.append(
                {
                    "id": attachment.pk,
                    "kind": "attachment",
                    "url": image_url,
                    "thumbnail_url": (
                        _thumbnail_url(attachment) or image_url
                    ),
                    "filename": getattr(
                        attachment.attachment, "name", ""
                    ).rsplit("/", 1)[-1],
                    "comment": comment,
                    "source_url": source_url,
                }
            )

        return Response(
            {
                "part_id": part.pk,
                "part_name": part.name,
                "count": len(images),
                "images": images,
            }
        )


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


def _norm_learning_text(value, max_length=255):
    text = re.sub(r"\s+", " ", str(value or "")).strip().lower()
    return text[:max_length]


def _load_dynamic_keywords():
    """Load active learned terms for the deterministic normalizer."""
    result = {category: {} for category in _AI_LEXICON_CATEGORIES}
    try:
        queryset = AIAssistantLexiconEntry.objects.filter(is_active=True)
        for row in queryset.values("category", "term", "canonical_value"):
            category = str(row.get("category") or "")
            term = _norm_learning_text(row.get("term", ""))
            canonical = _norm_learning_text(row.get("canonical_value", ""))
            if category in result and term and canonical:
                result[category][term] = canonical
    except DatabaseError:
        # Lightweight unit tests can run without migrated plugin tables.
        return {}
    except Exception:
        logger.exception("Could not load dynamic AI lexicon entries")
        return {}

    return {category: terms for category, terms in result.items() if terms}


def _apply_lexicon_feedback(category, term, canonical, action):
    category = str(category or "").strip().lower()
    if category not in _AI_LEXICON_CATEGORIES:
        return False

    normalized_term = _norm_learning_text(term)
    normalized_canonical = _norm_learning_text(canonical or term)
    if not normalized_term or not normalized_canonical:
        return False

    entry, _created = AIAssistantLexiconEntry.objects.get_or_create(
        category=category,
        term=normalized_term,
        defaults={
            "canonical_value": normalized_canonical,
            "source": "decision",
            "approved_count": 0,
            "rejected_count": 0,
            "confidence": 0.5,
            "is_active": True,
        },
    )

    changed_fields = {"updated_at", "last_seen_at"}
    if action in {
        AIAssistantDecisionLog.Action.ACCEPTED,
        AIAssistantDecisionLog.Action.EDITED,
    }:
        entry.approved_count += 1
        changed_fields.add("approved_count")
        if normalized_canonical:
            entry.canonical_value = normalized_canonical
            changed_fields.add("canonical_value")
    elif action == AIAssistantDecisionLog.Action.REJECTED:
        entry.rejected_count += 1
        changed_fields.add("rejected_count")

    total = entry.approved_count + entry.rejected_count
    entry.confidence = round(entry.approved_count / total, 4) if total else 0.5
    entry.is_active = not (entry.rejected_count > entry.approved_count and total >= 4)
    changed_fields.update({"confidence", "is_active"})
    entry.save(update_fields=sorted(changed_fields))
    return True


def _process_ai_decisions(capture, user, decisions):
    if not isinstance(decisions, list) or not decisions:
        raise ValueError("decisions must be a non-empty array.")

    action_values = {
        AIAssistantDecisionLog.Action.ACCEPTED,
        AIAssistantDecisionLog.Action.REJECTED,
        AIAssistantDecisionLog.Action.EDITED,
    }
    processed = 0
    learned_updates = 0

    with transaction.atomic():
        for decision in decisions:
            if not isinstance(decision, dict):
                continue

            action = str(decision.get("action") or "").strip().lower()
            if action not in action_values:
                raise ValueError("Each decision action must be accepted, rejected, or edited.")

            category = str(decision.get("category") or "").strip().lower()
            term = decision.get("term")
            canonical = decision.get("canonical")

            AIAssistantDecisionLog.objects.create(
                capture=capture,
                row_index=decision.get("row_index"),
                suggestion_type=str(decision.get("suggestion_type") or "mapping")[:40],
                action=action,
                target=str(decision.get("target") or "")[:255],
                suggested_value=str(decision.get("suggested_value") or "")[:8000],
                applied_value=str(decision.get("applied_value") or "")[:8000],
                confidence=decision.get("confidence"),
                rationale=str(decision.get("rationale") or "")[:4000],
                payload=decision.get("payload") if isinstance(decision.get("payload"), dict) else {},
                decided_by=user if getattr(user, "is_authenticated", False) else None,
            )

            if term and category in _AI_LEXICON_CATEGORIES:
                if _apply_lexicon_feedback(category, term, canonical, action):
                    learned_updates += 1

            processed += 1

    if processed == 0:
        raise ValueError("No valid decisions were provided.")

    return {
        "processed": processed,
        "learned_updates": learned_updates,
    }


def _normalized_capture_items(capture, rules, request_data, dynamic_keywords=None):
    """Return normalized rows, with mapped values when rules are provided."""
    pairs = select_capture_rows(
        capture.payload.get("rows", []),
        request_data.get("selected_row_indices"),
    )
    items = []
    for row_index, row in pairs:
        mapped = map_row(row, rules) if isinstance(rules, dict) and rules else {}
        items.append(
            normalize_captured_row(
                raw_row=row,
                mapped_item=mapped,
                source=capture.source,
                capture_id=capture.pk,
                row_index=row_index,
                dynamic_keywords=dynamic_keywords,
            )
        )
    return items


def _candidate_parts_for_item(item, limit=120):
    """Fetch candidate existing parts for one normalized capture item."""
    try:
        from django.db.models import Q
        from part.models import Part
    except Exception:
        logger.exception("Could not import InvenTree Part models for candidates")
        raise

    identity = item.get("identity") or {}
    canonical = item.get("canonical") or {}

    incoming_ipn = str(identity.get("part_ipn") or "").strip()
    if incoming_ipn:
        queryset = Part.objects.filter(IPN__iexact=incoming_ipn)
        exact = list(queryset.values("pk", "IPN", "name", "description")[: max(1, int(limit))])
        if exact:
            return exact

    token_values = [
        str(identity.get("product_name") or "").strip(),
        str(identity.get("description") or "").strip(),
        str(canonical.get("type") or "").strip(),
        str(canonical.get("thread") or "").strip(),
        str(canonical.get("material") or "").strip(),
    ]
    query = Q()
    for value in token_values:
        if not value:
            continue
        token = value[:80]
        query |= Q(name__icontains=token)
        query |= Q(description__icontains=token)
        query |= Q(IPN__icontains=token)

    if not query:
        queryset = Part.objects.all()
    else:
        queryset = Part.objects.filter(query)

    return list(queryset.values("pk", "IPN", "name", "description")[: max(1, int(limit))])


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


class CaptureListCreateView(generics.ListCreateAPIView):
    permission_classes = [permissions.IsAuthenticated]
    serializer_class = CaptureImportSerializer

    def get_queryset(self):
        return _capture_queryset_for_request(self.request)

    def get_serializer_context(self):
        context = super().get_serializer_context()
        plugin = getattr(self.request, "plugin", None)
        if plugin:
            max_rows = int(plugin.get_setting("MAX_CAPTURE_ROWS") or 5000)
            max_payload_bytes = int(plugin.get_setting("MAX_CAPTURE_PAYLOAD_BYTES") or 8388608)
        else:
            max_rows = 5000
            max_payload_bytes = 8388608
        context["max_capture_rows"] = max_rows
        context["max_capture_payload_bytes"] = max_payload_bytes
        context["max_capture_row_fields"] = 500
        context["max_capture_field_name_length"] = 255
        context["max_capture_cell_length"] = 32000
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

    def get_queryset(self):
        return _capture_queryset_for_request(self.request)


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
        capture = _capture_or_404(request, pk)
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


class CaptureNormalizeView(APIView):
    """Return deterministic canonical normalization for selected capture rows."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        capture = _capture_or_404(request, pk)
        dynamic_keywords = _load_dynamic_keywords()
        profile_id = request.data.get("profile") or capture.profile_id
        rules = request.data.get("rules")
        profile = None
        if profile_id:
            profile = generics.get_object_or_404(
                MappingProfile,
                pk=profile_id,
                is_active=True,
            )
            rules = profile.rules

        try:
            items = _normalized_capture_items(
                capture,
                rules,
                request.data,
                dynamic_keywords=dynamic_keywords,
            )
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        return Response(
            {
                "capture_id": capture.pk,
                "profile_id": profile.pk if profile else None,
                "row_count": len(items),
                "items": items,
            }
        )


class CaptureCandidatesView(APIView):
    """Return deterministic likely existing-part candidates for selected rows."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        capture = _capture_or_404(request, pk)
        dynamic_keywords = _load_dynamic_keywords()
        profile_id = request.data.get("profile") or capture.profile_id
        rules = request.data.get("rules")
        profile = None
        if profile_id:
            profile = generics.get_object_or_404(
                MappingProfile,
                pk=profile_id,
                is_active=True,
            )
            rules = profile.rules

        try:
            items = _normalized_capture_items(
                capture,
                rules,
                request.data,
                dynamic_keywords=dynamic_keywords,
            )
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        try:
            limit = max(1, min(20, int(request.data.get("limit") or 5)))
        except (TypeError, ValueError):
            return Response(
                {"detail": "limit must be an integer between 1 and 20."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        results = []
        for item in items:
            try:
                candidates = _candidate_parts_for_item(item)
            except Exception:
                return Response(
                    {"detail": "Could not query existing InvenTree parts for candidate matching."},
                    status=status.HTTP_503_SERVICE_UNAVAILABLE,
                )
            matches = build_candidate_matches(
                item,
                candidates,
                limit=limit,
                dynamic_keywords=dynamic_keywords,
            )
            results.append(
                {
                    "capture_id": item.get("capture_id"),
                    "row_index": item.get("row_index"),
                    "canonical": item.get("canonical") or {},
                    "identity": item.get("identity") or {},
                    "candidates": matches,
                }
            )

        return Response(
            {
                "capture_id": capture.pk,
                "profile_id": profile.pk if profile else None,
                "row_count": len(results),
                "items": results,
            }
        )


class CaptureDecisionsView(APIView):
    """Persist AI decisions and update dynamic learned keyword entries."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        capture = _capture_or_404(request, pk)
        decisions = request.data.get("decisions")
        try:
            summary = _process_ai_decisions(capture, request.user, decisions)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        except Exception:
            logger.exception("Failed to persist AI decisions for capture_id=%s", capture.pk)
            return Response(
                {"detail": "Could not persist AI decisions."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        return Response(
            {
                "capture_id": capture.pk,
                **summary,
            }
        )


class ImportPlanView(APIView):
    """Build a read-only plan against current InvenTree part identifiers."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
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
        capture = _capture_or_404(request, pk)
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
        capture = _capture_or_404(request, pk)
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
        capture = _capture_or_404(request, pk)
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


def _workflow_items(request, capture):
    rules = request.data.get("rules")
    profile_id = request.data.get("profile") or capture.profile_id
    if profile_id:
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


class ImportCaptureProcurementView(APIView):
    """Write supplier/manufacturer records in a separate confirmed stage."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        if request.data.get("confirm") is not True:
            return Response({"detail": "Set confirm to true."}, status=400)
        mode = str(request.data.get("existing_part_mode") or "update").lower()
        if mode not in {"update", "overwrite"}:
            return Response({"detail": "Invalid update mode."}, status=400)
        from company.models import Company, ManufacturerPart, SupplierPart, SupplierPriceBreak
        from decimal import Decimal
        from djmoney.money import Money
        from part.models import Part
        from users.permissions import check_user_permission
        capture = _capture_or_404(request, pk)
        counts = {"manufacturer_created": 0, "manufacturer_updated": 0,
                  "supplier_created": 0, "supplier_updated": 0}
        try:
            plan = _build_live_import_plan(_workflow_items(request, capture))
            if not plan["ready"] or plan["summary"]["create"]:
                return Response({"detail": "Create all Parts and resolve plan errors first.", "rows": plan["rows"]}, status=409)
            needed_models = []
            if any(row["manufacturer_action"] != "none" for row in plan["rows"]):
                needed_models.append(ManufacturerPart)
            if any(row["supplier_action"] != "none" for row in plan["rows"]):
                needed_models.append(SupplierPart)
            if any(row["mapped"].get("supplier.price") for row in plan["rows"]):
                needed_models.append(SupplierPriceBreak)
            if any(
                not check_user_permission(request.user, model, permission)
                for model in needed_models
                for permission in ("add", "change")
            ):
                return Response(
                    {"detail": "Add and change permissions are required for the mapped procurement records."},
                    status=403,
                )
            with transaction.atomic():
                for row in plan["rows"]:
                    mapped = row["mapped"]
                    part = _resolved_part(row, Part)
                    manufacturer_part = None
                    company_name = str(mapped.get("manufacturer.company") or "").strip()
                    mpn = str(mapped.get("manufacturer.mpn") or "").strip()
                    if company_name and mpn:
                        company = Company.objects.get(name__iexact=company_name, is_manufacturer=True)
                        manufacturer_part, made = ManufacturerPart.objects.get_or_create(
                            part=part, manufacturer=company, MPN=mpn
                        )
                        for field in ("description", "link"):
                            value = mapped.get(f"manufacturer.{field}")
                            if value not in (None, "") or mode == "overwrite":
                                setattr(manufacturer_part, field, str(value or "").strip() or None)
                        manufacturer_part.full_clean()
                        manufacturer_part.save()
                        counts[f"manufacturer_{'created' if made else 'updated'}"] += 1
                    company_name = str(mapped.get("supplier.company") or "").strip()
                    sku = str(mapped.get("supplier.sku") or "").strip()
                    if company_name and sku:
                        company = Company.objects.get(name__iexact=company_name, is_supplier=True)
                        supplier_part, made = SupplierPart.objects.get_or_create(
                            part=part, supplier=company, SKU=sku,
                            defaults={"pack_quantity": "1"},
                        )
                        for field in ("description", "link", "packaging", "pack_quantity", "note"):
                            key = "notes" if field == "note" else field
                            value = mapped.get(f"supplier.{key}")
                            if value not in (None, "") or mode == "overwrite":
                                setattr(supplier_part, field, str(value or "").strip())
                        for field in ("active", "primary"):
                            key = f"supplier.{field}"
                            if key in mapped:
                                supplier_part_value = str(mapped[key]).strip().lower()
                                setattr(
                                    supplier_part, field,
                                    supplier_part_value in {"1", "true", "yes", "on"},
                                )
                        if manufacturer_part:
                            supplier_part.manufacturer_part = manufacturer_part
                        supplier_part.full_clean()
                        supplier_part.save()
                        counts[f"supplier_{'created' if made else 'updated'}"] += 1
                        raw_price = str(mapped.get("supplier.price") or "").strip()
                        if raw_price:
                            price_quantity = Decimal(
                                str(mapped.get("supplier.price_quantity") or "1").strip()
                            )
                            currency = str(
                                mapped.get("supplier.price_currency") or "USD"
                            ).strip().upper()
                            price_break, _made = SupplierPriceBreak.objects.update_or_create(
                                part=supplier_part,
                                quantity=price_quantity,
                                defaults={"price": Money(Decimal(raw_price), currency)},
                            )
                            price_break.full_clean()
                if any(counts.values()):
                    _mark_inventory_write(capture, "procurement")
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=400)
        except Exception:
            logger.exception("Procurement import failed for capture_id=%s", capture.pk)
            return Response({"detail": "Procurement import failed; the batch was rolled back."}, status=400)
        return Response({"capture_id": capture.pk, "mode": mode, **counts})


class CreateCaptureStockView(APIView):
    """Create stock only after an explicit opt-in, once per capture row."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        if request.data.get("confirm") is not True or request.data.get("enable_stock") is not True:
            return Response({"detail": "Set confirm and enable_stock to true."}, status=400)
        from decimal import Decimal, InvalidOperation
        from djmoney.money import Money
        from part.models import Part
        from stock.models import StockItem, StockLocation
        from users.permissions import check_user_permission
        if not check_user_permission(request.user, StockItem, "add"):
            return Response({"detail": "Stock Item add permission is required."}, status=403)
        capture = _capture_or_404(request, pk)
        created, skipped = [], []
        try:
            plan = _build_live_import_plan(_workflow_items(request, capture))
            if not plan["ready"] or plan["summary"]["create"]:
                return Response({"detail": "Create all Parts and resolve plan errors first.", "rows": plan["rows"]}, status=409)
            with transaction.atomic():
                for row in plan["rows"]:
                    mapped = row["mapped"]
                    raw_quantity = str(mapped.get("stock.quantity") or "").strip()
                    if not raw_quantity:
                        continue
                    if StockImportRecord.objects.filter(capture=capture, row_index=row["row_index"]).exists():
                        skipped.append({"row_index": row["row_index"], "reason": "already imported"})
                        continue
                    try:
                        quantity = Decimal(raw_quantity)
                    except InvalidOperation as exc:
                        raise ValueError(f"Row {row['row_index'] + 1}: invalid quantity.") from exc
                    if quantity <= 0:
                        raise ValueError(f"Row {row['row_index'] + 1}: quantity must be positive.")
                    part = _resolved_part(row, Part)
                    location = StockLocation.objects.get(name__iexact=str(mapped["stock.location"]).strip())
                    if location.structural:
                        raise ValueError(f"Row {row['row_index'] + 1}: location is structural.")
                    item = StockItem(
                        part=part, location=location, quantity=quantity,
                        batch=str(mapped.get("stock.batch") or "").strip(),
                        serial=str(mapped.get("stock.serial") or "").strip() or None,
                        link=str(mapped.get("stock.link") or "").strip() or None,
                        packaging=str(mapped.get("stock.packaging") or "").strip() or None,
                    )
                    if str(mapped.get("stock.status") or "").strip():
                        item.status = int(str(mapped["stock.status"]).strip())
                    if str(mapped.get("stock.purchase_price") or "").strip():
                        item.purchase_price = Money(
                            Decimal(str(mapped["stock.purchase_price"]).strip()),
                            str(mapped.get("stock.price_currency") or "USD").strip().upper(),
                        )
                    item.full_clean()
                    item.save(user=request.user, notes=str(mapped.get("stock.notes") or "").strip())
                    StockImportRecord.objects.create(
                        capture=capture, row_index=row["row_index"],
                        stock_item_id=item.pk, created_by=request.user,
                    )
                    created.append({"row_index": row["row_index"], "stock_item_id": item.pk, "quantity": str(quantity)})
                if created:
                    _mark_inventory_write(capture, "stock")
        except (ValueError, KeyError) as exc:
            return Response({"detail": str(exc)}, status=400)
        except Exception:
            logger.exception("Stock import failed for capture_id=%s", capture.pk)
            return Response({"detail": "Stock creation failed; the batch was rolled back."}, status=400)
        return Response({"capture_id": capture.pk, "created_count": len(created), "created": created,
                         "skipped_count": len(skipped), "skipped": skipped})


class CaptureCleanupView(APIView):
    """List and selectively delete only captures with no inventory writes."""

    permission_classes = [permissions.IsAdminUser]

    def get(self, request):
        return Response({"captures": capture_cleanup_catalog()})

    def post(self, request):
        if request.data.get("confirm") is not True:
            return Response({"detail": "Set confirm to true."}, status=400)
        capture_ids = request.data.get("capture_ids")
        if not isinstance(capture_ids, list) or not capture_ids:
            return Response({"detail": "Select at least one capture."}, status=400)
        try:
            result = cleanup_selected(
                capture_ids, action=str(request.data.get("action") or "")
            )
        except (TypeError, ValueError) as exc:
            return Response({"detail": str(exc)}, status=400)
        return Response(result)


class CapturePinView(APIView):
    """Pin or unpin a capture so scheduled cleanup cannot remove it."""

    permission_classes = [permissions.IsAdminUser]

    def post(self, request, pk):
        if not isinstance(request.data.get("pinned"), bool):
            return Response({"detail": "pinned must be a boolean."}, status=400)
        capture = _capture_or_404(request, pk)
        capture.pinned = request.data["pinned"]
        capture.save(update_fields=["pinned", "updated_at"])
        return Response({"capture_id": capture.pk, "pinned": capture.pinned})


class HealthView(generics.GenericAPIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        return Response({"ok": True, "contract_version": "1.0"})

