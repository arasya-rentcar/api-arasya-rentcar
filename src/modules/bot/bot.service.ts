import { DriverType, Prisma, TripStatus } from "@prisma/client";
import prisma from "../../prisma/client";
import { AppError } from "../../utils/AppError";
import {
  BotAssignInput,
  BotCreateOrderInput,
  BotFinishInput,
  BotReportInput,
} from "./bot.validation";
import { upsertCustomerForOrder } from "../customers/customers.service";
import {
  findOrCreateVendor,
  findOrCreateVendorCar,
} from "../external-vendors/external-vendors.service";

function normalizePhone(phone = ""): string {
  let digits = phone.replace(/[^0-9]/g, "");
  if (digits.startsWith("0")) digits = `62${digits.slice(1)}`;
  if (digits && !digits.startsWith("62")) digits = `62${digits}`;
  return digits;
}

function phoneVariants(phone = ""): string[] {
  const n = normalizePhone(phone);
  if (!n) return [];
  const local = n.startsWith("62") ? `0${n.slice(2)}` : n;
  return Array.from(new Set([phone, n, local].filter(Boolean)));
}

function reportTypeIsDocument(type = ""): boolean {
  return /DOCUMENT|PDF|ETOLL|ODOMETER|SUMMARY|EXPENSE/i.test(type);
}

function reportTypeIsPhoto(type = ""): boolean {
  return /PHOTO|IMAGE|START|FINISH|STOP/i.test(type);
}

function orderInclude() {
  return {
    customers: true,
    service_items: { orderBy: { sort_order: "asc" as const } },
    trip: {
      include: {
        driver: true,
        car: true,
        logs: { orderBy: { created_at: "asc" as const } },
        reports: { orderBy: { created_at: "desc" as const } },
      },
    },
    reports: { orderBy: { created_at: "desc" as const } },
    summary: true,
    invoices: { orderBy: { created_at: "desc" as const } },
  };
}

export async function findDriverByPhone(phone = "") {
  const variants = phoneVariants(phone);
  if (!variants.length) return null;
  return prisma.driver.findFirst({
    where: { phone: { in: variants } },
    include: { user: { select: { email: true } } },
  });
}

function normalizeName(value = ""): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export async function findDriverByName(name = "") {
  const q = normalizeName(name);
  if (!q) return null;
  const drivers = await prisma.driver.findMany({
    include: { user: { select: { email: true } } },
    orderBy: { name: "asc" },
  });
  const exact = drivers.find(
    (d) =>
      normalizeName(d.name) === q ||
      normalizeName(d.email || "") === q ||
      normalizeName(d.user?.email || "") === q,
  );
  if (exact) return exact;
  const tokens = q.split(" ").filter(Boolean);
  return (
    drivers.find((d) => {
      const haystack = normalizeName(
        `${d.name} ${d.email || ""} ${d.user?.email || ""}`,
      );
      return tokens.every((token) =>
        haystack
          .split(" ")
          .some(
            (word) =>
              word === token ||
              word.startsWith(token) ||
              token.startsWith(word),
          ),
      );
    }) || null
  );
}

export async function findCarByQuery(query = "") {
  const q = query.trim();
  if (!q) return null;
  return prisma.car.findFirst({
    where: {
      OR: [
        { unit_code: { contains: q, mode: "insensitive" } },
        { model: { contains: q, mode: "insensitive" } },
        { plate_number: { contains: q, mode: "insensitive" } },
      ],
    },
    orderBy: [{ status: "asc" }, { model: "asc" }],
  });
}

function normalizeServiceItems(input: BotCreateOrderInput) {
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

function normalizeDriverType(value = ""): DriverType {
  return /external|eksternal/i.test(value) ? "EXTERNAL" : "INTERNAL";
}

function externalDriverEmail(phone: string): string {
  return `external-${phone || Date.now()}@arasya.local`;
}

async function findOrCreateDriver(input: BotAssignInput) {
  const existing = input.driver_id
    ? await prisma.driver.findUnique({ where: { id: input.driver_id } })
    : (await findDriverByPhone(input.driver_phone || "")) ||
      (await findDriverByName(input.driver_name || ""));
  if (existing) {
    const updates: Prisma.DriverUpdateInput = {};
    if (input.driver_origin && !existing.location)
      updates.location = input.driver_origin;
    if (input.driver_type && existing.type !== input.driver_type)
      updates.type = input.driver_type;
    if (Object.keys(updates).length)
      return prisma.driver.update({
        where: { id: existing.id },
        data: updates,
      });
    return existing;
  }

  const phone = normalizePhone(input.driver_phone || "");
  const type =
    input.driver_type ||
    (phone ? normalizeDriverType(input.driver_origin || "") : "EXTERNAL");
  if (!phone && type !== "EXTERNAL")
    throw new AppError(
      "Driver phone is required for internal bot assignment",
      400,
    );
  const email = externalDriverEmail(
    phone || normalizeName(input.driver_name || "external-driver"),
  );
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, password: `external:${phone}`, role: "DRIVER" },
  });
  return prisma.driver.create({
    data: {
      user_id: user.id,
      name: input.driver_name || `Driver ${phone}`,
      phone: phone || `external-${Date.now()}`,
      email: type === "EXTERNAL" ? null : email,
      location: input.driver_origin || null,
      type,
    },
  });
}

async function findOrCreateCar(input: BotAssignInput) {
  const existing = input.car_id
    ? await prisma.car.findUnique({ where: { id: input.car_id } })
    : (input.car_plate
        ? await prisma.car.findUnique({
            where: { plate_number: input.car_plate },
          })
        : null) ||
      (await findCarByQuery(input.car_query || input.car_model || ""));
  if (existing) return existing;
  const model = input.car_model || input.car_query || "Unknown Vehicle";
  const plate = input.car_plate || `NO-PLATE-${Date.now()}`;
  return prisma.car.create({ data: { model, plate_number: plate } });
}

export async function createBotOrder(input: BotCreateOrderInput) {
  const existing = input.order_code
    ? await prisma.order.findUnique({
        where: { order_code: input.order_code },
        include: orderInclude(),
      })
    : null;
  if (existing) return existing;

  const serviceItems = normalizeServiceItems(input);
  const finalPrice = serviceItems?.length
    ? serviceItemsTotal(serviceItems)
    : Number(input.final_price || 0);
  const orderDate = new Date(input.order_date);

  // Infer external: explicit type, OR a driver phone is present (the agreed
  // WhatsApp signal that an outside driver was supplied), OR the car/driver
  // name is prefixed "External".
  const carText = `${input.car_model || ""} ${input.car_query || ""}`.toLowerCase();
  const isExternal =
    input.driver_type === "EXTERNAL" ||
    !!(input.driver_phone && input.driver_phone.trim()) ||
    /\bexternal\b/.test(carText) ||
    /\bexternal\b/.test((input.driver_name || "").toLowerCase());

  return prisma.$transaction(async (tx) => {
    // Link / upsert the customer by phone so WhatsApp orders count toward
    // repeat-order stats just like web orders.
    const customer = await upsertCustomerForOrder(tx, {
      name: input.customer_name,
      phone: input.customer_phone,
      amount: finalPrice,
      orderDate,
    });

    // For external WhatsApp orders, find-or-create the vendor (from the driver
    // name/phone) and the car they brought.
    let externalVendorId: string | null = null;
    let externalCarId: string | null = null;
    if (isExternal) {
      const vendorName = (input.driver_name || input.driver_origin || "")
        .replace(/\s*\([^)]*\)\s*$/, "")
        .trim();
      if (vendorName) {
        const vendor = await findOrCreateVendor(tx, {
          name: vendorName,
          phone: input.driver_phone || null,
        });
        if (vendor) {
          externalVendorId = vendor.id;
          const carModel = (input.car_model || input.car_query || "")
            .replace(/external/gi, "")
            .trim();
          const car = await findOrCreateVendorCar(tx, vendor.id, {
            model: carModel || null,
            plate_number: input.car_plate || null,
          });
          externalCarId = car?.id ?? null;
          await tx.externalVendor.update({
            where: { id: vendor.id },
            data: { order_count: { increment: 1 } },
          });
        }
      }
    }

    return tx.order.create({
      data: {
        order_code: input.order_code,
        source: "WHATSAPP",
        customer_name: input.customer_name,
        customer_phone: normalizePhone(input.customer_phone),
        customer_id: customer?.id ?? null,
        is_external: isExternal,
        external_vendor_id: externalVendorId,
        external_car_id: externalCarId,
        pickup_location: input.pickup_location,
        dropoff_location: input.dropoff_location,
        order_date: orderDate,
        service_start_at: orderDate,
        final_price: new Prisma.Decimal(finalPrice),
        service_type: input.service_type,
        passenger_count: input.passenger_count,
        notes: input.notes,
        area: input.area,
        driver_origin: input.driver_origin,
        raw_order_text: input.raw_order_text,
        whatsapp_message_id: input.whatsapp_message_id,
        service_items: serviceItems?.length
          ? { create: serviceItems }
          : undefined,
        customers: input.customers?.length
          ? {
              create: input.customers.map((c, index) => ({
                name: c.name,
                phone: c.phone ? normalizePhone(c.phone) : null,
                is_primary: c.is_primary ?? index === 0,
              })),
            }
          : undefined,
      },
      include: orderInclude(),
    });
  }, { timeout: 15000 });
}

async function resolveOrder(orderIdOrCode: string) {
  const order = await prisma.order.findFirst({
    where: { OR: [{ id: orderIdOrCode }, { order_code: orderIdOrCode }] },
    include: orderInclude(),
  });
  if (!order) throw new AppError("Order not found", 404);
  return order;
}

export async function assignBotOrder(
  orderIdOrCode: string,
  input: BotAssignInput,
) {
  const order = await resolveOrder(orderIdOrCode);
  if (order.trip) return order.trip;

  const driver = await findOrCreateDriver(input);
  const car = await findOrCreateCar(input);

  const activeTrip = await prisma.trip.findFirst({
    where: { driver_id: driver.id, current_status: { not: "COMPLETED" } },
  });
  if (activeTrip) throw new AppError("Driver already has an active trip", 409);

  return prisma.$transaction(async (tx) => {
    const trip = await tx.trip.create({
      data: {
        order_id: order.id,
        driver_id: driver.id,
        car_id: car.id,
        current_status: "DRIVER_ASSIGNED",
      },
    });
    await tx.tripLog.create({
      data: { trip_id: trip.id, status: "DRIVER_ASSIGNED", actor: "ADMIN" },
    });
    await tx.driver.update({
      where: { id: driver.id },
      data: { status: "ON_DUTY" },
    });
    await tx.car.update({ where: { id: car.id }, data: { status: "IN_USE" } });
    await tx.order.update({
      where: { id: order.id },
      data: { order_status: "ASSIGNED" },
    });
    return trip;
  });
}

export async function markDriverMessageSent(orderIdOrCode: string) {
  const order = await resolveOrder(orderIdOrCode);
  return prisma.order.update({
    where: { id: order.id },
    data: { driver_message_sent_at: new Date(), order_status: "ASSIGNED" },
    include: orderInclude(),
  });
}

export async function getOrderByCode(orderCode: string) {
  const order = await prisma.order.findUnique({
    where: { order_code: orderCode },
    include: orderInclude(),
  });
  if (!order) throw new AppError("Order not found", 404);
  return order;
}

export async function getActiveOrderByDriverPhone(phone: string) {
  const driver = await findDriverByPhone(phone);
  if (!driver) return null;
  return prisma.order.findFirst({
    where: {
      order_status: { in: ["ASSIGNED", "IN_PROGRESS"] },
      trip: { driver_id: driver.id, current_status: { not: "COMPLETED" } },
    },
    orderBy: { created_at: "desc" },
    include: orderInclude(),
  });
}

async function transitionTrip(
  orderId: string,
  status: TripStatus,
  actor: "ADMIN" | "DRIVER" = "DRIVER",
) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { trip: true },
  });
  if (!order?.trip) return null;
  const now = new Date();
  return prisma.trip.update({
    where: { id: order.trip.id },
    data: {
      current_status: status,
      started_at: ["DEPART_GARAGE", "ON_TRIP"].includes(status)
        ? now
        : undefined,
      finished_at: status === "COMPLETED" ? now : undefined,
      logs: { create: { status, actor } },
    },
  });
}

export async function startBotOrder(
  orderIdOrCode: string,
  report?: BotReportInput,
) {
  const order = await resolveOrder(orderIdOrCode);
  const createdReport = report
    ? await createBotReport(orderIdOrCode, {
        ...report,
        report_type: report.report_type || "START",
      })
    : null;
  await transitionTrip(order.id, "ON_TRIP");
  const updated = await prisma.order.update({
    where: { id: order.id },
    data: { order_status: "IN_PROGRESS" },
    include: orderInclude(),
  });
  return { order: updated, report: createdReport };
}

export async function finishBotOrder(
  orderIdOrCode: string,
  input: BotFinishInput = {},
) {
  const order = await resolveOrder(orderIdOrCode);
  const report = await createBotReport(orderIdOrCode, {
    driver_phone: input.driver_phone,
    report_type: "FINISH",
    input_type: "TEXT",
    notes: input.notes,
    match_method: "finish endpoint",
    status: "MATCHED",
  });
  await transitionTrip(order.id, "COMPLETED");

  const reports = await prisma.tripReport.findMany({
    where: { order_id: order.id },
  });
  const startReceived = reports.some((r) =>
    /START|Pick Up/i.test(r.report_type),
  );
  const finishReceived = true;
  const docsReceived = reports.filter((r) =>
    reportTypeIsDocument(r.report_type),
  ).length;
  const photosCount = reports.filter((r) =>
    reportTypeIsPhoto(r.report_type),
  ).length;
  const missingItems = [
    !startReceived ? "START" : null,
    !finishReceived ? "FINISH" : null,
    !docsReceived ? "Expense/PDF document" : null,
  ].filter(Boolean) as string[];

  const updated = await prisma.$transaction(async (tx) => {
    await tx.orderSummary.upsert({
      where: { order_id: order.id },
      update: {
        start_received: startReceived,
        finish_received: finishReceived,
        docs_received: docsReceived,
        photos_count: photosCount,
        missing_items: missingItems,
        generated_summary: input.generated_summary,
        generated_at: new Date(),
      },
      create: {
        order_id: order.id,
        start_received: startReceived,
        finish_received: finishReceived,
        docs_received: docsReceived,
        photos_count: photosCount,
        missing_items: missingItems,
        generated_summary: input.generated_summary,
      },
    });
    return tx.order.update({
      where: { id: order.id },
      data: {
        order_status: "DONE",
        needs_review: missingItems.length > 0,
        review_reason: missingItems.length
          ? `Missing: ${missingItems.join(", ")}`
          : null,
      },
      include: orderInclude(),
    });
  });

  return { order: updated, report };
}

export async function createBotReport(
  orderIdOrCode: string,
  input: BotReportInput,
) {
  let order = null as Awaited<ReturnType<typeof resolveOrder>> | null;
  try {
    order = await resolveOrder(orderIdOrCode);
  } catch {
    if (input.order_code)
      order = await prisma.order.findUnique({
        where: { order_code: input.order_code },
        include: orderInclude(),
      });
  }

  const driver = input.driver_phone
    ? await findDriverByPhone(input.driver_phone)
    : null;
  const trip = order?.trip || null;
  const status = order ? input.status : "UNMATCHED";

  return prisma.tripReport.create({
    data: {
      order_id: order?.id,
      trip_id: trip?.id,
      order_code: order?.order_code || input.order_code,
      driver_id: driver?.id,
      driver_phone: input.driver_phone
        ? normalizePhone(input.driver_phone)
        : undefined,
      report_type: input.report_type,
      input_type: input.input_type,
      notes: input.notes,
      extracted_text: input.extracted_text,
      file_url: input.file_url,
      file_mime: input.file_mime,
      match_method: input.match_method,
      source: "WHATSAPP",
      status,
    },
  });
}
