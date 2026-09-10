import {
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

// A single revision is the atomic boundary for a research ledger and its links.
// Document bytes live in R2; this row contains only bounded structured records.
export const ledgers = sqliteTable('ledgers', {
  ownerId: text('owner_id').primaryKey(),
  body: text('body').notNull(),
  revision: integer('revision').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
});

// Durable byte reservations count even interrupted uploads against the quota.
export const snapshotObjects = sqliteTable(
  'snapshot_objects',
  {
    ownerId: text('owner_id').notNull(),
    hash: text('hash').notNull(),
    byteSize: integer('byte_size').notNull(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.hash] })],
);
