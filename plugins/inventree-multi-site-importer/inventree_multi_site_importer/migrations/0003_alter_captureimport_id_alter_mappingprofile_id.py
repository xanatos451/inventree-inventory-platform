from django.db import migrations, models


class Migration(migrations.Migration):
    """Canonicalize the historical server-generated primary-key migration."""

    dependencies = [
        ("inventree_multi_site_importer", "0002_capture_profiles"),
    ]

    operations = [
        migrations.AlterField(
            model_name="captureimport",
            name="id",
            field=models.BigAutoField(
                auto_created=True,
                primary_key=True,
                serialize=False,
                verbose_name="ID",
            ),
        ),
        migrations.AlterField(
            model_name="mappingprofile",
            name="id",
            field=models.BigAutoField(
                auto_created=True,
                primary_key=True,
                serialize=False,
                verbose_name="ID",
            ),
        ),
    ]
