import { EtollCard, EtollCardHandover, EtollTransaction, Prisma } from "@prisma/client";
import prisma from "../../prisma/client";
import { AppError } from "../../utils/AppError";
import { eventTime } from "../driver-app/driver-app.service";
import { notifyAdmins } from "../../services/adminNotify";
import type { AddTransactionInput, CreateCardInput, UpdateCardInput } from "./etoll-cards.validation";

/**
 * Office e-toll cards (2026-10-04). The cards are a shared pool: a driver takes
 * one when a trip starts ("Ambil kartu") and returns it when back at the
 * garage; taking a card another driver still holds moves it over. History is
 * a list of transactions (top-ups, tolls, balance checks) that are voided,
 * never edited. The balance on the card row is an estimate, recomputed from
 * that history after every change (see recomputeBalance).
 *
 * Every change locks the card row first, so two phones or two admins acting
 * on one card at the same moment are applied one after the other.
 */

type Tx = Prisma.TransactionClient;

export const ISSUER_LABEL: Record<string, string> = {
  MANDIRI: "Mandiri e-Money",
  BCA: "BCA Flazz",
  BRI: "BRI Brizzi",
  BNI: "BNI TapCash",
  DKI: "JakCard",
  OTHER: "",
};

const last4 = (n: string) => n.slice(-4);

/** "BCA Flazz · Kartu 3 ••••5678": how drivers, messages and requests name a card. */
export function cardLabel(c: { issuer: string; name: string; card_number: string }): string {
  return [ISSUER_LABEL[c.issuer], `${c.name} ••••${last4(c.card_number)}`].filter(Boolean).join(" · ");
}

const num = (v: Prisma.Decimal | null) => (v == null ? null : Number(v));
const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
const later = (a: Date, b: Date) => (a.getTime() >= b.getTime() ? a : b);

async function lockCard(tx: Tx, cardId: string): Promise<EtollCard> {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM etoll_cards WHERE id = ${cardId} FOR UPDATE`;
  if (!rows.length) throw new AppError("Kartu e-toll tidak ditemukan", 404);
  return tx.etollCard.findUniqueOrThrow({ where: { id: cardId } });
}

/**
 * The estimate: the latest known balance (a balance check, or a top-up with
 * the balance after it), plus top-ups and minus tolls entered after it.
 * Unknown (null) until someone has read the balance once. balance_at is when
 * that known balance was read.
 */
export async function recomputeBalance(tx: Tx, cardId: string) {
  const anchor = await tx.etollTransaction.findFirst({
    where: { card_id: cardId, voided_at: null, balance_after: { not: null } },
    orderBy: [{ occurred_at: "desc" }, { created_at: "desc" }],
  });
  let balance: number | null = null;
  if (anchor) {
    balance = Number(anchor.balance_after);
    const since = await tx.etollTransaction.findMany({
      where: {
        card_id: cardId,
        voided_at: null,
        balance_after: null,
        OR: [
          { occurred_at: { gt: anchor.occurred_at } },
          { occurred_at: anchor.occurred_at, created_at: { gt: anchor.created_at } },
        ],
      },
      select: { type: true, amount: true },
    });
    for (const t of since) {
      if (t.amount == null) continue;
      if (t.type === "TOPUP") balance += Number(t.amount);
      else if (t.type === "TOLL") balance -= Number(t.amount);
    }
  }
  await tx.etollCard.update({
    where: { id: cardId },
    data: { balance, balance_at: anchor?.occurred_at ?? null },
  });
}

// ── Shapes returned to clients ──────────────────────────────────────────────
const holderInclude = {
  handovers: {
    where: { returned_at: null },
    include: { driver: { select: { id: true, name: true, phone: true } } },
    take: 1,
  },
  requests: {
    where: { status: "OPEN" as const },
    select: { id: true, driver_id: true, created_at: true },
    orderBy: { created_at: "desc" as const },
    take: 1,
  },
} satisfies Prisma.EtollCardInclude;
type CardWithHolder = Prisma.EtollCardGetPayload<{ include: typeof holderInclude }>;

/** Dashboard: the full card, who has it and an open top-up request. */
export function toCard(c: CardWithHolder) {
  const h = c.handovers[0];
  const r = c.requests[0];
  return {
    id: c.id,
    issuer: c.issuer,
    issuer_label: ISSUER_LABEL[c.issuer] ?? "",
    name: c.name,
    card_number: c.card_number,
    card_last4: last4(c.card_number),
    label: cardLabel(c),
    balance: num(c.balance),
    balance_at: c.balance_at,
    status: c.status,
    inactive_reason: c.inactive_reason,
    note: c.note,
    created_at: c.created_at,
    updated_at: c.updated_at,
    holder: h
      ? { handover_id: h.id, driver: h.driver, taken_at: h.taken_at, service_item_id: h.service_item_id }
      : null,
    open_request: r ? { id: r.id, driver_id: r.driver_id, created_at: r.created_at } : null,
  };
}

/** Driver app: the last four digits only, and who has it (name only). */
function toDriverCard(c: CardWithHolder, driverId: string) {
  const h = c.handovers[0];
  const r = c.requests[0];
  return {
    id: c.id,
    issuer: c.issuer,
    issuer_label: ISSUER_LABEL[c.issuer] ?? "",
    name: c.name,
    card_last4: last4(c.card_number),
    label: cardLabel(c),
    balance: num(c.balance),
    balance_at: c.balance_at,
    holder: h ? { mine: h.driver_id === driverId, name: h.driver.name, taken_at: h.taken_at } : null,
    open_request: r ? { id: r.id, mine: r.driver_id === driverId, created_at: r.created_at } : null,
  };
}

export function toTransaction(t: EtollTransaction & { driver?: { id: string; name: string } | null }) {
  return {
    id: t.id,
    card_id: t.card_id,
    type: t.type,
    amount: num(t.amount),
    balance_after: num(t.balance_after),
    source: t.source,
    occurred_at: t.occurred_at,
    driver: t.driver ?? null,
    request_id: t.request_id,
    handover_id: t.handover_id,
    service_item_id: t.service_item_id,
    note: t.note,
    created_by: t.created_by,
    created_at: t.created_at,
    voided_at: t.voided_at,
    voided_by: t.voided_by,
    void_reason: t.void_reason,
  };
}

function toHandover(h: EtollCardHandover & { driver?: { id: string; name: string; phone: string } }) {
  return {
    id: h.id,
    card_id: h.card_id,
    driver: h.driver ?? null,
    service_item_id: h.service_item_id,
    taken_at: h.taken_at,
    taken_by: h.taken_by,
    returned_at: h.returned_at,
    returned_by: h.returned_by,
    return_kind: h.return_kind,
  };
}

async function cardOut(cardId: string) {
  return toCard(await prisma.etollCard.findUniqueOrThrow({ where: { id: cardId }, include: holderInclude }));
}

// ── Admin: cards ────────────────────────────────────────────────────────────
export async function listCards(status: "ACTIVE" | "INACTIVE" | "ALL") {
  const rows = await prisma.etollCard.findMany({
    where: status === "ALL" ? {} : { status },
    include: holderInclude,
    orderBy: [{ status: "asc" }, { name: "asc" }],
  });
  return { items: rows.map(toCard) };
}

async function assertNumberFree(cardNumber: string, exceptId?: string) {
  const other = await prisma.etollCard.findUnique({ where: { card_number: cardNumber } });
  if (other && other.id !== exceptId) throw new AppError(`Nomor kartu sudah terdaftar (${other.name})`, 409);
}

export async function createCard(input: CreateCardInput, adminId: string) {
  await assertNumberFree(input.card_number);
  try {
    const card = await prisma.$transaction(async (tx) => {
      const c = await tx.etollCard.create({
        data: {
          issuer: input.issuer,
          name: input.name,
          card_number: input.card_number,
          note: input.note ?? null,
          created_by: adminId,
        },
      });
      if (input.balance != null) {
        await tx.etollTransaction.create({
          data: { card_id: c.id, type: "BALANCE_CHECK", balance_after: input.balance, note: "Saldo awal", created_by: adminId },
        });
        await recomputeBalance(tx, c.id);
      }
      return c;
    });
    return cardOut(card.id);
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError("Nomor kartu sudah terdaftar", 409);
    throw err;
  }
}

export async function getCard(id: string) {
  const c = await prisma.etollCard.findUnique({ where: { id }, include: holderInclude });
  if (!c) throw new AppError("Kartu e-toll tidak ditemukan", 404);
  return toCard(c);
}

/**
 * Edit, or deactivate (lost, broken, replaced). A deactivated card is closed
 * for whoever held it and its open top-up request is cancelled; its history
 * stays.
 */
export async function updateCard(id: string, input: UpdateCardInput, adminId: string) {
  if (input.card_number) await assertNumberFree(input.card_number, id);
  try {
    await prisma.$transaction(async (tx) => {
      const card = await lockCard(tx, id);
      const deactivate = input.status === "INACTIVE" && card.status !== "INACTIVE";
      await tx.etollCard.update({
        where: { id },
        data: {
          ...(input.issuer ? { issuer: input.issuer } : {}),
          ...(input.name ? { name: input.name } : {}),
          ...(input.card_number ? { card_number: input.card_number } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(input.status ? { status: input.status } : {}),
          ...(input.status === "ACTIVE"
            ? { inactive_reason: null }
            : input.inactive_reason !== undefined
              ? { inactive_reason: input.inactive_reason }
              : {}),
        },
      });
      if (deactivate) {
        const now = new Date();
        await tx.etollCardHandover.updateMany({
          where: { card_id: id, returned_at: null },
          data: { returned_at: now, returned_by: adminId, return_kind: "DEACTIVATED" },
        });
        await tx.driverRequest.updateMany({
          where: { card_id: id, status: "OPEN" },
          data: { status: "CANCELLED", handled_at: now, handled_by: adminId, handled_note: "Kartu dinonaktifkan" },
        });
      }
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError("Nomor kartu sudah terdaftar", 409);
    throw err;
  }
  return cardOut(id);
}

/** Only a card without any history (a typo); otherwise deactivate it. */
export async function deleteCard(id: string) {
  await prisma.$transaction(async (tx) => {
    await lockCard(tx, id);
    const [h, t, r] = await Promise.all([
      tx.etollCardHandover.count({ where: { card_id: id } }),
      tx.etollTransaction.count({ where: { card_id: id } }),
      tx.driverRequest.count({ where: { card_id: id } }),
    ]);
    if (h + t + r > 0) throw new AppError("Kartu ini sudah punya riwayat. Nonaktifkan saja.", 409);
    await tx.etollCard.delete({ where: { id } });
  });
  return { id, deleted: true };
}

/** Card detail: the card, its history (newest first) and who entered what. */
export async function getCardHistory(id: string) {
  const card = await getCard(id);
  const [transactions, handovers] = await Promise.all([
    prisma.etollTransaction.findMany({
      where: { card_id: id },
      include: { driver: { select: { id: true, name: true } } },
      orderBy: [{ occurred_at: "desc" }, { created_at: "desc" }],
      take: 500,
    }),
    prisma.etollCardHandover.findMany({
      where: { card_id: id },
      include: { driver: { select: { id: true, name: true, phone: true } } },
      orderBy: { taken_at: "desc" },
      take: 200,
    }),
  ]);
  const adminIds = new Set<string>();
  for (const t of transactions) for (const u of [t.created_by, t.voided_by]) if (u) adminIds.add(u);
  for (const h of handovers) for (const u of [h.taken_by, h.returned_by]) if (u) adminIds.add(u);
  const users = await prisma.user.findMany({ where: { id: { in: [...adminIds] } }, select: { id: true, email: true } });
  return {
    card,
    transactions: transactions.map(toTransaction),
    handovers: handovers.map(toHandover),
    users: Object.fromEntries(users.map((u) => [u.id, u.email])),
  };
}

// ── Transactions ────────────────────────────────────────────────────────────
type NewTransaction = {
  type: "TOPUP" | "TOLL" | "BALANCE_CHECK";
  amount?: number | null;
  balance_after?: number | null;
  source?: "MANUAL" | "NFC";
  occurred_at?: Date;
  driver_id?: string | null;
  request_id?: string | null;
  handover_id?: string | null;
  service_item_id?: string | null;
  note?: string | null;
  created_by?: string | null;
  client_ref?: string | null;
};

/** Inside a transaction that already locked the card. */
export async function addTransactionTx(tx: Tx, cardId: string, t: NewTransaction) {
  const row = await tx.etollTransaction.create({
    data: {
      card_id: cardId,
      type: t.type,
      amount: t.amount ?? null,
      balance_after: t.balance_after ?? null,
      source: t.source ?? "MANUAL",
      occurred_at: t.occurred_at ?? new Date(),
      driver_id: t.driver_id ?? null,
      request_id: t.request_id ?? null,
      handover_id: t.handover_id ?? null,
      service_item_id: t.service_item_id ?? null,
      note: t.note ?? null,
      created_by: t.created_by ?? null,
      client_ref: t.client_ref ?? null,
    },
  });
  await recomputeBalance(tx, cardId);
  return row;
}

/** Admin "Catat top-up / tol / saldo" (e.g. from the m-banking history). */
export async function addTransaction(cardId: string, input: AddTransactionInput, adminId: string) {
  if (input.client_ref) {
    const prev = await prisma.etollTransaction.findUnique({ where: { client_ref: input.client_ref } });
    if (prev) {
      if (prev.card_id !== cardId) throw new AppError("client_ref already used", 409);
      return { created: false, transaction: toTransaction(prev), card: await cardOut(cardId) };
    }
  }
  if (input.driver_id && !(await prisma.driver.findUnique({ where: { id: input.driver_id } }))) {
    throw new AppError("Driver tidak ditemukan", 404);
  }
  const now = new Date();
  const at = input.occurred_at ? new Date(Math.min(Date.parse(input.occurred_at), now.getTime())) : now;
  try {
    const row = await prisma.$transaction(async (tx) => {
      await lockCard(tx, cardId);
      return addTransactionTx(tx, cardId, {
        type: input.type,
        amount: input.type === "BALANCE_CHECK" ? null : input.amount,
        balance_after: input.balance_after,
        occurred_at: at,
        driver_id: input.driver_id,
        note: input.note,
        created_by: adminId,
        client_ref: input.client_ref,
      });
    });
    return { created: true, transaction: toTransaction(row), card: await cardOut(cardId) };
  } catch (err) {
    // The same entry sent twice at once: the other copy was stored.
    if (isUniqueViolation(err) && input.client_ref) {
      const again = await prisma.etollTransaction.findUnique({ where: { client_ref: input.client_ref } });
      if (again) return { created: false, transaction: toTransaction(again), card: await cardOut(cardId) };
    }
    throw err;
  }
}

/** A wrong entry is voided once (409 the second time); the balance follows. */
export async function voidTransaction(txId: string, adminId: string, reason?: string) {
  const t = await prisma.etollTransaction.findUnique({ where: { id: txId } });
  if (!t) throw new AppError("Transaksi tidak ditemukan", 404);
  await prisma.$transaction(async (tx) => {
    await lockCard(tx, t.card_id);
    const { count } = await tx.etollTransaction.updateMany({
      where: { id: txId, voided_at: null },
      data: { voided_at: new Date(), voided_by: adminId, void_reason: reason ?? null },
    });
    if (count === 0) throw new AppError("Transaksi ini sudah dibatalkan.", 409);
    await recomputeBalance(tx, t.card_id);
  });
  const row = await prisma.etollTransaction.findUniqueOrThrow({ where: { id: txId } });
  return { transaction: toTransaction(row), card: await cardOut(t.card_id) };
}

// ── Handovers ───────────────────────────────────────────────────────────────
type TakeInput = {
  cardId: string;
  driverId: string;
  at: Date;
  balance?: number;
  serviceItemId?: string | null;
  source?: "MANUAL" | "NFC";
  clientRef?: string;
  /** Admin user id when the office records it; undefined = the driver. */
  adminId?: string;
};

/**
 * A driver has the card now. Idempotent on client_ref; a card the same driver
 * already holds stays as it is; a card another driver holds moves over (their
 * handover closes as TAKEN_OVER). Admins are told when it really changed.
 */
async function takeCard(input: TakeInput) {
  const { cardId, driverId } = input;
  const byRef = async () => {
    if (!input.clientRef) return null;
    const h = await prisma.etollCardHandover.findUnique({ where: { client_ref: input.clientRef } });
    if (h && (h.driver_id !== driverId || h.card_id !== cardId)) throw new AppError("client_ref already used", 409);
    return h;
  };
  const prev = await byRef();
  if (prev) return { created: false, handover: prev, card: await cardOut(cardId) };

  let result: { created: boolean; handover: EtollCardHandover; from?: string | null };
  try {
    result = await prisma.$transaction(async (tx) => {
      const card = await lockCard(tx, cardId);
      if (card.status !== "ACTIVE") throw new AppError("Kartu ini sudah tidak dipakai", 409);
      const open = await tx.etollCardHandover.findFirst({
        where: { card_id: cardId, returned_at: null },
        include: { driver: { select: { name: true } } },
      });
      if (open && open.driver_id === driverId) return { created: false, handover: open };
      let at = input.at;
      if (open) {
        at = later(at, open.taken_at);
        await tx.etollCardHandover.update({
          where: { id: open.id },
          data: { returned_at: at, returned_by: input.adminId ?? null, return_kind: "TAKEN_OVER" },
        });
      }
      const handover = await tx.etollCardHandover.create({
        data: {
          card_id: cardId,
          driver_id: driverId,
          service_item_id: input.serviceItemId ?? null,
          taken_at: at,
          taken_by: input.adminId ?? null,
          client_ref: input.clientRef ?? null,
        },
      });
      if (input.balance != null) {
        await addTransactionTx(tx, cardId, {
          type: "BALANCE_CHECK",
          balance_after: input.balance,
          source: input.source,
          occurred_at: at,
          driver_id: driverId,
          handover_id: handover.id,
          service_item_id: input.serviceItemId,
          note: "Saat diambil",
          created_by: input.adminId ?? null,
        });
      }
      return { created: true, handover, from: open?.driver.name ?? null };
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // The same "Ambil kartu" sent twice at once, or two drivers at once.
    const again = await byRef();
    if (again) return { created: false, handover: again, card: await cardOut(cardId) };
    throw new AppError("Kartu baru saja diambil driver lain. Coba lagi.", 409);
  }
  const card = await cardOut(cardId);
  if (result.created) {
    const driver = await prisma.driver.findUnique({ where: { id: driverId }, select: { name: true } });
    await notifyAdmins({
      type: "ETOLL_CARD",
      title: `${driver?.name ?? "Driver"} ${input.adminId ? "diberi" : "mengambil"} kartu e-toll ${card.name}`,
      body: [
        card.label,
        result.from ? `sebelumnya dipegang ${result.from}` : null,
        input.balance != null ? `saldo ${rupiahText(input.balance)}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      driver_id: driverId,
      link: cardLink(cardId),
    });
  }
  return { created: result.created, handover: result.handover, card };
}

const driverSelect = { select: { id: true, name: true, phone: true } } as const;
type DriverRow = { id: string; name: string; phone: string };

type ReturnInput = {
  cardId: string;
  /** Only this driver's handover; undefined (admin) = whoever holds it. */
  driverId?: string;
  at: Date;
  balance?: number;
  source?: "MANUAL" | "NFC";
  returnRef?: string;
  adminId?: string;
};

/**
 * The card is back at the office. For the driver a resend, or a card someone
 * else took over meanwhile, is a no-op (returned: false); an admin returning a
 * card nobody holds gets 409.
 */
async function returnCard(input: ReturnInput) {
  const { cardId } = input;
  const byRef = async () => {
    if (!input.returnRef) return null;
    const h = await prisma.etollCardHandover.findUnique({ where: { return_ref: input.returnRef } });
    if (h && (h.card_id !== cardId || (input.driverId && h.driver_id !== input.driverId))) {
      throw new AppError("client_ref already used", 409);
    }
    return h;
  };
  const prev = await byRef();
  if (prev) return { returned: false, handover: prev, card: await cardOut(cardId) };

  let result: { returned: boolean; handover: (EtollCardHandover & { driver: DriverRow }) | null };
  try {
    result = await prisma.$transaction(async (tx) => {
      await lockCard(tx, cardId);
      const open = await tx.etollCardHandover.findFirst({
        where: { card_id: cardId, returned_at: null, ...(input.driverId ? { driver_id: input.driverId } : {}) },
        include: { driver: driverSelect },
      });
      if (!open) {
        if (input.adminId) throw new AppError("Kartu ini sedang tidak dipegang driver.", 409);
        return { returned: false, handover: null };
      }
      const at = later(input.at, open.taken_at);
      const handover = await tx.etollCardHandover.update({
        where: { id: open.id },
        data: {
          returned_at: at,
          returned_by: input.adminId ?? null,
          return_kind: "RETURNED",
          return_ref: input.returnRef ?? null,
        },
        include: { driver: driverSelect },
      });
      if (input.balance != null) {
        await addTransactionTx(tx, cardId, {
          type: "BALANCE_CHECK",
          balance_after: input.balance,
          source: input.source,
          occurred_at: at,
          driver_id: open.driver_id,
          handover_id: open.id,
          note: "Saat dikembalikan",
          created_by: input.adminId ?? null,
        });
      }
      return { returned: true, handover };
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const again = await byRef();
    if (again) return { returned: false, handover: again, card: await cardOut(cardId) };
    throw err;
  }
  const card = await cardOut(cardId);
  if (result.returned && result.handover) {
    await notifyAdmins({
      type: "ETOLL_CARD",
      title: input.adminId
        ? `Kartu e-toll ${card.name} sudah kembali dari ${result.handover.driver.name}`
        : `${result.handover.driver.name} mengembalikan kartu e-toll ${card.name}`,
      body: [card.label, input.balance != null ? `saldo ${rupiahText(input.balance)}` : null].filter(Boolean).join(" · "),
      driver_id: result.handover.driver_id,
      link: cardLink(cardId),
    });
  }
  return { returned: result.returned, handover: result.handover, card };
}

const rupiahText = (n: number) => `Rp ${Math.round(n).toLocaleString("id-ID")}`;
export const cardLink = (cardId: string) => `/dashboard/etoll-cards/${cardId}`;

/** Admin "Serahkan ke driver". */
export async function adminGiveCard(
  cardId: string,
  input: { driver_id: string; service_item_id?: string; balance?: number },
  adminId: string,
) {
  if (!(await prisma.driver.findUnique({ where: { id: input.driver_id } }))) {
    throw new AppError("Driver tidak ditemukan", 404);
  }
  const r = await takeCard({
    cardId,
    driverId: input.driver_id,
    at: new Date(),
    balance: input.balance,
    serviceItemId: input.service_item_id,
    adminId,
  });
  return { created: r.created, handover: toHandover(r.handover), card: r.card };
}

/** Admin "Tandai sudah kembali". */
export async function adminReturnCard(cardId: string, input: { balance?: number }, adminId: string) {
  const r = await returnCard({ cardId, at: new Date(), balance: input.balance, adminId });
  return { handover: r.handover ? toHandover(r.handover) : null, card: r.card };
}

// ── Driver app ──────────────────────────────────────────────────────────────
/** Active cards: the ones this driver holds first, then the ones at the office. */
export async function listCardsForDriver(driverId: string) {
  const rows = await prisma.etollCard.findMany({
    where: { status: "ACTIVE" },
    include: holderInclude,
    orderBy: { name: "asc" },
  });
  const rank = (c: CardWithHolder) => {
    const h = c.handovers[0];
    return h?.driver_id === driverId ? 0 : h ? 2 : 1;
  };
  rows.sort((a, b) => rank(a) - rank(b));
  return { items: rows.map((c) => toDriverCard(c, driverId)) };
}

async function driverCardOut(cardId: string, driverId: string) {
  return toDriverCard(await prisma.etollCard.findUniqueOrThrow({ where: { id: cardId }, include: holderInclude }), driverId);
}

/** Only the driver's own trip is linked; anything else is dropped. */
async function ownTrip(driverId: string, tripId?: string) {
  if (!tripId) return null;
  const line = await prisma.orderServiceItem.findFirst({ where: { id: tripId, driver_id: driverId }, select: { id: true } });
  return line?.id ?? null;
}

export async function driverTakeCard(
  driverId: string,
  cardId: string,
  input: { client_ref: string; occurred_at?: string; balance?: number; trip_id?: string; source: "MANUAL" | "NFC" },
) {
  const r = await takeCard({
    cardId,
    driverId,
    at: eventTime(input.occurred_at),
    balance: input.balance,
    serviceItemId: await ownTrip(driverId, input.trip_id),
    source: input.source,
    clientRef: input.client_ref,
  });
  return { created: r.created, card: await driverCardOut(cardId, driverId) };
}

export async function driverReturnCard(
  driverId: string,
  cardId: string,
  input: { client_ref: string; occurred_at?: string; balance?: number; source: "MANUAL" | "NFC" },
) {
  const r = await returnCard({
    cardId,
    driverId,
    at: eventTime(input.occurred_at),
    balance: input.balance,
    source: input.source,
    returnRef: input.client_ref,
  });
  return { returned: r.returned, card: await driverCardOut(cardId, driverId) };
}

/** "Catat sisa saldo": the balance the driver read on the card (also after a top-up update). */
export async function driverRecordBalance(
  driverId: string,
  cardId: string,
  input: { client_ref: string; occurred_at?: string; balance: number; source: "MANUAL" | "NFC" },
) {
  const prev = await prisma.etollTransaction.findUnique({ where: { client_ref: input.client_ref } });
  if (prev) {
    if (prev.driver_id !== driverId || prev.card_id !== cardId) throw new AppError("client_ref already used", 409);
    return { created: false, card: await driverCardOut(cardId, driverId) };
  }
  try {
    await prisma.$transaction(async (tx) => {
      const card = await lockCard(tx, cardId);
      if (card.status !== "ACTIVE") throw new AppError("Kartu ini sudah tidak dipakai", 409);
      await addTransactionTx(tx, cardId, {
        type: "BALANCE_CHECK",
        balance_after: input.balance,
        source: input.source,
        occurred_at: eventTime(input.occurred_at),
        driver_id: driverId,
        client_ref: input.client_ref,
      });
    });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    return { created: false, card: await driverCardOut(cardId, driverId) };
  }
  return { created: true, card: await driverCardOut(cardId, driverId) };
}

/** Cards the driver holds now, for /driver/me and old app versions. */
export async function heldCards(driverId: string) {
  const rows = await prisma.etollCardHandover.findMany({
    where: { driver_id: driverId, returned_at: null, card: { status: "ACTIVE" } },
    include: { card: true },
    orderBy: { taken_at: "desc" },
  });
  return rows.map((h) => h.card);
}
