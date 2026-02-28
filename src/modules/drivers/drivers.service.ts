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
