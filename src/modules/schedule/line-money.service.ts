import type { Prisma, ExpenseType, OrderAdjustmentType } from "@prisma/client";
import { computeLineMargin, MARGIN_FORMULA_VERSION } from "../../utils/margin";
import { syncPayableForLine } from "../payables/payables.service";

/**
 * Driver pay + trip costs for ONE day-line (2026-10-03). Call after anything
 * that changes a line's driver/vendor, fee, uang jalan, RTR, status or its
 * expenses, inside the same transaction, then roll the order up once.
 *
 *  - Expenses that are APPROVED and bill_to_customer are mirrored as billable
 *    OrderAdjustments (so they land on Invoice Tambahan); any other expense
 *    loses its mirror.
 *  - The payable is re-synced (fee + reimbursements − uang jalan + extras).
 *  - ops_cost = Arasya's share: APPROVED expenses not billed to the customer.
 *  - margin = revenue − (driver_fee | RTR) − ops_cost − payable extras.
 */
export async function recomputeLineMoney(
  tx: Prisma.TransactionClient,
  lineId: string,
) {
  const line = await tx.orderServiceItem.findUnique({
    where: { id: lineId },
    include: { expenses: true },
  });
  if (!line) return;

  for (const e of line.expenses) {
    await syncBilledAdjustment(tx, line, e);
  }

  const approved = line.expenses.filter((e) => e.status === "APPROVED");
  const arasyaCosts = approved
    .filter((e) => !e.bill_to_customer)
    .reduce((s, e) => s + Number(e.amount), 0);

  await syncPayableForLine(tx, lineId);
  // Extras on the payable (bonus, potongan, vendor overtime) are money paid
  // out for this day too.
  const payable = await tx.payable.findUnique({
    where: { service_item_id: lineId },
    select: { extras_amount: true },
  });
  const extras = payable ? Number(payable.extras_amount) : 0;

  const margin =
    computeLineMargin({
      isExternal: line.is_external,
      revenue: Number(line.total_price ?? 0),
      ops_cost: arasyaCosts,
      rtr_amount: line.rtr_amount != null ? Number(line.rtr_amount) : null,
      driver_fee: line.driver_fee != null ? Number(line.driver_fee) : null,
    }) - extras;

  await tx.orderServiceItem.update({
    where: { id: lineId },
    data: {
      ops_cost: arasyaCosts,
      margin_amount: margin,
      margin_formula_version: MARGIN_FORMULA_VERSION,
    },
  });
}

const ADJUSTMENT_TYPE: Record<ExpenseType, OrderAdjustmentType> = {
  FUEL: "FUEL",
  TOLL: "TOLL",
  PARKING: "PARKING",
  OTHER: "OTHER",
};

const COST_LABEL: Record<ExpenseType, string> = {
  FUEL: "Bensin",
  TOLL: "Tol",
  PARKING: "Parkir",
  OTHER: "Biaya lain",
};

function wibDay(d: Date | null): string {
  if (!d) return "";
  return d.toLocaleDateString("id-ID", {
    timeZone: "Asia/Jakarta",
    day: "numeric",
    month: "short",
  });
}

async function syncBilledAdjustment(
  tx: Prisma.TransactionClient,
  line: { order_id: string; service_date: Date | null },
  e: {
    id: string;
    type: ExpenseType;
    amount: Prisma.Decimal;
    note: string | null;
    status: string;
    bill_to_customer: boolean;
    adjustment_id: string | null;
  },
) {
  const shouldBill = e.status === "APPROVED" && e.bill_to_customer;
  if (!shouldBill) {
    if (e.adjustment_id) {
      await tx.expense.update({ where: { id: e.id }, data: { adjustment_id: null } });
      await tx.orderAdjustment.deleteMany({ where: { id: e.adjustment_id } });
    }
    return;
  }
  const description = [
    `${COST_LABEL[e.type]} ${wibDay(line.service_date)}`.trim(),
    e.note?.trim() || null,
  ]
    .filter(Boolean)
    .join(" · ");
  if (e.adjustment_id) {
    await tx.orderAdjustment.update({
      where: { id: e.adjustment_id },
      data: {
        type: ADJUSTMENT_TYPE[e.type],
        description,
        amount: e.amount,
        quantity: 1,
        is_billable: true,
      },
    });
    return;
  }
  const adj = await tx.orderAdjustment.create({
    data: {
      order_id: line.order_id,
      type: ADJUSTMENT_TYPE[e.type],
      description,
      amount: e.amount,
      quantity: 1,
      is_billable: true,
      created_by: "Biaya perjalanan",
    },
  });
  await tx.expense.update({ where: { id: e.id }, data: { adjustment_id: adj.id } });
}
