import { DriverRequest, Prisma } from "@prisma/client";
import prisma from "../../prisma/client";
import { AppError } from "../../utils/AppError";
import { pushToDriver } from "../../services/push.service";
import { notifyDriverRequest } from "../../services/adminNotify";
import { eventTime } from "../driver-app/driver-app.service";
import type { CreateDriverRequestInput } from "../driver-app/driver-app.validation";

/**
 * Requests a driver sends from the app to the office (2026-10-04): an e-toll
 * top-up for now. Exactly-once like the trip actions: the phone's client_ref
 * is unique, so a resend returns the stored request; a driver has at most one
 * OPEN request per type (a second one returns the open one, already_open).
 * Admins are told through the dashboard notification feed; the driver gets a
 * push + inbox row when an admin marks it done.
 */

export function toRequest(r: DriverRequest) {
  return {
    id: r.id,
    driver_id: r.driver_id,
    type: r.type,
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
  let result: { created: boolean; already_open?: boolean; request: DriverRequest };
  try {
    result = await prisma.$transaction(async (tx) => {
      // One OPEN request per driver and type, also when two different
      // requests arrive at the same moment: serialise on the driver row.
      await tx.$queryRaw`SELECT id FROM drivers WHERE id = ${driverId} FOR UPDATE`;
      const open = await tx.driverRequest.findFirst({
        where: { driver_id: driverId, type: input.type, status: "OPEN" },
        orderBy: { created_at: "desc" },
      });
      if (open) return { created: false, already_open: true, request: open };
      const request = await tx.driverRequest.create({
        data: {
          driver_id: driverId,
          type: input.type,
          card_label: input.card_label ?? driver?.etoll_card ?? null,
          balance: input.balance == null ? null : Math.round(input.balance),
          note: input.note ?? null,
          client_ref: input.client_ref,
          created_at: eventTime(input.occurred_at),
        },
      });
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

/** Admin list: newest first, with the driver's name and phone only. */
export async function listRequests(status: "OPEN" | "DONE" | "CANCELLED" | "ALL") {
  const rows = await prisma.driverRequest.findMany({
    where: status === "ALL" ? {} : { status },
    orderBy: { created_at: "desc" },
    include: { driver: driverSelect },
    take: 200,
  });
  return { items: rows.map((r) => ({ ...toRequest(r), driver: r.driver })) };
}

const DONE_TITLE: Record<string, string> = {
  ETOLL_TOPUP: "Top-up e-toll sudah diproses",
};

/**
 * Admin marks a request done. Conditional (OPEN → DONE only), so a double
 * click or a second admin gets 409 and the driver is told once.
 */
export async function markRequestDone(id: string, adminUserId: string, note?: string) {
  const { count } = await prisma.driverRequest.updateMany({
    where: { id, status: "OPEN" },
    data: { status: "DONE", handled_at: new Date(), handled_by: adminUserId, handled_note: note ?? null },
  });
  const r = await prisma.driverRequest.findUnique({ where: { id }, include: { driver: driverSelect } });
  if (!r) throw new AppError("Permintaan tidak ditemukan", 404);
  if (count === 0) {
    throw new AppError(
      r.status === "DONE" ? "Permintaan ini sudah diproses." : "Permintaan ini sudah dibatalkan.",
      409,
    );
  }
  const card = r.card_label ? `Kartu ${r.card_label.replace(/^kartu\s+/i, "")}` : "Saldo e-toll";
  await pushToDriver(r.driver_id, {
    title: DONE_TITLE[r.type] ?? "Permintaan sudah diproses",
    body: note ? `${card}. ${note}` : `${card} sudah diisi. Cek saldonya sebelum jalan.`,
    data: { type: "driver_request_done", request_id: r.id, request_type: r.type },
  });
  return { request: { ...toRequest(r), driver: r.driver } };
}
