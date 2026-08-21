from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("inventree_multi_site_importer", "0007_merge_0005_generated_0006_capture_retention"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="AIAssistantDecisionLog",
            fields=[
                ("id", models.AutoField(primary_key=True, serialize=False)),
                ("row_index", models.PositiveIntegerField(blank=True, null=True)),
                ("suggestion_type", models.CharField(default="mapping", max_length=40)),
                (
                    "action",
                    models.CharField(
                        choices=[
                            ("accepted", "Accepted"),
                            ("rejected", "Rejected"),
                            ("edited", "Edited"),
                        ],
                        max_length=20,
                    ),
                ),
                ("target", models.CharField(blank=True, max_length=255)),
                ("suggested_value", models.TextField(blank=True)),
                ("applied_value", models.TextField(blank=True)),
                ("confidence", models.FloatField(blank=True, null=True)),
                ("rationale", models.TextField(blank=True)),
                ("payload", models.JSONField(blank=True, default=dict)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                (
                    "capture",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=models.SET_NULL,
                        related_name="ai_decisions",
                        to="inventree_multi_site_importer.captureimport",
                    ),
                ),
                (
                    "decided_by",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=models.SET_NULL,
                        related_name="supplier_ai_decisions",
                        to=settings.AUTH_USER_MODEL,
                    ),
                ),
            ],
            options={
                "ordering": ["-created_at", "-pk"],
            },
        ),
        migrations.CreateModel(
            name="AIAssistantLexiconEntry",
            fields=[
                ("id", models.AutoField(primary_key=True, serialize=False)),
                (
                    "category",
                    models.CharField(
                        choices=[
                            ("type", "Type"),
                            ("drive", "Drive"),
                            ("material", "Material"),
                            ("finish", "Finish"),
                        ],
                        max_length=20,
                    ),
                ),
                ("term", models.CharField(max_length=255)),
                ("canonical_value", models.CharField(max_length=255)),
                ("source", models.CharField(default="decision", max_length=40)),
                ("approved_count", models.PositiveIntegerField(default=0)),
                ("rejected_count", models.PositiveIntegerField(default=0)),
                ("confidence", models.FloatField(default=0.5)),
                ("is_active", models.BooleanField(default=True)),
                ("last_seen_at", models.DateTimeField(auto_now=True)),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("updated_at", models.DateTimeField(auto_now=True)),
            ],
            options={
                "ordering": ["category", "-approved_count", "term", "pk"],
                "constraints": [
                    models.UniqueConstraint(
                        fields=("category", "term"),
                        name="unique_ai_lexicon_category_term",
                    )
                ],
            },
        ),
    ]
