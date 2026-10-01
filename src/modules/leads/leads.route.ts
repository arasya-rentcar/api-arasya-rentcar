import express, { Router } from "express";
import cors from "cors";
import {
  verifyTokenMiddleware,
  requireRole,
} from "../../middleware/auth.middleware";
import { publicLeadLimiter } from "../../middleware/rateLimit.middleware";
import { env } from "../../config/env";
import {
  createPublicLeadController,
  getLeadController,
  ignoreLeadController,
  linkLeadController,
  listLeadsController,
  reopenLeadController,
} from "./leads.controller";

/** Admin: the "Lead Website" inbox. */
const router = Router();
router.use(verifyTokenMiddleware, requireRole("ADMIN"));
router.get("/", listLeadsController);
router.get("/:id", getLeadController);
router.post("/:id/ignore", ignoreLeadController);
router.post("/:id/reopen", reopenLeadController);
router.post("/:id/link", linkLeadController);
export default router;

/**
 * Public: the website's booking form. Mounted before the app-wide CORS
 * policy, with its own list of allowed origins (PUBLIC_LEAD_ORIGINS).
 */
const publicOrigins = env.PUBLIC_LEAD_ORIGINS.split(",")
  .map((o) => o.trim())
  .filter(Boolean);
export const publicLeadsRouter = Router();
publicLeadsRouter.use(
  cors({ origin: publicOrigins, methods: ["POST", "OPTIONS"] }),
);
publicLeadsRouter.post(
  "/",
  publicLeadLimiter,
  express.text({ type: "text/plain", limit: "16kb" }),
  express.json({ limit: "16kb" }),
  createPublicLeadController,
);
