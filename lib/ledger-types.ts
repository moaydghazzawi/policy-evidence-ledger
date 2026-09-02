import demoManifest from '@/demo/manifest.json';

export type Source = {
  id: string;
  title: string;
  author_institution: string;
  publication_date: string | null;
  source_type: string;
  url: string | null;
  access_date: string;
  document_hash: string | null;
  metadata_status: 'pending' | 'verified';
  ingest_mode: string;
  content_type: string | null;
  language: string;
  notes: string;
  created_at: string;
  duplicate?: boolean;
  aliases?: SourceAlias[];
  previous_version_id?: string | null;
};

export type SourceAlias = {
  id: string;
  url: string | null;
  title: string | null;
  author_institution: string | null;
  publication_date: string | null;
  source_type: string | null;
  metadata_status: 'pending' | 'verified' | null;
  access_date: string | null;
  language: string | null;
  notes: string | null;
  created_at: string;
};

export type Evidence = {
  id: string;
  claim_id: string;
  source_id: string;
  role: 'supporting' | 'counterevidence';
  kind: 'passage' | 'data_point';
  exact_text: string;
  locator_type: string | null;
  locator: string | null;
  review_state: 'draft' | 'approved';
  reviewer_note: string;
  created_at: string;
};

export type Claim = {
  id: string;
  claim_text: string;
  interpretation: string;
  confidence: 'low' | 'moderate' | 'high';
  known_limitation: string;
  status: 'supported' | 'contested' | 'unclear' | 'rejected';
  policy_outcome: string;
  case_name: string;
  time_period: string;
  created_at: string;
  evidence: Evidence[];
};

export type DefinitionVersion = {
  id: string;
  definition_id: string;
  version: number;
  term: string;
  definition: string;
  scope: string;
  rationale: string;
  created_at: string;
};

export type Comparison = {
  id: string;
  claim_a_id: string;
  claim_b_id: string;
  relation: string;
  rationale: string;
  created_at: string;
};

export type Decision = {
  id: string;
  entity_type: string;
  entity_id: string;
  before_state: string;
  after_state: string;
  rationale: string;
  created_at: string;
};

export type Dashboard = {
  sources: Source[];
  claims: Claim[];
  definitions: DefinitionVersion[];
  comparisons: Comparison[];
  decisions: Decision[];
  export_ready: boolean;
  export_issues: string[];
};

const createdAt = `${demoManifest.retrieved_on}T00:00:00Z`;
const idFor = (prefix: string, index: number) =>
  `${prefix}-DEMO-${String(index + 1).padStart(3, '0')}`;

const sourceIdByKey = Object.fromEntries(
  demoManifest.sources.map((source, index) => [
    source.key,
    idFor('SRC', index),
  ]),
) as Record<string, string>;

const sources: Source[] = demoManifest.sources.map((source, index) => ({
  id: idFor('SRC', index),
  title: source.title,
  author_institution: source.author_institution,
  publication_date: source.publication_date,
  source_type: source.source_type,
  url: source.url,
  access_date: demoManifest.retrieved_on,
  document_hash: null,
  metadata_status: 'verified',
  ingest_mode: 'demo',
  content_type: null,
  language: source.language,
  notes: source.notes,
  created_at: createdAt,
  aliases: [],
  previous_version_id: null,
}));

const claimIdByKey = Object.fromEntries(
  demoManifest.claims.map((claim, index) => [claim.key, idFor('CLM', index)]),
) as Record<string, string>;

let evidenceIndex = 0;
const claims: Claim[] = demoManifest.claims.map((claim, claimIndex) => {
  const claimId = idFor('CLM', claimIndex);
  return {
    id: claimId,
    claim_text: claim.claim_text,
    interpretation: claim.interpretation,
    confidence: claim.confidence as Claim['confidence'],
    known_limitation: claim.known_limitation,
    status: claim.status as Claim['status'],
    policy_outcome: claim.policy_outcome,
    case_name: claim.case_name,
    time_period: claim.time_period,
    created_at: createdAt,
    evidence: claim.evidence.map((evidence) => {
      const item: Evidence = {
        id: idFor('EVD', evidenceIndex),
        claim_id: claimId,
        source_id: sourceIdByKey[evidence.source_key],
        role: evidence.role as Evidence['role'],
        kind: evidence.kind as Evidence['kind'],
        exact_text: evidence.exact_text,
        locator_type: evidence.locator_type,
        locator: evidence.locator,
        review_state: evidence.review_state as Evidence['review_state'],
        reviewer_note: evidence.reviewer_note,
        created_at: createdAt,
      };
      evidenceIndex += 1;
      return item;
    }),
  };
});

const definitionKeys = [
  ...new Set(demoManifest.definitions.map((definition) => definition.key)),
];
const definitionIdByKey = Object.fromEntries(
  definitionKeys.map((key, index) => [key, idFor('DEF', index)]),
) as Record<string, string>;
const definitionVersionByKey = new Map<string, number>();
const previousDefinitionByKey = new Map<
  string,
  (typeof demoManifest.definitions)[number]
>();
const definitionRevisionDecisions: Decision[] = [];
const definitions: DefinitionVersion[] = demoManifest.definitions.map(
  (definition, index) => {
    const expectedVersion =
      (definitionVersionByKey.get(definition.key) ?? 0) + 1;
    if (definition.version !== expectedVersion) {
      throw new Error(`Demo definition version drift for ${definition.key}`);
    }
    definitionVersionByKey.set(definition.key, definition.version);
    const previous = previousDefinitionByKey.get(definition.key);
    if (previous) {
      definitionRevisionDecisions.push({
        id: `DEC-DEMO-DEFINITION-${String(index + 1).padStart(3, '0')}`,
        entity_type: 'definition',
        entity_id: definitionIdByKey[definition.key],
        before_state: previous.definition,
        after_state: definition.definition,
        rationale: definition.rationale,
        created_at: createdAt,
      });
    }
    previousDefinitionByKey.set(definition.key, definition);
    return {
      id: `${idFor('DEFV', index)}-V${definition.version}`,
      definition_id: definitionIdByKey[definition.key],
      version: definition.version,
      term: definition.term,
      definition: definition.definition,
      scope: definition.scope,
      rationale: definition.rationale,
      created_at: createdAt,
    };
  },
);

const comparisons: Comparison[] = demoManifest.comparisons.map(
  (comparison, index) => ({
    id: idFor('CMP', index),
    claim_a_id: claimIdByKey[comparison.claim_a_key],
    claim_b_id: claimIdByKey[comparison.claim_b_key],
    relation: comparison.relation,
    rationale: comparison.rationale,
    created_at: createdAt,
  }),
);

const decisions: Decision[] = [
  ...definitionRevisionDecisions,
  ...demoManifest.decisions.map((decision, index) => ({
    id: idFor('DEC', definitionRevisionDecisions.length + index),
    entity_type: decision.entity_type,
    entity_id: claimIdByKey[decision.entity_key],
    before_state: decision.before_state,
    after_state: decision.after_state,
    rationale: decision.rationale,
    created_at: createdAt,
  })),
];

export const fallbackDashboard: Dashboard = {
  sources,
  claims,
  definitions,
  comparisons,
  decisions,
  export_ready: true,
  export_issues: [],
};
