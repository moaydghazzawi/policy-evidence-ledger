from __future__ import annotations

import re
import subprocess
import sys
from pathlib import Path

BLOCKED_SUFFIXES = {
    ".csv",
    ".db",
    ".docm",
    ".docx",
    ".htm",
    ".html",
    ".key",
    ".p12",
    ".pdf",
    ".pem",
    ".pfx",
    ".pptx",
    ".sqlite",
    ".sqlite-journal",
    ".sqlite-shm",
    ".sqlite-wal",
    ".sqlite3",
    ".sqlite3-journal",
    ".sqlite3-shm",
    ".sqlite3-wal",
    ".tsv",
    ".txt",
    ".xls",
    ".xlsx",
    ".zip",
    ".db-journal",
    ".db-shm",
    ".db-wal",
}
BLOCKED_NAMES = {
    ".env",
}
EXPORTED_BUNDLE_NAMES = {
    "bibliography.md",
    "case-comparison.csv",
    "case-comparison.md",
    "claims.md",
    "contradiction-matrix.csv",
    "contradiction-matrix.md",
    "evidence.csv",
    "manifest.json",
    "memo-outline.md",
    "source-aliases.csv",
    "source-versions.csv",
}
SECRET_PATTERNS = {
    "GitHub token": re.compile(rb"(?:ghp|github_pat)_[A-Za-z0-9_]{20,}"),
    "OpenAI-style key": re.compile(rb"\bsk-[A-Za-z0-9_-]{20,}"),
    "AWS access key": re.compile(rb"\bAKIA[0-9A-Z]{16}\b"),
    "private key": re.compile(rb"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
}
MAX_FILE_BYTES = 10 * 1024 * 1024


def candidate_files(root: Path) -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "-co", "--exclude-standard", "-z"],
        cwd=root,
        check=True,
        capture_output=True,
    )
    return [root / item.decode() for item in result.stdout.split(b"\0") if item]


def indexed_files(root: Path) -> list[tuple[Path, bytes | None]]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=root,
        check=True,
        capture_output=True,
    )
    indexed: list[tuple[Path, bytes | None]] = []
    for item in result.stdout.split(b"\0"):
        if not item:
            continue
        relative = Path(item.decode())
        blob = subprocess.run(
            ["git", "show", f":{relative.as_posix()}"],
            cwd=root,
            check=False,
            capture_output=True,
        )
        indexed.append((relative, blob.stdout if blob.returncode == 0 else None))
    return indexed


def path_issue(relative: Path) -> str | None:
    lower_name = relative.name.casefold()
    lower_parts = {part.casefold() for part in relative.parts[:-1]}
    looks_like_source_blob = "blobs" in lower_parts
    looks_like_environment_file = (
        lower_name == ".env"
        or lower_name.startswith(".env.")
        or lower_name.endswith(".env")
        or lower_name in {".envrc", ".flaskenv"}
    ) and relative.as_posix() != ".env.example"
    looks_like_unpacked_export = (
        lower_name in EXPORTED_BUNDLE_NAMES
        and relative.as_posix().casefold() != "demo/manifest.json"
    )
    if looks_like_source_blob:
        return f"content-addressed source blob: {relative}"
    if looks_like_environment_file:
        return f"environment file: {relative}"
    if looks_like_unpacked_export:
        return f"generated research export: {relative}"
    if relative.suffix.casefold() in BLOCKED_SUFFIXES or lower_name in BLOCKED_NAMES:
        return f"blocked file type or name: {relative}"
    return None


def content_issues(relative: Path, content: bytes, location: str) -> list[str]:
    issues: list[str] = []
    label = f"{relative} ({location})"
    size = len(content)
    if size > MAX_FILE_BYTES:
        return [f"unexpected file larger than 10 MB: {label} ({size} bytes)"]
    if size == 0:
        return []
    for secret_label, pattern in SECRET_PATTERNS.items():
        if pattern.search(content):
            issues.append(f"possible {secret_label}: {label}")
    return issues


def audit(root: Path) -> list[str]:
    issues: list[str] = []
    worktree = candidate_files(root)
    index = indexed_files(root)
    relatives = {path.relative_to(root) for path in worktree}
    relatives.update(relative for relative, _content in index)
    blocked: set[Path] = set()
    for relative in sorted(relatives):
        issue = path_issue(relative)
        if issue:
            issues.append(issue)
            blocked.add(relative)

    for path in worktree:
        relative = path.relative_to(root)
        if relative in blocked:
            continue
        if not path.is_file():
            continue
        try:
            content = path.read_bytes()
        except OSError:
            issues.append(f"could not read worktree file: {relative}")
            continue
        issues.extend(content_issues(relative, content, "worktree"))

    for relative, content in index:
        if relative in blocked:
            continue
        if content is None:
            issues.append(f"could not read indexed file: {relative}")
            continue
        issues.extend(content_issues(relative, content, "index"))
    return list(dict.fromkeys(issues))


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    issues = audit(root)
    if issues:
        print("Tracked-file audit failed:")
        for issue in issues:
            print(f"- {issue}")
        return 1
    print(
        "Tracked-file audit passed: no blocked research-file type, generated research "
        "export, runtime database, source-blob path, or common credential pattern found "
        "in the worktree or Git index."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
