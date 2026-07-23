from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [("inventree_multi_site_importer", "0001_initial")]

    operations = [
        migrations.AddField(
            model_name="captureimport",
            name="capture_profile",
            field=models.CharField(default="auto", max_length=80),
        ),
        migrations.AddField(
            model_name="mappingprofile",
            name="capture_profile",
            field=models.CharField(blank=True, max_length=80),
        ),
        migrations.AddField(
            model_name="mappingprofile",
            name="priority",
            field=models.IntegerField(default=100),
        ),
        migrations.AlterModelOptions(
            name="mappingprofile",
            options={"ordering": ["priority", "name", "pk"]},
        ),
    ]
