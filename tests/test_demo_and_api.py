from __future__ import annotations

import io
import zipfile
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

import policy_evidence_ledger.app as app_module
import policy_evidence_ledger.seed as seed_module
from policy_evidence_ledger.app import app
from policy_evidence_ledger.ingestion import FetchedSource
from policy_evidence_ledger.seed import load_manifest, seed_demo
from policy_evidence_ledger.storage import LedgerStore


def test_demo_seed_is_public_only_and_idempotent(store: LedgerStore) -> None:
    assert seed_demo(store) is True
    assert seed_demo(store) is False
    sources = store.list_sources()
    assert len(sources) == 6
    assert all(source.ingest_mode == "demo" for source in sources)
    assert all(source.document_hash is None for source in sources)
    assert all(
        source.url
        and (
            str(source.url).startswith("https://www.govinfo.gov/")
            or str(source.url).startswith("https://www.mofcom.gov.cn/")
        )
        for source in sources
    )
    dashboard = store.dashboard()
    manifest = load_manifest()
    assert len(dashboard.claims) == len(manifest["claims"])
    assert len(dashboard.definitions) == len(manifest["definitions"])
    assert len(dashboard.comparisons) == len(manifest["comparisons"])
    assert len(dashboard.decisions) == len(manifest["decisions"]) + 1
    assert {evidence.exact_text for claim in dashboard.claims for evidence in claim.evidence} == {
        evidence["exact_text"] for claim in manifest["claims"] for evidence in claim["evidence"]
    }
    assert dashboard.export_ready is True


def test_demo_seed_failure_leaves_original_ledger_empty(store: LedgerStore, monkeypatch) -> None:
    manifest = load_manifest()
    manifest["claims"][0]["claim_text"] = ""
    monkeypatch.setattr(seed_module, "load_manifest", lambda: manifest)

    with pytest.raises(ValueError):
        seed_module.seed_demo(store)

    assert store.has_research_records() is False


def test_api_exposes_complete_seeded_workflow(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PEL_INSTANCE_DIR", str(tmp_path / "instance"))
    monkeypatch.setenv("PEL_AUTO_SEED", "true")
    with TestClient(app) as client:
        assert client.get("/api/health").json()["status"] == "ok"
        dashboard = client.get("/api/dashboard").json()
        assert dashboard["export_ready"] is True
        assert len(dashboard["sources"]) == 6
        assert len(dashboard["claims"]) == 4
        assert any(
            evidence["role"] == "counterevidence"
            for claim in dashboard["claims"]
            for evidence in claim["evidence"]
        )
        response = client.post("/api/export")
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/zip"
        assert len(response.content) > 1000


def test_backend_responses_cannot_be_framed(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PEL_INSTANCE_DIR", str(tmp_path / "anti-framing"))
    monkeypatch.setenv("PEL_AUTO_SEED", "false")
    with TestClient(app) as client:
        response = client.get("/api/health")
        rejected = client.post(
            "/api/claims",
            json={},
            headers={"origin": "https://evil.example"},
        )

    for checked in (response, rejected):
        assert checked.headers["content-security-policy"] == "frame-ancestors 'none'"
        assert checked.headers["x-frame-options"] == "DENY"


def test_api_full_mutation_workflow_reaches_traceable_export(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PEL_INSTANCE_DIR", str(tmp_path / "fresh-instance"))
    monkeypatch.setenv("PEL_AUTO_SEED", "false")
    with TestClient(app) as client:
        source_response = client.post(
            "/api/sources",
            json={
                "title": "Public policy record",
                "author_institution": "Public institution",
                "publication_date": "2026-01-15",
                "source_type": "official_statement",
                "url": "https://example.gov/policy-record",
                "metadata_status": "pending",
                "ingest_mode": "manual",
                "language": "en",
                "notes": "Integration-test citation.",
            },
        )
        assert source_response.status_code == 201
        source_id = source_response.json()["source"]["id"]
        assert client.patch(f"/api/sources/{source_id}/verify").status_code == 200

        claim_ids: list[str] = []
        for index, status in enumerate(("supported", "contested"), start=1):
            response = client.post(
                "/api/claims",
                json={
                    "claim_text": f"Policy claim {index}",
                    "interpretation": "Researcher interpretation kept separate.",
                    "confidence": "moderate",
                    "known_limitation": "One official record only.",
                    "status": status,
                    "policy_outcome": "Implementation",
                    "case_name": f"Case {index}",
                    "time_period": "2026",
                },
            )
            assert response.status_code == 201
            claim_ids.append(response.json()["id"])

        evidence_ids: list[str] = []
        for index, (claim_id, locator) in enumerate(
            zip(claim_ids, ("paragraph 2", "paragraph 4"), strict=True)
        ):
            response = client.post(
                "/api/evidence",
                json={
                    "claim_id": claim_id,
                    "source_id": source_id,
                    "role": "supporting",
                    "kind": "data_point",
                    "exact_text": f"Located record for {claim_id}.",
                    "locator_type": "paragraph" if index else None,
                    "locator": locator if index else None,
                    "review_state": "approved" if index else "draft",
                    "reviewer_note": "Checked in the source.",
                },
            )
            assert response.status_code == 201
            evidence_ids.append(response.json()["id"])

        approved = client.patch(
            f"/api/evidence/{evidence_ids[0]}/approve",
            json={
                "locator_type": "paragraph",
                "locator": "paragraph 2",
                "reviewer_note": "Completed and checked in the source.",
            },
        )
        assert approved.status_code == 200
        assert approved.json()["review_state"] == "approved"
        assert approved.json()["locator"] == "paragraph 2"

        counter = client.post(
            "/api/evidence",
            json={
                "claim_id": claim_ids[0],
                "source_id": source_id,
                "role": "counterevidence",
                "kind": "data_point",
                "exact_text": "A located qualification to the first claim.",
                "locator_type": "paragraph",
                "locator": "paragraph 7",
                "review_state": "approved",
                "reviewer_note": "Checked in the source.",
            },
        )
        assert counter.status_code == 201

        comparison = client.post(
            "/api/comparisons",
            json={
                "claim_a_id": claim_ids[0],
                "claim_b_id": claim_ids[1],
                "relation": "disagrees",
                "rationale": "The claims reach different conclusions for the same outcome.",
            },
        )
        assert comparison.status_code == 201
        decision = client.post(
            "/api/decisions",
            json={
                "entity_type": "claim",
                "entity_id": claim_ids[0],
                "before_state": "unclear",
                "after_state": "supported",
                "rationale": "A located official record changed the assessment.",
            },
        )
        assert decision.status_code == 201

        readiness = client.get("/api/export/readiness").json()
        assert readiness == {"ready": True, "issues": []}
        exported = client.post("/api/export")
        assert exported.status_code == 200
        with zipfile.ZipFile(io.BytesIO(exported.content)) as archive:
            claims_markdown = archive.read("claims.md").decode()
            matrix = archive.read("contradiction-matrix.csv").decode()
        assert all(claim_id in claims_markdown for claim_id in claim_ids)
        assert source_id in matrix
        assert "paragraph 2" in matrix


def test_source_api_forces_human_verification_and_rejects_internal_modes(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("PEL_INSTANCE_DIR", str(tmp_path / "source-api"))
    monkeypatch.setenv("PEL_AUTO_SEED", "false")
    base = {
        "title": "Public record",
        "author_institution": "Public institution",
        "source_type": "official_statement",
        "url": "https://example.gov/record",
        "metadata_status": "verified",
        "language": "en",
    }
    with TestClient(app) as client:
        created = client.post("/api/sources", json={**base, "ingest_mode": "manual"})
        assert created.status_code == 201
        assert created.json()["source"]["metadata_status"] == "pending"

        for mode in ("upload", "demo"):
            rejected = client.post("/api/sources", json={**base, "ingest_mode": mode})
            assert rejected.status_code == 422
            assert "internal only" in rejected.json()["detail"]

        assert client.post("/api/export").status_code == 422


def test_api_rejects_untrusted_hosts_and_unknown_fields(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PEL_INSTANCE_DIR", str(tmp_path / "strict-api"))
    monkeypatch.setenv("PEL_AUTO_SEED", "false")
    with TestClient(app) as client:
        assert client.get("/api/health", headers={"host": "attacker.example"}).status_code == 400
        response = client.post(
            "/api/claims",
            json={
                "claim_text": "A claim.",
                "interpretation": "An interpretation.",
                "confidence": "moderate",
                "known_limitation": "A limitation.",
                "status": "unclear",
                "policy_outcome": "Outcome",
                "case_nam": "misspelled field",
            },
        )
        assert response.status_code == 422
        assert response.json()["detail"][0]["type"] == "extra_forbidden"


def test_api_rejects_cross_origin_writes(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PEL_INSTANCE_DIR", str(tmp_path / "origin-guard"))
    monkeypatch.setenv("PEL_AUTO_SEED", "false")
    source = {
        "title": "Public record",
        "author_institution": "Public institution",
        "source_type": "official_statement",
        "ingest_mode": "manual",
    }
    with TestClient(app) as client:
        rejected = client.post(
            "/api/sources/upload",
            data={
                "title": "Cross-site upload",
                "author_institution": "Untrusted page",
                "source_type": "report",
            },
            files={"file": ("source.txt", b"untrusted bytes", "text/plain")},
            headers={"origin": "https://evil.example"},
        )
        assert rejected.status_code == 403
        assert client.get("/api/sources").json() == []

        rejected_without_origin = client.post(
            "/api/sources",
            json=source,
            headers={"sec-fetch-site": "cross-site"},
        )
        assert rejected_without_origin.status_code == 403

        allowed_origin = "http://127.0.0.1:47832"
        accepted = client.post(
            "/api/sources",
            json=source,
            headers={"origin": allowed_origin},
        )
        assert accepted.status_code == 201
        assert accepted.headers["access-control-allow-origin"] == allowed_origin


@pytest.mark.parametrize(
    "override",
    [
        {"title": "   "},
        {"url": "https://user:secret@example.com/report"},
    ],
)
def test_upload_validation_errors_are_serializable_422(
    tmp_path: Path, monkeypatch, override: dict[str, str]
) -> None:
    monkeypatch.setenv("PEL_INSTANCE_DIR", str(tmp_path / "upload-validation"))
    monkeypatch.setenv("PEL_AUTO_SEED", "false")
    data = {
        "title": "Public upload",
        "author_institution": "Public institution",
        "source_type": "report",
        **override,
    }
    with TestClient(app) as client:
        response = client.post(
            "/api/sources/upload",
            data=data,
            files={"file": ("source.txt", b"public bytes", "text/plain")},
        )

    assert response.status_code == 422
    assert isinstance(response.json()["detail"], list)


def test_url_fetch_failures_are_reported_as_bad_gateway(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PEL_INSTANCE_DIR", str(tmp_path / "failed-fetch"))
    monkeypatch.setenv("PEL_AUTO_SEED", "false")

    async def fail_fetch(_url: str):
        raise httpx.ConnectError("upstream unavailable")

    monkeypatch.setattr(app_module, "fetch_public_source", fail_fetch)
    with TestClient(app) as client:
        response = client.post(
            "/api/sources",
            json={
                "title": "Public record",
                "author_institution": "Public institution",
                "source_type": "official_statement",
                "url": "https://example.gov/record",
                "ingest_mode": "url",
            },
        )
    assert response.status_code == 502
    assert response.json() == {
        "detail": "the public source could not be fetched from the remote server"
    }


def test_redirect_metadata_cannot_overflow_source_notes(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("PEL_INSTANCE_DIR", str(tmp_path / "redirect-note"))
    monkeypatch.setenv("PEL_AUTO_SEED", "false")

    async def redirected(_url: str):
        return FetchedSource(
            content=b"public record",
            content_type="text/plain",
            final_url="https://example.com/final",
        )

    monkeypatch.setattr(app_module, "fetch_public_source", redirected)
    with TestClient(app) as client:
        response = client.post(
            "/api/sources",
            json={
                "title": "Redirected public record",
                "author_institution": "Public institution",
                "source_type": "official_statement",
                "url": "https://example.com/start",
                "ingest_mode": "url",
                "notes": "n" * 4000,
            },
        )
        readiness = client.get("/api/export/readiness").json()

    assert response.status_code == 201
    stored_notes = response.json()["source"]["notes"]
    assert len(stored_notes) <= 4000
    assert stored_notes.endswith("Resolved download URL: https://example.com/final")
    assert all("invalid sources record data" not in issue for issue in readiness["issues"])


def test_unknown_api_get_is_json_404_even_when_frontend_is_built(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("PEL_INSTANCE_DIR", str(tmp_path / "api-404"))
    monkeypatch.setenv("PEL_AUTO_SEED", "false")
    with TestClient(app) as client:
        response = client.get("/api/does-not-exist")
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/json")
