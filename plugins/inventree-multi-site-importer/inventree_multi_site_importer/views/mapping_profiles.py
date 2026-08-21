"""CRUD for mapping profiles and mapping-rule preview against raw capture rows."""

from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from ..mapping import preview_rows
from ..models import MappingProfile
from ..selection import select_capture_rows
from ..serializers import MappingProfileSerializer
from .common import _capture_or_404


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
