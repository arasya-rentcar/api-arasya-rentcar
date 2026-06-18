import prisma from '../../prisma/client';
import { AppError } from '../../utils/AppError';
import { CreateDriverInput, UpdateDriverInput } from './drivers.validation';

export async function createDriver(input: CreateDriverInput) {
  const user = await prisma.user.findUnique({ where: { id: input.user_id } });

  if (!user) throw new AppError('User not found', 404);
  if (user.role !== 'DRIVER') throw new AppError('User must have DRIVER role', 400);

  const existing = await prisma.driver.findUnique({ where: { user_id: input.user_id } });
  if (existing) throw new AppError('Driver profile already exists for this user', 409);

  return prisma.driver.create({
    data: {
      user_id: input.user_id,
      name: input.name,
      phone: input.phone,
      type: input.type,
      location: input.location || null,
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

  return prisma.driver.update({
    where: { id },
    data: input,
    include: { user: { select: { email: true } } },
  });
}

export async function getMyActiveTrip(userId: string) {
  const driver = await prisma.driver.findUnique({ where: { user_id: userId } });
  if (!driver) throw new AppError('Driver profile not found', 404);

  const trip = await prisma.trip.findFirst({
    where: {
      driver_id: driver.id,
      current_status: { not: 'COMPLETED' },
    },
    include: {
      order: true,
      car: true,
      logs: { orderBy: { created_at: 'desc' }, take: 10 },
      expenses: { orderBy: { created_at: 'desc' } },
    },
  });

  return trip;
}
