import ipaddr from 'ipaddr.js';
import { LedgerError } from './validation';

export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;
export const sourceTypes = new Set([
  'application/pdf',
  'text/plain',
  'text/html',
  'application/xhtml+xml',
]);
export async function readBounded(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
  allowEmpty = false,
): Promise<Uint8Array> {
  if (!stream) throw new LedgerError('The source is empty.');
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new LedgerError('The file exceeds the 25 MB source limit.', 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size && !allowEmpty) throw new LedgerError('The source is empty.');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
export function publicUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new LedgerError('Enter a valid public URL.');
  }
  const host = url.hostname
    .replace(/^\[|\]$/g, '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !['80', '443'].includes(url.port))
  )
    throw new LedgerError(
      'Use a public HTTP(S) URL on a standard port without embedded credentials.',
    );
  if (
    ipaddr.isValid(host) ||
    !host.includes('.') ||
    /(^|\.)(localhost|local|internal|test|invalid|example|onion)$/.test(host) ||
    ['metadata.google.internal', 'metadata.aws.internal'].includes(host)
  )
    throw new LedgerError(
      'Private addresses and internal hosts cannot be captured.',
    );
  return url;
}
async function assertPublicDns(host: string, signal: AbortSignal) {
  const results = await Promise.all(
    ['A', 'AAAA'].map(async (type) => {
      const response = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${type}`,
        { headers: { accept: 'application/dns-json' }, signal },
      );
      if (!response.ok)
        throw new LedgerError(
          'The source hostname could not be checked. Try again or upload the file.',
          502,
        );
      const bytes = await readBounded(response.body, 64 * 1024);
      return JSON.parse(new TextDecoder().decode(bytes)) as {
        Status: number;
        Answer?: { type: number; data: string }[];
      };
    }),
  );
  const addresses = results.flatMap((result) =>
    (result.Answer ?? [])
      .filter((record) => record.type === 1 || record.type === 28)
      .map((record) => record.data),
  );
  if (results.some((result) => result.Status !== 0) || !addresses.length)
    throw new LedgerError('The source hostname could not be resolved.', 422);
  for (const address of addresses) {
    if (!ipaddr.isValid(address) || ipaddr.parse(address).range() !== 'unicast')
      throw new LedgerError(
        'The source resolves to a private or reserved network address.',
      );
  }
}
export async function captureUrl(value: string) {
  const signal = AbortSignal.timeout(25_000);
  let url = publicUrl(value);
  for (let redirect = 0; redirect <= 5; redirect++) {
    await assertPublicDns(url.hostname, signal);
    const response = await fetch(url.href, {
      redirect: 'manual',
      signal,
      headers: {
        accept: 'application/pdf,text/html,text/plain,application/xhtml+xml',
        'user-agent': 'PolicyEvidenceLedger/0.2 PublicSourceCapture',
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location)
        throw new LedgerError('The source returned an empty redirect.', 502);
      url = publicUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new LedgerError(
        `The source returned HTTP ${response.status}. Upload a downloaded copy or save a manual citation.`,
        422,
      );
    }
    const contentType = (response.headers.get('content-type') ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!sourceTypes.has(contentType)) {
      await response.body?.cancel();
      throw new LedgerError(
        'Only PDF, HTML, XHTML, and plain text sources can be captured.',
        415,
      );
    }
    const bytes = await readBounded(response.body, MAX_SOURCE_BYTES);
    return { bytes, contentType, finalUrl: url.href };
  }
  throw new LedgerError('The source redirected too many times.');
}
