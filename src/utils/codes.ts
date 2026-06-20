import type { Prisma } from '@prisma/client';
import prisma from '../prisma/client';

/**
 * Arasya numbering system (LOCKED spec, see DASHBOARD_TODO_PLAN.md §4).
 *
 *   Customer code : C{n}                       e.g. C42   (global running, no reset, unpadded)
 *   Order code    : ARS-YYYYMMDD-C{n}-{s}       {s} = per-customer order seq  (booking date)
 *   Invoice number: INV-YYYYMMDD-C{n}-{s}       {s} = per-customer invoice seq (issue date)
 *   Kwitansi      : KWT-YYYYMMDD-C{n}-{s}       {s} = per-customer kwitansi seq (payment date)
 *
 * All sequence increments are ATOMIC and must run INSIDE the same DB transaction
 * as the row insert (never `count()`), so concurrent writes never collide.
 */

export type Db = Prisma.TransactionClient | typeof prisma;

// ── Date formatting (Asia/Jakarta GMT+7) ────────────────────────────────
// toISOString() is UTC; an order booked late-evening Jakarta time would render
// the previous day. Always format the local Jakarta date for the code.
export function formatCodeDate(date: Date = new Date()): string {
  const jakarta = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const y = jakarta.getUTCFullYear();
  const m = String(jakarta.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jakarta.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

// ── Primitive 1: mint the next global customer code (C{n}) ───────────────
// Atomic: UPDATE ... RETURNING locks the counter row so concurrent customer
// creations serialize and each gets a distinct value.
export async function mintCustomerCode(tx: Db): Promise<{ n: number; code: string }> {
  const rows = await tx.$queryRaw<{ value: number }[]>`
    UPDATE counters SET value = value + 1, updated_at = now()
    WHERE scope = 'customer'
    RETURNING value`;
  if (!rows.length) {
    // Counter row missing (should be seeded by migration). Create + retry once.
    await tx.$executeRaw`
      INSERT INTO counters (scope, value, updated_at)
      VALUES ('customer', 0, now())
      ON CONFLICT (scope) DO NOTHING`;
    const retry = await tx.$queryRaw<{ value: number }[]>`
      UPDATE counters SET value = value + 1, updated_at = now()
      WHERE scope = 'customer'
      RETURNING value`;
    const n = retry[0].value;
    return { n, code: `C${n}` };
  }
  const n = rows[0].value;
  return { n, code: `C${n}` };
}

// ── Primitive 2: next per-customer document sequence ─────────────────────
// Locks just that one customer row. Two docs for the SAME customer serialize
// (correct); docs for DIFFERENT customers never block each other.
type SeqColumn = 'order_seq' | 'invoice_seq' | 'kwitansi_seq';

async function nextCustomerSeq(tx: Db, customerId: string, column: SeqColumn): Promise<number> {
  // Column name is a fixed literal from a closed union — safe to interpolate.
  const rows = await tx.$queryRawUnsafe<{ seq: number }[]>(
    `UPDATE customers SET ${column} = ${column} + 1 WHERE id = $1 RETURNING ${column} AS seq`,
    customerId,
  );
  if (!rows.length) {
    throw new Error(`Customer ${customerId} not found while assigning ${column}`);
  }
  return rows[0].seq;
}

// ── Number assembly + per-customer sequence (single source of truth) ─────
function custCode(code: string): string {
  // Stored codes are unpadded ("C42"). PDF layer may pad for presentation.
  return code;
}

export async function nextOrderCode(
  tx: Db,
  customer: { id: string; code: string },
  bookingDate: Date = new Date(),
): Promise<{ seq: number; code: string }> {
  const seq = await nextCustomerSeq(tx, customer.id, 'order_seq');
  const code = `ARS-${formatCodeDate(bookingDate)}-${custCode(customer.code)}-${seq}`;
  return { seq, code };
}

export async function nextInvoiceNumber(
  tx: Db,
  customer: { id: string; code: string },
  issueDate: Date = new Date(),
): Promise<{ seq: number; number: string }> {
  const seq = await nextCustomerSeq(tx, customer.id, 'invoice_seq');
  const number = `INV-${formatCodeDate(issueDate)}-${custCode(customer.code)}-${seq}`;
  return { seq, number };
}

export async function nextReceiptNumber(
  tx: Db,
  customer: { id: string; code: string },
  paymentDate: Date = new Date(),
): Promise<{ seq: number; number: string }> {
  const seq = await nextCustomerSeq(tx, customer.id, 'kwitansi_seq');
  const number = `KWT-${formatCodeDate(paymentDate)}-${custCode(customer.code)}-${seq}`;
  return { seq, number };
}
