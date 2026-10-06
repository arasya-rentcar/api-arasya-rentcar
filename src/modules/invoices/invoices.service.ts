import { waLink, waManual } from "../../utils/waManual";
import {
  dpBaseOf,
  minDpFor,
  netPaid,
  paymentStatusFor,
  rentalBaseOf,
  startPayment,
} from "../orders/assignment-guard";
import { notifyOrderPaidInFull } from "../../services/driverNotify";
import { reportLeadPurchase } from "../../services/ga4.service";
import type { Prisma } from "@prisma/client";
import prisma from "../../prisma/client";
import { env } from "../../config/env";
import { AppError } from "../../utils/AppError";
import { nextInvoiceNumber, nextReceiptNumber } from "../../utils/codes";
import { packageNoteLines } from "../../utils/packageNotes";
import {
  buildDpInvoiceCaption,
  buildSettlementInvoiceCaption,
  buildAdditionalInvoiceCaption,
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
};

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
 * What is already billed on an order, for the "never bill more than the order
 * total" checks: the active invoices plus money received on invoices that a
 * cancellation voided. That money still counts toward the cancellation fee
 * (cancelOrder bills only the rest), so it must not be billed again. Only
 * cancelOrder voids invoices, so other orders are unaffected.
 */
export async function billedSoFar(
  orderId: string,
  excludeInvoiceId?: string,
  db: Prisma.TransactionClient | typeof prisma = prisma,
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

export async function generateInvoice(
  orderId: string,
  input: GenerateInvoiceInput,
) {
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

  const isCombined = input.invoice_type === "COMBINED";

  // Rental base = the days that are not cancelled (additionals/adjustments are
  // billed separately, each as its own ADDITIONAL invoice). DP percentage is
  // based on this rental base.
  const rentalBase = rentalBaseOf(order.service_items);

  // Billable additional charges (overtime/parking/etc.) — only used for COMBINED,
  // which rolls rental + extras into a single invoice (and a single Kwitansi).
  const billableAdjustments = order.adjustments.filter((a) => a.is_billable);
  const additionalsTotal = billableAdjustments.reduce(
    (sum, a) => sum + Number(a.amount) * (a.quantity ?? 1),
    0,
  );

  // Calculate how much has already been invoiced
  const alreadyInvoiced = await billedSoFar(orderId);
  const finalPrice = Number(order.final_price);
  const remaining = finalPrice - alreadyInvoiced;

  // Validate: FULL invoice requires no previous payments
  if (input.invoice_type === "FULL" && alreadyInvoiced > 0) {
    throw new AppError(
      "Cannot generate FULL invoice when partial payments already exist",
      409,
    );
  }

  // COMBINED bills rental + all billable additionals as one invoice, so like FULL
  // it must be the only/first active invoice on the order.
  if (isCombined && alreadyInvoiced > 0) {
    throw new AppError(
      "Cannot generate a Combined invoice when other active invoices already exist",
      409,
    );
  }

  // Prevent double-billing: a separate ADDITIONAL invoice can't coexist with an
  // active COMBINED invoice (which already includes the additionals), and vice-versa.
  if (input.invoice_type === "ADDITIONAL") {
    const hasActiveCombined = await prisma.invoice.count({
      where: {
        order_id: orderId,
        invoice_type: "COMBINED",
        status: { notIn: ["REVISED", "CANCELLED"] },
      },
    });
    if (hasActiveCombined > 0) {
      throw new AppError(
        "An active Combined invoice already includes additional charges. Revise it instead of adding a separate Additional invoice.",
        409,
      );
    }
  }

  // Validate: SETTLEMENT requires a previous DP
  if (input.invoice_type === "SETTLEMENT" && alreadyInvoiced === 0) {
    throw new AppError(
      "Cannot generate SETTLEMENT invoice without a prior DP payment",
      409,
    );
  }

  if (input.invoice_type === "DP") assertDpAmount(input.amount, rentalBase);

  // Guard: active invoice total must never exceed order.final_price.
  // Extra charges should update the order final_price first, then create an invoice.
  if (input.amount > remaining) {
    throw new AppError(
      `Amount (${input.amount}) exceeds remaining balance (${remaining}). Order total: ${finalPrice}, already invoiced: ${alreadyInvoiced}`,
      409,
    );
  }

  // Reserve the invoice number atomically (per-customer invoice_seq) in a short
  // transaction BEFORE building the PDF, so the pooler never times out and two
  // concurrent invoices for the same customer can't collide.
  const issueDate = input.issue_date ? new Date(input.issue_date) : new Date();
  const { seq: invoiceSeq, number: invoiceNumber } = await prisma.$transaction(
    (tx) =>
      nextInvoiceNumber(
        tx,
        { id: order.customer!.id, code: order.customer!.code },
        issueDate,
      ),
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

  // Determine PDF description label


  // For COMBINED, render the billable adjustments as an "Additional Charges"
  // section in the same PDF as the rental service lines.
  const additionalItems = isCombined
    ? billableAdjustments.map(adjustmentToLineItem)
    : undefined;

  // The PDF line items depend on the invoice type:
  //  - ADDITIONAL bills ONLY the billable adjustments (no rental day lines).
  //  - everything else (DP / SETTLEMENT / FULL / COMBINED) lists the rental
  //    service days; COMBINED also appends additionalItems above.
  const additionalLineItems = billableAdjustments.map(adjustmentToLineItem);
  const pdfItems =
    input.invoice_type === "ADDITIONAL"
      ? additionalLineItems
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
    invoiceType: INVOICE_TYPE_LABEL[input.invoice_type] ?? input.invoice_type,
    paymentMethod: PAYMENT_METHOD_LABEL[input.payment_method] ?? input.payment_method,
    amountPaid: input.amount,
    previouslyPaid: alreadyInvoiced,
    documentMode: "INVOICE",
    invoiceKind: input.invoice_type,
    dueDate,
    noteLines: isFeeOnly(order) ? undefined : buildNoteLines(order),
    items: pdfItems,
    additionalItems,
  });

  const fileName = `${invoiceNumber}.pdf`;
  const fileUrl = await uploadInvoicePDF(pdfBuffer, fileName);

  // Create invoice + auto-update payment_status in one transaction
  const [invoice] = await prisma.$transaction(async (tx) => {
    const newInvoice = await tx.invoice.create({
      data: {
        order_id: orderId,
        invoice_number: invoiceNumber,
        customer_seq: invoiceSeq,
        invoice_type: input.invoice_type,
        payment_method: input.payment_method,
        issue_date: issueDate,
        amount: input.amount,
        note: input.note,
        file_url: fileUrl,
        status: "ISSUED",
        due_date: dueDate,
      },
    });

    // Keep the customer's billed total in sync (G9: total_billed = sum invoices).
    await tx.customer.update({
      where: { id: order.customer!.id },
      data: { total_billed: { increment: input.amount } },
    });

    // NOTE: issuing an invoice does NOT change payment_status.
    // payment_status only advances when an invoice is marked PAID (see markInvoicePaid).
    return [newInvoice];
  });

  return invoice;
}

export async function getInvoicesByOrder(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new AppError("Order not found", 404);

  return prisma.invoice.findMany({
    where: { order_id: orderId },
    orderBy: { created_at: "desc" },
  });
}

export async function updateInvoiceStatus(
  invoiceId: string,
  status: "DRAFT" | "ISSUED" | "REVISED" | "PAID" | "CANCELLED",
) {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new AppError("Invoice not found", 404);

  const updated = await prisma.invoice.update({
    where: { id: invoiceId },
    data: { status },
  });
  if (status === "PAID")
    reportLeadPurchase(invoice.order_id).catch((err) =>
      console.error("GA4 purchase report failed:", err),
    );
  return updated;
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

// Mark an invoice paid: money received, kwitansi (receipt PDF), order payment status.
export async function markInvoicePaid(
  invoiceId: string,
  input: {
    payment_method?: string;
    paid_at?: string;
    amount_received?: number;
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
  // Already paid: return the plain invoice row (the loaded order/customer
  // carries personal data such as the NIK and must not reach the client).
  if (invoice.status === "PAID") {
    const { order: _order, ...plain } = invoice;
    return plain;
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
  // Sprint 2 payment model: record the ACTUAL money received, which may be more
  // than the invoice amount (overpayment). Defaults to the invoice amount.
  const amountReceived =
    input.amount_received != null ? Number(input.amount_received) : Number(invoice.amount);
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
  // (the other one burns no number and records nothing). Lock order: invoice
  // row, then order row (as cancelOrder and reviseInvoice), so they cannot
  // deadlock; the order lock makes two invoices paid at once add up.
  let applied: { becameReady: boolean } | null;
  try {
    applied = await prisma.$transaction(
      async (tx) => {
        const { count } = await tx.invoice.updateMany({
          where: { id: invoiceId, status: { notIn: ["PAID", "REVISED", "CANCELLED"] } },
          data: {
            status: "PAID",
            paid_at: paidAt,
            ...(input.payment_method
              ? { payment_method: input.payment_method as never }
              : {}),
          },
        });
        if (count === 0) return null;
        const [locked] = await tx.$queryRaw<
          {
            final_price: unknown;
            paid_to_date: unknown;
            is_refunded: boolean;
            refund_amount: unknown;
            cancellation_fee: unknown;
          }[]
        >`SELECT final_price, paid_to_date, is_refunded, refund_amount, cancellation_fee
          FROM "orders" WHERE id = ${invoice.order_id} FOR NO KEY UPDATE`;

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
              // ACTUAL money received (may exceed the invoice amount on overpayment).
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
            // Less than the 20% DP received stays UNPAID (B2).
            payment_status: paymentStatusFor(
              netPaid({ ...locked, paid_to_date: paidTotal }),
              locked.final_price,
              dpBaseOf(locked, days),
            ),
            paid_to_date: paidTotal,
          },
        });
        // Did this payment make the rental paid in full? Decided under the
        // lock, so two invoices paid at once notify the drivers only once.
        const becameReady =
          !startPayment({ paid_to_date: locked.paid_to_date }, days).ready &&
          startPayment({ paid_to_date: paidTotal }, days).ready;
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
    if (current?.status === "PAID") return current;
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
  reportLeadPurchase(invoice.order_id).catch((err) =>
    console.error("GA4 purchase report failed:", err),
  );
  // Paid in full just now: the assigned drivers may begin the trip with the
  // customer (app unlocks "Mulai perjalanan") and get a notification.
  if (applied.becameReady) void notifyOrderPaidInFull(invoice.order_id);

  return prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });
}

/**
 * Regenerate the invoice as a Kwitansi/Receipt (LUNAS stamp, payment date)
 * and attach it. Stored in receipt_url, NOT file_url: the original invoice PDF
 * is kept so the order keeps BOTH documents paired.
 */
async function attachReceiptPdf(
  invoiceId: string,
  pay: { paidAt: Date; paymentMethod: string; amountReceived: number },
) {
  const invoice = await prisma.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    include: {
      order: {
        include: {
          service_items: { orderBy: { sort_order: "asc" } },
          adjustments: { orderBy: { created_at: "asc" } },
        },
      },
    },
  });
  const order = invoice.order;
  const orderTotal = Number(order.final_price);

  // For a COMBINED invoice the kwitansi mirrors the invoice: rental lines plus
  // an Additional Charges section. An ADDITIONAL receipt lists ONLY the
  // additional charges; every other type lists the rental service days.
  const billable = order.adjustments.filter((a) => a.is_billable);
  const additionalItems =
    invoice.invoice_type === "COMBINED" ? billable.map(adjustmentToLineItem) : undefined;
  const items =
    invoice.invoice_type === "ADDITIONAL"
      ? billable.map(adjustmentToLineItem)
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
  const all = await paymentsOnOrder(prisma, invoice.order_id, invoice.id);
  const earlier = all.items.filter((p) => !p.paid_at || p.paid_at.getTime() <= pay.paidAt.getTime());
  const others = { items: earlier, total: earlier.reduce((s, p) => s + p.received, 0) };
  const paymentsReceived = paymentLines([
    ...others.items,
    { invoice_type: invoice.invoice_type, paid_at: pay.paidAt, issue_date: invoice.issue_date, received: pay.amountReceived },
  ]);
  const totalReceived = others.total + pay.amountReceived;

  const pdfBuffer = await generateInvoicePDF({
    invoiceNumber: invoice.invoice_number,
    displayNumber: order.order_code ?? null,
    issueDate: invoice.issue_date,
    customerName: order.customer_name,
    customerPhone: order.customer_phone ?? null,
    pickupLocation: order.pickup_location,
    dropoffLocation: order.dropoff_location,
    finalPrice: orderTotal,
    invoiceType: INVOICE_TYPE_LABEL[invoice.invoice_type] ?? invoice.invoice_type,
    paymentMethod: PAYMENT_METHOD_LABEL[pay.paymentMethod] ?? pay.paymentMethod,
    amountPaid: pay.amountReceived,
    previouslyPaid,
    documentMode: "RECEIPT",
    paidAt: pay.paidAt,
    paymentsReceived,
    remainingBalance: Math.max(orderTotal - totalReceived, 0),
    // Sprint 2: overpayment/refund details live ONLY in the PDF. Refund is due
    // only when total received exceeds the ORDER total (never the DP).
    refundDue: Math.max(totalReceived - orderTotal, 0),
    noteLines: isFeeOnly(order, invoice.invoice_type) ? undefined : buildNoteLines(order),
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
// line items + billable adjustments + every payment received + running balance
// (LUNAS stamp when fully settled). Kept separate from per-payment invoice /
// kuitansi documents which remain individually accessible.
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
  // receipt, also for an invoice voided later by a cancellation).
  const chosen = new Set(order.invoices.map((i) => i.id));
  const paymentsReceived = paymentLines(
    (await paymentsOnOrder(prisma, order.id)).items.filter((p) => chosen.has(p.id)),
  );
  const totalReceived = paymentsReceived.reduce((s, p) => s + p.amount, 0);
  const remainingBalance = Math.max(finalPrice - totalReceived, 0);
  const fullyPaid = remainingBalance <= 0 && finalPrice > 0;

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
    remainingBalance,
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
    remaining_balance: remainingBalance,
    fully_paid: fullyPaid,
  };
}

export async function reviseInvoice(
  invoiceId: string,
  input: ReviseInvoiceInput,
) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      order: {
        include: {
          service_items: { orderBy: { sort_order: "asc" } },
          adjustments: { orderBy: { created_at: "asc" } },
        },
      },
    },
  });
  if (!invoice) throw new AppError("Invoice not found", 404);
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

  const typeLabels: Record<string, string> = {
    DP: "Down Payment Revision",
    SETTLEMENT: "Settlement Payment Revision",
    FULL: "Full Payment Revision",
    ADDITIONAL: "Additional Charge Revision",
  };



  // For a revision, exclude the invoice being revised from the "previously paid" total.
  const previouslyPaid = await billedSoFar(invoice.order_id, invoice.id);
  const finalPrice = Number(invoice.order.final_price);

  if (previouslyPaid + amount > finalPrice) {
    throw new AppError(
      `Revised invoice total (${previouslyPaid + amount}) exceeds order final price (${finalPrice}). Update order price first or reduce the invoice amount.`,
      409,
    );
  }
  // B2: a revised DP keeps the 20% minimum, like a new one.
  if (invoice.invoice_type === "DP")
    assertDpAmount(amount, rentalBaseOf(invoice.order.service_items));

  // Mirror the original invoice's line items: an ADDITIONAL revision lists ONLY
  // the additional charges; COMBINED lists rental + an Additional Charges
  // section; the rest list the rental service days.
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
    invoiceType:
      typeLabels[invoice.invoice_type] ?? `${invoice.invoice_type} Revision`,
    paymentMethod: PAYMENT_METHOD_LABEL[paymentMethod] ?? paymentMethod,
    amountPaid: amount,
    previouslyPaid,
    invoiceKind: invoice.invoice_type,
    // Same notes as the original; a cancellation fee keeps none (its own
    // notes, the reason and tier, are not stored).
    noteLines: isFeeOnly(invoice.order, invoice.invoice_type) ? undefined : buildNoteLines(invoice.order),
    items: reviseItems,
    additionalItems: reviseAdditionalItems,
  });

  // Unique per attempt: two revisions at once must not overwrite each other's
  // PDF (only one of them is recorded, see the conditional update below).
  const fileName = `${invoiceNumber}-${Date.now().toString(36)}.pdf`;
  const fileUrl = await uploadInvoicePDF(pdfBuffer, fileName);

  let revised;
  try {
    revised = await prisma.$transaction(async (tx) => {
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
      const revised = await tx.invoice.create({
        data: {
          order_id: invoice.order_id,
          invoice_number: invoiceNumber,
          invoice_type: invoice.invoice_type,
          payment_method: paymentMethod,
          issue_date: issueDate,
          amount,
          note: input.note || invoice.note,
          file_url: fileUrl,
          status: "ISSUED",
          revision: invoice.revision + 1,
          parent_id: invoice.parent_id || invoice.id,
        },
      });
      // payment_status is NOT recomputed here: it follows the money received
      // (markInvoicePaid), never the amount billed. Revising an unpaid invoice
      // must not mark the order paid (the owner's DP rule and GA4 rely on it).

      await tx.orderChangeLog.create({
        data: {
          order_id: invoice.order_id,
          field: "invoice_revision",
          old_value: `${invoice.invoice_number}: ${invoice.amount}`,
          new_value: `${invoiceNumber}: ${input.amount}`,
          note: input.note,
          actor: "ADMIN",
        },
      });
      // Keep total_billed = sum of active invoices (G9): the old amount is
      // replaced by the new one.
      if (invoice.order.customer_id) {
        const delta = amount - Number(invoice.amount);
        if (delta !== 0) {
          await tx.customer.update({
            where: { id: invoice.order.customer_id },
            data: { total_billed: { increment: delta } },
          });
        }
      }
      return revised;
    });
  } catch (err) {
    // Not recorded: the revision PDF (customer name, amounts) must not stay
    // behind in the public bucket.
    void removeFile(env.SUPABASE_STORAGE_BUCKET, `invoices/${fileName}`);
    throw err;
  }
  return revised;
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
    });
    dpPaidAt = dpInvoice?.paid_at ?? dpInvoice?.issue_date ?? null;
    dpAmount = dpInvoice ? Number(dpInvoice.amount) : Math.max(rentalTotal - amount, 0);
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
