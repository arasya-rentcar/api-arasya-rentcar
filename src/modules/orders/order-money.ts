import type { Prisma } from "@prisma/client";
import prisma from "../../prisma/client";
import { AppError } from "../../utils/AppError";
import { rupiah } from "../../services/adminNotify";
import { dpBaseOf, minDpFor, orderPaymentStatus, rentalBaseOf, rentalLineSelect } from "./assignment-guard";

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
export const sen = (v: unknown) => Math.round(Number(v ?? 0) * 100);
export const rp = (s: number) => s / 100;

/*
 * ── Saldo lebih ledger (INV-1, INV-2) ──────────────────────────────────────
 * orders.credit_balance = Σ order_credit_entries.amount, always ≥ 0. Only
 * addCreditEntry writes entries, each in the caller's transaction and under
 * the order lock (lockOrder), together with the cached balance. The A1
 * migration's OPENING entries follow the same rule.
 *
 * Where credit comes from (finance design §3.3): OVERPAYMENT (mark-paid with
 * more than the invoice asked), RELEASE (the total fell below what money
 * already covers: settleCredit), UNAPPLIED (an unpaid invoice that used
 * credit is revised or voided), OPENING (backfill). Where it goes: APPLIED
 * (invoice create / revise, the cancellation fee) and REFUND. Credit stays on
 * its order (owner, 7 Oct 2026); it is never moved to another one.
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
 * The money of one order in whole sen (finance design §2). Read it under the
 * order lock whenever a rule depends on it.
 *
 *   T        = final_price
 *   Net      = paid_to_date − refunded_total
 *   C        = credit_balance (saldo lebih)
 *   Covered  = Net − C             the part of T settled with money
 *   Open     = Σ amount (cash asked) of DRAFT/ISSUED invoices
 *   Billable = T − Covered − Open  the most a new invoice may cover (gross)
 *
 * `excludeInvoiceId` leaves one unpaid invoice out of Open (the one a
 * revision replaces).
 */
export interface MoneyState {
  total: number;
  /** DP / "lunas" base (dpBaseOf). */
  base: number;
  charges: number;
  received: number;
  refunded: number;
  net: number;
  credit: number;
  covered: number;
  open: number;
  billable: number;
  paymentStatus: string;
}

export async function moneyState(
  db: Db,
  orderId: string,
  opts: { excludeInvoiceId?: string } = {},
): Promise<MoneyState | null> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    select: {
      final_price: true,
      paid_to_date: true,
      payment_status: true,
      refunded_total: true,
      credit_balance: true,
      cancellation_fee: true,
      cancellation_rule: true,
      service_items: { select: rentalLineSelect },
      adjustments: { where: { is_billable: true }, select: { amount: true, quantity: true } },
    },
  });
  if (!order) return null;
  const open = await db.invoice.aggregate({
    where: {
      order_id: orderId,
      status: { in: ["DRAFT", "ISSUED"] },
      ...(opts.excludeInvoiceId ? { id: { not: opts.excludeInvoiceId } } : {}),
    },
    _sum: { amount: true },
  });
  const total = sen(order.final_price);
  const net = sen(order.paid_to_date) - sen(order.refunded_total);
  const credit = sen(order.credit_balance);
  const covered = net - credit;
  const openSen = sen(open._sum.amount);
  return {
    total,
    base: sen(dpBaseOf(order, order.service_items)),
    charges: order.adjustments.reduce((s, a) => s + sen(a.amount) * (a.quantity ?? 1), 0),
    received: sen(order.paid_to_date),
    refunded: sen(order.refunded_total),
    net,
    credit,
    covered,
    open: openSen,
    billable: total - covered - openSen,
    paymentStatus: order.payment_status,
  };
}

/**
 * INV-5 (Covered ≤ T): when the total fell below what money already covers
 * (a billed charge removed, a cancellation fee lower than the money kept),
 * the excess becomes saldo lebih (RELEASE). Called under the order lock, at
 * the end of rollupOrderFinance, mark-paid and cancel. Returns the rupiah
 * released.
 */
export async function settleCredit(
  tx: Prisma.TransactionClient,
  orderId: string,
  note = "Total order turun di bawah uang yang sudah diterima",
): Promise<number> {
  const m = await moneyState(tx, orderId);
  if (!m || m.covered <= m.total) return 0;
  const release = m.covered - m.total;
  await addCreditEntry(tx, { orderId, kind: "RELEASE", amount: rp(release), note, actor: "SYSTEM" });
  return rp(release);
}

/**
 * INV-6 (Covered + OpenBilled ≤ T, finance design §6) for a change that
 * lowers T on purpose (a day cancelled in Edit Hari, a day removed or
 * repriced in Edit Order, a billed trip cost rejected, deleted or lowered).
 * Unpaid invoices may ask at most what is still owed: refused when
 * OpenBilled > max(0, T_new − Covered). Money beyond T_new is not refused:
 * the rollup releases it as saldo lebih (settleCredit, INV-5). Called under
 * the order lock, after the rollup wrote T_new. The 409 carries the numbers
 * so the admin knows how far to revise the unpaid invoice.
 */
export async function assertOpenWithinTotal(
  tx: Prisma.TransactionClient,
  orderId: string,
  what = "Perubahan ini",
): Promise<void> {
  const m = await moneyState(tx, orderId);
  if (!m) return;
  const maxOpen = Math.max(0, m.total - m.covered);
  if (m.open <= maxOpen) return;
  throw new AppError(
    `${what} membuat total order ${rupiah(rp(m.total))}, padahal invoice yang belum dibayar masih menagih ${rupiah(rp(m.open))} dan yang masih terutang tinggal ${rupiah(rp(maxOpen))}. Revisi invoice yang belum dibayar menjadi paling banyak ${rupiah(rp(maxOpen))} (atau batalkan), lalu simpan lagi.`,
    409,
    {
      code: "OPEN_INVOICE_EXCEEDS",
      new_total: rp(m.total),
      covered: rp(m.covered),
      open_billed: rp(m.open),
      max_open_billed: rp(maxOpen),
    },
  );
}

/**
 * INV-9: payment_status from Net, T and base (orderPaymentStatus), written
 * when it changed. For transactions that move Net without a rollup (refunds).
 */
export async function recomputePaymentStatus(tx: Prisma.TransactionClient, orderId: string): Promise<string> {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      final_price: true,
      paid_to_date: true,
      payment_status: true,
      refunded_total: true,
      cancellation_fee: true,
      cancellation_rule: true,
      service_items: { select: rentalLineSelect },
    },
  });
  const status = orderPaymentStatus(order, order.service_items);
  if (status !== order.payment_status) {
    await tx.order.update({ where: { id: orderId }, data: { payment_status: status } });
  }
  return status;
}

/**
 * The money of one order (finance design §2), returned as `money` by
 * GET /orders/:id and as `order_money` by the money endpoints. All amounts in
 * rupiah.
 *
 * Rule set "v3" (PR A2): new invoices are capped by Billable (on Covered, so
 * an underpaid invoice's shortfall can be billed again and saldo lebih is
 * not billed twice); payment_status and start_ready use Net (money received
 * − refunded).
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
  /** The most a new invoice may cover (gross, before saldo lebih): total − covered − open_billed. */
  billable_remaining: number;
  /** Piutang: max(0, total − net_paid). */
  outstanding: number;
  payment_status: string;
  /** "Mulai perjalanan" allowed: net_paid ≥ rental price of the days not cancelled. */
  start_ready: boolean;
  rule: "v3";
}

export async function computeOrderMoney(db: Db, orderId: string): Promise<OrderMoney | null> {
  const [m, days] = await Promise.all([
    moneyState(db, orderId),
    db.orderServiceItem.findMany({ where: { order_id: orderId }, select: rentalLineSelect }),
  ]);
  if (!m) return null;
  return {
    total: rp(m.total),
    base: rp(m.base),
    // minDp from the same float the DP rule uses (minDpFor), so the two agree.
    min_dp: minDpFor(rp(m.base)),
    charges: rp(m.charges),
    received: rp(m.received),
    refunded: rp(m.refunded),
    net_paid: rp(m.net),
    credit_balance: rp(m.credit),
    covered: rp(m.covered),
    open_billed: rp(m.open),
    billable_remaining: rp(Math.max(0, m.billable)),
    outstanding: rp(Math.max(0, m.total - m.net)),
    payment_status: m.paymentStatus,
    start_ready: m.net >= sen(rentalBaseOf(days)),
    rule: "v3",
  };
}
