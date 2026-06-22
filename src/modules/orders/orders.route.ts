import { Router } from "express";
import multer from "multer";
import {
  verifyTokenMiddleware,
  requireRole,
} from "../../middleware/auth.middleware";

// Sprint 3: in-memory upload for payment proof (validated in the service layer).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});
import {
  createOrderController,
  listOrdersController,
  searchOrdersController,
  getOrderByIdController,
  upsertOrderFinanceController,
  updateOrderController,
  assignOrderController,
  createOrderAdjustmentController,
  createOrderChangeLogController,
  generateInvoiceController,
  getInvoiceByOrderController,
  reviseInvoiceController,
  sendInvoiceWhatsappController,
  sendReceiptWhatsappController,
  markInvoicePaidController,
  getOrderStatementController,
  getPaymentProofController,
  markOrderRefundedController,
  getRefundProofController,
} from "./orders.controller";

const router = Router();

router.use(verifyTokenMiddleware, requireRole("ADMIN"));

router.post("/", createOrderController);
router.get("/", listOrdersController);
router.get("/search", searchOrdersController);
router.get("/:id", getOrderByIdController);
router.put("/:id", updateOrderController);
router.put("/:id/finance", upsertOrderFinanceController);
router.post("/:id/assign", assignOrderController);
router.post("/:id/adjustments", createOrderAdjustmentController);
router.post("/:id/change-logs", createOrderChangeLogController);
router.post("/:id/generate-invoice", generateInvoiceController);
router.get("/:id/invoice", getInvoiceByOrderController);
router.get("/:id/statement", getOrderStatementController);
// POST variant carries an optional { invoice_ids: string[] } selection.
router.post("/:id/statement", getOrderStatementController);
router.post("/:id/invoice/:invoiceId/revise", reviseInvoiceController);
// mark-paid requires a payment proof file (field name: "proof").
router.post(
  "/:id/invoice/:invoiceId/mark-paid",
  upload.single("proof"),
  markInvoicePaidController,
);
// Fetch a short-lived signed URL to view the payment proof.
router.get(
  "/:id/invoice/:invoiceId/payment-proof",
  getPaymentProofController,
);
router.post(
  "/:id/invoice/:invoiceId/send-whatsapp",
  sendInvoiceWhatsappController,
);
router.post(
  "/:id/invoice/:invoiceId/send-receipt-whatsapp",
  sendReceiptWhatsappController,
);
// Sprint 5: mark a refund settled. Refund proof file REQUIRED (field "proof").
router.post(
  "/:id/mark-refunded",
  upload.single("proof"),
  markOrderRefundedController,
);
// Signed URL to view the refund proof.
router.get("/:id/refund-proof", getRefundProofController);

export default router;
