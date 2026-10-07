import type { Prisma } from "@prisma/client";
import prisma from "../../prisma/client";
import { dpBaseOf, minDpFor, netPaid, startPayment } from "./assignment-guard";

type Db = Prisma.TransactionClient | typeof prisma;

/*
 * ── Lock order (B9) ─────────────────────────────────────────────────────────
 * Every write transaction that touches an order's money or days takes its row
 * locks in this order, so two of them can wait on each other but never
 * deadlock (finance design §6):
 *
 *   1. Days of the order, only when the transaction changes days:
 *      lockOrderDays (all days, ORDER BY id), or the single day `update` that
 *      Edit Hari and the driver app start with.
 *   2. The order row: lockOrder (FOR NO KEY UPDATE). rollupOrderFinance takes
 *      it too, after the days.
 *   3. Invoices of the order: conditional updateMany (or the insert).
 *   4. Payables.
 *   5. Drivers and cars: lockUnits (id order).
 *   6. Customer row and counters (nextInvoiceNumber / nextReceiptNumber,
 *      total_billed / total_paid).
 *
 * Inserts (receipts, refunds, credit entries, adjustments) take only FK KEY
 * SHARE locks, which do not conflict with FOR NO KEY UPDATE.
 *
 * Callers cite this block as "B9 lock order (order-money.ts)".
 * ────────────────────────────────────────────────────────────────────────────
 */

/** Step 1: every day of the order, in id order. */
export async function lockOrderDays(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "order_service_items" WHERE order_id = ${orderId} ORDER BY id FOR NO KEY UPDATE`;
}

/** Step 2: the order row. */
export async function lockOrder(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${orderId} FOR NO KEY UPDATE`;
}

/** Whole sen, so sums of DECIMAL(12,2) values stay exact. */
const sen = (v: unknown) => Math.round(Number(v ?? 0) * 100);
const rp = (s: number) => s / 100;

/*
 * ── Saldo lebih ledger (INV-1, INV-2) ──────────────────────────────────────
 * orders.credit_balance = Σ order_credit_entries.amount, always ≥ 0. Only
 * these helpers write entries, each in the caller's transaction and under the
 * order lock (lockOrder), together with the cached balance. The migration's
 * OPENING entries follow the same rule.
 * In A1 nothing reads the balance for a rule: billable_remaining, start_ready
 * and payment_status do not use it (see computeOrderMoney).
 */
type CreditKind = "OPENING" | "OVERPAYMENT" | "RELEASE" | "APPLIED" | "UNAPPLIED" | "REFUND";

/** One ledger movement (positive adds credit, negative uses it). Zero writes nothing. */
export async function addCreditEntry(
  tx: Prisma.TransactionClient,
  entry: {
    orderId: string;
    kind: CreditKind;
    /** Rupiah; sign as stored. */
    amount: number;
    invoiceId?: string;
    refundId?: string;
    note?: string;
    actor?: string;
  },
): Promise<void> {
  const amount = rp(sen(entry.amount));
  if (amount === 0) return;
  await tx.orderCreditEntry.create({
    data: {
      order_id: entry.orderId,
      kind: entry.kind,
      amount,
      invoice_id: entry.invoiceId ?? null,
      refund_id: entry.refundId ?? null,
      note: entry.note ?? null,
      actor: entry.actor ?? null,
    },
  });
  await tx.order.update({
    where: { id: entry.orderId },
    data: { credit_balance: { increment: amount } },
  });
}

/**
 * The old "refund settled" endpoint keeps one refund per order and overwrites
 * it when re-marked. Its REFUND entry (one per refund, INV-8) follows: the
 * refund uses saldo lebih up to min(amount, credit available before it), and
 * a re-mark moves the same entry instead of adding a second one.
 */
export async function setLegacyRefundCredit(
  tx: Prisma.TransactionClient,
  orderId: string,
  refundId: string,
  amount: number,
): Promise<void> {
  const [order, existing] = await Promise.all([
    tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { credit_balance: true } }),
    tx.orderCreditEntry.findFirst({ where: { refund_id: refundId, kind: "REFUND" } }),
  ]);
  const before = existing ? -sen(existing.amount) : 0;
  const available = sen(order.credit_balance) + before;
  const use = Math.max(0, Math.min(sen(amount), available));
  if (use === before) return;
  if (!existing) {
    await addCreditEntry(tx, {
      orderId,
      kind: "REFUND",
      amount: -rp(use),
      refundId,
      note: "Pengembalian dana (tandai sudah direfund)",
      actor: "ADMIN",
    });
    return;
  }
  if (use === 0) await tx.orderCreditEntry.delete({ where: { id: existing.id } });
  else await tx.orderCreditEntry.update({ where: { id: existing.id }, data: { amount: -rp(use) } });
  await tx.order.update({
    where: { id: orderId },
    data: { credit_balance: { increment: rp(before - use) } },
  });
}

/**
 * What is already billed on an order, for the "never bill more than the order
 * total" checks: the active invoices plus money received on invoices that a
 * cancellation voided. That money still counts toward the cancellation fee
 * (cancelOrder bills only the rest), so it must not be billed again. Only
 * cancelOrder voids invoices, so other orders are unaffected.
 */
export async function billedSoFar(
  orderId: string,
  excludeInvoiceId?: string,
  db: Db = prisma,
): Promise<number> {
  const [active, voidedPaid] = await Promise.all([
    db.invoice.aggregate({
      where: {
        order_id: orderId,
        ...(excludeInvoiceId ? { id: { not: excludeInvoiceId } } : {}),
        status: { notIn: ["REVISED", "CANCELLED"] },
      },
      _sum: { amount: true },
    }),
    db.invoice.aggregate({
      where: { order_id: orderId, status: "CANCELLED", paid_at: { not: null } },
      _sum: { amount: true },
    }),
  ]);
  return Number(active._sum.amount ?? 0) + Number(voidedPaid._sum.amount ?? 0);
}

/**
 * The money of one order (finance design §2), returned as `money` by
 * GET /orders/:id. All amounts in rupiah.
 *
 * Rule set "v3-a1" (PR A1): the ledger columns exist, but the numbers are
 * today's rules, so nothing an admin sees changes yet:
 *  - billable_remaining is the cap generateInvoice enforces today: total −
 *    billedSoFar (invoice amounts), not total − covered − open_billed.
 *  - start_ready is startPayment (money received before refunds ≥ base).
 *  - credit_balance is 0 unless the migration opened it (OPENING); nothing
 *    adds to or uses it yet.
 * PR A2 moves billable_remaining to covered and start_ready to net_paid and
 * sets the rule to "v3".
 */
export interface OrderMoney {
  /** T: the order total (final_price). */
  total: number;
  /** DP and "lunas" base: rental price of the days that are not cancelled; on a cancelled order the fee. */
  base: number;
  min_dp: number;
  /** Billable charges (Σ amount × quantity). */
  charges: number;
  /** Money received (paid_to_date). */
  received: number;
  /** Σ refunds (refunded_total). */
  refunded: number;
  net_paid: number;
  /** Saldo lebih. */
  credit_balance: number;
  /** net_paid − credit_balance: the part of the total settled with money. */
  covered: number;
  /** Cash asked on active unpaid invoices (DRAFT/ISSUED). */
  open_billed: number;
  /** The most a new invoice may ask for. */
  billable_remaining: number;
  /** Piutang: max(0, total − net_paid). */
  outstanding: number;
  payment_status: string;
  start_ready: boolean;
  rule: "v3-a1";
}

export async function computeOrderMoney(db: Db, orderId: string): Promise<OrderMoney | null> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      final_price: true,
      paid_to_date: true,
      payment_status: true,
      is_refunded: true,
      refund_amount: true,
      refunded_total: true,
      credit_balance: true,
      cancellation_fee: true,
      service_items: { select: { total_price: true, line_status: true } },
      adjustments: { where: { is_billable: true }, select: { amount: true, quantity: true } },
    },
  });
  if (!order) return null;
  const [billed, open] = await Promise.all([
    billedSoFar(orderId, undefined, db),
    db.invoice.aggregate({
      where: { order_id: orderId, status: { in: ["DRAFT", "ISSUED"] } },
      _sum: { amount: true },
    }),
  ]);

  const total = sen(order.final_price);
  // minDp from the same float the DP rule uses today (minDpFor), so the two agree.
  const base = dpBaseOf(order, order.service_items);
  const charges = order.adjustments.reduce((s, a) => s + sen(a.amount) * (a.quantity ?? 1), 0);
  const net = sen(netPaid(order));
  const credit = sen(order.credit_balance);
  return {
    total: rp(total),
    base: rp(sen(base)),
    min_dp: minDpFor(base),
    charges: rp(charges),
    received: rp(sen(order.paid_to_date)),
    refunded: rp(sen(order.refunded_total)),
    net_paid: rp(net),
    credit_balance: rp(credit),
    covered: rp(net - credit),
    open_billed: rp(sen(open._sum.amount)),
    billable_remaining: rp(Math.max(0, total - sen(billed))),
    outstanding: rp(Math.max(0, total - net)),
    payment_status: order.payment_status,
    start_ready: startPayment(order, order.service_items).ready,
    rule: "v3-a1",
  };
}
