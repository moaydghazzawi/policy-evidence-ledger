from __future__ import annotations

import json
from datetime import date
from importlib.resources import files
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Any

from .schemas import (
    ClaimCreate,
    ClaimStatus,
    ComparisonCreate,
    Confidence,
    DecisionCreate,
    DefinitionCreate,
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
from .storage import LedgerStore


def load_manifest() -> dict[str, Any]:
    """Load the one canonical public demo fixture from a checkout or wheel."""
    checkout_manifest = Path(__file__).resolve().parents[2] / "demo" / "manifest.json"
    if checkout_manifest.exists():
        return json.loads(checkout_manifest.read_text(encoding="utf-8"))
    packaged_manifest = files("policy_evidence_ledger").joinpath("demo_manifest.json")
    return json.loads(packaged_manifest.read_text(encoding="utf-8"))


def seed_demo(store: LedgerStore) -> bool:
    """Seed an idempotent, public-only demonstration corpus."""
    if store.has_research_records():
        return False

    manifest = load_manifest()
    with TemporaryDirectory(prefix=".demo-seed-", dir=store.db_path.parent) as temporary:
        staging_dir = Path(temporary)
        staging = LedgerStore(staging_dir / "ledger.sqlite3", staging_dir / "blobs")
        _populate_demo(staging, manifest)
        staging.db_path.replace(store.db_path)
    return True


def _populate_demo(store: LedgerStore, manifest: dict[str, Any]) -> None:
    retrieved_on = date.fromisoformat(manifest["retrieved_on"])
    source_ids: dict[str, str] = {}
    for item in manifest["sources"]:
        source = store.add_source(
            SourceCreate(
                title=item["title"],
                author_institution=item["author_institution"],
                publication_date=date.fromisoformat(item["publication_date"]),
                source_type=SourceType(item["source_type"]),
                url=item["url"],
                access_date=retrieved_on,
                metadata_status=MetadataStatus.VERIFIED,
                ingest_mode=IngestMode.DEMO,
                language=item["language"],
                notes=item["notes"],
            )
        )
        source_ids[item["key"]] = source.id

    claim_ids: dict[str, str] = {}
    for item in manifest["claims"]:
        claim = store.add_claim(
            ClaimCreate(
                claim_text=item["claim_text"],
                interpretation=item["interpretation"],
                confidence=Confidence(item["confidence"]),
                known_limitation=item["known_limitation"],
                status=ClaimStatus(item["status"]),
                policy_outcome=item["policy_outcome"],
                case_name=item["case_name"],
                time_period=item["time_period"],
            )
        )
        claim_ids[item["key"]] = claim.id
        for evidence in item["evidence"]:
            store.add_evidence(
                EvidenceCreate(
                    claim_id=claim.id,
                    source_id=source_ids[evidence["source_key"]],
                    role=EvidenceRole(evidence["role"]),
                    kind=EvidenceKind(evidence["kind"]),
                    exact_text=evidence["exact_text"],
                    locator_type=LocatorType(evidence["locator_type"]),
                    locator=evidence["locator"],
                    review_state=ReviewState(evidence["review_state"]),
                    reviewer_note=evidence["reviewer_note"],
                )
            )

    for item in manifest["definitions"]:
        version = store.add_definition(
            DefinitionCreate(
                term=item["term"],
                definition=item["definition"],
                scope=item["scope"],
                rationale=item["rationale"],
            )
        )
        if version.version != item["version"]:
            raise ValueError(f"demo definition version drift for {item['key']}")

    for item in manifest["comparisons"]:
        store.add_comparison(
            ComparisonCreate(
                claim_a_id=claim_ids[item["claim_a_key"]],
                claim_b_id=claim_ids[item["claim_b_key"]],
                relation=RelationType(item["relation"]),
                rationale=item["rationale"],
            )
        )

    for item in manifest["decisions"]:
        if item["entity_type"] != "claim":
            raise ValueError("demo decisions currently support claim entities only")
        store.add_decision(
            DecisionCreate(
                entity_type=item["entity_type"],
                entity_id=claim_ids[item["entity_key"]],
                before_state=item["before_state"],
                after_state=item["after_state"],
                rationale=item["rationale"],
            )
        )
