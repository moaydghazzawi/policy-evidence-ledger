import { fallbackDashboard } from '@/lib/ledger-types';
import {
  approvalInput,
  approvalIssues,
  claimInput,
  comparisonInput,
  decisionInput,
  definitionInput,
  evidenceInput,
  LedgerError,
  ledgerSchema,
  now,
  recordId,
  requireRecord,
  sourceInput,
  type Ledger,
} from './validation';
import { preserveBlob } from './store';

export function seedLedger(): Ledger {
  const { sources, claims, definitions, comparisons, decisions } =
    structuredClone(fallbackDashboard);
  return ledgerSchema.parse({
    sources,
    claims: claims.map((claim) => ({
      ...claim,
      evidence: claim.evidence.map((e) => ({ ...e, origin: 'human' })),
    })),
    definitions,
    comparisons,
    decisions,
    source_versions: [],
    blob_sizes: {},
  });
}
export async function addSource(
  ownerId: string,
  ledger: Ledger,
  input: unknown,
  capture?: { bytes: Uint8Array; contentType: string; finalUrl?: string },
) {
  const values = sourceInput.parse(input);
  if (['url', 'upload'].includes(values.ingest_mode) && !capture)
    throw new LedgerError('Source capture did not complete.');
  if (values.ingest_mode === 'demo')
    throw new LedgerError(
      'Use the example import to add demonstration records.',
    );
  values.metadata_status = 'pending';
  if (capture?.finalUrl && capture.finalUrl !== values.url) {
    values.notes =
      `${values.notes.slice(0, 1800)}\nRetrieved URL: ${capture.finalUrl}`.slice(
        0,
        4000,
      );
  }
  const hash = capture
    ? await preserveBlob(ownerId, ledger, capture.bytes, capture.contentType)
    : null;
  const duplicate = hash
    ? ledger.sources.find((source) => source.document_hash === hash)
    : undefined;
  const history = ledger.source_versions.filter(
    (item) => item.url === values.url,
  );
  const previous = history.length
    ? ledger.sources.find(
        (source) => source.id === history[history.length - 1].source_id,
      )
    : [...ledger.sources]
        .reverse()
        .find(
          (source) =>
            (source.url === values.url ||
              source.aliases.some((alias) => alias.url === values.url)) &&
            source.document_hash,
        );
  const stamp = { id: recordId('SRC'), created_at: now() };
  const source = duplicate ?? {
    ...values,
    ...stamp,
    document_hash: hash,
    content_type: capture?.contentType ?? null,
    aliases: [],
    previous_version_id: previous?.id ?? null,
  };
  if (duplicate)
    duplicate.aliases.push({
      ...values,
      id: recordId('ALS'),
      created_at: now(),
    });
  else ledger.sources.push(source);
  if (hash && values.url && previous && previous.id !== source.id) {
    ledger.source_versions.push({
      id: recordId('VER'),
      previous_source_id: previous.id,
      source_id: source.id,
      url: values.url,
      created_at: now(),
    });
  }
  const possible = ledger.sources
    .filter(
      (item) =>
        item.id !== source.id &&
        item.title.toLowerCase() === values.title.toLowerCase(),
    )
    .map((item) => item.id);
  return {
    source: { ...source, duplicate: !!duplicate },
    citation_duplicate_warning: possible,
  };
}
export function mutateLedger(
  ledger: Ledger,
  method: string,
  path: string,
  input: unknown,
): unknown {
  const parts = path.split('/').filter(Boolean);
  if (method === 'PATCH' && parts[0] === 'sources' && parts[2] === 'verify') {
    const source = requireRecord(
      ledger.sources.find((item) => item.id === parts[1]),
      'Source',
    );
    source.metadata_status = 'verified';
    return source;
  }
  if (method === 'POST' && path === '/claims') {
    const claim = {
      ...claimInput.parse(input),
      id: recordId('CLM'),
      created_at: now(),
      evidence: [],
    };
    ledger.claims.push(claim);
    return claim;
  }
  if (method === 'PATCH' && parts[0] === 'claims' && parts.length === 2) {
    const payload = input as Record<string, unknown>;
    const { rationale, ...fields } = payload;
    if (
      typeof rationale !== 'string' ||
      !rationale.trim() ||
      rationale.length > 2000
    )
      throw new LedgerError('Explain why this claim is changing.');
    const claim = requireRecord(
      ledger.claims.find((item) => item.id === parts[1]),
      'Claim',
    );
    const values = claimInput.parse(fields);
    if (
      ledger.claim_revisions.some(
        (revision) => revision.previous_claim_id === claim.id,
      )
    )
      throw new LedgerError(
        'This claim already has a newer revision. Revise its latest version.',
        409,
      );
    const newId = recordId('CLM');
    const created = now();
    const revised = {
      ...values,
      id: newId,
      created_at: created,
      evidence: claim.evidence.map((e) => ({
        ...e,
        id: recordId('EVD'),
        claim_id: newId,
        review_state: 'draft' as const,
        reviewer_note: '',
        created_at: created,
      })),
    };
    ledger.claims.unshift(revised);
    ledger.claim_revisions.push({
      id: recordId('REV'),
      created_at: created,
      previous_claim_id: claim.id,
      claim_id: newId,
      rationale,
    });
    ledger.decisions.unshift({
      id: recordId('DEC'),
      created_at: created,
      entity_type: 'claim',
      entity_id: newId,
      before_state: `Previous claim: ${claim.id} (${claim.status}; ${claim.confidence} confidence). Full text and approvals remain in that record.`,
      after_state: `Revised claim: ${newId} (${revised.status}; ${revised.confidence} confidence). Carried evidence requires fresh review.`,
      rationale,
    });
    return revised;
  }
  if (method === 'POST' && path === '/evidence') {
    const values = evidenceInput.parse(input);
    const claim = requireRecord(
      ledger.claims.find((item) => item.id === values.claim_id),
      'Claim',
    );
    requireRecord(
      ledger.sources.find((item) => item.id === values.source_id),
      'Source',
    );
    if (values.review_state === 'approved') {
      const issues = approvalIssues(ledger, values);
      if (issues.length)
        throw new LedgerError('Evidence needs review.', 422, issues);
    }
    const evidence = {
      ...values,
      id: recordId('EVD'),
      created_at: now(),
      origin: 'human' as const,
    };
    claim.evidence.push(evidence);
    return evidence;
  }
  if (method === 'PATCH' && parts[0] === 'evidence' && parts[2] === 'approve') {
    const evidence = requireRecord(
      ledger.claims
        .flatMap((claim) => claim.evidence)
        .find((item) => item.id === parts[1]),
      'Evidence',
    );
    if (evidence.review_state === 'approved')
      throw new LedgerError(
        'Approved evidence is immutable. Add a new evidence record to preserve a correction.',
        409,
      );
    const values = approvalInput.parse(input);
    const candidate = {
      ...evidence,
      ...values,
      review_state: 'approved' as const,
    };
    const issues = approvalIssues(ledger, candidate);
    if (issues.length)
      throw new LedgerError('Evidence needs review.', 422, issues);
    Object.assign(evidence, candidate);
    return evidence;
  }
  if (method === 'POST' && path === '/definitions') {
    const values = definitionInput.parse(input);
    const key = values.term.normalize('NFKC').toLocaleLowerCase();
    const previous = ledger.definitions
      .filter((item) => item.term.normalize('NFKC').toLocaleLowerCase() === key)
      .sort((a, b) => b.version - a.version)[0];
    const definition = {
      ...values,
      id: recordId('DFV'),
      definition_id: previous?.definition_id ?? recordId('DEF'),
      version: (previous?.version ?? 0) + 1,
      created_at: now(),
    };
    ledger.definitions.push(definition);
    if (previous)
      ledger.decisions.unshift({
        id: recordId('DEC'),
        created_at: now(),
        entity_type: 'definition',
        entity_id: definition.definition_id,
        before_state: previous.definition.slice(0, 4000),
        after_state: definition.definition.slice(0, 4000),
        rationale: definition.rationale,
      });
    return definition;
  }
  if (method === 'POST' && path === '/comparisons') {
    const values = comparisonInput.parse(input);
    if (values.claim_a_id === values.claim_b_id)
      throw new LedgerError('Choose two different claims.');
    for (const id of [values.claim_a_id, values.claim_b_id])
      requireRecord(
        ledger.claims.find((item) => item.id === id),
        'Claim',
      );
    const comparison = { ...values, id: recordId('CMP'), created_at: now() };
    ledger.comparisons.push(comparison);
    return comparison;
  }
  if (method === 'POST' && path === '/decisions') {
    const values = decisionInput.parse(input);
    if (values.entity_type === 'claim')
      requireRecord(
        ledger.claims.find((item) => item.id === values.entity_id),
        'Claim',
      );
    if (values.entity_type === 'definition')
      requireRecord(
        ledger.definitions.find(
          (item) => item.definition_id === values.entity_id,
        ),
        'Definition',
      );
    const decision = { ...values, id: recordId('DEC'), created_at: now() };
    ledger.decisions.unshift(decision);
    return decision;
  }
  throw new LedgerError('This action is not available.', 404);
}
