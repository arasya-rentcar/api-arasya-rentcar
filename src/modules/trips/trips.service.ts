import { TripStatus } from '@prisma/client';
import prisma from '../../prisma/client';
import { AppError } from '../../utils/AppError';
import { NextStatusInput } from './trips.validation';

const TRIP_TRANSITIONS: Record<TripStatus, TripStatus | null> = {
  DRIVER_ASSIGNED: 'DEPART_GARAGE',
  DEPART_GARAGE: 'ARRIVE_AT_CUSTOMER',
  ARRIVE_AT_CUSTOMER: 'ON_TRIP',
  ON_TRIP: 'DROP_CUSTOMER',
  DROP_CUSTOMER: 'RETURN_GARAGE',
  RETURN_GARAGE: 'ARRIVE_GARAGE',
  ARRIVE_GARAGE: 'COMPLETED',
  COMPLETED: null,
};

export async function getTripById(id: string) {
  const trip = await prisma.trip.findUnique({
    where: { id },
    include: {
      order: true,
      driver: { include: { user: { select: { email: true } } } },
      car: true,
      logs: { orderBy: { created_at: 'asc' } },
      expenses: { orderBy: { created_at: 'desc' } },
    },
  });

  if (!trip) throw new AppError('Trip not found', 404);
  return trip;
}

export async function advanceTripStatus(
  tripId: string,
  input: NextStatusInput,
  actor: 'ADMIN' | 'DRIVER',
  userId: string,
) {
  const trip = await prisma.trip.findUnique({
    where: { id: tripId },
    include: { driver: true },
  });

  if (!trip) throw new AppError('Trip not found', 404);

  // If caller is DRIVER, ensure they own this trip
  if (actor === 'DRIVER') {
    const driver = await prisma.driver.findUnique({ where: { user_id: userId } });
    if (!driver || driver.id !== trip.driver_id) {
      throw new AppError('Forbidden: this trip does not belong to you', 403);
    }
  }

  if (trip.current_status === 'COMPLETED') {
    throw new AppError('Trip is already completed', 409);
  }

  const expectedNext = TRIP_TRANSITIONS[trip.current_status];

  if (!expectedNext || input.status !== expectedNext) {
    throw new AppError(
      `Invalid status transition from ${trip.current_status}. Expected next: ${expectedNext}`,
      409,
    );
  }

  const now = new Date();
  const newStatus = input.status as TripStatus;

  const updated = await prisma.$transaction(async (tx) => {
    const updatedTrip = await tx.trip.update({
      where: { id: tripId },
      data: {
        current_status: newStatus,
        started_at: newStatus === 'DEPART_GARAGE' ? now : undefined,
        finished_at: newStatus === 'COMPLETED' ? now : undefined,
      },
    });

    await tx.tripLog.create({
      data: {
        trip_id: tripId,
        status: newStatus,
        actor,
      },
    });

    if (newStatus === 'COMPLETED') {
      await tx.order.update({
        where: { id: trip.order_id },
        data: { order_status: 'DONE' },
      });

      await tx.driver.update({
        where: { id: trip.driver_id },
        data: { status: 'AVAILABLE' },
      });

      await tx.car.update({
        where: { id: trip.car_id },
        data: { status: 'AVAILABLE' },
      });
    }

    // Update order to IN_PROGRESS when driver departs
    if (newStatus === 'DEPART_GARAGE') {
      await tx.order.update({
        where: { id: trip.order_id },
        data: { order_status: 'IN_PROGRESS' },
      });
    }

    return updatedTrip;
  });

  return updated;
}
