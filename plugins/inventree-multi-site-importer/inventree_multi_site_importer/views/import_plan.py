"""Read-only import plan preview against live InvenTree part/category/supplier identifiers."""

from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from ..models import MappingProfile
from .common import _build_live_import_plan, _capture_or_404, _mapped_capture_items, logger


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
