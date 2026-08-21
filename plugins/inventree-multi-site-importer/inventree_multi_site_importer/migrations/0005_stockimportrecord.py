import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [
        ("inventree_multi_site_importer", "0004_imageprefetch"),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name="StockImportRecord",
            fields=[
                ("id", models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name="ID")),
                ("row_index", models.PositiveIntegerField()),
                ("stock_item_id", models.PositiveBigIntegerField()),
                ("created_at", models.DateTimeField(auto_now_add=True)),
                ("capture", models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name="stock_import_records", to="inventree_multi_site_importer.captureimport")),
                ("created_by", models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, to=settings.AUTH_USER_MODEL)),
            ],
        ),
        migrations.AddConstraint(
            model_name="stockimportrecord",
            constraint=models.UniqueConstraint(fields=("capture", "row_index"), name="unique_capture_stock_row"),
        ),
    ]
