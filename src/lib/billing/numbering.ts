import type { Prisma } from '@prisma/client';

/**
 * Gap-free, human-facing document numbers.
 *
 * WHY A COUNTER TABLE AND NOT AUTOINCREMENT
 * -----------------------------------------
 * A Canadian auditor reads a missing invoice number as a destroyed invoice.
 * SQLite/Postgres autoincrement and Postgres sequences are explicitly NOT
 * gap-free: they hand out a value outside the transaction so a rollback burns
 * it forever. `DocumentSequence` is a plain counter row bumped inside the same
 * transaction that issues the document, so a rolled-back issue returns its
 * number to the pool.
 *
 * THE RACE, STATED PRECISELY
 * --------------------------
 * The naive implementation is read-then-write:
 *
 *     const row = await tx.documentSequence.findUnique(...)   // reads 137
 *     await tx.documentSequence.update({ nextValue: row.nextValue + 1 })
 *
 * Two issues running concurrently both read 137 and both write 138. Both
 * documents claim INV-2026-000137. On SQLite the second write blocks (one
 * writer at a time) but it blocks holding a *stale* value it read before the
 * first transaction committed, so it still writes 138. The duplicate is then
 * caught only by `Invoice.number @unique`, which aborts the second transaction
 * — and the number it had already consumed is now a gap. Worse, on a database
 * without that unique index you get two invoices with the same number and no
 * error at all.
 *
 * The fix here is to never compute the next value in application code. The
 * bump is a single `UPDATE … SET nextValue = nextValue + 1 … RETURNING *`
 * (Prisma's `{ increment: 1 }`), which is atomic at the row level on both
 * SQLite and Postgres: the database, not this process, decides the new value,
 * and the returned row is the post-increment state. We hand out
 * `returned.nextValue - 1`.
 *
 * That leaves exactly one race, on the FIRST document of a new year, where two
 * transactions both find no counter row and both try to create it. The loser
 * gets a unique-constraint violation on `@@unique([scope, series, year])`;
 * `allocateDocumentNumber` catches it and retries against the row the winner
 * created. See `isUniqueViolation` below.
 *
 * POSTGRES MIGRATION NOTE: the increment stays atomic, but if you ever replace
 * it with a read-modify-write you must add `SELECT … FOR UPDATE`. Do not
 * "optimise" the counter into a nextval() sequence — that reintroduces gaps.
 */

export type DocumentScope = 'invoice' | 'credit_note' | 'ticket' | 'placement_invoice';

/** The persisted shape of a `DocumentSequence` row, narrowed to what we use. */
export interface SequenceRow {
  id: string;
  scope: string;
  series: string;
  year: number;
  prefix: string;
  nextValue: number;
  padding: number;
}

export interface SequenceKey {
  scope: DocumentScope;
  series: string;
  year: number;
}

export interface SequenceStyle {
  series: string;
  prefix: string;
  padding: number;
}

/**
 * Per-scope defaults. `prefix` and `padding` live in the database precisely so
 * the printed format is data rather than code — these are only the values used
 * when a counter row for a given (scope, series, year) does not exist yet.
 *
 * Note the series stays `JP` / `JP-CN` (that is what the schema defaults to and
 * what other modules filter on) while the printed prefix is `INV-` / `CN-`.
 * The series is an internal book; the prefix is what the customer reads.
 */
export const SEQUENCE_STYLES: Record<DocumentScope, SequenceStyle> = {
  invoice: { series: 'JP', prefix: 'INV-', padding: 6 },
  credit_note: { series: 'JP-CN', prefix: 'CN-', padding: 6 },
  ticket: { series: 'TKT', prefix: 'TKT-', padding: 6 },
  // Stage 19: an agency's invoice to its CLIENT. Its own book: the counter
  // table is shared numbering infrastructure, not a billing path - a
  // placement invoice never becomes an `Invoice` row.
  placement_invoice: { series: 'PL', prefix: 'PL-', padding: 6 },
};

/**
 * Render a document number: `INV-2026-000123`.
 *
 * If the sequence outgrows its padding the number gets longer rather than
 * truncated — a wrong number is far worse than an ugly one, and truncating
 * would eventually collide.
 */
export function formatDocumentNumber(input: {
  prefix: string;
  year: number;
  sequence: number;
  padding?: number;
}): string {
  const { prefix, year, sequence } = input;
  const padding = input.padding ?? 6;

  if (!Number.isInteger(sequence) || sequence < 1) {
    throw new Error(`Document sequence must be a positive integer, received ${sequence}`);
  }
  if (!Number.isInteger(year) || year < 1970 || year > 9999) {
    throw new Error(`Document year must be a four-digit year, received ${year}`);
  }

  return `${prefix}${year}-${String(sequence).padStart(Math.max(1, padding), '0')}`;
}

/**
 * Inverse of `formatDocumentNumber`, for console search and tests. Returns null
 * rather than throwing — this parses user-typed input.
 */
export function parseDocumentNumber(
  value: string,
): { prefix: string; year: number; sequence: number } | null {
  // Prefix segments must each contain a letter, so the four-digit year can
  // never be swallowed into the prefix ("JP-CN-2026-000012" parses correctly).
  const match = /^((?:[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*-)+)(\d{4})-(\d+)$/.exec(value.trim());
  if (!match) return null;
  return { prefix: match[1], year: Number(match[2]), sequence: Number(match[3]) };
}

/** The three operations numbering needs from storage. */
export interface SequenceStore {
  find(key: SequenceKey): Promise<SequenceRow | null>;
  create(row: Omit<SequenceRow, 'id'>): Promise<SequenceRow>;
  /** Atomic `nextValue = nextValue + 1`; resolves with the row AFTER the bump. */
  increment(id: string): Promise<SequenceRow>;
}

/** A Prisma client or interactive-transaction client. */
export type SequenceClient = Pick<Prisma.TransactionClient, 'documentSequence'>;

/** Adapt Prisma to `SequenceStore`. Pass the *transaction* client, not `db`. */
export function prismaSequenceStore(client: SequenceClient): SequenceStore {
  return {
    find: (key) =>
      client.documentSequence.findUnique({
        where: {
          scope_series_year: { scope: key.scope, series: key.series, year: key.year },
        },
      }),
    create: (row) => client.documentSequence.create({ data: row }),
    increment: (id) =>
      client.documentSequence.update({
        where: { id },
        data: { nextValue: { increment: 1 } },
      }),
  };
}

export interface AllocatedNumber {
  number: string;
  sequence: number;
  year: number;
  series: string;
  prefix: string;
  padding: number;
}

/** True for a Prisma unique-constraint violation (P2002) from any client. */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'P2002'
  );
}

/**
 * Take the next number for (scope, series, year).
 *
 * MUST be called inside the transaction that also writes the document, so a
 * failed issue gives the number back.
 */
export async function allocateDocumentNumber(
  store: SequenceStore,
  key: SequenceKey,
  style?: Partial<SequenceStyle>,
): Promise<AllocatedNumber> {
  const defaults = SEQUENCE_STYLES[key.scope];
  const prefix = style?.prefix ?? defaults.prefix;
  const padding = style?.padding ?? defaults.padding;

  const existing = await store.find(key);
  if (existing) return handOut(existing, await store.increment(existing.id));

  // First document of this series/year. `nextValue: 2` because we are handing
  // out 1 right now — the row records what comes *next*, never what was used.
  try {
    const created = await store.create({
      scope: key.scope,
      series: key.series,
      year: key.year,
      prefix,
      padding,
      nextValue: 2,
    });
    return {
      number: formatDocumentNumber({ prefix: created.prefix, year: created.year, sequence: 1, padding: created.padding }),
      sequence: 1,
      year: created.year,
      series: created.series,
      prefix: created.prefix,
      padding: created.padding,
    };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Someone else created the counter between our find and our create. Their
    // row is authoritative; bump it instead of guessing.
    const row = await store.find(key);
    if (!row) throw error;
    return handOut(row, await store.increment(row.id));
  }
}

function handOut(before: SequenceRow, after: SequenceRow): AllocatedNumber {
  const sequence = after.nextValue - 1;
  return {
    number: formatDocumentNumber({
      prefix: after.prefix,
      year: after.year,
      sequence,
      padding: after.padding,
    }),
    sequence,
    year: after.year,
    series: after.series || before.series,
    prefix: after.prefix,
    padding: after.padding,
  };
}

/** Next invoice number, e.g. `INV-2026-000123`. */
export function allocateInvoiceNumber(
  client: SequenceClient,
  year: number,
  series = SEQUENCE_STYLES.invoice.series,
): Promise<AllocatedNumber> {
  return allocateDocumentNumber(prismaSequenceStore(client), { scope: 'invoice', series, year });
}

/** Next credit-note number, e.g. `CN-2026-000012`. */
export function allocateCreditNoteNumber(
  client: SequenceClient,
  year: number,
  series = SEQUENCE_STYLES.credit_note.series,
): Promise<AllocatedNumber> {
  return allocateDocumentNumber(prismaSequenceStore(client), {
    scope: 'credit_note',
    series,
    year,
  });
}
