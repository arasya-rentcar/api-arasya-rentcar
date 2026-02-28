import { Router } from 'express';
import { verifyTokenMiddleware } from '../../middleware/auth.middleware';
import { getTripController, nextStatusController } from './trips.controller';
import { createExpenseController, listExpensesController } from '../expenses/expenses.controller';

const router = Router();

router.use(verifyTokenMiddleware);

// Accessible by both ADMIN and DRIVER
router.get('/:id', getTripController);
router.post('/:id/next-status', nextStatusController);
router.post('/:id/expenses', createExpenseController);
router.get('/:id/expenses', listExpensesController);

export default router;
