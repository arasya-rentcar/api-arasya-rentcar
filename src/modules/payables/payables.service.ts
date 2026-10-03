import prisma from '../../prisma/client';
import { AppError } from '../../utils/AppError';
import type { Prisma, PaymentMethod } from '@prisma/client';
import {
  ListPayablesQuery,
  UpdatePayableInput,
  MarkPayablePaidInput,
} from './payables.validation';
import { recomputeLineMoney } from '../schedule/line-money.service';
import { rollupOrderFinance } from '../schedule/schedule.service';

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
 * Sync (create / update / remove) the payable for a single service line from
 * the line itself. Called inside the caller's transaction (normally through
 * recomputeLineMoney, after the line's ops/margin were refreshed).
 *
 * Rules (driver pay, 2026-10-03):
 *  - Internal driver -> DRIVER payable:
 *      base (fee)       = line.driver_fee
 *      reimburse_amount = APPROVED expenses the driver paid (own money / uang jalan)
 *      advance_amount   = line.travel_advance (uang jalan already handed out)
 *      total            = base + reimburse − advance + extras
 *  - Partner vendor -> VENDOR payable, base = line.rtr_amount, total = base + extras.
 *  - No assignment, or a cancelled day that owes nothing -> remove the UNPAID payable.
 *  - A PAID payable is frozen: never re-priced and never moved to another
 *    driver/vendor (assignScheduleLine refuses that change instead).
 */
export async function syncPayableForLine(
  tx: Prisma.TransactionClient,
  serviceItemId: string,
) {
  const line = await tx.orderServiceItem.findUnique({
    where: { id: serviceItemId },
    include: {
      payable: { include: { extras: true } },
      expenses: {
        where: { status: 'APPROVED', paid_by: 'DRIVER' },
        select: { amount: true },
      },
    },
  });
  if (!line) return;

  const existing = line.payable;
  if (existing && existing.status === 'PAID') return;

  const isExternal = line.is_external;
  const hasDriver = !isExternal && !!line.driver_id;
  const hasVendor = isExternal && !!line.external_vendor_id;

  // No (valid) assignment for a payable.
  if (!hasDriver && !hasVendor) {
    if (existing) await tx.payable.delete({ where: { id: existing.id } });
    return;
  }

  const kind: 'DRIVER' | 'VENDOR' = hasDriver ? 'DRIVER' : 'VENDOR';
  const base =
    kind === 'DRIVER'
      ? Number(line.driver_fee ?? 0)
      : Number(line.rtr_amount ?? 0);
  const reimburse =
    kind === 'DRIVER'
      ? line.expenses.reduce((s, e) => s + Number(e.amount), 0)
      : 0;
  const advance = kind === 'DRIVER' ? Number(line.travel_advance ?? 0) : 0;
  // Manually-entered extras (bonus, potongan) survive every re-sync.
  const extrasSum = existing
    ? existing.extras.reduce((s, e) => s + Number(e.amount), 0)
    : 0;
  const total = base + reimburse - advance + extrasSum;

  // A cancelled day that owes nothing has no payable.
  if (
    line.line_status === 'CANCELLED' &&
    base === 0 &&
    reimburse === 0 &&
    advance === 0 &&
    extrasSum === 0
  ) {
    if (existing) await tx.payable.delete({ where: { id: existing.id } });
    return;
  }

  const data = {
    kind,
    driver_id: kind === 'DRIVER' ? line.driver_id : null,
    vendor_id: kind === 'VENDOR' ? line.external_vendor_id : null,
    service_date: line.service_date,
    base_amount: base,
    reimburse_amount: reimburse,
    advance_amount: advance,
    extras_amount: extrasSum,
    total_amount: total,
  };

  if (!existing) {
    await tx.payable.create({
      data: {
        ...data,
        status: 'UNPAID',
        service_item_id: line.id,
        order_id: line.order_id,
      },
    });
    return;
  }
  await tx.payable.update({ where: { id: existing.id }, data });
}

/**
 * The driver/vendor a PAID payable belongs to, when the requested change
 * would move this line's money to someone else. Used to refuse such edits.
 */
export async function paidPayableBlockingChange(
  tx: Prisma.TransactionClient | typeof prisma,
  serviceItemId: string,
  next: { kind: 'DRIVER' | 'VENDOR' | null; ownerId: string | null },
): Promise<string | null> {
  const p = await tx.payable.findUnique({
    where: { service_item_id: serviceItemId },
    include: {
      driver: { select: { name: true } },
      vendor: { select: { name: true } },
    },
  });
  if (!p || p.status !== 'PAID') return null;
  const ownerId = p.kind === 'DRIVER' ? p.driver_id : p.vendor_id;
  if (p.kind === next.kind && ownerId === next.ownerId) return null;
  return p.driver?.name ?? p.vendor?.name ?? 'driver/rekanan sebelumnya';
}

/** List payables with filters, pagination, and summary totals. */
/**
 * Dashboard summary: outstanding + paid + count, split by kind
 * (DRIVER = internal debt, VENDOR = external debt). Optional date range
 * filters on service_date.
 */
export async function payablesSummary(opts: {
  date_from?: string;
  date_to?: string;
} = {}) {
  const dateFilter: Prisma.DateTimeFilter = {};
  if (opts.date_from) dateFilter.gte = new Date(opts.date_from);
  if (opts.date_to) dateFilter.lte = new Date(opts.date_to);
  const hasDate = opts.date_from || opts.date_to;

  async function forKind(kind: 'DRIVER' | 'VENDOR') {
    const base: Prisma.PayableWhereInput = { kind };
    if (hasDate) base.service_date = dateFilter;
    const [unpaid, paid, unpaidCount, paidCount] = await Promise.all([
      prisma.payable.aggregate({
        where: { ...base, status: 'UNPAID' },
        _sum: { total_amount: true },
      }),
      prisma.payable.aggregate({
        where: { ...base, status: 'PAID' },
        _sum: { total_amount: true },
      }),
      prisma.payable.count({ where: { ...base, status: 'UNPAID' } }),
      prisma.payable.count({ where: { ...base, status: 'PAID' } }),
    ]);
    const outstanding = Number(unpaid._sum.total_amount ?? 0);
    const paidTotal = Number(paid._sum.total_amount ?? 0);
    return {
      outstanding,
      paid: paidTotal,
      total: outstanding + paidTotal,
      unpaid_count: unpaidCount,
      paid_count: paidCount,
    };
  }

  const [driver, vendor] = await Promise.all([
    forKind('DRIVER'),
    forKind('VENDOR'),
  ]);

  return {
    driver,
    vendor,
    combined: {
      outstanding: driver.outstanding + vendor.outstanding,
      paid: driver.paid + vendor.paid,
      total: driver.total + vendor.total,
    },
  };
}

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
  if (existing.status === 'PAID')
    throw new AppError(
      'Tagihan ini sudah terbayar. Tandai belum terbayar dulu bila ingin mengubahnya.',
      409,
    );

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

    // Fee / RTR come from the day (Edit Hari) and reimbursements from the
    // approved trip costs, so only extras + keterangan are edited here.
    // base_amount is still accepted from older dashboards but ignored.
    const base = Number(existing.base_amount);
    const total =
      base +
      Number(existing.reimburse_amount) -
      Number(existing.advance_amount) +
      extrasSum;

    const data: Prisma.PayableUncheckedUpdateInput = {
      extras_amount: extrasSum,
      total_amount: total,
    };
    if (input.keterangan !== undefined) data.keterangan = input.keterangan;

    await tx.payable.update({ where: { id }, data });
    // Extras change the day's margin and the order totals.
    await recomputeLineMoney(tx, existing.service_item_id);
    await rollupOrderFinance(tx, existing.order_id);
    return tx.payable.findUnique({ where: { id }, include: payableInclude });
  }, { maxWait: 15000, timeout: 30000 });
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
  await prisma.$transaction(async (tx) => {
    await tx.payable.update({
      where: { id },
      data: { status: 'UNPAID', paid_at: null, payment_method: null },
    });
    // While it was paid the day may have changed (fee, costs, driver):
    // bring the amounts back in line with the day.
    await syncPayableForLine(tx, existing.service_item_id);
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
