import { Prisma } from "@prisma/client";
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
    await prisma.webLead.create({ data });
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    )
      return;
    throw err;
  }
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
  const [data, total, counts] = await Promise.all([
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
  ]);
  return {
    data,
    meta: {
      page: query.page,
      limit: query.limit,
      total,
      total_pages: Math.max(1, Math.ceil(total / query.limit)),
      counts: Object.fromEntries(counts.map((c) => [c.status, c._count._all])),
    },
  };
}

export async function getLead(id: string) {
  const lead = await prisma.webLead.findUnique({
    where: { id },
    include: { order: { select: { id: true, order_code: true } } },
  });
  if (!lead) throw new AppError("Lead not found", 404);
  return lead;
}

export async function ignoreLead(id: string, reason?: string) {
  const lead = await getLead(id);
  if (lead.status === "CONVERTED")
    throw new AppError("Lead is already linked to an order", 409);
  return prisma.webLead.update({
    where: { id },
    data: { status: "IGNORED", ignore_reason: reason ?? null },
  });
}

export async function reopenLead(id: string) {
  const lead = await getLead(id);
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
  return prisma.$transaction((tx) => attachLeadToOrder(tx, leadId, orderId));
}
