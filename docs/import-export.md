# Import and export

## Import paths

### Public URL

Choose **Add source**, select URL, and enter the citation metadata and public HTTP(S) address. The backend resolves DNS, rejects localhost and private/reserved addresses, validates every redirect, accepts PDF/HTML/XHTML/plain text, applies a 25 MB limit, hashes the exact bytes preserved by the importer after standard HTTP content decoding, then stores them under `instance/blobs/<digest-prefix>/<digest>`.

If the same bytes already exist, the ledger reuses the content-addressed snapshot and preserves the new retrieval metadata as an alias event, including URL when one exists, access date, citation fields, and its independent metadata-review status. Alias metadata is visible but is not independently selectable as evidence in this MVP; claim traces continue to cite the verified canonical source record.

If an existing URL later returns different bytes, the ledger preserves a timestamped transition between the prior and newly observed snapshots rather than overwriting either one. These are retrieval events, not a promise that the records form an acyclic revision history: a URL can later return earlier bytes again.

### File upload

Upload PDF, HTML, XHTML, or plain text up to 25 MB. The application hashes bytes before storage and uses the same content-addressed duplicate rules as URL ingestion. A file stays on the local machine running the Python service.

### Manual citation

Use this for sources that cannot be downloaded or redistributed. Metadata is stored, but no document bytes exist to hash. The interface and export represent that state as `unavailable: citation-only`; they never invent a hash.

## Verification and evidence

A new source begins as `pending`. Review the title, author or institution, date, source type, and URL shown in the source register against the original, then mark the metadata verified. Language and notes remain available through the local API. The MVP does not edit a citation in place; enter a corrected record and retain the earlier one as provenance if submitted metadata was wrong.

Evidence can be saved as a draft without a locator while the researcher is working. Approval requires both a locator type and a nonblank locator. The store also refuses approval against an unverified source. This rule exists in the Pydantic schema, the SQLite constraint, and the export readiness check.

Recommended locator examples:

- `page` — `p. 17` or `pp. 17–19`
- `section` — `Supplementary Information § III.A`
- `paragraph` — `operative paragraph 2`
- `table` — `Table 4, row “Advanced-node ICs”`
- `article` — `Article 6(2)`
- `timestamp` — `00:13:42–00:14:18`

Record the exact passage or data point in the evidence field. Put analytical meaning in the claim’s interpretation and uncertainty in its known limitation. Counterevidence is a first-class evidence role, not a note appended to the conclusion.

## Export readiness

Export fails closed unless all of the following are true:

- the ledger contains at least one claim;
- every claim has at least one approved evidence record;
- every approved evidence record points to a verified source;
- every approved evidence record has a locator type and locator;
- every captured source snapshot still matches its stored SHA-256 hash.

Draft evidence and machine suggestions are excluded. An invalid record cannot be hidden by adding a valid one; all approved evidence is rechecked.

## Export bundle

The **Export research output** action downloads a ZIP containing:

| File                               | Purpose                                                                                                            |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `claims.md`                        | Citation-ready claim notes with separate source text, interpretation, limitation, locator, metadata, and trace IDs |
| `evidence.csv`                     | One row per approved evidence record, including supporting/counterevidence role                                    |
| `case-comparison.md` / `.csv`      | Claims grouped with case, period, outcome, status, confidence, and evidence count                                  |
| `contradiction-matrix.md` / `.csv` | Human-classified agreement, disagreement, definition, period, or mixed relationships                               |
| `memo-outline.md`                  | Short outline organized around findings, counterarguments, uncertainty, and implications                           |
| `bibliography.md`                  | Referenced sources only                                                                                            |
| `source-aliases.csv`               | Duplicate-retrieval citation metadata for evidence-referenced sources, including review status                     |
| `source-versions.csv`              | Same-URL content-transition events whose two source records are evidence-referenced                                |
| `manifest.json`                    | App/schema version, generation time, record IDs, source hashes, and SHA-256 for each non-manifest output           |

Potential spreadsheet formulas at the start of a CSV cell are prefixed with an apostrophe and identified by `csv_formula_escaped=true`; removing that documented prefix recovers the underlying field text. Markdown control syntax and raw HTML in researcher-entered fields are escaped. The unsigned export manifest records hashes for internal-consistency and accidental-corruption checks; it cannot prove authenticity against a deliberate edit that also rewrites the manifest.

An export contains the full claim set in its instance. To create a narrowly scoped bundle, work in a separate scoped instance and review the entire ZIP before sharing it. The MVP does not yet archive claims or revoke approved evidence through the interface; retain corrections as rejected claims, counterevidence, and decision-log entries, or use a new scoped instance when an erroneous row must be excluded.

## API equivalents

The interactive API documentation is at `/docs` while the backend is running. The main routes are:

- `POST /api/sources`, `POST /api/sources/upload`, `PATCH /api/sources/{id}/verify`
- `POST /api/claims`, `POST /api/evidence`
- `PATCH /api/evidence/{id}/approve`
- `POST /api/definitions`, `POST /api/comparisons`, `POST /api/decisions`
- `GET /api/export/readiness`, `POST /api/export`

The browser interface is the supported MVP workflow. The JSON API is deliberately simple and may change before version 1.0.
