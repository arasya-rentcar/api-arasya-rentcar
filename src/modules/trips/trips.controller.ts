import { Request, Response, NextFunction } from 'express';
import { nextStatusSchema } from './trips.validation';
import { getTripById, advanceTripStatus } from './trips.service';

export async function getTripController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const trip = await getTripById(req.params.id);
    res.json({ status: 'success', data: trip });
  } catch (err) {
    next(err);
  }
}

export async function nextStatusController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = nextStatusSchema.parse(req.body);
    const actor = req.user!.role;
    const trip = await advanceTripStatus(req.params.id, input, actor, req.user!.user_id);
    res.json({ status: 'success', data: trip });
  } catch (err) {
    next(err);
  }
}
