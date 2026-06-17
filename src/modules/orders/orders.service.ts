import prisma from "../../prisma/client";
import { AppError } from "../../utils/AppError";
import {
  CreateOrderInput,
  UpdateOrderInput,
  AssignOrderInput,
  CreateAdjustmentInput,
  CreateChangeLogInput,
} from "./orders.validation";

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
  return prisma.order.create({
    data: {
      customer_name: primary.name,
      customer_phone: primary.phone || input.customer_phone,
      customers: { create: customers },
      pickup_location: input.pickup_location,
      dropoff_location: input.dropoff_location,
      order_date: new Date(input.order_date),
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
      service_items: serviceItems?.length
        ? { create: serviceItems }
        : undefined,
    },
  });
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
      customers: { orderBy: { created_at: "asc" as const } },
      service_items: { orderBy: { sort_order: "asc" as const } },
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
