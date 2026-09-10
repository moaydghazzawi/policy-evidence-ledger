import { env } from 'cloudflare:workers';
import { z } from 'zod';
import { getChatGPTUser } from '@/app/chatgpt-auth';
import { addSource, mutateLedger, seedLedger } from '@/lib/server/mutations';
import { blobKey, loadLedger, saveLedger, sha256 } from '@/lib/server/store';
import {
  LedgerError,
  provenanceIssues,
  requireRecord,
  sourceInput,
} from '@/lib/server/validation';
import {
  captureUrl,
  MAX_SOURCE_BYTES,
  readBounded,
  sourceTypes,
} from '@/lib/server/ingestion';
import { exportLedger } from '@/lib/server/export';

export const dynamic = 'force-dynamic';
const responseHeaders = {
  'Cache-Control': 'private, no-store',
  'Content-Security-Policy': "frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
};
const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: responseHeaders });
function checkOrigin(request: Request) {
  const origin = request.headers.get('origin');
  const current = new URL(request.url).origin;
  if (
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    (origin &&
      origin !== current &&
      origin !== 'https://policy-evidence-ledger.moaydghazzawi.com')
  )
    throw new LedgerError(
      'This action must be started from your workspace.',
      403,
    );
}
async function handle(request: Request) {
  try {
    const path = new URL(request.url).pathname.replace(/^\/api/, '');
    const method = request.method;
    if (method !== 'GET') checkOrigin(request);
    const user = await getChatGPTUser();
    if (path === '/health' && method === 'GET')
      return json({ status: 'ok', storage: 'cloud' });
    if (path === '/dashboard' && method === 'GET') {
      if (!user) {
        const ledger = seedLedger();
        return json({
          ...ledger,
          blob_sizes: undefined,
          source_versions: undefined,
          export_ready: true,
          export_issues: [],
          workspace: { mode: 'demo' },
        });
      }
      const { ledger, revision } = await loadLedger(user.userId);
      const issues = provenanceIssues(ledger);
      return json({
        ...ledger,
        claims: ledger.claims.map((claim) => ({
          ...claim,
          superseded_by: ledger.claim_revisions.find(
            (item) => item.previous_claim_id === claim.id,
          )?.claim_id,
        })),
        blob_sizes: undefined,
        source_versions: undefined,
        export_ready: !issues.length,
        export_issues: issues,
        revision,
        workspace: {
          mode: 'cloud',
          display_name: user.fullName ?? 'Researcher',
        },
      });
    }
    if (path === '/export' && method === 'POST') {
      const ledger = user
        ? (await loadLedger(user.userId)).ledger
        : seedLedger();
      const output = await exportLedger(user?.userId ?? null, ledger);
      return new Response(new Uint8Array(output.bytes).buffer, {
        headers: {
          ...responseHeaders,
          'Content-Type': 'application/zip',
          'Content-Disposition': `attachment; filename="${output.filename}"`,
        },
      });
    }
    if (!user)
      throw new LedgerError(
        'Sign in with ChatGPT to save research in your private workspace.',
        401,
      );
    const { ledger, revision } = await loadLedger(user.userId);
    const download = /^\/sources\/([^/]+)\/download$/.exec(path);
    if (download && method === 'GET') {
      const source = requireRecord(
        ledger.sources.find((item) => item.id === download[1]),
        'Source',
      );
      if (!source.document_hash)
        throw new LedgerError(
          'This source is citation-only and has no saved file.',
          404,
        );
      const object = await env.BUCKET.get(
        await blobKey(user.userId, source.document_hash),
      );
      if (!object)
        throw new LedgerError('The preserved source file is unavailable.', 404);
      const bytes = await object.arrayBuffer();
      if ((await sha256(bytes)) !== source.document_hash)
        throw new LedgerError(
          'The saved source copy failed its integrity check.',
          409,
        );
      const ext =
        source.content_type === 'application/pdf'
          ? 'pdf'
          : source.content_type === 'text/plain'
            ? 'txt'
            : 'html';
      return new Response(bytes, {
        headers: {
          ...responseHeaders,
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${source.id}.${ext}"`,
        },
      });
    }
    if (path === '/workspace/seed' && method === 'POST') {
      if (
        ledger.sources.length ||
        ledger.claims.length ||
        ledger.definitions.length ||
        ledger.decisions.length ||
        ledger.comparisons.length
      )
        throw new LedgerError(
          'The example can only be imported into an empty workspace.',
          409,
        );
      await saveLedger(user.userId, seedLedger(), revision);
      return json({ saved: true });
    }
    let result: unknown;
    if (path === '/sources/upload' && method === 'POST') {
      // Bound multipart parsing without keeping an extra copy of the entire request.
      let received = 0;
      const bounded = request.body?.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            received += chunk.byteLength;
            if (received > MAX_SOURCE_BYTES + 64 * 1024)
              throw new LedgerError(
                'The upload exceeds the 25 MB source limit.',
                413,
              );
            controller.enqueue(chunk);
          },
        }),
      );
      const form = await new Response(bounded, {
        headers: { 'Content-Type': request.headers.get('content-type') ?? '' },
      }).formData();
      const file = form.get('file');
      if (!(file instanceof File))
        throw new LedgerError('Choose a source file to upload.');
      const contentType = file.type.split(';')[0];
      if (!sourceTypes.has(contentType))
        throw new LedgerError(
          'Upload a PDF, HTML, XHTML, or plain text file.',
          415,
        );
      if (!file.size || file.size > MAX_SOURCE_BYTES)
        throw new LedgerError(
          'Choose a non-empty source file up to 25 MB.',
          413,
        );
      const input = Object.fromEntries(
        [...form.entries()].filter(([key]) => key !== 'file'),
      );
      result = await addSource(
        user.userId,
        ledger,
        {
          ...input,
          publication_date: input.publication_date || null,
          url: input.url || null,
          ingest_mode: 'upload',
          notes: `Uploaded file: ${file.name.split(/[\\/]/).pop()?.slice(0, 250)}`,
        },
        { bytes: new Uint8Array(await file.arrayBuffer()), contentType },
      );
    } else {
      const raw = request.body
        ? new TextDecoder().decode(
            await readBounded(request.body, 64 * 1024, true),
          )
        : '';
      const input = raw ? JSON.parse(raw) : {};
      if (path === '/sources' && method === 'POST') {
        const values = sourceInput.parse(input);
        if (values.ingest_mode === 'url' && !values.url)
          throw new LedgerError('Enter the URL to capture.');
        result = await addSource(
          user.userId,
          ledger,
          values,
          values.ingest_mode === 'url'
            ? await captureUrl(values.url!)
            : undefined,
        );
      } else result = mutateLedger(ledger, method, path, input);
    }
    await saveLedger(user.userId, ledger, revision);
    return json(result, method === 'POST' ? 201 : 200);
  } catch (error) {
    if (error instanceof LedgerError)
      return json(
        { detail: error.message, issues: error.issues },
        error.status,
      );
    if (error instanceof z.ZodError)
      return json(
        {
          detail: 'Check the highlighted record fields.',
          issues: error.issues.map(
            (issue) => `${issue.path.join('.')}: ${issue.message}`,
          ),
        },
        422,
      );
    if (error instanceof SyntaxError)
      return json({ detail: 'The request contains invalid record data.' }, 400);
    if (
      error instanceof Error &&
      (error.name === 'TimeoutError' || error.name === 'AbortError')
    )
      return json(
        {
          detail:
            'The source took too long to respond. Upload a copy or try again.',
        },
        504,
      );
    console.error(
      JSON.stringify({
        event: 'ledger_request_failed',
        error: error instanceof Error ? error.name : 'unknown',
      }),
    );
    return json(
      {
        detail:
          'Your workspace is temporarily unavailable. Your form has been kept; please retry.',
      },
      503,
    );
  }
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
