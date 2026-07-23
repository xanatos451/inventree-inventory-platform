"""Build and verify the distributable InvenTree plugin wheel."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ROOT = PLUGIN_ROOT.parent
ARTIFACT_ROOT = WORKSPACE_ROOT / ".artifacts"
REQUIRED_WHEEL_FILES = {
    "inventree_multi_site_importer/planning.py",
    "inventree_multi_site_importer/migrations/0001_initial.py",
    "inventree_multi_site_importer/migrations/0002_capture_profiles.py",
    "inventree_multi_site_importer/templates/inventree_multi_site_importer/capture_workspace.html",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=ARTIFACT_ROOT / "plugin",
        help="Wheel output directory (default: workspace .artifacts/plugin directory).",
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help="Remove the selected output directory before building.",
    )
    return parser.parse_args()


def checked_output_dir(raw_path: Path) -> Path:
    candidate = raw_path if raw_path.is_absolute() else PLUGIN_ROOT / raw_path
    output = candidate.expanduser().resolve()
    allowed = (
        output != PLUGIN_ROOT
        and output != WORKSPACE_ROOT
        and (PLUGIN_ROOT in output.parents or ARTIFACT_ROOT in output.parents or output == ARTIFACT_ROOT)
    )
    if not allowed:
        raise SystemExit("Output directory must be under the plugin project or workspace .artifacts directory.")
    return output


def verify_wheel(wheel: Path) -> None:
    with zipfile.ZipFile(wheel) as archive:
        names = set(archive.namelist())
    missing = sorted(REQUIRED_WHEEL_FILES - names)
    if missing:
        raise SystemExit(f"Wheel is missing required files: {', '.join(missing)}")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    args = parse_args()
    output = checked_output_dir(args.output_dir)
    if args.clean and output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True, exist_ok=True)

    try:
        subprocess.run(
            [
                sys.executable,
                "-m",
                "pip",
                "wheel",
                "--no-deps",
                "--wheel-dir",
                str(output),
                str(PLUGIN_ROOT),
            ],
            cwd=PLUGIN_ROOT,
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        return exc.returncode

    wheels = sorted(output.glob("inventree_multi_site_importer-*.whl"), key=lambda item: item.stat().st_mtime)
    if not wheels:
        raise SystemExit(f"Build completed without producing a wheel in {output}")
    wheel = wheels[-1]
    verify_wheel(wheel)

    for transient in (PLUGIN_ROOT / "build", PLUGIN_ROOT / "inventree_multi_site_importer.egg-info"):
        if transient.exists():
            shutil.rmtree(transient)

    print("\nVerified plugin package")
    print(f"Wheel: {wheel}")
    print(f"Size: {wheel.stat().st_size} bytes")
    print(f"SHA256: {sha256(wheel)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
