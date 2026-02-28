import { Router } from 'express';
import { verifyTokenMiddleware, requireRole } from '../../middleware/auth.middleware';
import {
  createDriverController,
  listDriversController,
  getDriverByIdController,
  updateDriverController,
  getMyTripController,
} from './drivers.controller';

const router = Router();

router.use(verifyTokenMiddleware);

// DRIVER routes – must come before /:id to avoid conflict
router.get('/me/trip', requireRole('DRIVER'), getMyTripController);

// ADMIN routes
router.post('/', requireRole('ADMIN'), createDriverController);
router.get('/', requireRole('ADMIN'), listDriversController);
router.get('/:id', requireRole('ADMIN'), getDriverByIdController);
router.put('/:id', requireRole('ADMIN'), updateDriverController);

export default router;
