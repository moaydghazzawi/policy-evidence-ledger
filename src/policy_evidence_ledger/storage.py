from __future__ import annotations

import hashlib
import json
import sqlite3
import unicodedata
import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, date, datetime
from pathlib import Path

from pydantic import ValidationError

from .schemas import (
    ClaimCreate,
    ClaimStatus,
    ClaimView,
    ComparisonCreate,
    Confidence,
    DashboardView,
    DecisionCreate,
    DecisionEntityType,
    DefinitionCreate,
    DefinitionVersionView,
    EvidenceApproval,
    EvidenceCreate,
    EvidenceKind,
    EvidenceRole,
    EvidenceView,
    IngestMode,
    LocatorType,
    MetadataStatus,
    RelationType,
    ReviewState,
    SourceAliasView,
    SourceCreate,
    SourceType,
    SourceVersionView,
    SourceView,
)

SCHEMA = """
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    author_institution TEXT NOT NULL,
    publication_date TEXT,
    source_type TEXT NOT NULL,
    url TEXT,
    access_date TEXT NOT NULL,
    document_hash TEXT,
    metadata_status TEXT NOT NULL,
    ingest_mode TEXT NOT NULL,
    content_type TEXT,
    snapshot_path TEXT,
    citation_fingerprint TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'en',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sources_document_hash
ON sources(document_hash) WHERE document_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS source_aliases (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    url TEXT,
    title TEXT,
    author_institution TEXT,
    publication_date TEXT,
    source_type TEXT,
    metadata_status TEXT,
    access_date TEXT,
    language TEXT,
    notes TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_version_links (
    id TEXT PRIMARY KEY,
    previous_source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
    url TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (previous_source_id != source_id)
);

CREATE TABLE IF NOT EXISTS claims (
    id TEXT PRIMARY KEY,
    claim_text TEXT NOT NULL,
    interpretation TEXT NOT NULL,
    confidence TEXT NOT NULL,
    known_limitation TEXT NOT NULL,
    status TEXT NOT NULL,
    policy_outcome TEXT NOT NULL,
    case_name TEXT NOT NULL DEFAULT '',
    time_period TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY,
    claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    exact_text TEXT NOT NULL,
    locator_type TEXT,
    locator TEXT,
    review_state TEXT NOT NULL,
    reviewer_note TEXT NOT NULL DEFAULT '',
    origin TEXT NOT NULL DEFAULT 'human',
    created_at TEXT NOT NULL,
    CHECK (
        review_state != 'approved'
        OR (locator_type IS NOT NULL AND locator IS NOT NULL AND trim(locator) != '')
    ),
    CHECK (origin = 'human')
);

CREATE TABLE IF NOT EXISTS definitions (
    id TEXT PRIMARY KEY,
    term TEXT NOT NULL COLLATE NOCASE UNIQUE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS definition_versions (
    id TEXT PRIMARY KEY,
    definition_id TEXT NOT NULL REFERENCES definitions(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    term TEXT NOT NULL,
    definition TEXT NOT NULL,
    scope TEXT NOT NULL,
    rationale TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(definition_id, version)
);

CREATE TABLE IF NOT EXISTS comparisons (
    id TEXT PRIMARY KEY,
    claim_a_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    claim_b_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
    relation TEXT NOT NULL,
    rationale TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (claim_a_id != claim_b_id)
);

CREATE TABLE IF NOT EXISTS research_decisions (
    id TEXT PRIMARY KEY,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    before_state TEXT NOT NULL DEFAULT '',
    after_state TEXT NOT NULL,
    rationale TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS machine_suggestions (
    id TEXT PRIMARY KEY,
    source_id TEXT REFERENCES sources(id) ON DELETE CASCADE,
    suggestion_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unverified',
    created_at TEXT NOT NULL,
    CHECK (status IN ('unverified', 'dismissed', 'approved'))
);
"""


def utc_now() -> datetime:
    return datetime.now(UTC)


def sha256_bytes(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def normalized_text(value: str) -> str:
    """Normalize researcher-entered identifiers before case-insensitive comparison."""
    return unicodedata.normalize("NFKC", value).casefold().strip()


def citation_fingerprint(source: SourceCreate) -> str:
    normalized = "|".join(
        [
            normalized_text(source.title),
            normalized_text(source.author_institution),
            source.publication_date.isoformat() if source.publication_date else "",
        ]
    )
    return sha256_bytes(normalized.encode("utf-8"))


class LedgerStore:
    """Small SQLite repository with provenance rules enforced below the UI layer."""

    def __init__(self, db_path: Path, blob_dir: Path | None = None) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.blob_dir = Path(blob_dir or self.db_path.parent / "blobs")
        self.blob_dir.mkdir(parents=True, exist_ok=True)
        self.init_schema()

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys = ON")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def init_schema(self) -> None:
        with self.connect() as connection:
            connection.executescript(SCHEMA)
            alias_columns = {
                row["name"]
                for row in connection.execute("PRAGMA table_info(source_aliases)").fetchall()
            }
            for name, column_type in {
                "title": "TEXT",
                "author_institution": "TEXT",
                "publication_date": "TEXT",
                "source_type": "TEXT",
                "metadata_status": "TEXT",
                "access_date": "TEXT",
                "language": "TEXT",
                "notes": "TEXT",
            }.items():
                if name not in alias_columns:
                    connection.execute(
                        f"ALTER TABLE source_aliases ADD COLUMN {name} {column_type}"
                    )
            aliases_sql = connection.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'source_aliases'"
            ).fetchone()
            if aliases_sql and (
                "UNIQUE(source_id, url)" in aliases_sql["sql"]
                or "url TEXT NOT NULL" in aliases_sql["sql"]
            ):
                connection.executescript(
                    """
                    ALTER TABLE source_aliases RENAME TO source_aliases_legacy;
                    CREATE TABLE source_aliases (
                        id TEXT PRIMARY KEY,
                        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
                        url TEXT,
                        title TEXT,
                        author_institution TEXT,
                        publication_date TEXT,
                        source_type TEXT,
                        metadata_status TEXT,
                        access_date TEXT,
                        language TEXT,
                        notes TEXT,
                        created_at TEXT NOT NULL
                    );
                    INSERT INTO source_aliases (
                        id, source_id, url, title, author_institution, publication_date,
                        source_type, metadata_status, access_date, language, notes, created_at
                    )
                    SELECT id, source_id, url, title, author_institution, publication_date,
                           source_type, metadata_status, access_date, language, notes, created_at
                    FROM source_aliases_legacy;
                    DROP TABLE source_aliases_legacy;
                    """
                )
            version_links_sql = connection.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' "
                "AND name = 'source_version_links'"
            ).fetchone()
            if (
                version_links_sql
                and "UNIQUE(previous_source_id, source_id, url)" in (version_links_sql["sql"])
            ):
                connection.executescript(
                    """
                    ALTER TABLE source_version_links RENAME TO source_version_links_legacy;
                    CREATE TABLE source_version_links (
                        id TEXT PRIMARY KEY,
                        previous_source_id TEXT NOT NULL
                            REFERENCES sources(id) ON DELETE CASCADE,
                        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
                        url TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        CHECK (previous_source_id != source_id)
                    );
                    INSERT INTO source_version_links
                    SELECT * FROM source_version_links_legacy;
                    DROP TABLE source_version_links_legacy;
                    """
                )
            evidence_sql = connection.execute(
                "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'evidence'"
            ).fetchone()
            if evidence_sql and (
                "locator IS NOT NULL" not in evidence_sql["sql"]
                or "CHECK (origin = 'human')" not in evidence_sql["sql"]
            ):
                connection.executescript(
                    """
                    BEGIN;
                    ALTER TABLE evidence RENAME TO evidence_legacy;
                    CREATE TABLE evidence (
                        id TEXT PRIMARY KEY,
                        claim_id TEXT NOT NULL REFERENCES claims(id) ON DELETE CASCADE,
                        source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE RESTRICT,
                        role TEXT NOT NULL,
                        kind TEXT NOT NULL,
                        exact_text TEXT NOT NULL,
                        locator_type TEXT,
                        locator TEXT,
                        review_state TEXT NOT NULL,
                        reviewer_note TEXT NOT NULL DEFAULT '',
                        origin TEXT NOT NULL DEFAULT 'human',
                        created_at TEXT NOT NULL,
                        CHECK (
                            review_state != 'approved'
                            OR (
                                locator_type IS NOT NULL
                                AND locator IS NOT NULL
                                AND trim(locator) != ''
                            )
                        ),
                        CHECK (origin = 'human')
                    );
                    INSERT INTO evidence (
                        id, claim_id, source_id, role, kind, exact_text, locator_type,
                        locator, review_state, reviewer_note, origin, created_at
                    )
                    SELECT id, claim_id, source_id, role, kind, exact_text, locator_type,
                           locator, review_state, reviewer_note, origin, created_at
                    FROM evidence_legacy;
                    DROP TABLE evidence_legacy;
                    COMMIT;
                    """
                )
            for row in connection.execute("SELECT * FROM sources").fetchall():
                if row["snapshot_path"] and Path(row["snapshot_path"]).is_absolute():
                    digest = row["document_hash"]
                    local = self.blob_dir / digest[:2] / digest if digest else None
                    if local and local.is_file():
                        connection.execute(
                            "UPDATE sources SET snapshot_path = ? WHERE id = ?",
                            (str(local.relative_to(self.blob_dir)), row["id"]),
                        )
                try:
                    source = SourceCreate(
                        title=row["title"],
                        author_institution=row["author_institution"],
                        publication_date=row["publication_date"],
                        source_type=row["source_type"],
                        url=row["url"],
                        access_date=row["access_date"],
                        metadata_status=row["metadata_status"],
                        ingest_mode=row["ingest_mode"],
                        language=row["language"],
                        notes=row["notes"],
                    )
                except ValidationError:
                    continue
                connection.execute(
                    "UPDATE sources SET citation_fingerprint = ? WHERE id = ?",
                    (citation_fingerprint(source), row["id"]),
                )

    def has_research_records(self) -> bool:
        with self.connect() as connection:
            return any(
                connection.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone()
                for table in (
                    "sources",
                    "claims",
                    "evidence",
                    "definition_versions",
                    "comparisons",
                    "research_decisions",
                )
            )

    @staticmethod
    def new_id(prefix: str) -> str:
        return f"{prefix}-{uuid.uuid4().hex[:10].upper()}"

    def _write_blob(self, content: bytes, digest: str) -> Path:
        target = self.blob_dir / digest[:2] / digest
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() and not target.is_file():
            raise ValueError("content-addressed blob target is not a regular file")
        try:
            valid = target.is_file() and sha256_bytes(target.read_bytes()) == digest
        except OSError:
            valid = False
        if not valid:
            temporary = target.with_suffix(".tmp")
            temporary.write_bytes(content)
            temporary.replace(target)
        return target

    def _resolve_snapshot_path(self, stored_path: str) -> Path:
        path = Path(stored_path)
        if not path.is_absolute():
            return self.blob_dir / path
        local = self.blob_dir / path.parent.name / path.name
        return local if local.is_file() else path

    @staticmethod
    def _latest_snapshot_for_url(connection: sqlite3.Connection, url: str) -> sqlite3.Row | None:
        return connection.execute(
            """
            SELECT id, document_hash, observed_at FROM (
                SELECT id, document_hash, created_at AS observed_at
                FROM sources
                WHERE url = ? AND document_hash IS NOT NULL
                UNION ALL
                SELECT s.id, s.document_hash, a.created_at AS observed_at
                FROM source_aliases a
                JOIN sources s ON s.id = a.source_id
                WHERE a.url = ? AND s.document_hash IS NOT NULL
            )
            ORDER BY observed_at DESC, id DESC
            LIMIT 1
            """,
            (url, url),
        ).fetchone()

    def add_source(
        self,
        source: SourceCreate,
        snapshot_bytes: bytes | None = None,
        content_type: str | None = None,
    ) -> SourceView:
        digest = sha256_bytes(snapshot_bytes) if snapshot_bytes is not None else None
        now = utc_now()
        url = str(source.url) if source.url else None

        with self.connect() as connection:
            previous_version = (
                self._latest_snapshot_for_url(connection, url) if digest and url else None
            )
            if digest:
                existing = connection.execute(
                    "SELECT * FROM sources WHERE document_hash = ?", (digest,)
                ).fetchone()
                if existing:
                    stored_blob = self._write_blob(snapshot_bytes, digest)
                    snapshot_path = str(stored_blob.relative_to(self.blob_dir))
                    connection.execute(
                        "UPDATE sources SET snapshot_path = ?, content_type = "
                        "COALESCE(content_type, ?) WHERE id = ?",
                        (snapshot_path, content_type, existing["id"]),
                    )
                    connection.execute(
                        """
                            INSERT INTO source_aliases (
                                id, source_id, url, title, author_institution,
                                publication_date, source_type, access_date, language,
                                metadata_status, notes, created_at
                            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            """,
                        (
                            self.new_id("ALIAS"),
                            existing["id"],
                            url,
                            source.title,
                            source.author_institution,
                            source.publication_date.isoformat()
                            if source.publication_date
                            else None,
                            source.source_type.value,
                            source.access_date.isoformat(),
                            source.language,
                            source.metadata_status.value,
                            source.notes,
                            now.isoformat(),
                        ),
                    )
                    if previous_version and previous_version["id"] != existing["id"]:
                        connection.execute(
                            """
                            INSERT INTO source_version_links (
                                id, previous_source_id, source_id, url, created_at
                            ) VALUES (?, ?, ?, ?, ?)
                            """,
                            (
                                self.new_id("VER"),
                                previous_version["id"],
                                existing["id"],
                                url,
                                now.isoformat(),
                            ),
                        )
                    refreshed = connection.execute(
                        "SELECT * FROM sources WHERE id = ?", (existing["id"],)
                    ).fetchone()
                    assert refreshed is not None
                    view = self._source_view(refreshed, connection)
                    return view.model_copy(update={"duplicate": True})

            source_id = self.new_id("SRC")
            snapshot_path = None
            if digest and snapshot_bytes is not None:
                stored_blob = self._write_blob(snapshot_bytes, digest)
                snapshot_path = str(stored_blob.relative_to(self.blob_dir))

            connection.execute(
                """
                INSERT INTO sources (
                    id, title, author_institution, publication_date, source_type, url,
                    access_date, document_hash, metadata_status, ingest_mode,
                    content_type, snapshot_path, citation_fingerprint, language, notes, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    source_id,
                    source.title,
                    source.author_institution,
                    source.publication_date.isoformat() if source.publication_date else None,
                    source.source_type.value,
                    url,
                    source.access_date.isoformat(),
                    digest,
                    source.metadata_status.value,
                    source.ingest_mode.value,
                    content_type,
                    snapshot_path,
                    citation_fingerprint(source),
                    source.language,
                    source.notes,
                    now.isoformat(),
                ),
            )
            row = connection.execute("SELECT * FROM sources WHERE id = ?", (source_id,)).fetchone()
            if previous_version:
                connection.execute(
                    """
                    INSERT INTO source_version_links (
                        id, previous_source_id, source_id, url, created_at
                    ) VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        self.new_id("VER"),
                        previous_version["id"],
                        source_id,
                        url,
                        now.isoformat(),
                    ),
                )
            assert row is not None
            return self._source_view(row, connection)

    def verify_source(self, source_id: str) -> SourceView:
        with self.connect() as connection:
            cursor = connection.execute(
                "UPDATE sources SET metadata_status = ? WHERE id = ?",
                (MetadataStatus.VERIFIED.value, source_id),
            )
            if cursor.rowcount == 0:
                raise KeyError(f"source not found: {source_id}")
            row = connection.execute("SELECT * FROM sources WHERE id = ?", (source_id,)).fetchone()
            assert row is not None
            return self._source_view(row, connection)

    def get_source(self, source_id: str) -> SourceView:
        with self.connect() as connection:
            row = connection.execute("SELECT * FROM sources WHERE id = ?", (source_id,)).fetchone()
            if row is None:
                raise KeyError(f"source not found: {source_id}")
            return self._source_view(row, connection)

    def list_sources(self) -> list[SourceView]:
        with self.connect() as connection:
            rows = connection.execute("SELECT * FROM sources ORDER BY created_at DESC").fetchall()
            return [self._source_view(row, connection) for row in rows]

    def citation_duplicates(self, source: SourceCreate) -> list[SourceView]:
        fingerprint = citation_fingerprint(source)
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM sources WHERE citation_fingerprint = ? ORDER BY created_at",
                (fingerprint,),
            ).fetchall()
            return [self._source_view(row, connection) for row in rows]

    def add_claim(self, claim: ClaimCreate) -> ClaimView:
        claim_id = self.new_id("CLM")
        now = utc_now()
        with self.connect() as connection:
            connection.execute(
                """
                INSERT INTO claims (
                    id, claim_text, interpretation, confidence, known_limitation,
                    status, policy_outcome, case_name, time_period, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    claim_id,
                    claim.claim_text,
                    claim.interpretation,
                    claim.confidence.value,
                    claim.known_limitation,
                    claim.status.value,
                    claim.policy_outcome,
                    claim.case_name,
                    claim.time_period,
                    now.isoformat(),
                ),
            )
        return ClaimView(id=claim_id, created_at=now, evidence=[], **claim.model_dump())

    def add_evidence(self, evidence: EvidenceCreate) -> EvidenceView:
        evidence_id = self.new_id("EVD")
        now = utc_now()
        with self.connect() as connection:
            claim = connection.execute(
                "SELECT id FROM claims WHERE id = ?", (evidence.claim_id,)
            ).fetchone()
            if claim is None:
                raise KeyError(f"claim not found: {evidence.claim_id}")
            source = connection.execute(
                "SELECT metadata_status FROM sources WHERE id = ?", (evidence.source_id,)
            ).fetchone()
            if source is None:
                raise KeyError(f"source not found: {evidence.source_id}")
            if (
                evidence.review_state == ReviewState.APPROVED
                and source["metadata_status"] != MetadataStatus.VERIFIED.value
            ):
                raise ValueError("evidence cannot be approved until source metadata is verified")

            connection.execute(
                """
                INSERT INTO evidence (
                    id, claim_id, source_id, role, kind, exact_text, locator_type,
                    locator, review_state, reviewer_note, origin, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'human', ?)
                """,
                (
                    evidence_id,
                    evidence.claim_id,
                    evidence.source_id,
                    evidence.role.value,
                    evidence.kind.value,
                    evidence.exact_text,
                    evidence.locator_type.value if evidence.locator_type else None,
                    evidence.locator,
                    evidence.review_state.value,
                    evidence.reviewer_note,
                    now.isoformat(),
                ),
            )
        return EvidenceView(id=evidence_id, created_at=now, **evidence.model_dump())

    def approve_evidence(
        self, evidence_id: str, approval: EvidenceApproval | None = None
    ) -> EvidenceView:
        with self.connect() as connection:
            row = connection.execute(
                """
                SELECT e.*, s.metadata_status
                FROM evidence e JOIN sources s ON s.id = e.source_id
                WHERE e.id = ?
                """,
                (evidence_id,),
            ).fetchone()
            if row is None:
                raise KeyError(f"evidence not found: {evidence_id}")
            if row["review_state"] == ReviewState.APPROVED.value:
                raise ValueError("approved evidence is immutable; create a new evidence record")
            locator_type = approval.locator_type.value if approval else row["locator_type"]
            locator = approval.locator if approval else row["locator"]
            reviewer_note = (
                approval.reviewer_note
                if approval and approval.reviewer_note is not None
                else row["reviewer_note"]
            )
            if not (locator_type and (locator or "").strip()):
                raise ValueError("evidence cannot be approved without a source locator")
            if row["metadata_status"] != MetadataStatus.VERIFIED.value:
                raise ValueError("evidence cannot be approved until source metadata is verified")
            connection.execute(
                """
                UPDATE evidence
                SET locator_type = ?, locator = ?, reviewer_note = ?, review_state = ?
                WHERE id = ?
                """,
                (
                    locator_type,
                    locator,
                    reviewer_note,
                    ReviewState.APPROVED.value,
                    evidence_id,
                ),
            )
            updated = connection.execute(
                "SELECT * FROM evidence WHERE id = ?", (evidence_id,)
            ).fetchone()
            assert updated is not None
            return self._evidence_view(updated)

    def add_definition(self, definition: DefinitionCreate) -> DefinitionVersionView:
        now = utc_now()
        with self.connect() as connection:
            existing = next(
                (
                    row
                    for row in connection.execute("SELECT id, term FROM definitions").fetchall()
                    if normalized_text(row["term"]) == normalized_text(definition.term)
                ),
                None,
            )
            if existing:
                definition_id = existing["id"]
                previous = connection.execute(
                    "SELECT * FROM definition_versions WHERE definition_id = ? "
                    "ORDER BY version DESC LIMIT 1",
                    (definition_id,),
                ).fetchone()
                version = int(previous["version"]) + 1
            else:
                definition_id = self.new_id("DEF")
                version = 1
                previous = None
                connection.execute(
                    "INSERT INTO definitions (id, term, created_at) VALUES (?, ?, ?)",
                    (definition_id, definition.term, now.isoformat()),
                )

            version_id = self.new_id("DEFV")
            connection.execute(
                """
                INSERT INTO definition_versions (
                    id, definition_id, version, term, definition, scope, rationale, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    version_id,
                    definition_id,
                    version,
                    definition.term,
                    definition.definition,
                    definition.scope,
                    definition.rationale,
                    now.isoformat(),
                ),
            )
            if previous:
                self._insert_decision(
                    connection,
                    DecisionCreate(
                        entity_type="definition",
                        entity_id=definition_id,
                        before_state=previous["definition"],
                        after_state=definition.definition,
                        rationale=definition.rationale,
                    ),
                    now,
                )

        return DefinitionVersionView(
            id=version_id,
            definition_id=definition_id,
            version=version,
            created_at=now,
            **definition.model_dump(),
        )

    def add_comparison(self, comparison: ComparisonCreate) -> dict[str, str]:
        comparison_id = self.new_id("CMP")
        now = utc_now()
        with self.connect() as connection:
            found = connection.execute(
                "SELECT COUNT(*) AS count FROM claims WHERE id IN (?, ?)",
                (comparison.claim_a_id, comparison.claim_b_id),
            ).fetchone()
            if found is None or found["count"] != 2:
                raise KeyError("both comparison claims must exist")
            connection.execute(
                """
                INSERT INTO comparisons (
                    id, claim_a_id, claim_b_id, relation, rationale, created_at
                ) VALUES (?, ?, ?, ?, ?, ?)
                """,
                (
                    comparison_id,
                    comparison.claim_a_id,
                    comparison.claim_b_id,
                    comparison.relation.value,
                    comparison.rationale,
                    now.isoformat(),
                ),
            )
        return {
            "id": comparison_id,
            "created_at": now.isoformat(),
            **comparison.model_dump(mode="json"),
        }

    def add_decision(self, decision: DecisionCreate) -> dict[str, str]:
        now = utc_now()
        with self.connect() as connection:
            table = {
                DecisionEntityType.CLAIM: "claims",
                DecisionEntityType.DEFINITION: "definitions",
            }.get(decision.entity_type)
            if (
                table
                and connection.execute(
                    f"SELECT 1 FROM {table} WHERE id = ?", (decision.entity_id,)
                ).fetchone()
                is None
            ):
                raise KeyError(f"{decision.entity_type.value} not found: {decision.entity_id}")
            decision_id = self._insert_decision(connection, decision, now)
        return {"id": decision_id, "created_at": now.isoformat(), **decision.model_dump()}

    def _insert_decision(
        self, connection: sqlite3.Connection, decision: DecisionCreate, now: datetime
    ) -> str:
        decision_id = self.new_id("DEC")
        connection.execute(
            """
            INSERT INTO research_decisions (
                id, entity_type, entity_id, before_state, after_state, rationale, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                decision_id,
                decision.entity_type,
                decision.entity_id,
                decision.before_state,
                decision.after_state,
                decision.rationale,
                now.isoformat(),
            ),
        )
        return decision_id

    def list_claims(self) -> list[ClaimView]:
        with self.connect() as connection:
            rows = connection.execute("SELECT * FROM claims ORDER BY created_at DESC").fetchall()
            return [self._claim_view(connection, row) for row in rows]

    def list_definitions(self) -> list[DefinitionVersionView]:
        with self.connect() as connection:
            rows = connection.execute(
                """
                SELECT * FROM definition_versions
                ORDER BY term, version DESC
                """
            ).fetchall()
        return [self._definition_view(row) for row in rows]

    def export_issues(self) -> list[str]:
        issues: list[str] = []
        with self.connect() as connection:
            foreign_key_violations = [
                tuple(row) for row in connection.execute("PRAGMA foreign_key_check").fetchall()
            ]
            for table, row_id, parent, constraint_id in sorted(
                foreign_key_violations,
                key=lambda item: tuple(str(value) for value in item),
            ):
                issues.append(
                    f"{table} row {row_id} violates foreign key {constraint_id} to {parent}"
                )
            record_models = {
                "sources": (
                    SourceCreate,
                    (
                        "title",
                        "author_institution",
                        "publication_date",
                        "source_type",
                        "url",
                        "access_date",
                        "metadata_status",
                        "ingest_mode",
                        "language",
                        "notes",
                    ),
                ),
                "claims": (
                    ClaimCreate,
                    (
                        "claim_text",
                        "interpretation",
                        "confidence",
                        "known_limitation",
                        "status",
                        "policy_outcome",
                        "case_name",
                        "time_period",
                    ),
                ),
                "evidence": (
                    EvidenceCreate,
                    (
                        "claim_id",
                        "source_id",
                        "role",
                        "kind",
                        "exact_text",
                        "locator_type",
                        "locator",
                        "review_state",
                        "reviewer_note",
                    ),
                ),
                "definition_versions": (
                    DefinitionCreate,
                    ("term", "definition", "scope", "rationale"),
                ),
                "source_aliases": (
                    SourceAliasView,
                    (
                        "id",
                        "url",
                        "title",
                        "author_institution",
                        "publication_date",
                        "source_type",
                        "metadata_status",
                        "access_date",
                        "language",
                        "notes",
                        "created_at",
                    ),
                ),
                "source_version_links": (
                    SourceVersionView,
                    ("id", "previous_source_id", "source_id", "url", "created_at"),
                ),
                "comparisons": (
                    ComparisonCreate,
                    ("claim_a_id", "claim_b_id", "relation", "rationale"),
                ),
                "research_decisions": (
                    DecisionCreate,
                    ("entity_type", "entity_id", "before_state", "after_state", "rationale"),
                ),
            }
            for table, (model, fields) in record_models.items():
                for row in connection.execute(f"SELECT * FROM {table} ORDER BY id").fetchall():
                    try:
                        model.model_validate({field: row[field] for field in fields})
                    except (ValidationError, ValueError):
                        issues.append(f"{row['id']} has invalid {table} record data")

            for table in (
                "sources",
                "claims",
                "evidence",
                "definition_versions",
                "comparisons",
                "research_decisions",
            ):
                for row in connection.execute(
                    f"SELECT id, created_at FROM {table} ORDER BY id"
                ).fetchall():
                    try:
                        datetime.fromisoformat(row["created_at"])
                    except (TypeError, ValueError):
                        issues.append(f"{row['id']} has invalid created_at")

            enum_fields = {
                "sources": {
                    "source_type": {item.value for item in SourceType},
                    "metadata_status": {item.value for item in MetadataStatus},
                    "ingest_mode": {item.value for item in IngestMode},
                },
                "claims": {
                    "confidence": {item.value for item in Confidence},
                    "status": {item.value for item in ClaimStatus},
                },
                "evidence": {
                    "role": {item.value for item in EvidenceRole},
                    "kind": {item.value for item in EvidenceKind},
                    "review_state": {item.value for item in ReviewState},
                    "origin": {"human"},
                },
                "comparisons": {
                    "relation": {item.value for item in RelationType},
                },
            }
            for table, fields in enum_fields.items():
                rows = connection.execute(f"SELECT * FROM {table} ORDER BY id").fetchall()
                for row in rows:
                    for field, allowed in fields.items():
                        if row[field] not in allowed:
                            issues.append(f"{row['id']} has invalid {field}: {row[field]}")
            locator_values = {item.value for item in LocatorType}
            for row in connection.execute("SELECT * FROM evidence ORDER BY id").fetchall():
                if row["locator_type"] is not None and row["locator_type"] not in locator_values:
                    issues.append(f"{row['id']} has invalid locator_type: {row['locator_type']}")

            claims = connection.execute("SELECT id, claim_text FROM claims ORDER BY id").fetchall()
            if not claims:
                issues.append("ledger has no claims")
            for claim in claims:
                evidence_rows = connection.execute(
                    """
                    SELECT e.*, s.metadata_status, s.document_hash, s.snapshot_path,
                           s.ingest_mode
                    FROM evidence e JOIN sources s ON s.id = e.source_id
                    WHERE e.claim_id = ? AND e.review_state = 'approved'
                    """,
                    (claim["id"],),
                ).fetchall()
                if not evidence_rows:
                    issues.append(f"{claim['id']} has no approved evidence")
                    continue
                for item in evidence_rows:
                    if not (item["locator_type"] and (item["locator"] or "").strip()):
                        issues.append(f"{item['id']} has no source locator")
                    if item["metadata_status"] != MetadataStatus.VERIFIED.value:
                        issues.append(f"{item['id']} uses unverified source metadata")
                    captured = item["ingest_mode"] in {"url", "upload"}
                    if captured and not item["document_hash"]:
                        issues.append(f"{item['source_id']} captured source has no document hash")
                    if captured and not item["snapshot_path"]:
                        issues.append(f"{item['source_id']} captured source has no snapshot path")
                    if item["document_hash"] and not item["snapshot_path"]:
                        issues.append(f"{item['source_id']} hashed source has no snapshot path")
                    if item["snapshot_path"] and not item["document_hash"]:
                        issues.append(f"{item['source_id']} snapshot has no document hash")
                    if item["document_hash"] and item["snapshot_path"]:
                        path = self._resolve_snapshot_path(item["snapshot_path"])
                        try:
                            matches = (
                                path.is_file()
                                and sha256_bytes(path.read_bytes()) == item["document_hash"]
                            )
                        except OSError:
                            matches = False
                        if not matches:
                            issues.append(f"{item['source_id']} snapshot hash does not match")
        return list(dict.fromkeys(issues))

    def dashboard(self) -> DashboardView:
        with self.connect() as connection:
            comparisons = [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM comparisons ORDER BY created_at DESC"
                ).fetchall()
            ]
            decisions = [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM research_decisions ORDER BY created_at DESC"
                ).fetchall()
            ]
        issues = self.export_issues()
        return DashboardView(
            sources=self.list_sources(),
            claims=self.list_claims(),
            definitions=self.list_definitions(),
            comparisons=comparisons,
            decisions=decisions,
            export_ready=not issues,
            export_issues=issues,
        )

    def raw_export_rows(self) -> dict[str, list[dict[str, object]]]:
        """Return normalized records for the exporter; never expose this as a public API."""
        with self.connect() as connection:
            return {
                "sources": [
                    dict(row)
                    for row in connection.execute("SELECT * FROM sources ORDER BY id").fetchall()
                ],
                "source_aliases": [
                    dict(row)
                    for row in connection.execute(
                        "SELECT * FROM source_aliases ORDER BY source_id, created_at, id"
                    ).fetchall()
                ],
                "source_versions": [
                    dict(row)
                    for row in connection.execute(
                        "SELECT * FROM source_version_links ORDER BY created_at, id"
                    ).fetchall()
                ],
                "claims": [
                    dict(row)
                    for row in connection.execute("SELECT * FROM claims ORDER BY id").fetchall()
                ],
                "evidence": [
                    dict(row)
                    for row in connection.execute(
                        """
                        SELECT e.*, s.title AS source_title,
                               s.author_institution AS source_author_institution,
                               s.publication_date AS source_publication_date,
                               s.url AS source_url, s.access_date AS source_access_date,
                               s.document_hash AS source_document_hash,
                               s.metadata_status AS source_metadata_status
                        FROM evidence e JOIN sources s ON s.id = e.source_id
                        ORDER BY e.claim_id, e.role, e.id
                        """
                    ).fetchall()
                ],
                "definitions": [
                    dict(row)
                    for row in connection.execute(
                        "SELECT * FROM definition_versions ORDER BY term, version"
                    ).fetchall()
                ],
                "comparisons": [
                    dict(row)
                    for row in connection.execute(
                        "SELECT * FROM comparisons ORDER BY id"
                    ).fetchall()
                ],
                "decisions": [
                    dict(row)
                    for row in connection.execute(
                        "SELECT * FROM research_decisions ORDER BY id"
                    ).fetchall()
                ],
            }

    def export_snapshot(self) -> tuple[list[str], dict[str, list[dict[str, object]]]]:
        """Validate and read export rows while holding a consistent local DB snapshot."""
        with self.connect() as guard:
            guard.execute("BEGIN IMMEDIATE")
            issues = self.export_issues()
            records = self.raw_export_rows()
            return issues, records

    def _source_view(
        self, row: sqlite3.Row, connection: sqlite3.Connection | None = None
    ) -> SourceView:
        alias_rows = (
            connection.execute(
                "SELECT * FROM source_aliases WHERE source_id = ? ORDER BY created_at, id",
                (row["id"],),
            ).fetchall()
            if connection
            else []
        )
        previous = (
            connection.execute(
                "SELECT previous_source_id FROM source_version_links WHERE source_id = ? "
                "ORDER BY created_at DESC, id DESC LIMIT 1",
                (row["id"],),
            ).fetchone()
            if connection
            else None
        )
        return SourceView(
            id=row["id"],
            title=row["title"],
            author_institution=row["author_institution"],
            publication_date=date.fromisoformat(row["publication_date"])
            if row["publication_date"]
            else None,
            source_type=row["source_type"],
            url=row["url"],
            access_date=date.fromisoformat(row["access_date"]),
            document_hash=row["document_hash"],
            metadata_status=row["metadata_status"],
            ingest_mode=row["ingest_mode"],
            content_type=row["content_type"],
            language=row["language"],
            notes=row["notes"],
            created_at=datetime.fromisoformat(row["created_at"]),
            aliases=[
                SourceAliasView(
                    id=alias["id"],
                    url=alias["url"],
                    title=alias["title"],
                    author_institution=alias["author_institution"],
                    publication_date=date.fromisoformat(alias["publication_date"])
                    if alias["publication_date"]
                    else None,
                    source_type=alias["source_type"],
                    metadata_status=alias["metadata_status"],
                    access_date=date.fromisoformat(alias["access_date"])
                    if alias["access_date"]
                    else None,
                    language=alias["language"],
                    notes=alias["notes"],
                    created_at=datetime.fromisoformat(alias["created_at"]),
                )
                for alias in alias_rows
            ],
            previous_version_id=previous["previous_source_id"] if previous else None,
        )

    @staticmethod
    def _evidence_view(row: sqlite3.Row) -> EvidenceView:
        return EvidenceView(
            id=row["id"],
            claim_id=row["claim_id"],
            source_id=row["source_id"],
            role=row["role"],
            kind=row["kind"],
            exact_text=row["exact_text"],
            locator_type=row["locator_type"],
            locator=row["locator"],
            review_state=row["review_state"],
            reviewer_note=row["reviewer_note"],
            created_at=datetime.fromisoformat(row["created_at"]),
        )

    def _claim_view(self, connection: sqlite3.Connection, row: sqlite3.Row) -> ClaimView:
        evidence_rows = connection.execute(
            "SELECT * FROM evidence WHERE claim_id = ? ORDER BY role, created_at", (row["id"],)
        ).fetchall()
        return ClaimView(
            id=row["id"],
            claim_text=row["claim_text"],
            interpretation=row["interpretation"],
            confidence=row["confidence"],
            known_limitation=row["known_limitation"],
            status=row["status"],
            policy_outcome=row["policy_outcome"],
            case_name=row["case_name"],
            time_period=row["time_period"],
            created_at=datetime.fromisoformat(row["created_at"]),
            evidence=[self._evidence_view(item) for item in evidence_rows],
        )

    @staticmethod
    def _definition_view(row: sqlite3.Row) -> DefinitionVersionView:
        return DefinitionVersionView(
            id=row["id"],
            definition_id=row["definition_id"],
            version=row["version"],
            term=row["term"],
            definition=row["definition"],
            scope=row["scope"],
            rationale=row["rationale"],
            created_at=datetime.fromisoformat(row["created_at"]),
        )

    def dump_debug_json(self) -> str:
        return json.dumps(self.raw_export_rows(), indent=2, default=str, sort_keys=True)
