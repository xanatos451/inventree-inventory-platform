from django.conf import settings
from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    initial = True
    dependencies = [migrations.swappable_dependency(settings.AUTH_USER_MODEL)]

    operations = [
        migrations.CreateModel(
            name="MappingProfile",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("name", models.CharField(max_length=200)),
                ("source", models.CharField(blank=True, max_length=80)),
                ("page_type", models.CharField(blank=True, max_length=120)),
                ("host_pattern", models.CharField(blank=True, max_length=255)),
                ("path_pattern", models.CharField(blank=True, max_length=500)),
                ("rules", models.JSONField(default=dict)),
                ("is_active", models.BooleanField(default=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("created_by", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="supplier_mapping_profiles_created", to=settings.AUTH_USER_MODEL)),
            ],
            options={"ordering": ["name", "pk"]},
        ),
        migrations.CreateModel(
            name="CaptureImport",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("contract_version", models.CharField(default="1.0", max_length=20)),
                ("source", models.CharField(max_length=80)),
                ("page_type", models.CharField(blank=True, max_length=120)),
                ("page_title", models.CharField(blank=True, max_length=500)),
                ("page_url", models.URLField(max_length=2000)),
                ("captured_at", models.DateTimeField()),
                ("payload", models.JSONField()),
                ("row_count", models.PositiveIntegerField(default=0)),
                ("status", models.CharField(choices=[("queued", "Queued"), ("mapped", "Mapped"), ("importing", "Importing"), ("complete", "Complete"), ("failed", "Failed")], default="queued", max_length=20)),
                ("error", models.TextField(blank=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
                ("profile", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="captures", to="inventree_multi_site_importer.mappingprofile")),
                ("submitted_by", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name="supplier_captures_submitted", to=settings.AUTH_USER_MODEL)),
            ],
            options={"ordering": ["-created_at"]},
        ),
    ]
