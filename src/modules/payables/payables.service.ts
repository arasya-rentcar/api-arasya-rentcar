import prisma from '../../prisma/client';
import { AppError } from '../../utils/AppError';
import type { Prisma, PaymentMethod } from '@prisma/client';
import {
  ListPayablesQuery,
  UpdatePayableInput,
  MarkPayablePaidInput,
} from './payables.validation';

const payableInclude = {
  order: {
    select: { id: true, order_code: true, customer_name: true },
  },
  driver: { select: { id: true, name: true, phone: true } },
  vendor: { select: { id: true, name: true, phone: true } },
  service_item: {
    select: {
      id: true,
      service_date: true,
      description: true,
      service_kind: true,
      service_package: true,
      pickup_location: true,
      dropoff_location: true,
    },
  },
  extras: true,
} satisfies Prisma.PayableInclude;

/**
 * Sync (create / update / remove) the payable for a single service line based
 * on its current assignment. Called from assignScheduleLine inside its tx.
 *
 * Rules:
 *  - Internal driver assigned -> DRIVER payable, base_amount = ops_cost.
 *  - External vendor assigned -> VENDOR payable, base_amount = rtr_amount.
 *  - No assignment -> remove any existing UNPAID payable (keep PAID for history).
 *  - base/total are kept in sync while UNPAID; once PAID we never silently rewrite.
 */
export async function syncPayableForLine(
  tx: Prisma.TransactionClient,
  serviceItemId: string,
) {
  const line = await tx.orderServiceItem.findUnique({
    where: { id: serviceItemId },
    include: { payable: { include: { extras: true } } },
  });
  if (!line) return;

  const existing = line.payable;
  const isExternal = line.is_external;
  const hasDriver = !isExternal && !!line.driver_id;
  const hasVendor = isExternal && !!line.external_vendor_id;

  // No (valid) assignment for a payable.
  if (!hasDriver && !hasVendor) {
    if (existing && existing.status === 'UNPAID') {
      await tx.payable.delete({ where: { id: existing.id } });
    }
    return;
  }

  const kind: 'DRIVER' | 'VENDOR' = hasDriver ? 'DRIVER' : 'VENDOR';
  const base =
    kind === 'DRIVER'
      ? Number(line.ops_cost ?? 0)
      : Number(line.rtr_amount ?? 0);

  // Preserve manually-entered extras on existing payable.
  const extrasSum = existing
    ? existing.extras.reduce((s, e) => s + Number(e.amount), 0)
    : 0;

  if (!existing) {
    await tx.payable.create({
      data: {
        kind,
        status: 'UNPAID',
        service_item_id: line.id,
        order_id: line.order_id,
        driver_id: kind === 'DRIVER' ? line.driver_id : null,
        vendor_id: kind === 'VENDOR' ? line.external_vendor_id : null,
        service_date: line.service_date,
        base_amount: base,
        extras_amount: 0,
        total_amount: base,
      },
    });
    return;
  }

  // Keep PAID payables for history; only refresh assignment link + service_date.
  if (existing.status === 'PAID') {
    await tx.payable.update({
      where: { id: existing.id },
      data: {
        kind,
        driver_id: kind === 'DRIVER' ? line.driver_id : null,
        vendor_id: kind === 'VENDOR' ? line.external_vendor_id : null,
        service_date: line.service_date,
      },
    });
    return;
  }

  await tx.payable.update({
    where: { id: existing.id },
    data: {
      kind,
      driver_id: kind === 'DRIVER' ? line.driver_id : null,
      vendor_id: kind === 'VENDOR' ? line.external_vendor_id : null,
      service_date: line.service_date,
      base_amount: base,
      extras_amount: extrasSum,
      total_amount: base + extrasSum,
    },
  });
}

function recalcTotal(base: number, extrasSum: number): number {
  return base + extrasSum;
}

/** List payables with filters, pagination, and summary totals. */
export async function listPayables(query: ListPayablesQuery) {
  const where: Prisma.PayableWhereInput = {};
  if (query.kind) where.kind = query.kind;
  if (query.status) where.status = query.status;
  if (query.driver_id) where.driver_id = query.driver_id;
  if (query.vendor_id) where.vendor_id = query.vendor_id;
  if (query.date_from || query.date_to) {
    where.service_date = {};
    if (query.date_from)
      (where.service_date as Prisma.DateTimeFilter).gte = new Date(
        query.date_from,
      );
    if (query.date_to)
      (where.service_date as Prisma.DateTimeFilter).lte = new Date(
        query.date_to,
      );
  }
  if (query.search) {
    where.OR = [
      { keterangan: { contains: query.search, mode: 'insensitive' } },
      { driver: { name: { contains: query.search, mode: 'insensitive' } } },
      { vendor: { name: { contains: query.search, mode: 'insensitive' } } },
      {
        order: { order_code: { contains: query.search, mode: 'insensitive' } },
      },
    ];
  }

  const skip = (query.page - 1) * query.page_size;
  const [items, total, unpaidAgg, paidAgg] = await Promise.all([
    prisma.payable.findMany({
      where,
      include: payableInclude,
      orderBy: [{ service_date: 'desc' }, { created_at: 'desc' }],
      skip,
      take: query.page_size,
    }),
    prisma.payable.count({ where }),
    prisma.payable.aggregate({
      where: { ...where, status: 'UNPAID' },
      _sum: { total_amount: true },
    }),
    prisma.payable.aggregate({
      where: { ...where, status: 'PAID' },
      _sum: { total_amount: true },
    }),
  ]);

  return {
    items,
    pagination: {
      page: query.page,
      page_size: query.page_size,
      total,
      total_pages: Math.ceil(total / query.page_size),
    },
    totals: {
      outstanding: Number(unpaidAgg._sum.total_amount ?? 0),
      paid: Number(paidAgg._sum.total_amount ?? 0),
    },
  };
}

export async function getPayable(id: string) {
  const p = await prisma.payable.findUnique({
    where: { id },
    include: payableInclude,
  });
  if (!p) throw new AppError('Payable not found', 404);
  return p;
}

/** Update editable fields: base override, extras list, keterangan. */
export async function updatePayable(id: string, input: UpdatePayableInput) {
  const existing = await prisma.payable.findUnique({
    where: { id },
    include: { extras: true },
  });
  if (!existing) throw new AppError('Payable not found', 404);

  return prisma.$transaction(async (tx) => {
    // Replace extras list if provided.
    let extrasSum = existing.extras.reduce((s, e) => s + Number(e.amount), 0);
    if (input.extras) {
      await tx.payableExtra.deleteMany({ where: { payable_id: id } });
      if (input.extras.length) {
        await tx.payableExtra.createMany({
          data: input.extras.map((e) => ({
            payable_id: id,
            label: e.label,
            amount: e.amount,
          })),
        });
      }
      extrasSum = input.extras.reduce((s, e) => s + e.amount, 0);
    }

    const base =
      input.base_amount != null
        ? input.base_amount
        : Number(existing.base_amount);

    const data: Prisma.PayableUncheckedUpdateInput = {
      base_amount: base,
      extras_amount: extrasSum,
      total_amount: recalcTotal(base, extrasSum),
    };
    if (input.keterangan !== undefined) data.keterangan = input.keterangan;

    await tx.payable.update({ where: { id }, data });
    return tx.payable.findUnique({ where: { id }, include: payableInclude });
  });
}

/** Mark a payable PAID (records paid_at + optional method). */
export async function markPayablePaid(id: string, input: MarkPayablePaidInput) {
  const existing = await prisma.payable.findUnique({ where: { id } });
  if (!existing) throw new AppError('Payable not found', 404);
  if (existing.status === 'PAID')
    throw new AppError('Payable is already paid', 409);

  await prisma.payable.update({
    where: { id },
    data: {
      status: 'PAID',
      paid_at: input.paid_at ? new Date(input.paid_at) : new Date(),
      payment_method: (input.payment_method as PaymentMethod) ?? null,
    },
  });
  return prisma.payable.findUnique({ where: { id }, include: payableInclude });
}

/** Reverse a payment back to UNPAID (correction). */
export async function markPayableUnpaid(id: string) {
  const existing = await prisma.payable.findUnique({ where: { id } });
  if (!existing) throw new AppError('Payable not found', 404);
  await prisma.payable.update({
    where: { id },
    data: { status: 'UNPAID', paid_at: null, payment_method: null },
  });
  return prisma.payable.findUnique({ where: { id }, include: payableInclude });
}

/** Mark many payables PAID at once (batch settlement). */
export async function bulkMarkPaid(ids: string[], paidAt?: string) {
  if (!ids.length) throw new AppError('No payable ids provided', 400);
  const when = paidAt ? new Date(paidAt) : new Date();
  const res = await prisma.payable.updateMany({
    where: { id: { in: ids }, status: 'UNPAID' },
    data: { status: 'PAID', paid_at: when },
  });
  return { updated: res.count };
}

/** Payable history + rollup for one driver (used by Driver Detail page). */
export async function driverPayableHistory(driverId: string) {
  const [driver, items, unpaidAgg, paidAgg] = await Promise.all([
    prisma.driver.findUnique({
      where: { id: driverId },
      select: { id: true, name: true, phone: true, type: true },
    }),
    prisma.payable.findMany({
      where: { driver_id: driverId },
      include: payableInclude,
      orderBy: [{ service_date: 'desc' }, { created_at: 'desc' }],
    }),
    prisma.payable.aggregate({
      where: { driver_id: driverId, status: 'UNPAID' },
      _sum: { total_amount: true },
    }),
    prisma.payable.aggregate({
      where: { driver_id: driverId, status: 'PAID' },
      _sum: { total_amount: true },
    }),
  ]);
  if (!driver) throw new AppError('Driver not found', 404);
  return {
    driver,
    summary: {
      total_earned:
        Number(unpaidAgg._sum.total_amount ?? 0) +
        Number(paidAgg._sum.total_amount ?? 0),
      total_paid: Number(paidAgg._sum.total_amount ?? 0),
      outstanding: Number(unpaidAgg._sum.total_amount ?? 0),
      count: items.length,
    },
    items,
  };
}

/** Payable history + rollup for one external vendor (Vendor Detail page). */
export async function vendorPayableHistory(vendorId: string) {
  const [vendor, items, unpaidAgg, paidAgg] = await Promise.all([
    prisma.externalVendor.findUnique({
      where: { id: vendorId },
      select: { id: true, name: true, phone: true },
    }),
    prisma.payable.findMany({
      where: { vendor_id: vendorId },
      include: payableInclude,
      orderBy: [{ service_date: 'desc' }, { created_at: 'desc' }],
    }),
    prisma.payable.aggregate({
      where: { vendor_id: vendorId, status: 'UNPAID' },
      _sum: { total_amount: true },
    }),
    prisma.payable.aggregate({
      where: { vendor_id: vendorId, status: 'PAID' },
      _sum: { total_amount: true },
    }),
  ]);
  if (!vendor) throw new AppError('Vendor not found', 404);
  return {
    vendor,
    summary: {
      total_billed:
        Number(unpaidAgg._sum.total_amount ?? 0) +
        Number(paidAgg._sum.total_amount ?? 0),
      total_paid: Number(paidAgg._sum.total_amount ?? 0),
      outstanding: Number(unpaidAgg._sum.total_amount ?? 0),
      count: items.length,
    },
    items,
  };
}
