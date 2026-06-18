import { Router } from 'express';
import {
  verifyTokenMiddleware,
  requireRole,
} from '../../middleware/auth.middleware';
import {
  listPayablesController,
  payablesSummaryController,
  getPayableController,
  updatePayableController,
  markPayablePaidController,
  markPayableUnpaidController,
  bulkMarkPaidController,
  driverPayableHistoryController,
  vendorPayableHistoryController,
} from './payables.controller';

const router = Router();

router.use(verifyTokenMiddleware, requireRole('ADMIN'));

router.get('/', listPayablesController);
router.get('/summary', payablesSummaryController);
router.post('/bulk-mark-paid', bulkMarkPaidController);
router.get('/driver/:id/history', driverPayableHistoryController);
router.get('/vendor/:id/history', vendorPayableHistoryController);
router.get('/:id', getPayableController);
router.put('/:id', updatePayableController);
router.post('/:id/mark-paid', markPayablePaidController);
router.post('/:id/mark-unpaid', markPayableUnpaidController);

export default router;
