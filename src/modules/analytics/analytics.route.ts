import { Router } from 'express';
import {
  verifyTokenMiddleware,
  requireRole,
} from '../../middleware/auth.middleware';
import {
  dashboardAnalyticsController,
  revenueReportController,
  dashboardV2Controller,
} from './analytics.controller';

const router = Router();

router.use(verifyTokenMiddleware, requireRole('ADMIN'));

router.get('/dashboard', dashboardAnalyticsController);
router.get('/dashboard-v2', dashboardV2Controller);
router.get('/revenue', revenueReportController);

export default router;
