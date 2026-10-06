import { Router, Request, Response, NextFunction } from "express";
import cors from "cors";
import { verifyTokenMiddleware, requireRole } from "../../middleware/auth.middleware";
import { publicPriceLimiter } from "../../middleware/rateLimit.middleware";
import { env } from "../../config/env";
import {
  createCarSchema,
  createSurchargeSchema,
  historyQuerySchema,
  publicationsQuerySchema,
  publishSchema,
  updateCarSchema,
  updateCitySchema,
  updateExtraSchema,
  updateRatesSchema,
  updateSurchargeSchema,
  updateZoneSchema,
} from "./prices.validation";
import {
  createCar,
  createSurcharge,
  deleteSurcharge,
  getHistory,
  getPriceList,
  getPublishedSnapshot,
  listPublications,
  publishPrices,
  updateCar,
  updateCity,
  updateExtra,
  updateRates,
  updateSurcharge,
  updateZone,
} from "./prices.service";

/** Admin: the official price list (working copy, history, publishing). */
type Handler = (req: Request) => Promise<unknown>;
const h = (fn: Handler, status = 200) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      res.status(status).json({ status: "success", data: await fn(req) });
    } catch (err) {
      next(err);
    }
  };
const admin = (req: Request) => req.user!.user_id;

const router = Router();
router.use(verifyTokenMiddleware, requireRole("ADMIN"));

// Every write answers with the whole list (same as GET /).
router.get("/", h(() => getPriceList()));
router.patch("/rates", h((req) => updateRates(updateRatesSchema.parse(req.body ?? {}).items, admin(req))));
router.post("/surcharges", h((req) => createSurcharge(createSurchargeSchema.parse(req.body ?? {}), admin(req)), 201));
router.patch("/surcharges/:id", h((req) => updateSurcharge(req.params.id, updateSurchargeSchema.parse(req.body ?? {}), admin(req))));
router.delete("/surcharges/:id", h((req) => deleteSurcharge(req.params.id, admin(req))));
router.patch("/zones/:id", h((req) => updateZone(req.params.id, updateZoneSchema.parse(req.body ?? {}), admin(req))));
router.patch("/extras/:id", h((req) => updateExtra(req.params.id, updateExtraSchema.parse(req.body ?? {}), admin(req))));
router.patch("/cities/:id", h((req) => updateCity(req.params.id, updateCitySchema.parse(req.body ?? {}), admin(req))));
router.post("/cars", h((req) => createCar(createCarSchema.parse(req.body ?? {}), admin(req)), 201));
router.patch("/cars/:id", h((req) => updateCar(req.params.id, updateCarSchema.parse(req.body ?? {}), admin(req))));

router.get("/history", h((req) => getHistory(historyQuerySchema.parse(req.query).limit)));
router.get("/publications", h((req) => listPublications(publicationsQuerySchema.parse(req.query).limit)));

// "Terbitkan ke website". 201 when published, 200 for a resend (same client_ref).
router.post("/publish", async (req, res, next) => {
  try {
    const r = await publishPrices(publishSchema.parse(req.body ?? {}), admin(req));
    res.status(r.created ? 201 : 200).json({ status: "success", data: { publication: r.publication, snapshot: r.snapshot } });
  } catch (err) {
    next(err);
  }
});

export default router;

/**
 * Public: the last published price list, read by the website build (server
 * side, no Origin header) and by the website in the browser. Mounted before
 * the app-wide CORS policy, with the website origins of the public leads form.
 */
const publicOrigins = env.PUBLIC_LEAD_ORIGINS.split(",")
  .map((o) => o.trim())
  .filter(Boolean);
export const publicPricesRouter = Router();
publicPricesRouter.use(cors({ origin: publicOrigins, methods: ["GET", "OPTIONS"] }));
publicPricesRouter.get("/", publicPriceLimiter, async (_req, res, next) => {
  try {
    const snapshot = await getPublishedSnapshot();
    // Only a real list is cached; "not published yet" is not.
    res.set("Cache-Control", "public, max-age=300");
    res.json({ status: "success", data: snapshot });
  } catch (err) {
    next(err);
  }
});
