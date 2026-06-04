import { PDFDocument, rgb, StandardFonts, PDFFont, PDFPage } from "pdf-lib";

export interface InvoiceLineItem {
  serviceDate?: Date | string | null;
  description?: string | null;
  serviceKind?: string | null;
  pickupLocation?: string | null;
  dropoffLocation?: string | null;
  quantity?: number | null;
  unitPrice?: number | string | null;
  totalPrice?: number | string | null;
}

export interface InvoiceData {
  invoiceNumber: string;
  issueDate: Date;
  customerName: string;
  pickupLocation: string;
  dropoffLocation: string;
  finalPrice: number;
  items?: InvoiceLineItem[];
  // New fields for payment-type invoices
  invoiceType: string; // e.g. "Down Payment", "Settlement Payment", "Full Payment"
  paymentMethod: string; // e.g. "Cash", "Bank Transfer", "QRIS"
  amountPaid: number; // Amount for this specific invoice
  previouslyPaid: number; // Sum of all prior invoices
}

function formatRp(value: number): string {
  return `Rp ${new Intl.NumberFormat("id-ID").format(value)}`;
}

function drawLabelValue(
  page: PDFPage,
  label: string,
  value: string,
  x: number,
  y: number,
  labelFont: PDFFont,
  valueFont: PDFFont,
): void {
  page.drawText(label, {
    x,
    y: y + 14,
    size: 8,
    font: labelFont,
    color: rgb(0.5, 0.5, 0.5),
  });
  page.drawText(value, {
    x,
    y,
    size: 10,
    font: valueFont,
    color: rgb(0.1, 0.1, 0.1),
  });
}

export async function generateInvoicePDF(data: InvoiceData): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]); // A4

  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);

  const { width, height } = page.getSize();
  const margin = 50;
  const contentWidth = width - margin * 2;

  // ── Header band ──────────────────────────────────────────────────
  page.drawRectangle({
    x: 0,
    y: height - 115,
    width,
    height: 115,
    color: rgb(0.07, 0.07, 0.07),
  });

  page.drawText("ARASYA RENTCAR", {
    x: margin,
    y: height - 52,
    size: 22,
    font: bold,
    color: rgb(1, 1, 1),
  });

  page.drawText("Car Rental Services", {
    x: margin,
    y: height - 72,
    size: 9,
    font: regular,
    color: rgb(0.65, 0.65, 0.65),
  });

  // Invoice type label + number on the right
  page.drawText("INVOICE", {
    x: width - margin - 70,
    y: height - 45,
    size: 18,
    font: bold,
    color: rgb(1, 1, 1),
  });

  page.drawText(data.invoiceType.toUpperCase(), {
    x: width - margin - 110,
    y: height - 62,
    size: 9,
    font: bold,
    color: rgb(0.45, 0.85, 0.55),
  });

  page.drawText(data.invoiceNumber, {
    x: width - margin - 120,
    y: height - 78,
    size: 8,
    font: regular,
    color: rgb(0.65, 0.65, 0.65),
  });

  // ── Info Section ──────────────────────────────────────────────────
  let y = height - 160;

  const issueDateStr = data.issueDate.toLocaleDateString("id-ID", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  drawLabelValue(page, "ISSUE DATE", issueDateStr, margin, y, regular, bold);
  drawLabelValue(
    page,
    "CUSTOMER NAME",
    data.customerName,
    width / 2,
    y,
    regular,
    bold,
  );

  y -= 50;

  drawLabelValue(
    page,
    "PICKUP LOCATION",
    data.pickupLocation,
    margin,
    y,
    regular,
    regular,
  );
  drawLabelValue(
    page,
    "DROPOFF LOCATION",
    data.dropoffLocation,
    width / 2,
    y,
    regular,
    regular,
  );

  y -= 50;

  drawLabelValue(
    page,
    "PAYMENT METHOD",
    data.paymentMethod,
    margin,
    y,
    regular,
    bold,
  );

  y -= 30;

  // Separator
  page.drawLine({
    start: { x: margin, y },
    end: { x: width - margin, y },
    thickness: 0.5,
    color: rgb(0.82, 0.82, 0.82),
  });

  y -= 30;

  // ── Service table header ──────────────────────────────────────────
  page.drawRectangle({
    x: margin,
    y: y - 6,
    width: contentWidth,
    height: 24,
    color: rgb(0.95, 0.95, 0.95),
  });

  page.drawText("DATE", {
    x: margin + 8,
    y: y + 3,
    size: 8,
    font: bold,
    color: rgb(0.35, 0.35, 0.35),
  });
  page.drawText("SERVICE DETAIL", {
    x: margin + 78,
    y: y + 3,
    size: 8,
    font: bold,
    color: rgb(0.35, 0.35, 0.35),
  });
  page.drawText("QTY", {
    x: width - margin - 150,
    y: y + 3,
    size: 8,
    font: bold,
    color: rgb(0.35, 0.35, 0.35),
  });
  page.drawText("AMOUNT", {
    x: width - margin - 90,
    y: y + 3,
    size: 8,
    font: bold,
    color: rgb(0.35, 0.35, 0.35),
  });

  y -= 28;

  const lineItems = data.items?.length
    ? data.items
    : [
        {
          description: `${data.invoiceType} — Car Rental Service`,
          pickupLocation: data.pickupLocation,
          dropoffLocation: data.dropoffLocation,
          quantity: 1,
          totalPrice: data.amountPaid,
        },
      ];

  for (const [index, item] of lineItems.entries()) {
    if (y < 250) break;
    const rawDate = item.serviceDate ? new Date(item.serviceDate) : null;
    const dateStr =
      rawDate && !Number.isNaN(rawDate.getTime())
        ? rawDate.toLocaleDateString("id-ID", {
            day: "2-digit",
            month: "short",
            year: "numeric",
          })
        : "-";
    const route = [item.pickupLocation, item.dropoffLocation]
      .filter(Boolean)
      .join(" → ");
    const description =
      item.description || route || `Service Item ${index + 1}`;
    const kind = item.serviceKind ? `${item.serviceKind} — ` : "";
    const detail =
      kind +
      (route && item.description ? `${description} (${route})` : description);
    const qty = item.quantity ?? 1;
    const amount = Number(item.totalPrice ?? 0);

    page.drawText(dateStr.slice(0, 14), {
      x: margin + 8,
      y,
      size: 8,
      font: regular,
      color: rgb(0.25, 0.25, 0.25),
    });
    page.drawText(detail.slice(0, 58), {
      x: margin + 78,
      y,
      size: 8,
      font: regular,
      color: rgb(0.1, 0.1, 0.1),
    });
    page.drawText(String(qty), {
      x: width - margin - 150,
      y,
      size: 8,
      font: regular,
      color: rgb(0.1, 0.1, 0.1),
    });
    page.drawText(formatRp(amount), {
      x: width - margin - 90,
      y,
      size: 8,
      font: regular,
      color: rgb(0.1, 0.1, 0.1),
    });
    y -= 18;
  }

  y -= 2;

  page.drawLine({
    start: { x: margin, y },
    end: { x: width - margin, y },
    thickness: 0.5,
    color: rgb(0.82, 0.82, 0.82),
  });

  y -= 28;

  // ── Summary section ─────────────────────────────────────────────
  const summaryRows: [string, string][] = [
    ["Order Total", formatRp(data.finalPrice)],
  ];

  if (data.previouslyPaid > 0) {
    summaryRows.push(["Previously Paid", formatRp(data.previouslyPaid)]);
  }

  summaryRows.push(["Amount This Invoice", formatRp(data.amountPaid)]);

  const balance = data.finalPrice - data.previouslyPaid - data.amountPaid;
  summaryRows.push(["Balance Remaining", formatRp(balance)]);

  for (const [label, value] of summaryRows) {
    page.drawText(label, {
      x: margin + 10,
      y,
      size: 9,
      font: regular,
      color: rgb(0.4, 0.4, 0.4),
    });
    page.drawText(value, {
      x: width - margin - 90,
      y,
      size: 9,
      font: regular,
      color: rgb(0.2, 0.2, 0.2),
    });
    y -= 18;
  }

  y -= 10;

  // Bold total line
  page.drawLine({
    start: { x: margin, y },
    end: { x: width - margin, y },
    thickness: 1,
    color: rgb(0.07, 0.07, 0.07),
  });

  y -= 22;

  page.drawText("AMOUNT PAID", {
    x: margin + 10,
    y,
    size: 12,
    font: bold,
    color: rgb(0.07, 0.07, 0.07),
  });

  page.drawText(formatRp(data.amountPaid), {
    x: width - margin - 90,
    y,
    size: 13,
    font: bold,
    color: rgb(0.07, 0.07, 0.07),
  });

  y -= 55;

  // ── Payment information ───────────────────────────────────────────
  page.drawText("PAYMENT INFORMATION", {
    x: margin,
    y,
    size: 9,
    font: bold,
    color: rgb(0.35, 0.35, 0.35),
  });

  y -= 18;

  page.drawLine({
    start: { x: margin, y },
    end: { x: margin + 220, y },
    thickness: 0.5,
    color: rgb(0.82, 0.82, 0.82),
  });

  const paymentRows: [string, string][] = [
    ["Payment Method", data.paymentMethod],
    ["Bank", "BCA"],
    ["Account Number", "1234567890"],
    ["Account Name", "ARASYA RENTCAR"],
  ];

  for (const [label, value] of paymentRows) {
    y -= 18;
    page.drawText(label, {
      x: margin,
      y,
      size: 9,
      font: regular,
      color: rgb(0.5, 0.5, 0.5),
    });
    page.drawText(value, {
      x: margin + 130,
      y,
      size: 9,
      font: bold,
      color: rgb(0.1, 0.1, 0.1),
    });
  }

  // ── Footer ────────────────────────────────────────────────────────
  page.drawLine({
    start: { x: margin, y: 80 },
    end: { x: width - margin, y: 80 },
    thickness: 0.5,
    color: rgb(0.82, 0.82, 0.82),
  });

  page.drawText("Thank you for choosing ARASYA RENTCAR.", {
    x: margin,
    y: 62,
    size: 9,
    font: regular,
    color: rgb(0.5, 0.5, 0.5),
  });

  page.drawText("This document was generated automatically.", {
    x: margin,
    y: 46,
    size: 8,
    font: regular,
    color: rgb(0.7, 0.7, 0.7),
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}
