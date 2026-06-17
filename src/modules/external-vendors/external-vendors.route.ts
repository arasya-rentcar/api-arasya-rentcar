import { Router } from 'express';
import {
  verifyTokenMiddleware,
  requireRole,
} from '../../middleware/auth.middleware';
import {
  createVendorController,
  listVendorsController,
  getVendorByIdController,
  updateVendorController,
  deleteVendorController,
  addVendorCarController,
  updateVendorCarController,
  deleteVendorCarController,
} from './external-vendors.controller';

const router = Router();

router.use(verifyTokenMiddleware, requireRole('ADMIN'));

router.post('/', createVendorController);
router.get('/', listVendorsController);
router.get('/:id', getVendorByIdController);
router.put('/:id', updateVendorController);
router.delete('/:id', deleteVendorController);

// Vendor cars
router.post('/:id/cars', addVendorCarController);
router.put('/cars/:carId', updateVendorCarController);
router.delete('/cars/:carId', deleteVendorCarController);

export default router;
