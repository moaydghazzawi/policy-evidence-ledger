from __future__ import annotations

import csv
import hashlib
import html
import io
import json
import zipfile
from collections import defaultdict
from datetime import UTC, datetime

from .storage import LedgerStore

EXPORT_SCHEMA_VERSION = "1.0"


class ExportBlocked(ValueError):
    def __init__(self, issues: list[str]) -> None:
        super().__init__("export blocked by provenance validation")
        self.issues = issues


def _safe_markdown(value: object) -> str:
    text = html.escape(str(value), quote=False)
    for character in ("\\", "`", "*", "_", "[", "]", "!", "#", ">"):
        text = text.replace(character, f"\\{character}")
    return text


def _safe_markdown_inline(value: object) -> str:
    return _safe_markdown(value).replace("\r\n", " ").replace("\n", " ").replace("\r", " ")


def _markdown_quote(value: str) -> str:
    safe = _safe_markdown(value)
    return "\n".join(f"> {line}" if line else ">" for line in safe.splitlines())


def _safe_csv_cell(value: object) -> tuple[object, bool]:
    if not isinstance(value, str):
        return value, False
    if value.startswith(("\t", "\r", "\n")) or value.lstrip(" \t\r\n").startswith(
        ("=", "+", "-", "@")
    ):
        return "'" + value, True
    return value, False


def _markdown_table_cell(value: object) -> str:
    return (
        _safe_markdown(value)
        .replace("|", "\\|")
        .replace("\r\n", "<br>")
        .replace("\n", "<br>")
        .replace("\r", "<br>")
    )


def _write_csv(rows: list[dict[str, object]], columns: list[str]) -> str:
    output = io.StringIO(newline="")
    writer = csv.DictWriter(output, fieldnames=columns, lineterminator="\n")
    writer.writeheader()
    for row in rows:
        safe_row: dict[str, object] = {}
        escaped = False
        for column in columns:
            if column == "csv_formula_escaped":
                continue
            safe_value, was_escaped = _safe_csv_cell(row.get(column, ""))
            safe_row[column] = safe_value
            escaped = escaped or was_escaped
        if "csv_formula_escaped" in columns:
            safe_row["csv_formula_escaped"] = "true" if escaped else "false"
        writer.writerow(safe_row)
    return output.getvalue()


def generate_export_bundle(
    store: LedgerStore, generated_at: datetime | None = None
) -> tuple[bytes, str]:
    issues, records = store.export_snapshot()
    if issues:
        raise ExportBlocked(issues)

    generated_at = (generated_at or datetime.now(UTC)).replace(microsecond=0)
    sources = {str(item["id"]): item for item in records["sources"]}
    claims = {str(item["id"]): item for item in records["claims"]}
    approved_evidence = [item for item in records["evidence"] if item["review_state"] == "approved"]
    referenced_source_ids = {str(item["source_id"]) for item in approved_evidence}
    referenced_aliases = [
        item
        for item in records["source_aliases"]
        if str(item["source_id"]) in referenced_source_ids
    ]
    referenced_versions = [
        item
        for item in records["source_versions"]
        if str(item["previous_source_id"]) in referenced_source_ids
        and str(item["source_id"]) in referenced_source_ids
    ]
    evidence_by_claim: dict[str, list[dict[str, object]]] = defaultdict(list)
    for item in approved_evidence:
        evidence_by_claim[str(item["claim_id"])].append(item)

    files: dict[str, str] = {}

    claim_lines = [
        "# Citation-ready claim notes",
        "",
        f"Generated: {generated_at.isoformat()}",
        "",
        "Source content, researcher interpretation, and uncertainty are separated below.",
        "",
    ]
    for claim_id, claim in claims.items():
        claim_lines.extend(
            [
                f"## {claim_id}: {_safe_markdown_inline(claim['claim_text'])}",
                "",
                f"- **Status:** {claim['status']}",
                f"- **Confidence:** {claim['confidence']}",
                f"- **Policy outcome:** {_safe_markdown_inline(claim['policy_outcome'])}",
                f"- **Case / period:** "
                f"{_safe_markdown_inline(claim['case_name'] or 'Not assigned')} / "
                f"{_safe_markdown_inline(claim['time_period'] or 'Not assigned')}",
                "",
                "### Researcher interpretation",
                "",
                _safe_markdown(claim["interpretation"]),
                "",
                "### Known limitation",
                "",
                _safe_markdown(claim["known_limitation"]),
                "",
                "### Located source records",
                "",
            ]
        )
        for index, evidence in enumerate(evidence_by_claim[claim_id], start=1):
            digest = evidence["source_document_hash"] or "unavailable: citation-only"
            evidence_text = str(evidence["exact_text"])
            rendered_record = (
                _markdown_quote(evidence_text)
                if evidence["kind"] == "passage"
                else f"Data point (researcher-entered): {_safe_markdown(evidence_text)}"
            )
            claim_lines.extend(
                [
                    f"#### {index}. {evidence['role']} / {evidence['kind']} — "
                    f"{_safe_markdown_inline(evidence['source_title'])}",
                    "",
                    rendered_record,
                    "",
                    f"Locator: {evidence['locator_type']} — "
                    f"{_safe_markdown_inline(evidence['locator'])}",
                    f"Review note: "
                    f"{_safe_markdown_inline(evidence['reviewer_note'] or 'None recorded')}",
                    f"Source: {_safe_markdown_inline(evidence['source_author_institution'])}; "
                    f"{_safe_markdown_inline(evidence['source_publication_date'] or 'no date')}; "
                    f"{_safe_markdown_inline(evidence['source_url'] or 'manual citation')}",
                    f"Accessed: {evidence['source_access_date']} · SHA-256: {digest}",
                    f"Trace IDs: claim `{claim_id}` · evidence `{evidence['id']}` · "
                    f"source `{evidence['source_id']}`",
                    "",
                ]
            )
    files["claims.md"] = "\n".join(claim_lines).rstrip() + "\n"

    evidence_rows: list[dict[str, object]] = []
    for item in approved_evidence:
        claim = claims[str(item["claim_id"])]
        evidence_rows.append(
            {
                "claim_id": item["claim_id"],
                "claim": claim["claim_text"],
                "claim_status": claim["status"],
                "confidence": claim["confidence"],
                "policy_outcome": claim["policy_outcome"],
                "case_name": claim["case_name"],
                "time_period": claim["time_period"],
                "interpretation": claim["interpretation"],
                "known_limitation": claim["known_limitation"],
                "evidence_id": item["id"],
                "evidence_role": item["role"],
                "evidence_kind": item["kind"],
                "exact_source_text_or_data": item["exact_text"],
                "source_id": item["source_id"],
                "source_title": item["source_title"],
                "source_author_institution": item["source_author_institution"],
                "source_publication_date": item["source_publication_date"],
                "source_url": item["source_url"],
                "source_access_date": item["source_access_date"],
                "source_document_hash": item["source_document_hash"]
                or "unavailable: citation-only",
                "locator_type": item["locator_type"],
                "locator": item["locator"],
            }
        )
    evidence_columns = [
        "claim_id",
        "claim",
        "claim_status",
        "confidence",
        "policy_outcome",
        "case_name",
        "time_period",
        "interpretation",
        "known_limitation",
        "evidence_id",
        "evidence_role",
        "evidence_kind",
        "exact_source_text_or_data",
        "source_id",
        "source_title",
        "source_author_institution",
        "source_publication_date",
        "source_url",
        "source_access_date",
        "source_document_hash",
        "locator_type",
        "locator",
        "csv_formula_escaped",
    ]
    files["evidence.csv"] = _write_csv(evidence_rows, evidence_columns)

    alias_columns = [
        "id",
        "source_id",
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
        "csv_formula_escaped",
    ]
    files["source-aliases.csv"] = _write_csv(referenced_aliases, alias_columns)

    version_columns = [
        "id",
        "previous_source_id",
        "source_id",
        "url",
        "created_at",
        "csv_formula_escaped",
    ]
    files["source-versions.csv"] = _write_csv(referenced_versions, version_columns)

    case_rows = [
        {
            "claim_id": claim_id,
            "case_name": claim["case_name"] or "Unassigned",
            "time_period": claim["time_period"] or "Unassigned",
            "policy_outcome": claim["policy_outcome"],
            "claim": claim["claim_text"],
            "status": claim["status"],
            "confidence": claim["confidence"],
            "approved_evidence_count": len(evidence_by_claim[claim_id]),
        }
        for claim_id, claim in claims.items()
    ]
    case_columns = [
        "claim_id",
        "case_name",
        "time_period",
        "policy_outcome",
        "claim",
        "status",
        "confidence",
        "approved_evidence_count",
        "csv_formula_escaped",
    ]
    files["case-comparison.csv"] = _write_csv(case_rows, case_columns)
    case_md = [
        "# Case-comparison matrix",
        "",
        "| Claim | Case | Period | Outcome | Status | Confidence | Located records |",
        "|---|---|---|---|---|---|---:|",
    ]
    for row in case_rows:
        case_md.append(
            "| "
            + " | ".join(
                _markdown_table_cell(row[column])
                for column in (
                    "claim_id",
                    "case_name",
                    "time_period",
                    "policy_outcome",
                    "status",
                    "confidence",
                    "approved_evidence_count",
                )
            )
            + " |"
        )
    files["case-comparison.md"] = "\n".join(case_md) + "\n"

    comparison_rows = [
        {
            "comparison_id": item["id"],
            "claim_a_id": item["claim_a_id"],
            "claim_a": claims[str(item["claim_a_id"])]["claim_text"],
            "claim_b_id": item["claim_b_id"],
            "claim_b": claims[str(item["claim_b_id"])]["claim_text"],
            "claim_a_source_ids": " | ".join(
                sorted(
                    {
                        str(record["source_id"])
                        for record in evidence_by_claim[str(item["claim_a_id"])]
                    }
                )
            ),
            "claim_a_locators": " | ".join(
                f"{record['locator_type']}: {record['locator']}"
                for record in evidence_by_claim[str(item["claim_a_id"])]
            ),
            "claim_b_source_ids": " | ".join(
                sorted(
                    {
                        str(record["source_id"])
                        for record in evidence_by_claim[str(item["claim_b_id"])]
                    }
                )
            ),
            "claim_b_locators": " | ".join(
                f"{record['locator_type']}: {record['locator']}"
                for record in evidence_by_claim[str(item["claim_b_id"])]
            ),
            "relation": item["relation"],
            "rationale": item["rationale"],
        }
        for item in records["comparisons"]
    ]
    comparison_columns = [
        "comparison_id",
        "claim_a_id",
        "claim_a",
        "claim_b_id",
        "claim_b",
        "claim_a_source_ids",
        "claim_a_locators",
        "claim_b_source_ids",
        "claim_b_locators",
        "relation",
        "rationale",
        "csv_formula_escaped",
    ]
    files["contradiction-matrix.csv"] = _write_csv(comparison_rows, comparison_columns)
    contradiction_md = [
        "# Contradiction matrix",
        "",
        "Relationships are human-classified; the application does not infer disagreement.",
        "",
        "| Claim A | Claim A trace | Claim B | Claim B trace | Relationship | Rationale |",
        "|---|---|---|---|---|---|",
    ]
    for row in comparison_rows:
        claim_a_trace = f"{row['claim_a_source_ids']} — {row['claim_a_locators']}"
        claim_b_trace = f"{row['claim_b_source_ids']} — {row['claim_b_locators']}"
        contradiction_md.append(
            "| "
            + " | ".join(
                _markdown_table_cell(value)
                for value in (
                    row["claim_a_id"],
                    claim_a_trace,
                    row["claim_b_id"],
                    claim_b_trace,
                    row["relation"],
                    row["rationale"],
                )
            )
            + " |"
        )
    files["contradiction-matrix.md"] = "\n".join(contradiction_md) + "\n"

    memo_lines = [
        "# Short policy-memo outline",
        "",
        "## Question",
        "",
        "What does the current evidence establish, contest, or leave uncertain?",
        "",
        "## Bottom line",
        "",
        "Draft only after resolving the uncertainty and counterevidence listed below.",
        "",
        "## Evidence by finding",
        "",
    ]
    for claim_id, claim in claims.items():
        counter = [
            item for item in evidence_by_claim[claim_id] if item["role"] == "counterevidence"
        ]
        trace = "; ".join(
            f"{item['id']} → {item['source_id']} ({item['locator_type']}: {item['locator']})"
            for item in evidence_by_claim[claim_id]
        )
        memo_lines.extend(
            [
                f"### {_safe_markdown_inline(claim['claim_text'])}",
                "",
                f"- Claim ID: {claim_id}",
                f"- Status/confidence: {claim['status']} / {claim['confidence']}",
                f"- Interpretation: {_safe_markdown_inline(claim['interpretation'])}",
                f"- Limitation: {_safe_markdown_inline(claim['known_limitation'])}",
                f"- Located records: {len(evidence_by_claim[claim_id])}",
                f"- Counterevidence records: {len(counter)}",
                f"- Evidence trace: {_safe_markdown_inline(trace)}",
                "",
            ]
        )
    memo_lines.extend(
        [
            "## Counterarguments and uncertainty",
            "",
            "Retain contested claims, competing definitions, different time periods, "
            "and missing data.",
            "",
            "## Decision implications",
            "",
            "State which conclusions would change if the strongest counterevidence is confirmed.",
            "",
        ]
    )
    files["memo-outline.md"] = "\n".join(memo_lines)

    bibliography = ["# Source bibliography", ""]
    for source_id in sorted(referenced_source_ids):
        source = sources[source_id]
        bibliography.append(
            f"- {_safe_markdown_inline(source['author_institution'])}. "
            f"“{_safe_markdown_inline(source['title'])}.” "
            f"{_safe_markdown_inline(source['publication_date'] or 'n.d.')}. "
            f"{_safe_markdown_inline(source['url'] or 'Manual citation')}. "
            f"Accessed {source['access_date']}. [Source ID: {source_id}]"
        )
    files["bibliography.md"] = "\n".join(bibliography) + "\n"

    file_hashes = {
        name: hashlib.sha256(content.encode("utf-8")).hexdigest()
        for name, content in sorted(files.items())
    }
    manifest = {
        "app": "Policy Evidence Ledger",
        "app_version": "0.1.0",
        "schema_version": EXPORT_SCHEMA_VERSION,
        "generated_at": generated_at.isoformat(),
        "claim_ids": sorted(claims),
        "source_ids": sorted(referenced_source_ids),
        "source_alias_ids": sorted(str(item["id"]) for item in referenced_aliases),
        "source_version_link_ids": sorted(str(item["id"]) for item in referenced_versions),
        "source_hashes": {
            source_id: sources[source_id]["document_hash"] or "unavailable: citation-only"
            for source_id in sorted(referenced_source_ids)
        },
        "output_sha256": file_hashes,
        "machine_suggestions_included": False,
    }
    files["manifest.json"] = json.dumps(manifest, indent=2, sort_keys=True) + "\n"

    archive = io.BytesIO()
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zip_file:
        for name, content in sorted(files.items()):
            info = zipfile.ZipInfo(name)
            info.date_time = (
                generated_at.year,
                generated_at.month,
                generated_at.day,
                generated_at.hour,
                generated_at.minute,
                generated_at.second,
            )
            info.compress_type = zipfile.ZIP_DEFLATED
            zip_file.writestr(info, content.encode("utf-8"))

    filename = f"policy-evidence-ledger-{generated_at.date().isoformat()}.zip"
    return archive.getvalue(), filename
