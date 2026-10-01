import prisma from "../prisma/client";
import { env } from "../config/env";
import { logger } from "../config/logger";

/**
 * GA4 Measurement Protocol. When an order that came from a website lead gets
 * its first payment (usually the DP), report a "purchase" for the visitor who
 * sent the booking form, so GA4 shows which pages, cities and campaigns bring
 * paying customers rather than just clicks. Sent once per lead.
 */
export async function reportLeadPurchase(orderId: string): Promise<void> {
  if (!env.GA4_MEASUREMENT_ID || !env.GA4_API_SECRET) return;
  const lead = await prisma.webLead.findUnique({
    where: { order_id: orderId },
    include: {
      order: {
        select: {
          order_code: true,
          final_price: true,
          payment_status: true,
          invoices: { where: { status: "PAID" }, select: { id: true }, take: 1 },
        },
      },
    },
  });
  if (!lead || !lead.order || lead.purchase_reported_at || !lead.ga_client_id) return;
  // Called on every payment and on linking a lead: only a paid order counts.
  const paid =
    lead.order.invoices.length > 0 ||
    lead.order.payment_status === "DP_PAID" ||
    lead.order.payment_status === "PAID";
  if (!paid) return;
  // Claim the report first so two payments recorded at once cannot both send
  // it; released again if Google does not accept it.
  const claim = await prisma.webLead.updateMany({
    where: { id: lead.id, purchase_reported_at: null },
    data: { purchase_reported_at: new Date() },
  });
  if (claim.count === 0) return;
  const release = () =>
    prisma.webLead.update({ where: { id: lead.id }, data: { purchase_reported_at: null } });

  const params: Record<string, unknown> = {
    transaction_id: lead.order.order_code || lead.lead_code,
    value: Number(lead.order.final_price),
    currency: "IDR",
    lead_id: lead.lead_code,
    items: [{ item_name: lead.unit || "Sewa mobil" }],
  };
  if (lead.ga_session_id) params.session_id = lead.ga_session_id;

  const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(env.GA4_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(env.GA4_API_SECRET)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: lead.ga_client_id,
        events: [{ name: "purchase", params }],
      }),
    });
  } catch (err) {
    await release();
    throw err;
  }
  if (!res.ok) {
    await release();
    logger.warn({ status: res.status, lead: lead.lead_code }, "GA4 purchase not accepted");
    return;
  }
  logger.info({ lead: lead.lead_code, value: params.value }, "GA4 purchase reported");
}
