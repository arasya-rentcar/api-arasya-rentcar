import { Request, Response, NextFunction } from 'express';
import {
  listScheduleQuerySchema,
  assignScheduleLineSchema,
  driverAvailabilityQuerySchema,
} from './schedule.validation';
import {
  listSchedule,
  assignScheduleLine,
  driverAvailability,
} from './schedule.service';

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
