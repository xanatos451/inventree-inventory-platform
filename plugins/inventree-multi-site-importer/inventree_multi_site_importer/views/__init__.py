"""API and browser views for the multi-site importer, split by capture workflow stage."""

from .ai import CaptureCandidatesView, CaptureDecisionsView, CaptureNormalizeView
from .captures import (
    CaptureCleanupView,
    CaptureDatasetRowsView,
    CaptureDetailView,
    CaptureFieldInspectionView,
    CaptureListCreateView,
    CapturePinView,
    CaptureWorkspaceView,
)
from .creation import CreateCaptureCategoriesView, CreateCapturePartsView
from .details import ImportCapturePartDetailsView
from .gallery import PartImageGalleryView
from .health import HealthView
from .images import CaptureImagePrefetchView, ExcludeCapturePrefetchFailuresView
from .import_plan import ImportPlanView
from .mapping_profiles import (
    MappingPreviewView,
    MappingProfileDetailView,
    MappingProfileListCreateView,
)
from .procurement import CreateCaptureStockView, ImportCaptureProcurementView

__all__ = [
    "CaptureCandidatesView",
    "CaptureCleanupView",
    "CaptureDatasetRowsView",
    "CaptureDecisionsView",
    "CaptureDetailView",
    "CaptureFieldInspectionView",
    "CaptureImagePrefetchView",
    "CaptureListCreateView",
    "CaptureNormalizeView",
    "CapturePinView",
    "CaptureWorkspaceView",
    "CreateCaptureCategoriesView",
    "CreateCapturePartsView",
    "CreateCaptureStockView",
    "ExcludeCapturePrefetchFailuresView",
    "HealthView",
    "ImportCapturePartDetailsView",
    "ImportCaptureProcurementView",
    "ImportPlanView",
    "MappingPreviewView",
    "MappingProfileDetailView",
    "MappingProfileListCreateView",
    "PartImageGalleryView",
]
