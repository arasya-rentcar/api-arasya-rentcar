import { Request, Response, NextFunction } from "express";
import {
  botAssignSchema,
  botCreateOrderSchema,
  botFinishSchema,
  botReportSchema,
} from "./bot.validation";
import {
  assignBotOrder,
  createBotOrder,
  createBotReport,
  findCarByQuery,
  findDriverByName,
  findDriverByPhone,
  finishBotOrder,
  getActiveOrderByDriverPhone,
  getOrderByCode,
  markDriverMessageSent,
  startBotOrder,
} from "./bot.service";

export async function createBotOrderController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const input = botCreateOrderSchema.parse(req.body);
    const order = await createBotOrder(input);
    res.status(201).json({ status: "success", data: order });
  } catch (err) {
    next(err);
  }
}

export async function assignBotOrderController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const input = botAssignSchema.parse(req.body);
    const trip = await assignBotOrder(req.params.id, input);
    res.status(201).json({ status: "success", data: trip });
  } catch (err) {
    next(err);
  }
}

export async function markDriverMessageSentController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const order = await markDriverMessageSent(req.params.id);
    res.json({ status: "success", data: order });
  } catch (err) {
    next(err);
  }
}

export async function createBotReportController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const input = botReportSchema.parse(req.body);
    const report = await createBotReport(req.params.id, input);
    res.status(201).json({ status: "success", data: report });
  } catch (err) {
    next(err);
  }
}

export async function startBotOrderController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const report = req.body?.report
      ? botReportSchema.parse(req.body.report)
      : undefined;
    const data = await startBotOrder(req.params.id, report);
    res.json({ status: "success", data });
  } catch (err) {
    next(err);
  }
}

export async function finishBotOrderController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const input = botFinishSchema.parse(req.body || {});
    const data = await finishBotOrder(req.params.id, input);
    res.json({ status: "success", data });
  } catch (err) {
    next(err);
  }
}

export async function getBotOrderByCodeController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const order = await getOrderByCode(req.params.orderCode);
    res.json({ status: "success", data: order });
  } catch (err) {
    next(err);
  }
}

export async function getActiveOrderByDriverPhoneController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const order = await getActiveOrderByDriverPhone(req.params.phone);
    res.json({ status: "success", data: order });
  } catch (err) {
    next(err);
  }
}

export async function getDriverByPhoneController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const driver = await findDriverByPhone(req.params.phone);
    res.json({ status: "success", data: driver });
  } catch (err) {
    next(err);
  }
}

export async function matchDriverController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const driver =
      (await findDriverByName(String(req.query.q || ""))) ||
      (await findDriverByPhone(String(req.query.q || "")));
    res.json({ status: "success", data: driver });
  } catch (err) {
    next(err);
  }
}

export async function matchCarController(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const car = await findCarByQuery(String(req.query.q || ""));
    res.json({ status: "success", data: car });
  } catch (err) {
    next(err);
  }
}
