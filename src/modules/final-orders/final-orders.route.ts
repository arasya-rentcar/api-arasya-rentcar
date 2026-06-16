import { Router } from "express";
import { verifyTokenMiddleware, requireRole } from "../../middleware/auth.middleware";
import { getFinalOrderByIdController, listFinalOrdersController } from "./final-orders.controller";

const router = Router();

router.use(verifyTokenMiddleware, requireRole("ADMIN"));
router.get("/", listFinalOrdersController);
router.get("/:id", getFinalOrderByIdController);

export default router;
