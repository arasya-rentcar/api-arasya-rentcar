import { Router } from "express";
import { z } from "zod";
import { verifyTokenMiddleware, requireRole } from "../../middleware/auth.middleware";
import { listRequests, markRequestDone } from "./driver-requests.service";

/** Admin side of the driver requests (e-toll top-up): list and mark done (with the top-up amount). */
const listQuerySchema = z.object({
  status: z.preprocess(
    (v) => (typeof v === "string" ? v.toUpperCase() : v),
    z.enum(["OPEN", "DONE", "CANCELLED", "ALL"]).default("OPEN"),
  ),
});
const blank = (v: unknown) => (v === "" || v === null ? undefined : v);
const rupiah = z.preprocess(blank, z.coerce.number().min(0).max(100_000_000).optional());
const doneSchema = z.object({
  note: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .transform((v) => v || undefined),
  // Top-up amount; recorded on the card (the request's, or card_id for a
  // request from an older app that names no office card).
  card_id: z.preprocess(blank, z.string().uuid().optional()),
  amount: rupiah.refine((v) => v == null || v > 0, "Nominal top-up harus lebih dari 0"),
  // Balance after the top-up, when m-banking showed it.
  balance_after: rupiah,
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
    const input = doneSchema.parse(req.body ?? {});
    res.json({ status: "success", data: await markRequestDone(req.params.id, req.user!.user_id, input) });
  } catch (err) {
    next(err);
  }
});

export default router;
