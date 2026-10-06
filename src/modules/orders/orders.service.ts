import prisma from "../../prisma/client";
import { Prisma, type ScheduleStatus } from "@prisma/client";
import { AppError } from "../../utils/AppError";
import {
  assertOrderOpenForDayChanges,
  assertOrderPaidForDriverAssignment,
  netPaid,
  paymentStatusFor,
  rentalBaseOf,
  startPayment,
} from "./assignment-guard";
import {
  CreateOrderInput,
  UpdateOrderInput,
  AssignOrderInput,
  CreateAdjustmentInput,
  CreateChangeLogInput,
} from "./orders.validation";
import { upsertCustomerForOrder } from "../customers/customers.service";
import { attachLeadToOrder } from "../leads/leads.service";
import { notifyNewTrips, notifyTripsChanged, notifyTripsRemoved } from "../../services/tripNotify";
import { defaultDriverFee } from "../../utils/driverFee";
import { computeMargin, MARGIN_FORMULA_VERSION } from "../../utils/margin";
import { recomputeLineMoney } from "../schedule/line-money.service";
import { rollupOrderFinance } from "../schedule/schedule.service";
import { assertUnitsFree, lockUnits } from "../schedule/availability";
import { nextOrderCode } from "../../utils/codes";
import { wibShortDay } from "../../utils/wib";
import { buildCancellationFeePdf } from "../invoices/invoices.service";
import {
  deriveAndSetOrderStatus,
  refreshCarStatuses,
  refreshDriverStatuses,
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
  cancellation_fee?: unknown;
}): void {
  if (order.order_status === "DONE")
    throw new AppError("Order ini sudah selesai (difinalisasi), jadi tidak bisa diubah lagi.", 409);
  if (order.order_status === "CANCELLED")
    throw new AppError("Order ini sudah dibatalkan, jadi tidak bisa diubah lagi.", 409);
  // Cancelled after some days were done: still open for finalize, but its
  // total is the cancellation fee, so days and charges no longer change it.
  if (order.cancellation_fee != null)
    throw new AppError(
      "Sisa hari order ini sudah dibatalkan, jadi order tidak bisa diubah lagi. Tinggal finalisasi.",
      409,
    );
}

// What a day in the order form carries (everything else on a day belongs to
// Edit Hari: who serves it, its status, its money).
const DAY_CONTENT_FIELDS = [
  "service_date",
  "start_at",
  "end_at",
  "description",
  "service_kind",
  "service_package",
  "pickup_location",
  "dropoff_location",
  "driver_origin_location",
  "quantity",
  "unit_price",
  "total_price",
  "notes",
  "sort_order",
] as const;
// Changing these on a day already given to a driver tells the driver, and
// the customer confirmation / driver reminder must be sent again.
const DAY_SCHEDULE_FIELDS = [
  "service_date",
  "start_at",
  "end_at",
  "pickup_location",
  "dropoff_location",
] as const;

/**
 * A day that may be deleted by leaving it out of Edit Order: nothing is on it
 * yet. A driver or car, a trip started, reports or costs from the road, uang
 * jalan, money owed or paid, a partner's driver/plate, or a confirmation sent
 * to the customer keep it (it is cancelled from Edit Hari instead). One filter
 * for the check and for the delete itself.
 */
const DELETABLE_DAY: Prisma.OrderServiceItemWhereInput = {
  line_status: { in: ["SCHEDULED", "CANCELLED"] },
  driver_id: null,
  car_id: null,
  actual_start_at: null,
  trip_started_at: null,
  driver_name_raw: null,
  driver_phone_raw: null,
  plate_raw: null,
  confirmation_sent_at: null,
  OR: [{ travel_advance: null }, { travel_advance: 0 }],
  payable: { is: null },
  reports: { none: {} },
  expenses: { none: {} },
};

const dayForEditSelect = {
  id: true,
  line_status: true,
  service_date: true,
  start_at: true,
  end_at: true,
  description: true,
  service_kind: true,
  service_package: true,
  pickup_location: true,
  dropoff_location: true,
  driver_origin_location: true,
  quantity: true,
  unit_price: true,
  total_price: true,
  notes: true,
  sort_order: true,
} as const;

type DayForEdit = Prisma.OrderServiceItemGetPayload<{ select: typeof dayForEditSelect }>;
// Compile-time guard: every content field is read (else it would look changed).
const _everyContentFieldSelected: Record<
  Exclude<(typeof DAY_CONTENT_FIELDS)[number], keyof typeof dayForEditSelect>,
  never
> = {};
void _everyContentFieldSelected;

const wibYmd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" });

/**
 * Same value for the order form? A service date is the WIB calendar day (the
 * form sends WIB midnight; older days may hold another hour of that day);
 * times are compared to the minute (the form has no seconds).
 */
function sameValue(field: string, a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (a instanceof Date || b instanceof Date) {
    const x = new Date(a as Date);
    const y = new Date(b as Date);
    if (field === "service_date") return wibYmd.format(x) === wibYmd.format(y);
    return Math.floor(x.getTime() / 60000) === Math.floor(y.getTime() / 60000);
  }
  if (typeof a === "object" || typeof b === "object") return Number(a) === Number(b); // Decimal
  return a === b;
}

const reloadAndRetry = "Muat ulang halaman lalu simpan lagi.";

/**
 * Edit an order. The service days are merged by id, never replaced: a day the
 * form sends back with its id keeps its driver, car, status, reports, costs
 * and payable, and only the content fields that changed are written. A day
 * without an id is new. A day left out is deleted only when nothing is on it
 * yet (DELETABLE_DAY); otherwise the edit is refused, so an older dashboard
 * that sends no ids cannot wipe an assigned or running order.
 */
export async function updateOrder(id: string, input: UpdateOrderInput) {
  const order = await prisma.order.findUnique({
    where: { id },
    include: { service_items: { select: dayForEditSelect } },
  });
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

  // ── Service days: which to update, create and delete ─────────────────────
  type DayData = NonNullable<ReturnType<typeof normalizeServiceItems>>[number];
  type DayUpdate = { line: DayForEdit; data: Partial<DayData>; schedule: boolean };
  let days: { updates: DayUpdate[]; creates: DayData[]; deletes: string[] } | null =
    null;
  if (service_items) {
    if (service_items.length === 0)
      throw new AppError("Order harus punya minimal satu hari layanan.", 400);
    const normalized = normalizeServiceItems({ ...input, service_items }) ?? [];
    const existing = new Map(order.service_items.map((l) => [l.id, l]));
    const kept = new Set<string>();
    const updates: DayUpdate[] = [];
    const creates: DayData[] = [];
    normalized.forEach((data, i) => {
      const lineId = service_items[i].id;
      if (!lineId) {
        creates.push(data);
        return;
      }
      const line = existing.get(lineId);
      if (!line)
        throw new AppError(`Salah satu hari tidak ditemukan di order ini. ${reloadAndRetry}`, 400);
      if (kept.has(lineId))
        throw new AppError(`Satu hari terkirim dua kali. ${reloadAndRetry}`, 400);
      kept.add(lineId);
      // Only what changed is written. The order form has no field for the
      // driver's origin, so it is kept unless sent.
      const changed: Partial<DayData> = {};
      for (const f of DAY_CONTENT_FIELDS) {
        if (f === "driver_origin_location" && service_items[i].driver_origin_location === undefined)
          continue;
        if (!sameValue(f, data[f], line[f])) (changed as Record<string, unknown>)[f] = data[f];
      }
      if (Object.keys(changed).length > 0) {
        updates.push({
          line,
          data: changed,
          schedule: DAY_SCHEDULE_FIELDS.some((f) => f in changed),
        });
      }
    });
    const removed = order.service_items.filter((l) => !kept.has(l.id));
    if (removed.length > 0) {
      const deletable = new Set(
        (
          await prisma.orderServiceItem.findMany({
            where: { id: { in: removed.map((l) => l.id) }, ...DELETABLE_DAY },
            select: { id: true },
          })
        ).map((l) => l.id),
      );
      const busy = removed.filter((l) => !deletable.has(l.id));
      const label = (ls: DayForEdit[]) =>
        ls.map((l) => wibShortDay(l.service_date) || "tanpa tanggal").join(", ");
      const busyActive = busy.filter((l) => l.line_status !== "CANCELLED");
      const busyCancelled = busy.filter((l) => l.line_status === "CANCELLED");
      const reasons: string[] = [];
      if (busyActive.length)
        reasons.push(
          `Hari ${label(busyActive)} tidak bisa dihapus dari order karena sudah ada driver, mobil, perjalanan, laporan, biaya, uang jalan, tagihan, atau konfirmasi. Batalkan hari itu lewat Edit Hari di menu Trip.`,
        );
      if (busyCancelled.length)
        reasons.push(
          `Hari ${label(busyCancelled)} sudah dibatalkan tetapi menyimpan data perjalanan, fee, atau tagihan, jadi tetap tercatat di order. Biarkan hari itu di daftar; hari yang dibatalkan tidak dihitung di harga.`,
        );
      if (reasons.length) throw new AppError(reasons.join(" "), 409);
    }
    days = { updates, creates, deletes: removed.map((l) => l.id) };
  }

  // The total follows the days and billable charges (rollupOrderFinance); it
  // is changed through the days' prices, never set on its own.
  const { final_price: requestedPrice, ...orderFields } = updateData;
  if (!days && requestedPrice !== undefined && order.service_items.length > 0) {
    throw new AppError(
      "Harga order mengikuti harga per hari. Ubah harga di baris hari layanan.",
      400,
    );
  }
  // Did the admin change prices? (What the form asks a reason for: a day's
  // price, or a priced day added or removed.)
  const pricesChanged =
    !!days &&
    (days.updates.some((u) => "total_price" in u.data && u.line.line_status !== "CANCELLED") ||
      days.creates.some((d) => Number(d.total_price ?? 0) !== 0) ||
      order.service_items.some(
        (l) =>
          days!.deletes.includes(l.id) &&
          l.line_status !== "CANCELLED" &&
          Number(l.total_price ?? 0) !== 0,
      ));
  if (pricesChanged && !change_reason?.trim()) {
    throw new AppError("change_reason is required when changing final_price", 400);
  }
  // Drivers to tell about a moved day (sent after the transaction commits).
  const movedForDriver = new Map<string, string[]>();
  // Drivers/cars of moved days: ON_DUTY / IN_USE follow the trip date.
  const movedDrivers = new Set<string>();
  const movedCars = new Set<string>();

  const result = await prisma.$transaction(
    async (tx) => {
      // Days first, then the order row: the same lock order as the driver
      // app and Edit Hari (day → order), so they cannot deadlock.
      if (days) {
        if (days.deletes.length > 0) {
          // Re-checked inside the transaction: a day assigned (or reported
          // on) after the check above is kept.
          const { count } = await tx.orderServiceItem.deleteMany({
            where: { id: { in: days.deletes }, order_id: id, ...DELETABLE_DAY },
          });
          if (count !== days.deletes.length) {
            throw new AppError(
              `Hari yang mau dihapus baru saja ditugaskan atau punya laporan. ${reloadAndRetry}`,
              409,
            );
          }
        }
        for (const u of days.updates) {
          let fresh;
          try {
            fresh = await tx.orderServiceItem.update({
              where: { id: u.line.id },
              data: {
                ...u.data,
                // A moved day: the customer confirmation and the driver
                // reminder go out again.
                ...(u.schedule
                  ? {
                      confirmation_sent_at: null,
                      confirmation_sent_snapshot: Prisma.DbNull,
                      driver_reminder_sent_at: null,
                      driver_reminder_snapshot: Prisma.DbNull,
                    }
                  : {}),
              },
              select: {
                is_external: true,
                driver_id: true,
                car_id: true,
                line_status: true,
                payable: { select: { id: true } },
              },
            });
          } catch (err) {
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025")
              throw new AppError(`Salah satu hari baru saja dihapus. ${reloadAndRetry}`, 409);
            throw err;
          }
          // Revenue or date changed: margin and payable follow, except on a
          // partner day nobody has priced yet (no payable), which createOrder
          // and Edit Hari leave alone until the day is assigned.
          const moneyChanged = "total_price" in u.data || "service_date" in u.data;
          if (moneyChanged && !(fresh.is_external && !fresh.payable)) {
            await recomputeLineMoney(tx, u.line.id);
          }
          if (u.schedule && !fresh.is_external) {
            if (fresh.driver_id) movedDrivers.add(fresh.driver_id);
            if (fresh.car_id) movedCars.add(fresh.car_id);
          }
          if (
            u.schedule &&
            fresh.driver_id &&
            !fresh.is_external &&
            fresh.line_status !== "DONE" &&
            fresh.line_status !== "CANCELLED"
          ) {
            const list = movedForDriver.get(fresh.driver_id) ?? [];
            list.push(u.line.id);
            movedForDriver.set(fresh.driver_id, list);
          }
        }
      }

      const updated = await tx.order.update({
        where: { id },
        data: {
          ...orderFields,
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
          ...(!days && requestedPrice !== undefined
            ? { final_price: requestedPrice }
            : {}),
          customers: normalizedCustomers
            ? {
                deleteMany: {},
                create: normalizedCustomers,
              }
            : undefined,
        },
      });

      if (days) {
        // A day this request did not know about (another tab, or the same
        // save sent twice) was added meanwhile: refuse rather than add a
        // second copy. The order row lock above makes this check reliable.
        const appeared = await tx.orderServiceItem.count({
          where: { order_id: id, id: { notIn: order.service_items.map((l) => l.id) } },
        });
        if (appeared > 0) {
          throw new AppError(`Order ini baru saja diubah di tab atau perangkat lain. ${reloadAndRetry}`, 409);
        }
        // A new day is a partner day only on an order made for a partner that
        // still is one; a mixed order's new days start internal.
        const partner = updated.is_external && !!updated.external_vendor_id;
        for (const d of days.creates) {
          await tx.orderServiceItem.create({
            data: {
              ...d,
              order_id: id,
              line_status: "SCHEDULED",
              is_external: partner,
              external_vendor_id: partner ? updated.external_vendor_id : null,
              external_car_id: partner ? updated.external_car_id : null,
              ops_cost: 0,
            },
          });
        }
        // Cancelling a whole order goes through cancelOrder (penalty, fee
        // invoice, log), never through removing its last open days.
        const open = await tx.orderServiceItem.count({
          where: { order_id: id, line_status: { not: "CANCELLED" } },
        });
        if (open === 0) {
          throw new AppError(
            "Semua hari yang tersisa sudah dibatalkan. Untuk membatalkan order, pakai tombol Batalkan Pesanan (denda dihitung sesuai kebijakan).",
            409,
          );
        }
        // B1.1 (owner, 6 Oct 2026): removing the last days still to run while
        // other days are done would end the order without the cancellation
        // fee, like cancelling them in Edit Hari.
        const toRun: ScheduleStatus[] = ["SCHEDULED", "ASSIGNED", "IN_PROGRESS"];
        if (order.service_items.some((l) => toRun.includes(l.line_status))) {
          const stillToRun = await tx.orderServiceItem.count({
            where: { order_id: id, line_status: { in: toRun } },
          });
          if (stillToRun === 0)
            throw new AppError(
              "Hari yang dihapus adalah hari terakhir yang masih aktif. Pakai tombol Batalkan Pesanan supaya biaya pembatalan dihitung.",
              409,
            );
        }
        if (days.updates.length || days.creates.length || days.deletes.length) {
          await rollupOrderFinance(tx, id);
          await deriveAndSetOrderStatus(tx, id);
          await refreshDriverStatuses(tx, [...movedDrivers]);
          await refreshCarStatuses(tx, [...movedCars]);
        }
      }

      // The total as stored now (days + billable charges, by the rollup).
      const after = await tx.order.findUniqueOrThrow({ where: { id } });
      const priceChanged =
        Math.round(Number(after.final_price) * 100) !==
        Math.round(Number(order.final_price) * 100);
      if (pricesChanged) {
        const active = await tx.invoice.aggregate({
          where: { order_id: id, status: { notIn: ["REVISED", "CANCELLED"] } },
          _sum: { amount: true },
        });
        const invoicedTotal = Number(active._sum.amount ?? 0);
        if (Number(after.final_price) < invoicedTotal) {
          throw new AppError(
            `final_price cannot be lower than active invoice total (${invoicedTotal}). Revise/cancel invoices first.`,
            409,
          );
        }
        await tx.orderChangeLog.create({
          data: {
            order_id: id,
            field: "final_price",
            old_value: String(order.final_price),
            new_value: String(after.final_price),
            note: change_reason,
            actor: "ADMIN",
          },
        });
      } else if (priceChanged) {
        // No price was edited, but the stored total was out of date (e.g.
        // charges an older edit left out); the rollup corrected it.
        await tx.orderChangeLog.create({
          data: {
            order_id: id,
            field: "final_price",
            old_value: String(order.final_price),
            new_value: String(after.final_price),
            note: "Dihitung ulang dari hari layanan dan biaya tambahan",
            actor: "SYSTEM",
          },
        });
      }

      return after;
    },
    { maxWait: 15000, timeout: 30000 },
  );

  // Drivers whose day moved hear about it (best-effort, after commit).
  for (const [driverId, lineIds] of movedForDriver) {
    void notifyTripsChanged(driverId, lineIds);
  }
  return result;
}

export async function assignOrder(orderId: string, input: AssignOrderInput) {
  // Validate order
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { service_items: { select: { total_price: true, line_status: true } } },
  });
  if (!order) throw new AppError("Order not found", 404);
  assertOrderOpenForDayChanges(order);
  if (order.order_status !== "CREATED") {
    throw new AppError(
      "Order must be in CREATED status to assign a driver",
      409,
    );
  }
  assertOrderPaidForDriverAssignment(order);

  const driver = await prisma.driver.findUnique({
    where: { id: input.driver_id },
  });
  if (!driver) throw new AppError("Driver not found", 404);
  const car = await prisma.car.findUnique({ where: { id: input.car_id } });
  if (!car) throw new AppError("Car not found", 404);

  // Merge: assign at the LINE level (the line IS the trip). Every internal
  // day-line that has no driver yet inherits this driver+car and flips to
  // ASSIGNED, exactly like a per-day assign; order + driver/car status are
  // then derived from the lines. Only open days: a cancelled or finished day
  // must not come back to life.
  const openUnassigned = {
    order_id: orderId,
    is_external: false,
    driver_id: null,
    line_status: { in: ["SCHEDULED", "ASSIGNED"] as ScheduleStatus[] },
  };
  const newLines = await prisma.orderServiceItem.findMany({
    where: openUnassigned,
    select: {
      id: true,
      service_kind: true,
      driver_fee: true,
      service_date: true,
      start_at: true,
      end_at: true,
    },
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
          // Nobody accepted these days yet: the app asks "Terima tugas".
          driver_accepted_at: null,
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
      // Free on these days' dates and times (not by Driver/Car status: a
      // driver booked for another date is free here). Checked under the order
      // and unit locks, so a concurrent assign of the same driver or car to an
      // overlapping day waits and is then refused.
      await lockUnits(tx, [input.driver_id], [input.car_id]);
      await assertUnitsFree(tx, { driver, car }, got);
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
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { service_items: { select: { total_price: true, line_status: true } } },
  });
  if (!order) throw new AppError("Order not found", 404);
  assertOrderOpenForDayChanges(order);

  // Only the not-yet-started internal lines that have a driver are eligible
  // for a swap: ASSIGNED, plus SCHEDULED days given a driver before per-day
  // assignment made them ASSIGNED (they become ASSIGNED here).
  const swappable: Prisma.OrderServiceItemWhereInput = {
    order_id: orderId,
    is_external: false,
    OR: [
      { line_status: "ASSIGNED" },
      { line_status: "SCHEDULED", driver_id: { not: null } },
    ],
  };
  const eligibleLines = await prisma.orderServiceItem.findMany({
    where: swappable,
    select: {
      id: true,
      driver_id: true,
      car_id: true,
      service_date: true,
      start_at: true,
      end_at: true,
    },
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

  const driver = await prisma.driver.findUnique({
    where: { id: input.driver_id },
  });
  if (!driver) throw new AppError("Driver not found", 404);
  const car = await prisma.car.findUnique({ where: { id: input.car_id } });
  if (!car) throw new AppError("Car not found", 409);
  // The new driver / car must be free at the times of the days they take
  // over (by date and time, not by Driver/Car status). Days that keep the
  // same driver or car are not checked again. Checked in the transaction
  // below, under the order and unit locks.
  const driverDays = eligibleLines.filter((l) => l.driver_id !== input.driver_id);
  const carDays = eligibleLines.filter((l) => l.car_id !== input.car_id);

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
    const mine = { id: { in: eligibleLines.map((l) => l.id) } };
    // Days the new driver already has keep their acceptance (car swap only).
    await tx.orderServiceItem.updateMany({
      where: { AND: [swappable, mine, { driver_id: input.driver_id }] },
      data: { car_id: input.car_id, line_status: "ASSIGNED" },
    });
    // A day moving to another driver: not accepted by them yet.
    await tx.orderServiceItem.updateMany({
      where: {
        AND: [
          swappable,
          mine,
          { OR: [{ driver_id: null }, { driver_id: { not: input.driver_id } }] },
        ],
      },
      data: {
        driver_id: input.driver_id,
        car_id: input.car_id,
        line_status: "ASSIGNED",
        driver_accepted_at: null,
      },
    });
    // The unpaid driver payables follow the days to the new driver.
    for (const l of eligibleLines) await recomputeLineMoney(tx, l.id);
    await rollupOrderFinance(tx, orderId);
    // Old and new units locked in id order (no deadlock with a concurrent
    // swap the other way); a concurrent assign of the new driver or car to
    // an overlapping day waits here and is then refused.
    await lockUnits(tx, [input.driver_id, ...oldDriverIds], [input.car_id, ...oldCarIds]);
    if (driverDays.length) await assertUnitsFree(tx, { driver }, driverDays);
    if (carDays.length) await assertUnitsFree(tx, { car }, carDays);
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
      // Under the order lock: a cancel or finalize that committed meanwhile
      // wins, and a cancel of the remaining days is read fresh for the note.
      await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${orderId} FOR NO KEY UPDATE`;
      const fresh = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { order_status: true, cancellation_fee: true, cancellation_reason: true },
      });
      if (fresh.order_status === "DONE" || fresh.order_status === "CANCELLED") {
        throw new AppError("Order ini sudah selesai atau sudah dibatalkan.", 409);
      }
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
          note:
            fresh.cancellation_fee != null
              ? `Order finalized by admin (finance reviewed); remaining days were cancelled (fee ${Number(fresh.cancellation_fee)}): ${fresh.cancellation_reason ?? "-"}`
              : "Order finalized by admin (finance reviewed)",
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
  // Penalties are in whole rupiah (B12): the fee is billed to the customer.
  const todayJakarta = jakartaDate(now);
  const jakartaNow = new Date(now.getTime() + JAKARTA_OFFSET_MS);
  const jakartaHour = jakartaNow.getUTCHours();
  const jakartaMin = jakartaNow.getUTCMinutes();

  // No service date at all → treat as early cancel (Tier 1).
  if (!firstServiceDate) {
    return {
      tier: 1,
      penalty: Math.round(finalPrice * 0.2),
      label: "Tier 1 (tanpa tanggal layanan) — DP 20% hangus",
    };
  }

  const firstDayJakarta = jakartaDate(firstServiceDate);

  if (todayJakarta < firstDayJakarta) {
    // Cancel on any calendar day before the service date → forfeit DP (20%).
    return {
      tier: 1,
      penalty: Math.round(finalPrice * 0.2),
      label: "Tier 1 (sebelum hari H) — DP 20% hangus",
    };
  }

  if (todayJakarta === firstDayJakarta) {
    const before10 =
      jakartaHour < 10 || (jakartaHour === 10 && jakartaMin === 0);
    if (before10 && !anyLineStarted) {
      return {
        tier: 2,
        penalty: Math.round(finalPrice * 0.5),
        label: "Tier 2 (hari H sebelum pukul 10.00) — 50% dari total",
      };
    }
    return {
      tier: 3,
      penalty: Math.round(finalPrice),
      label:
        "Tier 3 (hari H setelah pukul 10.00 / driver tiba) — 100% dari total",
    };
  }

  // Cancel after the first service day has passed → 100%.
  return {
    tier: 3,
    penalty: Math.round(finalPrice),
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
 *    for what is still owed (penalty − money already received; none when the
 *    money received covers it) and INCREMENTS total_billed by that amount →
 *    preserves the G9 invariant total_billed = sum(active invoices).
 *  - cancels all active lines → order status derives to CANCELLED; releases
 *    drivers/cars. Days already DONE are kept: the order then stays open and
 *    closes through finalize (decided 6 Oct 2026).
 *  - stores cancelled_at / cancellation_fee / cancellation_reason (what marks
 *    the order as cancelled for rollupOrderFinance and the reports), recomputes
 *    payment_status against the new (penalty) total and re-rolls the order
 *    finance so the order card margin includes the fee.
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
  if (order.cancellation_fee != null) {
    throw new AppError(
      "Sisa hari order ini sudah dibatalkan. Tinggal finalisasi.",
      409,
    );
  }
  // Every day already done (awaiting finalize): nothing is left to cancel.
  if (
    order.service_items.length > 0 &&
    order.service_items.every((l) => l.line_status === "DONE" || l.line_status === "CANCELLED")
  ) {
    throw new AppError(
      "Semua hari order ini sudah selesai, jadi tidak ada yang bisa dibatalkan. Tutup order lewat Finalisasi.",
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

  // What the customer still owes toward the penalty. Money already received
  // (a DP, or the full price) counts against it; the transaction re-reads it.
  // Whole rupiah, like the penalty (B12).
  const owedFor = (paid: number) => Math.max(0, Math.round(penalty - paid));
  const paidBefore = netPaid(order);
  const owedBefore = owedFor(paidBefore);

  // ── Render the cancellation-fee PDF + reserve its number OUTSIDE the main
  //    tx (slow network work; mirrors generateInvoice). Skip if no customer
  //    is linked (cannot issue a numbered invoice without a customer code),
  //    or when nothing is owed (no invoice to issue).
  let prepared:
    | { invoiceNumber: string; invoiceSeq: number; fileUrl: string }
    | null = null;
  if (order.customer && owedBefore > 0) {
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
      alreadyPaid: paidBefore,
      tierLabel: label,
      reason,
      issueDate: now,
    });
    prepared = built;
  }

  // ── Mutations in one transaction ────────────────────────────────────────
  const result = await prisma.$transaction(async (tx) => {
    // 0) Lock the order and re-check under the lock: a second click (or a
    //    finalize) that committed meanwhile wins and this cancel stops.
    await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${orderId} FOR NO KEY UPDATE`;
    const fresh = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { order_status: true, cancellation_fee: true },
    });
    if (
      fresh.order_status === "DONE" ||
      fresh.order_status === "CANCELLED" ||
      fresh.cancellation_fee != null
    ) {
      throw new AppError("Order ini sudah dibatalkan atau sudah selesai.", 409);
    }

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

    // Money received, read now: the invoices are locked by step 1, so a
    // payment recorded while the fee PDF was being built is included. The PDF
    // was made for owedBefore; if that changed, stop and let the admin retry.
    const money = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: { paid_to_date: true, is_refunded: true, refund_amount: true },
    });
    const paidToDate = Number(money.paid_to_date ?? 0);
    const owed = owedFor(netPaid(money));
    if (owed !== owedBefore) {
      throw new AppError(
        "Ada pembayaran yang baru tercatat saat pesanan dibatalkan. Coba batalkan lagi.",
        409,
      );
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

    // 4) Issue the CANCELLATION_FEE invoice for what is still owed, with its
    //    PDF (penalty − already paid = remaining). Nothing owed → no invoice:
    //    a fee invoice over money already received would be paid twice.
    let cancellationInvoiceNumber: string | null = null;
    let invoiced = 0;
    if (prepared && order.customer && owed > 0) {
      await tx.invoice.create({
        data: {
          order_id: orderId,
          invoice_number: prepared.invoiceNumber,
          customer_seq: prepared.invoiceSeq,
          invoice_type: "CANCELLATION_FEE",
          payment_method: "BANK_TRANSFER",
          issue_date: now,
          amount: owed,
          note: `${reason}\n${label}`,
          file_url: prepared.fileUrl,
          status: "ISSUED",
        },
      });
      cancellationInvoiceNumber = prepared.invoiceNumber;
      invoiced = owed;
    }

    // 5) Keep total_billed = sum(active invoices): remove voided, add the new one.
    if (order.customer) {
      const billedDelta = invoiced - voidedSum;
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
    //    The cancellation fields mark the order as cancelled even when done
    //    days keep it open, so later roll-ups keep the penalty as its price.
    // The DP rule counts the days that were not cancelled (the done ones).
    const paymentStatus = paymentStatusFor(
      netPaid(money),
      penalty,
      rentalBaseOf(order.service_items.filter((l) => l.line_status === "DONE")),
    );

    await tx.order.update({
      where: { id: orderId },
      data: {
        final_price: penalty,
        payment_status: paymentStatus,
        cancelled_at: now,
        cancellation_fee: penalty,
        cancellation_reason: reason,
      },
    });
    await rollupOrderFinance(tx, orderId);

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

    // Net of any refund already made, like `owed` and payment_status.
    const refundDue = Math.max(0, Math.round(netPaid(money) - penalty));
    return {
      tier,
      penalty,
      originalFinalPrice,
      paidToDate,
      refundDue,
      stillOwed: owed,
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
