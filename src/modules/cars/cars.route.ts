import { Router } from 'express';
import { verifyTokenMiddleware, requireRole } from '../../middleware/auth.middleware';
import {
  createCarController,
  listCarsController,
  getCarByIdController,
  updateCarController,
} from './cars.controller';

const router = Router();

router.use(verifyTokenMiddleware, requireRole('ADMIN'));

router.post('/', createCarController);
router.get('/', listCarsController);
router.get('/:id', getCarByIdController);
router.put('/:id', updateCarController);

export default router;
