from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView
from django.shortcuts import render

from ..inspection import display_value, field_catalog, inspect_field, ordered_fields
from ..serializers import CaptureImportSerializer
from ..cleanup import capture_cleanup_catalog, cleanup_selected
from .common import _capture_queryset_for_request, _capture_or_404


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
