import { Router } from 'express';
import { verifyTokenMiddleware, requireRole } from '../../middleware/auth.middleware';
import {
  createOrderController,
  listOrdersController,
  getOrderByIdController,
  updateOrderController,
  assignOrderController,
  generateInvoiceController,
  getInvoiceByOrderController,
} from './orders.controller';

const router = Router();

router.use(verifyTokenMiddleware, requireRole('ADMIN'));

router.post('/', createOrderController);
router.get('/', listOrdersController);
router.get('/:id', getOrderByIdController);
router.put('/:id', updateOrderController);
router.post('/:id/assign', assignOrderController);
router.post('/:id/generate-invoice', generateInvoiceController);
router.get('/:id/invoice', getInvoiceByOrderController);

export default router;
