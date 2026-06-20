import { Request, Response, NextFunction } from 'express';
import { dashboardAnalytics, revenueReport, dashboardV2 } from './analytics.service';

export async function dashboardAnalyticsController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await dashboardAnalytics({
      date_from: req.query.date_from as string | undefined,
      date_to: req.query.date_to as string | undefined,
    });
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
}

// Dashboard v2 — single-page owner/finance overview. Margin-leading,
// accrual + cash labelled, current outstanding + overdue, 6-month trend.
export async function dashboardV2Controller(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await dashboardV2({
      date_from: req.query.date_from as string | undefined,
      date_to: req.query.date_to as string | undefined,
    });
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
}

// #5 Revenue report (§4f): internal-car revenue + vendor margin, Final/Estimated.
export async function revenueReportController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await revenueReport({
      date_from: req.query.date_from as string | undefined,
      date_to: req.query.date_to as string | undefined,
    });
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
}
