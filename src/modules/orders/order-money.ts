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
