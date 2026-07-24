from django.conf import settings
from django.db import models
from django.db.models.signals import post_delete
from django.dispatch import receiver


class MappingProfile(models.Model):
    """Reusable, server-owned transformation rules for a capture scope."""

    name = models.CharField(max_length=200)
    source = models.CharField(max_length=80, blank=True)
    capture_profile = models.CharField(max_length=80, blank=True)
    page_type = models.CharField(max_length=120, blank=True)
    host_pattern = models.CharField(max_length=255, blank=True)
    path_pattern = models.CharField(max_length=500, blank=True)
    rules = models.JSONField(default=dict)
    is_active = models.BooleanField(default=True)
    priority = models.IntegerField(default=100)
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="supplier_mapping_profiles_created",
    )
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = "inventree_multi_site_importer"
        ordering = ["priority", "name", "pk"]

    def __str__(self):
        return self.name


class CaptureImport(models.Model):
    """Immutable browser capture plus server-side processing state."""

    class Status(models.TextChoices):
        QUEUED = "queued", "Queued"
        MAPPED = "mapped", "Mapped"
        IMPORTING = "importing", "Importing"
        COMPLETE = "complete", "Complete"
        FAILED = "failed", "Failed"

    contract_version = models.CharField(max_length=20, default="1.0")
    capture_profile = models.CharField(max_length=80, default="auto")
    source = models.CharField(max_length=80)
    page_type = models.CharField(max_length=120, blank=True)
    page_title = models.CharField(max_length=500, blank=True)
    page_url = models.URLField(max_length=2000)
    captured_at = models.DateTimeField()
    payload = models.JSONField()
    row_count = models.PositiveIntegerField(default=0)
    status = models.CharField(max_length=20, choices=Status.choices, default=Status.QUEUED)
    profile = models.ForeignKey(
        MappingProfile,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="captures",
    )
    submitted_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="supplier_captures_submitted",
    )
    error = models.TextField(blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = "inventree_multi_site_importer"
        ordering = ["-created_at"]

    def __str__(self):
        return f"{self.source} capture #{self.pk} ({self.row_count} rows)"


def image_prefetch_upload_to(instance, filename):
    return f"multi-site-importer/prefetch/{instance.capture_id}/{filename}"


class ImagePrefetch(models.Model):
    """Capture-scoped cached image and its validation state."""

    class Status(models.TextChoices):
        READY = "ready", "Ready"
        FAILED = "failed", "Failed"
        EXCLUDED = "excluded", "Excluded"

    capture = models.ForeignKey(
        CaptureImport,
        on_delete=models.CASCADE,
        related_name="image_prefetches",
    )
    url = models.URLField(max_length=2000)
    status = models.CharField(max_length=20, choices=Status.choices)
    cached_file = models.FileField(
        upload_to=image_prefetch_upload_to,
        blank=True,
        null=True,
    )
    original_filename = models.CharField(max_length=255, blank=True)
    content_type = models.CharField(max_length=100, blank=True)
    file_size = models.PositiveBigIntegerField(default=0)
    error = models.CharField(max_length=500, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = "inventree_multi_site_importer"
        ordering = ["url", "pk"]
        constraints = [
            models.UniqueConstraint(
                fields=["capture", "url"],
                name="unique_capture_prefetch_url",
            )
        ]

    def __str__(self):
        return f"{self.capture_id}: {self.status} {self.url}"


@receiver(post_delete, sender=ImagePrefetch)
def delete_image_prefetch_file(sender, instance, **kwargs):
    if instance.cached_file:
        instance.cached_file.delete(save=False)
