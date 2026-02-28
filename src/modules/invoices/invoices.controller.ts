import { Request, Response, NextFunction } from 'express';
import { generateInvoiceSchema } from './invoices.validation';
import { generateInvoice, getInvoicesByOrder } from './invoices.service';

export async function generateInvoiceController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = generateInvoiceSchema.parse(req.body);
    const invoice = await generateInvoice(req.params.id, input);
    res.status(201).json({ status: 'success', data: invoice });
  } catch (err) {
    next(err);
  }
}

export async function getInvoiceByOrderController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const invoices = await getInvoicesByOrder(req.params.id);
    res.json({ status: 'success', data: invoices });
  } catch (err) {
    next(err);
  }
}
