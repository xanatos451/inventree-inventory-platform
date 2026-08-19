import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from scripts import check_secrets


class CheckSecretsTests(unittest.TestCase):
    def test_source_files_excludes_venv(self):
        with TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            venv_file = root / ".venv" / "Lib" / "site-packages" / "example.py"
            venv_file.parent.mkdir(parents=True)
            venv_file.write_text("sk-short\n", encoding="utf-8")

            project_file = root / "src" / "settings.py"
            project_file.parent.mkdir(parents=True)
            project_file.write_text("SECRET_KEY = 'not_a_real_key'\n", encoding="utf-8")

            with patch.object(check_secrets, "ROOT", root):
                files = list(check_secrets.source_files())

            self.assertEqual(files, [project_file])


if __name__ == "__main__":
    unittest.main()
