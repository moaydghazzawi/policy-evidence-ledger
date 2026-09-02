# Architecture

Policy Evidence Ledger separates provenance storage, research judgment, and presentation while keeping the codebase approachable.

```text
React interface
      │ JSON / multipart
      ▼
FastAPI validation layer
      │
      ├── Pydantic research schemas
      ├── public-URL ingestion guard
      ├── export readiness and ZIP generator
      │
      ▼
SQLite ledger ───── content-addressed source blobs
```

## Backend

`src/policy_evidence_ledger/app.py` exposes the API and serves a production-built frontend when `dist/client` exists. `schemas.py` defines typed inputs and vocabulary. `storage.py` owns schema initialization, identifiers, deduplication, provenance rules, and queries. `ingestion.py` handles guarded public downloads. `exports.py` validates the ledger again and creates deterministic research artifacts. `seed.py` inserts the public demonstration idempotently.

SQLite is a deliberate MVP choice: a single researcher can inspect and copy structured records without operating another service. Captured source bytes live separately so large files do not inflate database pages and identical snapshots share storage. A complete backup must copy `ledger.sqlite3` and `blobs/` together while the service is stopped.

## Interface

The React workspace uses seven views that follow the research sequence: desk, sources, claims, definitions, comparisons, decisions, and export. Mutations use the local API. If it is not available, the interface shows the bundled public corpus in a clearly labeled read-only mode.

The optional WebMCP surface exposes one imperative `create_manual_source` tool. It validates inputs through the same API, returns a pending-verification record, and does not approve metadata or evidence. No declarative tool duplicates it.

## Trust boundaries

Source metadata verification and evidence approval are human decisions. The application enforces the mechanics of provenance—identity, locator, hash, review state—but cannot decide whether a quotation is substantively fair or whether an interpretation is correct.

The export layer treats the database as potentially inconsistent and reruns schema, locator, review-state, metadata, and snapshot-integrity checks against one locked read snapshot. This catches accidental corruption and incomplete application writes. Deliberate direct edits to the unsigned SQLite database remain outside the trust boundary and can defeat provenance fields; use filesystem controls and review exported records against the originals.

## Extension points

Future work can add full-text extraction, CSL/Zotero interchange, signed decision histories, or optional machine suggestions without changing the core distinction among source text, interpretation, and unverified assistance. Multi-user or hosted use would require authentication, authorization, encrypted storage, migrations, and a different deployment review.
