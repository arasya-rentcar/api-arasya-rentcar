import { waLink, waManual } from "../../utils/waManual";
import {
  dpBaseOf,
  minDpFor,
  netPaid,
  paymentStatusFor,
  rentalBaseOf,
  startPayment,
} from "../orders/assignment-guard";
import {
  addCreditEntry,
  computeOrderMoney,
  lockOrder,
  moneyState,
  rp,
  sen,
  settleCredit,
  type MoneyState,
} from "../orders/order-money";
import { rupiah } from "../../services/adminNotify";
import { notifyOrderPaidInFull } from "../../services/driverNotify";
import { reportLeadPurchase, sendsNoPurchase } from "../../services/ga4.service";
import { Prisma, type Invoice } from "@prisma/client";
import prisma from "../../prisma/client";
import { env } from "../../config/env";
import { AppError } from "../../utils/AppError";
import { nextInvoiceNumber, nextReceiptNumber } from "../../utils/codes";
import { packageNoteLines } from "../../utils/packageNotes";
import {
  buildDpInvoiceCaption,
  buildSettlementInvoiceCaption,
  buildAdditionalInvoiceCaption,
  buildAdjustmentInvoiceCaption,
  buildRentalReceiptCaption,
  buildAdditionalReceiptCaption,
  formatTripDuration,
  greetingFor,
  isSameDay,
} from "../../utils/waCaptions";
import { generateInvoicePDF, type InvoiceLineItem } from "../../services/pdf.service";
import {
  uploadInvoicePDF,
  uploadFile,
  removeFile,
  assertValidUpload,
  getSignedUrl,
  PAYMENT_PROOFS_BUCKET,
  type UploadedFile,
} from "../../services/storage.service";
import {
  GenerateInvoiceInput,
  ReviseInvoiceInput,
  SendInvoiceWhatsappInput,
  SendReceiptWhatsappInput,
} from "./invoices.validation";

// Format an adjustment's date as e.g. "Senin, 22 Juni 2026" (Asia/Jakarta).
function fmtAdjustmentDate(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("id-ID", {
    timeZone: "Asia/Jakarta",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

const INVOICE_TYPE_LABEL: Record<string, string> = {
  DP: "Down Payment",
  SETTLEMENT: "Settlement Payment",
  FULL: "Full Payment",
  ADDITIONAL: "Additional Charge",
  COMBINED: "Rental + Additional (Combined)",
  ADJUSTMENT: "Invoice Penyesuaian",
};
const PAYMENT_METHOD_LABEL: Record<string, string> = {
  CASH: "Cash",
  BANK_TRANSFER: "Bank Transfer",
  QRIS: "QRIS",
  OTHER: "Other",
};
const PAYMENT_RECEIVED_LABEL: Record<string, string> = {
  DP: "Pembayaran DP diterima",
  SETTLEMENT: "Pelunasan diterima",
  FULL: "Pembayaran diterima",
  ADDITIONAL: "Pembayaran tambahan diterima",
  ADJUSTMENT: "Pembayaran kekurangan diterima",
};

/** The part of the order total an invoice covers: cash asked + saldo lebih used. */
export const grossOf = (inv: { amount: unknown; credit_applied?: unknown }) =>
  rp(sen(inv.amount) + sen(inv.credit_applied));

/** Money short on a paid invoice (asked − received), 0 when none. */
export const shortfallOf = (inv: { status: string; amount: unknown; amount_received?: unknown }) =>
  inv.status === "PAID" && inv.amount_received != null
    ? rp(Math.max(0, sen(inv.amount) - sen(inv.amount_received)))
    : 0;

/** An invoice as the API returns it: the stored row plus its gross and shortfall. */
export const invoiceView = <T extends { status: string; amount: unknown; credit_applied?: unknown; amount_received?: unknown }>(inv: T) => ({
  ...inv,
  gross: grossOf(inv),
  shortfall: shortfallOf(inv),
});

/** "3 Oktober 2026" in WIB. */
function fmtLongWibDate(d: Date): string {
  return new Date(d).toLocaleDateString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * Money actually received on an order, one entry per paid invoice: its
 * receipt amount (may exceed the invoice on overpayment), or the invoice
 * amount for old rows without a receipt. An invoice voided later by a
 * cancellation still counts: that money was received.
 */
async function paymentsOnOrder(
  db: Prisma.TransactionClient | typeof prisma,
  orderId: string,
  excludeInvoiceId?: string,
) {
  const paid = await db.invoice.findMany({
    where: {
      order_id: orderId,
      ...(excludeInvoiceId ? { id: { not: excludeInvoiceId } } : {}),
      OR: [{ status: "PAID" }, { status: "CANCELLED", paid_at: { not: null } }],
    },
    orderBy: [{ paid_at: "asc" }, { issue_date: "asc" }],
    select: {
      id: true,
      invoice_type: true,
      amount: true,
      paid_at: true,
      issue_date: true,
      receipts: { select: { amount: true }, orderBy: { created_at: "asc" }, take: 1 },
    },
  });
  const items = paid.map((p) => ({
    id: p.id,
    invoice_type: p.invoice_type as string,
    paid_at: p.paid_at,
    issue_date: p.issue_date,
    received: p.receipts[0] ? Number(p.receipts[0].amount) : Number(p.amount),
  }));
  return { items, total: items.reduce((s, p) => s + p.received, 0) };
}

/** "Payments received" lines for a kwitansi or statement. */
function paymentLines(
  items: { invoice_type: string; paid_at: Date | null; issue_date: Date; received: number }[],
) {
  return items.map((p) => ({
    label: `${PAYMENT_RECEIVED_LABEL[p.invoice_type] ?? "Pembayaran diterima"} tanggal ${fmtLongWibDate(p.paid_at ?? p.issue_date)}`,
    amount: p.received,
  }));
}

/**
 * One service day as a PDF line item (invoice, kwitansi, statement). A
 * cancelled day is not in the order total, so it is printed as
 * "(Dibatalkan)" at Rp 0 and the lines add up to the printed total (B7).
 */
function serviceItemToLineItem(item: {
  service_date: Date | null;
  description: string | null;
  service_kind: string | null;
  service_package: string | null;
  pickup_location: string;
  dropoff_location: string;
  quantity: number;
  unit_price: unknown;
  total_price: unknown;
  line_status: string;
}) {
  const cancelled = item.line_status === "CANCELLED";
  return {
    serviceDate: item.service_date,
    description: cancelled
      ? [item.description?.trim(), "(Dibatalkan)"].filter(Boolean).join(" ")
      : item.description,
    serviceKind: item.service_kind,
    servicePackage: item.service_package,
    pickupLocation: item.pickup_location,
    dropoffLocation: item.dropoff_location,
    quantity: item.quantity,
    unitPrice: cancelled ? 0 : Number(item.unit_price),
    totalPrice: cancelled ? 0 : Number(item.total_price),
  };
}

/**
 * The audit-log value cancelOrder writes; tierLabelOf reads the tier back
 * for the documents printed later (the order keeps only the fee).
 */
export const cancellationLogValue = (penalty: number, tierLabel: string) =>
  `CANCELLED (cancellation fee ${penalty} — ${tierLabel})`;
const CANCELLATION_LOG = /^CANCELLED \(cancellation fee [\d.]+ — (.+)\)$/;

async function tierLabelOf(orderId: string): Promise<string | null> {
  const log = await prisma.orderChangeLog.findFirst({
    where: { order_id: orderId, field: "order_status", new_value: { startsWith: "CANCELLED (cancellation fee" } },
    orderBy: { created_at: "desc" },
    select: { new_value: true },
  });
  return log?.new_value?.match(CANCELLATION_LOG)?.[1] ?? null;
}

type DocumentOrder = {
  id: string;
  cancellation_fee: unknown;
  service_items: Parameters<typeof serviceItemToLineItem>[0][];
};

/**
 * A document only about the cancellation fee: the CANCELLATION_FEE invoice
 * and its kwitansi, or anything for an order whose days are all cancelled.
 * It prints no package notes (what the price includes is not what it bills).
 */
const isFeeOnly = (order: DocumentOrder, invoiceType?: string) =>
  invoiceType === "CANCELLATION_FEE" ||
  (order.cancellation_fee != null && order.service_items.every((i) => i.line_status === "CANCELLED"));

/**
 * The day lines of a document (invoice, kwitansi, statement). On a cancelled
 * order (cancellation_fee set, the order total) a "Biaya Pembatalan" line
 * holds what the days and the other lines printed (`otherLines`) do not, so
 * the lines add up to the printed total (B7). A CANCELLATION_FEE document
 * lists only the fee, like the invoice cancelOrder issued.
 */
async function rentalDocumentItems(
  order: DocumentOrder,
  invoiceType?: string,
  otherLines = 0,
): Promise<InvoiceLineItem[]> {
  const fee = order.cancellation_fee == null ? null : Number(order.cancellation_fee);
  const days = invoiceType === "CANCELLATION_FEE" ? [] : order.service_items.map(serviceItemToLineItem);
  if (fee == null) return days;
  const listed = days.reduce((s, d) => s + d.totalPrice, 0) + otherLines;
  const amount = fee - listed;
  if (amount <= 0) return days;
  const tier = await tierLabelOf(order.id);
  return [
    ...days,
    {
      description: tier ? `Biaya Pembatalan — ${tier}` : "Biaya Pembatalan",
      quantity: 1,
      unitPrice: amount,
      totalPrice: amount,
    },
  ];
}

// Turn a billable adjustment into a PDF line item, appending the date to the
// description (e.g. "overtime 2 jam - Senin, 22 Juni 2026").
function adjustmentToLineItem(a: {
  description: string;
  amount: unknown;
  quantity?: number | null;
  created_at?: Date | string | null;
}) {
  const dateStr = fmtAdjustmentDate(a.created_at);
  return {
    description: dateStr ? `${a.description} - ${dateStr}` : a.description,
    quantity: a.quantity ?? 1,
    unitPrice: Number(a.amount),
    totalPrice: Number(a.amount) * (a.quantity ?? 1),
  };
}

// Build the descriptive note lines shown under the table (pickup / dropoff /
// what's included), mirroring the official invoice/kuitansi templates. What
// is included follows the package of the order's days (packageNoteLines).
function buildNoteLines(order: {
  pickup_location?: string | null;
  dropoff_location?: string | null;
  service_items: { service_package?: string | null; line_status?: string | null }[];
}): string[] {
  const lines: string[] = [];
  if (order.pickup_location) lines.push(`Jemput : ${order.pickup_location}`);
  if (order.dropoff_location)
    lines.push(`Tujuan : pemakaian area ${order.dropoff_location}`);
  lines.push(...packageNoteLines(order.service_items));
  return lines;
}

/**
 * Prepare a CANCELLATION_FEE invoice for a cancelled order: reserve the invoice
 * number (atomic, short tx) and render the PDF. Returns everything the caller
 * needs to create the invoice row inside its own transaction. Network/PDF work
 * is done HERE (outside the caller's main tx) so the DB transaction stays short
 * — mirrors the generateInvoice pattern. Does NOT mutate any state itself.
 */
export async function buildCancellationFeePdf(args: {
  customer: { id: string; code: string };
  order: {
    order_code: string | null;
    customer_name: string;
    customer_phone: string | null;
    pickup_location: string;
    dropoff_location: string;
  };
  penalty: number;
  /** Money already received on the order; the invoice asks for the rest. */
  alreadyPaid: number;
  tierLabel: string;
  reason: string;
  issueDate?: Date;
}): Promise<{
  invoiceNumber: string;
  invoiceSeq: number;
  fileUrl: string;
  issueDate: Date;
}> {
  const issueDate = args.issueDate ?? new Date();
  const { seq: invoiceSeq, number: invoiceNumber } = await prisma.$transaction(
    (tx) => nextInvoiceNumber(tx, args.customer, issueDate),
  );

  const lineItem = {
    description: `Biaya Pembatalan — ${args.tierLabel}`,
    quantity: 1,
    unitPrice: args.penalty,
    totalPrice: args.penalty,
  };

  const alreadyPaid = Math.min(Math.max(args.alreadyPaid, 0), args.penalty);
  const pdfBuffer = await generateInvoicePDF({
    invoiceNumber,
    displayNumber: args.order.order_code ?? null,
    issueDate,
    customerName: args.order.customer_name,
    customerPhone: args.order.customer_phone ?? null,
    pickupLocation: args.order.pickup_location,
    dropoffLocation: args.order.dropoff_location,
    finalPrice: args.penalty,
    // Nothing paid yet: the single-amount layout ("Total Tambahan / TOTAL").
    // Some money in: the settlement layout (total − already paid = remaining).
    invoiceType: "Cancellation Fee",
    invoiceKind: alreadyPaid > 0 ? "SETTLEMENT" : "ADDITIONAL",
    paymentMethod: "Bank Transfer",
    amountPaid: args.penalty - alreadyPaid,
    previouslyPaid: alreadyPaid,
    documentMode: "INVOICE",
    noteLines: [
      `Pembatalan pesanan: ${args.reason}`,
      args.tierLabel,
    ],
    items: [lineItem],
  });

  const fileName = `${invoiceNumber}.pdf`;
  const fileUrl = await uploadInvoicePDF(pdfBuffer, fileName);
  return { invoiceNumber, invoiceSeq, fileUrl, issueDate };
}

/**
 * A DP must be at least 20% of the rental base (minimum down payment) and at
 * most the rental base. Customer may pay more than 20%, but never less. Same
 * rule when the DP is created and when it is revised.
 */
function assertDpAmount(amount: number, rentalBase: number): void {
  if (rentalBase <= 0) return;
  const minDp = minDpFor(rentalBase);
  if (amount < minDp) {
    throw new AppError(
      `DP must be at least 20% of the rental price (minimum ${minDp}). Rental base: ${rentalBase}.`,
      409,
    );
  }
  if (amount > rentalBase) {
    throw new AppError(
      `DP (${amount}) cannot exceed the rental price (${rentalBase}).`,
      409,
    );
  }
}

/** What the invoice caps are checked against: read before the PDF, and again under the order lock. */
async function invoiceCapState(
  db: Prisma.TransactionClient | typeof prisma,
  orderId: string,
  opts: { excludeInvoiceId?: string; adjustsInvoiceId?: string | null } = {},
) {
  const [m, days, activeCombined, adjusted] = await Promise.all([
    moneyState(db, orderId, { excludeInvoiceId: opts.excludeInvoiceId }),
    db.orderServiceItem.findMany({ where: { order_id: orderId }, select: { total_price: true, line_status: true } }),
    db.invoice.count({
      where: {
        order_id: orderId,
        invoice_type: "COMBINED",
        status: { notIn: ["REVISED", "CANCELLED"] },
        ...(opts.excludeInvoiceId ? { id: { not: opts.excludeInvoiceId } } : {}),
      },
    }),
    opts.adjustsInvoiceId
      ? db.invoice.findUnique({
          where: { id: opts.adjustsInvoiceId },
          select: {
            id: true,
            order_id: true,
            invoice_number: true,
            status: true,
            amount: true,
            amount_received: true,
            adjusted_by: {
              where: {
                status: { notIn: ["REVISED", "CANCELLED"] },
                ...(opts.excludeInvoiceId ? { id: { not: opts.excludeInvoiceId } } : {}),
              },
              select: { amount: true, credit_applied: true },
            },
          },
        })
      : Promise.resolve(null),
  ]);
  if (!m) throw new AppError("Order not found", 404);
  return {
    money: m,
    rentalBase: rentalBaseOf(days),
    hasActiveCombined: activeCombined > 0,
    adjusted,
  };
}
type CapState = Awaited<ReturnType<typeof invoiceCapState>>;

/**
 * The most an ADJUSTMENT invoice for `adjusted` may cover (sen): that
 * invoice's shortfall less what other active adjustments of it already bill.
 * Refused when it is not a paid, underpaid invoice of this order.
 */
function adjustmentRoom(orderId: string, adjusted: CapState["adjusted"]): number {
  if (!adjusted || adjusted.order_id !== orderId)
    throw new AppError("Invoice yang disesuaikan tidak ditemukan di order ini.", 404);
  const short =
    adjusted.status === "PAID" && adjusted.amount_received != null
      ? sen(adjusted.amount) - sen(adjusted.amount_received)
      : 0;
  if (short <= 0)
    throw new AppError(
      `Invoice ${adjusted.invoice_number} tidak kurang bayar, jadi tidak ada yang ditagih lewat invoice penyesuaian.`,
      409,
      { code: "NOT_UNDERPAID" },
    );
  const billed = adjusted.adjusted_by.reduce((s, a) => s + sen(a.amount) + sen(a.credit_applied), 0);
  return short - billed;
}

/**
 * The rules a new invoice must pass (B8: also checked under the lock).
 * Finance design §5.7: the amount is the gross, capped by Billable (T −
 * Covered − OpenBilled, INV-6); the DP rule checks the gross.
 */
function assertNewInvoiceAllowed(
  orderId: string,
  input: Pick<GenerateInvoiceInput, "invoice_type" | "amount">,
  state: CapState,
): void {
  const { money: m, rentalBase } = state;
  const gross = sen(input.amount);
  // Already paid toward the total, or billed and not paid yet.
  const alreadyBilled = m.covered + m.open;

  // Validate: FULL invoice requires no previous payments
  if (input.invoice_type === "FULL" && alreadyBilled > 0) {
    throw new AppError(
      "Cannot generate FULL invoice when partial payments already exist",
      409,
    );
  }

  // COMBINED bills rental + all billable additionals as one invoice, so like FULL
  // it must be the only/first active invoice on the order.
  if (input.invoice_type === "COMBINED" && alreadyBilled > 0) {
    throw new AppError(
      "Cannot generate a Combined invoice when other active invoices already exist",
      409,
    );
  }

  // Prevent double-billing: a separate ADDITIONAL invoice cannot coexist with an
  // active COMBINED invoice (which already includes the additionals), and vice-versa.
  if (input.invoice_type === "ADDITIONAL" && state.hasActiveCombined) {
    throw new AppError(
      "An active Combined invoice already includes additional charges. Revise it instead of adding a separate Additional invoice.",
      409,
    );
  }

  // Validate: SETTLEMENT requires a previous DP
  if (input.invoice_type === "SETTLEMENT" && alreadyBilled <= 0) {
    throw new AppError(
      "Cannot generate SETTLEMENT invoice without a prior DP payment",
      409,
    );
  }

  if (input.invoice_type === "DP") assertDpAmount(input.amount, rentalBase);

  // An ADJUSTMENT bills a shortfall again: allowed below the DP minimum (it
  // is not a DP), but never more than that invoice is still short.
  if (input.invoice_type === "ADJUSTMENT") {
    const room = adjustmentRoom(orderId, state.adjusted);
    if (gross > room) {
      throw new AppError(
        `Invoice penyesuaian (${rupiah(rp(gross))}) melebihi kekurangan ${state.adjusted!.invoice_number} yang belum ditagih (${rupiah(rp(Math.max(0, room)))}).`,
        409,
        { code: "ADJUSTMENT_EXCEEDS_SHORTFALL", shortfall_remaining: rp(Math.max(0, room)) },
      );
    }
  }

  // Guard: never bill past the order total (INV-6: Covered + Open ≤ T).
  // Extra charges should update the order final_price first, then create an invoice.
  if (gross > m.billable) {
    throw new AppError(
      `Amount (${input.amount}) exceeds remaining balance (${rp(Math.max(0, m.billable))}). Order total: ${rp(m.total)}, already paid or invoiced: ${rp(alreadyBilled)}`,
      409,
      { code: "BILLABLE_EXCEEDED", billable_remaining: rp(Math.max(0, m.billable)) },
    );
  }
}

/** Saldo lebih (sen) an invoice of `gross` uses: all it can, when asked. */
const creditToApply = (applyCredit: boolean, m: MoneyState, gross: number) =>
  applyCredit ? Math.max(0, Math.min(m.credit, gross)) : 0;

/**
 * B8: the invoice a client_ref already made on this order (a resend), or
 * null. A client_ref used on another order is refused.
 */
async function invoiceByClientRef(
  db: Prisma.TransactionClient | typeof prisma,
  clientRef: string | undefined,
  orderId: string,
): Promise<Invoice | null> {
  if (!clientRef) return null;
  const seen = await db.invoice.findUnique({ where: { client_ref: clientRef } });
  if (seen && seen.order_id !== orderId) throw new AppError("client_ref sudah dipakai untuk order lain.", 409);
  return seen;
}

/** A unique-key race on client_ref (the same resend committed first). */
const isClientRefConflict = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError &&
  err.code === "P2002" &&
  String((err.meta as { target?: unknown } | undefined)?.target ?? "").includes("client_ref");

/** The PDF printed one saldo lebih amount; the ledger moved before the save. */
const CREDIT_CHANGED =
  "Saldo lebih order ini baru saja berubah saat invoice dibuat. Muat ulang halaman lalu coba lagi.";

/**
 * An invoice saldo lebih pays in full (cash asked 0, owner decision Q12): it
 * is PAID at once with amount_received 0 and a receipt of 0, in the caller's
 * transaction (B9 lock order: the order is already locked; the receipt
 * counter is the customer row, last). Net does not move, so payment_status
 * does not either.
 */
async function settleFromCredit(
  tx: Prisma.TransactionClient,
  inv: Invoice,
  customer: { id: string; code: string },
  paidAt: Date,
): Promise<Invoice> {
  const paid = await tx.invoice.update({
    where: { id: inv.id },
    data: { status: "PAID", paid_at: paidAt, amount_received: 0 },
  });
  const { number: receiptNumber, seq: receiptSeq } = await nextReceiptNumber(tx, customer, paidAt);
  await tx.receipt.create({
    data: {
      receipt_number: receiptNumber,
      invoice_id: inv.id,
      customer_id: customer.id,
      customer_seq: receiptSeq,
      payment_date: paidAt,
      amount: 0,
      payment_method: inv.payment_method,
      note: "Dibayar dari saldo lebih",
    },
  });
  return paid;
}

/**
 * Issue an invoice. `created` is false when the client_ref was already used
 * on this order: the first invoice is returned and nothing else happens (no
 * second number, no PDF).
 *
 * input.amount is the gross (the part of the total this invoice covers). By
 * default saldo lebih is applied (APPLIED entry) and `amount` stores the cash
 * asked; an invoice the credit covers in full is created PAID (kwitansi
 * "Dibayar dari saldo lebih", no GA4).
 */
export async function generateInvoice(
  orderId: string,
  input: GenerateInvoiceInput,
): Promise<{ invoice: Invoice; created: boolean }> {
  // B8: a resend is answered before a number is reserved or a PDF is built.
  const replay = await invoiceByClientRef(prisma, input.client_ref, orderId);
  if (replay) return { invoice: replay, created: false };

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      service_items: { orderBy: { sort_order: "asc" } },
      adjustments: { orderBy: { created_at: "asc" } },
      customer: true,
    },
  });
  if (!order) throw new AppError("Order not found", 404);
  // G6: an invoice cannot be numbered without a customer (the invoice number
  // embeds the customer code + per-customer sequence).
  if (!order.customer) {
    throw new AppError(
      "Order has no linked customer; cannot issue a numbered invoice",
      409,
    );
  }
  const customer = { id: order.customer.id, code: order.customer.code };

  const isCombined = input.invoice_type === "COMBINED";
  const isAdjustment = input.invoice_type === "ADJUSTMENT";
  const capOpts = { adjustsInvoiceId: input.adjusts_invoice_id };

  // Billable additional charges (overtime/parking/etc.) — only used for COMBINED,
  // which rolls rental + extras into a single invoice (and a single Kwitansi).
  const billableAdjustments = order.adjustments.filter((a) => a.is_billable);
  const additionalsTotal = billableAdjustments.reduce(
    (sum, a) => sum + Number(a.amount) * (a.quantity ?? 1),
    0,
  );

  // The caps (the DP rule's rental base = the days that are not cancelled;
  // additionals are billed separately), checked here so a refused invoice
  // burns no number, and again under the order lock below (B8).
  const capState = await invoiceCapState(prisma, orderId, capOpts);
  assertNewInvoiceAllowed(orderId, input, capState);
  const finalPrice = rp(capState.money.total);
  const gross = sen(input.amount);
  // The PDF prints the credit used; the transaction refuses if it changed.
  const plannedCredit = creditToApply(input.apply_credit, capState.money, gross);

  // Reserve the invoice number atomically (per-customer invoice_seq) in a short
  // transaction BEFORE building the PDF, so the pooler never times out and two
  // concurrent invoices for the same customer cannot collide.
  const issueDate = input.issue_date ? new Date(input.issue_date) : new Date();
  const { seq: invoiceSeq, number: invoiceNumber } = await prisma.$transaction(
    (tx) => nextInvoiceNumber(tx, customer, issueDate),
  );

  // Settlement (remaining rental balance) is due on the first day of service
  // that will run: a cancelled day is skipped (all of them only when every
  // day is cancelled).
  let dueDate: Date | null = null;
  if (input.invoice_type === "SETTLEMENT") {
    const earliest = (items: typeof order.service_items) =>
      items
        .map((i) => i.service_date)
        .filter((d): d is Date => !!d)
        .sort((a, b) => a.getTime() - b.getTime())[0];
    const firstServiceDate =
      earliest(order.service_items.filter((i) => i.line_status !== "CANCELLED")) ??
      earliest(order.service_items);
    dueDate =
      firstServiceDate || order.service_start_at || order.order_date || null;
  }

  // For COMBINED, render the billable adjustments as an "Additional Charges"
  // section in the same PDF as the rental service lines.
  const additionalItems = isCombined
    ? billableAdjustments.map(adjustmentToLineItem)
    : undefined;

  // The PDF line items depend on the invoice type:
  //  - ADDITIONAL bills ONLY the billable adjustments (no rental day lines).
  //  - ADJUSTMENT bills one line: the shortfall of the invoice it adjusts.
  //  - everything else (DP / SETTLEMENT / FULL / COMBINED) lists the rental
  //    service days; COMBINED also appends additionalItems above.
  const adjustedNumber = capState.adjusted?.invoice_number ?? "";
  const pdfItems: InvoiceLineItem[] =
    input.invoice_type === "ADDITIONAL"
      ? billableAdjustments.map(adjustmentToLineItem)
      : isAdjustment
        ? [adjustmentLineItem(adjustedNumber, input.amount)]
        : await rentalDocumentItems(order, input.invoice_type, isCombined ? additionalsTotal : 0);

  const pdfBuffer = await generateInvoicePDF({
    invoiceNumber,
    displayNumber: order.order_code ?? null,
    issueDate,
    customerName: order.customer_name,
    customerPhone: order.customer_phone ?? null,
    pickupLocation: order.pickup_location,
    dropoffLocation: order.dropoff_location,
    finalPrice,
    invoiceType: isAdjustment
      ? adjustmentTitle(adjustedNumber)
      : (INVOICE_TYPE_LABEL[input.invoice_type] ?? input.invoice_type),
    paymentMethod: PAYMENT_METHOD_LABEL[input.payment_method] ?? input.payment_method,
    amountPaid: input.amount,
    // Already paid toward the total or billed (Covered + Open).
    previouslyPaid: rp(capState.money.covered + capState.money.open),
    creditApplied: rp(plannedCredit),
    documentMode: "INVOICE",
    // An adjustment uses the single-amount layout ("Total Tambahan").
    invoiceKind: isAdjustment ? "ADDITIONAL" : input.invoice_type,
    dueDate,
    noteLines: isAdjustment || isFeeOnly(order) ? undefined : buildNoteLines(order),
    items: pdfItems,
    additionalItems,
  });

  const fileName = `${invoiceNumber}.pdf`;
  const fileUrl = await uploadInvoicePDF(pdfBuffer, fileName);
  // Not recorded (refused under the lock, or a resend got there first): the
  // PDF (customer name, amounts) must not stay behind in the public bucket.
  const dropPdf = () => void removeFile(env.SUPABASE_STORAGE_BUCKET, `invoices/${fileName}`);

  // An invoice saldo lebih pays in full is paid now, also when its issue_date
  // is back-dated: its kwitansi then counts every payment made so far.
  const paidFromCreditAt = new Date();
  let result: { invoice: Invoice; created: boolean; fromCredit: boolean };
  try {
    result = await prisma.$transaction(
      async (tx) => {
        // B9 lock order (order-money.ts): the order row first, so two invoices
        // of one order (or a resend) are decided one after the other.
        await lockOrder(tx, orderId);
        const seen = await invoiceByClientRef(tx, input.client_ref, orderId);
        if (seen) return { invoice: seen, created: false, fromCredit: false };
        // B8: the caps again, on what is committed now.
        const fresh = await invoiceCapState(tx, orderId, capOpts);
        assertNewInvoiceAllowed(orderId, input, fresh);
        const credit = creditToApply(input.apply_credit, fresh.money, gross);
        if (credit !== plannedCredit) throw new AppError(CREDIT_CHANGED, 409, { code: "CREDIT_CHANGED" });
        const cash = gross - credit;

        const newInvoice = await tx.invoice.create({
          data: {
            order_id: orderId,
            invoice_number: invoiceNumber,
            customer_seq: invoiceSeq,
            invoice_type: input.invoice_type,
            payment_method: input.payment_method,
            issue_date: issueDate,
            amount: rp(cash),
            credit_applied: rp(credit),
            adjusts_invoice_id: input.adjusts_invoice_id ?? null,
            note: input.note,
            file_url: fileUrl,
            status: "ISSUED",
            due_date: dueDate,
            client_ref: input.client_ref ?? null,
          },
        });
        await addCreditEntry(tx, {
          orderId,
          kind: "APPLIED",
          amount: -rp(credit),
          invoiceId: newInvoice.id,
          note: `Dipotong dari saldo lebih untuk ${invoiceNumber}`,
          actor: "ADMIN",
        });

        // Keep the customer's billed total in sync (G9: total_billed = sum of
        // the active invoices' cash asked).
        await tx.customer.update({
          where: { id: customer.id },
          data: { total_billed: { increment: rp(cash) } },
        });

        // NOTE: issuing an invoice does NOT change payment_status.
        // payment_status only advances when an invoice is marked PAID (see
        // markInvoicePaid); an invoice paid from saldo lebih moves no money.
        if (cash === 0) {
          const paid = await settleFromCredit(tx, newInvoice, customer, paidFromCreditAt);
          return { invoice: paid, created: true, fromCredit: true };
        }
        return { invoice: newInvoice, created: true, fromCredit: false };
      },
      { maxWait: 15000, timeout: 20000 },
    );
  } catch (err) {
    dropPdf();
    if (isClientRefConflict(err)) {
      const seen = await invoiceByClientRef(prisma, input.client_ref, orderId);
      if (seen) return { invoice: seen, created: false };
    }
    throw err;
  }
  if (!result.created) dropPdf();
  if (result.fromCredit) {
    // The kwitansi "Dibayar dari saldo lebih". No GA4: no money came in.
    try {
      await attachReceiptPdf(result.invoice.id, {
        paidAt: paidFromCreditAt,
        paymentMethod: input.payment_method,
        amountReceived: 0,
      });
    } catch (err) {
      console.error("Receipt PDF generation failed:", err);
    }
    result.invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: result.invoice.id } });
  }
  return { invoice: result.invoice, created: result.created };
}

/** The one line of an ADJUSTMENT invoice and its kwitansi. */
function adjustmentLineItem(adjustedNumber: string, amount: number): InvoiceLineItem {
  return {
    // The PDF prints no document title, so the line says what this invoice is.
    description: adjustmentTitle(adjustedNumber),
    quantity: 1,
    unitPrice: amount,
    totalPrice: amount,
  };
}
const adjustmentTitle = (adjustedNumber: string) =>
  `Invoice Penyesuaian — kekurangan pembayaran ${adjustedNumber}`.trim();

export async function getInvoicesByOrder(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new AppError("Order not found", 404);

  const rows = await prisma.invoice.findMany({
    where: { order_id: orderId },
    orderBy: { created_at: "desc" },
  });
  return rows.map(invoiceView);
}

// Sprint 3: return a short-lived signed URL for an invoice's payment proof.
export async function getPaymentProofUrl(invoiceId: string) {
  const receipt = await prisma.receipt.findFirst({
    where: { invoice_id: invoiceId },
    orderBy: { created_at: "desc" },
  });
  if (!receipt || !receipt.payment_proof_url) {
    throw new AppError("No payment proof on file for this invoice", 404);
  }
  const url = await getSignedUrl(
    PAYMENT_PROOFS_BUCKET,
    receipt.payment_proof_url,
    60 * 60,
  );
  return { url, expires_in: 3600 };
}

/** What a payment did, returned with mark-paid (finance design §5.9). */
function paymentOf(inv: { amount: unknown; amount_received?: unknown }) {
  const asked = sen(inv.amount);
  const received = inv.amount_received != null ? sen(inv.amount_received) : asked;
  return {
    received: rp(received),
    shortfall: rp(Math.max(0, asked - received)),
    overpayment: rp(Math.max(0, received - asked)),
    // An overpayment becomes saldo lebih (OVERPAYMENT entry).
    credit_added: rp(Math.max(0, received - asked)),
  };
}

const STATUS_LABEL: Record<string, string> = {
  UNPAID: "Belum bayar",
  DP_PAID: "DP terbayar",
  PAID: "Lunas",
};

/**
 * Owner decision (7 Oct 2026, finance design §3.4): money received that
 * differs from the invoice amount is recorded only with an explicit
 * acknowledgement. Without it: 409 with both numbers and what would happen,
 * and nothing is recorded (also no proof uploaded).
 */
async function assertAmountAcknowledged(
  invoice: { order_id: string; invoice_number: string; amount: unknown },
  received: number,
  ack: boolean,
): Promise<void> {
  const asked = sen(invoice.amount);
  const got = sen(received);
  if (got === asked || ack) return;
  const [m, days] = await Promise.all([
    moneyState(prisma, invoice.order_id),
    prisma.orderServiceItem.findMany({ where: { order_id: invoice.order_id }, select: { total_price: true, line_status: true } }),
  ]);
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: invoice.order_id },
    select: { cancellation_fee: true },
  });
  const netAfter = rp((m?.net ?? 0) + got);
  const statusAfter = paymentStatusFor(netAfter, rp(m?.total ?? 0), dpBaseOf(order, days));
  const short = Math.max(0, asked - got);
  const over = Math.max(0, got - asked);
  const effect = short
    ? `kurang ${rupiah(rp(short))}: invoice tetap ditandai terbayar, kekurangannya bisa ditagih lewat Invoice Penyesuaian`
    : `lebih ${rupiah(rp(over))}: kelebihannya masuk saldo lebih order ini`;
  throw new AppError(
    `Uang diterima ${rupiah(received)} berbeda dari nilai invoice ${invoice.invoice_number} ${rupiah(rp(asked))} (${effect}; status order menjadi ${STATUS_LABEL[statusAfter] ?? statusAfter}). Bila jumlahnya benar, centang konfirmasi selisih lalu simpan lagi.`,
    409,
    {
      code: "AMOUNT_MISMATCH",
      invoice_amount: rp(asked),
      amount_received: rp(got),
      shortfall: rp(short),
      overpayment: rp(over),
      payment_status_after: statusAfter,
    },
  );
}

// Mark an invoice paid: money received, kwitansi (receipt PDF), order payment status.
export async function markInvoicePaid(
  invoiceId: string,
  input: {
    payment_method?: string;
    paid_at?: string;
    amount_received?: number;
    amount_mismatch_ack?: boolean;
    proof?: UploadedFile;
  } = {},
) {
  // Sprint 3: a payment proof is REQUIRED to mark an invoice paid (cash too:
  // upload a photo taken when the money was received). Validate early.
  const proofFile = assertValidUpload(input.proof);
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      order: { include: { customer: true } },
    },
  });
  if (!invoice) throw new AppError("Invoice not found", 404);
  const respond = async (inv: Invoice) => ({
    ...invoiceView(inv),
    payment: paymentOf(inv),
    order_money: await computeOrderMoney(prisma, inv.order_id),
  });
  // Already paid: return the plain invoice row (the loaded order/customer
  // carries personal data such as the NIK and must not reach the client).
  if (invoice.status === "PAID") {
    const { order: _order, ...plain } = invoice;
    return respond(plain);
  }
  if (["REVISED", "CANCELLED"].includes(invoice.status)) {
    throw new AppError(
      `Cannot mark a ${invoice.status} invoice as paid`,
      409,
    );
  }

  const paidAt = input.paid_at ? new Date(input.paid_at) : new Date();
  const paymentMethod = (input.payment_method ||
    invoice.payment_method) as string;
  // The ACTUAL money received. Defaults to the invoice amount; a different
  // amount needs amount_mismatch_ack (an invoice's amount never changes: a
  // revision is a new invoice, so this check needs no lock).
  const amountReceived =
    input.amount_received != null ? Number(input.amount_received) : Number(invoice.amount);
  await assertAmountAcknowledged(invoice, amountReceived, input.amount_mismatch_ack === true);
  const customer = invoice.order.customer;

  // Upload the payment proof to the private bucket (signed URLs are minted on
  // read). Store only the storage path on the receipt.
  const proofUpload = await uploadFile(proofFile, {
    bucket: PAYMENT_PROOFS_BUCKET,
    prefix: `invoice/${invoice.id}`,
    public: false,
  });

  // One payment per invoice, also on a double click or two admins at once:
  // the invoice turns PAID only if it is not already, and only that request
  // reserves the kwitansi number, writes the receipt and adds to the totals
  // (the other one burns no number and records nothing). B9 lock order
  // (order-money.ts): the order row first, then the invoice, as cancelOrder,
  // generateInvoice and reviseInvoice, so they cannot deadlock; the order lock
  // also makes two invoices paid at once add up.
  let applied: { becameReady: boolean } | null;
  try {
    applied = await prisma.$transaction(
      async (tx) => {
        const [locked] = await tx.$queryRaw<
          {
            final_price: unknown;
            paid_to_date: unknown;
            refunded_total: unknown;
            cancellation_fee: unknown;
          }[]
        >`SELECT final_price, paid_to_date, refunded_total, cancellation_fee
          FROM "orders" WHERE id = ${invoice.order_id} FOR NO KEY UPDATE`;
        const { count } = await tx.invoice.updateMany({
          where: { id: invoiceId, status: { notIn: ["PAID", "REVISED", "CANCELLED"] } },
          data: {
            status: "PAID",
            paid_at: paidAt,
            // The money actually taken (also on the receipt below).
            amount_received: amountReceived,
            ...(input.payment_method
              ? { payment_method: input.payment_method as never }
              : {}),
          },
        });
        if (count === 0) return null;
        // More money than the invoice asked: the difference is saldo lebih
        // (one OVERPAYMENT per invoice, unique index). Less: the invoice stays
        // PAID and the shortfall is billable again (Billable is on Covered).
        const over = sen(amountReceived) - sen(invoice.amount);
        if (over > 0) {
          await addCreditEntry(tx, {
            orderId: invoice.order_id,
            kind: "OVERPAYMENT",
            amount: rp(over),
            invoiceId: invoice.id,
            note: `Lebih bayar ${invoice.invoice_number}`,
            actor: "ADMIN",
          });
        }

        if (customer) {
          const { number: receiptNumber, seq: receiptSeq } = await nextReceiptNumber(
            tx,
            { id: customer.id, code: customer.code },
            paidAt,
          );
          await tx.receipt.create({
            data: {
              receipt_number: receiptNumber,
              invoice_id: invoice.id,
              customer_id: customer.id,
              customer_seq: receiptSeq,
              payment_date: paidAt,
              // ACTUAL money received (may differ from the invoice amount).
              amount: amountReceived,
              payment_method: paymentMethod as never,
              // Private storage path; resolved to a signed URL on read.
              payment_proof_url: proofUpload.path,
            },
          });
          // total_paid = sum of receipts (cash actually collected, G9).
          await tx.customer.update({
            where: { id: customer.id },
            data: { total_paid: { increment: amountReceived } },
          });
        }

        // paid_to_date = all money received on the order, this payment included.
        const others = await paymentsOnOrder(tx, invoice.order_id, invoice.id);
        const paidTotal = others.total + amountReceived;
        const days = await tx.orderServiceItem.findMany({
          where: { order_id: invoice.order_id },
          select: { total_price: true, line_status: true },
        });
        await tx.order.update({
          where: { id: invoice.order_id },
          data: {
            // Net (received − refunded) against the total and the DP base:
            // less than the 20% DP stays UNPAID (B2).
            payment_status: paymentStatusFor(
              netPaid({ ...locked, paid_to_date: paidTotal }),
              locked.final_price,
              dpBaseOf(locked, days),
            ),
            paid_to_date: paidTotal,
          },
        });
        // INV-5: a payment on an order whose total meanwhile fell below what
        // money covers (a cancellation) puts the excess in saldo lebih.
        await settleCredit(tx, invoice.order_id);
        // Did this payment make the rental paid in full (Net)? Decided under
        // the lock, so two invoices paid at once notify the drivers only once.
        const becameReady =
          !startPayment(locked, days).ready &&
          startPayment({ ...locked, paid_to_date: paidTotal }, days).ready;
        return { becameReady };
      },
      { maxWait: 15000, timeout: 20000 },
    );
  } catch (err) {
    // Nothing was recorded: the proof must not stay behind in the bucket.
    void removeFile(PAYMENT_PROOFS_BUCKET, proofUpload.path);
    throw err;
  }

  if (!applied) {
    // Another request recorded this payment first: drop our copy of the proof
    // and answer with the invoice as it is now.
    void removeFile(PAYMENT_PROOFS_BUCKET, proofUpload.path);
    const current = await prisma.invoice.findUnique({ where: { id: invoiceId } });
    if (current?.status === "PAID") return respond(current);
    throw new AppError(`Cannot mark a ${current?.status ?? "missing"} invoice as paid`, 409);
  }

  // The kwitansi PDF, built from what is now committed (so a payment recorded
  // at the same moment is on it too). If it fails the invoice stays paid.
  try {
    await attachReceiptPdf(invoiceId, { paidAt, paymentMethod, amountReceived });
  } catch (err) {
    console.error("Receipt PDF generation failed:", err);
  }

  // Website lead → GA4 "purchase" (first payment only; never blocks the admin).
  // Never from a cancellation fee or an adjustment (B12).
  if (!sendsNoPurchase(invoice.invoice_type))
    reportLeadPurchase(invoice.order_id).catch((err) =>
      console.error("GA4 purchase report failed:", err),
    );
  // Paid in full just now: the assigned drivers may begin the trip with the
  // customer (app unlocks "Mulai perjalanan") and get a notification.
  if (applied.becameReady) void notifyOrderPaidInFull(invoice.order_id);

  return respond(await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } }));
}

/** "Pengembalian dana" lines for a kwitansi or statement (shown as money going back). */
function refundLines(refunds: { amount: unknown; refunded_at: Date }[]) {
  return refunds.map((r) => ({
    label: `Pengembalian dana tanggal ${fmtLongWibDate(r.refunded_at)}`,
    amount: Number(r.amount),
  }));
}

/**
 * Regenerate the invoice as a Kwitansi/Receipt (LUNAS stamp, payment date)
 * and attach it. Stored in receipt_url, NOT file_url: the original invoice PDF
 * is kept so the order keeps BOTH documents paired.
 *
 * Finance design §8: the money actually received; the saldo lebih used
 * ("Dipotong dari saldo lebih", or "Dibayar dari saldo lebih" when it paid
 * the whole invoice); a shortfall ("Kekurangan … ditagih lewat invoice
 * penyesuaian") or an overpayment ("Masuk saldo lebih"); refunds; the
 * remaining balance max(0, T − Net) and the saldo lebih left.
 */
async function attachReceiptPdf(
  invoiceId: string,
  pay: { paidAt: Date; paymentMethod: string; amountReceived: number },
) {
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: {
      adjusts_invoice: { select: { invoice_number: true } },
      order: {
        include: {
          service_items: { orderBy: { sort_order: "asc" } },
          adjustments: { orderBy: { created_at: "asc" } },
          refunds: { orderBy: { refunded_at: "asc" }, select: { amount: true, refunded_at: true } },
        },
      },
    },
  });
  const order = invoice.order;
  const orderTotal = Number(order.final_price);

  // For a COMBINED invoice the kwitansi mirrors the invoice: rental lines plus
  // an Additional Charges section. An ADDITIONAL receipt lists ONLY the
  // additional charges; an ADJUSTMENT its one shortfall line; every other
  // type lists the rental service days.
  const billable = order.adjustments.filter((a) => a.is_billable);
  const additionalItems =
    invoice.invoice_type === "COMBINED" ? billable.map(adjustmentToLineItem) : undefined;
  const adjustedNumber = invoice.adjusts_invoice?.invoice_number ?? "";
  const items =
    invoice.invoice_type === "ADDITIONAL"
      ? billable.map(adjustmentToLineItem)
      : invoice.invoice_type === "ADJUSTMENT"
        ? [adjustmentLineItem(adjustedNumber, grossOf(invoice))]
        : await rentalDocumentItems(
            order,
            invoice.invoice_type,
            (additionalItems ?? []).reduce((s, a) => s + a.totalPrice, 0),
          );

  // Sum of the other active invoices, for the receipt summary.
  const priorAgg = await prisma.invoice.aggregate({
    where: {
      order_id: invoice.order_id,
      id: { not: invoice.id },
      status: { notIn: ["REVISED", "CANCELLED"] },
    },
    _sum: { amount: true },
  });
  const previouslyPaid = Number(priorAgg._sum.amount ?? 0);

  // "Payments received" lines: the payments made up to this one (a later one,
  // recorded before this PDF was built, belongs on its own kwitansi), then this.
  // Invoices paid from saldo lebih moved no money and get no payment line.
  const all = await paymentsOnOrder(prisma, invoice.order_id, invoice.id);
  const earlier = all.items.filter((p) => !p.paid_at || p.paid_at.getTime() <= pay.paidAt.getTime());
  const others = { items: earlier, total: earlier.reduce((s, p) => s + p.received, 0) };
  const paymentsReceived = paymentLines(
    [
      ...others.items,
      { invoice_type: invoice.invoice_type, paid_at: pay.paidAt, issue_date: invoice.issue_date, received: pay.amountReceived },
    ].filter((p) => p.received !== 0),
  );
  const totalReceived = others.total + pay.amountReceived;
  // Refunds made so far, so the balance is on Net like the order card.
  const refunds = order.refunds;
  const refunded = refunds.reduce((s, r) => s + Number(r.amount), 0);

  // This invoice's own lines.
  const receiptLines: { label: string; amount?: number }[] = [];
  const creditUsed = Number(invoice.credit_applied ?? 0);
  if (creditUsed > 0) {
    receiptLines.push({
      label: Number(invoice.amount) === 0 ? "Dibayar dari saldo lebih" : "Dipotong dari saldo lebih",
      amount: -creditUsed,
    });
  }
  const short = sen(invoice.amount) - sen(pay.amountReceived);
  if (short > 0) {
    receiptLines.push({
      label: `Kekurangan ${rupiah(rp(short))} (ditagih lewat invoice penyesuaian)`,
    });
  } else if (short < 0) {
    receiptLines.push({ label: "Masuk saldo lebih", amount: rp(-short) });
  }

  const pdfBuffer = await generateInvoicePDF({
    invoiceNumber: invoice.invoice_number,
    displayNumber: order.order_code ?? null,
    issueDate: invoice.issue_date,
    customerName: order.customer_name,
    customerPhone: order.customer_phone ?? null,
    pickupLocation: order.pickup_location,
    dropoffLocation: order.dropoff_location,
    finalPrice: orderTotal,
    invoiceType:
      invoice.invoice_type === "ADJUSTMENT"
        ? adjustmentTitle(adjustedNumber)
        : (INVOICE_TYPE_LABEL[invoice.invoice_type] ?? invoice.invoice_type),
    paymentMethod: PAYMENT_METHOD_LABEL[pay.paymentMethod] ?? pay.paymentMethod,
    amountPaid: pay.amountReceived,
    previouslyPaid,
    documentMode: "RECEIPT",
    paidAt: pay.paidAt,
    paymentsReceived,
    refundsMade: refundLines(refunds),
    receiptLines,
    // Piutang: max(0, T − Net).
    remainingBalance: Math.max(orderTotal - (totalReceived - refunded), 0),
    creditBalance: Number(order.credit_balance ?? 0),
    noteLines:
      invoice.invoice_type === "ADJUSTMENT" || isFeeOnly(order, invoice.invoice_type)
        ? undefined
        : buildNoteLines(order),
    items,
    additionalItems,
  });
  const receiptUrl = await uploadInvoicePDF(pdfBuffer, `${invoice.invoice_number}-receipt.pdf`);
  await prisma.$transaction([
    prisma.invoice.update({ where: { id: invoiceId }, data: { receipt_url: receiptUrl } }),
    prisma.receipt.updateMany({ where: { invoice_id: invoiceId }, data: { file_url: receiptUrl } }),
  ]);
}

// Build a single combined STATEMENT PDF for the whole order: all service-day
// line items + billable adjustments + every payment received + every refund
// + running balance (LUNAS stamp when fully settled) + the saldo lebih left.
// Kept separate from per-payment invoice / kuitansi documents which remain
// individually accessible.
export async function generateOrderStatement(
  orderId: string,
  invoiceIds?: string[],
) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      service_items: { orderBy: { sort_order: "asc" } },
      adjustments: { orderBy: { created_at: "asc" } },
      invoices: { orderBy: { issue_date: "asc" } },
      refunds: { orderBy: { refunded_at: "asc" }, select: { amount: true, refunded_at: true } },
    },
  });
  if (!order) throw new AppError("Order not found", 404);

  // Optional admin selection: only include the chosen invoices in the combined
  // statement. When omitted/empty, fall back to ALL invoices (legacy behavior).
  const selectedIds = (invoiceIds ?? []).filter(Boolean);
  if (selectedIds.length > 0) {
    const known = new Set(order.invoices.map((i) => i.id));
    const unknown = selectedIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new AppError(
        `Invoice(s) not found on this order: ${unknown.join(", ")}`,
        400,
      );
    }
    const selectedSet = new Set(selectedIds);
    order.invoices = order.invoices.filter((i) => selectedSet.has(i.id));
  }

  const finalPrice = Number(order.final_price);

  // Billable additional charges (overtime/parking/etc.).
  const additionalItems = order.adjustments
    .filter((a) => a.is_billable)
    .map(adjustmentToLineItem);

  // Service-day line items (and the cancellation fee of a cancelled order).
  const items = await rentalDocumentItems(
    order,
    undefined,
    additionalItems.reduce((s, a) => s + a.totalPrice, 0),
  );

  // Every payment actually received on the chosen invoices (the money on the
  // receipt, also for an invoice voided later by a cancellation). Invoices
  // paid from saldo lebih moved no money and get no line.
  const chosen = new Set(order.invoices.map((i) => i.id));
  const paymentsReceived = paymentLines(
    (await paymentsOnOrder(prisma, order.id)).items.filter((p) => chosen.has(p.id) && p.received !== 0),
  );
  const totalReceived = paymentsReceived.reduce((s, p) => s + p.amount, 0);
  // Refunds are order-level money going back: always listed.
  const refundsMade = refundLines(order.refunds);
  const totalRefunded = refundsMade.reduce((s, r) => s + r.amount, 0);
  const remainingBalance = Math.max(finalPrice - (totalReceived - totalRefunded), 0);
  const fullyPaid = remainingBalance <= 0 && finalPrice > 0;
  const creditBalance = Number(order.credit_balance ?? 0);

  const invoiceNumber = `${order.order_code ?? order.id}-STATEMENT`;
  const pdfBuffer = await generateInvoicePDF({
    invoiceNumber,
    displayNumber: order.order_code ?? null,
    issueDate: new Date(),
    customerName: order.customer_name,
    customerPhone: order.customer_phone ?? null,
    pickupLocation: order.pickup_location,
    dropoffLocation: order.dropoff_location,
    finalPrice,
    invoiceType: "Statement",
    paymentMethod: "-",
    amountPaid: totalReceived,
    previouslyPaid: 0,
    documentMode: "STATEMENT",
    paymentsReceived,
    refundsMade,
    remainingBalance,
    creditBalance,
    showPaidStamp: fullyPaid,
    noteLines: isFeeOnly(order) ? undefined : buildNoteLines(order),
    items,
    additionalItems: additionalItems.length ? additionalItems : undefined,
  });

  const fileUrl = await uploadInvoicePDF(
    pdfBuffer,
    `${invoiceNumber}.pdf`,
  );
  return {
    order_id: order.id,
    order_code: order.order_code,
    statement_url: fileUrl,
    final_price: finalPrice,
    total_received: totalReceived,
    total_refunded: totalRefunded,
    remaining_balance: remainingBalance,
    credit_balance: creditBalance,
    fully_paid: fullyPaid,
  };
}

/** A revision of `invoice` (the same revision chain). */
const isRevisionOf = (
  rev: { parent_id: string | null },
  invoice: { id: string; parent_id: string | null },
) => rev.parent_id === (invoice.parent_id || invoice.id);

/**
 * Revise an unpaid invoice. `created` is false when the client_ref already
 * made this revision: it is returned and nothing else happens (B8).
 *
 * input.amount is the new gross, as on generate. The old invoice's saldo
 * lebih comes back (UNAPPLIED) and the revision applies it again by default
 * (APPLIED); a revision the credit covers in full is PAID at once.
 */
export async function reviseInvoice(
  invoiceId: string,
  input: ReviseInvoiceInput,
): Promise<{ invoice: Invoice; created: boolean }> {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      adjusts_invoice: { select: { invoice_number: true } },
      order: {
        include: {
          service_items: { orderBy: { sort_order: "asc" } },
          adjustments: { orderBy: { created_at: "asc" } },
          customer: { select: { id: true, code: true } },
        },
      },
    },
  });
  if (!invoice) throw new AppError("Invoice not found", 404);
  // B8: a resend (the invoice is REVISED by now) gets the revision it made.
  const replayOf = async (db: Prisma.TransactionClient | typeof prisma) => {
    const seen = await invoiceByClientRef(db, input.client_ref, invoice.order_id);
    if (seen && !isRevisionOf(seen, invoice)) throw new AppError("client_ref sudah dipakai untuk invoice lain.", 409);
    return seen;
  };
  const replay = await replayOf(prisma);
  if (replay) return { invoice: replay, created: false };
  if (invoice.status === "PAID")
    throw new AppError(
      "Paid invoice cannot be revised. Update order price and create a revision before marking invoice paid.",
      409,
    );
  if (invoice.status === "CANCELLED")
    throw new AppError("Cancelled invoice cannot be revised", 409);
  if (invoice.status === "REVISED")
    throw new AppError("Invoice is already revised", 409);

  const invoiceNumber = `${invoice.invoice_number}-R${invoice.revision + 1}`;
  const issueDate = new Date();
  const paymentMethod = input.payment_method || invoice.payment_method;
  const amount = input.amount;
  const gross = sen(amount);
  const oldCredit = sen(invoice.credit_applied);
  // `amount` is the gross. An older dashboard sends the cash it shows (the
  // stored amount), which on an invoice that used saldo lebih is the gross
  // minus that credit: the revision would ask the credit off twice. Such an
  // invoice is revised only by a client that says apply_credit explicitly.
  if (oldCredit > 0 && input.apply_credit === undefined) {
    throw new AppError(
      `Invoice ${invoice.invoice_number} sebagian dibayar dari saldo lebih: nilai invoice ${rupiah(grossOf(invoice))}, dipotong saldo lebih ${rupiah(rp(oldCredit))}, yang ditagih ${rupiah(Number(invoice.amount))}. Versi dashboard ini belum bisa merevisinya dengan benar. Muat ulang dashboard ke versi terbaru, lalu revisi lagi.`,
      409,
      {
        code: "REVISE_NEEDS_APPLY_CREDIT",
        gross: grossOf(invoice),
        credit_applied: rp(oldCredit),
        amount: Number(invoice.amount),
      },
    );
  }
  const applyCredit = input.apply_credit ?? true;
  const isAdjustment = invoice.invoice_type === "ADJUSTMENT";
  const adjustedNumber = invoice.adjusts_invoice?.invoice_number ?? "";

  const typeLabels: Record<string, string> = {
    DP: "Down Payment Revision",
    SETTLEMENT: "Settlement Payment Revision",
    FULL: "Full Payment Revision",
    ADDITIONAL: "Additional Charge Revision",
  };

  /**
   * The caps of the revision, on the money as it would be once the old
   * invoice is set aside (its cash leaves Open, its credit comes back).
   * Returns the saldo lebih (sen) the revision would use.
   */
  const checkRevision = (state: CapState, creditBack: number) => {
    const m = state.money;
    const credit = m.credit + creditBack;
    const covered = m.covered - creditBack;
    const billable = m.total - covered - m.open;
    if (gross > billable) {
      throw new AppError(
        `Revised invoice total (${rp(covered + m.open + gross)}) exceeds order final price (${rp(m.total)}). Update order price first or reduce the invoice amount.`,
        409,
        { code: "BILLABLE_EXCEEDED", billable_remaining: rp(Math.max(0, billable)) },
      );
    }
    // B2: a revised DP keeps the 20% minimum, like a new one.
    if (invoice.invoice_type === "DP") assertDpAmount(amount, state.rentalBase);
    if (isAdjustment) {
      const room = adjustmentRoom(invoice.order_id, state.adjusted);
      if (gross > room)
        throw new AppError(
          `Invoice penyesuaian (${rupiah(amount)}) melebihi kekurangan ${adjustedNumber} yang belum ditagih (${rupiah(rp(Math.max(0, room)))}).`,
          409,
          { code: "ADJUSTMENT_EXCEEDS_SHORTFALL", shortfall_remaining: rp(Math.max(0, room)) },
        );
    }
    return applyCredit ? Math.max(0, Math.min(credit, gross)) : 0;
  };
  const capOpts = { excludeInvoiceId: invoice.id, adjustsInvoiceId: invoice.adjusts_invoice_id };
  const before = await invoiceCapState(prisma, invoice.order_id, capOpts);
  const plannedCredit = checkRevision(before, oldCredit);
  const finalPrice = rp(before.money.total);

  // Mirror the original invoice's line items: an ADDITIONAL revision lists ONLY
  // the additional charges; an ADJUSTMENT its shortfall line; COMBINED lists
  // rental + an Additional Charges section; the rest list the rental service days.
  const reviseBillableAdjustments = invoice.order.adjustments.filter(
    (a) => a.is_billable,
  );
  const reviseAdjustmentItems = reviseBillableAdjustments.map(
    adjustmentToLineItem,
  );
  const reviseAdditionalItems =
    invoice.invoice_type === "COMBINED" ? reviseAdjustmentItems : undefined;
  const reviseItems =
    invoice.invoice_type === "ADDITIONAL"
      ? reviseAdjustmentItems
      : isAdjustment
        ? [adjustmentLineItem(adjustedNumber, amount)]
        : await rentalDocumentItems(
            invoice.order,
            invoice.invoice_type,
            (reviseAdditionalItems ?? []).reduce((s, a) => s + a.totalPrice, 0),
          );

  const pdfBuffer = await generateInvoicePDF({
    invoiceNumber,
    issueDate,
    customerName: invoice.order.customer_name,
    pickupLocation: invoice.order.pickup_location,
    dropoffLocation: invoice.order.dropoff_location,
    finalPrice,
    invoiceType: isAdjustment
      ? `${adjustmentTitle(adjustedNumber)} (revisi)`
      : (typeLabels[invoice.invoice_type] ?? `${invoice.invoice_type} Revision`),
    paymentMethod: PAYMENT_METHOD_LABEL[paymentMethod] ?? paymentMethod,
    amountPaid: amount,
    // Already paid toward the total or billed elsewhere (Covered + Open,
    // without this invoice and its credit).
    previouslyPaid: rp(before.money.covered - oldCredit + before.money.open),
    creditApplied: rp(plannedCredit),
    invoiceKind: isAdjustment ? "ADDITIONAL" : invoice.invoice_type,
    // Same notes as the original; a cancellation fee keeps none (its own
    // notes, the reason and tier, are not stored).
    noteLines:
      isAdjustment || isFeeOnly(invoice.order, invoice.invoice_type) ? undefined : buildNoteLines(invoice.order),
    items: reviseItems,
    additionalItems: reviseAdditionalItems,
  });

  // Unique per attempt: two revisions at once must not overwrite each other's
  // PDF (only one of them is recorded, see the conditional update below).
  const fileName = `${invoiceNumber}-${Date.now().toString(36)}.pdf`;
  const fileUrl = await uploadInvoicePDF(pdfBuffer, fileName);

  let result: { invoice: Invoice; created: boolean; fromCredit: boolean };
  try {
    result = await prisma.$transaction(async (tx) => {
      // B9 lock order (order-money.ts): the order row, then the invoice.
      await lockOrder(tx, invoice.order_id);
      const seen = await replayOf(tx);
      if (seen) return { invoice: seen, created: false, fromCredit: false };
      // Conditional: an invoice paid (or revised) by someone else since it was
      // read above is left alone (the revision would bill the customer twice).
      const { count } = await tx.invoice.updateMany({
        where: { id: invoice.id, status: { notIn: ["PAID", "REVISED", "CANCELLED"] } },
        data: { status: "REVISED" },
      });
      if (count === 0) {
        throw new AppError(
          "Invoice ini baru saja dibayar atau direvisi. Muat ulang halaman lalu coba lagi.",
          409,
        );
      }
      // The old invoice's saldo lebih comes back (UNAPPLIED).
      await addCreditEntry(tx, {
        orderId: invoice.order_id,
        kind: "UNAPPLIED",
        amount: rp(oldCredit),
        invoiceId: invoice.id,
        note: `Saldo lebih dikembalikan dari ${invoice.invoice_number} (direvisi)`,
        actor: "ADMIN",
      });
      // B8: the caps again, under the lock, on what is committed now (the old
      // invoice is REVISED and its credit back, so nothing more to set aside).
      const fresh = await invoiceCapState(tx, invoice.order_id, capOpts);
      const credit = checkRevision(fresh, 0);
      if (credit !== plannedCredit) throw new AppError(CREDIT_CHANGED, 409, { code: "CREDIT_CHANGED" });
      const cash = gross - credit;
      const revised = await tx.invoice.create({
        data: {
          order_id: invoice.order_id,
          invoice_number: invoiceNumber,
          invoice_type: invoice.invoice_type,
          payment_method: paymentMethod,
          issue_date: issueDate,
          amount: rp(cash),
          credit_applied: rp(credit),
          adjusts_invoice_id: invoice.adjusts_invoice_id,
          note: input.note || invoice.note,
          file_url: fileUrl,
          status: "ISSUED",
          revision: invoice.revision + 1,
          parent_id: invoice.parent_id || invoice.id,
          client_ref: input.client_ref ?? null,
        },
      });
      await addCreditEntry(tx, {
        orderId: invoice.order_id,
        kind: "APPLIED",
        amount: -rp(credit),
        invoiceId: revised.id,
        note: `Dipotong dari saldo lebih untuk ${invoiceNumber}`,
        actor: "ADMIN",
      });
      // payment_status is NOT recomputed here: it follows the money received
      // (markInvoicePaid), never the amount billed. Revising an unpaid invoice
      // must not mark the order paid (the owner's DP rule and GA4 rely on it).

      await tx.orderChangeLog.create({
        data: {
          order_id: invoice.order_id,
          field: "invoice_revision",
          old_value: `${invoice.invoice_number}: ${invoice.amount}`,
          new_value: `${invoiceNumber}: ${rp(cash)}`,
          note: input.note,
          actor: "ADMIN",
        },
      });
      // Keep total_billed = sum of active invoices (G9): the old amount is
      // replaced by the new one.
      if (invoice.order.customer_id) {
        const delta = rp(cash - sen(invoice.amount));
        if (delta !== 0) {
          await tx.customer.update({
            where: { id: invoice.order.customer_id },
            data: { total_billed: { increment: delta } },
          });
        }
      }
      if (cash === 0 && invoice.order.customer) {
        const paid = await settleFromCredit(tx, revised, invoice.order.customer, issueDate);
        return { invoice: paid, created: true, fromCredit: true };
      }
      return { invoice: revised, created: true, fromCredit: false };
    }, { maxWait: 15000, timeout: 20000 });
  } catch (err) {
    // Not recorded: the revision PDF (customer name, amounts) must not stay
    // behind in the public bucket.
    void removeFile(env.SUPABASE_STORAGE_BUCKET, `invoices/${fileName}`);
    if (isClientRefConflict(err)) {
      const seen = await replayOf(prisma);
      if (seen) return { invoice: seen, created: false };
    }
    throw err;
  }
  if (!result.created) void removeFile(env.SUPABASE_STORAGE_BUCKET, `invoices/${fileName}`);
  if (result.fromCredit) {
    try {
      await attachReceiptPdf(result.invoice.id, { paidAt: issueDate, paymentMethod, amountReceived: 0 });
    } catch (err) {
      console.error("Receipt PDF generation failed:", err);
    }
    result.invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: result.invoice.id } });
  }
  return { invoice: result.invoice, created: result.created };
}

function normalizePhone(phone = ""): string {
  let digits = phone.replace(/[^0-9]/g, "");
  if (digits.startsWith("0")) digits = `62${digits.slice(1)}`;
  if (digits && !digits.startsWith("62")) digits = `62${digits}`;
  return digits;
}

function formatRupiah(value: number): string {
  return new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(value);
}

function botBaseUrl(): string {
  return (
    process.env.ARASYA_WA_BOT_INTERNAL_URL ||
    process.env.WA_BOT_INTERNAL_URL ||
    "http://127.0.0.1:3015"
  ).replace(/\/+$/, "");
}

function botToken(): string {
  return (
    process.env.ARASYA_WA_BOT_INTERNAL_TOKEN ||
    process.env.WA_BOT_INTERNAL_TOKEN ||
    process.env.BOT_INTERNAL_TOKEN ||
    ""
  );
}

export async function sendInvoiceWhatsapp(
  invoiceId: string,
  input: SendInvoiceWhatsappInput,
  sentByUserId?: string,
) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      order: {
        include: {
          customers: { orderBy: { created_at: "asc" } },
          service_items: { orderBy: { sort_order: "asc" } },
        },
      },
    },
  });
  if (!invoice) throw new AppError("Invoice not found", 404);
  if (["REVISED", "CANCELLED", "DRAFT"].includes(invoice.status)) {
    throw new AppError(
      `Cannot send invoice with status ${invoice.status}`,
      409,
    );
  }
  if (!invoice.file_url)
    throw new AppError(
      "Invoice PDF is missing. Generate/sync PDF before sending.",
      409,
    );

  const targetPhone = normalizePhone(input.target_phone);
  if (!targetPhone) throw new AppError("Valid target phone is required", 400);
  const targetName =
    input.target_name ||
    invoice.order.customers.find((c) => c.phone)?.name ||
    invoice.order.customer_name;
  const amount = Number(invoice.amount);
  const rentalBase = rentalBaseOf(invoice.order.service_items);
  const rentalTotal = rentalBase > 0 ? rentalBase : amount;
  // DP caption quotes the DP invoice's actual amount; a settlement's own
  // amount is what is still due (the paid DP is read below).
  let dpAmount = invoice.invoice_type === "DP" ? amount : minDpFor(rentalTotal);
  let settlementAmount =
    invoice.invoice_type === "SETTLEMENT" ? amount : Math.max(rentalTotal - dpAmount, 0);

  // ── Sprint 2: per-type WhatsApp caption (bold, dynamic dates/greeting/H-1) ──
  const now = new Date();
  const serviceDates = invoice.order.service_items
    .map((i) => i.service_date)
    .filter((d): d is Date => !!d);
  const duration = formatTripDuration(serviceDates);
  const firstServiceDate =
    [...serviceDates].sort((a, b) => a.getTime() - b.getTime())[0] ||
    invoice.order.service_start_at ||
    invoice.order.order_date ||
    null;
  // "Same-day" handover wording when the first service day is today (no H-1).
  const sameDay = isSameDay(firstServiceDate, now);
  const greeting = greetingFor(now);

  // DP payment timestamp for the settlement reminder (first PAID DP invoice).
  let dpPaidAt: Date | null = null;
  if (invoice.invoice_type === "SETTLEMENT") {
    const dpInvoice = await prisma.invoice.findFirst({
      where: {
        order_id: invoice.order_id,
        invoice_type: "DP",
        status: "PAID",
      },
      orderBy: { paid_at: "asc" },
      include: {
        adjusted_by: {
          where: { status: "PAID" },
          select: { amount: true, amount_received: true, credit_applied: true },
        },
      },
    });
    dpPaidAt = dpInvoice?.paid_at ?? dpInvoice?.issue_date ?? null;
    // The DP as actually settled, not as invoiced: the money received on it
    // (an underpaid DP received less), the saldo lebih it used, and any paid
    // Invoice Penyesuaian that billed its shortfall.
    const settled = (i: { amount: unknown; amount_received?: unknown; credit_applied?: unknown }) =>
      sen(i.amount_received ?? i.amount) + sen(i.credit_applied);
    dpAmount = dpInvoice
      ? rp(settled(dpInvoice) + dpInvoice.adjusted_by.reduce((s, a) => s + settled(a), 0))
      : Math.max(rentalTotal - amount, 0);
  }

  const captionCtx = {
    duration,
    total: rentalTotal,
    dp: dpAmount,
    sisa: settlementAmount,
    amount,
    full: invoice.invoice_type === "FULL" || invoice.invoice_type === "COMBINED",
    additionalTotal: amount,
    greeting,
    dpPaidAt,
    sameDay,
  };

  let baseCaption: string;
  switch (invoice.invoice_type) {
    case "SETTLEMENT":
      baseCaption = buildSettlementInvoiceCaption(captionCtx);
      break;
    case "ADDITIONAL":
      baseCaption = buildAdditionalInvoiceCaption(captionCtx);
      break;
    case "ADJUSTMENT":
      baseCaption = buildAdjustmentInvoiceCaption(captionCtx);
      break;
    // DP / FULL / COMBINED all use the DP-style "please pay" caption.
    default:
      baseCaption = buildDpInvoiceCaption(captionCtx);
      break;
  }

  // Optional admin note is prepended (kept out of the locked template body).
  const messageText = input.message_note
    ? `Catatan: ${input.message_note}\n\n${baseCaption}`
    : baseCaption;

  const log = await prisma.invoiceDeliveryLog.create({
    data: {
      invoice_id: invoice.id,
      order_id: invoice.order_id,
      document_type: "INVOICE",
      target_name: targetName,
      target_phone: targetPhone,
      message_text: messageText,
      file_url: invoice.file_url,
      invoice_number_snapshot: invoice.invoice_number,
      amount_snapshot: invoice.amount,
      status_snapshot: invoice.status,
      status: "PENDING",
      sent_by_user_id: sentByUserId,
    },
  });

  // Manual mode: no bot. Hand the admin a wa.me link with the message and
  // the PDF link; the delivery is logged as sent when the link is issued.
  if (waManual()) {
    const pdf = invoice.file_url;
    const text = pdf ? `${messageText}\n\nInvoice (PDF): ${pdf}` : messageText;
    const sent = await prisma.invoiceDeliveryLog.update({
      where: { id: log.id },
      data: {
        status: "SENT",
        message_text: text,
        provider_message_id: "manual-wa-link",
        sent_at: new Date(),
        error_message: null,
      },
    });
    return { ...sent, wa_url: waLink(targetPhone, text) };
  }

  try {
    const token = botToken();
    if (!token) throw new Error("WA bot internal token is not configured");
    const res = await fetch(`${botBaseUrl()}/internal/invoices/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        invoice_id: invoice.id,
        delivery_log_id: log.id,
        invoice_number: invoice.invoice_number,
        target_name: targetName,
        target_phone: targetPhone,
        amount,
        pdf_url: invoice.file_url,
        message_text: messageText,
        filename: `Invoice-${invoice.invoice_number}.pdf`,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    if (!res.ok)
      throw new Error(
        payload?.message ||
          payload?.error ||
          payload?.raw ||
          `WA bot HTTP ${res.status}`,
      );
    return prisma.invoiceDeliveryLog.update({
      where: { id: log.id },
      data: {
        status: "SENT",
        provider_message_id: payload?.message_id || payload?.id || null,
        sent_at: new Date(),
        error_message: null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.invoiceDeliveryLog.update({
      where: { id: log.id },
      data: { status: "FAILED", error_message: message },
    });
    throw new AppError(`WhatsApp invoice send failed: ${message}`, 502);
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Send the KWITANSI (receipt) PDF to the customer over WhatsApp.
// Mirrors sendInvoiceWhatsapp but resolves the receipt PDF (invoice.receipt_url
// or the latest Receipt.file_url) and uses the receipt caption. Only valid once
// the invoice is PAID and a receipt PDF exists.
// ───────────────────────────────────────────────────────────────────────────
export async function sendReceiptWhatsapp(
  invoiceId: string,
  input: SendReceiptWhatsappInput,
  sentByUserId?: string,
) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      receipts: { orderBy: { created_at: "desc" } },
      order: {
        include: {
          customers: { orderBy: { created_at: "asc" } },
          service_items: { orderBy: { sort_order: "asc" } },
        },
      },
    },
  });
  if (!invoice) throw new AppError("Invoice not found", 404);
  if (invoice.status !== "PAID")
    throw new AppError(
      "Receipt can only be sent after the invoice is paid.",
      409,
    );

  // Prefer the dedicated Receipt row's PDF; fall back to invoice.receipt_url.
  const latestReceipt = invoice.receipts[0];
  const receiptPdfUrl = latestReceipt?.file_url || invoice.receipt_url;
  if (!receiptPdfUrl)
    throw new AppError(
      "Kwitansi PDF is missing. The receipt may not have been generated yet.",
      409,
    );
  const receiptNumber = latestReceipt?.receipt_number || invoice.invoice_number;

  const targetPhone = normalizePhone(input.target_phone);
  if (!targetPhone) throw new AppError("Valid target phone is required", 400);
  const targetName =
    input.target_name ||
    invoice.order.customers.find((c) => c.phone)?.name ||
    invoice.order.customer_name;

  // Receipt caption: ADDITIONAL invoices use the additional-receipt wording,
  // everything else uses the rental receipt. "sameDay" tweaks the handover line.
  const now = new Date();
  const serviceDates = invoice.order.service_items
    .map((i) => i.service_date)
    .filter((d): d is Date => !!d);
  const firstServiceDate =
    [...serviceDates].sort((a, b) => a.getTime() - b.getTime())[0] ||
    invoice.order.service_start_at ||
    invoice.order.order_date ||
    null;
  const sameDay = isSameDay(firstServiceDate, now);
  const baseCaption =
    invoice.invoice_type === "ADDITIONAL"
      ? buildAdditionalReceiptCaption()
      : buildRentalReceiptCaption({ sameDay });
  const messageText = input.message_note
    ? `Catatan: ${input.message_note}\n\n${baseCaption}`
    : baseCaption;

  const log = await prisma.invoiceDeliveryLog.create({
    data: {
      invoice_id: invoice.id,
      order_id: invoice.order_id,
      document_type: "RECEIPT",
      target_name: targetName,
      target_phone: targetPhone,
      message_text: messageText,
      file_url: receiptPdfUrl,
      invoice_number_snapshot: receiptNumber,
      amount_snapshot: invoice.amount,
      status_snapshot: invoice.status,
      status: "PENDING",
      sent_by_user_id: sentByUserId,
    },
  });

  // Manual mode: no bot. Hand the admin a wa.me link with the message and
  // the PDF link; the delivery is logged as sent when the link is issued.
  if (waManual()) {
    const pdf = receiptPdfUrl;
    const text = pdf ? `${messageText}\n\nKuitansi (PDF): ${pdf}` : messageText;
    const sent = await prisma.invoiceDeliveryLog.update({
      where: { id: log.id },
      data: {
        status: "SENT",
        message_text: text,
        provider_message_id: "manual-wa-link",
        sent_at: new Date(),
        error_message: null,
      },
    });
    return { ...sent, wa_url: waLink(targetPhone, text) };
  }

  try {
    const token = botToken();
    if (!token) throw new Error("WA bot internal token is not configured");
    const res = await fetch(`${botBaseUrl()}/internal/invoices/send`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        invoice_id: invoice.id,
        delivery_log_id: log.id,
        invoice_number: receiptNumber,
        target_name: targetName,
        target_phone: targetPhone,
        amount: Number(invoice.amount),
        pdf_url: receiptPdfUrl,
        message_text: messageText,
        filename: `Kwitansi-${receiptNumber}.pdf`,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = { raw: text };
    }
    if (!res.ok)
      throw new Error(
        payload?.message ||
          payload?.error ||
          payload?.raw ||
          `WA bot HTTP ${res.status}`,
      );
    return prisma.invoiceDeliveryLog.update({
      where: { id: log.id },
      data: {
        status: "SENT",
        provider_message_id: payload?.message_id || payload?.id || null,
        sent_at: new Date(),
        error_message: null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.invoiceDeliveryLog.update({
      where: { id: log.id },
      data: { status: "FAILED", error_message: message },
    });
    throw new AppError(`WhatsApp receipt send failed: ${message}`, 502);
  }
}

// ── Server-side invoices list (replaces the old client-side flatMap) ────────
// The dashboard /invoices page used to pull the ENTIRE /orders list and build
// the invoice rows in the browser. This paginates + filters in the DB and
// returns each invoice already shaped with the order context the UI needs.
export interface SearchInvoicesParams {
  search?: string;
  status?: string; // DRAFT|ISSUED|REVISED|PAID|CANCELLED
  payment_status?: string; // order-level bucket: UNPAID|DP_PAID|PAID
  page?: number;
  page_size?: number;
}

export async function searchInvoices(params: SearchInvoicesParams) {
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(params.page_size) || 10));

  const and: Record<string, unknown>[] = [];

  if (params.search?.trim()) {
    const q = params.search.trim();
    and.push({
      OR: [
        { invoice_number: { contains: q, mode: "insensitive" } },
        { order: { customer_name: { contains: q, mode: "insensitive" } } },
        { order: { order_code: { contains: q, mode: "insensitive" } } },
        {
          order: {
            customers: {
              some: { name: { contains: q, mode: "insensitive" } },
            },
          },
        },
      ],
    });
  }
  if (params.status && params.status !== "ALL") {
    and.push({ status: params.status });
  }
  if (params.payment_status && params.payment_status !== "ALL") {
    and.push({ order: { payment_status: params.payment_status } });
  }

  const where = and.length ? { AND: and } : {};

  const [total, rows] = await Promise.all([
    prisma.invoice.count({ where }),
    prisma.invoice.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        order: {
          select: {
            id: true,
            order_code: true,
            customer_name: true,
            customer_phone: true,
            payment_status: true,
            customers: { orderBy: { created_at: "asc" } },
          },
        },
        receipts: { orderBy: { created_at: "desc" } },
        delivery_logs: { orderBy: { created_at: "desc" } },
      },
    }),
  ]);

  return {
    data: rows,
    pagination: {
      page,
      page_size: pageSize,
      total,
      page_count: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}
