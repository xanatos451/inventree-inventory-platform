from django.db import migrations, models


class Migration(migrations.Migration):
    """Merge the historical generated-ID branch with importer feature migrations."""

    dependencies = [
        (
            "inventree_multi_site_importer",
            "0005_alter_captureimport_id_alter_imageprefetch_id_and_more",
        ),
        ("inventree_multi_site_importer", "0006_capture_retention"),
    ]

    operations = [
        migrations.AlterField(
            model_name="stockimportrecord",
            name="id",
            field=models.AutoField(
                auto_created=True,
                primary_key=True,
                serialize=False,
                verbose_name="ID",
            ),
        ),
    ]
