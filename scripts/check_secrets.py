"""Fail when source files contain common credential material or secret-bearing files."""

from __future__ import annotations

from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parents[1]
EXCLUDED_PARTS = {
    ".git", ".artifacts", "node_modules", "__pycache__", "build", "dist",
    "playwright-report", "test-results",
}
SENSITIVE_NAMES = re.compile(
    r"(?i)(^\.env(?:\..+)?$|\.(?:pem|key|pfx|p12|crx|har|sqlite|sqlite3|db)$|"
    r"^(?:id_rsa|id_ed25519|credentials|secrets?|tokens?)$)"
)
PATTERNS = {
    "private key or certificate": re.compile(rb"BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY|BEGIN CERTIFICATE"),
    "GitHub token": re.compile(rb"(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})"),
    "AWS access key": re.compile(rb"AKIA[0-9A-Z]{16}"),
    "Google API key": re.compile(rb"AIza[0-9A-Za-z_-]{30,}"),
    "OpenAI-style secret": re.compile(rb"sk-[A-Za-z0-9_-]{20,}"),
    "Slack token": re.compile(rb"xox[baprs]-[A-Za-z0-9-]{10,}"),
    "credential assignment": re.compile(
        rb"(?i)(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|"
        rb"client[_-]?secret|secret[_-]?key)\s*[:=]\s*['\"][^'\"\r\n]{16,}['\"]"
    ),
}


def source_files():
    for path in ROOT.rglob("*"):
        if path.resolve() == Path(__file__).resolve():
            continue
        if not path.is_file() or any(part in EXCLUDED_PARTS for part in path.relative_to(ROOT).parts):
            continue
        yield path


def main() -> int:
    findings = []
    for path in source_files():
        relative = path.relative_to(ROOT)
        if SENSITIVE_NAMES.search(path.name):
            findings.append((str(relative), "sensitive filename"))
            continue
        try:
            data = path.read_bytes()
        except OSError as exc:
            findings.append((str(relative), f"could not read: {exc}"))
            continue
        if b"\x00" in data[:4096]:
            continue
        for label, pattern in PATTERNS.items():
            if pattern.search(data):
                findings.append((str(relative), label))

    if findings:
        print("Potential secret material found (values intentionally suppressed):", file=sys.stderr)
        for filename, label in findings:
            print(f"- {filename}: {label}", file=sys.stderr)
        return 1
    print("Secret scan passed: no sensitive filenames or recognized credential patterns in source.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
