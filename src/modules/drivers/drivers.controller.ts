import { Request, Response, NextFunction } from 'express';
import { createDriverSchema, updateDriverSchema } from './drivers.validation';
import {
  createDriver,
  listDrivers,
  getDriverById,
  updateDriver,
  getMyActiveTrip,
} from './drivers.service';

export async function createDriverController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = createDriverSchema.parse(req.body);
    const driver = await createDriver(input);
    res.status(201).json({ status: 'success', data: driver });
  } catch (err) {
    next(err);
  }
}

export async function listDriversController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const drivers = await listDrivers();
    res.json({ status: 'success', data: drivers });
  } catch (err) {
    next(err);
  }
}

export async function getDriverByIdController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const driver = await getDriverById(req.params.id);
    res.json({ status: 'success', data: driver });
  } catch (err) {
    next(err);
  }
}

export async function updateDriverController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = updateDriverSchema.parse(req.body);
    const driver = await updateDriver(req.params.id, input);
    res.json({ status: 'success', data: driver });
  } catch (err) {
    next(err);
  }
}

export async function getMyTripController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const trip = await getMyActiveTrip(req.user!.user_id);
    res.json({ status: 'success', data: trip });
  } catch (err) {
    next(err);
  }
}
