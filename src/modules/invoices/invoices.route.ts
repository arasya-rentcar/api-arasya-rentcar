import { Router } from "express";
import {
  verifyTokenMiddleware,
  requireRole,
} from "../../middleware/auth.middleware";
import { searchInvoicesController } from "./invoices.controller";

const router = Router();

router.use(verifyTokenMiddleware, requireRole("ADMIN"));

// Server-paginated invoices list (dashboard /invoices page).
router.get("/", searchInvoicesController);

export default router;
