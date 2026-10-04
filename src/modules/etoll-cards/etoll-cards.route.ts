import { Router, Request, Response, NextFunction } from "express";
import { verifyTokenMiddleware, requireRole } from "../../middleware/auth.middleware";
import {
  addTransactionSchema,
  createCardSchema,
  giveCardSchema,
  listCardsQuerySchema,
  returnCardSchema,
  updateCardSchema,
  voidTransactionSchema,
} from "./etoll-cards.validation";
import {
  addTransaction,
  adminGiveCard,
  adminReturnCard,
  createCard,
  deleteCard,
  getCardHistory,
  listCards,
  updateCard,
  voidTransaction,
} from "./etoll-cards.service";

/** Admin side of the office e-toll cards; the driver side is /driver/etoll-cards. */
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

router.get("/", h((req) => listCards(listCardsQuerySchema.parse(req.query).status)));
router.post("/", h((req) => createCard(createCardSchema.parse(req.body ?? {}), admin(req)), 201));
// The card with its history (transactions + handovers, newest first).
router.get("/:id", h((req) => getCardHistory(req.params.id)));
router.patch("/:id", h((req) => updateCard(req.params.id, updateCardSchema.parse(req.body ?? {}), admin(req))));
router.delete("/:id", h((req) => deleteCard(req.params.id)));

// "Catat top-up / tol / saldo". 201 when stored, 200 for a resend (same client_ref).
router.post("/:id/transactions", async (req, res, next) => {
  try {
    const r = await addTransaction(req.params.id, addTransactionSchema.parse(req.body ?? {}), admin(req));
    res.status(r.created ? 201 : 200).json({ status: "success", data: { transaction: r.transaction, card: r.card } });
  } catch (err) {
    next(err);
  }
});
router.post(
  "/transactions/:txId/void",
  h((req) => voidTransaction(req.params.txId, admin(req), voidTransactionSchema.parse(req.body ?? {}).reason)),
);

// The office records who has the card ("Serahkan ke driver" / "Sudah kembali").
router.post("/:id/give", h((req) => adminGiveCard(req.params.id, giveCardSchema.parse(req.body ?? {}), admin(req))));
router.post("/:id/return", h((req) => adminReturnCard(req.params.id, returnCardSchema.parse(req.body ?? {}), admin(req))));

export default router;
