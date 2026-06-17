import { Router } from 'express';
import {
  verifyTokenMiddleware,
  requireRole,
} from '../../middleware/auth.middleware';
import {
  listScheduleController,
  assignScheduleLineController,
  driverAvailabilityController,
} from './schedule.controller';

const router = Router();

router.use(verifyTokenMiddleware, requireRole('ADMIN'));

router.get('/', listScheduleController);
router.get('/driver-availability', driverAvailabilityController);
router.put('/lines/:id', assignScheduleLineController);

export default router;
