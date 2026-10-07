import { Request, Response, NextFunction } from "express";
import { logger } from "../../config/logger";
import {
  ignoreLeadSchema,
  linkLeadSchema,
  listLeadsQuerySchema,
  publicLeadSchema,
} from "./leads.validation";
import {
  createPublicLead,
  getLead,
  ignoreLead,
  linkLeadToOrder,
  listLeads,
  reopenLead,
} from "./leads.service";

/**
 * Public intake. Always answers 204 so the form never shows an error to the
 * visitor (they are already on their way to WhatsApp); bad input is logged.
 * The body may arrive as text/plain (navigator.sendBeacon) or JSON.
 */
export async function createPublicLeadController(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    const parsed = publicLeadSchema.safeParse(body);
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues }, "web lead rejected");
    } else if (!parsed.data.website) {
      await createPublicLead(parsed.data);
    }
  } catch (err) {
    // A body that is not JSON: the parser's message quotes part of it (name,
    // map points), so only the fact is logged.
    if (err instanceof SyntaxError) logger.warn("web lead rejected: body is not JSON");
    else logger.error({ err }, "web lead intake failed");
  }
  res.status(204).end();
}

export async function listLeadsController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await listLeads(listLeadsQuerySchema.parse(req.query));
    res.json({ status: "success", ...result });
  } catch (err) {
    next(err);
  }
}

export async function getLeadController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    res.json({ status: "success", data: await getLead(req.params.id) });
  } catch (err) {
    next(err);
  }
}

export async function ignoreLeadController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { reason } = ignoreLeadSchema.parse(req.body ?? {});
    res.json({ status: "success", data: await ignoreLead(req.params.id, reason) });
  } catch (err) {
    next(err);
  }
}

export async function reopenLeadController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    res.json({ status: "success", data: await reopenLead(req.params.id) });
  } catch (err) {
    next(err);
  }
}

export async function linkLeadController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { order_id } = linkLeadSchema.parse(req.body);
    res.json({
      status: "success",
      data: await linkLeadToOrder(req.params.id, order_id),
    });
  } catch (err) {
    next(err);
  }
}
