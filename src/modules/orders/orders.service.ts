import prisma from "../../prisma/client";
import { AppError } from "../../utils/AppError";
import {
  CreateOrderInput,
  UpdateOrderInput,
  AssignOrderInput,
  CreateAdjustmentInput,
  CreateChangeLogInput,
} from "./orders.validation";
import { upsertCustomerForOrder } from "../customers/customers.service";
import { computeMargin, MARGIN_FORMULA_VERSION } from "../../utils/margin";

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

    // Link / upsert the primary customer by phone and bump repeat-order stats.
    const customer = await upsertCustomerForOrder(tx, {
      name: primary.name,
      phone: primary.phone || input.customer_phone,
      amount: Number(calculatedFinalPrice),
      orderDate,
    });

    const order = await tx.order.create({
      data: {
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

    return order;
  }, { timeout: 15000 });
}

export async function listOrders() {
  return prisma.order.findMany({
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
      trip: {
        select: {
          id: true,
          current_status: true,
          driver: { select: { name: true } },
          car: { select: { plate_number: true, model: true } },
        },
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
          created_at: true,
          delivery_logs: { orderBy: { created_at: "desc" as const } },
        },
        orderBy: { created_at: "desc" as const },
      },
      customers: { orderBy: { created_at: "asc" as const } },
      service_items: { orderBy: { sort_order: "asc" as const } },
      adjustments: { orderBy: { created_at: "desc" as const }, take: 5 },
    },
  });
}

export interface SearchOrdersParams {
  search?: string;
  order_status?: string;
  payment_status?: string;
  source?: string;
  bucket?: string; // ALL | ACTIVE | MISSING_INVOICE | CANCELLED | NOT_FINAL | REFUNDED
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
        { pickup_location: { contains: q, mode: "insensitive" } },
        { dropoff_location: { contains: q, mode: "insensitive" } },
        { customers: { some: { name: { contains: q, mode: "insensitive" } } } },
        { customers: { some: { phone: { contains: q, mode: "insensitive" } } } },
        { trip: { driver: { name: { contains: q, mode: "insensitive" } } } },
        { trip: { car: { plate_number: { contains: q, mode: "insensitive" } } } },
        { trip: { car: { model: { contains: q, mode: "insensitive" } } } },
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

  const [total, rows, financeAgg] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
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
        trip: {
          select: {
            id: true,
            current_status: true,
            driver: { select: { name: true } },
            car: { select: { plate_number: true, model: true } },
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
  ]);

  // final_price sum (fallback turnover) across filtered set
  const priceAgg = await prisma.order.aggregate({
    where,
    _sum: { final_price: true },
  });

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

const nn = (v?: number | null) => (v == null ? null : Number(v));

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

  return getOrderById(id);
}

export async function getOrderById(id: string) {
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      trip: {
        include: {
          driver: true,
          car: true,
          logs: { orderBy: { created_at: "asc" } },
          expenses: { orderBy: { created_at: "desc" } },
        },
      },
      invoices: {
        orderBy: { created_at: "desc" as const },
        include: {
          delivery_logs: { orderBy: { created_at: "desc" as const } },
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
        },
      },
      adjustments: { orderBy: { created_at: "desc" as const } },
      change_logs: { orderBy: { created_at: "desc" as const } },
    },
  });

  if (!order) throw new AppError("Order not found", 404);
  return order;
}

export async function updateOrder(id: string, input: UpdateOrderInput) {
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) throw new AppError("Order not found", 404);

  if (order.order_status === "DONE" || order.order_status === "CANCELLED") {
    throw new AppError(
      `Cannot update order with status ${order.order_status}`,
      409,
    );
  }

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

  // Ensure driver has no active trip
  const driverActiveTrip = await prisma.trip.findFirst({
    where: {
      driver_id: input.driver_id,
      current_status: { not: "COMPLETED" },
    },
  });
  if (driverActiveTrip)
    throw new AppError("Driver already has an active trip", 409);

  // Ensure car has no active trip
  const carActiveTrip = await prisma.trip.findFirst({
    where: {
      car_id: input.car_id,
      current_status: { not: "COMPLETED" },
    },
  });
  if (carActiveTrip)
    throw new AppError("Car is already in use by another trip", 409);

  // Ensure order has no existing trip
  const existingTrip = await prisma.trip.findUnique({
    where: { order_id: orderId },
  });
  if (existingTrip)
    throw new AppError("Order already has a trip assigned", 409);

  // Execute in a transaction
  const trip = await prisma.$transaction(async (tx) => {
    const newTrip = await tx.trip.create({
      data: {
        order_id: orderId,
        driver_id: input.driver_id,
        car_id: input.car_id,
        current_status: "DRIVER_ASSIGNED",
      },
    });

    await tx.tripLog.create({
      data: {
        trip_id: newTrip.id,
        status: "DRIVER_ASSIGNED",
        actor: "ADMIN",
      },
    });

    await tx.driver.update({
      where: { id: input.driver_id },
      data: { status: "ON_DUTY" },
    });

    await tx.car.update({
      where: { id: input.car_id },
      data: { status: "IN_USE" },
    });

    await tx.order.update({
      where: { id: orderId },
      data: { order_status: "ASSIGNED" },
    });

    // Reflect the assignment on the schedule: any internal day-line of this
    // order that has no driver yet inherits this driver+car. (Multi-day orders
    // with per-day drivers are managed on the Schedule page instead.)
    await tx.orderServiceItem.updateMany({
      where: { order_id: orderId, is_external: false, driver_id: null },
      data: { driver_id: input.driver_id, car_id: input.car_id },
    });

    return newTrip;
  });

  return trip;
}

export async function createOrderAdjustment(
  orderId: string,
  input: CreateAdjustmentInput,
) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new AppError("Order not found", 404);

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
      await tx.order.update({
        where: { id: orderId },
        data: {
          final_price:
            Number(order.final_price) + input.amount * input.quantity,
        },
      });
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
