import { Router, Request, Response, NextFunction } from "express";
import multer from "multer";
import { verifyTokenMiddleware, requireRole } from "../../middleware/auth.middleware";
import {
  actionSchema,
  finishSchema,
  notificationsQuerySchema,
  readNotificationsSchema,
  reportSchema,
  tripsQuerySchema,
} from "./driver-app.validation";
import {
  acceptTrip,
  addReport,
  arriveTrip,
  boardTrip,
  driverForUser,
  finishTrip,
  getTrip,
  listNotifications,
  listTrips,
  markNotificationsRead,
  startTrip,
} from "./driver-app.service";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

type Handler = (req: Request, driverId: string) => Promise<unknown>;
const h = (fn: Handler, status = 200) =>
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const driver = await driverForUser(req.user!.user_id);
      res.status(status).json({ status: "success", data: await fn(req, driver.id) });
    } catch (err) {
      next(err);
    }
  };

/** Driver mobile app (role DRIVER only). */
const router = Router();
router.use(verifyTokenMiddleware, requireRole("DRIVER"));

router.get("/me", async (req, res, next) => {
  try {
    const d = await driverForUser(req.user!.user_id);
    res.json({
      status: "success",
      data: { id: d.id, name: d.name, phone: d.phone, status: d.status, type: d.type },
    });
  } catch (err) {
    next(err);
  }
});
router.get("/trips", h((req, id) => listTrips(id, tripsQuerySchema.parse(req.query).scope)));
router.get("/trips/:id", h((req, id) => getTrip(id, req.params.id)));
const opts = (req: Request) => {
  const b = actionSchema.parse(req.body ?? {});
  return { occurredAt: b.occurred_at, clientRef: b.client_ref };
};
router.post("/trips/:id/accept", h((req, id) => acceptTrip(id, req.params.id, opts(req).occurredAt)));
router.post("/trips/:id/start", h((req, id) => startTrip(id, req.params.id, opts(req))));
router.post("/trips/:id/arrive", h((req, id) => {
  const b = actionSchema.parse(req.body ?? {});
  return arriveTrip(id, req.params.id, { occurredAt: b.occurred_at, clientRef: b.client_ref, location: b });
}));
// Customer on board: the trip begins (needs the order paid in full).
router.post("/trips/:id/board", h((req, id) => boardTrip(id, req.params.id, opts(req))));
router.post("/trips/:id/finish", h((req, id) => {
  const b = finishSchema.parse(req.body ?? {});
  return finishTrip(id, req.params.id, { notes: b.notes, occurredAt: b.occurred_at, clientRef: b.client_ref });
}));
router.post(
  "/trips/:id/reports",
  upload.single("photo"),
  h((req, id) => addReport(id, req.params.id, reportSchema.parse(req.body), req.file ?? undefined)),
);

// Inbox: every push sent to this driver, newest first, plus the unread count.
router.get("/notifications", h((req, id) => listNotifications(id, notificationsQuerySchema.parse(req.query))));
router.post("/notifications/read", h((req, id) => markNotificationsRead(id, readNotificationsSchema.parse(req.body ?? {}))));

export default router;
