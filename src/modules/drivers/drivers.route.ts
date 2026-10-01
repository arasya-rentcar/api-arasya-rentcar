import { Router } from 'express';
import { verifyTokenMiddleware, requireRole } from '../../middleware/auth.middleware';
import {
  createDriverController,
  listDriversController,
  getDriverByIdController,
  getDriverDetailController,
  updateDriverController,
  setDriverAppPasswordController,
  getMyTripController,
} from './drivers.controller';

const router = Router();

router.use(verifyTokenMiddleware);

// DRIVER routes – must come before /:id to avoid conflict
router.get('/me/trip', requireRole('DRIVER'), getMyTripController);

// ADMIN routes
router.post('/', requireRole('ADMIN'), createDriverController);
router.get('/', requireRole('ADMIN'), listDriversController);
router.get('/:id/detail', requireRole('ADMIN'), getDriverDetailController);
router.get('/:id', requireRole('ADMIN'), getDriverByIdController);
router.put('/:id', requireRole('ADMIN'), updateDriverController);
// Driver app login: admin sets (or resets) the password the driver uses with
// their phone number in the mobile app.
router.put('/:id/app-password', requireRole('ADMIN'), setDriverAppPasswordController);

export default router;
