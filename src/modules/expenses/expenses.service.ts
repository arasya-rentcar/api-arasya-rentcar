import prisma from '../../prisma/client';
import { AppError } from '../../utils/AppError';
import { CreateExpenseInput } from './expenses.validation';

export async function createExpense(
  tripId: string,
  input: CreateExpenseInput,
  userId: string,
  role: 'ADMIN' | 'DRIVER',
) {
  const trip = await prisma.trip.findUnique({
    where: { id: tripId },
    include: { driver: true },
  });

  if (!trip) throw new AppError('Trip not found', 404);

  if (role === 'DRIVER') {
    const driver = await prisma.driver.findUnique({ where: { user_id: userId } });
    if (!driver || driver.id !== trip.driver_id) {
      throw new AppError('Forbidden: this trip does not belong to you', 403);
    }
  }

  if (trip.current_status === 'COMPLETED') {
    throw new AppError('Cannot add expenses to a completed trip', 409);
  }

  return prisma.expense.create({
    data: {
      trip_id: tripId,
      type: input.type,
      amount: input.amount,
      note: input.note,
    },
  });
}

export async function listExpensesByTrip(tripId: string) {
  const trip = await prisma.trip.findUnique({ where: { id: tripId } });
  if (!trip) throw new AppError('Trip not found', 404);

  return prisma.expense.findMany({
    where: { trip_id: tripId },
    orderBy: { created_at: 'desc' },
  });
}
