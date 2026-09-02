from __future__ import annotations

import csv
import hashlib
import io
import json
import sqlite3
import threading
import zipfile
from datetime import UTC, date, datetime

import pytest

from policy_evidence_ledger.exports import ExportBlocked, generate_export_bundle
from policy_evidence_ledger.schemas import (
    ClaimCreate,
    ClaimStatus,
    ComparisonCreate,
    Confidence,
    EvidenceCreate,
    EvidenceKind,
    EvidenceRole,
    IngestMode,
    LocatorType,
    MetadataStatus,
    RelationType,
    ReviewState,
    SourceCreate,
    SourceType,
)
from policy_evidence_ledger.storage import LedgerStore


def build_exportable(
    store: LedgerStore, exact_text: str = "Official, located data point.\nSecond line."
):
    source = store.add_source(
        SourceCreate(
            title="Official source",
            author_institution="Public institution",
            publication_date=date(2024, 1, 1),
            source_type=SourceType.GOVERNMENT_RULE,
            url="https://example.gov/rule",
            access_date=date(2026, 9, 2),
            metadata_status=MetadataStatus.VERIFIED,
            ingest_mode=IngestMode.UPLOAD,
        ),
        b"immutable original bytes",
        "application/pdf",
    )
    claim = store.add_claim(
        ClaimCreate(
            claim_text="The official rule changed the policy.",
            interpretation="This is evidence of legal scope, not implementation effect.",
            confidence=Confidence.HIGH,
            known_limitation="No compliance data are included.",
            status=ClaimStatus.SUPPORTED,
            policy_outcome="Legal scope",
            case_name="Test case",
            time_period="2024",
        )
    )
    evidence = store.add_evidence(
        EvidenceCreate(
            claim_id=claim.id,
            source_id=source.id,
            role=EvidenceRole.SUPPORTING,
            kind=EvidenceKind.DATA_POINT,
            exact_text=exact_text,
            locator_type=LocatorType.PAGE,
            locator="p. 17",
            review_state=ReviewState.APPROVED,
            reviewer_note="Checked by a human.",
        )
    )
    return source, claim, evidence


def unzip(archive: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(archive)) as file:
        return {name: file.read(name) for name in file.namelist()}


def test_export_preserves_citation_and_locator(store: LedgerStore) -> None:
    exact = 'Official, located "data" point.\nSecond line.'
    source, claim, evidence = build_exportable(store, exact)
    generated_at = datetime(2026, 9, 2, 12, 0, tzinfo=UTC)

    archive, _ = generate_export_bundle(store, generated_at)
    files = unzip(archive)
    expected = {
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
    assert set(files) == expected

    row = next(csv.DictReader(io.StringIO(files["evidence.csv"].decode())))
    assert row["exact_source_text_or_data"] == exact
    assert row["locator"] == "p. 17"
    assert row["claim_id"] == claim.id
    assert row["evidence_id"] == evidence.id
    assert row["source_id"] == source.id

    claims_markdown = files["claims.md"].decode()
    assert exact.splitlines()[0] in claims_markdown
    assert "Locator: page — p. 17" in claims_markdown
    assert "data_point" in claims_markdown
    assert "Data point (researcher-entered):" in claims_markdown
    assert "Review note: Checked by a human." in claims_markdown
    assert "### Researcher interpretation" in claims_markdown
    assert "### Known limitation" in claims_markdown

    memo = files["memo-outline.md"].decode()
    assert f"Claim ID: {claim.id}" in memo
    assert f"{evidence.id} → {source.id} (page: p. 17)" in memo

    manifest = json.loads(files["manifest.json"])
    assert manifest["machine_suggestions_included"] is False
    for name, digest in manifest["output_sha256"].items():
        assert hashlib.sha256(files[name]).hexdigest() == digest


def test_export_is_blocked_when_claim_has_no_approved_locator(store: LedgerStore) -> None:
    source = store.add_source(
        SourceCreate(
            title="Official source",
            author_institution="Public institution",
            source_type=SourceType.REPORT,
            url="https://example.gov/report",
            metadata_status=MetadataStatus.VERIFIED,
        )
    )
    claim = store.add_claim(
        ClaimCreate(
            claim_text="A claim without located evidence.",
            interpretation="Not exportable.",
            confidence=Confidence.LOW,
            known_limitation="Missing locator.",
            status=ClaimStatus.UNCLEAR,
            policy_outcome="Test",
        )
    )
    store.add_evidence(
        EvidenceCreate(
            claim_id=claim.id,
            source_id=source.id,
            role=EvidenceRole.SUPPORTING,
            kind=EvidenceKind.PASSAGE,
            exact_text="Draft source text",
            review_state=ReviewState.DRAFT,
        )
    )
    with pytest.raises(ExportBlocked, match="provenance") as raised:
        generate_export_bundle(store)
    assert any("no approved evidence" in issue for issue in raised.value.issues)


def test_export_rechecks_locator_even_if_database_guard_is_bypassed(store: LedgerStore) -> None:
    source, claim, _ = build_exportable(store)
    with store.connect() as connection:
        connection.execute("PRAGMA ignore_check_constraints = ON")
        connection.execute(
            """
            INSERT INTO evidence (
                id, claim_id, source_id, role, kind, exact_text, locator_type,
                locator, review_state, reviewer_note, origin, created_at
            ) VALUES ('EVD-BAD', ?, ?, 'supporting', 'passage', 'bad row', NULL,
                      NULL, 'approved', '', 'human', '2026-09-02T00:00:00+00:00')
            """,
            (claim.id, source.id),
        )
    with pytest.raises(ExportBlocked) as raised:
        generate_export_bundle(store)
    assert "EVD-BAD has no source locator" in raised.value.issues


def test_export_detects_tampered_snapshot(store: LedgerStore) -> None:
    source, _, _ = build_exportable(store)
    with store.connect() as connection:
        row = connection.execute(
            "SELECT snapshot_path FROM sources WHERE id = ?", (source.id,)
        ).fetchone()
    (store.blob_dir / row["snapshot_path"]).write_bytes(b"tampered")
    with pytest.raises(ExportBlocked) as raised:
        generate_export_bundle(store)
    assert any("snapshot hash does not match" in issue for issue in raised.value.issues)


def test_database_itself_rejects_approved_evidence_without_locator(store: LedgerStore) -> None:
    source, claim, _ = build_exportable(store)
    with pytest.raises(sqlite3.IntegrityError), store.connect() as connection:
        connection.execute(
            """
                INSERT INTO evidence (
                    id, claim_id, source_id, role, kind, exact_text,
                    review_state, reviewer_note, origin, created_at
                ) VALUES ('EVD-INVALID', ?, ?, 'supporting', 'passage',
                          'source text', 'approved', '', 'human', '2026-09-02T00:00:00+00:00')
                """,
            (claim.id, source.id),
        )


def test_database_rejects_approved_evidence_with_null_locator(store: LedgerStore) -> None:
    source, claim, _ = build_exportable(store)
    with pytest.raises(sqlite3.IntegrityError), store.connect() as connection:
        connection.execute(
            """
                INSERT INTO evidence (
                    id, claim_id, source_id, role, kind, exact_text, locator_type,
                    locator, review_state, reviewer_note, origin, created_at
                ) VALUES ('EVD-NULL-LOCATOR', ?, ?, 'supporting', 'passage',
                          'source text', 'page', NULL, 'approved', '', 'human',
                          '2026-09-02T00:00:00+00:00')
                """,
            (claim.id, source.id),
        )


def test_export_rejects_captured_source_with_missing_snapshot_path(store: LedgerStore) -> None:
    source, _, _ = build_exportable(store)
    with store.connect() as connection:
        connection.execute("UPDATE sources SET snapshot_path = NULL WHERE id = ?", (source.id,))

    with pytest.raises(ExportBlocked) as raised:
        generate_export_bundle(store)
    assert any("captured source has no snapshot path" in issue for issue in raised.value.issues)


@pytest.mark.parametrize(
    ("statement", "expected_issue"),
    [
        ("UPDATE claims SET claim_text = ''", "invalid claims record data"),
        ("UPDATE evidence SET exact_text = ''", "invalid evidence record data"),
        (
            "UPDATE sources SET publication_date = 'not-a-date'",
            "invalid sources record data",
        ),
        (
            "UPDATE sources SET url = 'https://user:secret@example.com/report'",
            "invalid sources record data",
        ),
        ("UPDATE comparisons SET relation = 'invented'", "invalid relation"),
    ],
)
def test_export_revalidates_direct_database_changes(
    store: LedgerStore, statement: str, expected_issue: str
) -> None:
    source, claim, _evidence = build_exportable(store)
    other = store.add_claim(
        ClaimCreate(
            claim_text="Second claim",
            interpretation="Separate interpretation.",
            confidence=Confidence.MODERATE,
            known_limitation="One record.",
            status=ClaimStatus.CONTESTED,
            policy_outcome="Implementation",
        )
    )
    store.add_evidence(
        EvidenceCreate(
            claim_id=other.id,
            source_id=source.id,
            role=EvidenceRole.SUPPORTING,
            kind=EvidenceKind.DATA_POINT,
            exact_text="Second located data point.",
            locator_type=LocatorType.PAGE,
            locator="p. 18",
            review_state=ReviewState.APPROVED,
        )
    )
    store.add_comparison(
        ComparisonCreate(
            claim_a_id=claim.id,
            claim_b_id=other.id,
            relation=RelationType.DISAGREES,
            rationale="Different findings.",
        )
    )
    with store.connect() as connection:
        connection.execute(statement)

    issues = store.export_issues()
    assert any(expected_issue in issue for issue in issues)
    with pytest.raises(ExportBlocked):
        generate_export_bundle(store)


def test_export_revalidates_duplicate_retrieval_rows(store: LedgerStore) -> None:
    source, _claim, _evidence = build_exportable(store)
    duplicate = SourceCreate(
        title="Mirror citation",
        author_institution="Public institution",
        publication_date=date(2024, 1, 1),
        source_type=SourceType.GOVERNMENT_RULE,
        url="https://mirror.example.gov/rule",
        access_date=date(2026, 9, 3),
        metadata_status=MetadataStatus.PENDING,
        ingest_mode=IngestMode.URL,
    )
    store.add_source(duplicate, b"immutable original bytes", "application/pdf")
    with store.connect() as connection:
        connection.execute(
            "UPDATE source_aliases SET metadata_status = 'bogus', "
            "publication_date = 'not-a-date' WHERE source_id = ?",
            (source.id,),
        )

    assert any("invalid source_aliases record data" in issue for issue in store.export_issues())
    with pytest.raises(ExportBlocked):
        generate_export_bundle(store)


def test_export_rejects_credential_bearing_alias_url(store: LedgerStore) -> None:
    source, _claim, _evidence = build_exportable(store)
    duplicate = SourceCreate(
        title="Mirror citation",
        author_institution="Public institution",
        source_type=SourceType.GOVERNMENT_RULE,
        url="https://mirror.example.gov/rule",
        metadata_status=MetadataStatus.PENDING,
        ingest_mode=IngestMode.URL,
    )
    store.add_source(duplicate, b"immutable original bytes", "application/pdf")
    with store.connect() as connection:
        connection.execute(
            "UPDATE source_aliases SET url = ? WHERE source_id = ?",
            ("https://user:secret@example.com/report", source.id),
        )

    assert any("invalid source_aliases record data" in issue for issue in store.export_issues())
    with pytest.raises(ExportBlocked):
        generate_export_bundle(store)


def test_export_reports_foreign_key_corruption_before_rendering(store: LedgerStore) -> None:
    _source, _claim, evidence = build_exportable(store)
    with sqlite3.connect(store.db_path) as connection:
        connection.execute("PRAGMA foreign_keys = OFF")
        connection.execute(
            "UPDATE evidence SET source_id = 'SRC-MISSING' WHERE id = ?",
            (evidence.id,),
        )

    issues = store.export_issues()
    assert any("evidence row" in issue and "violates foreign key" in issue for issue in issues)
    with pytest.raises(ExportBlocked):
        generate_export_bundle(store)


def test_export_rejects_unsupported_machine_evidence_origin(store: LedgerStore) -> None:
    _source, _claim, evidence = build_exportable(store)
    with store.connect() as connection:
        connection.execute("PRAGMA ignore_check_constraints = ON")
        connection.execute(
            "UPDATE evidence SET origin = 'approved_machine_suggestion' WHERE id = ?",
            (evidence.id,),
        )

    assert any("invalid origin" in issue for issue in store.export_issues())
    with pytest.raises(ExportBlocked):
        generate_export_bundle(store)


def test_export_excludes_aliases_and_versions_for_unreferenced_sources(
    store: LedgerStore,
) -> None:
    build_exportable(store)
    unused = SourceCreate(
        title="Unused source",
        author_institution="Public institution",
        publication_date=date(2025, 1, 1),
        source_type=SourceType.REPORT,
        url="https://example.gov/unused",
        access_date=date(2026, 9, 3),
        metadata_status=MetadataStatus.VERIFIED,
        ingest_mode=IngestMode.URL,
    )
    store.add_source(unused, b"unused version one", "text/plain")
    store.add_source(unused, b"unused version one", "text/plain")
    store.add_source(unused, b"unused version two", "text/plain")

    archive, _ = generate_export_bundle(store, datetime(2026, 9, 3, tzinfo=UTC))
    files = unzip(archive)

    assert list(csv.DictReader(io.StringIO(files["source-aliases.csv"].decode()))) == []
    assert list(csv.DictReader(io.StringIO(files["source-versions.csv"].decode()))) == []


def test_csv_formula_like_source_text_is_escaped(store: LedgerStore) -> None:
    build_exportable(store, "=SUM(1,2)")

    archive, _ = generate_export_bundle(store, datetime(2026, 9, 2, tzinfo=UTC))
    row = next(csv.DictReader(io.StringIO(unzip(archive)["evidence.csv"].decode())))

    assert row["exact_source_text_or_data"] == "'=SUM(1,2)"
    assert row["csv_formula_escaped"] == "true"


@pytest.mark.parametrize("value", [" +1", "\t=1+1", "\r@SUM(A1:A2)"])
def test_csv_formula_like_values_after_whitespace_are_escaped(
    store: LedgerStore, value: str
) -> None:
    build_exportable(store, value)
    archive, _ = generate_export_bundle(store, datetime(2026, 9, 3, tzinfo=UTC))
    row = next(csv.DictReader(io.StringIO(unzip(archive)["evidence.csv"].decode())))

    assert row["exact_source_text_or_data"] == "'" + value
    assert row["csv_formula_escaped"] == "true"


def test_empty_ledger_export_fails_closed(store: LedgerStore) -> None:
    with pytest.raises(ExportBlocked) as raised:
        generate_export_bundle(store, datetime(2026, 9, 3, tzinfo=UTC))
    assert raised.value.issues == ["ledger has no claims"]


def test_export_snapshot_blocks_concurrent_writer_and_reads_one_state(
    store: LedgerStore, monkeypatch
) -> None:
    snapshot_locked = threading.Event()
    release_snapshot = threading.Event()
    writer_started = threading.Event()
    writer_finished = threading.Event()
    result: dict[str, object] = {}
    errors: list[BaseException] = []
    original_export_issues = store.export_issues

    def held_export_issues():
        snapshot_locked.set()
        if not release_snapshot.wait(2):
            raise TimeoutError("test did not release export snapshot")
        return original_export_issues()

    monkeypatch.setattr(store, "export_issues", held_export_issues)

    def export_worker():
        try:
            result["snapshot"] = store.export_snapshot()
        except BaseException as exc:
            errors.append(exc)

    def writer_worker():
        try:
            writer_started.set()
            store.add_claim(
                ClaimCreate(
                    claim_text="Concurrent claim",
                    interpretation="Written after the snapshot.",
                    confidence=Confidence.LOW,
                    known_limitation="Concurrency fixture.",
                    status=ClaimStatus.UNCLEAR,
                    policy_outcome="Test",
                )
            )
            writer_finished.set()
        except BaseException as exc:
            errors.append(exc)

    export_thread = threading.Thread(target=export_worker, daemon=True)
    export_thread.start()
    assert snapshot_locked.wait(2)
    writer_thread = threading.Thread(target=writer_worker, daemon=True)
    writer_thread.start()
    assert writer_started.wait(2)
    writer_completed_while_locked = writer_finished.wait(0.25)
    release_snapshot.set()
    export_thread.join(3)
    writer_thread.join(3)

    assert not export_thread.is_alive()
    assert not writer_thread.is_alive()
    assert errors == []
    assert writer_completed_while_locked is False
    issues, records = result["snapshot"]
    assert issues == ["ledger has no claims"]
    assert records["claims"] == []
    assert len(store.raw_export_rows()["claims"]) == 1


def test_export_is_deterministic_and_markdown_tables_escape_user_text(
    store: LedgerStore,
) -> None:
    source, claim, _ = build_exportable(store, "政策记录 — café")
    with store.connect() as connection:
        connection.execute(
            "UPDATE claims SET case_name = ?, policy_outcome = ? WHERE id = ?",
            ("Case | one\ncontinued", "Outcome | measured", claim.id),
        )
    generated_at = datetime(2026, 9, 3, 12, 30, tzinfo=UTC)

    first, _ = generate_export_bundle(store, generated_at)
    second, _ = generate_export_bundle(store, generated_at)
    files = unzip(first)

    assert first == second
    assert "政策记录 — café" in files["claims.md"].decode()
    assert "Case \\| one<br>continued" in files["case-comparison.md"].decode()
    assert "Outcome \\| measured" in files["case-comparison.md"].decode()
    manifest = json.loads(files["manifest.json"])
    assert manifest["source_hashes"][source.id] == source.document_hash


def test_every_markdown_artifact_neutralizes_active_user_syntax(store: LedgerStore) -> None:
    active_markdown = "![beacon](https://attacker.example/pixel)"
    _source, claim, evidence = build_exportable(store, active_markdown)
    with store.connect() as connection:
        connection.execute(
            "UPDATE evidence SET locator = ? WHERE id = ?",
            (active_markdown, evidence.id),
        )
        connection.execute(
            "UPDATE claims SET interpretation = ? WHERE id = ?",
            ("<img src=https://attacker.example/pixel>", claim.id),
        )

    archive, _ = generate_export_bundle(store, datetime(2026, 9, 3, tzinfo=UTC))
    markdown_files = {
        name: content.decode() for name, content in unzip(archive).items() if name.endswith(".md")
    }

    assert markdown_files
    for content in markdown_files.values():
        assert active_markdown not in content
        assert "<img" not in content
