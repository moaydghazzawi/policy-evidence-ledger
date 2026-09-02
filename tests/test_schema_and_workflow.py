from __future__ import annotations

from datetime import date

import pytest
from pydantic import ValidationError

from policy_evidence_ledger.schemas import (
    ClaimCreate,
    ClaimStatus,
    ComparisonCreate,
    Confidence,
    DecisionCreate,
    DefinitionCreate,
    EvidenceApproval,
    EvidenceCreate,
    EvidenceKind,
    EvidenceRole,
    IngestMode,
    MetadataStatus,
    RelationType,
    ReviewState,
    SourceCreate,
    SourceType,
)
from policy_evidence_ledger.storage import LedgerStore


def manual_source(*, verified: bool = True) -> SourceCreate:
    return SourceCreate(
        title="Public source",
        author_institution="Public institution",
        publication_date=date(2024, 1, 1),
        source_type=SourceType.OFFICIAL_STATEMENT,
        url="https://example.gov/source",
        access_date=date(2026, 9, 2),
        metadata_status=MetadataStatus.VERIFIED if verified else MetadataStatus.PENDING,
        ingest_mode=IngestMode.MANUAL,
    )


def claim() -> ClaimCreate:
    return ClaimCreate(
        claim_text="The policy changed.",
        interpretation="The sequence matters.",
        confidence=Confidence.MODERATE,
        known_limitation="Implementation data are incomplete.",
        status=ClaimStatus.CONTESTED,
        policy_outcome="Policy scope",
    )


def test_schema_rejects_blank_and_invalid_values() -> None:
    with pytest.raises(ValidationError):
        ClaimCreate(
            claim_text=" ",
            interpretation="x",
            confidence="certain",
            known_limitation="x",
            status="maybe",
            policy_outcome="x",
        )

    with pytest.raises(ValidationError, match="requires a source locator"):
        EvidenceCreate(
            claim_id="CLM-1",
            source_id="SRC-1",
            role=EvidenceRole.SUPPORTING,
            kind=EvidenceKind.PASSAGE,
            exact_text="Source text",
            review_state=ReviewState.APPROVED,
        )

    with pytest.raises(ValidationError, match="must not be blank"):
        SourceCreate(
            title="Public source",
            author_institution="Public institution",
            source_type=SourceType.REPORT,
            language="  ",
        )

    with pytest.raises(ValidationError, match="embedded credentials"):
        SourceCreate(
            title="Public source",
            author_institution="Public institution",
            source_type=SourceType.REPORT,
            url="https://user:secret@example.com/report",
        )

    with pytest.raises(ValidationError, match="must not be blank"):
        DecisionCreate(
            entity_type="case",
            entity_id="   ",
            after_state="revised",
            rationale="New evidence.",
        )


def test_unverified_source_cannot_back_approved_evidence(store: LedgerStore) -> None:
    source = store.add_source(manual_source(verified=False))
    stored_claim = store.add_claim(claim())
    with pytest.raises(ValueError, match="metadata is verified"):
        store.add_evidence(
            EvidenceCreate(
                claim_id=stored_claim.id,
                source_id=source.id,
                role=EvidenceRole.SUPPORTING,
                kind=EvidenceKind.DATA_POINT,
                exact_text="Official data point",
                locator_type="section",
                locator="Summary",
                review_state=ReviewState.APPROVED,
            )
        )


def test_draft_evidence_can_be_human_approved_after_metadata_review(store: LedgerStore) -> None:
    source = store.add_source(manual_source(verified=True))
    stored_claim = store.add_claim(claim())
    draft = store.add_evidence(
        EvidenceCreate(
            claim_id=stored_claim.id,
            source_id=source.id,
            role=EvidenceRole.SUPPORTING,
            kind=EvidenceKind.DATA_POINT,
            exact_text="Official data point",
            locator_type="section",
            locator="Summary",
            review_state=ReviewState.DRAFT,
        )
    )

    approved = store.approve_evidence(draft.id)

    assert approved.review_state == ReviewState.APPROVED
    with pytest.raises(ValueError, match="immutable"):
        store.approve_evidence(
            draft.id,
            EvidenceApproval(
                locator_type="page",
                locator="99",
                reviewer_note="Attempted overwrite.",
            ),
        )


def test_definition_change_preserves_versions_and_logs_reason(store: LedgerStore) -> None:
    first = store.add_definition(
        DefinitionCreate(
            term="Policy scope",
            definition="The provisions covered by a named instrument.",
            scope="Initial",
            rationale="Start the comparison.",
        )
    )
    second = store.add_definition(
        DefinitionCreate(
            term="Policy scope",
            definition="The provisions covered by a named instrument as of a stated date.",
            scope="Revised",
            rationale="The later instrument changes only part of the earlier measure.",
        )
    )
    assert first.definition_id == second.definition_id
    assert (first.version, second.version) == (1, 2)
    dashboard = store.dashboard()
    assert dashboard.definitions[0].version == 2
    assert [item.version for item in dashboard.definitions] == [2, 1]
    assert any("later instrument" in str(item["rationale"]) for item in dashboard.decisions)


def test_unicode_equivalent_definition_terms_share_version_history(store: LedgerStore) -> None:
    first = store.add_definition(
        DefinitionCreate(
            term="État capacity",
            definition="Initial definition.",
            scope="Initial scope.",
            rationale="Start the term record.",
        )
    )
    second = store.add_definition(
        DefinitionCreate(
            term="E\u0301TAT capacity",
            definition="Revised definition.",
            scope="Revised scope.",
            rationale="Normalize the same term before versioning.",
        )
    )

    assert second.definition_id == first.definition_id
    assert second.version == 2


def test_failed_relationship_and_approval_operations_leave_state_unchanged(
    store: LedgerStore,
) -> None:
    source = store.add_source(manual_source(verified=True))
    stored_claim = store.add_claim(claim())
    draft = store.add_evidence(
        EvidenceCreate(
            claim_id=stored_claim.id,
            source_id=source.id,
            role=EvidenceRole.COUNTEREVIDENCE,
            kind=EvidenceKind.DATA_POINT,
            exact_text="A qualification without a final locator.",
            review_state=ReviewState.DRAFT,
        )
    )

    with pytest.raises(ValueError, match="without a source locator"):
        store.approve_evidence(draft.id)
    assert store.list_claims()[0].evidence[0].review_state == ReviewState.DRAFT

    with pytest.raises(ValidationError, match="cannot be compared with itself"):
        ComparisonCreate(
            claim_a_id=stored_claim.id,
            claim_b_id=stored_claim.id,
            relation=RelationType.MIXED,
            rationale="Self-comparison is invalid.",
        )

    with pytest.raises(KeyError, match="both comparison claims must exist"):
        store.add_comparison(
            ComparisonCreate(
                claim_a_id=stored_claim.id,
                claim_b_id="CLM-MISSING",
                relation=RelationType.DISAGREES,
                rationale="The second claim is absent.",
            )
        )
    assert store.dashboard().comparisons == []
