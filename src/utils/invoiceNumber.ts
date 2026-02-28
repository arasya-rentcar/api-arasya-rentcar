import prisma from '../prisma/client';

export async function generateInvoiceNumber(): Promise<string> {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const prefix = `INV-${year}-${month}`;

  const count = await prisma.invoice.count({
    where: {
      invoice_number: {
        startsWith: prefix,
      },
    },
  });

  const sequence = count + 1;
  return `${prefix}-${String(sequence).padStart(3, '0')}`;
}
