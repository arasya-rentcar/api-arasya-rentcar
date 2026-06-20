import { Router } from 'express';
import {
  verifyTokenMiddleware,
  requireRole,
} from '../../middleware/auth.middleware';
import {
  listScheduleController,
  assignScheduleLineController,
  driverAvailabilityController,
  scheduleStockController,
} from './schedule.controller';
import {
  sendLineConfirmationController,
  runConfirmationSweepController,
} from '../confirmation/confirmation.controller';

const router = Router();

router.use(verifyTokenMiddleware, requireRole('ADMIN'));

router.get('/', listScheduleController);
router.get('/driver-availability', driverAvailabilityController);
router.get('/stock', scheduleStockController);
router.put('/lines/:id', assignScheduleLineController);
// #A1/#A2 trip-team confirmation messaging.
router.post('/lines/:id/send-confirmation', sendLineConfirmationController);
router.post('/confirmation-sweep', runConfirmationSweepController);

export default router;
