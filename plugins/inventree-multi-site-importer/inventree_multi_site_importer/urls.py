from django.urls import path

from .views import CaptureDetailView, CaptureFieldInspectionView, CaptureListCreateView, CaptureWorkspaceView, CreateCaptureCategoriesView, HealthView, ImportPlanView, MappingPreviewView, MappingProfileDetailView, MappingProfileListCreateView

urlpatterns = [
    path("health/", HealthView.as_view(), name="health"),
    path("captures/", CaptureListCreateView.as_view(), name="captures"),
    path("captures/<int:pk>/", CaptureDetailView.as_view(), name="capture-detail"),
    path("captures/<int:pk>/preview/", MappingPreviewView.as_view(), name="capture-preview"),
    path("captures/<int:pk>/plan/", ImportPlanView.as_view(), name="capture-plan"),
    path("captures/<int:pk>/categories/", CreateCaptureCategoriesView.as_view(), name="capture-create-categories"),
    path("captures/<int:pk>/fields/", CaptureFieldInspectionView.as_view(), name="capture-fields"),
    path("captures/<int:pk>/workspace/", CaptureWorkspaceView.as_view(), name="capture-workspace"),
    path("mapping-profiles/", MappingProfileListCreateView.as_view(), name="mapping-profiles"),
    path("mapping-profiles/<int:pk>/", MappingProfileDetailView.as_view(), name="mapping-profile-detail"),
]
