import prisma from "../../prisma/client";
import { Prisma, type ScheduleStatus } from "@prisma/client";
import { AppError } from "../../utils/AppError";
import {
  assertNotLastOpenDay,
  assertOrderOpenForDayChanges,
  assertOrderPaidForDriverAssignment,
  dpBaseOf,
  netPaid,
  OPEN_DAY_STATUSES,
  paymentOrderSelect,
  paymentStatusFor,
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
import { cancelDecisionTime, dayArrivedBy, dayCancellation, dayDateOf, TIER_PCT } from "./cancellation-policy";
import { recomputeLineMoney } from "../schedule/line-money.service";
import { manualFeeLog, rollupOrderFinance } from "../schedule/schedule.service";
import { assertUnitsFree, lockUnits } from "../schedule/availability";
import { nextOrderCode } from "../../utils/codes";
import { wibShortDay } from "../../utils/wib";
import { buildCancellationFeePdf, cancellationLogValue, invoiceView } from "../invoices/invoices.service";
import { rupiah } from "../../services/adminNotify";
import {
  addCreditEntry,
  assertOpenWithinTotal,
  computeOrderMoney,
  lockOrder,
  lockOrderDays,
  moneyState,
  type MoneyState,
  recomputePaymentStatus,
  rp,
  sen,
} from "./order-money";
import {
  deriveAndSetOrderStatus,
  refreshCarStatuses,
  refreshDriverStatuses,
  syncDriverStatus,
  syncCarStatus,
} from "../schedule/order-derive.service";
import { env } from "../../config/env";
import {
  uploadFile,
  removeFile,
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
      pickup_lat: item.pickup_lat ?? null,
      pickup_lng: item.pickup_lng ?? null,
      pickup_place_id: item.pickup_place_id ?? null,
      dropoff_lat: item.dropoff_lat ?? null,
      dropoff_lng: item.dropoff_lng ?? null,
      dropoff_place_id: item.dropoff_place_id ?? null,
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
      // An order with a refund is still active (finance design §7): with
      // several refunds per order it must not drop out of the list.
      and.push({ order_status: { not: "CANCELLED" } });
      and.push({ invoice_missing: false });
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
      // is_refunded alone: sheet imports (scripts/import-workbook.js) mark
      // a refund without an amount.
      and.push({ OR: [{ refunded_total: { gt: 0 } }, { is_refunded: true }] });
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
      refunds: {
        orderBy: { refunded_at: "asc" as const },
        select: { id: true, amount: true, refunded_at: true, note: true, proof_url: true },
      },
      credit_entries: {
        orderBy: { created_at: "asc" as const },
        select: {
          kind: true,
          amount: true,
          created_at: true,
          note: true,
          invoice: { select: { invoice_number: true } },
        },
      },
    },
  });

  if (!order) throw new AppError("Order not found", 404);
  const { refunds, credit_entries, invoices, ...rest } = order;
  return {
    ...rest,
    // Per invoice also: gross (cash asked + saldo lebih used) and shortfall.
    invoices: invoices.map(invoiceView),
    // Paid in full = trips may start (driver app "Berangkat"); see startPayment.
    // Kept for older clients; `money` carries the same numbers.
    start_payment: startPayment(order, order.service_items),
    // One money model for every screen (finance design §2, order-money.ts).
    money: await computeOrderMoney(prisma, id),
    // The proof is a private storage path: only whether there is one.
    refunds: refunds.map(({ proof_url, ...r }) => ({ ...r, has_proof: !!proof_url })),
    credit_entries: credit_entries.map(({ invoice, ...e }) => ({
      ...e,
      invoice_number: invoice?.invoice_number ?? null,
    })),
  };
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
  "pickup_lat",
  "pickup_lng",
  "pickup_place_id",
  "dropoff_lat",
  "dropoff_lng",
  "dropoff_place_id",
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
export const DAY_DELETE_NEEDS_CANCEL_MESSAGE =
  "Batalkan hari itu lewat Edit Hari supaya biaya pembatalan dihitung";

/**
 * Edit Order may delete a day that counts toward the total (not cancelled,
 * or cancelled with a fee) only while the order has no money: Net = 0, no
 * unpaid invoice and no PAID invoice (owner, 7 Oct 2026; finance design
 * §3.1). Otherwise 409 DAY_DELETE_NEEDS_CANCEL. Under the order lock.
 */
async function assertDayDeleteFree(tx: Prisma.TransactionClient, orderId: string, dayIds: string[]) {
  const counted = await tx.orderServiceItem.count({
    where: {
      id: { in: dayIds },
      order_id: orderId,
      OR: [{ line_status: { not: "CANCELLED" } }, { cancel_fee: { gt: 0 } }],
    },
  });
  if (counted === 0) return;
  const [m, paidInvoices] = await Promise.all([
    moneyState(tx, orderId),
    tx.invoice.count({ where: { order_id: orderId, status: "PAID" } }),
  ]);
  if (!m) return;
  if (m.net !== 0 || m.open > 0 || paidInvoices > 0) {
    throw new AppError(`${DAY_DELETE_NEEDS_CANCEL_MESSAGE}.`, 409, {
      code: "DAY_DELETE_NEEDS_CANCEL",
      net_paid: rp(m.net),
      open_billed: rp(m.open),
      paid_invoices: paidInvoices,
    });
  }
}

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
  pickup_lat: true,
  pickup_lng: true,
  pickup_place_id: true,
  dropoff_lat: true,
  dropoff_lng: true,
  dropoff_place_id: true,
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

/** A day field the order form may leave out to keep the stored value. */
function keptUnlessSent(
  field: (typeof DAY_CONTENT_FIELDS)[number],
  sent: NonNullable<UpdateOrderInput["service_items"]>[number],
): boolean {
  switch (field) {
    case "driver_origin_location":
    case "pickup_lat":
    case "pickup_lng":
    case "dropoff_lat":
    case "dropoff_lng":
      return sent[field] === undefined;
    case "pickup_place_id":
      return sent.pickup_place_id === undefined && sent.pickup_lat === undefined;
    case "dropoff_place_id":
      return sent.dropoff_place_id === undefined && sent.dropoff_lat === undefined;
    default:
      return false;
  }
}

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
      // driver's origin, so it is kept unless sent; so are the map points
      // (a place id goes with its point: a point sent without one clears it).
      const changed: Partial<DayData> = {};
      for (const f of DAY_CONTENT_FIELDS) {
        if (keptUnlessSent(f, service_items[i])) continue;
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
      // B1.1: does this save remove a day still to run?
      let deletesOpenDay = false;
      // Days first, then the order row: the same lock order as the driver
      // app and Edit Hari (day → order), so they cannot deadlock. All days in
      // id order, as cancelOrder (B9 lock order, order-money.ts).
      if (days) {
        await lockOrderDays(tx, id);
        if (days.deletes.length > 0) {
          // Owner, 7 Oct 2026 (Q6): removing a day is free only while the
          // order has no money and no active invoice. Otherwise the day is
          // cancelled through Edit Hari, so its cancellation fee is charged.
          // Checked under the order lock (B9: days, then the order), so a
          // payment recorded at the same moment is seen.
          await lockOrder(tx, id);
          await assertDayDeleteFree(tx, id, days.deletes);
          deletesOpenDay =
            (await tx.orderServiceItem.count({
              where: { id: { in: days.deletes }, order_id: id, line_status: { in: OPEN_DAY_STATUSES } },
            })) > 0;
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
        // B1.1: removing the last days still to run while other days are
        // done would end the order without the cancellation fee, like
        // cancelling them in Edit Hari. Only a save that removes such a day;
        // checked on the days as they are now, under the order lock.
        if (deletesOpenDay) await assertNotLastOpenDay(tx, id);
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
        // INV-6 (A3): a lower total may leave money beyond it (the rollup
        // released it as saldo lebih), but unpaid invoices may not ask more
        // than is still owed (409 OPEN_INVOICE_EXCEEDS with the amounts).
        if (sen(after.final_price) < sen(order.final_price)) {
          await assertOpenWithinTotal(tx, id, "Perubahan harga ini");
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
    select: { ...paymentOrderSelect, order_status: true },
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
      // B9 lock order (order-money.ts): the days in id order, then the order.
      await lockOrderDays(tx, orderId);
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
    select: { ...paymentOrderSelect, order_status: true },
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
    // B9 lock order (order-money.ts): the days in id order, then the order.
    await lockOrderDays(tx, orderId);
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

/**
 * Add a charge (or a non-billable note) to an order. `created` is false when
 * the client_ref already made this charge: it is returned unchanged (B8).
 */
export async function createOrderAdjustment(
  orderId: string,
  input: CreateAdjustmentInput,
) {
  const byRef = async (db: Prisma.TransactionClient | typeof prisma) => {
    if (!input.client_ref) return null;
    const seen = await db.orderAdjustment.findUnique({ where: { client_ref: input.client_ref } });
    if (seen && seen.order_id !== orderId) throw new AppError("client_ref sudah dipakai untuk order lain.", 409);
    return seen;
  };
  const replay = await byRef(prisma);
  if (replay) return { adjustment: replay, created: false };
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new AppError("Order not found", 404);
  assertOrderStructurallyEditable(order);

  try {
    return await prisma.$transaction(async (tx) => {
      // B9 lock order (order-money.ts): the order row first, then the checks
      // again on what is committed now (a cancel or finalize meanwhile wins).
      await lockOrder(tx, orderId);
      const seen = await byRef(tx);
      if (seen) return { adjustment: seen, created: false };
      const fresh = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { order_status: true, cancellation_fee: true, final_price: true },
      });
      assertOrderStructurallyEditable(fresh);
      const adjustment = await tx.orderAdjustment.create({
        data: {
          order_id: orderId,
          type: input.type,
          description: input.description,
          amount: input.amount,
          quantity: input.quantity,
          is_billable: input.is_billable,
          created_by: input.created_by,
          client_ref: input.client_ref ?? null,
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
                Number(fresh.final_price) + input.amount * input.quantity,
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

      return { adjustment, created: true };
    }, { maxWait: 15000, timeout: 20000 });
  } catch (err) {
    // The same client_ref committed at the same moment (unique key; on this
    // order the lock above already serializes them): answer with that row.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const seen = await byRef(prisma);
      if (seen) return { adjustment: seen, created: false };
    }
    throw err;
  }
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

/**
 * Refunds (finance design §3.5, owner decision 7 Oct 2026): several per
 * order, each at most the saldo lebih (INV-7, checked under the order lock).
 * One transaction writes the refund row, its REFUND credit entry,
 * refunded_total and the old single-refund columns (is_refunded,
 * refund_amount = the cumulative total, refunded_at / refund_proof_url /
 * refund_note = the latest), then recomputes payment_status on Net.
 * Refunding credit while the customer still owes (a prepayment) is allowed;
 * outstanding_after tells the admin the piutang it leaves.
 *
 * `amount` undefined = the whole saldo lebih (the old endpoint's default).
 * `created` is false when the client_ref already made this refund.
 */
async function recordRefund(
  orderId: string,
  input: { amount?: number; note?: string; clientRef?: string; proof?: UploadedFile; actor?: string },
) {
  const proofFile = assertValidUpload(input.proof);
  const byRef = async (db: Prisma.TransactionClient | typeof prisma) => {
    if (!input.clientRef) return null;
    const seen = await db.orderRefund.findUnique({ where: { client_ref: input.clientRef } });
    if (seen && seen.order_id !== orderId) throw new AppError("client_ref sudah dipakai untuk order lain.", 409);
    return seen;
  };
  const replay = await byRef(prisma);
  if (replay) return { refund: replay, created: false };

  const before = await moneyState(prisma, orderId);
  if (!before) throw new AppError("Order not found", 404);
  // The amount is fixed here (what the admin confirmed), then bounded again
  // by the saldo lebih under the lock: a double submit cannot refund twice.
  const amount = input.amount != null ? sen(input.amount) : before.credit;
  if (amount <= 0) {
    throw new AppError(
      "Tidak ada saldo lebih untuk dikembalikan di order ini (No refund is due on this order).",
      400,
    );
  }
  const tooMuch = (credit: number) =>
    new AppError(
      `Pengembalian ${rupiah(rp(amount))} melebihi saldo lebih. Saldo lebih tinggal ${rupiah(rp(credit))}.`,
      409,
      { code: "REFUND_EXCEEDS_CREDIT", credit_balance: rp(credit) },
    );
  if (amount > before.credit) throw tooMuch(before.credit);

  const proofUpload = await uploadFile(proofFile, {
    bucket: PAYMENT_PROOFS_BUCKET,
    prefix: `refunds/${orderId}`,
  });
  const refundedAt = new Date();
  let result: { refund: Awaited<ReturnType<typeof prisma.orderRefund.create>>; created: boolean };
  try {
    result = await prisma.$transaction(async (tx) => {
      // B9 lock order (order-money.ts): the order row; the refund and its
      // credit entry are inserts.
      await lockOrder(tx, orderId);
      const seen = await byRef(tx);
      if (seen) return { refund: seen, created: false };
      const m = await moneyState(tx, orderId);
      if (!m) throw new AppError("Order not found", 404);
      if (amount > m.credit) throw tooMuch(m.credit);
      const refund = await tx.orderRefund.create({
        data: {
          order_id: orderId,
          amount: rp(amount),
          refunded_at: refundedAt,
          proof_url: proofUpload.path,
          note: input.note ?? null,
          client_ref: input.clientRef ?? null,
          created_by: input.actor ?? "ADMIN",
        },
      });
      await addCreditEntry(tx, {
        orderId,
        kind: "REFUND",
        amount: -rp(amount),
        refundId: refund.id,
        note: input.note ? `Pengembalian dana: ${input.note}` : "Pengembalian dana",
        actor: input.actor ?? "ADMIN",
      });
      const refundedTotal = rp(m.refunded + amount);
      await tx.order.update({
        where: { id: orderId },
        data: {
          refunded_total: refundedTotal,
          // The old single-refund columns, for older clients: the total so
          // far and the latest refund.
          is_refunded: true,
          refund_amount: refundedTotal,
          refunded_at: refundedAt,
          refund_proof_url: proofUpload.path,
          refund_note: input.note ?? null,
        },
      });
      // INV-9: Net fell, so the status may too (a prepayment refunded).
      await recomputePaymentStatus(tx, orderId);
      return { refund, created: true };
    }, { maxWait: 15000, timeout: 20000 });
  } catch (err) {
    // Not recorded: the proof must not stay behind in the bucket.
    void removeFile(PAYMENT_PROOFS_BUCKET, proofUpload.path);
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const seen = await byRef(prisma);
      if (seen) return { refund: seen, created: false };
    }
    throw err;
  }
  // A resend that the lock found already recorded: our copy of the proof is
  // not on any refund.
  if (!result.created) void removeFile(PAYMENT_PROOFS_BUCKET, proofUpload.path);
  return result;
}

/** The refund as the API returns it: no storage path, only whether there is a proof. */
const refundView = ({ proof_url, ...r }: { proof_url: string | null } & Record<string, unknown>) => ({
  ...r,
  has_proof: !!proof_url,
});

/**
 * POST /orders/:id/refunds (multipart: proof, amount, note, client_ref).
 * 201 { refund, order_money, outstanding_after }; a resend of the same
 * client_ref → 200 with the same refund and nothing deducted again.
 */
export async function createOrderRefund(
  orderId: string,
  input: { amount: number; note?: string; client_ref: string; proof?: UploadedFile },
) {
  const { refund, created } = await recordRefund(orderId, {
    amount: input.amount,
    note: input.note,
    clientRef: input.client_ref,
    proof: input.proof,
  });
  const money = await computeOrderMoney(prisma, orderId);
  return {
    created,
    data: {
      refund: refundView(refund),
      order_money: money,
      outstanding_after: money?.outstanding ?? 0,
    },
  };
}

/**
 * The old "refund settled" endpoint (POST /orders/:id/mark-refunded), kept
 * as an alias for one release so the dashboard in production keeps working:
 * each call is a new refund, its amount defaults to the whole saldo lebih and
 * is bounded by it (a second click finds no credit left). Answers the order,
 * as before.
 */
export async function markOrderRefunded(
  orderId: string,
  input: { note?: string; amount?: number; proof?: UploadedFile },
) {
  await recordRefund(orderId, { amount: input.amount, note: input.note, proof: input.proof });
  return prisma.order.findUniqueOrThrow({ where: { id: orderId } });
}

// Sprint 5: short-lived signed URL for the (private) proof of the latest refund.
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

/** GET /orders/:id/refunds/:refundId/proof: a fresh 5-minute signed URL per click. */
export async function getOrderRefundProofUrl(orderId: string, refundId: string) {
  const refund = await prisma.orderRefund.findUnique({
    where: { id: refundId },
    select: { order_id: true, proof_url: true },
  });
  if (!refund || refund.order_id !== orderId) throw new AppError("Refund not found", 404);
  if (!refund.proof_url) throw new AppError("No proof on file for this refund", 404);
  const url = await getSignedUrl(PAYMENT_PROOFS_BUCKET, refund.proof_url, 5 * 60);
  return { url, expires_in: 300 };
}

const ALL_DAYS_DONE_MESSAGE =
  "Semua hari order ini sudah selesai, jadi tidak ada yang bisa dibatalkan. Tutup order lewat Finalisasi.";
const allDaysEnded = (days: { line_status: string }[]) =>
  days.length > 0 && days.every((l) => l.line_status === "DONE" || l.line_status === "CANCELLED");

/** A day as the per-day cancellation plan needs it. */
type PlanDay = {
  id: string;
  line_status: string;
  total_price: unknown;
  service_date: Date | null;
  start_at: Date | null;
  actual_pickup_at: Date | null;
  customer_onboard_at: Date | null;
  cancel_fee: unknown;
  cancel_fee_auto: unknown;
  cancel_tier: number | null;
};

export interface CancelPlanDay {
  id: string;
  date: string | null;
  price: number;
  /** The driver was at the pickup by the decision time (dayArrivedBy). */
  arrived: boolean;
  /** The automatic tier / pct (dayCancellation). */
  tier: 1 | 2 | 3;
  pct: 20 | 50 | 100;
  /** The fee charged: `fee_auto`, or the one set by hand (`day_fees`). */
  fee: number;
  /** The automatic fee. */
  fee_auto: number;
  manual: boolean;
  label: string;
}

/**
 * Batalkan Pesanan per day (owner, 7 Oct 2026; finance design §3.2), worked
 * out in whole sen from the order's days and money at one decision time:
 *
 *  - every open day (SCHEDULED / ASSIGNED / IN_PROGRESS) gets its own fee
 *    (dayCancellation); days already cancelled keep theirs; DONE days keep
 *    their price; charges stay billed in full, outside the fee base.
 *  - T_new = Σ DONE prices + Σ fees of every cancelled day + charges.
 *  - Unpaid invoices (DRAFT/ISSUED) are voided and give back their saldo
 *    lebih; PAID invoices stay PAID.
 *  - gross = T_new − Covered (after the voids). gross > 0: saldo lebih goes
 *    first, a CANCELLATION_FEE invoice asks for the rest. gross ≤ 0: the
 *    excess becomes saldo lebih (RELEASE).
 *
 * `dayFees` (owner, 8 Oct 2026): fees set by hand for some of the days
 * cancelled now (line id → whole rupiah, checked by dayFeeMap); every sum
 * above uses them. Without it the plan is the automatic one.
 *
 * Pure over its inputs: GET /orders/:id/cancel-quote shows it and cancelOrder
 * recomputes it under the locks, so the two agree (R8).
 */
function cancelPlan(args: {
  orderStart: Date | null;
  days: PlanDay[];
  money: { net: number; credit: number; charges: number };
  unpaid: { id: string; invoice_number: string; amount: unknown; credit_applied: unknown }[];
  decidedAt: Date;
  dayFees?: Map<string, number>;
}) {
  const { days, money, unpaid, decidedAt, dayFees } = args;
  const toCancel: CancelPlanDay[] = [];
  let doneSen = 0;
  let earlierSen = 0;
  for (const d of days) {
    if (d.line_status === "DONE") doneSen += sen(d.total_price);
    else if (d.line_status === "CANCELLED") earlierSen += sen(d.cancel_fee);
    else {
      const date = dayDateOf(d, args.orderStart);
      const arrived = dayArrivedBy(d, decidedAt);
      const q = dayCancellation({ price: Number(d.total_price), dayDate: date, arrived, decidedAt });
      const fee = dayFees?.get(d.id) ?? q.fee;
      toCancel.push({
        id: d.id,
        date: date ? date.toISOString() : null,
        price: Number(d.total_price),
        arrived,
        ...q,
        fee,
        fee_auto: q.fee,
        manual: fee !== q.fee,
      });
    }
  }
  const nowSen = toCancel.reduce((s, d) => s + sen(d.fee), 0);
  const feeTotalSen = earlierSen + nowSen;
  const newTotal = doneSen + feeTotalSen + money.charges;
  const creditBack = unpaid.reduce((s, i) => s + sen(i.credit_applied), 0);
  const creditAfterVoid = money.credit + creditBack;
  const covered = money.net - creditAfterVoid;
  const gross = newTotal - covered;
  const creditApplied = gross > 0 ? Math.min(creditAfterVoid, gross) : 0;
  const amount = gross > 0 ? gross - creditApplied : 0;
  const release = gross < 0 ? -gross : 0;
  return {
    days: toCancel,
    tier: (toCancel.reduce<number>((t, d) => Math.max(t, d.tier), 0) || 1) as 1 | 2 | 3,
    earlierFeeSen: earlierSen,
    feeTotalSen,
    doneSen,
    newTotal,
    covered,
    creditAfterVoid,
    gross,
    creditApplied,
    amount,
    release,
    creditAfter: creditAfterVoid - creditApplied + release,
    voided: unpaid.map((i) => ({
      id: i.id,
      number: i.invoice_number,
      amount: Number(i.amount),
      credit_applied: Number(i.credit_applied ?? 0),
    })),
  };
}
type CancelPlan = ReturnType<typeof cancelPlan>;

const planDaySelect = {
  id: true,
  line_status: true,
  total_price: true,
  service_date: true,
  start_at: true,
  actual_pickup_at: true,
  customer_onboard_at: true,
  cancel_fee: true,
  cancel_fee_auto: true,
  cancel_tier: true,
} as const;

/**
 * The plan from the database (prisma or a transaction), for one order:
 * `auto` without and `plan` with the fees set by hand (the same when none).
 */
async function loadCancelPlan(
  db: Prisma.TransactionClient | typeof prisma,
  orderId: string,
  orderStart: Date | null,
  decidedAt: Date,
  dayFees?: Map<string, number>,
) {
  const [days, m, unpaid] = await Promise.all([
    db.orderServiceItem.findMany({
      where: { order_id: orderId },
      select: planDaySelect,
      orderBy: [{ service_date: { sort: "asc", nulls: "last" } }, { sort_order: "asc" }],
    }),
    moneyState(db, orderId),
    db.invoice.findMany({
      where: { order_id: orderId, status: { in: ["DRAFT", "ISSUED"] } },
      select: { id: true, invoice_number: true, amount: true, credit_applied: true },
      orderBy: { id: "asc" },
    }),
  ]);
  if (!m) throw new AppError("Order not found", 404);
  const auto = cancelPlan({ orderStart, days, money: m, unpaid, decidedAt });
  return {
    days,
    money: m,
    auto,
    plan: dayFees?.size ? cancelPlan({ orderStart, days, money: m, unpaid, decidedAt, dayFees }) : auto,
  };
}

/**
 * The fees set by hand in Batalkan Pesanan (`day_fees`, owner 8 Oct 2026):
 * only days this cancel cancels, once each, whole rupiah within the day's
 * price; else 400 INVALID_CANCEL_FEE.
 */
function dayFeeMap(dayFees: { line_id: string; fee: number }[] | undefined, auto: CancelPlan) {
  const out = new Map<string, number>();
  const days = new Map(auto.days.map((d) => [d.id, d]));
  for (const f of dayFees ?? []) {
    const bad = (msg: string) => new AppError(msg, 400, { code: "INVALID_CANCEL_FEE", line_id: f.line_id });
    const d = days.get(f.line_id);
    if (!d) throw bad("Biaya manual hanya untuk hari yang ikut dibatalkan sekarang.");
    if (out.has(f.line_id)) throw bad("Biaya manual satu hari diisi dua kali.");
    if (!Number.isInteger(f.fee) || f.fee < 0) throw bad("Biaya pembatalan harus rupiah bulat, tidak minus.");
    if (sen(f.fee) > sen(d.price)) throw bad(`Biaya pembatalan paling banyak harga harinya, ${rupiah(d.price)}.`);
    out.set(f.line_id, f.fee);
  }
  return out;
}

/** The refusals Batalkan Pesanan and its quote share. */
function assertCancellable(
  order: { order_status: string; cancellation_fee: unknown },
  days: { line_status: string }[],
) {
  if (order.order_status === "DONE" || order.order_status === "CANCELLED") {
    throw new AppError(`Cannot cancel an order with status ${order.order_status}`, 409);
  }
  if (order.cancellation_fee != null) {
    throw new AppError("Sisa hari order ini sudah dibatalkan. Tinggal finalisasi.", 409);
  }
  // Every day already done (awaiting finalize): nothing is left to cancel.
  if (allDaysEnded(days)) throw new AppError(ALL_DAYS_DONE_MESSAGE, 409);
}

/** The cancel-quote shape (finance design §5.5), in rupiah. */
function planView(plan: CancelPlan, m: MoneyState, decidedAt: Date, requestedAt: Date | null) {
  return {
    decided_at: decidedAt.toISOString(),
    requested_at: requestedAt?.toISOString() ?? null,
    tier: plan.tier,
    days: plan.days,
    earlier_fee_total: rp(plan.earlierFeeSen),
    fee_total: rp(plan.feeTotalSen),
    done_total: rp(plan.doneSen),
    charges: rp(m.charges),
    original_total: rp(m.total),
    new_total: rp(plan.newTotal),
    net_paid: rp(m.net),
    credit_balance: rp(m.credit),
    covered: rp(plan.covered),
    voided_invoices: plan.voided,
    fee_invoice:
      plan.amount > 0
        ? { gross: rp(plan.gross), credit_applied: rp(plan.creditApplied), amount: rp(plan.amount) }
        : null,
    credit_applied: rp(plan.creditApplied),
    credit_release: rp(plan.release),
    credit_after: rp(plan.creditAfter),
    still_owed: rp(plan.amount),
  };
}

/**
 * GET /orders/:id/cancel-quote: what "Batalkan Pesanan" would charge now (or
 * at the customer's request time) per day, and what it does to the money.
 * Read-only.
 */
export async function orderCancelQuote(orderId: string, requestedAt?: string) {
  const now = new Date();
  const when = cancelDecisionTime(requestedAt, now);
  if (when.error) throw new AppError(when.error, 400);
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { order_status: true, cancellation_fee: true, service_start_at: true },
  });
  if (!order) throw new AppError("Order not found", 404);
  const { days, money, plan } = await loadCancelPlan(prisma, orderId, order.service_start_at, when.decidedAt);
  assertCancellable(order, days);
  return planView(plan, money, when.decidedAt, when.requestedAt);
}

export interface CancelOrderResult {
  /** Highest tier among the days cancelled now. */
  tier: 1 | 2 | 3;
  /** Σ fees charged of every cancelled day (= orders.cancellation_fee). */
  penalty: number;
  originalFinalPrice: number;
  /** Money received (paid_to_date). */
  paidToDate: number;
  /** Saldo lebih after the cancellation (refunded through /refunds). */
  refundDue: number;
  /** Cash still owed after saldo lebih (what the fee invoice asks; 0 when covered). */
  stillOwed: number;
  cancellationInvoiceNumber: string | null;
  // A3 (finance design §5.6)
  rule: "DAY_V2";
  days: CancelPlanDay[];
  earlierFeeTotal: number;
  /** Σ fees charged (the ones set by hand included) = penalty. */
  feeTotal: number;
  /** The automatic total of the days cancelled now + earlierFeeTotal. */
  autoFeeTotal: number;
  newTotal: number;
  netPaid: number;
  creditBalance: number;
  creditApplied: number;
  creditReleased: number;
  voidedInvoices: { id: string; number: string; amount: number; credit_applied: number }[];
  decidedAt: string;
}

const samePlan = (a: CancelPlan, b: CancelPlan) =>
  a.feeTotalSen === b.feeTotalSen &&
  a.newTotal === b.newTotal &&
  a.amount === b.amount &&
  a.creditApplied === b.creditApplied &&
  a.days.length === b.days.length &&
  a.voided.length === b.voided.length;

/**
 * Cancel a full order, per day (owner, 7 Oct 2026; finance design §3.2).
 *
 *  - Every open day is cancelled with its own fee (cancel_fee / cancel_tier /
 *    cancelled_at / cancel_reason / cancel_requested_at on the day); days
 *    cancelled earlier keep theirs; DONE days keep their price.
 *  - orders.cancellation_fee = Σ fees of every cancelled day (still the
 *    "this order was cancelled" marker), cancellation_rule = 'DAY_V2'.
 *    final_price is not frozen: the rollup computes Σ DONE prices + Σ fees +
 *    charges, the payment status and the RELEASE of money beyond it.
 *  - Only unpaid invoices are voided (their saldo lebih comes back,
 *    UNAPPLIED); PAID invoices stay PAID. One CANCELLATION_FEE invoice (PDF
 *    built outside the transaction) asks only what is still owed after the
 *    saldo lebih; none when money already covers it.
 *  - Drivers/cars of days not started are released. Days already DONE keep
 *    the order open; it closes through finalize (decided 6 Oct 2026).
 *  - `expectedFeeTotal` (the quote the admin saw) differing from the server's
 *    → 409 CANCEL_FEE_CHANGED with the new quote, nothing changed.
 *  - Money is never moved here: refunds stay manual through /refunds.
 */
export async function cancelOrder(
  orderId: string,
  input: {
    reason: string;
    actor?: string;
    expected_fee_total?: number;
    requested_at?: string;
    client_ref?: string;
    day_fees?: { line_id: string; fee: number }[];
  },
): Promise<CancelOrderResult> {
  const { reason, actor } = input;
  const ref = input.client_ref ?? null;
  const now = new Date();
  const when = cancelDecisionTime(input.requested_at, now);
  if (when.error) throw new AppError(when.error, 400);
  const decidedAt = when.decidedAt;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { customer: true },
  });
  if (!order) throw new AppError("Order not found", 404);
  // Idempotency (client_ref): a resend of the cancel that went through gets
  // its stored result; another ref on a cancelled order is refused below.
  const replayed = cancelReplay(order, ref);
  if (replayed) return replayed;
  if (ref) await assertCancelRefFree(orderId, ref);
  const auto = await loadCancelPlan(prisma, orderId, order.service_start_at, decidedAt);
  assertCancellable(order, auto.days);
  // `expected_fee_total` is the AUTOMATIC total the admin was shown; the fees
  // set by hand (`day_fees`) replace the automatic fee of their days only.
  if (
    input.expected_fee_total !== undefined &&
    sen(input.expected_fee_total) !== auto.auto.feeTotalSen
  ) {
    throw new AppError(
      `Biaya pembatalan sekarang ${rupiah(rp(auto.auto.feeTotalSen))}, bukan ${rupiah(input.expected_fee_total)}. Periksa rinciannya lalu batalkan lagi.`,
      409,
      { code: "CANCEL_FEE_CHANGED", quote: planView(auto.auto, auto.money, decidedAt, when.requestedAt) },
    );
  }
  const dayFees = dayFeeMap(input.day_fees, auto.auto);
  const before = dayFees.size
    ? await loadCancelPlan(prisma, orderId, order.service_start_at, decidedAt, dayFees)
    : auto;
  if (dayFees.size && !samePlan(before.auto, auto.auto)) {
    throw new AppError(
      "Ada perubahan pada hari, invoice atau pembayaran order ini saat pesanan dibatalkan. Coba batalkan lagi.",
      409,
    );
  }
  const originalFinalPrice = Number(order.final_price);

  // Every cancelled day (earlier ones too) for the fee invoice lines.
  const feeLines = (plan: CancelPlan, days: PlanDay[]) => {
    const now = new Map(plan.days.map((d) => [d.id, d]));
    return days
      .filter((d) => d.line_status === "CANCELLED" || now.has(d.id))
      .map((d) => {
        const q = now.get(d.id);
        const tier = (q?.tier ?? d.cancel_tier ?? 1) as 1 | 2 | 3;
        // A fee set by hand prints no % (it is not the tier's).
        const manual = q
          ? q.manual
          : d.cancel_fee_auto != null && sen(d.cancel_fee_auto) !== sen(d.cancel_fee);
        return {
          date: dayDateOf(d, order.service_start_at),
          price: Number(d.total_price),
          pct: manual ? null : TIER_PCT[tier],
          fee: q ? q.fee : Number(d.cancel_fee ?? 0),
        };
      });
  };

  // ── Render the cancellation-fee PDF + reserve its number OUTSIDE the main
  //    tx (slow network work; mirrors generateInvoice). Skip if no customer
  //    is linked (cannot issue a numbered invoice without a customer code),
  //    or when nothing is owed (no invoice to issue).
  let prepared: { invoiceNumber: string; invoiceSeq: number; fileUrl: string } | null = null;
  if (order.customer && before.plan.amount > 0) {
    prepared = await buildCancellationFeePdf({
      customer: { id: order.customer.id, code: order.customer.code },
      order: {
        order_code: order.order_code,
        customer_name: order.customer_name,
        customer_phone: order.customer_phone ?? null,
        pickup_location: order.pickup_location,
        dropoff_location: order.dropoff_location,
      },
      days: feeLines(before.plan, before.days),
      total: rp(before.plan.newTotal),
      alreadyPaid: rp(before.plan.covered),
      creditApplied: rp(before.plan.creditApplied),
      reason,
      issueDate: now,
    });
  }

  let result: CancelOrderResult;
  try {
    result = await prisma.$transaction(async (tx) => {
      // 0) B9 lock order (order-money.ts): the days, then the order (as Edit
      //    Hari, Edit Order and the driver app), then the invoices in step 1.
      //    Re-check under the locks: a second click (or a finalize) that
      //    committed meanwhile wins and this cancel stops.
      await lockOrderDays(tx, orderId);
      await lockOrder(tx, orderId);
      const fresh = await tx.order.findUniqueOrThrow({
        where: { id: orderId },
        select: { order_status: true, cancellation_fee: true, cancel_client_ref: true, cancel_result: true },
      });
      // The same ref committed meanwhile (a double click): its result.
      const again = cancelReplay(fresh, ref);
      if (again) return again;
      if (
        fresh.order_status === "DONE" ||
        fresh.order_status === "CANCELLED" ||
        fresh.cancellation_fee != null
      ) {
        throw new AppError("Order ini sudah dibatalkan atau sudah selesai.", 409);
      }
      // The days and money as they are now. A day started, finished,
      // cancelled or repriced, a payment or an invoice since the plan was
      // worked out (and its PDF built) changes what is owed: stop and let the
      // admin retry.
      const locked = await loadCancelPlan(tx, orderId, order.service_start_at, decidedAt, dayFees);
      if (allDaysEnded(locked.days)) throw new AppError(ALL_DAYS_DONE_MESSAGE, 409);
      const plan = locked.plan;
      // The automatic plan decides (expected_fee_total was checked on it);
      // the one with the fees set by hand is what the PDF was built from.
      if (!samePlan(locked.auto, before.auto) || !samePlan(plan, before.plan)) {
        throw new AppError(
          "Ada perubahan pada hari, invoice atau pembayaran order ini saat pesanan dibatalkan. Coba batalkan lagi.",
          409,
        );
      }

      // 1) Void the unpaid invoices only (PAID stay PAID) and give back the
      //    saldo lebih they used (UNAPPLIED). total_billed = Σ active
      //    invoices: remove the voided ones.
      const voidedIds = plan.voided.map((v) => v.id);
      if (voidedIds.length > 0) {
        const { count } = await tx.invoice.updateMany({
          where: { id: { in: voidedIds }, status: { in: ["DRAFT", "ISSUED"] } },
          data: { status: "CANCELLED" },
        });
        if (count !== voidedIds.length) {
          throw new AppError("Ada invoice yang baru saja dibayar atau direvisi. Coba batalkan lagi.", 409);
        }
      }
      for (const inv of plan.voided) {
        await addCreditEntry(tx, {
          orderId,
          kind: "UNAPPLIED",
          amount: inv.credit_applied,
          invoiceId: inv.id,
          note: `Saldo lebih dikembalikan dari ${inv.number} (dibatalkan bersama pesanan)`,
          actor: actor ?? "ADMIN",
        });
      }
      const voidedSum = plan.voided.reduce((s, v) => s + v.amount, 0);

      // 2) Cancel the open days, each with its own fee; collect drivers/cars
      //    to release.
      const driverIds = new Set<string>();
      const carIds = new Set<string>();
      const cancellableIds = plan.days.map((d) => d.id);
      const full = await tx.orderServiceItem.findMany({
        where: { id: { in: cancellableIds } },
        select: { id: true, is_external: true, driver_id: true, car_id: true, actual_start_at: true, trip_started_at: true },
      });
      // A day already paid out (driver fee / partner RTR) keeps who drove and
      // its amounts, like a started day: the payment stays on record.
      const paidOut = await tx.payable.findMany({
        where: { service_item_id: { in: cancellableIds }, status: "PAID" },
        select: { service_item_id: true },
      });
      const paidOutIds = new Set(paidOut.map((p) => p.service_item_id));
      const byId = new Map(plan.days.map((d) => [d.id, d]));
      for (const l of full) {
        const q = byId.get(l.id)!;
        if (l.driver_id) driverIds.add(l.driver_id);
        if (l.car_id) carIds.add(l.car_id);
        const keep = !!(l.actual_start_at || l.trip_started_at) || paidOutIds.has(l.id);
        const release: Prisma.OrderServiceItemUncheckedUpdateInput = keep
          ? {}
          : l.is_external
            ? { rtr_amount: 0 }
            : { driver_id: null, car_id: null, driver_fee: 0, driver_fee_note: "Dibatalkan sebelum berangkat" };
        await tx.orderServiceItem.update({
          where: { id: l.id },
          data: {
            ...release,
            line_status: "CANCELLED",
            cancel_fee: q.fee,
            cancel_fee_auto: q.fee_auto,
            cancel_tier: q.tier,
            cancelled_at: now,
            cancel_reason: reason,
            cancel_requested_at: when.requestedAt,
          },
        });
      }
      for (const id of cancellableIds) await recomputeLineMoney(tx, id);

      // 3) Derive order status (all-cancelled → CANCELLED) + release resources.
      await deriveAndSetOrderStatus(tx, orderId);
      for (const dId of driverIds) await syncDriverStatus(tx, dId);
      for (const cId of carIds) await syncCarStatus(tx, cId);

      // 4) The cancellation marks the order (DAY_V2). The rollup computes the
      //    new total from the days (Σ DONE prices + Σ fees + charges), the
      //    payment status, and releases money beyond it as saldo lebih
      //    (settleCredit, RELEASE).
      await tx.order.update({
        where: { id: orderId },
        data: {
          cancelled_at: now,
          cancellation_fee: rp(plan.feeTotalSen),
          cancellation_reason: reason,
          cancellation_rule: "DAY_V2",
        },
      });
      await rollupOrderFinance(tx, orderId);

      // 5) What is still owed after the saldo lebih: one CANCELLATION_FEE
      //    invoice with its PDF (none when money covers it). Saldo lebih goes
      //    first (APPLIED), also when it covers the rest without an invoice.
      let cancellationInvoiceNumber: string | null = null;
      let feeInvoiceId: string | undefined;
      let invoiced = 0;
      if (prepared && order.customer && plan.amount > 0) {
        const fee = await tx.invoice.create({
          data: {
            order_id: orderId,
            invoice_number: prepared.invoiceNumber,
            customer_seq: prepared.invoiceSeq,
            invoice_type: "CANCELLATION_FEE",
            payment_method: "BANK_TRANSFER",
            issue_date: now,
            amount: rp(plan.amount),
            note: `${reason}\n${feeSummary(plan)}`,
            file_url: prepared.fileUrl,
            status: "ISSUED",
            credit_applied: rp(plan.creditApplied),
          },
        });
        feeInvoiceId = fee.id;
        cancellationInvoiceNumber = prepared.invoiceNumber;
        invoiced = rp(plan.amount);
      }
      await addCreditEntry(tx, {
        orderId,
        kind: "APPLIED",
        amount: -rp(plan.creditApplied),
        invoiceId: feeInvoiceId,
        note: cancellationInvoiceNumber
          ? `Dipotong dari saldo lebih untuk biaya pembatalan ${cancellationInvoiceNumber}`
          : "Dipakai untuk biaya pembatalan",
        actor: actor ?? "ADMIN",
      });

      // 6) Keep total_billed = Σ active invoices: remove voided, add the new one.
      if (order.customer) {
        const billedDelta = invoiced - voidedSum;
        if (billedDelta !== 0) {
          await tx.customer.update({
            where: { id: order.customer.id },
            data: { total_billed: { increment: billedDelta } },
          });
        }
      }

      // 7) Audit log (keeps the original price and every day's fee).
      await tx.orderChangeLog.create({
        data: {
          order_id: orderId,
          field: "order_status",
          old_value: `${order.order_status} (final_price ${originalFinalPrice})`,
          new_value: cancellationLogValue(rp(plan.feeTotalSen), feeSummary(plan)),
          note: [
            reason,
            when.requestedAt ? `jam pelanggan membatalkan ${when.requestedAt.toISOString()}` : null,
          ]
            .filter(Boolean)
            .join(" | "),
          actor: actor ?? "ADMIN",
        },
      });

      const after = await moneyState(tx, orderId);
      if (!after) throw new AppError("Order not found", 404);
      const out: CancelOrderResult = {
        tier: plan.tier,
        penalty: rp(plan.feeTotalSen),
        originalFinalPrice,
        paidToDate: rp(after.received),
        refundDue: rp(after.credit),
        stillOwed: rp(plan.amount),
        cancellationInvoiceNumber,
        rule: "DAY_V2",
        days: plan.days,
        earlierFeeTotal: rp(plan.earlierFeeSen),
        feeTotal: rp(plan.feeTotalSen),
        autoFeeTotal: rp(locked.auto.feeTotalSen),
        newTotal: rp(after.total),
        netPaid: rp(after.net),
        creditBalance: rp(after.credit),
        creditApplied: rp(plan.creditApplied),
        creditReleased: rp(plan.release),
        voidedInvoices: plan.voided,
        decidedAt: decidedAt.toISOString(),
      };
      // Stored for a resend with the same client_ref (unique: a ref already
      // used by another order fails here and rolls back).
      await tx.order.update({
        where: { id: orderId },
        data: { cancel_client_ref: ref, cancel_result: out as unknown as Prisma.InputJsonValue },
      });
      return out;
    }, {
      // Cancel runs many sequential round-trips (status derive + driver/car sync
      // loops + invoice/order writes) against the Supabase pooler; the default 5s
      // interactive-tx limit can be exceeded and yield P2028. Give it headroom.
      maxWait: 15000,
      timeout: 30000,
    });
  } catch (err) {
    // Refused (or failed) after the fee PDF was uploaded: the PDF (customer
    // name, amounts) must not stay behind in the public bucket. Its reserved
    // number stays unused.
    if (prepared) void removeFile(env.SUPABASE_STORAGE_BUCKET, `invoices/${prepared.invoiceNumber}.pdf`);
    // Only the client_ref key: another unique key (e.g. the fee invoice's
    // number) is a real error, not a reused client_ref.
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002" &&
      ref &&
      String(err.meta?.target ?? "").includes("cancel_client_ref")
    ) {
      throw new AppError("client_ref ini sudah dipakai untuk pembatalan order lain.", 409);
    }
    throw err;
  }
  // A replay found under the lock: this request's PDF is not used.
  if (prepared && result.cancellationInvoiceNumber !== prepared.invoiceNumber) {
    void removeFile(env.SUPABASE_STORAGE_BUCKET, `invoices/${prepared.invoiceNumber}.pdf`);
  }

  return result;
}

/** The stored result when this cancel was already done with the same client_ref. */
function cancelReplay(
  order: { cancel_client_ref: string | null; cancel_result: Prisma.JsonValue | null },
  ref: string | null,
): CancelOrderResult | null {
  if (!ref || order.cancel_client_ref !== ref || order.cancel_result == null) return null;
  return order.cancel_result as unknown as CancelOrderResult;
}

/** A client_ref already used to cancel another order → 409. */
async function assertCancelRefFree(orderId: string, ref: string) {
  const other = await prisma.order.findFirst({
    where: { cancel_client_ref: ref, id: { not: orderId } },
    select: { id: true },
  });
  if (other) throw new AppError("client_ref ini sudah dipakai untuk pembatalan order lain.", 409);
}

/** One line for the invoice note and the change log: the fee of each day. */
function feeSummary(plan: CancelPlan): string {
  const parts = plan.days.map(
    (d) =>
      `${d.date ? wibShortDay(new Date(d.date)) : "tanpa tanggal"} ${
        d.manual ? manualFeeLog(d.fee, { fee: d.fee_auto, pct: d.pct }) : `${d.pct}% ${rupiah(d.fee)}`
      }`,
  );
  const earlier = plan.earlierFeeSen > 0 ? `; dibatalkan sebelumnya ${rupiah(rp(plan.earlierFeeSen))}` : "";
  return `Biaya pembatalan per hari: ${parts.join(", ")}${earlier}`;
}
