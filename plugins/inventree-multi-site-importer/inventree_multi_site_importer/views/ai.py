import re

from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView
from django.db import DatabaseError, transaction

from ..ai_assistant import build_candidate_matches, normalize_captured_row
from ..models import AIAssistantDecisionLog, AIAssistantLexiconEntry, MappingProfile
from ..selection import select_capture_rows
from .common import _capture_or_404, logger

_AI_LEXICON_CATEGORIES = {
    "type",
    "drive",
    "material",
    "finish",
}


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
    from ..mapping import map_row

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
