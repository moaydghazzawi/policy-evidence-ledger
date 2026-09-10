# Policy Evidence Ledger

## Description

A local-first research workspace that makes every exportable policy claim traceable to a verified source and precise locator. It records evidence, counterevidence, changing definitions, contradictions, uncertainty, and research decisions without presenting generated prose as evidence.

## Workflow

`ADD SOURCE → VERIFY METADATA → CAPTURE CLAIM → RECORD EVIDENCE → ADD COUNTEREVIDENCE → COMPARE CASES → EXPORT RESEARCH OUTPUT`

## Current capabilities

- Public URL, PDF/HTML/text upload, and manual-citation ingestion
- SHA-256 source snapshots, deduplication, aliases, and changed-URL versioning
- Metadata verification and human-reviewed source locators
- Structured claims with interpretation, confidence, limitation, status, and counterevidence
- Versioned working definitions
- Case comparison and contradiction relationships
- Research-decision log
- Fail-closed Markdown/CSV/ZIP exports with output hashes
- Public official demonstration corpus
- Keyboard, responsive, and automated accessibility checks
- Private saved online workspaces through ChatGPT sign-in
- Immutable claim revisions with fresh evidence review and full history
- Preserved-source downloads
- Standalone local mode without an API key or model call

The bundled demonstration uses six selected official GovInfo and MOFCOM records, rechecked on September 3, 2026. Its current-status example records that MOFCOM Announcement No. 72 suspends only the second numbered provision of Announcement No. 46 through November 27, 2026—not Announcement No. 46 in full.

## Current limitations

- Metadata verification and evidence extraction are manual.
- The app preserves source files but does not render, OCR, or search their full text.
- Bibliography output is not yet CSL/Zotero compatible.
- No collaboration, local/cloud sync, end-to-end encryption, or backup import.
- Online storage: 900 KB structured ledger, 100 MB snapshots, 25 MB per source.
- Case comparison is pairwise; the MVP does not model cases as standalone entities.
- Anonymous visitors see the public example. Signed-in users get their own private workspace.
- Local research is never automatically uploaded.

## Links

- Live workspace: [policy-evidence-ledger.moaydghazzawi.com](https://policy-evidence-ledger.moaydghazzawi.com/)
- Source repository: [github.com/moaydghazzawi/policy-evidence-ledger](https://github.com/moaydghazzawi/policy-evidence-ledger)
- Future portfolio entry: [moaydghazzawi.com](https://moaydghazzawi.com/) — add a dedicated case study when the broader portfolio is next updated.
