import { Request, Response, NextFunction } from 'express';
import {
  listPayablesQuerySchema,
  updatePayableSchema,
  markPayablePaidSchema,
  bulkMarkPaidSchema,
} from './payables.validation';
import {
  listPayables,
  getPayable,
  updatePayable,
  markPayablePaid,
  markPayableUnpaid,
  bulkMarkPaid,
  driverPayableHistory,
  vendorPayableHistory,
} from './payables.service';

export async function listPayablesController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = listPayablesQuerySchema.parse(req.query);
    const data = await listPayables(query);
    res.json({ status: 'success', ...data });
  } catch (err) {
    next(err);
  }
}

export async function getPayableController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await getPayable(req.params.id);
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
}

export async function updatePayableController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = updatePayableSchema.parse(req.body);
    const data = await updatePayable(req.params.id, input);
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
}

export async function markPayablePaidController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = markPayablePaidSchema.parse(req.body ?? {});
    const data = await markPayablePaid(req.params.id, input);
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
}

export async function markPayableUnpaidController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await markPayableUnpaid(req.params.id);
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
}

export async function bulkMarkPaidController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = bulkMarkPaidSchema.parse(req.body);
    const data = await bulkMarkPaid(input.ids, input.paid_at);
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
}

export async function driverPayableHistoryController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await driverPayableHistory(req.params.id);
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
}

export async function vendorPayableHistoryController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await vendorPayableHistory(req.params.id);
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
}
