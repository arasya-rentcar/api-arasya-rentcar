import {
  PDFDocument,
  rgb,
  StandardFonts,
  PDFFont,
  PDFPage,
  PDFImage,
} from "pdf-lib";
import fs from "fs";
import path from "path";

export interface InvoiceLineItem {
  serviceDate?: Date | string | null;
  description?: string | null;
  serviceKind?: string | null;
  servicePackage?: string | null;
  pickupLocation?: string | null;
  dropoffLocation?: string | null;
  quantity?: number | null;
  unitPrice?: number | string | null;
  totalPrice?: number | string | null;
  // Free-form right-hand "UNIT" column text (e.g. "Innova Reborn | Full day | tbc")
  unitLabel?: string | null;
}

// A payment already received, shown on a Kuitansi as a negative line.
export interface PaymentReceived {
  label: string; // e.g. "Pembayaran DP diterima saat pemesanan tanggal 24 Mei 2026"
  amount: number; // positive number; rendered as -amount
}

export interface InvoiceData {
  invoiceNumber: string; // internal unique number (kept for storage/filename)
  displayNumber?: string | null; // number printed as "INVOICE #" (order code)
  issueDate: Date;
  customerName: string;
  customerPhone?: string | null;
  pickupLocation: string;
  dropoffLocation: string;
  finalPrice: number;
  items?: InvoiceLineItem[];
  invoiceType: string;
  paymentMethod: string;
  amountPaid: number;
  previouslyPaid: number;
  documentMode?: "INVOICE" | "RECEIPT";
  paidAt?: Date | string | null;
  dueDate?: Date | string | null;
  // Receipt-specific: list of received payments (DP / pelunasan), and remaining.
  paymentsReceived?: PaymentReceived[];
  remainingBalance?: number | null;
  // Free-form footer notes shown under the table (pickup/dropoff/inclusions).
  noteLines?: string[];
  // Optional extra "additional charges" section (combined invoice).
  additionalItems?: InvoiceLineItem[];
}

// ── Company constants (hardcoded from the official templates) ──────────
const COMPANY = {
  tagline: "Rental Mobil dan Travel Profesional di Indonesia",
  address: "Selakopi Hijau Blok F no. 5, Pasirmulya, Kota Bogor, 16118",
  phone: "+62 821 240 242 81",
  perihal: "Jasa Rental Mobil",
  signerName: "Aldi Lesmana",
  signerTitle: "Finance",
  bankLine:
    "Pembayaran transfer ditujukan kepada rekening:\n" +
    "BCA 0954840782 a/n PT Ayomi Raya Karsa atau MANDIRI 1330015925837 a/n Q Ahmada Arifin",
  overtimeTitle: "*Overtime*",
  overtimeNote:
    "Pemakaian melebihi durasi sewa (12 jam/Full day) atau lewat 23.00 dikenakan biaya overtime 10% per jam",
  terms:
    "Terms of Payment :\n" +
    "(1) DP 20% pada saat pemesanan.\n" +
    "(2) Pelunasan dibayarkan di hari pertama pelayanan.\n" +
    "(3) Tambahan overtime, reimburse parkir, atau biaya lain yang terjadi (jika ada), " +
    "dibayarkan maksimal H+2 dari selesai kegiatan",
  // Newer cancellation policy (the 21.00-cutoff version from the kuitansi files).
  cancellation:
    "Cancellation policy:\n" +
    "Cancel sejak DP diterima sampai H-1 sebelum jam 21.00 = DP hangus.\n" +
    "Cancel H-1 setelah jam 21.00 sampai hari H sebelum driver tiba di lokasi = 50% dari total invoice.\n" +
    "Cancel hari H setelah driver tiba atau cancel di hari H setelah jam 10.00 pagi = 100% dari total invoice.",
  thankYou: "THANK YOU FOR YOUR BUSINESS!",
};

const BRAND_DIR = path.join(__dirname, "..", "assets", "brand");

function tryReadAsset(name: string): Buffer | null {
  try {
    return fs.readFileSync(path.join(BRAND_DIR, name));
  } catch {
    return null;
  }
}

function formatDateId(value: Date | string | null | undefined): string {
  if (!value) return "-";
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("id-ID", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function formatRp(value: number): string {
  const n = Math.round(value);
  const sign = n < 0 ? "-" : "";
  return `${sign}Rp ${new Intl.NumberFormat("id-ID").format(Math.abs(n))}`;
}

// Standard PDF fonts only support Latin-1; map common Unicode to ASCII.
function sanitizeText(input: unknown): string {
  if (input === null || input === undefined) return "";
  return String(input)
    .replace(/[\u2192\u279C\u27A1]/g, "->")
    .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
    .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/[\u00B7\u2022]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[^\u0000-\u00FF]/g, "");
}

// Wrap text to a max width (in points) at the given font size.
function wrapText(
  text: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const out: string[] = [];
  for (const rawLine of sanitizeText(text).split("\n")) {
    const words = rawLine.split(/\s+/);
    let line = "";
    for (const w of words) {
      const test = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(test, size) > maxWidth && line) {
        out.push(line);
        line = w;
      } else {
        line = test;
      }
    }
    out.push(line);
  }
  return out;
}

export async function generateInvoicePDF(data: InvoiceData): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595.28, 841.89]); // A4
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const italic = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  const { width, height } = page.getSize();
  const margin = 42;
  const right = width - margin;
  const isReceipt = data.documentMode === "RECEIPT";

  // Embed brand assets (real logo / signature / paid stamp) if present.
  let logo: PDFImage | null = null;
  let signature: PDFImage | null = null;
  let stamp: PDFImage | null = null;
  const logoBuf = tryReadAsset("logo.png");
  const sigBuf = tryReadAsset("signature.png");
  const stampBuf = tryReadAsset("paid-stamp.png");
  try {
    if (logoBuf) logo = await pdfDoc.embedPng(logoBuf);
    if (sigBuf) signature = await pdfDoc.embedPng(sigBuf);
    if (stampBuf) stamp = await pdfDoc.embedPng(stampBuf);
  } catch {
    // ignore broken assets; fall back to text
  }

  const drawRight = (
    text: string,
    yy: number,
    size: number,
    font: PDFFont,
    color = rgb(0.1, 0.1, 0.1),
  ) => {
    const t = sanitizeText(text);
    page.drawText(t, {
      x: right - font.widthOfTextAtSize(t, size),
      y: yy,
      size,
      font,
      color,
    });
  };

  // ── Header ──────────────────────────────────────────────────────
  let y = height - margin;

  // Logo top-left
  if (logo) {
    const lw = 120;
    const lh = (logo.height / logo.width) * lw;
    page.drawImage(logo, { x: margin, y: y - lh, width: lw, height: lh });
  } else {
    page.drawText("ARASYA", {
      x: margin,
      y: y - 22,
      size: 24,
      font: bold,
      color: rgb(0.1, 0.1, 0.1),
    });
  }

  // Document title top-right
  const title = isReceipt ? "KUITANSI" : "INVOICE";
  drawRight(title, y - 24, 26, bold, rgb(0.1, 0.1, 0.1));

  // Tagline / address / phone (left, under logo)
  let infoY = y - 56;
  page.drawText(sanitizeText(COMPANY.tagline), {
    x: margin,
    y: infoY,
    size: 8,
    font: regular,
    color: rgb(0.35, 0.35, 0.35),
  });
  infoY -= 12;
  page.drawText(sanitizeText(COMPANY.address), {
    x: margin,
    y: infoY,
    size: 8,
    font: regular,
    color: rgb(0.35, 0.35, 0.35),
  });
  infoY -= 12;
  page.drawText(sanitizeText(COMPANY.phone), {
    x: margin,
    y: infoY,
    size: 8,
    font: regular,
    color: rgb(0.35, 0.35, 0.35),
  });

  // Right meta block: Tanggal / INVOICE # / Perihal
  const metaLabelX = right - 200;
  const metaValX = right - 120;
  let metaY = y - 50;
  const metaRows: [string, string][] = [
    ["Tanggal", formatDateId(data.issueDate)],
    ["INVOICE #", sanitizeText(data.displayNumber || data.invoiceNumber)],
    ["Perihal", COMPANY.perihal],
  ];
  for (const [label, value] of metaRows) {
    page.drawText(label, {
      x: metaLabelX,
      y: metaY,
      size: 8,
      font: bold,
      color: rgb(0.4, 0.4, 0.4),
    });
    page.drawText(sanitizeText(value), {
      x: metaValX,
      y: metaY,
      size: 8,
      font: regular,
      color: rgb(0.1, 0.1, 0.1),
    });
    metaY -= 13;
  }

  // ── BILL TO ─────────────────────────────────────────────────────
  y = height - 130;
  page.drawText("BILL TO:", {
    x: margin,
    y,
    size: 9,
    font: bold,
    color: rgb(0.2, 0.2, 0.2),
  });
  y -= 14;
  page.drawText(sanitizeText(data.customerName), {
    x: margin,
    y,
    size: 11,
    font: bold,
    color: rgb(0.1, 0.1, 0.1),
  });
  if (data.customerPhone) {
    y -= 13;
    page.drawText(sanitizeText(data.customerPhone), {
      x: margin,
      y,
      size: 9,
      font: regular,
      color: rgb(0.4, 0.4, 0.4),
    });
  }

  // ── Table header ────────────────────────────────────────────────
  y -= 24;
  const colDesc = margin;
  const colUnit = right - 205;
  // Right-aligned numeric columns: HARGA then JUMLAH (rightmost).
  const hargaRightX = right - 78;
  const jumlahRightX = right;
  const drawRightAt = (
    text: string,
    rx: number,
    yy: number,
    size: number,
    font: PDFFont,
    color = rgb(0.1, 0.1, 0.1),
  ) => {
    const t = sanitizeText(text);
    page.drawText(t, {
      x: rx - font.widthOfTextAtSize(t, size),
      y: yy,
      size,
      font,
      color,
    });
  };

  page.drawRectangle({
    x: margin - 4,
    y: y - 6,
    width: width - 2 * (margin - 4),
    height: 20,
    color: rgb(0.93, 0.93, 0.93),
  });
  page.drawText("DESKRIPSI", {
    x: colDesc,
    y,
    size: 8,
    font: bold,
    color: rgb(0.3, 0.3, 0.3),
  });
  page.drawText("UNIT", {
    x: colUnit,
    y,
    size: 8,
    font: bold,
    color: rgb(0.3, 0.3, 0.3),
  });
  drawRightAt("HARGA", hargaRightX, y, 8, bold, rgb(0.3, 0.3, 0.3));
  drawRightAt("JUMLAH", jumlahRightX, y, 8, bold, rgb(0.3, 0.3, 0.3));

  y -= 20;

  // ── Line items ──────────────────────────────────────────────────
  const drawItemRow = (item: InvoiceLineItem) => {
    const rawDate = item.serviceDate ? new Date(item.serviceDate) : null;
    const dateStr =
      rawDate && !Number.isNaN(rawDate.getTime())
        ? rawDate.toLocaleDateString("id-ID", {
            day: "2-digit",
            month: "long",
            year: "numeric",
          })
        : null;
    const route = [item.pickupLocation, item.dropoffLocation]
      .map((s) => sanitizeText(s))
      .filter(Boolean)
      .join(" - ");
    // Build a description that mirrors the sheet style.
    const parts = [
      dateStr,
      sanitizeText(item.description) || null,
      item.serviceKind ? sanitizeText(item.serviceKind) : null,
      item.servicePackage ? sanitizeText(item.servicePackage) : null,
    ].filter(Boolean);
    let desc = parts.join(" | ");
    if (!desc) desc = route || "Service";
    const unit = sanitizeText(item.unitLabel || "1");
    const qtyAmount = Number(item.totalPrice ?? 0);
    const harga = Number(item.unitPrice ?? item.totalPrice ?? 0);

    // Description may wrap
    const descLines = wrapText(desc, regular, 8, colUnit - colDesc - 8);
    for (const [i, dl] of descLines.entries()) {
      page.drawText(dl, {
        x: colDesc,
        y: y - i * 10,
        size: 8,
        font: regular,
        color: rgb(0.1, 0.1, 0.1),
      });
    }
    page.drawText(unit.slice(0, 16), {
      x: colUnit,
      y,
      size: 8,
      font: regular,
      color: rgb(0.25, 0.25, 0.25),
    });
    drawRightAt(formatRp(harga).replace("Rp ", ""), hargaRightX, y, 8, regular);
    drawRightAt(
      formatRp(qtyAmount).replace("Rp ", ""),
      jumlahRightX,
      y,
      8,
      regular,
    );
    y -= Math.max(14, descLines.length * 10 + 4);
  };

  for (const item of data.items ?? []) {
    if (y < 320) break;
    drawItemRow(item);
  }

  // Combined additional charges section (optional)
  if (data.additionalItems?.length) {
    y -= 4;
    page.drawText("Additional Charges:", {
      x: colDesc,
      y,
      size: 8,
      font: bold,
      color: rgb(0.3, 0.3, 0.3),
    });
    y -= 14;
    for (const item of data.additionalItems) {
      if (y < 320) break;
      drawItemRow(item);
    }
  }

  // ── Note lines (pickup/dropoff/inclusions) ──────────────────────
  y -= 4;
  for (const note of data.noteLines ?? []) {
    const lines = wrapText(note, regular, 7.5, colUnit - colDesc - 8);
    for (const l of lines) {
      page.drawText(l, {
        x: colDesc,
        y,
        size: 7.5,
        font: regular,
        color: rgb(0.45, 0.45, 0.45),
      });
      y -= 10;
    }
  }

  // Receipt: payment-received lines as full-width rows under the table.
  if (isReceipt && data.paymentsReceived?.length) {
    y -= 8;
    for (const p of data.paymentsReceived) {
      const labelLines = wrapText(
        p.label,
        regular,
        8,
        jumlahRightX - colDesc - 90,
      );
      labelLines.forEach((l, i) => {
        page.drawText(l, {
          x: colDesc,
          y: y - i * 10,
          size: 8,
          font: regular,
          color: rgb(0.3, 0.3, 0.3),
        });
      });
      drawRightAt(formatRp(-Math.abs(p.amount)), jumlahRightX, y, 8, regular);
      y -= Math.max(13, labelLines.length * 10 + 2);
    }
  }

  // ── Right totals box ────────────────────────────────────────────
  let ty = Math.min(y + 30, height - 380);
  const totalsLabelX = right - 220;
  const drawTotalRow = (
    label: string,
    value: string,
    opts: { bold?: boolean; size?: number } = {},
  ) => {
    const f = opts.bold ? bold : regular;
    const sz = opts.size ?? 9;
    page.drawText(sanitizeText(label), {
      x: totalsLabelX,
      y: ty,
      size: sz,
      font: f,
      color: rgb(0.3, 0.3, 0.3),
    });
    drawRightAt(value, jumlahRightX, ty, sz, f, rgb(0.1, 0.1, 0.1));
    ty -= sz + 7;
  };

  if (isReceipt) {
    drawTotalRow("TOTAL BIAYA PERJALANAN", formatRp(data.finalPrice));
    const remaining =
      data.remainingBalance != null
        ? data.remainingBalance
        : Math.max(
            data.finalPrice -
              (data.paymentsReceived ?? []).reduce(
                (s, p) => s + Math.abs(p.amount),
                0,
              ),
            0,
          );
    ty -= 4;
    page.drawLine({
      start: { x: totalsLabelX, y: ty + 6 },
      end: { x: right, y: ty + 6 },
      thickness: 0.5,
      color: rgb(0.7, 0.7, 0.7),
    });
    drawTotalRow("SISA TAGIHAN", formatRp(remaining), { bold: true });
    drawTotalRow("TOTAL", formatRp(remaining), { bold: true, size: 11 });
  } else {
    drawTotalRow("SUBTOTAL", formatRp(data.finalPrice));
    drawTotalRow("LAIN-LAIN", "Rp -");
    ty -= 4;
    page.drawLine({
      start: { x: totalsLabelX, y: ty + 6 },
      end: { x: right, y: ty + 6 },
      thickness: 0.5,
      color: rgb(0.7, 0.7, 0.7),
    });
    drawTotalRow("TOTAL", formatRp(data.finalPrice), { bold: true, size: 11 });
    if (data.dueDate) {
      drawTotalRow("Jatuh tempo", formatDateId(data.dueDate), { size: 8 });
    }
  }

  // ── Footer block (terms, cancellation, bank, signature) ─────────
  let fy = Math.min(y - 16, 250);

  // Overtime
  page.drawText(sanitizeText(COMPANY.overtimeTitle), {
    x: margin,
    y: fy,
    size: 8,
    font: bold,
    color: rgb(0.2, 0.2, 0.2),
  });
  fy -= 11;
  for (const l of wrapText(COMPANY.overtimeNote, italic, 7, 300)) {
    page.drawText(l, {
      x: margin,
      y: fy,
      size: 7,
      font: italic,
      color: rgb(0.45, 0.45, 0.45),
    });
    fy -= 9;
  }

  fy -= 4;
  for (const l of wrapText(COMPANY.terms, regular, 7, 320)) {
    page.drawText(l, {
      x: margin,
      y: fy,
      size: 7,
      font: regular,
      color: rgb(0.35, 0.35, 0.35),
    });
    fy -= 9;
  }

  fy -= 4;
  for (const l of wrapText(COMPANY.cancellation, regular, 7, 320)) {
    page.drawText(l, {
      x: margin,
      y: fy,
      size: 7,
      font: regular,
      color: rgb(0.55, 0.4, 0.4),
    });
    fy -= 9;
  }

  fy -= 4;
  for (const l of wrapText(COMPANY.bankLine, regular, 7, 320)) {
    page.drawText(l, {
      x: margin,
      y: fy,
      size: 7,
      font: regular,
      color: rgb(0.35, 0.35, 0.35),
    });
    fy -= 9;
  }

  // ── Signature block (bottom-right) ──────────────────────────────
  const sigBoxX = right - 150;
  let sigY = 150;

  // Paid stamp behind the signature (receipts only)
  if (isReceipt && stamp) {
    const sw = 95;
    const sh = (stamp.height / stamp.width) * sw;
    page.drawImage(stamp, {
      x: sigBoxX - 10,
      y: sigY - 10,
      width: sw,
      height: sh,
      opacity: 0.9,
    });
  }

  if (signature) {
    const sw = 110;
    const sh = (signature.height / signature.width) * sw;
    page.drawImage(signature, {
      x: sigBoxX,
      y: sigY,
      width: sw,
      height: sh,
    });
  }

  page.drawText(sanitizeText(COMPANY.signerName), {
    x: sigBoxX,
    y: sigY - 6,
    size: 9,
    font: bold,
    color: rgb(0.1, 0.1, 0.1),
  });
  page.drawText(sanitizeText(COMPANY.signerTitle), {
    x: sigBoxX,
    y: sigY - 18,
    size: 8,
    font: regular,
    color: rgb(0.4, 0.4, 0.4),
  });

  // ── Thank you footer ────────────────────────────────────────────
  page.drawLine({
    start: { x: margin, y: 70 },
    end: { x: right, y: 70 },
    thickness: 0.5,
    color: rgb(0.8, 0.8, 0.8),
  });
  page.drawText(sanitizeText(COMPANY.thankYou), {
    x: margin,
    y: 54,
    size: 9,
    font: bold,
    color: rgb(0.2, 0.2, 0.2),
  });

  const pdfBytes = await pdfDoc.save();
  return Buffer.from(pdfBytes);
}
