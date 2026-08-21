import django.db.models.deletion
from django.db import migrations, models

import inventree_multi_site_importer.models


class Migration(migrations.Migration):
    dependencies = [
        (
            "inventree_multi_site_importer",
            "0003_alter_captureimport_id_alter_mappingprofile_id",
        ),
    ]

    operations = [
        migrations.CreateModel(
            name="ImagePrefetch",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True,
                        primary_key=True,
                        serialize=False,
                        verbose_name="ID",
                    ),
                ),
                ("url", models.URLField(max_length=2000)),
                (
                    "status",
                    models.CharField(
                        choices=[
                            ("ready", "Ready"),
                            ("failed", "Failed"),
                            ("excluded", "Excluded"),
                        ],
                        max_length=20,
                    ),
                ),
                (
                    "cached_file",
                    models.FileField(
                        blank=True,
                        null=True,
                        upload_to=inventree_multi_site_importer.models.image_prefetch_upload_to,
                    ),
                ),
                ("original_filename", models.CharField(blank=True, max_length=255)),
                ("content_type", models.CharField(blank=True, max_length=100)),
                ("file_size", models.PositiveBigIntegerField(default=0)),
                ("error", models.CharField(blank=True, max_length=500)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                (
                    "capture",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="image_prefetches",
                        to="inventree_multi_site_importer.captureimport",
                    ),
                ),
            ],
            options={"ordering": ["url", "pk"]},
        ),
        migrations.AddConstraint(
            model_name="imageprefetch",
            constraint=models.UniqueConstraint(
                fields=("capture", "url"),
                name="unique_capture_prefetch_url",
            ),
        ),
    ]
