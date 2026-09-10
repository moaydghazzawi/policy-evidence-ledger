import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { createHash } from 'node:crypto';

const base = process.env.PEL_CLOUD_TEST_URL ?? 'http://localhost:3003';
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base))
  throw new Error(
    'Cloud API smoke tests must run against a local test server.',
  );
const run = Date.now().toString(36);
const cookie = '__sites_local_auth=1';
async function call(
  path,
  method = 'GET',
  body,
  authenticated = true,
  extra = {},
) {
  const headers = { ...(authenticated ? { cookie } : {}), ...extra };
  if (body && !(body instanceof FormData))
    headers['content-type'] = 'application/json';
  const options = { method, headers };
  if (body)
    options.body = body instanceof FormData ? body : JSON.stringify(body);
  const response = await fetch(`${base}/api${path}`, options);
  const raw = await response.text();
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    result = { detail: raw };
  }
  return { status: response.status, body: result };
}
function ok(result, status = 200) {
  assert.equal(result.status, status, JSON.stringify(result.body));
  return result.body;
}
const anonymous = ok(await call('/dashboard', 'GET', undefined, false));
assert.equal(anonymous.workspace.mode, 'demo');
assert.equal(
  (await call('/sources', 'POST', { title: 'forbidden' }, false)).status,
  401,
);
assert.equal(
  (
    await call('/sources', 'POST', { title: 'forbidden' }, true, {
      origin: 'https://untrusted.example',
    })
  ).status,
  403,
);
const spoofed = ok(
  await call('/dashboard', 'GET', undefined, false, {
    'oai-authenticated-user-id': 'spoofed',
    'oai-authenticated-user-email': 'spoofed@example.test',
  }),
);
assert.equal(spoofed.workspace.mode, 'demo');
let dashboard = ok(await call('/dashboard'));
assert.equal(dashboard.workspace.mode, 'cloud');
if (!dashboard.sources.length) ok(await call('/workspace/seed', 'POST'), 200);
const source = ok(
  await call('/sources', 'POST', {
    title: `API test ${run}`,
    author_institution: 'Test institution',
    source_type: 'report',
    ingest_mode: 'manual',
  }),
  201,
).source;
assert.equal(source.metadata_status, 'pending');
const claimPayload = {
  claim_text: `API test claim ${run}`,
  interpretation: 'An explicitly human interpretation.',
  known_limitation: 'A test record only.',
  policy_outcome: 'Data integrity',
  confidence: 'moderate',
  status: 'supported',
  case_name: 'Test case',
  time_period: '2026',
};
const claim = ok(await call('/claims', 'POST', claimPayload), 201);
const evidencePayload = {
  claim_id: claim.id,
  source_id: source.id,
  role: 'supporting',
  kind: 'passage',
  exact_text: '=Not a spreadsheet formula\nAn exact source passage.',
  locator_type: 'page',
  locator: 'p. 2',
  review_state: 'approved',
};
assert.equal((await call('/evidence', 'POST', evidencePayload)).status, 422);
ok(await call(`/sources/${source.id}/verify`, 'PATCH'));
const evidence = ok(await call('/evidence', 'POST', evidencePayload), 201);
assert.equal(
  (
    await call(`/evidence/${evidence.id}/approve`, 'PATCH', {
      locator_type: 'page',
      locator: 'p. 3',
    })
  ).status,
  409,
);
const definition = {
  term: `Test term ${run}`,
  definition: 'Original definition',
  scope: 'Test scope',
  rationale: 'Initial definition',
};
ok(await call('/definitions', 'POST', definition), 201);
const revisedDefinition = ok(
  await call('/definitions', 'POST', {
    ...definition,
    definition: 'Revised definition',
    rationale: 'New scope evidence',
  }),
  201,
);
assert.equal(revisedDefinition.version, 2);
assert.equal(
  (
    await call('/comparisons', 'POST', {
      claim_a_id: claim.id,
      claim_b_id: claim.id,
      relation: 'agrees',
      rationale: 'Invalid self reference',
    })
  ).status,
  422,
);
const oldDraft = ok(
  await call('/claims', 'POST', {
    ...claimPayload,
    claim_text: 'Superseded draft ' + run,
  }),
  201,
);
const replacement = ok(
  await call('/claims/' + oldDraft.id, 'PATCH', {
    ...claimPayload,
    claim_text: 'Reviewed replacement ' + run,
    rationale: 'Correcting an unfinished draft',
  }),
);
ok(
  await call('/evidence', 'POST', {
    ...evidencePayload,
    claim_id: replacement.id,
  }),
  201,
);
const revised = ok(
  await call(`/claims/${claim.id}`, 'PATCH', {
    ...claimPayload,
    interpretation: 'A'.repeat(6000),
    rationale: 'New evidence changes the interpretation.',
  }),
);
assert.notEqual(revised.id, claim.id);
assert.equal(revised.evidence[0].review_state, 'draft');
assert.notEqual(revised.evidence[0].id, evidence.id);
assert.equal((await call('/export', 'POST')).status, 422);
ok(
  await call(`/evidence/${revised.evidence[0].id}/approve`, 'PATCH', {
    locator_type: 'page',
    locator: 'p. 2',
    reviewer_note: 'Rechecked for revised claim',
  }),
);
ok(
  await call('/comparisons', 'POST', {
    claim_a_id: claim.id,
    claim_b_id: revised.id,
    relation: 'different_definition',
    rationale: 'Revised interpretation.',
  }),
  201,
);
async function upload(title, url, text) {
  const form = new FormData();
  form.set('file', new File([text], 'source.txt', { type: 'text/plain' }));
  form.set('title', title);
  form.set('author_institution', 'Test institution');
  form.set('source_type', 'report');
  form.set('url', url);
  return ok(await call('/sources/upload', 'POST', form), 201).source;
}
const urlA = `https://example.org/a-${run}`,
  urlB = `https://example.org/b-${run}`;
const fileA = await upload('File A', urlA, `Original bytes ${run}`);
const fileB = await upload('Alias B', urlB, `Original bytes ${run}`);
assert.equal(fileA.id, fileB.id);
assert.equal(fileB.duplicate, true);
const fileC = await upload('Revision B', urlB, `Updated bytes ${run}`);
assert.equal(fileC.previous_version_id, fileA.id);
const download = await fetch(`${base}/api/sources/${fileA.id}/download`, {
  headers: { cookie },
});
assert.equal(download.status, 200);
assert.equal(await download.text(), `Original bytes ${run}`);
const denied = await fetch(`${base}/api/sources/${fileA.id}/download`);
assert.equal(denied.status, 401);
assert.equal(
  (
    await call('/sources', 'POST', {
      title: 'Private host',
      author_institution: 'Test',
      source_type: 'report',
      ingest_mode: 'url',
      url: 'http://127.0.0.1/',
    })
  ).status,
  422,
);
dashboard = ok(await call('/dashboard'));
assert.equal(
  dashboard.claims.find((c) => c.id === claim.id).superseded_by,
  revised.id,
);
assert.equal(
  dashboard.claims.find((c) => c.id === revised.id).interpretation.length,
  6000,
);
const exportResponse = await fetch(`${base}/api/export`, {
  method: 'POST',
  headers: { cookie },
});
assert.equal(exportResponse.status, 200, await exportResponse.clone().text());
const bundle = unzipSync(new Uint8Array(await exportResponse.arrayBuffer()));
for (const name of [
  'claims.md',
  'evidence.csv',
  'claim-revisions.csv',
  'claim-history.csv',
  'definition-history.csv',
  'decision-log.csv',
  'manifest.json',
])
  assert.ok(bundle[name], name);
assert.ok(
  !strFromU8(bundle['source-versions.csv']).includes(urlB),
  'Unreferenced capture history must not leak into exports',
);
assert.ok(
  strFromU8(bundle['evidence.csv']).includes("'=Not a spreadsheet formula"),
);
assert.ok(!strFromU8(bundle['claims.md']).includes('Superseded draft ' + run));
assert.ok(
  strFromU8(bundle['claim-history.csv']).includes('Superseded draft ' + run),
);
const manifest = JSON.parse(strFromU8(bundle['manifest.json']));
for (const [name, hash] of Object.entries(manifest.output_sha256))
  assert.equal(createHash('sha256').update(bundle[name]).digest('hex'), hash);
assert.equal(
  (await call('/dashboard', 'GET', undefined, false)).body.claims.some(
    (c) => c.id === claim.id,
  ),
  false,
);
console.log(
  'Cloud API checks passed: authentication, private records, persistence, upload hashing/aliases/version lineage, evidence review, claim revision, definition history, comparisons, export gates, ZIP integrity, and private-network rejection.',
);
