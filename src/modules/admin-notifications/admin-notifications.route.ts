import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { verifyTokenMiddleware, requireRole } from "../../middleware/auth.middleware";
import {
  listAdminNotifications,
  markAdminNotificationsRead,
  notificationsSummary,
} from "./admin-notifications.service";

/**
 * Admin notification feed for the dashboard bell (/api/v1/notifications).
 * The driver app's own inbox is /api/v1/driver/notifications.
 */
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  before: z.string().datetime({ offset: true }).optional(),
  unread: z.preprocess((v) => v === "1" || v === "true" || v === true, z.boolean()).optional(),
});
const readSchema = z
  .object({
    ids: z.array(z.string().uuid()).max(200).optional(),
    all: z.boolean().optional(),
  })
  .refine((v) => v.all || (v.ids && v.ids.length > 0), { message: "ids or all is required" });

type Handler = (req: Request) => Promise<unknown>;
const h = (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ status: "success", data: await fn(req) });
  } catch (err) {
    next(err);
  }
};

const router = Router();
router.use(verifyTokenMiddleware, requireRole("ADMIN"));

router.get("/", h((req) => listAdminNotifications(req.user!.user_id, listQuerySchema.parse(req.query))));
router.get("/unread-count", h((req) => notificationsSummary(req.user!.user_id)));
router.post("/read", h((req) => markAdminNotificationsRead(req.user!.user_id, readSchema.parse(req.body ?? {}))));

export default router;
