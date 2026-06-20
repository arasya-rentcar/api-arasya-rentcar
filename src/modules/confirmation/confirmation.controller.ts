import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  sendLineConfirmation,
  runDailyConfirmationSweep,
} from './confirmation.service';

const sendBodySchema = z
  .object({
    include_driver: z.boolean().optional(),
    force: z.boolean().optional(),
  })
  .strict()
  .optional();

/** POST /schedule/lines/:id/send-confirmation */
export async function sendLineConfirmationController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const body = sendBodySchema.parse(req.body) ?? {};
    const data = await sendLineConfirmation(req.params.id, {
      includeDriver: body.include_driver,
      force: body.force,
    });
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
}

/** POST /schedule/confirmation-sweep — manual trigger of the H-1 cron worker. */
export async function runConfirmationSweepController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await runDailyConfirmationSweep();
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
}
