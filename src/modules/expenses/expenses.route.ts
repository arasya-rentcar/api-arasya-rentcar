import { Router } from 'express';
import { verifyTokenMiddleware } from '../../middleware/auth.middleware';
import {
  createExpenseController,
  listExpensesController,
} from './expenses.controller';

// Merge: expenses now hang off a service-day LINE (the line IS the trip).
// `:id` is the order_service_item id. Accessible by ADMIN and DRIVER
// (ownership is enforced in the service for drivers).
const router = Router();

router.use(verifyTokenMiddleware);

router.post('/:id/expenses', createExpenseController);
router.get('/:id/expenses', listExpensesController);

export default router;
