import { Request, Response, NextFunction } from "express";
import {
  generateInvoiceSchema,
  reviseInvoiceSchema,
  sendInvoiceWhatsappSchema,
} from "./invoices.validation";
import {
  generateInvoice,
  getInvoicesByOrder,
  reviseInvoice,
  sendInvoiceWhatsapp,
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
