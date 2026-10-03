import prisma from "../../prisma/client";
import type { ScheduleStatus } from "@prisma/client";
import { AppError } from "../../utils/AppError";
import { assertOrderPaidForDriverAssignment, startPayment } from "./assignment-guard";
import {
  CreateOrderInput,
  UpdateOrderInput,
  AssignOrderInput,
  CreateAdjustmentInput,
  CreateChangeLogInput,
} from "./orders.validation";
import { upsertCustomerForOrder } from "../customers/customers.service";
import { attachLeadToOrder } from "../leads/leads.service";
import { notifyNewTrips, notifyTripsRemoved } from "../../services/tripNotify";
import { defaultDriverFee } from "../../utils/driverFee";
import { computeMargin, MARGIN_FORMULA_VERSION } from "../../utils/margin";
import { recomputeLineMoney } from "../schedule/line-money.service";
import { rollupOrderFinance } from "../schedule/schedule.service";
import { nextOrderCode } from "../../utils/codes";
import { buildCancellationFeePdf } from "../invoices/invoices.service";
import {
  deriveAndSetOrderStatus,
  syncDriverStatus,
  syncCarStatus,
} from "../schedule/order-derive.service";
import {
  uploadFile,
  assertValidUpload,
  getSignedUrl,
  PAYMENT_PROOFS_BUCKET,
  type UploadedFile,
} from "../../services/storage.service";

function normalizeOrderCustomers(input: {
  customer_name: string;
  customer_phone?: string;
  customers?: { name: string; phone?: string; is_primary?: boolean }[];
}) {
  const raw = input.customers?.length
    ? input.customers
    : [
        {
          name: input.customer_name,
          phone: input.customer_phone,
          is_primary: true,
        },
      ];
  const primaryIndex = raw.findIndex((c) => c.is_primary);
  const actualPrimaryIndex = primaryIndex >= 0 ? primaryIndex : 0;
  return raw.map((c, index) => ({
    name: c.name,
    phone: c.phone || null,
    is_primary: index === actualPrimaryIndex,
  }));
}

function normalizeServiceItems(input: CreateOrderInput | UpdateOrderInput) {
  return input.service_items?.map((item, index) => {
    const quantity = item.quantity ?? 1;
    const unitPrice = item.unit_price ?? 0;
    return {
      service_date: item.service_date
        ? new Date(item.service_date)
        : item.start_at
          ? new Date(item.start_at)
          : null,
      start_at: item.start_at ? new Date(item.start_at) : null,
      end_at: item.end_at ? new Date(item.end_at) : null,
      description: item.description || null,
      service_kind: item.service_kind || null,
      service_package: item.service_package || null,
      pickup_location: item.pickup_location,
      dropoff_location: item.dropoff_location,
      driver_origin_location: item.driver_origin_location || null,
      quantity,
      unit_price: unitPrice,
      total_price: item.total_price ?? quantity * unitPrice,
      notes: item.notes || null,
      sort_order: item.sort_order ?? index,
    };
  });
}

function serviceItemsTotal(items?: ReturnType<typeof normalizeServiceItems>) {
  return items?.reduce((sum, item) => sum + Number(item.total_price), 0) ?? 0;
}

export async function createOrder(input: CreateOrderInput) {
  const customers = normalizeOrderCustomers(input);
  const primary = customers.find((c) => c.is_primary) || customers[0];
  const serviceItems = normalizeServiceItems(input);
  const calculatedFinalPrice = serviceItems?.length
    ? serviceItemsTotal(serviceItems)
    : input.final_price;
  const orderDate = new Date(input.order_date);
  const isExternal = input.is_external ?? false;

  return prisma.$transaction(async (tx) => {
    // Validate external links if provided.
    if (input.external_vendor_id) {
      const vendor = await tx.externalVendor.findUnique({
        where: { id: input.external_vendor_id },
      });
      if (!vendor) throw new AppError("External vendor not found", 404);
    }
    if (input.external_car_id) {
      const car = await tx.externalCar.findUnique({
        where: { id: input.external_car_id },
      });
      if (!car) throw new AppError("External car not found", 404);
      if (
        input.external_vendor_id &&
        car.vendor_id !== input.external_vendor_id
      )
        throw new AppError(
          "External car does not belong to the given vendor",
          400,
        );
    }

    // Link / upsert the primary customer and bump repeat-order stats. If a
    // master customer_id was chosen (#15), lock to it instead of phone-matching.
    const customer = await upsertCustomerForOrder(tx, {
      name: primary.name,
      phone: primary.phone || input.customer_phone,
      amount: Number(calculatedFinalPrice),
      orderDate,
      customerId: input.customer_id,
    });

    // Auto-generate the running order code (per-customer seq, booking date).
    // The per-customer seq is always taken, so invoice/kwitansi numbering keeps
    // working; an order made from a website lead is coded with the lead's
    // ARS-XXXXX instead, the code the customer already saw on the website.
    const { seq: orderSeq, code: generatedCode } = await nextOrderCode(
      tx,
      { id: customer.id, code: customer.code },
      orderDate,
    );
    let orderCode = generatedCode;
    if (input.web_lead_id) {
      const lead = await tx.webLead.findUnique({
        where: { id: input.web_lead_id },
        select: { lead_code: true },
      });
      if (!lead) throw new AppError("Lead not found", 404);
      const taken = await tx.order.findUnique({
        where: { order_code: lead.lead_code },
        select: { id: true },
      });
      if (!taken) orderCode = lead.lead_code;
    }

    const order = await tx.order.create({
      data: {
        order_code: orderCode,
        customer_seq: orderSeq,
        customer_name: primary.name,
        customer_phone: primary.phone || input.customer_phone,
        customer_id: customer?.id ?? null,
        customers: { create: customers },
        pickup_location: input.pickup_location,
        dropoff_location: input.dropoff_location,
        order_date: orderDate,
        service_start_at: input.service_start_at
          ? new Date(input.service_start_at)
          : null,
        service_end_at: input.service_end_at
          ? new Date(input.service_end_at)
          : null,
        final_price: calculatedFinalPrice,
        service_type: input.service_type ?? null,
        passenger_count: input.passenger_count ?? null,
        area: input.area ?? null,
        notes: input.notes ?? null,
        driver_origin: input.driver_origin ?? null,
        is_external: isExternal,
        external_vendor_id: input.external_vendor_id ?? null,
        external_car_id: input.external_car_id ?? null,
        service_items: {
          create: (serviceItems?.length
            ? serviceItems
            : [
                {
                  // Default single day-line so every app order shows on the
                  // schedule even before explicit service items are added.
                  service_date: input.service_start_at
                    ? new Date(input.service_start_at)
                    : orderDate,
                  start_at: input.service_start_at
                    ? new Date(input.service_start_at)
                    : null,
                  end_at: input.service_end_at
                    ? new Date(input.service_end_at)
                    : null,
                  description: null,
                  service_kind: input.service_type ?? null,
                  pickup_location: input.pickup_location,
                  dropoff_location: input.dropoff_location,
                  quantity: 1,
                  unit_price: Number(calculatedFinalPrice),
                  total_price: Number(calculatedFinalPrice),
                  notes: input.notes ?? null,
                  sort_order: 0,
                },
              ]
          ).map((item) => ({
            ...item,
            is_external: isExternal,
            line_status: "SCHEDULED" as const,
            external_vendor_id: input.external_vendor_id ?? null,
            external_car_id: input.external_car_id ?? null,
            ops_cost: 0,
          })),
        },
      },
    });

    // Bump vendor usage count for the External menu sort.
    if (input.external_vendor_id) {
      await tx.externalVendor.update({
        where: { id: input.external_vendor_id },
        data: { order_count: { increment: 1 } },
      });
    }

    if (input.web_lead_id) {
      await attachLeadToOrder(tx, input.web_lead_id, order.id);
    }

    return order;
  }, { timeout: 15000 });
}

export async function listOrders() {
  return prisma.order.findMany({
    relationLoadStrategy: "join",
    orderBy: { created_at: "desc" },
    include: {
      final_finance: {
        select: {
          id: true,
          total_user_amount: true,
          total_ops_cost: true,
          total_driver_amount: true,
          margin_amount: true,
          invoice_no_raw: true,
        },
      },
      sheet_import_rows: {
        select: { id: true, sheet_id: true, gid: true, row_number: true },
      },
      invoices: {
        select: {
          id: true,
          invoice_number: true,
          invoice_type: true,
          status: true,
          amount: true,
          revision: true,
          parent_id: true,
          file_url: true,
          receipt_url: true,
          issue_date: true,
          payment_method: true,
          created_at: true,
          delivery_logs: { orderBy: { created_at: "desc" as const } },
          // Kwitansi rows so the Invoices menu can show receipt alongside invoice.
          receipts: { orderBy: { created_at: "desc" as const } },
        },
        orderBy: { created_at: "desc" as const },
      },
      customers: { orderBy: { created_at: "asc" as const } },
      // Merge: driver/car summary comes from the service-day lines.
      service_items: {
        orderBy: { sort_order: "asc" as const },
        select: {
          id: true,
          line_status: true,
          service_date: true,
          driver: { select: { id: true, name: true } },
          car: { select: { id: true, plate_number: true, model: true } },
        },
      },
      adjustments: { orderBy: { created_at: "desc" as const }, take: 5 },
    },
  });
}

export interface SearchOrdersParams {
  search?: string;
  order_status?: string;
  payment_status?: string;
  source?: string;
  bucket?: string; // ALL | ACTIVE | MISSING_INVOICE | CANCELLED | NOT_FINAL | REFUNDED | AWAITING_FINAL
  has_finance?: string; // "true" | "false"
  date_field?: "order_date" | "service_start_at";
  date_from?: string;
  date_to?: string;
  page?: number;
  page_size?: number;
}

export async function searchOrders(params: SearchOrdersParams) {
  const page = Math.max(1, Number(params.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(params.page_size) || 20));
  const dateField =
    params.date_field === "service_start_at"
      ? "service_start_at"
      : "order_date";

  const where: Record<string, unknown> = {};
  const and: unknown[] = [];

  if (params.search?.trim()) {
    const q = params.search.trim();
    and.push({
      OR: [
        { customer_name: { contains: q, mode: "insensitive" } },
        { customer_phone: { contains: q, mode: "insensitive" } },
        { order_code: { contains: q, mode: "insensitive" } },
        { web_lead: { lead_code: { contains: q, mode: "insensitive" } } },
        { notes: { contains: q, mode: "insensitive" } },
        { pickup_location: { contains: q, mode: "insensitive" } },
        { dropoff_location: { contains: q, mode: "insensitive" } },
        { customers: { some: { name: { contains: q, mode: "insensitive" } } } },
        { customers: { some: { phone: { contains: q, mode: "insensitive" } } } },
        {
          service_items: {
            some: { driver: { name: { contains: q, mode: "insensitive" } } },
          },
        },
        {
          service_items: {
            some: {
              car: { plate_number: { contains: q, mode: "insensitive" } },
            },
          },
        },
        {
          service_items: {
            some: { car: { model: { contains: q, mode: "insensitive" } } },
          },
        },
        // Partner (rekanan) lines: driver and plate typed on the line, the
        // vendor, and the vendor's car.
        {
          service_items: {
            some: {
              OR: [
                { driver_name_raw: { contains: q, mode: "insensitive" } },
                { driver_phone_raw: { contains: q, mode: "insensitive" } },
                { plate_raw: { contains: q, mode: "insensitive" } },
                {
                  external_vendor: {
                    name: { contains: q, mode: "insensitive" },
                  },
                },
                {
                  external_car: {
                    plate_number: { contains: q, mode: "insensitive" },
                  },
                },
                {
                  external_car: { model: { contains: q, mode: "insensitive" } },
                },
              ],
            },
          },
        },
        {
          final_finance: {
            invoice_no_raw: { contains: q, mode: "insensitive" },
          },
        },
      ],
    });
  }
  if (params.order_status && params.order_status !== "ALL")
    and.push({ order_status: params.order_status });
  switch (params.bucket) {
    case "ACTIVE":
      and.push({ order_status: { not: "CANCELLED" } });
      and.push({ invoice_missing: false });
      and.push({ is_refunded: false });
      break;
    case "MISSING_INVOICE":
      and.push({ invoice_missing: true });
      break;
    case "CANCELLED":
      and.push({ order_status: "CANCELLED" });
      break;
    case "NOT_FINAL":
      and.push({ is_final: false });
      and.push({ order_status: { not: "CANCELLED" } });
      break;
    case "REFUNDED":
      and.push({ is_refunded: true });
      break;
    case "AWAITING_FINAL":
      // All service days finished by the driver, waiting on admin finalization.
      and.push({ awaiting_finalization: true });
      break;
    default:
      break;
  }
  if (params.payment_status && params.payment_status !== "ALL")
    and.push({ payment_status: params.payment_status });
  if (params.source && params.source !== "ALL")
    and.push({ source: params.source });
  if (params.has_finance === "true") and.push({ final_finance: { isNot: null } });
  if (params.has_finance === "false") and.push({ final_finance: { is: null } });
  if (params.date_from)
    and.push({ [dateField]: { gte: new Date(`${params.date_from}T00:00:00`) } });
  if (params.date_to)
    and.push({ [dateField]: { lte: new Date(`${params.date_to}T23:59:59`) } });
  if (and.length) where.AND = and;

  const [total, rows, financeAgg, priceAgg] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      relationLoadStrategy: "join",
      orderBy: { created_at: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        final_finance: {
          select: {
            id: true,
            total_user_amount: true,
            total_ops_cost: true,
            total_driver_amount: true,
            margin_amount: true,
            invoice_no_raw: true,
            driver_vendor_raw: true,
            vehicle_raw: true,
            route_raw: true,
            plate_no_raw: true,
            sheet_checked_raw: true,
            service_date: true,
          },
        },
        sheet_import_rows: {
          select: { id: true, sheet_id: true, gid: true, row_number: true },
        },
        // Merge: driver/car summary now comes from the service-day lines.
        service_items: {
          orderBy: { sort_order: "asc" as const },
          select: {
            id: true,
            line_status: true,
            service_date: true,
            driver: { select: { id: true, name: true } },
            car: { select: { id: true, plate_number: true, model: true } },
          },
        },
        invoices: {
          select: {
            id: true,
            invoice_number: true,
            invoice_type: true,
            status: true,
            amount: true,
            file_url: true,
          },
          orderBy: { created_at: "desc" as const },
        },
        customers: { orderBy: { created_at: "asc" as const } },
        web_lead: { select: WEB_LEAD_SUMMARY },
      },
    }),
    // Summary totals across the WHOLE filtered set (not just current page)
    prisma.orderFinalFinance.aggregate({
      where: { order: where },
      _sum: {
        total_user_amount: true,
        total_ops_cost: true,
        total_driver_amount: true,
        margin_amount: true,
      },
    }),
    // final_price sum (fallback turnover) across filtered set — parallelized.
    prisma.order.aggregate({
      where,
      _sum: { final_price: true },
    }),
  ]);

  return {
    data: rows,
    pagination: {
      page,
      page_size: pageSize,
      total,
      page_count: Math.max(1, Math.ceil(total / pageSize)),
    },
    summary: {
      count: total,
      final_price_total: priceAgg._sum.final_price ?? 0,
      total_user_amount: financeAgg._sum.total_user_amount ?? 0,
      total_ops_cost: financeAgg._sum.total_ops_cost ?? 0,
      total_driver_amount: financeAgg._sum.total_driver_amount ?? 0,
      margin_amount: financeAgg._sum.margin_amount ?? 0,
    },
  };
}

export interface UpsertOrderFinanceInput {
  total_user_amount?: number | null;
  sell_price?: number | null;
  rtr_amount?: number | null;
  total_ops_cost?: number | null;
  fuel_amount?: number | null;
  toll_amount?: number | null;
  parking_cash_amount?: number | null;
  driver_fee_amount?: number | null;
  total_driver_amount?: number | null;
  finance_note?: string | null;
}


/**
 * Create or update the finance record for an app order and (re)compute margin
 * using the confirmed rules. External flag comes from the order itself.
 */
export async function upsertOrderFinance(
  id: string,
  input: UpsertOrderFinanceInput,
) {
  const order = await prisma.order.findUnique({
    where: { id },
    select: { id: true, _count: { select: { service_items: true } } },
  });
  if (!order) throw new AppError("Order not found", 404);
  if (order._count.service_items === 0) {
    await upsertLegacyOrderFinance(id, input);
    return getOrderById(id);
  }

  // Driver pay (2026-10-03): fees, trip costs, RTR and margin are computed
  // from the days (Edit Hari + approved trip costs). Only the finance note is
  // edited here; the other fields are accepted from older dashboards but
  // ignored.
  await prisma.$transaction(async (tx) => {
    if (input.finance_note !== undefined) {
      await tx.orderFinalFinance.upsert({
        where: { order_id: id },
        update: { finance_note: input.finance_note },
        create: { order_id: id, finance_note: input.finance_note },
      });
    }
    await rollupOrderFinance(tx, id);
  });

  return getOrderById(id);
}

const nn = (v?: number | null) => (v == null ? null : Number(v));

/**
 * Orders without day-lines (older or manual orders) keep the old order-level
 * finance editing: there are no days for the rollup to compute from.
 */
async function upsertLegacyOrderFinance(
  id: string,
  input: UpsertOrderFinanceInput,
) {
  const order = await prisma.order.findUnique({
    where: { id },
    include: { final_finance: true },
  });
  if (!order) throw new AppError("Order not found", 404);

  const existing = order.final_finance;
  const num = (v: unknown) => (v == null ? null : Number(v));

  // Merge incoming values over existing finance.
  const totalUser =
    input.total_user_amount !== undefined
      ? nn(input.total_user_amount)
      : (num(existing?.total_user_amount) ?? Number(order.final_price));
  const sellPrice =
    input.sell_price !== undefined
      ? nn(input.sell_price)
      : num(existing?.sell_price);
  const rtr =
    input.rtr_amount !== undefined
      ? nn(input.rtr_amount)
      : num(existing?.rtr_amount);

  // Ops cost: explicit value wins; otherwise sum the cost components when given;
  // otherwise keep existing.
  let opsCost: number | null;
  if (input.total_ops_cost !== undefined) {
    opsCost = nn(input.total_ops_cost);
  } else if (
    input.fuel_amount !== undefined ||
    input.toll_amount !== undefined ||
    input.parking_cash_amount !== undefined
  ) {
    opsCost =
      (nn(input.fuel_amount) ?? 0) +
      (nn(input.toll_amount) ?? 0) +
      (nn(input.parking_cash_amount) ?? 0);
  } else {
    opsCost = num(existing?.total_ops_cost);
  }

  const driverTotal =
    input.total_driver_amount !== undefined
      ? nn(input.total_driver_amount)
      : num(existing?.total_driver_amount);

  const margin = computeMargin({
    isExternal: order.is_external,
    total_user_amount: totalUser,
    total_ops_cost: opsCost,
    // The admin-entered driver fee (one per order) is total_driver_amount.
    // Internal margin now subtracts it; external ignores it (RTR covers vendor).
    driver_fee_amount: driverTotal,
    sell_price: sellPrice,
    rtr_amount: rtr,
  });

  const data = {
    total_user_amount: totalUser,
    sell_price: sellPrice,
    rtr_amount: rtr,
    total_ops_cost: opsCost,
    fuel_amount:
      input.fuel_amount !== undefined
        ? nn(input.fuel_amount)
        : num(existing?.fuel_amount),
    toll_amount:
      input.toll_amount !== undefined
        ? nn(input.toll_amount)
        : num(existing?.toll_amount),
    parking_cash_amount:
      input.parking_cash_amount !== undefined
        ? nn(input.parking_cash_amount)
        : num(existing?.parking_cash_amount),
    driver_fee_amount:
      input.driver_fee_amount !== undefined
        ? nn(input.driver_fee_amount)
        : num(existing?.driver_fee_amount),
    total_driver_amount: driverTotal,
    finance_note:
      input.finance_note !== undefined
        ? input.finance_note
        : (existing?.finance_note ?? null),
    margin_amount: margin,
    margin_formula_version: MARGIN_FORMULA_VERSION,
  };

  await prisma.orderFinalFinance.upsert({
    where: { order_id: id },
    update: data,
    create: { ...data, order_id: id },
  });

}

/** The website lead an order came from, as shown on the order. */
const WEB_LEAD_SUMMARY = {
  id: true,
  lead_code: true,
  campaign: true,
  gclid: true,
  page_path: true,
  language: true,
  unit: true,
  passenger_count: true,
  duration: true,
  duration_key: true,
  notes: true,
  created_at: true,
} as const;

export async function getOrderById(id: string) {
  const order = await prisma.order.findUnique({
    where: { id },
    relationLoadStrategy: "join",
    include: {
      invoices: {
        orderBy: { created_at: "desc" as const },
        include: {
          delivery_logs: { orderBy: { created_at: "desc" as const } },
          // Kwitansi rows tied to this invoice (one per payment event), so the
          // dashboard can show which receipt belongs to which invoice.
          receipts: { orderBy: { created_at: "desc" as const } },
        },
      },
      final_finance: true,
      external_vendor: { select: { id: true, name: true, phone: true } },
      external_car: {
        select: { id: true, model: true, plate_number: true },
      },
      customer: {
        select: { id: true, name: true, phone: true, total_orders: true },
      },
      customers: { orderBy: { created_at: "asc" as const } },
      // Merge: the line IS the trip - include driver/car/expenses/reports here.
      service_items: {
        orderBy: { sort_order: "asc" as const },
        include: {
          driver: { select: { id: true, name: true } },
          car: {
            select: {
              id: true,
              model: true,
              plate_number: true,
              unit_code: true,
            },
          },
          external_vendor: { select: { id: true, name: true } },
          external_car: {
            select: { id: true, model: true, plate_number: true },
          },
          expenses: {
            orderBy: { created_at: "asc" as const },
            include: {
              trip_report: { select: { id: true, file_url: true, file_mime: true } },
            },
          },
          reports: { orderBy: { created_at: "desc" as const } },
          payable: {
            select: {
              id: true,
              kind: true,
              status: true,
              base_amount: true,
              reimburse_amount: true,
              advance_amount: true,
              extras_amount: true,
              total_amount: true,
              paid_at: true,
            },
          },
        },
      },
      adjustments: { orderBy: { created_at: "desc" as const } },
      change_logs: { orderBy: { created_at: "desc" as const } },
      web_lead: { select: WEB_LEAD_SUMMARY },
    },
  });

  if (!order) throw new AppError("Order not found", 404);
  // Paid in full = trips may start (driver app "Berangkat"); see startPayment.
  return { ...order, start_payment: startPayment(order, order.service_items) };
}

// Terminal orders are READ-ONLY for structural data. DONE and CANCELLED orders
// must not have their fields, service lines, driver assignment, or pricing
// adjustments changed. Billing/closure (invoices, payment, receipt, refund,
// finance settlement) is intentionally NOT guarded here because it legitimately
// happens after a trip is DONE and on CANCELLED orders (cancellation fee /
// refund). Callers that mutate structural data should call this first.
function assertOrderStructurallyEditable(order: {
  order_status: string;
}): void {
  if (order.order_status === "DONE" || order.order_status === "CANCELLED") {
    throw new AppError(
      `Cannot modify a ${order.order_status} order. Finished and cancelled orders are read-only.`,
      409,
    );
  }
}

export async function updateOrder(id: string, input: UpdateOrderInput) {
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) throw new AppError("Order not found", 404);

  assertOrderStructurallyEditable(order);

  const { change_reason, customers, service_items, ...updateData } = input;
  const normalizedCustomers = customers
    ? normalizeOrderCustomers({
        customer_name: updateData.customer_name || order.customer_name,
        customer_phone: updateData.customer_phone || order.customer_phone,
        customers,
      })
    : null;
  const primaryCustomer =
    normalizedCustomers?.find((c) => c.is_primary) || normalizedCustomers?.[0];
  const normalizedServiceItems = service_items
    ? normalizeServiceItems({ ...input, service_items })
    : null;
  const recalculatedFinalPrice = normalizedServiceItems?.length
    ? serviceItemsTotal(normalizedServiceItems)
    : updateData.final_price;
  const priceChanged =
    recalculatedFinalPrice !== undefined &&
    Number(recalculatedFinalPrice) !== Number(order.final_price);

  if (priceChanged && !change_reason?.trim()) {
    throw new AppError(
      "change_reason is required when changing final_price",
      400,
    );
  }

  if (priceChanged) {
    const activeInvoiceTotal = await prisma.invoice.aggregate({
      where: {
        order_id: id,
        status: { notIn: ["REVISED", "CANCELLED"] },
      },
      _sum: { amount: true },
    });
    const invoicedTotal = Number(activeInvoiceTotal._sum.amount ?? 0);
    if (Number(recalculatedFinalPrice) < invoicedTotal) {
      throw new AppError(
        `final_price cannot be lower than active invoice total (${invoicedTotal}). Revise/cancel invoices first.`,
        409,
      );
    }
  }

  return prisma.$transaction(async (tx) => {
    const updated = await tx.order.update({
      where: { id },
      data: {
        ...updateData,
        customer_name: primaryCustomer?.name ?? updateData.customer_name,
        customer_phone: primaryCustomer?.phone ?? updateData.customer_phone,
        order_date: updateData.order_date
          ? new Date(updateData.order_date)
          : undefined,
        service_start_at: updateData.service_start_at
          ? new Date(updateData.service_start_at)
          : undefined,
        service_end_at: updateData.service_end_at
          ? new Date(updateData.service_end_at)
          : undefined,
        final_price: recalculatedFinalPrice,
        service_items: normalizedServiceItems
          ? {
              deleteMany: {},
              create: normalizedServiceItems,
            }
          : undefined,
        customers: normalizedCustomers
          ? {
              deleteMany: {},
              create: normalizedCustomers,
            }
          : undefined,
      },
    });

    if (priceChanged) {
      await tx.orderChangeLog.create({
        data: {
          order_id: id,
          field: "final_price",
          old_value: String(order.final_price),
          new_value: String(recalculatedFinalPrice),
          note: change_reason,
          actor: "ADMIN",
        },
      });
    }

    return updated;
  });
}

export async function assignOrder(orderId: string, input: AssignOrderInput) {
  // Validate order
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new AppError("Order not found", 404);
  if (order.order_status !== "CREATED") {
    throw new AppError(
      "Order must be in CREATED status to assign a driver",
      409,
    );
  }
  assertOrderPaidForDriverAssignment(order);

  // Validate driver
  const driver = await prisma.driver.findUnique({
    where: { id: input.driver_id },
  });
  if (!driver) throw new AppError("Driver not found", 404);
  if (driver.status !== "AVAILABLE") {
    throw new AppError("Driver is not available", 409);
  }

  // Validate car
  const car = await prisma.car.findUnique({ where: { id: input.car_id } });
  if (!car) throw new AppError("Car not found", 404);
  if (car.status !== "AVAILABLE") {
    throw new AppError("Car is not available", 409);
  }

  // Merge: assign at the LINE level (the line IS the trip). Every internal
  // day-line that has no driver yet inherits this driver+car and flips to
  // ASSIGNED; order + driver/car status are then derived from the lines.
  // Only open days: a cancelled or finished day must not come back to life.
  const openUnassigned = {
    order_id: orderId,
    is_external: false,
    driver_id: null,
    line_status: { in: ["SCHEDULED", "ASSIGNED"] as ScheduleStatus[] },
  };
  const newLines = await prisma.orderServiceItem.findMany({
    where: openUnassigned,
    select: { id: true, service_kind: true, driver_fee: true },
  });
  let got = newLines;
  const updated = await prisma.$transaction(
    async (tx) => {
      // Conditional: a day another admin assigned meanwhile is left alone.
      await tx.orderServiceItem.updateMany({
        where: { ...openUnassigned, id: { in: newLines.map((l) => l.id) } },
        data: {
          driver_id: input.driver_id,
          car_id: input.car_id,
          line_status: "ASSIGNED",
        },
      });
      const mine = new Set(
        (
          await tx.orderServiceItem.findMany({
            where: { id: { in: newLines.map((l) => l.id) }, driver_id: input.driver_id },
            select: { id: true },
          })
        ).map((l) => l.id),
      );
      got = newLines.filter((l) => mine.has(l.id));
      // Each day gets its fee from the fee table (if not set yet) and its
      // payable, exactly like a single-day assign.
      for (const l of got) {
        if (l.driver_fee == null) {
          const d = defaultDriverFee(l.service_kind);
          await tx.orderServiceItem.update({
            where: { id: l.id },
            data: { driver_fee: d.amount, driver_fee_note: d.note },
          });
        }
        await recomputeLineMoney(tx, l.id);
      }
      await rollupOrderFinance(tx, orderId);
      await deriveAndSetOrderStatus(tx, orderId);
      await syncDriverStatus(tx, input.driver_id);
      await syncCarStatus(tx, input.car_id);
      return tx.order.findUnique({ where: { id: orderId } });
    },
    { maxWait: 15000, timeout: 30000 },
  );

  void notifyNewTrips(input.driver_id, got.map((l) => l.id));
  return updated;
}

/**
 * Bulk RE-assign: overwrite the driver+car on every internal line that has NOT
 * started yet (line_status = ASSIGNED), e.g. swapping the driver on a 5-day
 * order after it was already assigned. Lines that are IN_PROGRESS / DONE /
 * CANCELLED are left untouched — you can't yank a driver off a running or
 * finished day. Old drivers/cars whose remaining lines drop to zero are
 * released back to AVAILABLE.
 */
export async function reassignOrder(
  orderId: string,
  input: AssignOrderInput,
) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new AppError("Order not found", 404);

  // Only the not-yet-started internal lines are eligible for a swap.
  const eligibleLines = await prisma.orderServiceItem.findMany({
    where: {
      order_id: orderId,
      is_external: false,
      line_status: "ASSIGNED",
    },
    select: { id: true, driver_id: true, car_id: true },
  });
  if (eligibleLines.length === 0) {
    throw new AppError(
      "No assignable lines to reassign (all lines are unassigned, already started, done, or cancelled).",
      409,
    );
  }

  // Moving a line to a different driver needs a paid DP, like a first assign.
  if (eligibleLines.some((l) => l.driver_id !== input.driver_id)) {
    assertOrderPaidForDriverAssignment(order);
  }

  // Validate the new driver: must be AVAILABLE, unless it is already the driver
  // on one of this order's lines (re-confirming the same driver is harmless).
  const driver = await prisma.driver.findUnique({
    where: { id: input.driver_id },
  });
  if (!driver) throw new AppError("Driver not found", 404);
  const driverAlreadyOnOrder = eligibleLines.some(
    (l) => l.driver_id === input.driver_id,
  );
  if (driver.status !== "AVAILABLE" && !driverAlreadyOnOrder) {
    throw new AppError("Driver is not available", 409);
  }

  // Validate the new car: same rule.
  const car = await prisma.car.findUnique({ where: { id: input.car_id } });
  if (!car) throw new AppError("Car not found", 409);
  const carAlreadyOnOrder = eligibleLines.some(
    (l) => l.car_id === input.car_id,
  );
  if (car.status !== "AVAILABLE" && !carAlreadyOnOrder) {
    throw new AppError("Car is not available", 409);
  }

  // A day already paid to its driver cannot move to another driver.
  const paidDays = await prisma.payable.findMany({
    where: {
      service_item_id: { in: eligibleLines.map((l) => l.id) },
      status: "PAID",
      NOT: { driver_id: input.driver_id },
    },
    include: { driver: { select: { name: true } } },
  });
  if (paidDays.length > 0) {
    const names = [...new Set(paidDays.map((p) => p.driver?.name ?? "driver lama"))];
    throw new AppError(
      `${paidDays.length} hari sudah dibayar ke ${names.join(", ")}. Tandai belum terbayar dulu di menu Utang sebelum mengganti driver.`,
      409,
    );
  }

  // Drivers/cars being replaced (so we can re-sync their status afterwards).
  const oldDriverIds = new Set(
    eligibleLines.map((l) => l.driver_id).filter((d): d is string => !!d),
  );
  const oldCarIds = new Set(
    eligibleLines.map((l) => l.car_id).filter((c): c is string => !!c),
  );

  const updated = await prisma.$transaction(async (tx) => {
    await tx.orderServiceItem.updateMany({
      where: {
        order_id: orderId,
        is_external: false,
        line_status: "ASSIGNED",
      },
      data: {
        driver_id: input.driver_id,
        car_id: input.car_id,
      },
    });
    // The unpaid driver payables follow the days to the new driver.
    for (const l of eligibleLines) await recomputeLineMoney(tx, l.id);
    await rollupOrderFinance(tx, orderId);
    await deriveAndSetOrderStatus(tx, orderId);
    // Release the old resources first, then mark the new ones busy.
    for (const id of oldDriverIds) await syncDriverStatus(tx, id);
    for (const id of oldCarIds) await syncCarStatus(tx, id);
    await syncDriverStatus(tx, input.driver_id);
    await syncCarStatus(tx, input.car_id);
    return tx.order.findUnique({ where: { id: orderId } });
  }, { maxWait: 15000, timeout: 30000 });

  // Driver app: new driver gets the trips, replaced drivers are told.
  const moved = eligibleLines.filter((l) => l.driver_id !== input.driver_id);
  void notifyNewTrips(input.driver_id, moved.map((l) => l.id));
  for (const oldId of oldDriverIds) {
    if (oldId === input.driver_id) continue;
    void notifyTripsRemoved(oldId, moved.filter((l) => l.driver_id === oldId).map((l) => l.id));
  }
  return updated;
}

export async function createOrderAdjustment(
  orderId: string,
  input: CreateAdjustmentInput,
) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new AppError("Order not found", 404);
  assertOrderStructurallyEditable(order);

  return prisma.$transaction(async (tx) => {
    const adjustment = await tx.orderAdjustment.create({
      data: {
        order_id: orderId,
        type: input.type,
        description: input.description,
        amount: input.amount,
        quantity: input.quantity,
        is_billable: input.is_billable,
        created_by: input.created_by,
      },
    });

    if (input.is_billable) {
      const lineCount = await tx.orderServiceItem.count({
        where: { order_id: orderId },
      });
      if (lineCount > 0) {
        // Keeps final_price, Total User and margin on the finance card in step.
        await rollupOrderFinance(tx, orderId);
      } else {
        await tx.order.update({
          where: { id: orderId },
          data: {
            final_price:
              Number(order.final_price) + input.amount * input.quantity,
          },
        });
      }
    }

    await tx.orderChangeLog.create({
      data: {
        order_id: orderId,
        field: "adjustment",
        new_value: `${input.type}: ${input.description} (${input.amount} x ${input.quantity})`,
        actor: input.created_by,
        note: input.is_billable
          ? "Billable adjustment added to order final_price"
          : "Non-billable adjustment logged",
      },
    });

    return adjustment;
  });
}

export async function createOrderChangeLog(
  orderId: string,
  input: CreateChangeLogInput,
) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new AppError("Order not found", 404);
  return prisma.orderChangeLog.create({
    data: { order_id: orderId, ...input },
  });
}

/**
 * ADMIN-ONLY order finalization (2026-06-23).
 *
 * Per the admin-finalize model, the bot can move individual day-lines to DONE
 * (from the driver's dropoff report) but the ORDER never auto-completes
 * (rollupOrderStatus caps all-done at IN_PROGRESS and sets
 * awaiting_finalization). This endpoint is the ONLY path that sets
 * order_status = DONE — the admin calls it after entering ops cost / additional
 * / driver fee.
 *
 * Guard: every active (non-cancelled) line must already be DONE. Ops cost /
 * additional / driver fee are SOFT (not enforced here) — the dashboard reminds
 * the admin via a confirmation dialog when additionals exist.
 */
export async function finalizeOrder(orderId: string, actor?: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { service_items: { select: { line_status: true } } },
  });
  if (!order) throw new AppError("Order not found", 404);

  if (order.order_status === "DONE") {
    throw new AppError("Order is already finalized", 409);
  }
  if (order.order_status === "CANCELLED") {
    throw new AppError("Cannot finalize a cancelled order", 409);
  }

  const activeLines = order.service_items.filter(
    (l) => l.line_status !== "CANCELLED",
  );
  if (activeLines.length === 0) {
    throw new AppError("Order has no active service lines to finalize", 409);
  }
  const allDone = activeLines.every((l) => l.line_status === "DONE");
  if (!allDone) {
    throw new AppError(
      "All service days must be finished by the driver before finalizing",
      409,
    );
  }
  const pendingCosts = await prisma.expense.count({
    where: { status: "PENDING", order_service_item: { order_id: orderId } },
  });
  if (pendingCosts > 0) {
    throw new AppError(
      `Masih ada ${pendingCosts} biaya perjalanan dari driver yang belum dicek. Setujui atau tolak dulu sebelum finalisasi.`,
      409,
    );
  }

  return prisma.$transaction(
    async (tx) => {
      await tx.order.update({
        where: { id: orderId },
        data: { order_status: "DONE", awaiting_finalization: false },
      });
      await tx.orderChangeLog.create({
        data: {
          order_id: orderId,
          field: "order_status",
          new_value: "DONE",
          actor,
          note: "Order finalized by admin (finance reviewed)",
        },
      });
      return tx.order.findUnique({ where: { id: orderId } });
    },
    { maxWait: 15000, timeout: 30000 },
  );
}

// Sprint 5: how much refund the order owes the customer = money received beyond
// the order total. paid_to_date holds actual money received (Sprint 2).
export function computeRefundDue(order: {
  paid_to_date: unknown;
  final_price: unknown;
}): number {
  const paid = Number(order.paid_to_date ?? 0);
  const total = Number(order.final_price ?? 0);
  return Math.max(paid - total, 0);
}

// Sprint 5: mark an order's refund as settled. A refund proof file is REQUIRED
// (cash-flow must be evidenced, per Ten). Idempotent-safe: re-marking updates
// the proof/amount/note. Refund amount is derived live (paid_to_date - total)
// unless explicitly provided.
export async function markOrderRefunded(
  orderId: string,
  input: { note?: string; amount?: number; proof?: UploadedFile },
) {
  const proofFile = assertValidUpload(input.proof);
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new AppError("Order not found", 404);

  const refundDue = computeRefundDue(order);
  const amount = input.amount != null ? input.amount : refundDue;
  if (amount <= 0) {
    throw new AppError(
      "No refund is due on this order (paid amount does not exceed the order total).",
      400,
    );
  }

  const proofUpload = await uploadFile(proofFile, {
    bucket: PAYMENT_PROOFS_BUCKET,
    prefix: `refunds/${orderId}`,
  });

  return prisma.order.update({
    where: { id: orderId },
    data: {
      is_refunded: true,
      refunded_at: new Date(),
      refund_amount: amount,
      refund_proof_url: proofUpload.path,
      refund_note: input.note ?? null,
    },
  });
}

// Sprint 5: short-lived signed URL for the (private) refund proof.
export async function getRefundProofUrl(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { refund_proof_url: true },
  });
  if (!order || !order.refund_proof_url) {
    throw new AppError("No refund proof on file for this order", 404);
  }
  const url = await getSignedUrl(
    PAYMENT_PROOFS_BUCKET,
    order.refund_proof_url,
    60 * 60,
  );
  return { url, expires_in: 3600 };
}

// ── Jakarta timezone helpers ──────────────────────────────────────────────
const JAKARTA_OFFSET_MS = 7 * 60 * 60 * 1000;

function jakartaDate(d: Date | number | string): string {
  return new Date(
    new Date(d).getTime() + JAKARTA_OFFSET_MS,
  )
    .toISOString()
    .slice(0, 10);
}

/**
 * Compute the cancellation tier + penalty per Arasya policy. Penalty base is
 * ALWAYS final_price (confirmed with Ten): an order with no invoice yet still
 * incurs the policy %, and the invoice total should equal final_price anyway.
 *
 *  Tier 1 (cancel on any day before H)        → 20% of final_price (DP forfeit)
 *  Tier 2 (H-day, before 10:00, no driver yet) → 50% of final_price
 *  Tier 3 (H-day ≥10:00, driver arrived, or after H) → 100% of final_price
 */
function computeCancellationPenalty(args: {
  finalPrice: number;
  firstServiceDate: Date | null;
  anyLineStarted: boolean;
  now: Date;
}): { tier: 1 | 2 | 3; penalty: number; label: string } {
  const { finalPrice, firstServiceDate, anyLineStarted, now } = args;
  const round2 = (n: number) => Math.round(n * 100) / 100;
  const todayJakarta = jakartaDate(now);
  const jakartaNow = new Date(now.getTime() + JAKARTA_OFFSET_MS);
  const jakartaHour = jakartaNow.getUTCHours();
  const jakartaMin = jakartaNow.getUTCMinutes();

  // No service date at all → treat as early cancel (Tier 1).
  if (!firstServiceDate) {
    return {
      tier: 1,
      penalty: round2(finalPrice * 0.2),
      label: "Tier 1 (tanpa tanggal layanan) — DP 20% hangus",
    };
  }

  const firstDayJakarta = jakartaDate(firstServiceDate);

  if (todayJakarta < firstDayJakarta) {
    // Cancel on any calendar day before the service date → forfeit DP (20%).
    return {
      tier: 1,
      penalty: round2(finalPrice * 0.2),
      label: "Tier 1 (sebelum hari H) — DP 20% hangus",
    };
  }

  if (todayJakarta === firstDayJakarta) {
    const before10 =
      jakartaHour < 10 || (jakartaHour === 10 && jakartaMin === 0);
    if (before10 && !anyLineStarted) {
      return {
        tier: 2,
        penalty: round2(finalPrice * 0.5),
        label: "Tier 2 (hari H sebelum pukul 10.00) — 50% dari total",
      };
    }
    return {
      tier: 3,
      penalty: round2(finalPrice),
      label:
        "Tier 3 (hari H setelah pukul 10.00 / driver tiba) — 100% dari total",
    };
  }

  // Cancel after the first service day has passed → 100%.
  return {
    tier: 3,
    penalty: round2(finalPrice),
    label: "Tier 3 (setelah hari H) — 100% dari total",
  };
}

export interface CancelOrderResult {
  tier: 1 | 2 | 3;
  penalty: number;
  originalFinalPrice: number;
  paidToDate: number;
  /** Money owed back to the customer (paid more than the penalty). */
  refundDue: number;
  /** Money the customer still owes toward the penalty. */
  stillOwed: number;
  cancellationInvoiceNumber: string | null;
}

/**
 * Cancel a full order per Arasya cancellation policy.
 *
 * Non-breaking design (reviewed against existing money flows):
 *  - sets order.final_price = penalty, so the EXISTING refund flow
 *    (computeRefundDue = paid_to_date - final_price) and payment_status
 *    recompute both work with zero special-casing.
 *  - voids active invoices (status → CANCELLED) and DECREMENTS total_billed
 *    by their sum, then issues ONE CANCELLATION_FEE invoice (with a real PDF)
 *    and INCREMENTS total_billed by the penalty → preserves the G9 invariant
 *    total_billed = sum(active invoices).
 *  - cancels all active lines → order status derives to CANCELLED; releases
 *    drivers/cars.
 *  - recomputes payment_status against the new (penalty) total.
 *  - does NOT move money or auto-mark refunded: refunds stay manual (bank
 *    transfer) via the existing refund flow. Returns a summary so the UI can
 *    show the admin what to collect/refund.
 */
export async function cancelOrder(
  orderId: string,
  reason: string,
  actor?: string,
): Promise<CancelOrderResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      customer: true,
      service_items: { orderBy: { service_date: { sort: "asc", nulls: "last" } } },
    },
  });
  if (!order) throw new AppError("Order not found", 404);
  if (order.order_status === "DONE" || order.order_status === "CANCELLED") {
    throw new AppError(
      `Cannot cancel an order with status ${order.order_status}`,
      409,
    );
  }

  const now = new Date();
  const originalFinalPrice = Number(order.final_price);

  // ── Tier + penalty (base = final_price) ─────────────────────────────────
  const activeLines = order.service_items.filter(
    (l) => l.line_status !== "CANCELLED",
  );
  const firstServiceDate =
    activeLines
      .map((l) => l.service_date)
      .filter((d): d is Date => !!d)
      .sort((a, b) => a.getTime() - b.getTime())[0] ??
    order.service_start_at ??
    null;
  const anyLineStarted = activeLines.some((l) => l.trip_started_at != null);
  const { tier, penalty, label } = computeCancellationPenalty({
    finalPrice: originalFinalPrice,
    firstServiceDate,
    anyLineStarted,
    now,
  });

  // ── Render the cancellation-fee PDF + reserve its number OUTSIDE the main
  //    tx (slow network work; mirrors generateInvoice). Skip if no customer
  //    is linked (cannot issue a numbered invoice without a customer code).
  let prepared:
    | { invoiceNumber: string; invoiceSeq: number; fileUrl: string }
    | null = null;
  if (order.customer) {
    const built = await buildCancellationFeePdf({
      customer: { id: order.customer.id, code: order.customer.code },
      order: {
        order_code: order.order_code,
        customer_name: order.customer_name,
        customer_phone: order.customer_phone ?? null,
        pickup_location: order.pickup_location,
        dropoff_location: order.dropoff_location,
      },
      penalty,
      tierLabel: label,
      reason,
      issueDate: now,
    });
    prepared = built;
  }

  // ── Mutations in one transaction ────────────────────────────────────────
  const result = await prisma.$transaction(async (tx) => {
    // 1) Void active invoices and decrement the customer's billed total.
    const activeInvoices = await tx.invoice.findMany({
      where: {
        order_id: orderId,
        status: { notIn: ["REVISED", "CANCELLED"] },
      },
      select: { id: true, amount: true },
    });
    const voidedSum = activeInvoices.reduce(
      (s, inv) => s + Number(inv.amount),
      0,
    );
    if (activeInvoices.length > 0) {
      await tx.invoice.updateMany({
        where: { id: { in: activeInvoices.map((i) => i.id) } },
        data: { status: "CANCELLED" },
      });
    }

    // 2) Cancel all active lines; collect drivers/cars to release.
    const driverIds = new Set<string>();
    const carIds = new Set<string>();
    const cancellableIds: string[] = [];
    const startedIds: string[] = [];
    for (const l of order.service_items) {
      if (l.line_status === "DONE" || l.line_status === "CANCELLED") continue;
      cancellableIds.push(l.id);
      if (l.actual_start_at || l.trip_started_at) startedIds.push(l.id);
      if (l.driver_id) driverIds.add(l.driver_id);
      if (l.car_id) carIds.add(l.car_id);
    }
    // A day already paid out (driver fee / partner RTR) keeps who drove and
    // its amounts, like a started day: the payment stays on record.
    const paidOut = await tx.payable.findMany({
      where: { service_item_id: { in: cancellableIds }, status: "PAID" },
      select: { service_item_id: true },
    });
    for (const p of paidOut) {
      if (!startedIds.includes(p.service_item_id)) startedIds.push(p.service_item_id);
    }
    const notStartedIds = cancellableIds.filter((id) => !startedIds.includes(id));
    if (notStartedIds.length > 0) {
      // Not started: release driver/car; nobody earned anything that day.
      await tx.orderServiceItem.updateMany({
        where: { id: { in: notStartedIds }, is_external: false },
        data: {
          line_status: "CANCELLED",
          driver_id: null,
          car_id: null,
          driver_fee: 0,
          driver_fee_note: "Dibatalkan sebelum berangkat",
        },
      });
      await tx.orderServiceItem.updateMany({
        where: { id: { in: notStartedIds }, is_external: true },
        data: { line_status: "CANCELLED", rtr_amount: 0 },
      });
    }
    if (startedIds.length > 0) {
      // Already on the road (or already paid): keep who drove so their pay
      // stays with them.
      await tx.orderServiceItem.updateMany({
        where: { id: { in: startedIds } },
        data: { line_status: "CANCELLED" },
      });
    }
    for (const id of cancellableIds) await recomputeLineMoney(tx, id);

    // 3) Derive order status (all-cancelled → CANCELLED) + release resources.
    await deriveAndSetOrderStatus(tx, orderId);
    for (const dId of driverIds) await syncDriverStatus(tx, dId);
    for (const cId of carIds) await syncCarStatus(tx, cId);

    // 4) Issue the CANCELLATION_FEE invoice (penalty) with its PDF.
    let cancellationInvoiceNumber: string | null = null;
    if (prepared && order.customer) {
      await tx.invoice.create({
        data: {
          order_id: orderId,
          invoice_number: prepared.invoiceNumber,
          customer_seq: prepared.invoiceSeq,
          invoice_type: "CANCELLATION_FEE",
          payment_method: "BANK_TRANSFER",
          issue_date: now,
          amount: penalty,
          note: `${reason}\n${label}`,
          file_url: prepared.fileUrl,
          status: "ISSUED",
        },
      });
      cancellationInvoiceNumber = prepared.invoiceNumber;
    }

    // 5) Keep total_billed = sum(active invoices): remove voided, add penalty.
    if (order.customer) {
      const billedDelta = penalty - voidedSum;
      if (billedDelta !== 0) {
        await tx.customer.update({
          where: { id: order.customer.id },
          data: { total_billed: { increment: billedDelta } },
        });
      }
    }

    // 6) The order is now worth the penalty. Set final_price = penalty so the
    //    existing refund/payment flows compute correctly, and recompute
    //    payment_status against the new total (money received is unchanged).
    const paidToDate = Number(order.paid_to_date ?? 0);
    let paymentStatus: "UNPAID" | "DP_PAID" | "PAID";
    if (penalty > 0 && paidToDate >= penalty) paymentStatus = "PAID";
    else if (paidToDate > 0) paymentStatus = "DP_PAID";
    else paymentStatus = "UNPAID";

    await tx.order.update({
      where: { id: orderId },
      data: { final_price: penalty, payment_status: paymentStatus },
    });

    // 7) Audit log (preserve the original price).
    await tx.orderChangeLog.create({
      data: {
        order_id: orderId,
        field: "order_status",
        old_value: `${order.order_status} (final_price ${originalFinalPrice})`,
        new_value: `CANCELLED (cancellation fee ${penalty} — ${label})`,
        note: reason,
        actor: actor ?? "ADMIN",
      },
    });

    const refundDue = paidToDate > penalty ? paidToDate - penalty : 0;
    const stillOwed = penalty > paidToDate ? penalty - paidToDate : 0;
    return {
      tier,
      penalty,
      originalFinalPrice,
      paidToDate,
      refundDue,
      stillOwed,
      cancellationInvoiceNumber,
    } satisfies CancelOrderResult;
  }, {
    // Cancel runs many sequential round-trips (status derive + driver/car sync
    // loops + invoice/order writes) against the Supabase pooler; the default 5s
    // interactive-tx limit can be exceeded and yield P2028. Give it headroom.
    maxWait: 15000,
    timeout: 30000,
  });

  return result;
}
