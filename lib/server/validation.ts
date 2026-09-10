import { z } from 'zod';

const text = (max: number) => z.string().trim().min(1).max(max);
const date = z.iso.date();
const id = text(100);
const httpUrl = z
  .url()
  .max(4000)
  .refine((value) => {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      !url.username &&
      !url.password
    );
  }, 'Use an HTTP(S) URL without embedded credentials.');
const stamp = { id, created_at: z.iso.datetime() };
export const sourceInput = z
  .object({
    title: text(500),
    author_institution: text(300),
    publication_date: date.nullable().default(null),
    source_type: z.enum([
      'government_rule',
      'official_statement',
      'legislation',
      'court_record',
      'dataset',
      'research_paper',
      'report',
      'news',
      'manual_citation',
      'other',
    ]),
    url: httpUrl.nullable().default(null),
    access_date: date.default(() => new Date().toISOString().slice(0, 10)),
    metadata_status: z.enum(['pending', 'verified']).default('pending'),
    ingest_mode: z.enum(['manual', 'url', 'upload', 'demo']).default('manual'),
    language: text(20).min(2).default('en'),
    notes: z.string().max(4000).default(''),
  })
  .strict();
export const claimInput = z
  .object({
    claim_text: text(4000),
    interpretation: text(6000),
    confidence: z.enum(['low', 'moderate', 'high']),
    known_limitation: text(4000),
    status: z.enum(['supported', 'contested', 'unclear', 'rejected']),
    policy_outcome: text(300),
    case_name: z.string().max(300).default(''),
    time_period: z.string().max(200).default(''),
  })
  .strict();
export const locatorType = z.enum([
  'page',
  'section',
  'paragraph',
  'table',
  'article',
  'timestamp',
  'other',
]);
export const evidenceInput = z
  .object({
    claim_id: id,
    source_id: id,
    role: z.enum(['supporting', 'counterevidence']),
    kind: z.enum(['passage', 'data_point']),
    exact_text: z
      .string()
      .min(1)
      .max(12000)
      .refine((value) => !!value.trim(), 'Source text cannot be blank.'),
    locator_type: locatorType.nullable().default(null),
    locator: z.string().max(500).nullable().default(null),
    review_state: z.enum(['draft', 'approved']).default('draft'),
    reviewer_note: z.string().max(2000).default(''),
  })
  .strict();
export const approvalInput = z
  .object({
    locator_type: locatorType,
    locator: text(500),
    reviewer_note: z.string().max(2000).optional(),
  })
  .strict();
export const definitionInput = z
  .object({
    term: text(200),
    definition: text(5000),
    scope: text(1000),
    rationale: text(2000),
  })
  .strict();
export const comparisonInput = z
  .object({
    claim_a_id: id,
    claim_b_id: id,
    relation: z.enum([
      'agrees',
      'disagrees',
      'different_definition',
      'different_period',
      'mixed',
    ]),
    rationale: text(3000),
  })
  .strict();
export const decisionInput = z
  .object({
    entity_type: z.enum(['claim', 'definition', 'case', 'conclusion']),
    entity_id: id,
    before_state: z.string().max(4000).default(''),
    after_state: text(4000),
    rationale: text(4000),
  })
  .strict();
const sourceAlias = sourceInput.partial().extend(stamp);
const sourceView = sourceInput.extend({
  ...stamp,
  document_hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .nullable(),
  content_type: z.string().nullable(),
  aliases: z.array(sourceAlias).default([]),
  previous_version_id: id.nullable().default(null),
});
const evidenceView = evidenceInput.extend({
  ...stamp,
  origin: z.literal('human'),
});
const claimView = claimInput.extend({
  ...stamp,
  evidence: z.array(evidenceView),
});
export const ledgerSchema = z
  .object({
    sources: z.array(sourceView).max(500),
    claims: z.array(claimView).max(500),
    definitions: z
      .array(
        definitionInput.extend({
          ...stamp,
          definition_id: id,
          version: z.number().int().positive(),
        }),
      )
      .max(1000),
    comparisons: z.array(comparisonInput.extend(stamp)).max(1000),
    decisions: z.array(decisionInput.extend(stamp)).max(2000),
    source_versions: z
      .array(
        z.object({
          ...stamp,
          previous_source_id: id,
          source_id: id,
          url: httpUrl,
        }),
      )
      .max(2000),
    blob_sizes: z.record(
      z.string().regex(/^[a-f0-9]{64}$/),
      z.number().int().nonnegative(),
    ),
    claim_revisions: z
      .array(
        z.object({
          ...stamp,
          previous_claim_id: id,
          claim_id: id,
          rationale: text(2000),
        }),
      )
      .default([]),
  })
  .strict();
export type Ledger = z.infer<typeof ledgerSchema>;
export const emptyLedger = (): Ledger => ({
  sources: [],
  claims: [],
  definitions: [],
  comparisons: [],
  decisions: [],
  source_versions: [],
  blob_sizes: {},
  claim_revisions: [],
});
export class LedgerError extends Error {
  constructor(
    message: string,
    public status = 422,
    public issues: string[] = [],
  ) {
    super(message);
  }
}
export function requireRecord<T>(record: T | undefined, kind: string): T {
  if (!record) throw new LedgerError(`${kind} not found.`, 404);
  return record;
}
export const recordId = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;
export const now = () => new Date().toISOString();
export function approvalIssues(
  ledger: Ledger,
  evidence: z.infer<typeof evidenceInput>,
): string[] {
  const source = ledger.sources.find((item) => item.id === evidence.source_id);
  const issues: string[] = [];
  if (!source) issues.push('The source no longer exists.');
  else if (source.metadata_status !== 'verified')
    issues.push(`Verify metadata for ${source.id} before approving evidence.`);
  if (!evidence.locator_type || !evidence.locator?.trim())
    issues.push('A locator type and specific source location are required.');
  return issues;
}
export function provenanceIssues(ledger: Ledger): string[] {
  const issues: string[] = [];
  if (!ledger.claims.length)
    issues.push(
      'Add a claim and approve its located evidence before exporting.',
    );
  const superseded = new Set(
    ledger.claim_revisions.map((item) => item.previous_claim_id),
  );
  if (!ledger.claims.some((claim) => !superseded.has(claim.id)))
    issues.push('The ledger has no active claims.');
  const links = new Map(
    ledger.claim_revisions.map((item) => [
      item.previous_claim_id,
      item.claim_id,
    ]),
  );
  if (links.size !== ledger.claim_revisions.length)
    issues.push('Claim revision history contains multiple replacements.');
  for (const start of links.keys()) {
    const seen = new Set<string>();
    let current = start;
    while (links.has(current)) {
      if (seen.has(current)) {
        issues.push('Claim revision history contains a cycle.');
        break;
      }
      seen.add(current);
      current = links.get(current)!;
    }
  }
  for (const revision of ledger.claim_revisions) {
    if (
      revision.previous_claim_id === revision.claim_id ||
      ![revision.previous_claim_id, revision.claim_id].every((id) =>
        ledger.claims.some((c) => c.id === id),
      )
    )
      issues.push(`${revision.id}: invalid claim revision references.`);
  }
  for (const claim of ledger.claims) {
    const approved = claim.evidence.filter(
      (e) => e.review_state === 'approved',
    );
    if (!approved.length && !superseded.has(claim.id))
      issues.push(`${claim.id}: add at least one approved evidence record.`);
    for (const evidence of claim.evidence) {
      if (evidence.claim_id !== claim.id)
        issues.push(`${evidence.id}: claim link is invalid.`);
      if (!ledger.sources.some((s) => s.id === evidence.source_id))
        issues.push(`${evidence.id}: source link is invalid.`);
      if (evidence.review_state === 'approved')
        issues.push(
          ...approvalIssues(ledger, evidence).map(
            (issue) => `${evidence.id}: ${issue}`,
          ),
        );
    }
  }
  for (const comparison of ledger.comparisons) {
    if (
      comparison.claim_a_id === comparison.claim_b_id ||
      ![comparison.claim_a_id, comparison.claim_b_id].every((id) =>
        ledger.claims.some((c) => c.id === id),
      )
    )
      issues.push(`${comparison.id}: invalid comparison references.`);
  }
  for (const source of ledger.sources) {
    if (['upload', 'url'].includes(source.ingest_mode) && !source.document_hash)
      issues.push(`${source.id}: captured source hash is missing.`);
  }
  return [...new Set(issues)];
}
