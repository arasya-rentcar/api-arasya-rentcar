import { Router } from 'express';
import {
  verifyTokenMiddleware,
  requireRole,
} from '../../middleware/auth.middleware';
import {
  createCustomerController,
  listCustomersController,
  getCustomerByIdController,
  updateCustomerController,
} from './customers.controller';

const router = Router();

router.use(verifyTokenMiddleware, requireRole('ADMIN'));

router.post('/', createCustomerController);
router.get('/', listCustomersController);
router.get('/:id', getCustomerByIdController);
router.put('/:id', updateCustomerController);

export default router;
