from django.urls import path

from .views import CaptureDatasetRowsView, CaptureDetailView, CaptureFieldInspectionView, CaptureImagePrefetchView, CaptureListCreateView, CaptureWorkspaceView, CreateCaptureCategoriesView, CreateCapturePartsView, ExcludeCapturePrefetchFailuresView, HealthView, ImportCapturePartDetailsView, ImportPlanView, MappingPreviewView, MappingProfileDetailView, MappingProfileListCreateView

urlpatterns = [
    path("health/", HealthView.as_view(), name="health"),
    path("captures/", CaptureListCreateView.as_view(), name="captures"),
    path("captures/<int:pk>/", CaptureDetailView.as_view(), name="capture-detail"),
    path("captures/<int:pk>/preview/", MappingPreviewView.as_view(), name="capture-preview"),
    path("captures/<int:pk>/plan/", ImportPlanView.as_view(), name="capture-plan"),
    path("captures/<int:pk>/categories/", CreateCaptureCategoriesView.as_view(), name="capture-create-categories"),
    path("captures/<int:pk>/parts/", CreateCapturePartsView.as_view(), name="capture-create-parts"),
    path("captures/<int:pk>/details/", ImportCapturePartDetailsView.as_view(), name="capture-import-details"),
    path("captures/<int:pk>/images/prefetch/", CaptureImagePrefetchView.as_view(), name="capture-image-prefetch"),
    path("captures/<int:pk>/images/exclude-failures/", ExcludeCapturePrefetchFailuresView.as_view(), name="capture-image-exclude-failures"),
    path("captures/<int:pk>/fields/", CaptureFieldInspectionView.as_view(), name="capture-fields"),
    path("captures/<int:pk>/rows/", CaptureDatasetRowsView.as_view(), name="capture-dataset-rows"),
    path("captures/<int:pk>/workspace/", CaptureWorkspaceView.as_view(), name="capture-workspace"),
    path("mapping-profiles/", MappingProfileListCreateView.as_view(), name="mapping-profiles"),
    path("mapping-profiles/<int:pk>/", MappingProfileDetailView.as_view(), name="mapping-profile-detail"),
]
