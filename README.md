# Policy Evidence Ledger

Policy Evidence Ledger is a local-first workspace for policy research that needs to survive scrutiny. It keeps a claim, the exact source passage or data point, its locator, the researcher’s interpretation, uncertainty, counterevidence, and changes in judgment as separate records.

The application is built for a practical workflow:

`ADD SOURCE → VERIFY METADATA → CAPTURE CLAIM → RECORD EVIDENCE → ADD COUNTEREVIDENCE → COMPARE CASES → EXPORT RESEARCH OUTPUT`

The first demonstration studies official records on U.S. advanced-compute controls and Chinese responses. The data model and interface are topic-neutral, so the same workflow can be reused for other policy research.

[Open the public read-only demonstration](https://policy-evidence-ledger.moaydghazzawi.com/)

![Research desk](docs/screenshots/research-desk.png)

## Why this exists

Policy notes often collapse three different things into one paragraph: what a source says, what the researcher thinks it means, and what a tool generated. That makes later review difficult and turns citation repair into archaeology.

Policy Evidence Ledger instead uses explicit provenance and a fail-closed export rule. A claim cannot enter a research export unless it has human-approved evidence tied to verified source metadata and a real page, section, paragraph, table, article, timestamp, or other locator. Draft and machine-suggested material never silently becomes evidence.

## What works

- Add sources by public URL, PDF/HTML/text upload, or manual citation.
- Compute a SHA-256 hash before storing downloaded or uploaded bytes in content-addressed local storage.
- Detect identical files, preserve duplicate-retrieval metadata, and record timestamped same-URL content transitions without overwriting snapshots.
- Verify metadata before approving evidence.
- Record structured claims, source text or data, locators, interpretations, confidence, limitations, status, and counterevidence.
- Version working definitions with a rationale for every change.
- Compare claims as agreeing, disagreeing, using different definitions or periods, or mixed.
- Keep a research-decision log.
- Export citation-ready Markdown, evidence CSV, case-comparison and contradiction matrices, a memo outline, a bibliography, and a hashed export manifest.
- Work without an API key or paid service.
- Fall back to a read-only public demonstration if the local Python API is unavailable.

The project does not summarize documents with AI. Its schema reserves a separate, unverified machine-suggestion boundary for future experiments, but the MVP contains no model call and exports no machine suggestions.

## Quick start

Requirements: Python 3.11 or newer, Node.js 22.13 or newer, and npm.

```bash
python3 -m venv .venv
.venv/bin/pip install -e '.[dev]'
npm ci
npm run dev:full
```

Open <http://localhost:3000>. The local API is available at <http://127.0.0.1:8000/docs>. On first run, an empty local database is created in `instance/` and populated with the public demo corpus. `instance/` is ignored by Git.

To run only the backend and a previously built interface:

```bash
npm run build
.venv/bin/policy-evidence-ledger serve
```

The complete interface is served from a source checkout after `npm run build`. A wheel built from this repository is a backend/CLI distribution and does not bundle the generated React assets.

To start with an empty ledger:

```bash
.venv/bin/policy-evidence-ledger serve --no-auto-seed --instance-dir instance/empty
```

Use a new or empty instance path; `--no-auto-seed` does not delete records from an existing database. Use `--instance-dir /path/to/folder` to keep research data somewhere other than `instance/`. The server binds to `127.0.0.1` by default.

Backend settings use these CLI flags (or explicitly exported `PEL_INSTANCE_DIR` and `PEL_AUTO_SEED` environment variables). The Python service does not implicitly load a `.env` file.

## Demonstration

The seeded workspace contains six selected citation-only records from official public sources:

1. [BIS October 2022 interim final rule, 87 FR 62186](https://www.govinfo.gov/content/pkg/FR-2022-10-13/pdf/2022-21658.pdf)
2. [BIS October 2023 interim final rule, 88 FR 73458](https://www.govinfo.gov/content/pkg/FR-2023-10-25/pdf/2023-23055.pdf)
3. [BIS December 2024 interim final rule, 89 FR 96790](https://www.govinfo.gov/content/pkg/FR-2024-12-05/pdf/2024-28270.pdf)
4. [MOFCOM spokesperson response, October 18, 2023](https://www.mofcom.gov.cn/xwfb/art/2023/art_019986ab22c74613894fafe14719f56e.html)
5. [MOFCOM Announcement No. 46 of 2024](https://www.mofcom.gov.cn/zcfb/blgg/gg/2024/art/2024/art_1f22e2926a1d49b88d6b329549afcbdc.html)
6. [MOFCOM Announcement No. 72 of 2025](https://www.mofcom.gov.cn/zcfb/blgg/gg/2025/art/2025/art_bc4513421bb24faaa84e44c2e4f36dc5.html), the current-status source. As checked on September 3, 2026, it suspends only the second numbered provision of Announcement No. 46 from November 9, 2025 through November 27, 2026; it does not suspend the rest of No. 46.

The records demonstrate policy sequencing, a scope-limited current-status correction, a rejected overbroad claim with counterevidence, a definition revision, two human-classified comparisons, and a decision-log update. Descriptive English text for Chinese-language sources is labeled accordingly. The selection is illustrative rather than exhaustive. Because the demo stores citations rather than copied source files, its document hashes are explicitly reported as `unavailable: citation-only`; URL ingestion or upload captures and hashes the preserved source bytes.

![Claim cards](docs/screenshots/claim-cards.png)

## Design

The backend is intentionally small: FastAPI for a typed local API, Pydantic for validation, and SQLite for durable structured storage. Original source bytes are stored outside the database by SHA-256 digest. The React interface focuses on the research sequence rather than generic dashboard metrics.

Core records are:

- `Source`: citation metadata, verification state, ingest mode, access date, and optional content hash.
- `Claim`: plain-language claim, researcher interpretation, confidence, known limitation, status, outcome, case, and period.
- `Evidence`: supporting or counterevidence text/data, source ID, locator, and human review state.
- `DefinitionVersion`: an immutable version number, definition, scope, and change rationale.
- `Comparison`: two claims, a classified relationship, and a rationale.
- `Decision`: before/after state and the reason a research judgment changed.
- `MachineSuggestion`: structurally separate and unverified; never included in MVP exports.

See [Public demonstration methodology](docs/methodology.md), [Import and export](docs/import-export.md), [Architecture](docs/architecture.md), and [Privacy and security](docs/privacy-security.md).

## Tests and quality checks

```bash
npx playwright install chromium
npm test
npm run build
```

On Linux, use `npx playwright install --with-deps chromium` if Chromium's system libraries are not already installed.

The suite covers source hashing, duplicate retrievals and version transitions, schema validation, citation and locator preservation, locked-snapshot exports, tamper detection, CSV/Markdown safety, canonical demo parity, the API and browser workflows, keyboard reachability, responsive overflow down to 320 px, and serious/critical accessibility violations with axe. GitHub Actions checks Python 3.11 and 3.12, TypeScript, Python and TypeScript lint/format, dependency audits, production build, and Chromium workflows.

Run the repository privacy audit separately before staging or pushing:

```bash
npm run audit:tracked
```

## Privacy and security

SQLite databases, content-addressed source blobs, local exports, environment files, common raw research-document formats, and credential files are ignored. The audit script rejects those blocked paths and scans worktree and staged bytes for common secret patterns. Images still require visual review. URL ingestion accepts public HTTP(S) destinations only, revalidates redirects, blocks private/reserved and address-translation network targets, restricts content types, and caps sources at 25 MB. Credential-bearing citation URLs are rejected, state-changing API requests from non-loopback browser origins are refused, and local/hosted responses send anti-framing headers.

This is a research-organizing tool, not a secure document-management platform. Keep highly sensitive material on an encrypted device, review every export, and do not expose the local server to a network without adding authentication and deployment hardening.

## Current limits

- Metadata is entered and verified by a person; the MVP does not extract it automatically.
- PDFs and HTML are preserved and hashed, but the app does not render or OCR them in place.
- Citation formatting is a readable research bibliography, not CSL/Zotero output.
- Case comparison is pairwise in the MVP: case names are structured claim fields, not standalone case entities.
- Comparisons do not yet link each side to a specific definition-version ID; the rationale carries that scope.
- Approved evidence cannot yet be revoked or superseded through the interface, and exports include every claim in the selected instance. Use a separate scoped instance when an erroneous record must be excluded.
- There are no accounts, multi-user editing, sync, encryption, or cloud backup.
- The public hosted preview is intentionally read-only because research data and the Python service stay local.
- Official-source statements establish what institutions published, not whether a policy achieved its intended effect.

## License

[MIT](LICENSE) © 2026 Moayd Ghazzawi.
