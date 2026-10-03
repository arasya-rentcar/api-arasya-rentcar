import { hashPassword } from '../../utils/password';
import prisma from '../../prisma/client';
import { AppError } from '../../utils/AppError';
import { CreateDriverInput, UpdateDriverInput } from './drivers.validation';
import { normalizePhone } from '../customers/customers.validation';

/**
 * A driver logs in to the app with their phone number, so one number must
 * belong to one driver. Compared in canonical `08…` form (`62…`/`+62…` are the
 * same number). Returns the canonical number to store.
 */
async function assertPhoneFree(phone: string, exceptDriverId?: string) {
  const norm = normalizePhone(phone);
  if (!norm) throw new AppError('Nomor HP tidak valid', 400);
  const others = await prisma.driver.findMany({
    where: exceptDriverId ? { id: { not: exceptDriverId } } : {},
    select: { name: true, phone: true },
  });
  const clash = others.find((d) => normalizePhone(d.phone) === norm);
  if (clash) {
    throw new AppError(
      `Nomor HP ${norm} sudah dipakai driver lain (${clash.name}). Satu nomor hanya untuk satu driver.`,
      409,
    );
  }
  return norm;
}

export async function createDriver(input: CreateDriverInput) {
  const user = await prisma.user.findUnique({ where: { id: input.user_id } });

  if (!user) throw new AppError('User not found', 404);
  if (user.role !== 'DRIVER') throw new AppError('User must have DRIVER role', 400);

  const existing = await prisma.driver.findUnique({ where: { user_id: input.user_id } });
  if (existing) throw new AppError('Driver profile already exists for this user', 409);
  const phone = await assertPhoneFree(input.phone);

  return prisma.driver.create({
    data: {
      user_id: input.user_id,
      name: input.name,
      phone,
      type: input.type,
      location: input.location || null,
      etoll_card: input.etoll_card || null,
    },
    include: { user: { select: { email: true, role: true } } },
  });
}

export async function listDrivers() {
  return prisma.driver.findMany({
    include: { user: { select: { email: true } } },
    orderBy: { name: 'asc' },
  });
}

export async function getDriverById(id: string) {
  const driver = await prisma.driver.findUnique({
    where: { id },
    include: { user: { select: { email: true } } },
  });

  if (!driver) throw new AppError('Driver not found', 404);
  return driver;
}

/**
 * Rich driver detail: profile + trip history (assigned service-day lines) +
 * payment history (payables) + aggregate totals. Used by the Driver Detail
 * page so we can see how much work + payment a driver has had.
 */
export async function getDriverDetail(id: string) {
  const driver = await prisma.driver.findUnique({
    where: { id },
    include: { user: { select: { email: true } } },
  });
  if (!driver) throw new AppError('Driver not found', 404);

  const [lines, payables, payUnpaid, payPaid, revenueAgg] = await Promise.all([
    // Trip history = service-day lines assigned to this driver.
    prisma.orderServiceItem.findMany({
      where: { driver_id: id },
      orderBy: [{ service_date: 'desc' }, { created_at: 'desc' }],
      include: {
        order: {
          select: { id: true, order_code: true, customer_name: true },
        },
        car: { select: { id: true, model: true, plate_number: true } },
      },
    }),
    // Payment history = payables for this driver.
    prisma.payable.findMany({
      where: { driver_id: id },
      orderBy: [{ service_date: 'desc' }, { created_at: 'desc' }],
      include: {
        order: { select: { id: true, order_code: true } },
        extras: true,
      },
    }),
    prisma.payable.aggregate({
      where: { driver_id: id, status: 'UNPAID' },
      _sum: { total_amount: true },
    }),
    prisma.payable.aggregate({
      where: { driver_id: id, status: 'PAID' },
      _sum: { total_amount: true },
    }),
    prisma.orderServiceItem.aggregate({
      where: { driver_id: id },
      _sum: { total_price: true, ops_cost: true, margin_amount: true },
    }),
  ]);

  const completedTrips = lines.filter((l) => l.line_status === 'DONE').length;
  const totalPaid = Number(payPaid._sum.total_amount ?? 0);
  const outstanding = Number(payUnpaid._sum.total_amount ?? 0);

  return {
    driver,
    summary: {
      total_trips: lines.length,
      completed_trips: completedTrips,
      total_earned: totalPaid + outstanding,
      total_paid: totalPaid,
      outstanding,
      revenue_generated: Number(revenueAgg._sum.total_price ?? 0),
      margin_generated: Number(revenueAgg._sum.margin_amount ?? 0),
    },
    trips: lines,
    payments: payables,
  };
}

/**
 * Rich external-vendor detail: profile + trip history + payment history +
 * totals. Mirrors getDriverDetail for external vendors.
 */
export async function getVendorDetail(id: string) {
  const vendor = await prisma.externalVendor.findUnique({ where: { id } });
  if (!vendor) throw new AppError('Vendor not found', 404);

  const [lines, payables, payUnpaid, payPaid, revenueAgg] = await Promise.all([
    prisma.orderServiceItem.findMany({
      where: { external_vendor_id: id },
      orderBy: [{ service_date: 'desc' }, { created_at: 'desc' }],
      include: {
        order: {
          select: { id: true, order_code: true, customer_name: true },
        },
        external_car: {
          select: { id: true, model: true, plate_number: true },
        },
      },
    }),
    prisma.payable.findMany({
      where: { vendor_id: id },
      orderBy: [{ service_date: 'desc' }, { created_at: 'desc' }],
      include: {
        order: { select: { id: true, order_code: true } },
        extras: true,
      },
    }),
    prisma.payable.aggregate({
      where: { vendor_id: id, status: 'UNPAID' },
      _sum: { total_amount: true },
    }),
    prisma.payable.aggregate({
      where: { vendor_id: id, status: 'PAID' },
      _sum: { total_amount: true },
    }),
    prisma.orderServiceItem.aggregate({
      where: { external_vendor_id: id },
      _sum: { total_price: true, rtr_amount: true, margin_amount: true },
    }),
  ]);

  const completedTrips = lines.filter((l) => l.line_status === 'DONE').length;
  const totalPaid = Number(payPaid._sum.total_amount ?? 0);
  const outstanding = Number(payUnpaid._sum.total_amount ?? 0);

  return {
    vendor,
    summary: {
      total_trips: lines.length,
      completed_trips: completedTrips,
      total_billed: totalPaid + outstanding,
      total_paid: totalPaid,
      outstanding,
      revenue_generated: Number(revenueAgg._sum.total_price ?? 0),
      margin_generated: Number(revenueAgg._sum.margin_amount ?? 0),
    },
    trips: lines,
    payments: payables,
  };
}

export async function updateDriver(id: string, input: UpdateDriverInput) {
  const driver = await prisma.driver.findUnique({ where: { id } });
  if (!driver) throw new AppError('Driver not found', 404);

  const data = { ...input };
  if (input.phone !== undefined) {
    // Re-saving the driver's own (possibly still shared) number is allowed, so
    // other fields stay editable; changing it to another driver's is not.
    data.phone =
      normalizePhone(input.phone) === normalizePhone(driver.phone)
        ? normalizePhone(input.phone) || driver.phone
        : await assertPhoneFree(input.phone, id);
  }

  return prisma.driver.update({
    where: { id },
    data,
    include: { user: { select: { email: true } } },
  });
}

export async function getMyActiveTrip(userId: string) {
  const driver = await prisma.driver.findUnique({ where: { user_id: userId } });
  if (!driver) throw new AppError('Driver profile not found', 404);

  // Merge: the line IS the trip. A driver's active "trip" is their earliest
  // non-terminal service-day line, with its order/car/expenses/reports.
  const line = await prisma.orderServiceItem.findFirst({
    where: {
      driver_id: driver.id,
      is_external: false,
      line_status: { notIn: ['DONE', 'CANCELLED'] },
    },
    orderBy: [{ service_date: 'asc' }, { sort_order: 'asc' }],
    include: {
      order: true,
      car: true,
      expenses: { orderBy: { created_at: 'desc' } },
      reports: { orderBy: { created_at: 'desc' }, take: 10 },
    },
  });

  return line;
}

/** Set the password the driver uses (with their phone number) in the app. */
export async function setDriverAppPassword(driverId: string, password: string) {
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver) throw new AppError('Driver not found', 404);
  await prisma.user.update({
    where: { id: driver.user_id },
    data: { password: await hashPassword(password) },
  });
}
