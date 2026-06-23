import { DriverType, Prisma } from "@prisma/client";
import prisma from "../../prisma/client";
import { AppError } from "../../utils/AppError";
import {
  deriveAndSetOrderStatus,
  syncDriverStatus,
  syncCarStatus,
  resolveActiveLine,
} from "../schedule/order-derive.service";
import {
  BotAssignInput,
  BotCreateOrderInput,
  BotFinishInput,
  BotReportInput,
} from "./bot.validation";
import { upsertCustomerForOrder } from "../customers/customers.service";
import { nextOrderCode } from "../../utils/codes";
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

// Report types that mean "driver ARRIVED at the customer pickup location" ->
// stamps actual_pickup_at. Covers the bot's pickup-arrival tags and common
// Indonesian phrasings. Intentionally does NOT match START (depart garage),
// DROP/FINISH (dropoff), or generic photo/document reports.
function isPickupArrivalReport(type = ""): boolean {
  return /ARRIVE_CUSTOMER|ARRIVE|PICKUP|PICK_UP|PICK UP|SAMPAI_JEMPUT|SAMPAI JEMPUT|TIBA_JEMPUT|DI_LOKASI_JEMPUT/i.test(
    type,
  );
}

function orderInclude() {
  // Merge: the line IS the trip. Order detail now exposes its service-day lines
  // (each with its own driver/car/status) instead of a single order-level trip.
  return {
    customers: true,
    service_items: {
      orderBy: { sort_order: "asc" as const },
      include: {
        driver: true,
        car: true,
        external_vendor: true,
        external_car: true,
        reports: { orderBy: { created_at: "desc" as const } },
      },
    },
    reports: { orderBy: { created_at: "desc" as const } },
    summary: true,
    invoices: { orderBy: { created_at: "desc" as const } },
  };
}

/**
 * Option A: resolve the single service-day line a driver's WhatsApp action
 * (start/finish/report) should hit. Prefers the driver's active line; falls
 * back to the order's earliest non-terminal internal line (covers single-day
 * orders where no driver phone was supplied).
 */
async function resolveLineForAction(
  tx: Prisma.TransactionClient,
  orderId: string,
  driverPhone?: string,
): Promise<{ id: string; line_status: string } | null> {
  if (driverPhone) {
    const driver = await findDriverByPhone(driverPhone);
    if (driver) {
      const line = await resolveActiveLine(tx, orderId, driver.id);
      if (line) return line;
    }
  }
  const line = await tx.orderServiceItem.findFirst({
    where: {
      order_id: orderId,
      is_external: false,
      line_status: { notIn: ["DONE", "CANCELLED"] },
    },
    orderBy: [{ service_date: "asc" }, { sort_order: "asc" }],
    select: { id: true, line_status: true },
  });
  return line;
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

    // Use the caller-provided order_code if present (G5: never overwrite an
    // existing manual code); otherwise auto-generate the running code.
    let orderCode = input.order_code ?? null;
    let orderSeq: number | null = null;
    if (!orderCode) {
      const gen = await nextOrderCode(
        tx,
        { id: customer.id, code: customer.code },
        orderDate,
      );
      orderCode = gen.code;
      orderSeq = gen.seq;
    }

    return tx.order.create({
      data: {
        order_code: orderCode,
        customer_seq: orderSeq,
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
  }, { maxWait: 15000, timeout: 30000 });
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
  const driver = await findOrCreateDriver(input);
  const car = await findOrCreateCar(input);

  // Merge: assign at the LINE level. Every internal day-line of this order that
  // has no driver yet inherits this driver+car and flips to ASSIGNED. Order
  // status + driver/car status are then derived from the lines. For multi-day
  // orders with per-day drivers, the Schedule page overrides individual days.
  return prisma.$transaction(async (tx) => {
    await tx.orderServiceItem.updateMany({
      where: { order_id: order.id, is_external: false, driver_id: null },
      data: {
        driver_id: driver.id,
        car_id: car.id,
        line_status: "ASSIGNED",
      },
    });
    // If no unassigned internal line existed (e.g. order had no service items),
    // fall back to stamping the order directly so the bot flow still advances.
    const lineCount = await tx.orderServiceItem.count({
      where: { order_id: order.id, driver_id: driver.id, is_external: false },
    });
    await deriveAndSetOrderStatus(tx, order.id);
    if (lineCount === 0) {
      await tx.order.update({
        where: { id: order.id },
        data: { order_status: "ASSIGNED" },
      });
    }
    await syncDriverStatus(tx, driver.id);
    await syncCarStatus(tx, car.id);
    return tx.order.findUnique({
      where: { id: order.id },
      include: orderInclude(),
    });
  }, { maxWait: 15000, timeout: 30000 });
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
  // Merge: a driver's active order is one that has a non-terminal internal line
  // assigned to them (the line IS the trip).
  return prisma.order.findFirst({
    where: {
      order_status: { in: ["ASSIGNED", "IN_PROGRESS"] },
      service_items: {
        some: {
          driver_id: driver.id,
          is_external: false,
          line_status: { notIn: ["DONE", "CANCELLED"] },
        },
      },
    },
    orderBy: { created_at: "desc" },
    include: orderInclude(),
  });
}

/**
 * Merge: advance the driver's ACTIVE service-day line (Option A) to a coarse
 * state, stamping journey timestamps and re-deriving order + resource status.
 * Replaces the old order-level trip transition.
 */
async function transitionActiveLine(
  orderId: string,
  next: "IN_PROGRESS" | "DONE",
  driverPhone?: string,
) {
  return prisma.$transaction(async (tx) => {
    const line = await resolveLineForAction(tx, orderId, driverPhone);
    if (!line) return null;
    const now = new Date();
    const cur = await tx.orderServiceItem.findUnique({
      where: { id: line.id },
      select: {
        trip_started_at: true,
        actual_start_at: true,
        driver_id: true,
        car_id: true,
      },
    });
    const data: Prisma.OrderServiceItemUncheckedUpdateInput = {
      line_status: next,
    };
    if (next === "IN_PROGRESS" && cur?.trip_started_at == null)
      data.trip_started_at = now;
    // actual_start_at = driver DEPARTS the garage (the #start report). Distinct
    // from actual_pickup_at (arrive at customer). Stamp once.
    if (next === "IN_PROGRESS" && cur?.actual_start_at == null)
      data.actual_start_at = now;
    if (next === "DONE") {
      if (cur?.trip_started_at == null) data.trip_started_at = now;
      // actual dropoff = trip_finished_at; finish_reported_at records that the
      // driver reported finishing. The LINE goes DONE here, but the ORDER stays
      // IN_PROGRESS (awaiting_finalization) per the admin-finalize model.
      data.trip_finished_at = now;
      data.finish_reported_at = now;
    }
    const updated = await tx.orderServiceItem.update({
      where: { id: line.id },
      data,
      select: { driver_id: true, car_id: true },
    });
    await deriveAndSetOrderStatus(tx, orderId);
    if (updated.driver_id) await syncDriverStatus(tx, updated.driver_id);
    if (updated.car_id) await syncCarStatus(tx, updated.car_id);
    return updated;
  }, { maxWait: 15000, timeout: 30000 });
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
  // Merge: start the driver's active day-line; order status derives to
  // IN_PROGRESS from it. Use the report's driver phone for Option A resolution.
  await transitionActiveLine(order.id, "IN_PROGRESS", report?.driver_phone);
  const updated = await prisma.order.findUnique({
    where: { id: order.id },
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
  // Merge: finish the driver's active day-line. For multi-day orders this
  // completes only TODAY's line; the order stays IN_PROGRESS until all lines
  // are done (deriveAndSetOrderStatus handles that). Resource release happens
  // when the driver's last active line closes.
  await transitionActiveLine(order.id, "DONE", input.driver_phone);

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
    // Merge: do NOT force order_status=DONE here. transitionActiveLine already
    // finished today's line and derived the order status (a multi-day order
    // stays IN_PROGRESS until ALL lines are done). Only update review flags.
    await tx.order.update({
      where: { id: order.id },
      data: {
        needs_review: missingItems.length > 0,
        review_reason: missingItems.length
          ? `Missing: ${missingItems.join(", ")}`
          : null,
      },
    });
    await deriveAndSetOrderStatus(tx, order.id);
    return tx.order.findUnique({
      where: { id: order.id },
      include: orderInclude(),
    });
  }, { maxWait: 15000, timeout: 30000 });

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
  // Merge: attach the report to the driver's active service-day line (Option A)
  // instead of an order-level trip. Best-effort; unmatched reports keep null.
  let lineId: string | null = null;
  if (order) {
    const line = await resolveLineForAction(
      prisma,
      order.id,
      input.driver_phone,
    );
    lineId = line?.id ?? null;
  }
  const status = order ? input.status : "UNMATCHED";

  // actual_pickup_at = driver ARRIVES at the customer pickup location. Stamped
  // once from an ARRIVE/PICKUP-class report onto the active line. Distinct from
  // actual_start_at (depart garage) and trip_finished_at (dropoff).
  if (lineId && isPickupArrivalReport(input.report_type)) {
    await prisma.orderServiceItem.updateMany({
      where: { id: lineId, actual_pickup_at: null },
      data: { actual_pickup_at: new Date() },
    });
  }

  return prisma.tripReport.create({
    data: {
      order_id: order?.id,
      order_service_item_id: lineId,
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
