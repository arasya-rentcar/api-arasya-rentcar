import { DriverRequest, Prisma } from "@prisma/client";
import prisma from "../../prisma/client";
import { AppError } from "../../utils/AppError";
import { pushToDriver } from "../../services/push.service";
import { notifyDriverRequest, rupiah } from "../../services/adminNotify";
import { eventTime } from "../driver-app/driver-app.service";
import type { CreateDriverRequestInput } from "../driver-app/driver-app.validation";
import { addTransactionTx, cardLabel, heldCards } from "../etoll-cards/etoll-cards.service";

/**
 * Requests a driver sends from the app to the office (2026-10-04): an e-toll
 * top-up for now. Exactly-once like the trip actions: the phone's client_ref
 * is unique, so a resend returns the stored request. A request about an office
 * card (card_id) is one OPEN request per card, whoever asked; one without a
 * card (older app versions) stays one OPEN request per driver and type. A
 * second one returns the open one (already_open). Admins are told through the
 * dashboard notification feed; the driver gets a push + inbox row when an
 * admin marks it done, which also records the top-up on the card.
 */

export function toRequest(r: DriverRequest) {
  return {
    id: r.id,
    driver_id: r.driver_id,
    type: r.type,
    card_id: r.card_id,
    card_label: r.card_label,
    balance: r.balance == null ? null : Number(r.balance),
    note: r.note,
    status: r.status,
    client_ref: r.client_ref,
    created_at: r.created_at,
    handled_at: r.handled_at,
    handled_by: r.handled_by,
    handled_note: r.handled_note,
  };
}

const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

export async function createDriverRequest(driverId: string, input: CreateDriverRequestInput) {
  const stored = async () => {
    const r = await prisma.driverRequest.findUnique({ where: { client_ref: input.client_ref } });
    if (r && r.driver_id !== driverId) throw new AppError("client_ref already used", 409);
    return r;
  };
  const existing = await stored();
  if (existing) return { created: false, request: toRequest(existing) };

  const driver = await prisma.driver.findUnique({ where: { id: driverId }, select: { etoll_card: true } });
  // Older app versions send no card_id but show the card the driver holds:
  // a request for that card (or without a label) is about that card.
  let cardId = input.card_id;
  if (!cardId) {
    const held = await heldCards(driverId);
    if (held.length === 1 && (!input.card_label || input.card_label === cardLabel(held[0]))) cardId = held[0].id;
  }
  const card = cardId ? await prisma.etollCard.findUnique({ where: { id: cardId } }) : null;
  if (cardId && !card) throw new AppError("Kartu e-toll tidak ditemukan", 404);
  if (card && card.status !== "ACTIVE") throw new AppError("Kartu ini sudah tidak dipakai", 409);
  let result: { created: boolean; already_open?: boolean; request: DriverRequest };
  try {
    result = await prisma.$transaction(async (tx) => {
      // One OPEN request per card (or per driver and type without a card),
      // also when two arrive at the same moment: serialise on that row.
      if (card) await tx.$queryRaw`SELECT id FROM etoll_cards WHERE id = ${card.id} FOR UPDATE`;
      else await tx.$queryRaw`SELECT id FROM drivers WHERE id = ${driverId} FOR UPDATE`;
      const open = await tx.driverRequest.findFirst({
        where: card
          ? { card_id: card.id, type: input.type, status: "OPEN" }
          : { driver_id: driverId, type: input.type, status: "OPEN" },
        orderBy: { created_at: "desc" },
      });
      if (open) return { created: false, already_open: true, request: open };
      const at = eventTime(input.occurred_at);
      const request = await tx.driverRequest.create({
        data: {
          driver_id: driverId,
          type: input.type,
          card_id: card?.id ?? null,
          card_label: card ? cardLabel(card) : (input.card_label ?? driver?.etoll_card ?? null),
          balance: input.balance == null ? null : Math.round(input.balance),
          note: input.note ?? null,
          client_ref: input.client_ref,
          created_at: at,
        },
      });
      // The balance the driver typed is what the card had then.
      if (card && input.balance != null) {
        await addTransactionTx(tx, card.id, {
          type: "BALANCE_CHECK",
          balance_after: Math.round(input.balance),
          occurred_at: at,
          driver_id: driverId,
          request_id: request.id,
          note: "Saat minta top-up",
        });
      }
      return { created: true, request };
    });
  } catch (err) {
    // The same request sent twice at once: the other copy was stored.
    if (!isUniqueViolation(err)) throw err;
    const again = await stored();
    if (!again) throw err;
    return { created: false, request: toRequest(again) };
  }
  const request = toRequest(result.request);
  if (result.created) await notifyDriverRequest(request);
  // Another driver's open request for the same card: not their note to read.
  if (request.driver_id !== driverId) request.note = null;
  return { created: result.created, already_open: result.already_open, request };
}

/** The driver's own requests, newest first. */
export async function listOwnRequests(driverId: string, status: "open" | "all") {
  const rows = await prisma.driverRequest.findMany({
    where: { driver_id: driverId, ...(status === "open" ? { status: "OPEN" as const } : {}) },
    orderBy: { created_at: "desc" },
    take: 20,
  });
  return { items: rows.map(toRequest) };
}

const driverSelect = { select: { id: true, name: true, phone: true } } as const;
const cardSelect = {
  select: { id: true, issuer: true, name: true, card_number: true, balance: true, balance_at: true, status: true },
} as const;
type RequestCard = { id: string; issuer: string; name: string; card_number: string; balance: Prisma.Decimal | null; balance_at: Date | null; status: string };
const toRequestCard = (c: RequestCard | null) =>
  c && { ...c, label: cardLabel(c), balance: c.balance == null ? null : Number(c.balance) };

/** Admin list: newest first, with the driver's name and phone only and the card. */
export async function listRequests(status: "OPEN" | "DONE" | "CANCELLED" | "ALL") {
  const rows = await prisma.driverRequest.findMany({
    where: status === "ALL" ? {} : { status },
    orderBy: { created_at: "desc" },
    include: { driver: driverSelect, card: cardSelect },
    take: 200,
  });
  return { items: rows.map((r) => ({ ...toRequest(r), driver: r.driver, card: toRequestCard(r.card) })) };
}

const DONE_TITLE: Record<string, string> = {
  ETOLL_TOPUP: "Top-up e-toll sudah diproses",
};

/**
 * Admin marks a request done. Conditional (OPEN → DONE only), so a double
 * click or a second admin gets 409 and the driver is told once. With the
 * amount it also records the top-up on the card (the request's card, or the
 * one the admin picked for a request from an older app) in the same
 * transaction. The money only reaches the chip once the driver taps the card
 * to update the balance, so the push says so.
 */
export async function markRequestDone(
  id: string,
  adminUserId: string,
  input: { note?: string; card_id?: string; amount?: number; balance_after?: number } = {},
) {
  const { note, amount } = input;
  const existing = await prisma.driverRequest.findUnique({ where: { id } });
  if (!existing) throw new AppError("Permintaan tidak ditemukan", 404);
  const cardId = input.card_id ?? existing.card_id;
  if (amount != null && !cardId) throw new AppError("Pilih kartu yang diisi", 400);
  const card = cardId ? await prisma.etollCard.findUnique({ where: { id: cardId } }) : null;
  if (cardId && !card) throw new AppError("Kartu e-toll tidak ditemukan", 404);
  if (card && card.status !== "ACTIVE" && card.id !== existing.card_id) {
    throw new AppError("Kartu ini sudah dinonaktifkan", 409);
  }

  const count = await prisma.$transaction(async (tx) => {
    if (card) await tx.$queryRaw`SELECT id FROM etoll_cards WHERE id = ${card.id} FOR UPDATE`;
    const { count } = await tx.driverRequest.updateMany({
      where: { id, status: "OPEN" },
      data: {
        status: "DONE",
        handled_at: new Date(),
        handled_by: adminUserId,
        handled_note: note ?? null,
        ...(card ? { card_id: card.id, card_label: cardLabel(card) } : {}),
      },
    });
    if (count > 0 && card && amount != null) {
      await addTransactionTx(tx, card.id, {
        type: "TOPUP",
        amount,
        balance_after: input.balance_after ?? null,
        driver_id: existing.driver_id,
        request_id: id,
        note: note ?? null,
        created_by: adminUserId,
      });
    }
    return count;
  });
  const r = await prisma.driverRequest.findUniqueOrThrow({ where: { id }, include: { driver: driverSelect, card: cardSelect } });
  if (count === 0) {
    throw new AppError(
      r.status === "DONE" ? "Permintaan ini sudah diproses." : "Permintaan ini sudah dibatalkan.",
      409,
    );
  }
  // "Kartu Flazz 3 ••••5678"; the label the driver typed on an older app.
  const cardName = r.card
    ? `Kartu ${r.card.name.replace(/^kartu\s+/i, "")} ••••${r.card.card_number.slice(-4)}`
    : r.card_label
      ? `Kartu ${r.card_label.replace(/^kartu\s+/i, "")}`
      : "Saldo e-toll";
  const head =
    amount != null ? `${cardName} sudah diisi ${rupiah(amount)}.` : note ? `${cardName}.` : `${cardName} sudah diisi.`;
  await pushToDriver(r.driver_id, {
    title: DONE_TITLE[r.type] ?? "Permintaan sudah diproses",
    body: [head, note, "Jangan lupa update saldo kartu (tempel kartu) sebelum masuk tol."].filter(Boolean).join(" "),
    data: { type: "driver_request_done", request_id: r.id, request_type: r.type },
  });
  return { request: { ...toRequest(r), driver: r.driver, card: toRequestCard(r.card) } };
}
