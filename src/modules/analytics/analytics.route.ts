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

// Deprecated (8 Oct 2026): still the invoice-value formula and used by no
// dashboard page; /dashboard-v2 and /revenue are the finance figures. Kept
// for old clients; remove once nothing calls it.
router.get('/dashboard', (_req, res, next) => {
  res.set('Deprecation', 'true');
  res.set('Link', '</api/v1/analytics/dashboard-v2>; rel="successor-version"');
  next();
}, dashboardAnalyticsController);
router.get('/dashboard-v2', dashboardV2Controller);
router.get('/revenue', revenueReportController);

export default router;
