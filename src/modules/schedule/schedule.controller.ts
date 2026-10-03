import { Request, Response, NextFunction } from 'express';
import {
  listScheduleQuerySchema,
  assignScheduleLineSchema,
  driverAvailabilityQuerySchema,
  scheduleStockQuerySchema,
  tripHistoryQuerySchema,
  scheduleWeekQuerySchema,
} from './schedule.validation';
import {
  listSchedule,
  assignScheduleLine,
  driverAvailability,
  scheduleStock,
  tripHistory,
  scheduleWeek,
} from './schedule.service';
import { DRIVER_FEE_BASE, DRIVER_FEE_ADDONS } from '../../utils/driverFee';

export async function listScheduleController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = listScheduleQuerySchema.parse(req.query);
    const data = await listSchedule(query);
    res.json({ status: 'success', ...data });
  } catch (err) {
    next(err);
  }
}

export async function assignScheduleLineController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = assignScheduleLineSchema.parse(req.body);
    const data = await assignScheduleLine(req.params.id, input);
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
}

export async function driverAvailabilityController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = driverAvailabilityQuerySchema.parse(req.query);
    const data = await driverAvailability(query);
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
}

export async function scheduleStockController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = scheduleStockQuerySchema.parse(req.query);
    const data = await scheduleStock(query);
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
}

export async function tripHistoryController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = tripHistoryQuerySchema.parse(req.query);
    const data = await tripHistory(query);
    res.json({ status: 'success', ...data });
  } catch (err) {
    next(err);
  }
}

export async function scheduleWeekController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = scheduleWeekQuerySchema.parse(req.query);
    const data = await scheduleWeek(query);
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
}

/** The driver fee table (quick buttons in "Edit Hari"). */
export function driverFeePresetsController(_req: Request, res: Response): void {
  res.json({
    status: 'success',
    data: { base: DRIVER_FEE_BASE, addons: DRIVER_FEE_ADDONS },
  });
}
