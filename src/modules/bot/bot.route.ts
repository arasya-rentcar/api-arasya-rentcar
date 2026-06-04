import { Router } from "express";
import { verifyBotToken } from "../../middleware/bot.middleware";
import {
  assignBotOrderController,
  createBotOrderController,
  createBotReportController,
  finishBotOrderController,
  getActiveOrderByDriverPhoneController,
  getBotOrderByCodeController,
  getDriverByPhoneController,
  markDriverMessageSentController,
  matchCarController,
  matchDriverController,
  startBotOrderController,
} from "./bot.controller";

const router = Router();

router.use(verifyBotToken);

router.post("/orders", createBotOrderController);
router.post("/orders/:id/assign", assignBotOrderController);
router.post("/orders/:id/driver-message-sent", markDriverMessageSentController);
router.post("/orders/:id/reports", createBotReportController);
router.post("/orders/:id/start", startBotOrderController);
router.post("/orders/:id/finish", finishBotOrderController);
router.get("/orders/by-code/:orderCode", getBotOrderByCodeController);
router.get(
  "/active-order/by-driver-phone/:phone",
  getActiveOrderByDriverPhoneController,
);
router.get("/drivers/by-phone/:phone", getDriverByPhoneController);
router.get("/drivers/match", matchDriverController);
router.get("/cars/match", matchCarController);

export default router;
