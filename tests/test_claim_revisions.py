from policy_evidence_ledger.schemas import ClaimRevision
from policy_evidence_ledger.seed import seed_demo
from policy_evidence_ledger.storage import LedgerStore


def test_revision_preserves_old_claim_and_requires_new_evidence_review(store: LedgerStore):
    seed_demo(store)
    original = store.list_claims()[0]
    payload = original.model_dump(exclude={"id", "created_at", "evidence", "superseded_by"})
    payload["interpretation"] = "R" * 6000
    revision = store.revise_claim(
        original.id, ClaimRevision(**payload, rationale="A new interpretation")
    )
    assert revision.id != original.id
    assert len(revision.interpretation) == 6000
    assert all(item.review_state == "draft" for item in revision.evidence)
    saved = next(item for item in store.list_claims() if item.id == original.id)
    assert saved.interpretation == original.interpretation
    assert saved.evidence == original.evidence
    assert saved.superseded_by == revision.id
    assert store.export_issues()
    history = store.raw_export_rows()["claim_revisions"]
    assert history[0]["previous_claim_id"] == original.id
    assert history[0]["claim_id"] == revision.id


def test_superseded_draft_does_not_block_reviewed_replacement(store: LedgerStore):
    import io
    import zipfile

    from policy_evidence_ledger.exports import generate_export_bundle
    from policy_evidence_ledger.schemas import ClaimCreate, EvidenceCreate

    seed_demo(store)
    template = store.list_claims()[0]
    payload = template.model_dump(exclude={"id", "created_at", "evidence", "superseded_by"})
    original = store.add_claim(ClaimCreate(**{**payload, "claim_text": "Obsolete draft finding"}))
    revised = store.revise_claim(original.id, ClaimRevision(**payload, rationale="Corrected scope"))
    record = template.evidence[0].model_dump(exclude={"id", "created_at", "origin"})
    store.add_evidence(EvidenceCreate(**{**record, "claim_id": revised.id}))
    assert not store.export_issues()
    archive, _ = generate_export_bundle(store)
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        assert b"Obsolete draft finding" not in bundle.read("claims.md")
        assert b"Obsolete draft finding" in bundle.read("claim-history.csv")
        assert original.id.encode() in bundle.read("claim-revisions.csv")


def test_revision_cycle_blocks_export(store: LedgerStore):
    seed_demo(store)
    original = store.list_claims()[0]
    payload = original.model_dump(exclude={"id", "created_at", "evidence", "superseded_by"})
    revised = store.revise_claim(original.id, ClaimRevision(**payload, rationale="New scope"))
    with store.connect() as connection:
        connection.execute(
            "INSERT INTO claim_revisions VALUES (?, ?, ?, ?, ?)",
            (
                "REV-CYCLE",
                revised.id,
                original.id,
                "Invalid cycle",
                original.created_at.isoformat(),
            ),
        )
    assert "claim revision history contains a cycle" in store.export_issues()
