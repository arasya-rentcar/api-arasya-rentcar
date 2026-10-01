import { waLink, waManual } from "../../utils/waManual";
import { reportLeadPurchase } from "../../services/ga4.service";
import prisma from "../../prisma/client";
import { AppError } from "../../utils/AppError";
import { nextInvoiceNumber, nextReceiptNumber } from "../../utils/codes";
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
import { generateInvoicePDF } from "../../services/pdf.service";
import {
  uploadInvoicePDF,
  uploadFile,
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
// what's included), mirroring the official invoice/kuitansi templates.
function buildNoteLines(order: {
  pickup_location?: string | null;
  dropoff_location?: string | null;
}): string[] {
  const lines: string[] = [];
  if (order.pickup_location) lines.push(`Jemput : ${order.pickup_location}`);
  if (order.dropoff_location)
    lines.push(`Tujuan : pemakaian area ${order.dropoff_location}`);
  lines.push("Harga termasuk mobil supir bbm tol makan supir");
  lines.push(
    "Parkir/tiket masuk kawasan dan tips supir seikhlasnya dari Tamu",
  );
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

  const pdfBuffer = await generateInvoicePDF({
    invoiceNumber,
    displayNumber: args.order.order_code ?? null,
    issueDate,
    customerName: args.order.customer_name,
    customerPhone: args.order.customer_phone ?? null,
    pickupLocation: args.order.pickup_location,
    dropoffLocation: args.order.dropoff_location,
    finalPrice: args.penalty,
    // Reuse the single-amount totals layout ("Total Tambahan / TOTAL").
    invoiceType: "Cancellation Fee",
    invoiceKind: "ADDITIONAL",
    paymentMethod: "Bank Transfer",
    amountPaid: args.penalty,
    previouslyPaid: 0,
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

  // Rental base = sum of service lines (additionals/adjustments are billed separately,
  // each as its own ADDITIONAL invoice). DP percentage is based on this rental base.
  const rentalBase = order.service_items.reduce(
    (sum, item) => sum + Number(item.total_price || 0),
    0,
  );

  // Billable additional charges (overtime/parking/etc.) — only used for COMBINED,
  // which rolls rental + extras into a single invoice (and a single Kwitansi).
  const billableAdjustments = order.adjustments.filter((a) => a.is_billable);
  const additionalsTotal = billableAdjustments.reduce(
    (sum, a) => sum + Number(a.amount) * (a.quantity ?? 1),
    0,
  );

  // Calculate how much has already been invoiced
  const aggregate = await prisma.invoice.aggregate({
    where: {
      order_id: orderId,
      status: { notIn: ["REVISED", "CANCELLED"] },
    },
    _sum: { amount: true },
  });
  const alreadyInvoiced = Number(aggregate._sum.amount ?? 0);
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

  // Validate: DP must be at least 20% of the rental base (minimum down payment).
  // Customer may pay more than 20%, but never less.
  if (input.invoice_type === "DP" && rentalBase > 0) {
    const minDp = Math.round(rentalBase * 0.2);
    if (input.amount < minDp) {
      throw new AppError(
        `DP must be at least 20% of the rental price (minimum ${minDp}). Rental base: ${rentalBase}.`,
        409,
      );
    }
    if (input.amount > rentalBase) {
      throw new AppError(
        `DP (${input.amount}) cannot exceed the rental price (${rentalBase}).`,
        409,
      );
    }
  }

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

  // Settlement (remaining rental balance) is due on the first day of service.
  let dueDate: Date | null = null;
  if (input.invoice_type === "SETTLEMENT") {
    const firstServiceDate = order.service_items
      .map((i) => i.service_date)
      .filter((d): d is Date => !!d)
      .sort((a, b) => a.getTime() - b.getTime())[0];
    dueDate =
      firstServiceDate || order.service_start_at || order.order_date || null;
  }

  // Determine PDF description label
  const typeLabels: Record<string, string> = {
    DP: "Down Payment",
    SETTLEMENT: "Settlement Payment",
    FULL: "Full Payment",
    ADDITIONAL: "Additional Charge",
    COMBINED: "Rental + Additional (Combined)",
  };

  // For COMBINED, render the billable adjustments as an "Additional Charges"
  // section in the same PDF as the rental service lines.
  const additionalItems = isCombined
    ? billableAdjustments.map(adjustmentToLineItem)
    : undefined;

  // The PDF line items depend on the invoice type:
  //  - ADDITIONAL bills ONLY the billable adjustments (no rental day lines).
  //  - everything else (DP / SETTLEMENT / FULL / COMBINED) lists the rental
  //    service days; COMBINED also appends additionalItems above.
  const rentalLineItems = order.service_items.map((item) => ({
    serviceDate: item.service_date,
    description: item.description,
    serviceKind: item.service_kind,
    servicePackage: item.service_package,
    pickupLocation: item.pickup_location,
    dropoffLocation: item.dropoff_location,
    quantity: item.quantity,
    unitPrice: Number(item.unit_price),
    totalPrice: Number(item.total_price),
  }));
  const additionalLineItems = billableAdjustments.map(adjustmentToLineItem);
  const pdfItems =
    input.invoice_type === "ADDITIONAL" ? additionalLineItems : rentalLineItems;

  const methodLabels: Record<string, string> = {
    CASH: "Cash",
    BANK_TRANSFER: "Bank Transfer",
    QRIS: "QRIS",
    OTHER: "Other",
  };

  const pdfBuffer = await generateInvoicePDF({
    invoiceNumber,
    displayNumber: order.order_code ?? null,
    issueDate,
    customerName: order.customer_name,
    customerPhone: order.customer_phone ?? null,
    pickupLocation: order.pickup_location,
    dropoffLocation: order.dropoff_location,
    finalPrice,
    invoiceType: typeLabels[input.invoice_type] ?? input.invoice_type,
    paymentMethod: methodLabels[input.payment_method] ?? input.payment_method,
    amountPaid: input.amount,
    previouslyPaid: alreadyInvoiced,
    documentMode: "INVOICE",
    invoiceKind: input.invoice_type,
    dueDate,
    noteLines: buildNoteLines(order),
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

  return prisma.invoice.update({
    where: { id: invoiceId },
    data: { status },
  });
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

// Mark an invoice PAID -> it now prints as a Kwitansi/Receipt.
// Recomputes the order payment_status from the sum of all PAID invoices.
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
      order: {
        include: {
          service_items: { orderBy: { sort_order: "asc" } },
          adjustments: { orderBy: { created_at: "asc" } },
          customer: true,
        },
      },
    },
  });
  if (!invoice) throw new AppError("Invoice not found", 404);
  if (invoice.status === "PAID") return invoice;
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
  const invoiceAmount = Number(invoice.amount);
  const amountReceived =
    input.amount_received != null ? Number(input.amount_received) : invoiceAmount;
  // Surplus paid against THIS invoice (carried toward the rest of the order).
  const overpayThisInvoice = Math.max(amountReceived - invoiceAmount, 0);
  const orderTotal = Number(invoice.order.final_price);

  const typeLabels: Record<string, string> = {
    DP: "Down Payment",
    SETTLEMENT: "Settlement Payment",
    FULL: "Full Payment",
    ADDITIONAL: "Additional Charge",
    COMBINED: "Rental + Additional (Combined)",
  };
  const methodLabels: Record<string, string> = {
    CASH: "Cash",
    BANK_TRANSFER: "Bank Transfer",
    QRIS: "QRIS",
    OTHER: "Other",
  };

  // For a COMBINED invoice the kwitansi mirrors the invoice: rental lines plus
  // an Additional Charges section.
  const receiptBillableAdjustments = invoice.order.adjustments.filter(
    (a) => a.is_billable,
  );
  const receiptAdditionalItems =
    invoice.invoice_type === "COMBINED"
      ? receiptBillableAdjustments.map(adjustmentToLineItem)
      : undefined;
  // The kwitansi line items mirror the invoice: an ADDITIONAL receipt lists ONLY
  // the additional charges; every other type lists the rental service days.
  const receiptRentalItems = invoice.order.service_items.map((item) => ({
    serviceDate: item.service_date,
    description: item.description,
    serviceKind: item.service_kind,
    servicePackage: item.service_package,
    pickupLocation: item.pickup_location,
    dropoffLocation: item.dropoff_location,
    quantity: item.quantity,
    unitPrice: Number(item.unit_price),
    totalPrice: Number(item.total_price),
  }));
  const receiptItems =
    invoice.invoice_type === "ADDITIONAL"
      ? receiptBillableAdjustments.map(adjustmentToLineItem)
      : receiptRentalItems;

  // Sum of prior invoices (excluding this one) for the receipt summary.
  const priorAgg = await prisma.invoice.aggregate({
    where: {
      order_id: invoice.order_id,
      id: { not: invoice.id },
      status: { notIn: ["REVISED", "CANCELLED"] },
    },
    _sum: { amount: true },
  });
  const previouslyPaid = Number(priorAgg._sum.amount ?? 0);

  // Build the "payments received" lines for the kuitansi: all PAID invoices so
  // far (DP / settlement / etc.) plus the one being paid now.
  const priorPaid = await prisma.invoice.findMany({
    where: { order_id: invoice.order_id, status: "PAID", id: { not: invoice.id } },
    orderBy: { issue_date: "asc" },
  });
  const typeLabelId: Record<string, string> = {
    DP: "Pembayaran DP diterima",
    SETTLEMENT: "Pelunasan diterima",
    FULL: "Pembayaran diterima",
    ADDITIONAL: "Pembayaran tambahan diterima",
  };
  const fmtTgl = (d: Date) =>
    new Date(d).toLocaleDateString("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  // Prior receipts hold the ACTUAL money received per prior invoice (may exceed
  // the invoice amount on overpayment). Map by invoice_id for accurate totals.
  const priorReceipts = await prisma.receipt.findMany({
    where: { invoice_id: { in: priorPaid.map((p) => p.id) } },
  });
  const receivedByInvoice = new Map(
    priorReceipts.map((r) => [r.invoice_id, Number(r.amount)]),
  );
  const paymentsReceived = [
    ...priorPaid.map((p) => ({
      label: `${typeLabelId[p.invoice_type] ?? "Pembayaran diterima"} tanggal ${fmtTgl(p.paid_at ?? p.issue_date)}`,
      amount: receivedByInvoice.get(p.id) ?? Number(p.amount),
    })),
    {
      label: `${typeLabelId[invoice.invoice_type] ?? "Pembayaran diterima"} tanggal ${fmtTgl(paidAt)}`,
      amount: amountReceived,
    },
  ];
  const totalReceived = paymentsReceived.reduce((s, p) => s + p.amount, 0);
  const remainingBalance = Math.max(orderTotal - totalReceived, 0);
  // Refund is due ONLY when total received exceeds the ORDER total (never the DP).
  const refundDue = Math.max(totalReceived - orderTotal, 0);

  // Regenerate the PDF as a Kwitansi/Receipt (LUNAS stamp, payment date).
  // IMPORTANT: this is stored in receipt_url, NOT file_url. The original
  // invoice PDF (file_url) is kept so the order keeps BOTH documents paired.
  let receiptUrl: string | null = null;
  try {
    const pdfBuffer = await generateInvoicePDF({
      invoiceNumber: invoice.invoice_number,
      displayNumber: invoice.order.order_code ?? null,
      issueDate: invoice.issue_date,
      customerName: invoice.order.customer_name,
      customerPhone: invoice.order.customer_phone ?? null,
      pickupLocation: invoice.order.pickup_location,
      dropoffLocation: invoice.order.dropoff_location,
      finalPrice: Number(invoice.order.final_price),
      invoiceType: typeLabels[invoice.invoice_type] ?? invoice.invoice_type,
      paymentMethod: methodLabels[paymentMethod] ?? paymentMethod,
      amountPaid: amountReceived,
      previouslyPaid,
      documentMode: "RECEIPT",
      paidAt,
      paymentsReceived,
      remainingBalance,
      // Sprint 2: overpayment/refund details live ONLY in the PDF.
      refundDue,
      noteLines: buildNoteLines(invoice.order),
      items: receiptItems,
      additionalItems: receiptAdditionalItems,
    });
    receiptUrl = await uploadInvoicePDF(
      pdfBuffer,
      `${invoice.invoice_number}-receipt.pdf`,
    );
  } catch (err) {
    // If receipt PDF fails, still mark paid; keep the existing invoice PDF.
    console.error("Receipt PDF generation failed:", err);
  }

  // Upload the payment proof to the private bucket (signed URLs are minted on
  // read). Store only the storage path on the receipt.
  const proofUpload = await uploadFile(proofFile, {
    bucket: PAYMENT_PROOFS_BUCKET,
    prefix: `invoice/${invoice.id}`,
    public: false,
  });

  // Reserve the kwitansi number atomically (per-customer kwitansi_seq) before
  // the main transaction. Receipts always belong to a customer (via the order).
  const customer = invoice.order.customer;
  let receiptNumber: string | null = null;
  let receiptSeq: number | null = null;
  if (customer) {
    const gen = await prisma.$transaction((tx) =>
      nextReceiptNumber(tx, { id: customer.id, code: customer.code }, paidAt),
    );
    receiptNumber = gen.number;
    receiptSeq = gen.seq;
  }

  const paid = await prisma.$transaction(async (tx) => {
    const updated = await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        status: "PAID",
        paid_at: paidAt,
        receipt_url: receiptUrl,
        ...(input.payment_method
          ? { payment_method: input.payment_method as never }
          : {}),
      },
    });

    // Create the Kwitansi/Receipt row (idempotency: one receipt per invoice
    // payment event; the early `status === PAID` return above prevents repeats).
    if (customer && receiptNumber && receiptSeq !== null) {
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
          file_url: receiptUrl,
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

    // paid_to_date = sum of ACTUAL money received across the order (= totalReceived,
    // prior receipts + this payment). Drives payment_status + refund flag.
    const paidTotal = totalReceived;

    let paymentStatus: "UNPAID" | "DP_PAID" | "PAID" = "UNPAID";
    if (paidTotal >= orderTotal && orderTotal > 0) paymentStatus = "PAID";
    else if (paidTotal > 0) paymentStatus = "DP_PAID";

    await tx.order.update({
      where: { id: invoice.order_id },
      data: { payment_status: paymentStatus, paid_to_date: paidTotal },
    });

    return updated;
  });

  // Website lead → GA4 "purchase" (first payment only; never blocks the admin).
  reportLeadPurchase(invoice.order_id).catch((err) =>
    console.error("GA4 purchase report failed:", err),
  );

  return paid;
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

  // Service-day line items.
  const items = order.service_items.map((item) => ({
    serviceDate: item.service_date,
    description: item.description,
    serviceKind: item.service_kind,
    servicePackage: item.service_package,
    pickupLocation: item.pickup_location,
    dropoffLocation: item.dropoff_location,
    quantity: item.quantity,
    unitPrice: Number(item.unit_price),
    totalPrice: Number(item.total_price),
  }));

  // Billable additional charges (overtime/parking/etc.).
  const additionalItems = order.adjustments
    .filter((a) => a.is_billable)
    .map(adjustmentToLineItem);

  // Every payment actually received (PAID invoices only).
  const typeLabelId: Record<string, string> = {
    DP: "Pembayaran DP diterima",
    SETTLEMENT: "Pelunasan diterima",
    FULL: "Pembayaran diterima",
    ADDITIONAL: "Pembayaran tambahan diterima",
  };
  const fmtTgl = (d: Date) =>
    new Date(d).toLocaleDateString("id-ID", {
      timeZone: "Asia/Jakarta",
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  const paidInvoices = order.invoices.filter((i) => i.status === "PAID");
  const paymentsReceived = paidInvoices.map((p) => ({
    label: `${typeLabelId[p.invoice_type] ?? "Pembayaran diterima"} tanggal ${fmtTgl(p.paid_at ?? p.issue_date)}`,
    amount: Number(p.amount),
  }));
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
    noteLines: buildNoteLines(order),
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

  const methodLabels: Record<string, string> = {
    CASH: "Cash",
    BANK_TRANSFER: "Bank Transfer",
    QRIS: "QRIS",
    OTHER: "Other",
  };

  // For a revision, exclude the invoice being revised from the "previously paid" total.
  const aggregate = await prisma.invoice.aggregate({
    where: {
      order_id: invoice.order_id,
      id: { not: invoice.id },
      status: { notIn: ["REVISED", "CANCELLED"] },
    },
    _sum: { amount: true },
  });
  const previouslyPaid = Number(aggregate._sum.amount ?? 0);
  const finalPrice = Number(invoice.order.final_price);

  if (previouslyPaid + amount > finalPrice) {
    throw new AppError(
      `Revised invoice total (${previouslyPaid + amount}) exceeds order final price (${finalPrice}). Update order price first or reduce the invoice amount.`,
      409,
    );
  }

  // Mirror the original invoice's line items: an ADDITIONAL revision lists ONLY
  // the additional charges; COMBINED lists rental + an Additional Charges
  // section; the rest list the rental service days.
  const reviseBillableAdjustments = invoice.order.adjustments.filter(
    (a) => a.is_billable,
  );
  const reviseAdjustmentItems = reviseBillableAdjustments.map(
    adjustmentToLineItem,
  );
  const reviseRentalItems = invoice.order.service_items.map((item) => ({
    serviceDate: item.service_date,
    description: item.description,
    serviceKind: item.service_kind,
    servicePackage: item.service_package,
    pickupLocation: item.pickup_location,
    dropoffLocation: item.dropoff_location,
    quantity: item.quantity,
    unitPrice: Number(item.unit_price),
    totalPrice: Number(item.total_price),
  }));
  const reviseItems =
    invoice.invoice_type === "ADDITIONAL"
      ? reviseAdjustmentItems
      : reviseRentalItems;
  const reviseAdditionalItems =
    invoice.invoice_type === "COMBINED" ? reviseAdjustmentItems : undefined;

  const pdfBuffer = await generateInvoicePDF({
    invoiceNumber,
    issueDate,
    customerName: invoice.order.customer_name,
    pickupLocation: invoice.order.pickup_location,
    dropoffLocation: invoice.order.dropoff_location,
    finalPrice,
    invoiceType:
      typeLabels[invoice.invoice_type] ?? `${invoice.invoice_type} Revision`,
    paymentMethod: methodLabels[paymentMethod] ?? paymentMethod,
    amountPaid: amount,
    previouslyPaid,
    invoiceKind: invoice.invoice_type,
    items: reviseItems,
    additionalItems: reviseAdditionalItems,
  });

  const fileName = `${invoiceNumber}.pdf`;
  const fileUrl = await uploadInvoicePDF(pdfBuffer, fileName);

  return prisma.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id: invoice.id },
      data: { status: "REVISED" },
    });
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
    const newTotal = previouslyPaid + amount;
    let paymentStatus: "UNPAID" | "DP_PAID" | "PAID" = invoice.order
      .payment_status as "UNPAID" | "DP_PAID" | "PAID";
    if (newTotal >= finalPrice) {
      paymentStatus = "PAID";
    } else if (newTotal > 0) {
      paymentStatus = "DP_PAID";
    } else {
      paymentStatus = "UNPAID";
    }

    await tx.order.update({
      where: { id: invoice.order_id },
      data: { payment_status: paymentStatus },
    });

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
    return revised;
  });
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
  const rentalBase = invoice.order.service_items.reduce(
    (sum, item) => sum + Number(item.total_price || 0),
    0,
  );
  const rentalTotal = rentalBase > 0 ? rentalBase : amount;
  const dpAmount = Math.round(rentalTotal * 0.2);
  const settlementAmount = rentalTotal - dpAmount;

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
  }

  const captionCtx = {
    duration,
    total: rentalTotal,
    dp: dpAmount,
    sisa: settlementAmount,
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
