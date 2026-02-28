import prisma from '../../prisma/client';
import { AppError } from '../../utils/AppError';
import { generateInvoiceNumber } from '../../utils/invoiceNumber';
import { generateInvoicePDF } from '../../services/pdf.service';
import { uploadInvoicePDF } from '../../services/storage.service';
import { GenerateInvoiceInput } from './invoices.validation';

export async function generateInvoice(orderId: string, input: GenerateInvoiceInput) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new AppError('Order not found', 404);

  // Calculate how much has already been invoiced
  const aggregate = await prisma.invoice.aggregate({
    where: { order_id: orderId },
    _sum: { amount: true },
  });
  const alreadyInvoiced = Number(aggregate._sum.amount ?? 0);
  const finalPrice = Number(order.final_price);
  const remaining = finalPrice - alreadyInvoiced;

  // Validate: FULL invoice requires no previous payments
  if (input.invoice_type === 'FULL' && alreadyInvoiced > 0) {
    throw new AppError('Cannot generate FULL invoice when partial payments already exist', 409);
  }

  // Validate: SETTLEMENT requires a previous DP
  if (input.invoice_type === 'SETTLEMENT' && alreadyInvoiced === 0) {
    throw new AppError('Cannot generate SETTLEMENT invoice without a prior DP payment', 409);
  }

  // Validate: amount does not exceed remaining balance
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
    DP: 'Down Payment',
    SETTLEMENT: 'Settlement Payment',
    FULL: 'Full Payment',
  };

  const methodLabels: Record<string, string> = {
    CASH: 'Cash',
    BANK_TRANSFER: 'Bank Transfer',
    QRIS: 'QRIS',
    OTHER: 'Other',
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
        status: 'ISSUED',
      },
    });

    // Compute new payment status
    const newTotal = alreadyInvoiced + input.amount;
    let paymentStatus: 'UNPAID' | 'DP_PAID' | 'PAID' = 'UNPAID';
    if (newTotal >= finalPrice) {
      paymentStatus = 'PAID';
    } else if (newTotal > 0) {
      paymentStatus = 'DP_PAID';
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
  if (!order) throw new AppError('Order not found', 404);

  return prisma.invoice.findMany({
    where: { order_id: orderId },
    orderBy: { created_at: 'desc' },
  });
}

export async function updateInvoiceStatus(invoiceId: string, status: 'ISSUED' | 'PAID') {
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new AppError('Invoice not found', 404);

  return prisma.invoice.update({
    where: { id: invoiceId },
    data: { status },
  });
}
