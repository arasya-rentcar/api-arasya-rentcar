import { notifyNewTrips, notifyTripsRemoved } from '../../services/tripNotify';
import prisma from '../../prisma/client';
import { AppError } from '../../utils/AppError';
import {
  assertNotLastOpenDay,
  assertOrderOpenForDayChanges,
  assertOrderPaidForDriverAssignment,
  isLegacyCancelled,
  isOpenDay,
  LAST_OPEN_DAY_MESSAGE,
  orderPaymentStatus,
  paymentOrderSelect,
  startPayment,
  startPaymentSelect,
} from '../orders/assignment-guard';
import { assertOpenWithinTotal, computeOrderMoney, moneyState, settleCredit } from '../orders/order-money';
import {
  cancelDecisionTime,
  dayCancellation,
  dayDateOf,
  dayStarted,
  TIER_PCT,
  type DayCancellation,
} from '../orders/cancellation-policy';
import { rupiah } from '../../services/adminNotify';
import { MARGIN_FORMULA_VERSION } from '../../utils/margin';
import { staleTripCutoff } from '../../utils/wib';
import { defaultDriverFee } from '../../utils/driverFee';
import { paidPayableBlockingChange } from '../payables/payables.service';
import { recomputeLineMoney } from './line-money.service';
import {
  deriveAndSetOrderStatus,
  refreshCarStatuses,
  refreshDriverStatuses,
  tripTimestampsForLine,
} from './order-derive.service';
import { assertUnitsFree, lockUnits } from './availability';
import {
  deriveState,
  maybeAutoSendOnAssign,
} from '../confirmation/confirmation.service';
import {
  ListScheduleQuery,
  AssignScheduleLineInput,
  DriverAvailabilityQuery,
  TripHistoryQuery,
  ScheduleWeekQuery,
} from './schedule.validation';
import type { Prisma, ScheduleStatus } from '@prisma/client';

const lineInclude = {
  order: {
    select: {
      id: true,
      order_code: true,
      customer_name: true,
      order_status: true,
      payment_status: true,
      // For order.start_ready (withStartReady): paid in full → may depart.
      ...startPaymentSelect,
    },
  },
  driver: { select: { id: true, name: true, phone: true } },
  car: { select: { id: true, model: true, plate_number: true } },
  external_vendor: { select: { id: true, name: true, phone: true } },
  external_car: { select: { id: true, model: true, plate_number: true } },
  // Extras on the day's payable also come off the margin (Edit Hari preview).
  payable: { select: { status: true, extras_amount: true } },
} satisfies Prisma.OrderServiceItemInclude;

/**
 * order.start_ready = the order is paid in full, so the trip with the customer
 * may begin (owner rule; the driver app's "Mulai perjalanan" enforces it). The order's day
 * list loaded to compute it is dropped from the response.
 */
function withStartReady<
  T extends {
    order: {
      paid_to_date: unknown;
      refunded_total?: unknown;
      service_items: { total_price: unknown; line_status: string }[];
    };
  },
>(line: T) {
  const { service_items, ...order } = line.order;
  return {
    ...line,
    order: { ...order, start_ready: startPayment(line.order, service_items).ready },
  };
}

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Jakarta is UTC+7, no DST.

/**
 * Day window for a calendar date interpreted in **Asia/Jakarta (WIB, GMT+7)**.
 * A date of 2026-06-20 (WIB) spans 2026-06-19T17:00:00Z .. 2026-06-20T16:59:59.999Z.
 * Fixes the old UTC-based bounds that day-shifted late-evening Jakarta lines.
 */
function dayBounds(dateStr?: string): { start: Date; end: Date } {
  // Determine the target Y/M/D in WIB. If a date string is given, take its WIB
  // calendar date; otherwise use "today" in WIB.
  const base = dateStr ? new Date(dateStr) : new Date();
  const wib = new Date(base.getTime() + WIB_OFFSET_MS);
  const y = wib.getUTCFullYear();
  const m = wib.getUTCMonth();
  const d = wib.getUTCDate();
  // WIB midnight expressed in UTC = that wall-clock instant minus 7h.
  const start = new Date(Date.UTC(y, m, d, 0, 0, 0) - WIB_OFFSET_MS);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000 - 1);
  return { start, end };
}

/** List schedule day-lines with filters + pagination. */
export async function listSchedule(query: ListScheduleQuery) {
  const where: Prisma.OrderServiceItemWhereInput = {};

  if (query.date_from || query.date_to) {
    where.service_date = {};
    // Interpret both ends as WIB calendar days so a late-evening Jakarta line
    // isn't pushed into the wrong day by UTC parsing.
    if (query.date_from)
      (where.service_date as Prisma.DateTimeFilter).gte = dayBounds(
        query.date_from,
      ).start;
    if (query.date_to)
      (where.service_date as Prisma.DateTimeFilter).lte = dayBounds(
        query.date_to,
      ).end;
  }
  if (query.driver_id) where.driver_id = query.driver_id;
  if (query.car_id) where.car_id = query.car_id;
  if (query.external_vendor_id)
    where.external_vendor_id = query.external_vendor_id;
  if (query.type === 'INTERNAL') where.is_external = false;
  if (query.type === 'EXTERNAL') where.is_external = true;
  if (query.status) where.line_status = query.status;
  if (query.overdue) {
    where.AND = [
      { service_date: { lt: staleTripCutoff() } },
      { line_status: { in: ['SCHEDULED', 'ASSIGNED', 'IN_PROGRESS'] } },
    ];
  }
  if (query.search) {
    where.OR = [
      { description: { contains: query.search, mode: 'insensitive' } },
      { driver_name_raw: { contains: query.search, mode: 'insensitive' } },
      { driver_phone_raw: { contains: query.search, mode: 'insensitive' } },
      { plate_raw: { contains: query.search, mode: 'insensitive' } },
      { pickup_location: { contains: query.search, mode: 'insensitive' } },
      { dropoff_location: { contains: query.search, mode: 'insensitive' } },
      {
        order: {
          customer_name: { contains: query.search, mode: 'insensitive' },
        },
      },
      {
        order: { order_code: { contains: query.search, mode: 'insensitive' } },
      },
    ];
  }

  const skip = (query.page - 1) * query.page_size;
  const [rawItems, total, agg] = await Promise.all([
    prisma.orderServiceItem.findMany({
      where,
      relationLoadStrategy: 'join',
      include: lineInclude,
      orderBy: [{ service_date: 'asc' }, { sort_order: 'asc' }],
      skip,
      take: query.page_size,
    }),
    prisma.orderServiceItem.count({ where }),
    prisma.orderServiceItem.aggregate({
      where,
      _sum: { total_price: true, ops_cost: true, margin_amount: true },
    }),
  ]);

  // Attach the derived #A1/#A2 confirmation badge state to each line.
  const items = rawItems.map((it) => ({
    ...withStartReady(it),
    confirmation_state: deriveState(it),
  }));

  return {
    items,
    pagination: {
      page: query.page,
      page_size: query.page_size,
      total,
      total_pages: Math.ceil(total / query.page_size),
    },
    totals: {
      revenue: agg._sum.total_price ?? 0,
      ops_cost: agg._sum.ops_cost ?? 0,
      margin: agg._sum.margin_amount ?? 0,
    },
  };
}

const toSen = (n: unknown) => Math.round(Number(n ?? 0) * 100);

/** Update assignment / status / finance for a single day-line and recompute
 * its margin, then roll up the parent order's totals. */
export async function assignScheduleLine(
  id: string,
  input: AssignScheduleLineInput,
) {
  const line = await prisma.orderServiceItem.findUnique({
    where: { id },
    include: {
      order: {
        select: {
          ...paymentOrderSelect,
          order_status: true,
          cancellation_fee: true,
          service_start_at: true,
          service_items: { select: { id: true, total_price: true, line_status: true, cancel_fee: true } },
        },
      },
      payable: { select: { status: true, kind: true } },
    },
  });
  if (!line) throw new AppError('Schedule line not found', 404);
  // T5: the days of a finished or cancelled order are closed.
  assertOrderOpenForDayChanges(line.order);
  // Cancelled after some days were done: the done days stay editable until
  // finalize, the cancelled ones are closed (the order total is the fee).
  if (line.order.cancellation_fee != null && line.line_status === 'CANCELLED') {
    throw new AppError(
      'Hari ini sudah dibatalkan bersama sisa order, jadi tidak bisa diubah lagi.',
      409,
    );
  }

  const isExternal = input.is_external ?? line.is_external;

  // Giving the line to a (new) internal driver needs a paid DP. Clearing the
  // driver or re-saving the same one (editing notes/times/costs) stays allowed.
  if (!isExternal && input.driver_id && input.driver_id !== line.driver_id) {
    assertOrderPaidForDriverAssignment(line.order);
  }

  // Validate referenced entities exist (and respect internal/external mode).
  // These reads are independent, so run them concurrently — over the Supabase
  // pooler each serial round-trip costs ~1s, so parallelising the existence
  // checks shaves real latency off every assign.
  let newDriver: { id: string; name: string; status: string } | null = null;
  let newCar: { id: string; plate_number: string; status: string } | null = null;
  if (!isExternal) {
    const [d, c] = await Promise.all([
      input.driver_id
        ? prisma.driver.findUnique({ where: { id: input.driver_id } })
        : Promise.resolve(null),
      input.car_id
        ? prisma.car.findUnique({ where: { id: input.car_id } })
        : Promise.resolve(null),
    ]);
    if (input.driver_id && !d) throw new AppError('Driver not found', 404);
    if (input.car_id && !c) throw new AppError('Car not found', 404);
    // Only a unit newly given to this day is checked for clashes.
    if (d && d.id !== line.driver_id) newDriver = d;
    if (c && c.id !== line.car_id) newCar = c;
  } else {
    const [v, ec] = await Promise.all([
      input.external_vendor_id
        ? prisma.externalVendor.findUnique({
            where: { id: input.external_vendor_id },
          })
        : Promise.resolve(null),
      input.external_car_id
        ? prisma.externalCar.findUnique({
            where: { id: input.external_car_id },
          })
        : Promise.resolve(null),
    ]);
    if (input.external_vendor_id && !v)
      throw new AppError('External vendor not found', 404);
    if (input.external_car_id && !ec)
      throw new AppError('External car not found', 404);
  }

  // ── Driver pay (2026-10-03) ───────────────────────────────────────────
  // undefined = leave as is. "Biaya Ops" (ops_cost) from older dashboards is
  // ignored: it is now derived from the approved trip costs, and treating the
  // prefilled value as the fee wiped the driver's fee on every save.
  let fee: number | null | undefined = input.driver_fee;
  let feeNote: string | null | undefined = input.driver_fee_note;
  let rtr: number | null | undefined = input.rtr_amount;
  const feeGiven = fee !== undefined;

  const nextDriverId = isExternal
    ? null
    : input.driver_id !== undefined
      ? input.driver_id
      : line.driver_id;
  const nextVendorId = !isExternal
    ? null
    : input.external_vendor_id !== undefined
      ? input.external_vendor_id
      : line.is_external
        ? line.external_vendor_id
        : null;

  // A day already paid to someone cannot silently move to someone else.
  const paidTo = await paidPayableBlockingChange(prisma, id, {
    kind: nextDriverId ? 'DRIVER' : nextVendorId ? 'VENDOR' : null,
    ownerId: nextDriverId ?? nextVendorId ?? null,
  });
  if (paidTo) {
    throw new AppError(
      `Hari ini sudah dibayar ke ${paidTo}. Tandai belum terbayar dulu di menu Utang sebelum mengganti driver atau rekanan.`,
      409,
    );
  }

  // First internal driver on a day without a fee: fill it from the fee table.
  if (!isExternal && nextDriverId && !feeGiven && line.driver_fee == null) {
    const d = defaultDriverFee(line.service_kind);
    fee = d.amount;
    if (feeNote === undefined) feeNote = d.note;
  }

  // Cancelled before the trip started: nobody earned anything for this day,
  // unless the admin enters an amount in the same save.
  const becomesCancelled =
    input.line_status === 'CANCELLED' && line.line_status !== 'CANCELLED';
  // B1.1 (owner, 6 Oct 2026): Edit Hari never ends an order. Cancelling the
  // last day still to run (neither cancelled nor done) goes through "Batalkan
  // Pesanan", which charges the cancellation fee. A day of a multi-day order
  // may be cancelled here while another one is still to run. Checked again in
  // the transaction (two days cancelled at once).
  const endsOrder = becomesCancelled && isOpenDay(line.line_status);
  if (endsOrder && !line.order.service_items.some((l) => l.id !== id && isOpenDay(l.line_status))) {
    throw new AppError(LAST_OPEN_DAY_MESSAGE, 409, { code: 'LAST_OPEN_DAY' });
  }
  // Per-day cancellation fee (A3, owner 7 Oct 2026). The fee is worked out
  // from the day's own WIB date and price at the decision time (the save, or
  // when the customer asked) and stored on the day; it stays part of the
  // order total. A day already done keeps its price (Q7).
  const now = new Date();
  let cancellation: DayCancellation | null = null;
  let cancelRequestedAt: Date | null = null;
  if (becomesCancelled) {
    if (line.line_status === 'DONE') throw new AppError(DONE_DAY_MESSAGE, 409, { code: 'DONE_DAY' });
    if (!input.cancel_reason) {
      throw new AppError('Alasan pembatalan hari ini wajib diisi.', 400);
    }
    const when = cancelDecisionTime(input.cancel_requested_at, now);
    if (when.error) throw new AppError(when.error, 400);
    cancelRequestedAt = when.requestedAt;
    cancellation = dayCancellation({
      price: Number(line.total_price),
      dayDate: dayDateOf(line, line.order.service_start_at),
      started: dayStarted(line),
      decidedAt: when.decidedAt,
    });
    if (
      input.expected_cancel_fee !== undefined &&
      toSen(input.expected_cancel_fee) !== toSen(cancellation.fee)
    ) {
      const quote = await lineCancelQuote(id, input.cancel_requested_at, now);
      throw new AppError(
        `Biaya pembatalan hari ini sekarang ${rupiah(cancellation.fee)} (${cancellation.pct}%), bukan ${rupiah(input.expected_cancel_fee)}. Periksa lalu simpan lagi.`,
        409,
        { code: 'CANCEL_FEE_CHANGED', quote },
      );
    }
  }
  const started = !!(line.actual_start_at || line.trip_started_at);
  const paidPayable =
    line.payable?.status === 'PAID' ? line.payable.kind : null;
  if (becomesCancelled && !started) {
    // A day already paid out keeps its amounts (history); the admin marks it
    // unpaid first in Utang if the money has to come back.
    if (!isExternal && !feeGiven && paidPayable !== 'DRIVER') {
      fee = 0;
      feeNote = 'Dibatalkan sebelum berangkat';
    }
    if (isExternal && input.rtr_amount === undefined && paidPayable !== 'VENDOR')
      rtr = 0;
  }

  // The amounts of a day already paid out are frozen, like its payable.
  const changes = (next: number | null | undefined, cur: unknown) =>
    next !== undefined && Number(next ?? 0) !== Number(cur ?? 0);
  if (
    (paidPayable === 'DRIVER' &&
      !isExternal &&
      (changes(fee, line.driver_fee) ||
        changes(input.travel_advance, line.travel_advance))) ||
    (paidPayable === 'VENDOR' && isExternal && changes(rtr, line.rtr_amount))
  ) {
    throw new AppError(
      'Hari ini sudah dibayar. Tandai belum terbayar dulu di menu Utang bila fee, uang jalan atau RTR-nya berubah.',
      409,
    );
  }

  const data: Prisma.OrderServiceItemUncheckedUpdateInput = {
    is_external: isExternal,
  };
  if (isExternal) {
    // Partner day: no Arasya driver pay.
    data.driver_fee = null;
    data.driver_fee_note = null;
    data.travel_advance = null;
    if (rtr !== undefined) data.rtr_amount = rtr;
  } else {
    data.rtr_amount = null;
    if (fee !== undefined) data.driver_fee = fee;
    if (feeNote !== undefined) data.driver_fee_note = feeNote?.trim() || null;
    if (input.travel_advance !== undefined)
      data.travel_advance = input.travel_advance;
  }
  // When switching mode, clear the other side's links.
  if (isExternal) {
    data.driver_id = null;
    data.car_id = null;
    if (input.external_vendor_id !== undefined)
      data.external_vendor_id = input.external_vendor_id;
    if (input.external_car_id !== undefined)
      data.external_car_id = input.external_car_id;
    // Partner driver / plate for this day ('' → null).
    if (input.driver_name_raw !== undefined)
      data.driver_name_raw = input.driver_name_raw?.trim() || null;
    if (input.driver_phone_raw !== undefined)
      data.driver_phone_raw = input.driver_phone_raw?.trim() || null;
    if (input.plate_raw !== undefined)
      data.plate_raw = input.plate_raw?.trim().toUpperCase() || null;
  } else {
    data.external_vendor_id = null;
    data.external_car_id = null;
    // Switching external → internal: the partner's driver/plate no longer
    // apply. (Internal lines keep any sheet-import raw values untouched.)
    if (line.is_external) {
      data.driver_name_raw = null;
      data.driver_phone_raw = null;
      data.plate_raw = null;
    }
    if (input.driver_id !== undefined) data.driver_id = input.driver_id;
    if (input.car_id !== undefined) data.car_id = input.car_id;
  }
  // T4 (owner, Oct 2026): one way to assign. An internal day that has a
  // driver is ASSIGNED, whatever status the form sent (the day drawer and Edit
  // Hari send the day's current status, SCHEDULED, with the new driver);
  // taking the driver off a day not started yet puts it back to SCHEDULED.
  // Accepting is separate (driver_accepted_at) and never changes the status.
  // Partner days keep the status the admin chooses.
  const requested = input.line_status ?? line.line_status;
  let nextStatus: ScheduleStatus = requested;
  if (!isExternal && nextDriverId && requested === 'SCHEDULED') nextStatus = 'ASSIGNED';
  if (!isExternal && !nextDriverId && requested === 'ASSIGNED' && !started)
    nextStatus = 'SCHEDULED';
  if (input.line_status !== undefined || nextStatus !== line.line_status) {
    data.line_status = nextStatus;
    // The line IS the trip: derive journey timestamps from the status change
    // (an admin reset to SCHEDULED clears them even when a driver keeps it
    // ASSIGNED).
    const ts = tripTimestampsForLine(requested === 'SCHEDULED' ? requested : nextStatus, {
      trip_started_at: line.trip_started_at,
      trip_finished_at: line.trip_finished_at,
    });
    if (ts.trip_started_at !== undefined) data.trip_started_at = ts.trip_started_at;
    if (ts.trip_finished_at !== undefined)
      data.trip_finished_at = ts.trip_finished_at;
  }
  // A different driver (or none) has not accepted this day yet: the app shows
  // "Terima tugas" again. A day under way keeps its record.
  if (nextDriverId !== line.driver_id && !started) data.driver_accepted_at = null;
  if (input.service_date !== undefined)
    data.service_date = input.service_date ? new Date(input.service_date) : null;
  if (input.start_at !== undefined)
    data.start_at = input.start_at ? new Date(input.start_at) : null;
  if (input.end_at !== undefined)
    data.end_at = input.end_at ? new Date(input.end_at) : null;
  if (input.notes !== undefined) data.notes = input.notes;
  if (cancellation) {
    data.cancel_fee = cancellation.fee;
    data.cancel_tier = cancellation.tier;
    data.cancelled_at = now;
    data.cancel_reason = input.cancel_reason ?? null;
    data.cancel_requested_at = cancelRequestedAt;
  }
  // Reopening a cancelled day clears its fee, so the total rises again; the
  // saldo lebih it released stays (owner, 7 Oct 2026, Q8).
  const reopens =
    line.line_status === 'CANCELLED' && data.line_status !== undefined && data.line_status !== 'CANCELLED';
  if (reopens) {
    data.cancel_fee = null;
    data.cancel_tier = null;
    data.cancelled_at = null;
    data.cancel_reason = null;
    data.cancel_requested_at = null;
  }

  // A driver or car newly given to an open day must be free at that time
  // (same rule as "Tetapkan untuk Semua" / "Ganti Semua"). Checked inside the
  // transaction below, under the order and unit locks.
  const checkUnits =
    (newDriver || newCar) && ['SCHEDULED', 'ASSIGNED', 'IN_PROGRESS'].includes(nextStatus);
  const dayTimes = {
    id,
    service_date:
      input.service_date !== undefined ? (data.service_date as Date | null) : line.service_date,
    start_at: input.start_at !== undefined ? (data.start_at as Date | null) : line.start_at,
    end_at: input.end_at !== undefined ? (data.end_at as Date | null) : line.end_at,
  };

  // Capture the line's resource links BEFORE the update so a reassignment can
  // also release the previously-linked driver/car.
  const prevDriverId = line.driver_id;
  const prevCarId = line.car_id;
  const driversToSync = [...new Set([prevDriverId, nextDriverId].filter((x): x is string => !!x))];
  const nextCarId = isExternal
    ? null
    : input.car_id !== undefined
      ? input.car_id
      : line.car_id;
  const carsToSync = [...new Set([prevCarId, nextCarId].filter((x): x is string => !!x))];

  const updated = await prisma.$transaction(async (tx) => {
    // The day first (B9 lock order in order-money.ts). INV-10: a day is
    // cancelled once. Two saves cancelling it at the same moment: the second
    // finds it cancelled under the lock and keeps the first fee (a resend is
    // a no-op); a day finished meanwhile cannot be cancelled.
    if (cancellation) {
      const [cur] = await tx.$queryRaw<{ line_status: string }[]>`
        SELECT line_status::text AS line_status FROM "order_service_items" WHERE id = ${id} FOR NO KEY UPDATE`;
      if (cur?.line_status === 'DONE') throw new AppError(DONE_DAY_MESSAGE, 409, { code: 'DONE_DAY' });
      if (cur?.line_status === 'CANCELLED') {
        delete data.cancel_fee;
        delete data.cancel_tier;
        delete data.cancelled_at;
        delete data.cancel_reason;
        delete data.cancel_requested_at;
        cancellation = null;
      }
    }
    await tx.orderServiceItem.update({ where: { id }, data });
    // The order total before this change, read under the order lock (day →
    // order, B9 lock order in order-money.ts): the baseline of the INV-6
    // check below. The total read before the transaction may be out of date.
    await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${line.order_id} FOR NO KEY UPDATE`;
    const before = await tx.order.findUniqueOrThrow({
      where: { id: line.order_id },
      select: { final_price: true },
    });
    // Costs, margin and the payable follow the day; then the order totals.
    await recomputeLineMoney(tx, id);
    await rollupOrderFinance(tx, line.order_id);
    // T5 again, under the order lock rollupOrderFinance took: a finalize or
    // cancel that committed meanwhile wins and this save is rolled back (also
    // a cancel that kept done days: it may have cancelled this very day).
    const fresh = await tx.order.findUniqueOrThrow({
      where: { id: line.order_id },
      select: { order_status: true, cancellation_fee: true },
    });
    assertOrderOpenForDayChanges(fresh);
    if (fresh.cancellation_fee != null && line.order.cancellation_fee == null) {
      throw new AppError(
        'Sisa order ini baru saja dibatalkan. Buka ulang order lalu simpan lagi bila hari ini masih perlu diubah.',
        409,
      );
    }
    // B1.1 again, under the order lock rollupOrderFinance took: a second day
    // cancelled at the same moment committed first.
    if (endsOrder) await assertNotLastOpenDay(tx, line.order_id, id);
    // INV-6 (finance design §3.1/§6; replaces B1.3): a change that lowers the
    // total (a day cancelled, now with its fee) may leave money beyond the
    // new total (the rollup released it as saldo lebih, so a day of an order
    // paid in full can be cancelled, owner 7 Oct 2026), but unpaid invoices
    // may not ask more than is still owed: the admin revises or voids the
    // unpaid invoice first. The 409 carries the numbers.
    const totals = await tx.order.findUniqueOrThrow({
      where: { id: line.order_id },
      select: { final_price: true },
    });
    if (toSen(totals.final_price) < toSen(before.final_price)) {
      await assertOpenWithinTotal(tx, line.order_id, cancellation ? 'Membatalkan hari ini' : 'Perubahan hari ini');
    }
    if (cancellation || reopens) {
      await tx.orderChangeLog.create({
        data: {
          order_id: line.order_id,
          field: 'line_status',
          old_value: `${line.line_status} (${dayLabelForLog(line)}, Rp ${Number(line.total_price)})`,
          new_value: cancellation
            ? `CANCELLED — ${cancellation.label}: Rp ${cancellation.fee}`
            : `${String(data.line_status)} (dibuka lagi, biaya pembatalan Rp ${Number(line.cancel_fee ?? 0)} dihapus)`,
          note: cancellation
            ? [
                input.cancel_reason,
                cancelRequestedAt ? `jam pelanggan membatalkan ${cancelRequestedAt.toISOString()}` : null,
              ]
                .filter(Boolean)
                .join(' | ')
            : null,
          actor: 'ADMIN',
        },
      });
    }
    if (checkUnits) {
      // Another admin giving the same driver / car an overlapping day at the
      // same moment waits on these locks and is then refused.
      await lockUnits(tx, driversToSync, carsToSync);
      await assertUnitsFree(tx, { driver: newDriver, car: newCar }, [dayTimes]);
    }

    // Order, driver and car status follow the days, in this same transaction.
    // The driver/car updates are two conditional statements each (no reads).
    await deriveAndSetOrderStatus(tx, line.order_id);
    await refreshDriverStatuses(tx, driversToSync);
    await refreshCarStatuses(tx, carsToSync);

    return tx.orderServiceItem.findUniqueOrThrow({
      where: { id },
      include: lineInclude,
    });
  }, { timeout: 20000, maxWait: 10000 });

  // Driver app: tell the new driver (and a replaced one) about the change.
  if (!updated.is_external && updated.driver_id && updated.driver_id !== prevDriverId) {
    void notifyNewTrips(updated.driver_id, [id]);
  }
  if (prevDriverId && prevDriverId !== updated.driver_id) {
    void notifyTripsRemoved(prevDriverId, [id]);
  }

  // #A1/#A2: same-day auto-send. Best-effort, never blocks the assign response.
  // Only fires when an internal driver+car are both set on the line.
  if (!updated.is_external && updated.driver_id && updated.car_id) {
    void maybeAutoSendOnAssign(id);
  }

  const orderMoney = cancellation || reopens ? await computeOrderMoney(prisma, updated.order_id) : undefined;
  return {
    ...withStartReady(updated),
    confirmation_state: deriveState(updated),
    ...(cancellation ? { cancellation } : {}),
    ...(orderMoney ? { order_money: orderMoney } : {}),
  };
}

const DONE_DAY_MESSAGE =
  'Hari ini sudah selesai, jadi tidak bisa dibatalkan. Harga hari yang sudah berjalan tetap ditagih.';

const dayLabelForLog = (l: { service_date: Date | null; start_at: Date | null }) => {
  const d = l.service_date ?? l.start_at;
  return d ? new Date(d.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10) : 'tanpa tanggal';
};

export type LineCancelBlock = null | 'LAST_OPEN_DAY' | 'OPEN_INVOICE_EXCEEDS' | 'DONE_DAY' | 'ALREADY_CANCELLED';

/**
 * GET /schedule/lines/:id/cancel-quote (finance design §5.2): what cancelling
 * this day in Edit Hari would charge now (or at `requestedAt`, the customer's
 * request time) and do to the order's money. Read-only; the save computes
 * the same rule again (R3) and answers 409 CANCEL_FEE_CHANGED when its fee
 * differs from the `expected_cancel_fee` the admin saw.
 */
export async function lineCancelQuote(id: string, requestedAt?: string, now = new Date()) {
  const when = cancelDecisionTime(requestedAt, now);
  if (when.error) throw new AppError(when.error, 400);
  const line = await prisma.orderServiceItem.findUnique({
    where: { id },
    include: {
      order: {
        select: {
          order_status: true,
          service_start_at: true,
          service_items: { select: { id: true, line_status: true } },
        },
      },
    },
  });
  if (!line) throw new AppError('Schedule line not found', 404);
  assertOrderOpenForDayChanges(line.order);
  const m = await moneyState(prisma, line.order_id);
  if (!m) throw new AppError('Order not found', 404);
  const price = Number(line.total_price);
  const started = dayStarted(line);
  let quote: { tier: number; pct: number; fee: number; label: string };
  let blocked: LineCancelBlock = null;
  if (line.line_status === 'CANCELLED') {
    const tier = line.cancel_tier ?? 0;
    quote = {
      tier,
      pct: tier ? TIER_PCT[tier as 1 | 2 | 3] : 0,
      fee: Number(line.cancel_fee ?? 0),
      label: 'Hari ini sudah dibatalkan',
    };
    blocked = 'ALREADY_CANCELLED';
  } else {
    quote = dayCancellation({
      price,
      dayDate: dayDateOf(line, line.order.service_start_at),
      started,
      decidedAt: when.decidedAt,
    });
    if (line.line_status === 'DONE') blocked = 'DONE_DAY';
    else if (!line.order.service_items.some((l) => l.id !== id && isOpenDay(l.line_status)))
      blocked = 'LAST_OPEN_DAY';
  }
  const newTotal = blocked === 'ALREADY_CANCELLED' ? m.total : m.total - toSen(price) + toSen(quote.fee);
  const maxOpen = Math.max(0, newTotal - m.covered);
  if (!blocked && m.open > maxOpen) blocked = 'OPEN_INVOICE_EXCEEDS';
  return {
    decided_at: when.decidedAt.toISOString(),
    requested_at: when.requestedAt?.toISOString() ?? null,
    tier: quote.tier,
    pct: quote.pct,
    price,
    fee: quote.fee,
    label: quote.label,
    started,
    blocked,
    new_total: newTotal / 100,
    net_paid: m.net / 100,
    covered: m.covered / 100,
    credit_release: Math.max(0, m.covered - newTotal) / 100,
    open_billed: m.open / 100,
    max_open_billed: maxOpen / 100,
    owed_after: Math.max(0, newTotal - m.net) / 100,
  };
}

/**
 * Recompute the order's rolled-up totals + margin from its day-lines.
 *
 *  - final_price = Σ dayBillable (a day's price, or its cancellation fee
 *    once cancelled, A3) + all billable charges, except on an order
 *    cancelled by the old whole-order rule (ORDER_V1, isLegacyCancelled),
 *    whose price stays frozen at the fee.
 *  - Costs: driver fees, Arasya's trip costs and partner RTR of every day
 *    (a cancelled day can still cost money if the trip had started).
 *  - margin = Σ active day margins − costs of cancelled days + charges that
 *    are real extra income (overtime, extra stop…). Trip costs billed to the
 *    customer are pass-through: income and cost cancel out.
 *  - Margin v6: a cancelled day adds cancel_fee − its costs. Legacy
 *    (ORDER_V1): the fee replaces what the days and the charges would have
 *    earned: margin += fee − active day prices − all charges (same rule as
 *    the dashboard's cancellation income).
 */
export async function rollupOrderFinance(
  tx: Prisma.TransactionClient,
  orderId: string,
) {
  // Lock the order row (day → order, B9 lock order in order-money.ts) so a payment
  // recorded meanwhile cannot slip between reading the money and writing
  // payment_status below.
  await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${orderId} FOR NO KEY UPDATE`;
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      order_status: true,
      final_price: true,
      paid_to_date: true,
      payment_status: true,
      refunded_total: true,
      is_refunded: true,
      refund_amount: true,
      cancellation_fee: true,
      cancellation_rule: true,
      invoices: {
        where: {
          invoice_type: 'CANCELLATION_FEE',
          status: { notIn: ['CANCELLED', 'REVISED'] },
        },
        select: { id: true },
      },
    },
  });
  if (!order) return;
  const lines = await tx.orderServiceItem.findMany({
    where: { order_id: orderId },
    include: { payable: { select: { extras_amount: true } } },
  });
  // Orders without day-lines keep their manually set price.
  if (lines.length === 0) return;

  let revenue = 0;
  // Σ per-day cancellation fees (A3): billed like a day price.
  let dayFees = 0;
  let ops = 0;
  let rtr = 0;
  let fees = 0;
  let margin = 0;
  let anyExternal = false;
  for (const l of lines) {
    const cancelled = l.line_status === 'CANCELLED';
    const fee = l.is_external ? 0 : Number(l.driver_fee ?? 0);
    const vendor = l.is_external ? Number(l.rtr_amount ?? 0) : 0;
    const costs =
      Number(l.ops_cost ?? 0) + Number(l.payable?.extras_amount ?? 0);
    ops += Number(l.ops_cost ?? 0);
    rtr += vendor;
    fees += fee;
    if (l.is_external) anyExternal = true;
    if (cancelled) {
      // Margin v6: a cancelled day earns its cancellation fee (none on legacy
      // days) and still carries what it cost (a started trip, a paid fee).
      const cancelFee = Number(l.cancel_fee ?? 0);
      dayFees += cancelFee;
      margin += cancelFee - (fee + vendor + costs);
    } else {
      revenue += Number(l.total_price ?? 0);
      margin += Number(l.margin_amount ?? 0);
    }
  }
  const adjustments = await tx.orderAdjustment.findMany({
    where: { order_id: orderId, is_billable: true },
    select: { amount: true, quantity: true, expense: { select: { id: true } } },
  });
  let charges = 0;
  for (const a of adjustments) {
    const amt = Number(a.amount ?? 0) * (a.quantity ?? 1);
    charges += amt;
    if (!a.expense) margin += amt;
  }
  // Legacy whole-order cancellation (ORDER_V1): the fee replaced what the
  // days and charges would have earned, and final_price stays frozen. A
  // per-day cancellation (DAY_V2, A3) is computed from the days like any
  // other order: charges stay billed in full (owner, 7 Oct 2026).
  const legacyCancelled = isLegacyCancelled(order);
  if (legacyCancelled) {
    margin += Number(order.cancellation_fee) - revenue - charges;
  }

  // An active CANCELLATION_FEE invoice marked orders cancelled before
  // cancellation_fee existed (the migration backfills it; kept as a fallback).
  const cancelledOrder =
    order.cancellation_rule !== 'DAY_V2' &&
    (order.order_status === 'CANCELLED' || legacyCancelled || order.invoices.length > 0);
  const finalPrice = cancelledOrder
    ? Number(order.final_price)
    : revenue + dayFees + charges;

  // payment_status follows the money received against the (new) total and
  // rental base, so an order whose total grows (a day added, a charge billed)
  // is no longer shown as paid, and one whose rental base grows until the
  // money received is below the 20% DP is no longer DP_PAID. A cancelled
  // order's status is set by cancelOrder. Orders whose payment was recorded
  // without paid_to_date (sheet imports) keep theirs (orderPaymentStatus).
  const paymentStatus = orderPaymentStatus({ ...order, final_price: finalPrice }, lines);
  await tx.order.update({
    where: { id: orderId },
    data: cancelledOrder
      ? { is_external: anyExternal }
      : {
          final_price: finalPrice,
          is_external: anyExternal,
          ...(paymentStatus !== order.payment_status ? { payment_status: paymentStatus } : {}),
        },
  });
  const totals = {
    total_user_amount: finalPrice,
    total_ops_cost: ops,
    rtr_amount: rtr,
    total_driver_amount: fees,
    driver_fee_amount: fees,
    margin_amount: margin,
    margin_formula_version: MARGIN_FORMULA_VERSION,
  };
  await tx.orderFinalFinance.upsert({
    where: { order_id: orderId },
    update: totals,
    create: { order_id: orderId, ...totals },
  });
  // INV-5: a total that fell below what money already covers (a day
  // cancelled with its fee, a price lowered, a billed charge removed, Batalkan
  // Pesanan) turns the excess into saldo lebih (RELEASE). The callers that
  // lower the total on purpose check INV-6 after this (assertOpenWithinTotal).
  await settleCredit(tx, orderId);
}

/**
 * Driver availability for a given day, derived from the SCHEDULE (not orders).
 * A driver is BUSY if they have a non-cancelled line on that day, else FREE.
 */
export async function driverAvailability(query: DriverAvailabilityQuery) {
  const { start, end } = dayBounds(query.date);
  const drivers = await prisma.driver.findMany({
    where: query.type ? { type: query.type } : undefined,
    select: { id: true, name: true, phone: true, type: true, status: true },
    orderBy: { name: 'asc' },
  });
  const lines = await prisma.orderServiceItem.findMany({
    where: {
      driver_id: { not: null },
      line_status: { not: 'CANCELLED' },
      service_date: { gte: start, lte: end },
    },
    include: {
      order: { select: { id: true, order_code: true, customer_name: true } },
    },
  });
  const byDriver = new Map<string, typeof lines>();
  for (const l of lines) {
    if (!l.driver_id) continue;
    if (!byDriver.has(l.driver_id)) byDriver.set(l.driver_id, []);
    byDriver.get(l.driver_id)!.push(l);
  }
  return {
    date: start.toISOString().slice(0, 10),
    drivers: drivers.map((d) => {
      const busy = byDriver.get(d.id) || [];
      return {
        ...d,
        availability: busy.length ? 'BUSY' : 'FREE',
        bookings: busy.map((b) => ({
          line_id: b.id,
          order_id: b.order?.id,
          order_code: b.order?.order_code,
          customer_name: b.order?.customer_name,
          route: `${b.pickup_location} -> ${b.dropoff_location}`,
          status: b.line_status,
        })),
      };
    }),
  };
}

/**
 * #12 Stock / availability monitor for a WIB calendar date.
 * Rules (locked with TEN):
 *  - total = ALL internal Driver/Car owned.
 *  - down  = units off the road today (Driver.status OFF / Car.status MAINTENANCE).
 *  - used  = distinct internal units on lines that day with line_status in
 *            (SCHEDULED, IN_PROGRESS). DONE/CANCELLED do NOT occupy a unit.
 *  - free  = total - used - down (a unit counted once; down takes precedence).
 * Only INTERNAL stock is counted (external vendors = unlimited 3rd-party supply).
 */
export async function scheduleStock(query: { date?: string }) {
  const { start, end } = dayBounds(query.date);
  const ACTIVE: ScheduleStatus[] = ['SCHEDULED', 'ASSIGNED', 'IN_PROGRESS'];

  const [drivers, cars, lines] = await Promise.all([
    prisma.driver.findMany({
      where: { type: 'INTERNAL' },
      select: { id: true, name: true, phone: true, status: true },
      orderBy: { name: 'asc' },
    }),
    prisma.car.findMany({
      where: { type: 'INTERNAL' },
      select: {
        id: true,
        model: true,
        plate_number: true,
        unit_code: true,
        status: true,
      },
      orderBy: { model: 'asc' },
    }),
    prisma.orderServiceItem.findMany({
      where: {
        is_external: false,
        line_status: { in: ACTIVE },
        service_date: { gte: start, lte: end },
      },
      select: {
        id: true,
        driver_id: true,
        car_id: true,
        line_status: true,
        pickup_location: true,
        dropoff_location: true,
        order: { select: { id: true, order_code: true, customer_name: true } },
      },
    }),
  ]);

  type Booking = {
    line_id: string;
    order_id?: string;
    order_code?: string | null;
    customer_name?: string;
    route: string;
    status: ScheduleStatus;
  };
  const bookingOf = (l: (typeof lines)[number]): Booking => ({
    line_id: l.id,
    order_id: l.order?.id,
    order_code: l.order?.order_code,
    customer_name: l.order?.customer_name,
    route: `${l.pickup_location} -> ${l.dropoff_location}`,
    status: l.line_status,
  });

  const driverBookings = new Map<string, Booking[]>();
  const carBookings = new Map<string, Booking[]>();
  for (const l of lines) {
    if (l.driver_id) {
      if (!driverBookings.has(l.driver_id)) driverBookings.set(l.driver_id, []);
      driverBookings.get(l.driver_id)!.push(bookingOf(l));
    }
    if (l.car_id) {
      if (!carBookings.has(l.car_id)) carBookings.set(l.car_id, []);
      carBookings.get(l.car_id)!.push(bookingOf(l));
    }
  }

  // Drivers
  const driverDown: typeof drivers = [];
  const driverUsed: { id: string; name: string; phone: string; bookings: Booking[] }[] = [];
  const driverFree: { id: string; name: string; phone: string }[] = [];
  for (const d of drivers) {
    if (d.status === 'OFF') {
      driverDown.push(d);
    } else if (driverBookings.has(d.id)) {
      driverUsed.push({ id: d.id, name: d.name, phone: d.phone, bookings: driverBookings.get(d.id)! });
    } else {
      driverFree.push({ id: d.id, name: d.name, phone: d.phone });
    }
  }

  // Cars
  const carDown: typeof cars = [];
  const carUsed: {
    id: string;
    model: string;
    plate_number: string;
    unit_code: string | null;
    bookings: Booking[];
  }[] = [];
  const carFree: { id: string; model: string; plate_number: string; unit_code: string | null }[] = [];
  for (const c of cars) {
    if (c.status === 'MAINTENANCE') {
      carDown.push(c);
    } else if (carBookings.has(c.id)) {
      carUsed.push({
        id: c.id,
        model: c.model,
        plate_number: c.plate_number,
        unit_code: c.unit_code,
        bookings: carBookings.get(c.id)!,
      });
    } else {
      carFree.push({
        id: c.id,
        model: c.model,
        plate_number: c.plate_number,
        unit_code: c.unit_code,
      });
    }
  }

  return {
    date: start.toISOString(),
    date_wib: new Date(start.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10),
    drivers: {
      total: drivers.length,
      down: driverDown.length,
      used: driverUsed.length,
      free: driverFree.length,
      down_list: driverDown.map((d) => ({ id: d.id, name: d.name })),
      used_list: driverUsed,
      free_list: driverFree,
    },
    cars: {
      total: cars.length,
      down: carDown.length,
      used: carUsed.length,
      free: carFree.length,
      down_list: carDown.map((c) => ({
        id: c.id,
        model: c.model,
        plate_number: c.plate_number,
        unit_code: c.unit_code,
      })),
      used_list: carUsed,
      free_list: carFree,
    },
  };
}

/** WIB calendar date (YYYY-MM-DD) for a given instant. */
function wibDateStr(d: Date): string {
  return new Date(d.getTime() + WIB_OFFSET_MS).toISOString().slice(0, 10);
}

/** Monday (WIB) of the week containing the given WIB date string. */
function wibWeekStart(dateStr: string): string {
  const { start } = dayBounds(dateStr); // WIB midnight as UTC instant
  // getUTCDay on the WIB-shifted instant gives the WIB weekday.
  const wib = new Date(start.getTime() + WIB_OFFSET_MS);
  const dow = (wib.getUTCDay() + 6) % 7; // 0 = Monday
  const monday = new Date(start.getTime() - dow * 24 * 60 * 60 * 1000);
  return wibDateStr(monday);
}

/**
 * Week Timeline: 7 WIB days of fleet availability in ONE response, for the
 * dashboard Schedule > Timeline view.
 *
 * Rows are the chosen resource (drivers by default, or cars); each row carries
 * a 7-cell array aligned to the week's days. A cell is either free or holds the
 * active bookings (SCHEDULED/IN_PROGRESS internal lines) for that resource on
 * that WIB day. Each day also gets capacity counts (free/used/down/total for
 * BOTH drivers and cars) so the UI can show a per-day capacity ribbon without
 * extra calls. Two queries total (fleet + lines), bucketed in memory.
 */
export async function scheduleWeek(query: ScheduleWeekQuery) {
  const weekStart = wibWeekStart(query.from ?? wibDateStr(new Date()));
  const days = Array.from({ length: 7 }, (_, i) => {
    const ds = wibDateStr(
      new Date(dayBounds(weekStart).start.getTime() + i * 24 * 60 * 60 * 1000),
    );
    return ds;
  });
  const windowStart = dayBounds(days[0]).start;
  const windowEnd = dayBounds(days[6]).end;
  const ACTIVE: ScheduleStatus[] = ['SCHEDULED', 'ASSIGNED', 'IN_PROGRESS'];

  const [drivers, cars, lines] = await Promise.all([
    prisma.driver.findMany({
      where: { type: 'INTERNAL' },
      select: { id: true, name: true, phone: true, status: true },
      orderBy: { name: 'asc' },
    }),
    prisma.car.findMany({
      where: { type: 'INTERNAL' },
      select: {
        id: true,
        model: true,
        plate_number: true,
        unit_code: true,
        status: true,
      },
      orderBy: { model: 'asc' },
    }),
    prisma.orderServiceItem.findMany({
      where: {
        is_external: false,
        line_status: { in: ACTIVE },
        service_date: { gte: windowStart, lte: windowEnd },
      },
      relationLoadStrategy: 'join',
      select: {
        id: true,
        driver_id: true,
        car_id: true,
        line_status: true,
        service_date: true,
        pickup_location: true,
        dropoff_location: true,
        order: { select: { id: true, order_code: true, customer_name: true } },
      },
    }),
  ]);

  type WeekBooking = {
    line_id: string;
    order_id?: string;
    order_code?: string | null;
    customer_name?: string;
    route: string;
    status: ScheduleStatus;
  };
  const bookingOf = (l: (typeof lines)[number]): WeekBooking => ({
    line_id: l.id,
    order_id: l.order?.id,
    order_code: l.order?.order_code,
    customer_name: l.order?.customer_name,
    route: `${l.pickup_location} -> ${l.dropoff_location}`,
    status: l.line_status,
  });

  const dayIndex = new Map(days.map((d, i) => [d, i]));
  // resourceDayBookings[resourceId][dayIdx] = bookings
  const driverGrid = new Map<string, WeekBooking[][]>();
  const carGrid = new Map<string, WeekBooking[][]>();
  const emptyGrid = () => Array.from({ length: 7 }, () => [] as WeekBooking[]);

  // Unassigned lanes: a scheduled line with no driver (or no car) belongs to no
  // resource row, so without this it would be invisible on the board. Surface it
  // in a dedicated lane so dispatchers can see + assign pending work.
  const driverUnassigned = emptyGrid();
  const carUnassigned = emptyGrid();
  for (const l of lines) {
    if (!l.service_date) continue;
    const di = dayIndex.get(wibDateStr(l.service_date));
    if (di == null) continue;
    if (l.driver_id) {
      if (!driverGrid.has(l.driver_id)) driverGrid.set(l.driver_id, emptyGrid());
      driverGrid.get(l.driver_id)![di].push(bookingOf(l));
    } else {
      driverUnassigned[di].push(bookingOf(l));
    }
    if (l.car_id) {
      if (!carGrid.has(l.car_id)) carGrid.set(l.car_id, emptyGrid());
      carGrid.get(l.car_id)![di].push(bookingOf(l));
    } else {
      carUnassigned[di].push(bookingOf(l));
    }
  }

  const driverRows = drivers.map((d) => ({
    id: d.id,
    name: d.name,
    phone: d.phone,
    down: d.status === 'OFF',
    cells: (driverGrid.get(d.id) ?? emptyGrid()).map((bookings) => ({
      free: d.status !== 'OFF' && bookings.length === 0,
      bookings,
    })),
  }));
  const carRows = cars.map((c) => ({
    id: c.id,
    name: c.model,
    plate_number: c.plate_number,
    unit_code: c.unit_code,
    down: c.status === 'MAINTENANCE',
    cells: (carGrid.get(c.id) ?? emptyGrid()).map((bookings) => ({
      free: c.status !== 'MAINTENANCE' && bookings.length === 0,
      bookings,
    })),
  }));

  // Per-day capacity ribbon (both fleets), independent of the chosen resource.
  const capacity = days.map((_, di) => {
    const dDown = driverRows.filter((r) => r.down).length;
    const dUsed = driverRows.filter(
      (r) => !r.down && r.cells[di].bookings.length > 0,
    ).length;
    const cDown = carRows.filter((r) => r.down).length;
    const cUsed = carRows.filter(
      (r) => !r.down && r.cells[di].bookings.length > 0,
    ).length;
    const trips = lines.filter(
      (l) => l.service_date && wibDateStr(l.service_date) === days[di],
    ).length;
    return {
      date: days[di],
      trips,
      drivers: {
        total: drivers.length,
        down: dDown,
        used: dUsed,
        free: drivers.length - dDown - dUsed,
      },
      cars: {
        total: cars.length,
        down: cDown,
        used: cUsed,
        free: cars.length - cDown - cUsed,
      },
    };
  });

  const today = wibDateStr(new Date());
  // Lane of scheduled-but-unassigned trips for the chosen resource. Only emitted
  // when it actually has bookings, so the board stays clean when all is assigned.
  const unassignedCells = (
    query.resource === 'cars' ? carUnassigned : driverUnassigned
  ).map((bookings) => ({ free: false, bookings }));
  const unassigned = unassignedCells.some((c) => c.bookings.length > 0)
    ? { id: '__unassigned__', name: '', cells: unassignedCells }
    : null;
  return {
    week_start: days[0],
    week_end: days[6],
    today,
    resource: query.resource,
    days,
    capacity,
    unassigned,
    rows: query.resource === 'cars' ? carRows : driverRows,
  };
}

/**
 * Trip History: finished (DONE) service-day lines, newest first, with full
 * per-line detail for the dashboard History tab.
 *
 * A line goes DONE the moment the driver reports dropoff, but the parent ORDER
 * only reaches DONE once the admin finalizes (after entering ops cost / driver
 * fee / additionals). So a DONE line can still be financially pending. We
 * surface BOTH and tag each row:
 *   - finance_status = 'FINALIZED' when the parent order_status === 'DONE'
 *   - finance_status = 'AWAITING'  when the line is DONE but the order is not
 *     yet finalized (order.awaiting_finalization or still IN_PROGRESS).
 * The dashboard renders money fields as "Pending" for AWAITING rows.
 *
 * Included per line: order summary, driver/car (or external vendor/car), the
 * actual timestamps, ops_cost, margin_amount, the Payable (driver fee, with
 * extras), and the driver TripReports (chronological).
 */
export async function tripHistory(query: TripHistoryQuery) {
  const where: Prisma.OrderServiceItemWhereInput = {
    line_status: 'DONE',
  };

  if (query.date_from || query.date_to) {
    where.service_date = {};
    if (query.date_from)
      (where.service_date as Prisma.DateTimeFilter).gte = dayBounds(
        query.date_from,
      ).start;
    if (query.date_to)
      (where.service_date as Prisma.DateTimeFilter).lte = dayBounds(
        query.date_to,
      ).end;
  }
  if (query.driver_id) where.driver_id = query.driver_id;
  if (query.car_id) where.car_id = query.car_id;

  // finance filter via the parent order's finalization state.
  if (query.finance === 'finalized') {
    where.order = { order_status: 'DONE' };
  } else if (query.finance === 'awaiting') {
    where.order = { order_status: { not: 'DONE' } };
  }

  if (query.search) {
    where.OR = [
      { pickup_location: { contains: query.search, mode: 'insensitive' } },
      { dropoff_location: { contains: query.search, mode: 'insensitive' } },
      { driver_name_raw: { contains: query.search, mode: 'insensitive' } },
      {
        order: {
          customer_name: { contains: query.search, mode: 'insensitive' },
        },
      },
      {
        order: { order_code: { contains: query.search, mode: 'insensitive' } },
      },
    ];
  }

  const historyInclude = {
    order: {
      select: {
        id: true,
        order_code: true,
        customer_name: true,
        order_status: true,
        payment_status: true,
        awaiting_finalization: true,
      },
    },
    driver: { select: { id: true, name: true, phone: true } },
    car: { select: { id: true, model: true, plate_number: true } },
    external_vendor: { select: { id: true, name: true, phone: true } },
    external_car: { select: { id: true, model: true, plate_number: true } },
    payable: {
      include: {
        extras: {
          select: { id: true, label: true, amount: true },
          orderBy: { created_at: 'asc' as const },
        },
      },
    },
    reports: {
      select: {
        id: true,
        report_type: true,
        input_type: true,
        notes: true,
        file_url: true,
        file_mime: true,
        driver_phone: true,
        status: true,
        amount: true,
        source: true,
        created_at: true,
        // GPS fix of the arrival photo / "sampai di lokasi jemput".
        latitude: true,
        longitude: true,
        location_accuracy_m: true,
        location_at: true,
        location_mocked: true,
        location_name: true,
      },
      orderBy: { created_at: 'asc' as const },
    },
    expenses: {
      select: {
        id: true,
        type: true,
        amount: true,
        note: true,
        status: true,
        paid_by: true,
        bill_to_customer: true,
        created_at: true,
      },
      orderBy: { created_at: 'asc' as const },
    },
  } satisfies Prisma.OrderServiceItemInclude;

  const skip = (query.page - 1) * query.page_size;
  const [rows, total] = await Promise.all([
    prisma.orderServiceItem.findMany({
      where,
      relationLoadStrategy: 'join',
      include: historyInclude,
      // Newest finished first: prefer actual dropoff time, fall back to date.
      orderBy: [{ trip_finished_at: 'desc' }, { service_date: 'desc' }],
      skip,
      take: query.page_size,
    }),
    prisma.orderServiceItem.count({ where }),
  ]);

  const items = rows.map((it) => {
    const finalized = it.order?.order_status === 'DONE';
    return {
      ...it,
      finance_status: finalized ? 'FINALIZED' : 'AWAITING',
    };
  });

  return {
    items,
    pagination: {
      page: query.page,
      page_size: query.page_size,
      total,
      total_pages: Math.ceil(total / query.page_size),
    },
  };
}
