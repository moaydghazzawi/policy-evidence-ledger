from __future__ import annotations

import importlib.util
import subprocess
from pathlib import Path

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "audit_tracked_files.py"
SPEC = importlib.util.spec_from_file_location("audit_tracked_files", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
audit_module = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit_module)


def test_audit_rejects_runtime_and_export_artifacts(tmp_path: Path, monkeypatch) -> None:
    blocked = [
        tmp_path / "instance" / "blobs" / "ab" / "private-copy.tmp",
        tmp_path / "ledger.sqlite3-journal",
        tmp_path / "policy-evidence-ledger-2026-09-03.zip",
        tmp_path / "unpacked" / "claims.md",
        tmp_path / ".env.local",
        tmp_path / ".envrc",
        tmp_path / ".flaskenv",
        tmp_path / "settings.env",
    ]
    allowed = [tmp_path / "demo" / "manifest.json", tmp_path / ".env.example"]
    for path in [*blocked, *allowed]:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"public fixture")

    monkeypatch.setattr(
        audit_module,
        "candidate_files",
        lambda _root: [*blocked, *allowed],
    )
    monkeypatch.setattr(audit_module, "indexed_files", lambda _root: [])

    issues = audit_module.audit(tmp_path)

    assert len(issues) == len(blocked)
    assert any("source blob" in issue for issue in issues)
    assert any("sqlite3-journal" in issue for issue in issues)
    assert any(".zip" in issue for issue in issues)
    assert any("generated research export" in issue for issue in issues)
    assert any(".env.local" in issue for issue in issues)
    assert any(".envrc" in issue for issue in issues)
    assert any(".flaskenv" in issue for issue in issues)
    assert any("settings.env" in issue for issue in issues)
    assert all("demo/manifest.json" not in issue for issue in issues)
    assert all(".env.example" not in issue for issue in issues)


def test_audit_reads_staged_bytes_separately_from_worktree(tmp_path: Path) -> None:
    subprocess.run(["git", "init", "-q"], cwd=tmp_path, check=True)
    target = tmp_path / "config.js"
    target.write_bytes(b"const token = '" + b"gh" + b"p_" + (b"A" * 24) + b"';\n")
    subprocess.run(["git", "add", "config.js"], cwd=tmp_path, check=True)
    target.write_text("export const safe = true;\n")

    issues = audit_module.audit(tmp_path)

    assert any("possible GitHub token" in issue and "(index)" in issue for issue in issues)
