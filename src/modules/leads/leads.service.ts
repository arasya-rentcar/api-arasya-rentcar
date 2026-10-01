import { Prisma } from "@prisma/client";
import { pushToAdmins } from "../../services/push.service";
import { reportLeadPurchase } from "../../services/ga4.service";
import prisma from "../../prisma/client";
import { AppError } from "../../utils/AppError";
import type { ListLeadsQuery, PublicLeadInput } from "./leads.validation";

/**
 * Store a lead from the website. Idempotent on lead_code: the form may be
 * resent (or the beacon retried), and only the first copy is kept.
 */
export async function createPublicLead(input: PublicLeadInput) {
  const { website: _honeypot, ...data } = input;
  try {
    const lead = await prisma.webLead.create({ data });
    void pushToAdmins({
      title: `Lead website baru: ${lead.name}`,
      body: [lead.trip_date, lead.pickup_location, lead.destination && `→ ${lead.destination}`, lead.unit]
        .filter(Boolean)
        .join(" · "),
      data: { type: "lead_new", lead_id: lead.id },
    });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    )
      return;
    throw err;
  }
}

// ── Requested unit vs own fleet (the rest is fulfilled via partner/rekanan) ──
// Brand names and filler words say nothing about which car it is.
const UNIT_NOISE = new Set([
  "toyota", "suzuki", "mitsubishi", "daihatsu", "isuzu", "honda", "nissan",
  "hyundai", "wuling", "mercedes", "benz", "hybrid", "modellista", "new",
  "all", "grand", "the", "mobil", "unit", "type", "tipe", "seat", "seater",
  "kursi", "pax", "orang", "penumpang", "dengan", "driver", "supir", "sopir",
  "manual", "matic", "automatic", "bensin", "diesel", "atau", "and", "dan",
]);
// Known model words: when the request names one, only these decide the match.
const UNIT_MODELS = new Set([
  "avanza", "xenia", "veloz", "ertiga", "xpander", "terios", "rush", "innova",
  "reborn", "venturer", "zenix", "fortuner", "pajero", "hiace", "commuter",
  "premio", "alphard", "vellfire", "elf", "giga", "calya", "sigra", "brio",
  "mobilio", "livina", "camry", "starex", "staria",
]);

function words(v: string): string[] {
  return v.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** The words that identify the car in each alternative of a requested unit. */
function unitKeys(unit: string): string[][] {
  return unit
    .split(/\/|,|\bor\b|\batau\b/i)
    .map((alt) => {
      const w = words(alt);
      const models = w.filter((x) => UNIT_MODELS.has(x));
      return models.length
        ? models
        : w.filter((x) => x.length >= 3 && !UNIT_NOISE.has(x) && !/^\d+$/.test(x));
    })
    .filter((k) => k.length > 0);
}

type FleetCar = { id: string; model: string; plate_number: string };

/** All own (internal) cars that can be rented, read once per request. */
function ownFleet(): Promise<FleetCar[]> {
  return prisma.car.findMany({
    where: { type: "INTERNAL", status: { not: "MAINTENANCE" } },
    select: { id: true, model: true, plate_number: true },
    orderBy: { model: "asc" },
  });
}

/**
 * unit_in_fleet: null when the lead names no unit, true when an own car's
 * model carries every identifying word of the request (e.g. "Toyota Innova
 * Reborn" matches "Innova Reborn 2.4 G", not "Innova Zenix"), else false,
 * meaning the trip goes to a partner (rekanan) vendor.
 */
function fleetMatch(unit: string | null, fleet: FleetCar[]) {
  const keys = unit ? unitKeys(unit) : [];
  if (!keys.length) return { unit_in_fleet: null, matching_cars: [] as FleetCar[] };
  const matching_cars = fleet
    .filter((car) => {
      const have = new Set(words(car.model));
      return keys.some((k) => k.every((w) => have.has(w)));
    })
    .slice(0, 5);
  return { unit_in_fleet: matching_cars.length > 0, matching_cars };
}

export async function listLeads(query: ListLeadsQuery) {
  const where: Prisma.WebLeadWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.q
      ? {
          OR: [
            { lead_code: { contains: query.q, mode: "insensitive" } },
            { name: { contains: query.q, mode: "insensitive" } },
            { pickup_location: { contains: query.q, mode: "insensitive" } },
            { destination: { contains: query.q, mode: "insensitive" } },
          ],
        }
      : {}),
  };
  const [data, total, counts, fleet] = await Promise.all([
    prisma.webLead.findMany({
      where,
      orderBy: { created_at: "desc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      include: {
        order: {
          select: {
            id: true,
            order_code: true,
            final_price: true,
            payment_status: true,
            order_status: true,
          },
        },
      },
    }),
    prisma.webLead.count({ where }),
    prisma.webLead.groupBy({ by: ["status"], _count: { _all: true } }),
    ownFleet(),
  ]);
  return {
    data: data.map((lead) => ({ ...lead, ...fleetMatch(lead.unit, fleet) })),
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      total_pages: Math.max(1, Math.ceil(total / query.limit)),
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    },
  };
}

async function findLead(id: string) {
  const lead = await prisma.webLead.findUnique({
    where: { id },
    include: { order: { select: { id: true, order_code: true } } },
  });
  if (!lead) throw new AppError("Lead not found", 404);
  return lead;
}

export async function getLead(id: string) {
  const [lead, fleet] = await Promise.all([findLead(id), ownFleet()]);
  return { ...lead, ...fleetMatch(lead.unit, fleet) };
}

export async function ignoreLead(id: string, reason?: string) {
  const lead = await findLead(id);
  if (lead.status === "CONVERTED")
    throw new AppError("Lead is already linked to an order", 409);
  return prisma.webLead.update({
    where: { id },
    data: { status: "IGNORED", ignore_reason: reason ?? null },
  });
}

export async function reopenLead(id: string) {
  const lead = await findLead(id);
  if (lead.status !== "IGNORED") return lead;
  return prisma.webLead.update({
    where: { id },
    data: { status: "NEW", ignore_reason: null },
  });
}

/**
 * Attach a lead to an order (inside the order-creating transaction, or for
 * an order the admin already made from the WhatsApp chat).
 */
export async function attachLeadToOrder(
  tx: Prisma.TransactionClient,
  leadId: string,
  orderId: string,
) {
  const lead = await tx.webLead.findUnique({ where: { id: leadId } });
  if (!lead) throw new AppError("Lead not found", 404);
  if (lead.order_id && lead.order_id !== orderId)
    throw new AppError("Lead is already linked to another order", 409);
  const taken = await tx.webLead.findUnique({ where: { order_id: orderId } });
  if (taken && taken.id !== leadId)
    throw new AppError(`Order is already linked to ${taken.lead_code}`, 409);
  return tx.webLead.update({
    where: { id: leadId },
    data: { status: "CONVERTED", order_id: orderId, ignore_reason: null },
  });
}

export async function linkLeadToOrder(leadId: string, orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new AppError("Order not found", 404);
  const lead = await prisma.$transaction((tx) => attachLeadToOrder(tx, leadId, orderId));
  // An order that was already paid reports its GA4 purchase now.
  reportLeadPurchase(orderId).catch((err) =>
    console.error("GA4 purchase report failed:", err),
  );
  return lead;
}
