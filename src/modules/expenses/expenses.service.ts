import prisma from '../../prisma/client';
import { AppError } from '../../utils/AppError';
import { CreateExpenseInput } from './expenses.validation';

// Merge: expenses belong to a service-day LINE (the line IS the trip).
// `id` here is the order_service_item id.
export async function createExpense(
  lineId: string,
  input: CreateExpenseInput,
  userId: string,
  role: 'ADMIN' | 'DRIVER',
) {
  const line = await prisma.orderServiceItem.findUnique({
    where: { id: lineId },
    select: { id: true, driver_id: true, line_status: true },
  });

  if (!line) throw new AppError('Service line not found', 404);

  if (role === 'DRIVER') {
    const driver = await prisma.driver.findUnique({ where: { user_id: userId } });
    if (!driver || driver.id !== line.driver_id) {
      throw new AppError('Forbidden: this line does not belong to you', 403);
    }
  }

  if (line.line_status === 'DONE' || line.line_status === 'CANCELLED') {
    throw new AppError('Cannot add expenses to a closed service line', 409);
  }

  return prisma.expense.create({
    data: {
      order_service_item_id: lineId,
      type: input.type,
      amount: input.amount,
      note: input.note,
    },
  });
}

export async function listExpensesByTrip(lineId: string) {
  const line = await prisma.orderServiceItem.findUnique({
    where: { id: lineId },
    select: { id: true },
  });
  if (!line) throw new AppError('Service line not found', 404);

  return prisma.expense.findMany({
    where: { order_service_item_id: lineId },
    orderBy: { created_at: 'desc' },
  });
}
