import { Router } from 'express';
import {
  verifyTokenMiddleware,
  requireRole,
} from '../../middleware/auth.middleware';
import {
  dashboardAnalyticsController,
  revenueReportController,
} from './analytics.controller';

const router = Router();

router.use(verifyTokenMiddleware, requireRole('ADMIN'));

router.get('/dashboard', dashboardAnalyticsController);
router.get('/revenue', revenueReportController);

export default router;
