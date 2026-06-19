import { Request, Response, NextFunction } from "express";
import {
  generateInvoiceSchema,
  reviseInvoiceSchema,
  sendInvoiceWhatsappSchema,
  markInvoicePaidSchema,
} from "./invoices.validation";
import {
  generateInvoice,
  getInvoicesByOrder,
  reviseInvoice,
  sendInvoiceWhatsapp,
  markInvoicePaid,
  generateOrderStatement,
} from "./invoices.service";

export async function generateInvoiceController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = generateInvoiceSchema.parse(req.body);
    const invoice = await generateInvoice(req.params.id, input);
    res.status(201).json({ status: "success", data: invoice });
  } catch (err) {
    next(err);
  }
}

export async function getInvoiceByOrderController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const invoices = await getInvoicesByOrder(req.params.id);
    res.json({ status: "success", data: invoices });
  } catch (err) {
    next(err);
  }
}

export async function reviseInvoiceController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = reviseInvoiceSchema.parse(req.body);
    const invoice = await reviseInvoice(req.params.invoiceId, input);
    res.status(201).json({ status: "success", data: invoice });
  } catch (err) {
    next(err);
  }
}

export async function markInvoicePaidController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = markInvoicePaidSchema.parse(req.body ?? {});
    const invoice = await markInvoicePaid(req.params.invoiceId, input);
    res.json({ status: "success", data: invoice });
  } catch (err) {
    next(err);
  }
}

export async function getOrderStatementController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Accept an optional invoice selection from body (POST) or query (?invoice_ids=a,b).
    const raw =
      (req.body && (req.body.invoice_ids ?? req.body.invoiceIds)) ??
      req.query.invoice_ids;
    let invoiceIds: string[] | undefined;
    if (Array.isArray(raw)) {
      invoiceIds = raw.map(String);
    } else if (typeof raw === "string" && raw.trim()) {
      invoiceIds = raw.split(",").map((s) => s.trim()).filter(Boolean);
    }
    const result = await generateOrderStatement(req.params.id, invoiceIds);
    res.json({ status: "success", data: result });
  } catch (err) {
    next(err);
  }
}

export async function sendInvoiceWhatsappController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = sendInvoiceWhatsappSchema.parse(req.body);
    const log = await sendInvoiceWhatsapp(
      req.params.invoiceId,
      input,
      req.user?.user_id,
    );
    res.status(201).json({ status: "success", data: log });
  } catch (err) {
    next(err);
  }
}
