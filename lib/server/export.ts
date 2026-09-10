import { strToU8, zipSync } from 'fflate';
import { env } from 'cloudflare:workers';
import { blobKey, sha256 } from './store';
import {
  LedgerError,
  ledgerSchema,
  provenanceIssues,
  type Ledger,
} from './validation';

const plain = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : value == null
      ? ''
      : (JSON.stringify(value) ?? '');
const md = (value: unknown) =>
  plain(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_[\]!#|]/g, '\\$&');
const inline = (value: unknown) => md(value).replace(/[\r\n]+/g, ' ');
const quote = (value: unknown) =>
  md(value)
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');
export function csv(
  rows: Record<string, unknown>[],
  columns: string[],
): string {
  const encode = (value: unknown) => `"${plain(value).replace(/"/g, '""')}"`;
  return (
    [
      columns.join(','),
      ...rows.map((row) => {
        let escaped = false;
        const cells = columns
          .filter((key) => key !== 'csv_formula_escaped')
          .map((key) => {
            let value = row[key] ?? '';
            if (
              typeof value === 'string' &&
              (/^[\t\r\n]/.test(value) || /^[\s]*[=+\-@]/.test(value))
            ) {
              value = `'${value}`;
              escaped = true;
            }
            return encode(value);
          });
        if (columns.includes('csv_formula_escaped'))
          cells.push(encode(escaped ? 'true' : 'false'));
        return cells.join(',');
      }),
    ].join('\n') + '\n'
  );
}
export async function exportLedger(ownerId: string | null, snapshot: Ledger) {
  const ledger = ledgerSchema.parse(snapshot);
  const issues = provenanceIssues(ledger);
  if (issues.length)
    throw new LedgerError(
      'Export is blocked until the provenance checks pass.',
      422,
      issues,
    );
  const superseded = new Set(
    ledger.claim_revisions.map((item) => item.previous_claim_id),
  );
  const currentClaims = ledger.claims.filter(
    (claim) => !superseded.has(claim.id),
  );
  const approved = ledger.claims.flatMap((claim) =>
    claim.evidence.filter((e) => e.review_state === 'approved'),
  );
  const referenced = new Set(approved.map((e) => e.source_id));
  const sources = ledger.sources.filter((source) => referenced.has(source.id));
  for (const source of sources) {
    if (!source.document_hash) continue;
    if (!ownerId)
      throw new LedgerError('Sign in to export stored source records.', 401);
    const object = await env.BUCKET.get(
      await blobKey(ownerId, source.document_hash),
    );
    if (
      !object ||
      (await sha256(await object.arrayBuffer())) !== source.document_hash
    )
      throw new LedgerError(
        'A preserved source snapshot failed its integrity check.',
        409,
        [source.id],
      );
  }
  const sourceMap = new Map(sources.map((source) => [source.id, source]));
  const files: Record<string, Uint8Array> = {};
  const add = (name: string, text: string) => {
    files[name] = strToU8(text + '\n');
  };
  const generatedAt = new Date().toISOString();
  add(
    'claims.md',
    [
      '# Citation-ready claim notes',
      `Generated: ${generatedAt}`,
      ...currentClaims.map((claim) =>
        [
          `## ${inline(claim.claim_text)}`,
          `Claim: ${claim.id} · ${claim.status} · ${claim.confidence} confidence`,
          `Interpretation: ${inline(claim.interpretation)}`,
          `Known limitation: ${inline(claim.known_limitation)}`,
          ...claim.evidence
            .filter((e) => e.review_state === 'approved')
            .map(
              (e) =>
                `### ${e.role}\n${quote(e.exact_text)}\n\n${e.id} → ${e.source_id} · ${inline(sourceMap.get(e.source_id)?.title)}\n\nLocation: ${e.locator_type}: ${inline(e.locator)}\n\nReview note: ${inline(e.reviewer_note)}`,
            ),
        ].join('\n\n'),
      ),
    ].join('\n\n'),
  );
  add(
    'evidence.csv',
    csv(
      approved.map((e) => {
        const source = sourceMap.get(e.source_id)!;
        const claim = ledger.claims.find((item) => item.id === e.claim_id)!;
        return {
          claim_id: claim.id,
          claim: claim.claim_text,
          claim_status: claim.status,
          confidence: claim.confidence,
          policy_outcome: claim.policy_outcome,
          case_name: claim.case_name,
          time_period: claim.time_period,
          interpretation: claim.interpretation,
          known_limitation: claim.known_limitation,
          evidence_id: e.id,
          evidence_role: e.role,
          evidence_kind: e.kind,
          exact_source_text_or_data: e.exact_text,
          source_id: source.id,
          source_title: source.title,
          source_author_institution: source.author_institution,
          source_publication_date: source.publication_date,
          source_url: source.url,
          source_access_date: source.access_date,
          source_document_hash:
            source.document_hash ?? 'unavailable: citation-only',
          locator_type: e.locator_type,
          locator: e.locator,
        };
      }),
      [
        'claim_id',
        'claim',
        'claim_status',
        'confidence',
        'policy_outcome',
        'case_name',
        'time_period',
        'interpretation',
        'known_limitation',
        'evidence_id',
        'evidence_role',
        'evidence_kind',
        'exact_source_text_or_data',
        'source_id',
        'source_title',
        'source_author_institution',
        'source_publication_date',
        'source_url',
        'source_access_date',
        'source_document_hash',
        'locator_type',
        'locator',
        'csv_formula_escaped',
      ],
    ),
  );
  add(
    'source-aliases.csv',
    csv(
      sources.flatMap((source) =>
        source.aliases.map((alias) => ({ ...alias, source_id: source.id })),
      ),
      [
        'id',
        'source_id',
        'title',
        'author_institution',
        'url',
        'publication_date',
        'access_date',
        'metadata_status',
        'notes',
        'created_at',
        'csv_formula_escaped',
      ],
    ),
  );
  add(
    'source-versions.csv',
    csv(
      ledger.source_versions.filter(
        (item) =>
          referenced.has(item.previous_source_id) &&
          referenced.has(item.source_id),
      ),
      [
        'id',
        'previous_source_id',
        'source_id',
        'url',
        'created_at',
        'csv_formula_escaped',
      ],
    ),
  );
  add(
    'claim-history.csv',
    csv(
      ledger.claims.map((claim) => ({
        ...claim,
        superseded_by:
          ledger.claim_revisions.find(
            (item) => item.previous_claim_id === claim.id,
          )?.claim_id ?? '',
        history_only: superseded.has(claim.id),
      })),
      [
        'id',
        'claim_text',
        'interpretation',
        'confidence',
        'known_limitation',
        'status',
        'policy_outcome',
        'case_name',
        'time_period',
        'created_at',
        'superseded_by',
        'history_only',
        'csv_formula_escaped',
      ],
    ),
  );
  add(
    'claim-revisions.csv',
    csv(ledger.claim_revisions, [
      'id',
      'previous_claim_id',
      'claim_id',
      'rationale',
      'created_at',
      'csv_formula_escaped',
    ]),
  );
  add(
    'case-comparison.csv',
    csv(currentClaims, [
      'id',
      'case_name',
      'time_period',
      'policy_outcome',
      'claim_text',
      'status',
      'confidence',
      'known_limitation',
      'csv_formula_escaped',
    ]),
  );
  add(
    'case-comparison.md',
    [
      '# Case comparison',
      ...currentClaims.map(
        (claim) =>
          `## ${inline(claim.case_name || 'Unassigned case')} · ${inline(claim.time_period)}\n\n${inline(claim.claim_text)}\n\nStatus: ${claim.status}\n\nLimitation: ${inline(claim.known_limitation)}`,
      ),
    ].join('\n\n'),
  );
  add(
    'contradiction-matrix.csv',
    csv(
      ledger.comparisons.map((item) => ({
        ...item,
        claim_a_historical: superseded.has(item.claim_a_id),
        claim_b_historical: superseded.has(item.claim_b_id),
      })),
      [
        'id',
        'claim_a_id',
        'claim_b_id',
        'claim_a_historical',
        'claim_b_historical',
        'relation',
        'rationale',
        'created_at',
        'csv_formula_escaped',
      ],
    ),
  );
  add(
    'contradiction-matrix.md',
    [
      '# Contradiction matrix',
      ...ledger.comparisons.map(
        (item) =>
          `## ${item.claim_a_id}${superseded.has(item.claim_a_id) ? ' (historical)' : ''} / ${item.claim_b_id}${superseded.has(item.claim_b_id) ? ' (historical)' : ''}\n\nRelationship: ${item.relation}\n\n${inline(item.rationale)}`,
      ),
    ].join('\n\n'),
  );
  add(
    'definition-history.csv',
    csv(ledger.definitions, [
      'id',
      'definition_id',
      'version',
      'term',
      'definition',
      'scope',
      'rationale',
      'created_at',
      'csv_formula_escaped',
    ]),
  );
  add(
    'decision-log.csv',
    csv(ledger.decisions, [
      'id',
      'entity_type',
      'entity_id',
      'before_state',
      'after_state',
      'rationale',
      'created_at',
      'csv_formula_escaped',
    ]),
  );
  add(
    'bibliography.md',
    [
      '# Source bibliography',
      ...sources.map(
        (source) =>
          `- ${inline(source.author_institution)}. “${inline(source.title)}.” ${inline(source.publication_date || 'n.d.')}. ${inline(source.url || 'Manual citation')}. Accessed ${source.access_date}. [${source.id}]`,
      ),
    ].join('\n\n'),
  );
  add(
    'memo-outline.md',
    [
      '# Policy memo outline',
      '## Research question',
      'State the decision and the scope of the analysis.',
      '## Evidence by finding',
      ...currentClaims.map(
        (claim) =>
          `### ${inline(claim.claim_text)}\n\n${inline(claim.interpretation)}\n\nStatus / confidence: ${claim.status} / ${claim.confidence}\n\nLimitation: ${inline(claim.known_limitation)}\n\nEvidence: ${claim.evidence
            .filter((e) => e.review_state === 'approved')
            .map((e) => `${e.id} → ${e.source_id} (${inline(e.locator)})`)
            .join('; ')}`,
      ),
      '## Counterarguments and uncertainty',
      'Preserve competing definitions, different time periods, and unresolved counterevidence.',
      '## Decision implications',
      'Explain what additional evidence would change the conclusion.',
    ].join('\n\n'),
  );
  const outputHashes: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(files))
    outputHashes[name] = await sha256(bytes);
  add(
    'manifest.json',
    JSON.stringify(
      {
        app: 'Policy Evidence Ledger',
        app_version: '0.2.0',
        schema_version: '1.1',
        generated_at: generatedAt,
        claim_ids: currentClaims.map((c) => c.id),
        historical_claim_ids: [...superseded],
        source_ids: sources.map((s) => s.id),
        source_hashes: Object.fromEntries(
          sources.map((s) => [
            s.id,
            s.document_hash ?? 'unavailable: citation-only',
          ]),
        ),
        output_sha256: outputHashes,
        machine_suggestions_included: false,
      },
      null,
      2,
    ),
  );
  return {
    bytes: zipSync(files, { level: 6 }),
    filename: `policy-evidence-ledger-${generatedAt.slice(0, 10)}.zip`,
  };
}
