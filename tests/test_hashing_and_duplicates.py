from __future__ import annotations

import shutil
from datetime import date
from pathlib import Path

from policy_evidence_ledger.schemas import (
    IngestMode,
    MetadataStatus,
    SourceCreate,
    SourceType,
)
from policy_evidence_ledger.storage import LedgerStore, sha256_bytes


def source(url: str) -> SourceCreate:
    return SourceCreate(
        title="Official rule",
        author_institution="Public institution",
        publication_date=date(2024, 1, 2),
        source_type=SourceType.GOVERNMENT_RULE,
        url=url,
        access_date=date(2026, 9, 2),
        metadata_status=MetadataStatus.VERIFIED,
        ingest_mode=IngestMode.URL,
    )


def test_source_hash_is_stable_and_sensitive() -> None:
    content = b"authoritative source bytes\n"
    assert sha256_bytes(content) == sha256_bytes(content)
    assert sha256_bytes(content) != sha256_bytes(content + b".")
    assert len(sha256_bytes(content)) == 64


def test_same_hash_is_idempotent_and_records_alias(store: LedgerStore) -> None:
    content = b"same original bytes"
    first = store.add_source(source("https://example.gov/rule"), content, "application/pdf")
    second = store.add_source(source("https://mirror.example.gov/rule"), content, "application/pdf")

    assert second.id == first.id
    assert second.duplicate is True
    assert second.document_hash == sha256_bytes(content)
    with store.connect() as connection:
        aliases = connection.execute(
            "SELECT * FROM source_aliases WHERE source_id = ?", (first.id,)
        ).fetchall()
    assert [row["url"] for row in aliases] == ["https://mirror.example.gov/rule"]
    assert aliases[0]["title"] == "Official rule"
    assert aliases[0]["access_date"] == "2026-09-02"
    assert second.aliases[0].metadata_status == MetadataStatus.VERIFIED


def test_duplicate_upload_without_url_preserves_retrieval_metadata(store: LedgerStore) -> None:
    content = b"same uploaded bytes"
    first = source("https://example.gov/original").model_copy(
        update={"ingest_mode": IngestMode.UPLOAD}
    )
    second = first.model_copy(
        update={
            "url": None,
            "title": "Local archive copy",
            "notes": "Imported from an offline archive.",
        }
    )
    created = store.add_source(first, content, "application/pdf")
    duplicate = store.add_source(second, content, "application/pdf")

    assert duplicate.id == created.id
    assert duplicate.aliases[-1].url is None
    assert duplicate.aliases[-1].title == "Local archive copy"
    assert duplicate.aliases[-1].notes == "Imported from an offline archive."


def test_duplicate_reimport_heals_missing_snapshot(store: LedgerStore) -> None:
    content = b"recoverable source bytes"
    created = store.add_source(source("https://example.gov/rule"), content, "text/plain")
    with store.connect() as connection:
        row = connection.execute(
            "SELECT snapshot_path FROM sources WHERE id = ?", (created.id,)
        ).fetchone()
    assert row is not None
    snapshot = store.blob_dir / row["snapshot_path"]
    snapshot.unlink()

    duplicate = store.add_source(source("https://mirror.example.gov/rule"), content, "text/plain")

    assert duplicate.duplicate is True
    assert snapshot.read_bytes() == content


def test_same_url_with_changed_bytes_creates_a_new_version(store: LedgerStore) -> None:
    first = store.add_source(source("https://example.gov/rule"), b"version one", "text/html")
    second = store.add_source(source("https://example.gov/rule"), b"version two", "text/html")

    assert second.id != first.id
    assert second.document_hash != first.document_hash
    assert second.previous_version_id == first.id
    assert len(store.list_sources()) == 2


def test_url_version_link_is_preserved_when_new_bytes_already_exist(store: LedgerStore) -> None:
    first = store.add_source(source("https://example.gov/rule"), b"version one", "text/html")
    existing = store.add_source(
        source("https://mirror.example.gov/rule"), b"version two", "text/html"
    )

    reused = store.add_source(source("https://example.gov/rule"), b"version two", "text/html")

    assert reused.id == existing.id
    assert reused.previous_version_id == first.id
    with store.connect() as connection:
        link = connection.execute(
            "SELECT * FROM source_version_links WHERE previous_source_id = ? AND source_id = ?",
            (first.id, existing.id),
        ).fetchone()
    assert link is not None


def test_unicode_equivalent_citations_share_a_fingerprint(store: LedgerStore) -> None:
    composed = source("https://example.gov/composed").model_copy(update={"title": "État policy"})
    decomposed = source("https://example.gov/decomposed").model_copy(
        update={"title": "E\u0301TAT policy"}
    )
    created = store.add_source(composed.model_copy(update={"ingest_mode": IngestMode.MANUAL}))

    duplicates = store.citation_duplicates(
        decomposed.model_copy(update={"ingest_mode": IngestMode.MANUAL})
    )

    assert [item.id for item in duplicates] == [created.id]


def test_store_can_be_restored_at_a_new_path_with_snapshot_bytes_intact(tmp_path) -> None:
    original_dir = tmp_path / "original"
    db_path = original_dir / "ledger.sqlite3"
    blob_dir = original_dir / "blobs"
    original = LedgerStore(db_path, blob_dir)
    content = "Policy record — 政策记录\n".encode()
    created = original.add_source(
        source("https://example.gov/unicode-record"), content, "text/plain"
    )
    with original.connect() as connection:
        row = connection.execute(
            "SELECT snapshot_path FROM sources WHERE id = ?", (created.id,)
        ).fetchone()
        assert row is not None
        legacy_absolute = original.blob_dir / row["snapshot_path"]
        connection.execute(
            "UPDATE sources SET snapshot_path = ? WHERE id = ?",
            (str(legacy_absolute), created.id),
        )

    restored_dir = tmp_path / "restored"
    shutil.copytree(original_dir, restored_dir)
    shutil.rmtree(original_dir)
    restored = LedgerStore(restored_dir / "ledger.sqlite3", restored_dir / "blobs")
    loaded = restored.get_source(created.id)
    with restored.connect() as connection:
        row = connection.execute(
            "SELECT snapshot_path FROM sources WHERE id = ?", (created.id,)
        ).fetchone()

    assert loaded.document_hash == sha256_bytes(content)
    assert row is not None
    assert not Path(row["snapshot_path"]).is_absolute()
    assert (restored.blob_dir / row["snapshot_path"]).read_bytes() == content


def test_manual_citation_duplicate_is_warning_only(store: LedgerStore) -> None:
    first = source("https://example.gov/citation").model_copy(
        update={"ingest_mode": IngestMode.MANUAL}
    )
    created = store.add_source(first)

    duplicates = store.citation_duplicates(first)
    second = store.add_source(first)

    assert [item.id for item in duplicates] == [created.id]
    assert second.id != created.id
    assert second.document_hash is None
    assert second.previous_version_id is None
