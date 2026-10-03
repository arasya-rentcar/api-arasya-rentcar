import prisma from '../../prisma/client';
import { AppError } from '../../utils/AppError';
import { billedToCustomerByPackage } from '../../utils/driverFee';
import { recomputeLineMoney } from '../schedule/line-money.service';
import { notifyExpenseRejected } from '../../services/driverNotify';
import { rollupOrderFinance } from '../schedule/schedule.service';
import { CreateExpenseInput, UpdateExpenseInput } from './expenses.validation';

// Merge: expenses belong to a service-day LINE (the line IS the trip).
// `id` here is the order_service_item id.
//
// Trip costs (2026-10-03): costs from the driver app arrive PENDING and count
// only once an admin approves them; costs an admin adds are APPROVED at once.
export async function createExpense(
  lineId: string,
  input: CreateExpenseInput,
  userId: string,
  role: 'ADMIN' | 'DRIVER',
) {
  const line = await prisma.orderServiceItem.findUnique({
    where: { id: lineId },
    select: {
      id: true,
      order_id: true,
      driver_id: true,
      line_status: true,
      service_package: true,
    },
  });

  if (!line) throw new AppError('Service line not found', 404);

  if (role === 'DRIVER') {
    const driver = await prisma.driver.findUnique({ where: { user_id: userId } });
    if (!driver || driver.id !== line.driver_id) {
      throw new AppError('Forbidden: this line does not belong to you', 403);
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
        status: 'PENDING',
        paid_by: 'DRIVER',
        bill_to_customer: billedToCustomerByPackage(line.service_package, input.type),
      },
    });
  }

  // Admin: allowed on any day (late receipts after the trip, a started trip
  // that was cancelled, …).
  const reviewer = await reviewerName(userId);
  return prisma.$transaction(
    async (tx) => {
      const e = await tx.expense.create({
        data: {
          order_service_item_id: lineId,
          type: input.type,
          amount: input.amount,
          note: input.note,
          status: 'APPROVED',
          paid_by: input.paid_by ?? 'COMPANY',
          bill_to_customer:
            input.bill_to_customer ??
            billedToCustomerByPackage(line.service_package, input.type),
          created_by: reviewer,
          reviewed_at: new Date(),
          reviewed_by: reviewer,
        },
      });
      await recomputeLineMoney(tx, lineId);
      await rollupOrderFinance(tx, line.order_id);
      return tx.expense.findUniqueOrThrow({ where: { id: e.id } });
    },
    { maxWait: 15000, timeout: 30000 },
  );
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
    include: { trip_report: { select: { id: true, file_url: true, file_mime: true } } },
  });
}

async function reviewerName(userId: string): Promise<string> {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  return u?.email ?? 'admin';
}

/** Changes that move money owed to the driver. */
function touchesDriverMoney(
  e: { status: string; paid_by: string; amount: unknown },
  input: UpdateExpenseInput,
): boolean {
  const wasCounted = e.status === 'APPROVED' && e.paid_by === 'DRIVER';
  const status = input.status ?? e.status;
  const paidBy = input.paid_by ?? e.paid_by;
  const isCounted = status === 'APPROVED' && paidBy === 'DRIVER';
  if (wasCounted !== isCounted) return true;
  return isCounted && input.amount !== undefined && input.amount !== Number(e.amount);
}

/** Admin review: approve / reject, who paid, bill the customer, corrections. */
export async function updateExpense(
  expenseId: string,
  input: UpdateExpenseInput,
  userId: string,
) {
  const e = await prisma.expense.findUnique({
    where: { id: expenseId },
    include: {
      order_service_item: {
        select: { id: true, order_id: true, payable: { select: { status: true, kind: true } } },
      },
    },
  });
  if (!e || !e.order_service_item) throw new AppError('Biaya tidak ditemukan', 404);
  const line = e.order_service_item;
  if (
    line.payable?.status === 'PAID' &&
    line.payable.kind === 'DRIVER' &&
    touchesDriverMoney(e, input)
  ) {
    throw new AppError(
      'Fee driver hari ini sudah dibayar. Tandai belum terbayar dulu di menu Utang bila penggantian biayanya berubah.',
      409,
    );
  }

  const reviewer = await reviewerName(userId);
  const updated = await prisma.$transaction(
    async (tx) => {
      await tx.expense.update({
        where: { id: expenseId },
        data: {
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.paid_by !== undefined ? { paid_by: input.paid_by } : {}),
          ...(input.bill_to_customer !== undefined
            ? { bill_to_customer: input.bill_to_customer }
            : {}),
          ...(input.type !== undefined ? { type: input.type } : {}),
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          ...(input.note !== undefined ? { note: input.note } : {}),
          ...(input.review_note !== undefined ? { review_note: input.review_note } : {}),
          reviewed_at: new Date(),
          reviewed_by: reviewer,
        },
      });
      await recomputeLineMoney(tx, line.id);
      await rollupOrderFinance(tx, line.order_id);
      return tx.expense.findUniqueOrThrow({
        where: { id: expenseId },
        include: { trip_report: { select: { id: true, file_url: true, file_mime: true } } },
      });
    },
    { maxWait: 15000, timeout: 30000 },
  );
  // The driver hears about a rejected receipt (approvals show up as the
  // reimbursement in the fee payment).
  if (input.status === 'REJECTED' && e.status !== 'REJECTED') {
    void notifyExpenseRejected(expenseId);
  }
  return updated;
}

/** Delete a cost the admin added. Driver reports are rejected, not deleted. */
export async function deleteExpense(expenseId: string) {
  const e = await prisma.expense.findUnique({
    where: { id: expenseId },
    include: {
      order_service_item: {
        select: { id: true, order_id: true, payable: { select: { status: true, kind: true } } },
      },
    },
  });
  if (!e || !e.order_service_item) throw new AppError('Biaya tidak ditemukan', 404);
  if (!e.created_by) {
    throw new AppError(
      'Biaya dari aplikasi driver tidak dihapus. Pakai Tolak supaya tetap tercatat.',
      409,
    );
  }
  const line = e.order_service_item;
  if (
    line.payable?.status === 'PAID' &&
    line.payable.kind === 'DRIVER' &&
    e.status === 'APPROVED' &&
    e.paid_by === 'DRIVER'
  ) {
    throw new AppError(
      'Fee driver hari ini sudah dibayar. Tandai belum terbayar dulu di menu Utang bila penggantian biayanya berubah.',
      409,
    );
  }
  await prisma.$transaction(
    async (tx) => {
      if (e.adjustment_id) {
        await tx.expense.update({ where: { id: e.id }, data: { adjustment_id: null } });
        await tx.orderAdjustment.deleteMany({ where: { id: e.adjustment_id } });
      }
      await tx.expense.delete({ where: { id: e.id } });
      await recomputeLineMoney(tx, line.id);
      await rollupOrderFinance(tx, line.order_id);
    },
    { maxWait: 15000, timeout: 30000 },
  );
  return { id: expenseId, deleted: true };
}
