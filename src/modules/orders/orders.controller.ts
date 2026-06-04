import { Request, Response, NextFunction } from "express";
import {
  createOrderSchema,
  updateOrderSchema,
  assignOrderSchema,
  createAdjustmentSchema,
  createChangeLogSchema,
} from "./orders.validation";
import {
  createOrder,
  listOrders,
  getOrderById,
  updateOrder,
  assignOrder,
  createOrderAdjustment,
  createOrderChangeLog,
} from "./orders.service";
import {
  generateInvoiceController,
  getInvoiceByOrderController,
  reviseInvoiceController,
  sendInvoiceWhatsappController,
} from "../invoices/invoices.controller";

export async function createOrderController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = createOrderSchema.parse(req.body);
    const order = await createOrder(input);
    res.status(201).json({ status: "success", data: order });
  } catch (err) {
    next(err);
  }
}

export async function listOrdersController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const orders = await listOrders();
    res.json({ status: "success", data: orders });
  } catch (err) {
    next(err);
  }
}

export async function getOrderByIdController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const order = await getOrderById(req.params.id);
    res.json({ status: "success", data: order });
  } catch (err) {
    next(err);
  }
}

export async function updateOrderController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = updateOrderSchema.parse(req.body);
    const order = await updateOrder(req.params.id, input);
    res.json({ status: "success", data: order });
  } catch (err) {
    next(err);
  }
}

export async function assignOrderController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = assignOrderSchema.parse(req.body);
    const trip = await assignOrder(req.params.id, input);
    res.status(201).json({ status: "success", data: trip });
  } catch (err) {
    next(err);
  }
}

export async function createOrderAdjustmentController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = createAdjustmentSchema.parse(req.body);
    const adjustment = await createOrderAdjustment(req.params.id, input);
    res.status(201).json({ status: "success", data: adjustment });
  } catch (err) {
    next(err);
  }
}

export async function createOrderChangeLogController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = createChangeLogSchema.parse(req.body);
    const log = await createOrderChangeLog(req.params.id, input);
    res.status(201).json({ status: "success", data: log });
  } catch (err) {
    next(err);
  }
}

export {
  generateInvoiceController,
  getInvoiceByOrderController,
  reviseInvoiceController,
  sendInvoiceWhatsappController,
};
