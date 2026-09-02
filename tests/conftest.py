from __future__ import annotations

from pathlib import Path

import pytest

from policy_evidence_ledger.storage import LedgerStore


@pytest.fixture
def store(tmp_path: Path) -> LedgerStore:
    return LedgerStore(tmp_path / "ledger.sqlite3", tmp_path / "blobs")
