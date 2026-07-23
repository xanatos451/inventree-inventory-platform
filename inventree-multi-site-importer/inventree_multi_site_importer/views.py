from rest_framework import generics, permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView
from django.shortcuts import render
from django.db import transaction

from .models import CaptureImport, MappingProfile
from .mapping import map_row, preview_rows
from .planning import build_import_plan
from .inspection import display_value, field_catalog, inspect_field, ordered_fields
from .serializers import CaptureImportSerializer, MappingProfileSerializer


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
            items = preview_rows(capture.payload.get("rows", []), rules)
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response({
            "capture_id": capture.pk,
            "profile_id": profile.pk if profile else None,
            "row_count": capture.row_count,
            "preview_count": len(items),
            "items": items,
        })


class ImportPlanView(APIView):
    """Build a read-only plan against current InvenTree part identifiers."""

    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, pk):
        from functools import lru_cache

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
            mapped_items = [map_row(row, rules) for row in capture.payload.get("rows", [])]
        except ValueError as exc:
            return Response({"detail": str(exc)}, status=status.HTTP_400_BAD_REQUEST)

        try:
            from company.models import SupplierPart
            from part.models import Part, PartCategory

            @lru_cache(maxsize=2000)
            def part_lookup(identifier):
                return list(
                    Part.objects.filter(IPN__iexact=identifier)
                    .values("pk", "IPN", "name")[:5]
                )

            @lru_cache(maxsize=2000)
            def supplier_lookup(identifier):
                return list(
                    SupplierPart.objects.filter(SKU__iexact=identifier)
                    .values("pk", "SKU", "part_id", "supplier_id")[:5]
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

            plan = build_import_plan(
                mapped_items,
                part_lookup,
                supplier_lookup,
                category_lookup,
            )
        except Exception as exc:
            return Response(
                {"detail": f"Could not query existing InvenTree identifiers: {exc}"},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        return Response({
            "capture_id": capture.pk,
            "profile_id": profile.pk if profile else None,
            **plan,
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
        except Exception as exc:
            return Response(
                {"detail": f"Could not load InvenTree category permissions: {exc}"},
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
            mapped_items = [map_row(row, rules) for row in capture.payload.get("rows", [])]
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
        except Exception as exc:
            return Response(
                {"detail": f"Could not create InvenTree categories: {exc}"},
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
