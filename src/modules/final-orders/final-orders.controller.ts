import { Request, Response, NextFunction } from "express";
import { getFinalOrderById, listFinalOrders } from "./final-orders.service";
import { AppError } from "../../utils/AppError";

export async function listFinalOrdersController(_req: Request, res: Response, next: NextFunction) {
  try {
    const data = await listFinalOrders();
    res.json({ status: "success", data });
  } catch (err) {
    next(err);
  }
}

export async function getFinalOrderByIdController(req: Request, res: Response, next: NextFunction) {
  try {
    const data = await getFinalOrderById(req.params.id);
    if (!data) throw new AppError("Final order not found", 404);
    res.json({ status: "success", data });
  } catch (err) {
    next(err);
  }
}
