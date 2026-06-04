import { Router } from "express";
import {
  verifyTokenMiddleware,
  requireRole,
} from "../../middleware/auth.middleware";
import {
  createOrderController,
  listOrdersController,
  getOrderByIdController,
  updateOrderController,
  assignOrderController,
  createOrderAdjustmentController,
  createOrderChangeLogController,
  generateInvoiceController,
  getInvoiceByOrderController,
  reviseInvoiceController,
  sendInvoiceWhatsappController,
} from "./orders.controller";

const router = Router();

router.use(verifyTokenMiddleware, requireRole("ADMIN"));

router.post("/", createOrderController);
router.get("/", listOrdersController);
router.get("/:id", getOrderByIdController);
router.put("/:id", updateOrderController);
router.post("/:id/assign", assignOrderController);
router.post("/:id/adjustments", createOrderAdjustmentController);
router.post("/:id/change-logs", createOrderChangeLogController);
router.post("/:id/generate-invoice", generateInvoiceController);
router.get("/:id/invoice", getInvoiceByOrderController);
router.post("/:id/invoice/:invoiceId/revise", reviseInvoiceController);
router.post(
  "/:id/invoice/:invoiceId/send-whatsapp",
  sendInvoiceWhatsappController,
);

export default router;
