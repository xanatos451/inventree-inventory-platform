from django.db import migrations, models
from django.utils import timezone


def protect_legacy_captures(apps, schema_editor):
    CaptureImport = apps.get_model("inventree_multi_site_importer", "CaptureImport")
    CaptureImport.objects.filter(status="complete").update(
        inventory_written_at=timezone.now(),
        imported_stages=["legacy-complete"],
    )
    # Older detail-only imports did not change capture status, so pin every
    # remaining legacy capture until an administrator explicitly reviews it.
    CaptureImport.objects.exclude(status="complete").update(pinned=True)


class Migration(migrations.Migration):
    dependencies = [
        ("inventree_multi_site_importer", "0005_stockimportrecord"),
    ]

    operations = [
        migrations.AddField(
            model_name="captureimport",
            name="inventory_written_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="captureimport",
            name="imported_stages",
            field=models.JSONField(blank=True, default=list),
        ),
        migrations.AddField(
            model_name="captureimport",
            name="pinned",
            field=models.BooleanField(default=False),
        ),
        migrations.RunPython(
            protect_legacy_captures,
            migrations.RunPython.noop,
        ),
    ]
