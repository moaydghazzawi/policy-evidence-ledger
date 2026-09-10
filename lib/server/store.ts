import { env } from 'cloudflare:workers';
import {
  emptyLedger,
  LedgerError,
  ledgerSchema,
  now,
  type Ledger,
} from './validation';

type Stored = { body: string; revision: number };
export async function loadLedger(
  ownerId: string,
): Promise<{ ledger: Ledger; revision: number }> {
  const row = await env.DB.prepare(
    'SELECT body, revision FROM ledgers WHERE owner_id = ?',
  )
    .bind(ownerId)
    .first<Stored>();
  if (!row) return { ledger: emptyLedger(), revision: -1 };
  const result = ledgerSchema.safeParse(JSON.parse(row.body));
  if (!result.success)
    throw new LedgerError(
      'The saved ledger needs a data integrity review. No records were changed.',
      409,
    );
  return { ledger: result.data, revision: row.revision };
}
export async function saveLedger(
  ownerId: string,
  ledger: Ledger,
  revision: number,
) {
  const body = JSON.stringify(ledgerSchema.parse(ledger));
  if (new TextEncoder().encode(body).length > 900_000)
    throw new LedgerError(
      'This workspace has reached its structured-record limit. Export your research before starting another collection.',
      413,
    );
  const result =
    revision < 0
      ? await env.DB.prepare(
          'INSERT OR IGNORE INTO ledgers (owner_id, body, revision, updated_at) VALUES (?, ?, 0, ?)',
        )
          .bind(ownerId, body, now())
          .run()
      : await env.DB.prepare(
          'UPDATE ledgers SET body = ?, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND revision = ?',
        )
          .bind(body, now(), ownerId, revision)
          .run();
  if (result.meta.changes !== 1)
    throw new LedgerError(
      'This workspace changed in another window. Refresh and try saving again; your form is still here.',
      409,
    );
}
export async function sha256(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const buffer =
    bytes instanceof Uint8Array
      ? bytes.buffer instanceof ArrayBuffer &&
        bytes.byteOffset === 0 &&
        bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer
        : new Uint8Array(bytes).buffer
      : bytes;
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
}
export async function blobKey(ownerId: string, hash: string) {
  return `${await sha256(new TextEncoder().encode(ownerId))}/${hash}`;
}
export async function preserveBlob(
  ownerId: string,
  ledger: Ledger,
  bytes: Uint8Array,
  contentType: string,
) {
  const hash = await sha256(bytes);
  // Reserve first, atomically. Failed ledger commits never create unaccounted bytes.
  await env.DB.prepare(
    'INSERT OR IGNORE INTO snapshot_objects (owner_id, hash, byte_size) SELECT ?, ?, ? WHERE COALESCE((SELECT SUM(byte_size) FROM snapshot_objects WHERE owner_id = ?), 0) + ? <= ?',
  )
    .bind(
      ownerId,
      hash,
      bytes.byteLength,
      ownerId,
      bytes.byteLength,
      100 * 1024 * 1024,
    )
    .run();
  const reservation = await env.DB.prepare(
    'SELECT byte_size FROM snapshot_objects WHERE owner_id = ? AND hash = ?',
  )
    .bind(ownerId, hash)
    .first<{ byte_size: number }>();
  if (!reservation || reservation.byte_size !== bytes.byteLength)
    throw new LedgerError(
      'Your workspace has reached its 100 MB source-snapshot limit.',
      413,
    );
  await env.BUCKET.put(await blobKey(ownerId, hash), bytes, {
    httpMetadata: { contentType },
    onlyIf: { etagDoesNotMatch: '*' },
  });
  ledger.blob_sizes[hash] = bytes.byteLength;
  return hash;
}
