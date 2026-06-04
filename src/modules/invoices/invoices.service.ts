import prisma from "../../prisma/client";
import { AppError } from "../../utils/AppError";
import { generateInvoiceNumber } from "../../utils/invoiceNumber";
import { generateInvoicePDF } from "../../services/pdf.service";
import { uploadInvoicePDF } from "../../services/storage.service";
import {
  GenerateInvoiceInput,
  ReviseInvoiceInput,
  SendInvoiceWhatsappInput,
} from "./invoices.validation";

export async function generateInvoice(
  orderId: string,
  input: GenerateInvoiceInput,
) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { service_items: { orderBy: { sort_order: "asc" } } },
  });
  if (!order) throw new AppError("Order not found", 404);

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

  // Validate: SETTLEMENT requires a previous DP
  if (input.invoice_type === "SETTLEMENT" && alreadyInvoiced === 0) {
    throw new AppError(
      "Cannot generate SETTLEMENT invoice without a prior DP payment",
      409,
    );
  }

  // Guard: active invoice total must never exceed order.final_price.
  // Extra charges should update the order final_price first, then create an invoice.
  if (input.amount > remaining) {
    throw new AppError(
      `Amount (${input.amount}) exceeds remaining balance (${remaining}). Order total: ${finalPrice}, already invoiced: ${alreadyInvoiced}`,
      409,
    );
  }

  const invoiceNumber = await generateInvoiceNumber();
  const issueDate = new Date();

  // Determine PDF description label
  const typeLabels: Record<string, string> = {
    DP: "Down Payment",
    SETTLEMENT: "Settlement Payment",
    FULL: "Full Payment",
    ADDITIONAL: "Additional Charge",
  };

  const methodLabels: Record<string, string> = {
    CASH: "Cash",
    BANK_TRANSFER: "Bank Transfer",
    QRIS: "QRIS",
    OTHER: "Other",
  };

  const pdfBuffer = await generateInvoicePDF({
    invoiceNumber,
    issueDate,
    customerName: order.customer_name,
    pickupLocation: order.pickup_location,
    dropoffLocation: order.dropoff_location,
    finalPrice,
    invoiceType: typeLabels[input.invoice_type] ?? input.invoice_type,
    paymentMethod: methodLabels[input.payment_method] ?? input.payment_method,
    amountPaid: input.amount,
    previouslyPaid: alreadyInvoiced,
    items: order.service_items.map((item) => ({
      serviceDate: item.service_date,
      description: item.description,
      serviceKind: item.service_kind,
      pickupLocation: item.pickup_location,
      dropoffLocation: item.dropoff_location,
      quantity: item.quantity,
      unitPrice: Number(item.unit_price),
      totalPrice: Number(item.total_price),
    })),
  });

  const fileName = `${invoiceNumber}.pdf`;
  const fileUrl = await uploadInvoicePDF(pdfBuffer, fileName);

  // Create invoice + auto-update payment_status in one transaction
  const [invoice] = await prisma.$transaction(async (tx) => {
    const newInvoice = await tx.invoice.create({
      data: {
        order_id: orderId,
        invoice_number: invoiceNumber,
        invoice_type: input.invoice_type,
        payment_method: input.payment_method,
        issue_date: issueDate,
        amount: input.amount,
        note: input.note,
        file_url: fileUrl,
        status: "ISSUED",
      },
    });

    // Compute new payment status
    const newTotal = alreadyInvoiced + input.amount;
    let paymentStatus: "UNPAID" | "DP_PAID" | "PAID" = order.payment_status as
      | "UNPAID"
      | "DP_PAID"
      | "PAID";
    if (newTotal >= finalPrice) {
      paymentStatus = "PAID";
    } else if (newTotal > 0) {
      paymentStatus = "DP_PAID";
    }

    await tx.order.update({
      where: { id: orderId },
      data: { payment_status: paymentStatus },
    });

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

export async function reviseInvoice(
  invoiceId: string,
  input: ReviseInvoiceInput,
) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      order: { include: { service_items: { orderBy: { sort_order: "asc" } } } },
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
    items: invoice.order.service_items.map((item) => ({
      serviceDate: item.service_date,
      description: item.description,
      serviceKind: item.service_kind,
      pickupLocation: item.pickup_location,
      dropoffLocation: item.dropoff_location,
      quantity: item.quantity,
      unitPrice: Number(item.unit_price),
      totalPrice: Number(item.total_price),
    })),
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
      order: { include: { customers: { orderBy: { created_at: "asc" } } } },
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
  const messageText = [
    `Halo Bapak/Ibu ${targetName || invoice.order.customer_name},`,
    "",
    "Berikut kami kirimkan invoice Arasya Rentcar:",
    "",
    `Invoice: ${invoice.invoice_number}`,
    `Total: ${formatRupiah(amount)}`,
    input.message_note ? `Catatan: ${input.message_note}` : "",
    "",
    "Mohon dicek ya. Terima kasih 🙏",
  ]
    .filter((line) => line !== "")
    .join("\n");

  const log = await prisma.invoiceDeliveryLog.create({
    data: {
      invoice_id: invoice.id,
      order_id: invoice.order_id,
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
