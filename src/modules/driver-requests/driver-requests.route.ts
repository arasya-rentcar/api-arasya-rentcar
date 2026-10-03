import { Router } from "express";
import { z } from "zod";
import { verifyTokenMiddleware, requireRole } from "../../middleware/auth.middleware";
import { listRequests, markRequestDone } from "./driver-requests.service";

/** Admin side of the driver requests (e-toll top-up): list and mark done. */
const listQuerySchema = z.object({
  status: z.preprocess(
    (v) => (typeof v === "string" ? v.toUpperCase() : v),
    z.enum(["OPEN", "DONE", "CANCELLED", "ALL"]).default("OPEN"),
  ),
});
const doneSchema = z.object({
  note: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .transform((v) => v || undefined),
});

const router = Router();
router.use(verifyTokenMiddleware, requireRole("ADMIN"));

router.get("/", async (req, res, next) => {
  try {
    res.json({ status: "success", data: await listRequests(listQuerySchema.parse(req.query).status) });
  } catch (err) {
    next(err);
  }
});

router.post("/:id/done", async (req, res, next) => {
  try {
    const { note } = doneSchema.parse(req.body ?? {});
    res.json({ status: "success", data: await markRequestDone(req.params.id, req.user!.user_id, note) });
  } catch (err) {
    next(err);
  }
});

export default router;
