import prisma from '../../prisma/client';
import { Prisma } from '@prisma/client';

const n = (v: Prisma.Decimal | number | null | undefined) =>
  v == null ? 0 : Number(v);

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Jakarta is UTC+7, no DST.

// Current-month window expressed in UTC for WIB calendar boundaries (#5).
// Defaults to "this month" in Jakarta; explicit YYYY-MM-DD ends override it.
function wibMonthBounds(fromStr?: string, toStr?: string): { start: Date; end: Date } {
  if (fromStr || toStr) {
    const startBase = fromStr ? new Date(`${fromStr}T00:00:00Z`) : new Date();
    const sWib = new Date(startBase.getTime());
    const start = fromStr
      ? new Date(
          Date.UTC(
            sWib.getUTCFullYear(),
            sWib.getUTCMonth(),
            sWib.getUTCDate(),
            0,
            0,
            0,
          ) - WIB_OFFSET_MS,
        )
      : new Date(0);
    const endBase = toStr ? new Date(`${toStr}T00:00:00Z`) : new Date();
    const eWib = new Date(endBase.getTime());
    const end = toStr
      ? new Date(
          Date.UTC(
            eWib.getUTCFullYear(),
            eWib.getUTCMonth(),
            eWib.getUTCDate(),
            0,
            0,
            0,
          ) -
            WIB_OFFSET_MS +
            24 * 60 * 60 * 1000 -
            1,
        )
      : new Date();
    return { start, end };
  }
  // No range -> current WIB month.
  const nowWib = new Date(Date.now() + WIB_OFFSET_MS);
  const y = nowWib.getUTCFullYear();
  const m = nowWib.getUTCMonth();
  const start = new Date(Date.UTC(y, m, 1, 0, 0, 0) - WIB_OFFSET_MS);
  const end = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0) - WIB_OFFSET_MS - 1);
  return { start, end };
}

function daysBetween(a: Date, b: Date) {
  return Math.floor((a.getTime() - b.getTime()) / 86400000);
}

interface RangeOpts {
  date_from?: string;
  date_to?: string;
}

/**
 * One consolidated analytics payload powering the richer dashboard:
 *  1. Receivables split (DP-pending vs settlement-due vs unbilled)
 *  2. Aging buckets (receivables + payables)
 *  3. Margin per order (top + bottom)
 *  4. Cashflow timeline (this week in vs out)
 *  5. Partner leaderboard (driver + vendor by revenue + margin)
 *  6. Internal vs external mix
 *  7. Car utilization
 *  8. Monthly trend (turnover / collected / payout)
 */
export async function dashboardAnalytics(opts: RangeOpts = {}) {
  const now = new Date();
  const from = opts.date_from ? new Date(opts.date_from) : null;
  const to = opts.date_to ? new Date(`${opts.date_to}`) : null;

  const orderDateWhere: Prisma.OrderWhereInput = {};
  if (from || to) {
    orderDateWhere.order_date = {};
    if (from) (orderDateWhere.order_date as Prisma.DateTimeFilter).gte = from;
    if (to) (orderDateWhere.order_date as Prisma.DateTimeFilter).lte = to;
  }

  const [orders, invoices, payables, serviceLines, cars] = await Promise.all([
    prisma.order.findMany({
      where: { ...orderDateWhere, order_status: { not: 'CANCELLED' } },
      select: {
        id: true,
        order_code: true,
        customer_name: true,
        order_date: true,
        final_price: true,
        payment_status: true,
        order_status: true,
        is_external: true,
      },
    }),
    prisma.invoice.findMany({
      where: { status: { notIn: ['REVISED', 'CANCELLED'] } },
      select: {
        id: true,
        order_id: true,
        invoice_type: true,
        amount: true,
        status: true,
        due_date: true,
        paid_at: true,
        issue_date: true,
      },
    }),
    prisma.payable.findMany({
      where: { order: { order_status: { not: 'CANCELLED' } } },
      select: {
        id: true,
        kind: true,
        status: true,
        total_amount: true,
        service_date: true,
        driver_id: true,
        vendor_id: true,
        driver: { select: { id: true, name: true } },
        vendor: { select: { id: true, name: true } },
      },
    }),
    prisma.orderServiceItem.findMany({
      where: {
        order: { order_status: { not: 'CANCELLED' } },
        OR: [{ driver_id: { not: null } }, { external_vendor_id: { not: null } }],
      },
      select: {
        id: true,
        is_external: true,
        line_status: true,
        service_date: true,
        total_price: true,
        margin_amount: true,
        ops_cost: true,
        rtr_amount: true,
        driver_id: true,
        external_vendor_id: true,
        order_id: true,
        external_car_id: true,
        driver: { select: { id: true, name: true } },
        external_vendor: { select: { id: true, name: true } },
        car: { select: { id: true, model: true, plate_number: true } },
        external_car: { select: { id: true, model: true, plate_number: true } },
      },
    }),
    prisma.car.findMany({
      select: { id: true, model: true, plate_number: true, status: true },
    }),
  ]);

  // Billable adjustments per order, so the order-level revenue and margin
  // here match OrderFinalFinance after rollup: every billable charge is
  // revenue, but a trip cost billed to the customer is pass-through (its cost
  // is the reimbursement or the company's payment), so only the other charges
  // (overtime, extra stop…) add to the margin.
  const adjustmentRows = await prisma.orderAdjustment.findMany({
    where: { is_billable: true, order: { order_status: { not: 'CANCELLED' } } },
    select: { order_id: true, amount: true, quantity: true, expense: { select: { id: true } } },
  });
  const adjByOrder = new Map<string, { revenue: number; margin: number }>();
  for (const a of adjustmentRows) {
    const amt = n(a.amount) * (a.quantity ?? 1);
    const cur = adjByOrder.get(a.order_id) ?? { revenue: 0, margin: 0 };
    cur.revenue += amt;
    if (!a.expense) cur.margin += amt;
    adjByOrder.set(a.order_id, cur);
  }

  // Map invoices by order
  const invByOrder = new Map<string, typeof invoices>();
  for (const inv of invoices) {
    const arr = invByOrder.get(inv.order_id) ?? [];
    arr.push(inv);
    invByOrder.set(inv.order_id, arr);
  }

  // ── 1. Receivables split ────────────────────────────────────────────────
  let recDpPending = 0; // orders with no payment at all
  let recSettlement = 0; // orders with DP but not fully paid
  let recUnbilled = 0; // value not covered by any invoice
  let totalReceivable = 0;
  for (const o of orders) {
    const price = n(o.final_price);
    const ivs = invByOrder.get(o.id) ?? [];
    const billed = ivs.reduce((s, i) => s + n(i.amount), 0);
    const paid = ivs
      .filter((i) => i.status === 'PAID')
      .reduce((s, i) => s + n(i.amount), 0);
    const outstanding = Math.max(price - paid, 0);
    if (outstanding <= 0) continue;
    totalReceivable += outstanding;
    if (price - billed > 0) recUnbilled += price - billed;
    if (o.payment_status === 'UNPAID') recDpPending += outstanding;
    else recSettlement += outstanding; // DP_PAID -> settlement remaining
  }

  // ── 2. Aging buckets ──────────────────────────────────────────────────────
  const recBuckets = { current: 0, d1_7: 0, d8_14: 0, d15_30: 0, d30plus: 0 };
  for (const inv of invoices) {
    if (inv.status === 'PAID') continue;
    const due = inv.due_date ?? inv.issue_date;
    const amt = n(inv.amount);
    const overdue = due ? daysBetween(now, due) : 0;
    if (overdue <= 0) recBuckets.current += amt;
    else if (overdue <= 7) recBuckets.d1_7 += amt;
    else if (overdue <= 14) recBuckets.d8_14 += amt;
    else if (overdue <= 30) recBuckets.d15_30 += amt;
    else recBuckets.d30plus += amt;
  }
  const payBuckets = { current: 0, d1_7: 0, d8_14: 0, d15_30: 0, d30plus: 0 };
  for (const p of payables) {
    if (p.status === 'PAID') continue;
    const amt = n(p.total_amount);
    const sd = p.service_date;
    const overdue = sd ? daysBetween(now, sd) : 0;
    if (overdue <= 0) payBuckets.current += amt;
    else if (overdue <= 7) payBuckets.d1_7 += amt;
    else if (overdue <= 14) payBuckets.d8_14 += amt;
    else if (overdue <= 30) payBuckets.d15_30 += amt;
    else payBuckets.d30plus += amt;
  }

  // ── 3. Margin per order (aggregate service lines per order) ──────────────
  const orderMap = new Map(orders.map((o) => [o.id, o]));
  const marginByOrder = new Map<
    string,
    { revenue: number; margin: number }
  >();
  for (const l of serviceLines) {
    if (!orderMap.has(l.order_id)) continue;
    const cur = marginByOrder.get(l.order_id) ?? { revenue: 0, margin: 0 };
    cur.revenue += n(l.total_price);
    cur.margin += n(l.margin_amount);
    marginByOrder.set(l.order_id, cur);
  }
  const marginRows = [...marginByOrder.entries()].map(([oid, v]) => {
    const o = orderMap.get(oid)!;
    const adj = adjByOrder.get(oid);
    const revenue = v.revenue + (adj?.revenue ?? 0);
    const margin = v.margin + (adj?.margin ?? 0);
    return {
      order_id: oid,
      order_code: o.order_code,
      customer_name: o.customer_name,
      revenue,
      margin,
      margin_pct: revenue > 0 ? (margin / revenue) * 100 : 0,
    };
  });
  const topMargin = [...marginRows]
    .sort((a, b) => b.margin - a.margin)
    .slice(0, 8);
  const bottomMargin = [...marginRows]
    .sort((a, b) => a.margin - b.margin)
    .slice(0, 8);

  // ── 4. Cashflow timeline (next 7 days) ───────────────────────────────────
  const weekEnd = new Date(now);
  weekEnd.setDate(weekEnd.getDate() + 7);
  let inflow7 = 0;
  for (const inv of invoices) {
    if (inv.status === 'PAID') continue;
    const due = inv.due_date ?? inv.issue_date;
    if (due && due >= now && due <= weekEnd) inflow7 += n(inv.amount);
  }
  let outflow7 = 0;
  for (const p of payables) {
    if (p.status === 'PAID') continue;
    const sd = p.service_date;
    if (sd && sd >= now && sd <= weekEnd) outflow7 += n(p.total_amount);
  }

  // ── 5. Partner leaderboard ────────────────────────────────────────────────
  const drvAgg = new Map<
    string,
    { name: string; trips: number; revenue: number; margin: number; ops: number }
  >();
  const vnAgg = new Map<
    string,
    { name: string; trips: number; revenue: number; cost: number }
  >();
  for (const l of serviceLines) {
    if (l.driver_id && l.driver) {
      const a = drvAgg.get(l.driver_id) ?? {
        name: l.driver.name,
        trips: 0,
        revenue: 0,
        margin: 0,
        ops: 0,
      };
      a.trips += 1;
      a.revenue += n(l.total_price);
      a.margin += n(l.margin_amount);
      a.ops += n(l.ops_cost);
      drvAgg.set(l.driver_id, a);
    } else if (l.external_vendor_id && l.external_vendor) {
      const a = vnAgg.get(l.external_vendor_id) ?? {
        name: l.external_vendor.name,
        trips: 0,
        revenue: 0,
        cost: 0,
      };
      a.trips += 1;
      a.revenue += n(l.total_price);
      a.cost += n(l.rtr_amount);
      vnAgg.set(l.external_vendor_id, a);
    }
  }
  const driverLeaderboard = [...drvAgg.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);
  const vendorLeaderboard = [...vnAgg.entries()]
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 10);

  // ── 6. Internal vs external mix ───────────────────────────────────────────
  let intTrips = 0,
    extTrips = 0,
    intRevenue = 0,
    extRevenue = 0;
  for (const l of serviceLines) {
    if (l.is_external) {
      extTrips += 1;
      extRevenue += n(l.total_price);
    } else {
      intTrips += 1;
      intRevenue += n(l.total_price);
    }
  }

  // ── 9. Rental frequency (internal vs external, cars vs drivers/vendors) ──
  type FreqAgg = { id: string; label: string; count: number; revenue: number };
  const bump = (
    map: Map<string, FreqAgg>,
    id: string,
    label: string,
    revenue: number,
  ) => {
    const a = map.get(id) ?? { id, label, count: 0, revenue: 0 };
    a.count += 1;
    a.revenue += revenue;
    map.set(id, a);
  };
  const intCarFreq = new Map<string, FreqAgg>();
  const extCarFreq = new Map<string, FreqAgg>();
  const intDriverFreq = new Map<string, FreqAgg>();
  const extVendorFreq = new Map<string, FreqAgg>();
  for (const l of serviceLines) {
    const rev = n(l.total_price);
    if (l.is_external) {
      if (l.external_car?.id) {
        const plate = l.external_car.plate_number
          ? ` (${l.external_car.plate_number})`
          : '';
        bump(extCarFreq, l.external_car.id, `${l.external_car.model}${plate}`, rev);
      }
      if (l.external_vendor?.id)
        bump(extVendorFreq, l.external_vendor.id, l.external_vendor.name, rev);
    } else {
      if (l.car?.id) {
        const plate = l.car.plate_number ? ` (${l.car.plate_number})` : '';
        bump(intCarFreq, l.car.id, `${l.car.model}${plate}`, rev);
      }
      if (l.driver?.id) bump(intDriverFreq, l.driver.id, l.driver.name, rev);
    }
  }
  const topN = (m: Map<string, FreqAgg>) =>
    [...m.values()].sort((a, b) => b.count - a.count || b.revenue - a.revenue).slice(0, 10);
  const frequency = {
    internal: { cars: topN(intCarFreq), drivers: topN(intDriverFreq) },
    external: { cars: topN(extCarFreq), vendors: topN(extVendorFreq) },
  };

  // ── 7. Car utilization (internal fleet) ──────────────────────────────────
  const carUse = new Map<string, number>();
  for (const l of serviceLines) {
    if (l.car?.id) carUse.set(l.car.id, (carUse.get(l.car.id) ?? 0) + 1);
  }
  const carUtilization = cars
    .map((c) => ({
      id: c.id,
      model: c.model,
      plate_number: c.plate_number,
      status: c.status,
      days_booked: carUse.get(c.id) ?? 0,
    }))
    .sort((a, b) => b.days_booked - a.days_booked);

  // ── 8. Monthly trend (last 6 months) ──────────────────────────────────────
  const months: { key: string; label: string; start: Date; end: Date }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
    months.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleString('id-ID', { month: 'short', year: '2-digit' }),
      start: d,
      end,
    });
  }
  const monthlyTrend = months.map((m) => {
    let turnover = 0;
    for (const o of orders) {
      if (o.order_date >= m.start && o.order_date <= m.end)
        turnover += n(o.final_price);
    }
    let collected = 0;
    for (const inv of invoices) {
      if (
        inv.status === 'PAID' &&
        inv.paid_at &&
        inv.paid_at >= m.start &&
        inv.paid_at <= m.end
      )
        collected += n(inv.amount);
    }
    let payout = 0;
    for (const p of payables) {
      if (
        p.status === 'PAID' &&
        p.service_date &&
        p.service_date >= m.start &&
        p.service_date <= m.end
      )
        payout += n(p.total_amount);
    }
    return { label: m.label, turnover, collected, payout };
  });

  return {
    receivables: {
      dp_pending: recDpPending,
      settlement_due: recSettlement,
      unbilled: recUnbilled,
      total: totalReceivable,
    },
    aging: { receivables: recBuckets, payables: payBuckets },
    margin: { top: topMargin, bottom: bottomMargin },
    cashflow: { inflow_7d: inflow7, outflow_7d: outflow7, net_7d: inflow7 - outflow7 },
    leaderboard: { drivers: driverLeaderboard, vendors: vendorLeaderboard },
    mix: {
      internal: { trips: intTrips, revenue: intRevenue },
      external: { trips: extTrips, revenue: extRevenue },
    },
    car_utilization: carUtilization,
    monthly_trend: monthlyTrend,
    frequency,
  };
}

// ─── #5 Revenue Report (§4f) ─────────────────────────────────────────────────
// Two clearly-separated sections so owned-asset revenue is never mixed with
// pass-through vendor money:
//   A. Internal cars  — revenue per owned unit (gross / ops / net margin).
//   B. Vendor margin  — Arasya's markup over vendor cost (customer_billed -
//                       vendor_cost), drillable vendor -> unit.
// Basis = OrderServiceItem.service_date (WIB). Each metric is split into
//   Final     = lines on DONE/finalized orders (realized), and
//   Estimated = still-open lines (same formula, flagged estimated).
// "Final" line test: order_status DONE OR line_status DONE.
// A cancelled day earns nothing; it shows only when it still cost something
// (a started trip keeps its fee / RTR), as a settled (Final) cost. Extra
// charges and cancellation fees have no unit: they are in `order_level`, so
// sections A + B + order_level add up to the Dashboard's Revenue.
interface RevenueOpts {
  date_from?: string;
  date_to?: string;
}

export async function revenueReport(opts: RevenueOpts = {}) {
  const { start, end } = wibMonthBounds(opts.date_from, opts.date_to);

  const orderLevelP = orderLevelSlice(start, end);
  const linesP = prisma.orderServiceItem.findMany({
    where: {
      service_date: { gte: start, lte: end },
    },
    select: {
      id: true,
      order_id: true,
      total_price: true,
      ops_cost: true,
      margin_amount: true,
      rtr_amount: true,
      driver_fee: true,
      line_status: true,
      is_external: true,
      car_id: true,
      car: { select: { id: true, model: true, plate_number: true, unit_code: true } },
      driver_id: true,
      driver: { select: { id: true, name: true, phone: true, type: true } },
      external_vendor_id: true,
      external_vendor: { select: { id: true, name: true } },
      external_car_id: true,
      external_car: { select: { id: true, model: true, plate_number: true } },
      order: { select: { order_status: true } },
      payable: {
        select: {
          kind: true,
          total_amount: true,
          extras_amount: true,
          status: true,
          paid_at: true,
        },
      },
    },
  });
  const [orderLevel, lines] = await Promise.all([orderLevelP, linesP]);

  const isFinal = (l: (typeof lines)[number]) =>
    !dayEarns(l) || l.order?.order_status === 'DONE' || l.line_status === 'DONE';

  // ── Section A — internal cars, GROUP BY car_id ──────────────────────────────
  type ABucket = {
    car_id: string | null;
    car_label: string;
    plate: string | null;
    unit_code: string | null;
    final: { gross: number; ops: number; net_margin: number; trips: number; driver_fee: number };
    estimated: { gross: number; ops: number; net_margin: number; trips: number; driver_fee: number };
    final_margin_known: boolean;
    est_margin_known: boolean;
    final_order_ids: Set<string>;
    est_order_ids: Set<string>;
  };
  const aMap = new Map<string, ABucket>();

  // ── Section C — driver fee report, GROUP BY driver_id (internal drivers) ────
  type CBucket = {
    driver_id: string | null;
    driver_name: string;
    driver_phone: string | null;
    fee_paid: number;     // payable.status=PAID — received
    fee_pending: number;  // payable.status=UNPAID — still owed
    fee_total: number;    // = paid + pending (accrued in period)
    trips: number;
    order_ids: Set<string>;
  };
  const cMap = new Map<string, CBucket>();

  // KPI — distinct order counts by channel.
  const internalOrderIds = new Set<string>();
  const vendorOrderIds = new Set<string>();
  const freelanceOrderIds = new Set<string>();

  // ── Section B — vendor margin, GROUP BY vendor -> external_car ───────────────
  type BUnit = {
    external_car_id: string | null;
    car_label: string;
    plate: string | null;
    final: { customer_billed: number; vendor_cost: number; arasya_margin: number; trips: number };
    estimated: { customer_billed: number; vendor_cost: number; arasya_margin: number; trips: number };
    final_order_ids: Set<string>;
    est_order_ids: Set<string>;
  };
  type BVendor = {
    vendor_id: string | null;
    vendor_name: string;
    final: { customer_billed: number; vendor_cost: number; arasya_margin: number; trips: number };
    estimated: { customer_billed: number; vendor_cost: number; arasya_margin: number; trips: number };
    units: Map<string, BUnit>;
    final_order_ids: Set<string>;
    est_order_ids: Set<string>;
  };
  const bMap = new Map<string, BVendor>();

  for (const l of lines) {
    const earns = dayEarns(l);
    const extras = n(l.payable?.extras_amount);
    if (!earns && n(l.ops_cost) + n(l.driver_fee) + n(l.rtr_amount) + extras === 0) continue;
    const billed = earns ? n(l.total_price) : 0;
    const external = l.is_external || !!l.external_vendor_id || !!l.external_car_id;

    if (!external) {
      // Internal car line.
      if (earns) internalOrderIds.add(l.order_id);
      const key = l.car_id ?? '__unassigned__';
      if (!aMap.has(key)) {
        aMap.set(key, {
          car_id: l.car_id,
          car_label: l.car
            ? l.car.model
            : l.car_id
              ? 'Unknown car'
              : 'Belum ada unit',
          plate: l.car?.plate_number ?? null,
          unit_code: l.car?.unit_code ?? null,
          final: { gross: 0, ops: 0, net_margin: 0, trips: 0, driver_fee: 0 },
          estimated: { gross: 0, ops: 0, net_margin: 0, trips: 0, driver_fee: 0 },
          final_margin_known: false,
          est_margin_known: false,
          final_order_ids: new Set(),
          est_order_ids: new Set(),
        });
      }
      const b = aMap.get(key)!;
      const slot = isFinal(l) ? b.final : b.estimated;
      const orderSlot = isFinal(l) ? b.final_order_ids : b.est_order_ids;
      slot.gross += billed;
      slot.ops += n(l.ops_cost);
      if (earns) {
        slot.trips += 1;
        orderSlot.add(l.order_id);
      }
      // Driver fee on this line, accrual basis (the day's fee, not the
      // payable total, which also holds reimbursed trip costs).
      slot.driver_fee += n(l.driver_fee) + extras;
      if (!earns) {
        // margin_amount still holds the day's price; a cancelled day only costs.
        slot.net_margin -= n(l.driver_fee) + n(l.ops_cost) + extras;
        b.final_margin_known = true;
      } else if (l.margin_amount != null) {
        slot.net_margin += n(l.margin_amount);
        if (isFinal(l)) b.final_margin_known = true;
        else b.est_margin_known = true;
      }
      // Section C — per internal driver fee.
      if (
        l.driver_id &&
        l.driver &&
        l.driver.type === 'INTERNAL' &&
        l.payable &&
        l.payable.kind === 'DRIVER'
      ) {
        const dkey = l.driver_id;
        if (!cMap.has(dkey)) {
          cMap.set(dkey, {
            driver_id: dkey,
            driver_name: l.driver.name,
            driver_phone: l.driver.phone,
            fee_paid: 0,
            fee_pending: 0,
            fee_total: 0,
            trips: 0,
            order_ids: new Set(),
          });
        }
        const d = cMap.get(dkey)!;
        const amt = n(l.driver_fee) + n(l.payable.extras_amount);
        d.fee_total += amt;
        if (l.payable.status === 'PAID') d.fee_paid += amt;
        else d.fee_pending += amt;
        if (earns) {
          d.trips += 1;
          d.order_ids.add(l.order_id);
        }
      }
    } else {
      // External / vendor line.
      if (earns) {
        if (l.external_vendor_id) vendorOrderIds.add(l.order_id);
        else freelanceOrderIds.add(l.order_id);
      }
      const vkey = l.external_vendor_id ?? '__freelance__';
      if (!bMap.has(vkey)) {
        bMap.set(vkey, {
          vendor_id: l.external_vendor_id,
          vendor_name: l.external_vendor?.name ?? 'Freelance (tanpa vendor)',
          final: { customer_billed: 0, vendor_cost: 0, arasya_margin: 0, trips: 0 },
          estimated: { customer_billed: 0, vendor_cost: 0, arasya_margin: 0, trips: 0 },
          units: new Map(),
          final_order_ids: new Set(),
          est_order_ids: new Set(),
        });
      }
      const v = bMap.get(vkey)!;
      const ukey = l.external_car_id ?? '__no_unit__';
      if (!v.units.has(ukey)) {
        v.units.set(ukey, {
          external_car_id: l.external_car_id,
          car_label: l.external_car?.model ?? 'Unit tidak tercatat',
          plate: l.external_car?.plate_number ?? null,
          final: { customer_billed: 0, vendor_cost: 0, arasya_margin: 0, trips: 0 },
          estimated: { customer_billed: 0, vendor_cost: 0, arasya_margin: 0, trips: 0 },
          final_order_ids: new Set(),
          est_order_ids: new Set(),
        });
      }
      const u = v.units.get(ukey)!;
      const vendorCost = n(l.rtr_amount) + n(l.ops_cost) + extras;
      const final = isFinal(l);
      const vSlot = final ? v.final : v.estimated;
      const uSlot = final ? u.final : u.estimated;
      const vOrdSlot = final ? v.final_order_ids : v.est_order_ids;
      const uOrdSlot = final ? u.final_order_ids : u.est_order_ids;
      vSlot.customer_billed += billed;
      vSlot.vendor_cost += vendorCost;
      vSlot.arasya_margin += billed - vendorCost;
      uSlot.customer_billed += billed;
      uSlot.vendor_cost += vendorCost;
      uSlot.arasya_margin += billed - vendorCost;
      if (earns) {
        vSlot.trips += 1;
        vOrdSlot.add(l.order_id);
        uSlot.trips += 1;
        uOrdSlot.add(l.order_id);
      }
    }
  }

  const round = (x: number) => Math.round(x * 100) / 100;
  const sectionA = Array.from(aMap.values())
    .map((b) => ({
      car_id: b.car_id,
      car_label: b.car_label,
      plate: b.plate,
      unit_code: b.unit_code,
      final: {
        gross: round(b.final.gross),
        ops: round(b.final.ops),
        net_margin: b.final_margin_known ? round(b.final.net_margin) : null,
        driver_fee: round(b.final.driver_fee),
        trips: b.final.trips,
        orders: b.final_order_ids.size,
      },
      estimated: {
        gross: round(b.estimated.gross),
        ops: round(b.estimated.ops),
        net_margin: b.est_margin_known ? round(b.estimated.net_margin) : null,
        driver_fee: round(b.estimated.driver_fee),
        trips: b.estimated.trips,
        orders: b.est_order_ids.size,
      },
    }))
    .sort((a, b) => b.final.gross + b.estimated.gross - (a.final.gross + a.estimated.gross));

  const sectionB = Array.from(bMap.values())
    .map((v) => ({
      vendor_id: v.vendor_id,
      vendor_name: v.vendor_name,
      final: {
        customer_billed: round(v.final.customer_billed),
        vendor_cost: round(v.final.vendor_cost),
        arasya_margin: round(v.final.arasya_margin),
        trips: v.final.trips,
        orders: v.final_order_ids.size,
      },
      estimated: {
        customer_billed: round(v.estimated.customer_billed),
        vendor_cost: round(v.estimated.vendor_cost),
        arasya_margin: round(v.estimated.arasya_margin),
        trips: v.estimated.trips,
        orders: v.est_order_ids.size,
      },
      units: Array.from(v.units.values()).map((u) => ({
        external_car_id: u.external_car_id,
        car_label: u.car_label,
        plate: u.plate,
        final: {
          customer_billed: round(u.final.customer_billed),
          vendor_cost: round(u.final.vendor_cost),
          arasya_margin: round(u.final.arasya_margin),
          trips: u.final.trips,
          orders: u.final_order_ids.size,
        },
        estimated: {
          customer_billed: round(u.estimated.customer_billed),
          vendor_cost: round(u.estimated.vendor_cost),
          arasya_margin: round(u.estimated.arasya_margin),
          trips: u.estimated.trips,
          orders: u.est_order_ids.size,
        },
      })),
    }))
    .sort(
      (a, b) =>
        b.final.arasya_margin + b.estimated.arasya_margin -
        (a.final.arasya_margin + a.estimated.arasya_margin),
    );

  // Roll-up totals.
  const sumA = (k: 'final' | 'estimated') =>
    sectionA.reduce(
      (acc, c) => ({
        gross: acc.gross + c[k].gross,
        ops: acc.ops + c[k].ops,
        net_margin: acc.net_margin + (c[k].net_margin ?? 0),
        driver_fee: acc.driver_fee + c[k].driver_fee,
        trips: acc.trips + c[k].trips,
        orders: acc.orders + c[k].orders,
      }),
      { gross: 0, ops: 0, net_margin: 0, driver_fee: 0, trips: 0, orders: 0 },
    );
  const sumB = (k: 'final' | 'estimated') =>
    sectionB.reduce(
      (acc, v) => ({
        customer_billed: acc.customer_billed + v[k].customer_billed,
        vendor_cost: acc.vendor_cost + v[k].vendor_cost,
        arasya_margin: acc.arasya_margin + v[k].arasya_margin,
        trips: acc.trips + v[k].trips,
        orders: acc.orders + v[k].orders,
      }),
      { customer_billed: 0, vendor_cost: 0, arasya_margin: 0, trips: 0, orders: 0 },
    );

  // Section C rows + totals.
  const sectionC = Array.from(cMap.values())
    .map((d) => ({
      driver_id: d.driver_id,
      driver_name: d.driver_name,
      driver_phone: d.driver_phone,
      fee_paid: round(d.fee_paid),
      fee_pending: round(d.fee_pending),
      fee_total: round(d.fee_total),
      trips: d.trips,
      orders: d.order_ids.size,
    }))
    .sort((a, b) => b.fee_total - a.fee_total);
  const cTotals = sectionC.reduce(
    (acc, d) => ({
      fee_paid: acc.fee_paid + d.fee_paid,
      fee_pending: acc.fee_pending + d.fee_pending,
      fee_total: acc.fee_total + d.fee_total,
      trips: acc.trips + d.trips,
      orders: acc.orders + d.orders,
    }),
    { fee_paid: 0, fee_pending: 0, fee_total: 0, trips: 0, orders: 0 },
  );

  const internalOrders = internalOrderIds.size;
  const vendorOrders = vendorOrderIds.size;
  const freelanceOrders = freelanceOrderIds.size;
  // Distinct unions so mixed orders (internal + external lines in one order)
  // are never double-counted. Per-channel counts can overlap; total must not.
  const externalUnion = new Set<string>([...vendorOrderIds, ...freelanceOrderIds]);
  const allUnion = new Set<string>([
    ...internalOrderIds,
    ...vendorOrderIds,
    ...freelanceOrderIds,
  ]);

  return {
    range: { from: start.toISOString(), to: end.toISOString() },
    order_counts: {
      internal: internalOrders,
      vendor: vendorOrders,
      freelance: freelanceOrders,
      external_total: externalUnion.size,
      total: allUnion.size,
    },
    internal_cars: {
      rows: sectionA,
      totals: { final: sumA('final'), estimated: sumA('estimated') },
    },
    vendor_margin: {
      rows: sectionB,
      totals: { final: sumB('final'), estimated: sumB('estimated') },
    },
    driver_fees: {
      rows: sectionC,
      totals: cTotals,
    },
    order_level: {
      extra_charges: round(orderLevel.extra_charges),
      cancellation_income: round(orderLevel.cancellation_income),
      pass_through: round(orderLevel.pass_through),
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard v2 — one-page owner/finance view
//
// Accounting rules (LOCKED — do not change without bumping the rule set):
// Rule set v2 (2026-10-06): extra charges, cancellation fees and the costs of
// cancelled days are in; the order card (rollupOrderFinance) uses the same rule.
// Rule set v3 (2026-10-07, finance A2): CASH counts refunds and OUTSTANDING
// uses Net (money received − refunded), the same `money` model as GET
// /orders/:id (order-money.ts); saldo lebih held for customers is shown on
// its own (customer_credit). ACCRUAL and the order card are unchanged, so
// MARGIN_FORMULA_VERSION is not bumped.
//
//   ACCRUAL
//     day_revenue   = Σ total_price of days in range (by service_date, WIB)
//                     whose day and order are not CANCELLED
//     extra_charges = Σ billable OrderAdjustment (amount × quantity) added in
//                     range (by created_at), except trip costs billed back at
//                     cost (linked to an Expense) → pass_through, which is
//                     neither revenue nor cost
//     cancellation_income = Σ over orders cancelled in range (cancelled_at) of
//                     cancellation_fee − day prices kept − all billable charges
//                     (the fee replaces what the cancelled days and charges
//                     would have earned)
//     revenue       = day_revenue + extra_charges + cancellation_income
//     ops_cost      = Σ OrderServiceItem.ops_cost        ┐ every day in range,
//     driver_cost   = Σ (driver_fee + payable extras)    │ cancelled ones too
//                     of internal days                   │ (a started trip keeps
//     vendor_cost   = Σ (rtr_amount + payable extras)    │ its fee / RTR; a day
//                     of partner days                    ┘ cancelled before it
//                     started has them zeroed)
//                     (not Payable.total_amount: a driver payable also holds
//                     reimbursed trip costs, already counted in ops_cost or
//                     passed on to the customer)
//     margin        = revenue − ops_cost − driver_cost − vendor_cost
//     margin_pct    = margin / revenue (null if revenue=0)
//     Revenue is the customer price, partner days included (decided 6 Oct 2026);
//     the partner's RTR is a cost, so the markup shows in the margin.
//
//   CASH (basis = payment_date / refunded_at / paid_at WIB in range)
//     collected     = Σ Receipt.amount        (any payment_method)
//     refunded      = Σ OrderRefund.amount    WHERE refunded_at∈range
//     paid_out      = Σ Payable.total_amount  WHERE status=PAID AND paid_at∈range
//     net_cash      = collected − refunded − paid_out
//     (saldo lebih used on an invoice is not cash: it moves nothing)
//
//   OUTSTANDING (current snapshot; NOT period-scoped)
//     ar_outstanding = Σ (Order.final_price − (paid_to_date − refunded_total)) > 0
//                      WHERE payment_status≠PAID (a cancelled order's
//                      final_price is its fee, so an unpaid fee is owed)
//     customer_credit = Σ Order.credit_balance (saldo lebih: money held for
//                      customers, to use on their next bill or refund)
//     ap_outstanding = Σ Payable.total_amount WHERE status=UNPAID
//
//     Overdue rule (Arasya: due day-1 of service):
//       ar overdue = AR rows where MIN(service_items.service_date) ≤ today (WIB);
//                    a cancellation fee is due from the cancellation date
//       ap overdue = Payable rows where service_date ≤ today (WIB)
//
//   Δ vs prior period = same calc over a window of identical length placed
//     immediately before the current window. Returns null when prior=0.
//
// All money in IDR (no FX). Decimal coerced to number via n() everywhere.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS = 86400000;

// "Today" in WIB as a UTC Date for service_date comparison.
function wibTodayEnd(): Date {
  const nowWib = new Date(Date.now() + WIB_OFFSET_MS);
  const y = nowWib.getUTCFullYear();
  const m = nowWib.getUTCMonth();
  const d = nowWib.getUTCDate();
  // End of today WIB = next day 00:00 WIB − 1ms, expressed in UTC.
  return new Date(Date.UTC(y, m, d + 1, 0, 0, 0) - WIB_OFFSET_MS - 1);
}

function pct(part: number, whole: number): number | null {
  if (whole === 0) return null;
  return part / whole;
}

function delta(curr: number, prev: number): number | null {
  if (prev === 0) return null;
  return (curr - prev) / Math.abs(prev);
}

interface AccrualSlice extends OrderLevelSlice {
  revenue: number;
  day_revenue: number;
  ops_cost: number;
  driver_cost: number;
  vendor_cost: number;
  margin: number;
  margin_pct: number | null;
  trips: number;
}

interface OrderLevelSlice {
  extra_charges: number;
  cancellation_income: number;
  pass_through: number;
}

// A day earns its price unless it, or its whole order, was cancelled.
const dayEarns = (l: { line_status: string; order: { order_status: string } | null }) =>
  l.line_status !== 'CANCELLED' && l.order?.order_status !== 'CANCELLED';

// Order-level income has no unit; it goes to the vendor side only when every
// day of the order went to a partner.
const orderChannel = (days: { is_external: boolean }[]): 'internal' | 'vendor' =>
  days.length > 0 && days.every((d) => d.is_external) ? 'vendor' : 'internal';

// Income that belongs to an order, not to one day (rules in the header):
// extra charges by the date they were added (a later day edit never moves
// them to another month), cancellation fees by the cancellation date.
async function orderLevelSlice(
  start: Date,
  end: Date,
): Promise<OrderLevelSlice & { by_channel: Record<'internal' | 'vendor', number> }> {
  const [charges, cancelled] = await Promise.all([
    prisma.orderAdjustment.findMany({
      where: { is_billable: true, created_at: { gte: start, lte: end } },
      select: {
        amount: true,
        quantity: true,
        expense: { select: { id: true } },
        order: { select: { service_items: { select: { is_external: true } } } },
      },
    }),
    prisma.order.findMany({
      where: { cancellation_fee: { not: null }, cancelled_at: { gte: start, lte: end } },
      select: {
        order_status: true,
        cancellation_fee: true,
        service_items: {
          select: { line_status: true, total_price: true, is_external: true },
        },
        adjustments: {
          where: { is_billable: true },
          select: { amount: true, quantity: true },
        },
      },
    }),
  ]);
  const out = {
    extra_charges: 0,
    cancellation_income: 0,
    pass_through: 0,
    by_channel: { internal: 0, vendor: 0 },
  };
  for (const a of charges) {
    const amt = n(a.amount) * (a.quantity ?? 1);
    // A trip cost billed back at cost: the customer repays it, Arasya (or the
    // driver) paid it, so it is neither income nor margin.
    if (a.expense) {
      out.pass_through += amt;
      continue;
    }
    out.extra_charges += amt;
    out.by_channel[orderChannel(a.order.service_items)] += amt;
  }
  for (const o of cancelled) {
    const kept = o.service_items
      .filter((l) => dayEarns({ line_status: l.line_status, order: o }))
      .reduce((s, l) => s + n(l.total_price), 0);
    const charged = o.adjustments.reduce((s, a) => s + n(a.amount) * (a.quantity ?? 1), 0);
    const income = n(o.cancellation_fee) - kept - charged;
    out.cancellation_income += income;
    out.by_channel[orderChannel(o.service_items)] += income;
  }
  return out;
}

type OrderLevel = Awaited<ReturnType<typeof orderLevelSlice>>;

// `orderLevel` may be passed in when the caller already computed it for the
// same range (dashboardV2 shares one with channelSplit).
async function accrualSlice(
  start: Date,
  end: Date,
  orderLevelP: Promise<OrderLevel> = orderLevelSlice(start, end),
): Promise<AccrualSlice> {
  const [lines, orderLevel] = await Promise.all([
    prisma.orderServiceItem.findMany({
      where: { service_date: { gte: start, lte: end } },
      select: {
        total_price: true,
        ops_cost: true,
        driver_fee: true,
        rtr_amount: true,
        is_external: true,
        line_status: true,
        order: { select: { order_status: true } },
        payable: { select: { extras_amount: true } },
      },
    }),
    orderLevelP,
  ]);
  // Same rule as the order card (margin v5): revenue − driver fees − RTR −
  // Arasya's share of the approved trip costs. Payables are not used here:
  // a driver payable also carries reimbursed trip costs (already in ops_cost).
  // A cancelled day earns nothing but keeps what it cost.
  let day_revenue = 0;
  let trips = 0;
  let ops_cost = 0;
  let driver_cost = 0;
  let vendor_cost = 0;
  for (const l of lines) {
    if (dayEarns(l)) {
      day_revenue += n(l.total_price);
      trips += 1;
    }
    ops_cost += n(l.ops_cost);
    const extras = n(l.payable?.extras_amount);
    if (l.is_external) vendor_cost += n(l.rtr_amount) + extras;
    else driver_cost += n(l.driver_fee) + extras;
  }
  const { extra_charges, cancellation_income, pass_through } = orderLevel;
  const revenue = day_revenue + extra_charges + cancellation_income;
  const margin = revenue - ops_cost - driver_cost - vendor_cost;
  return {
    revenue,
    day_revenue,
    extra_charges,
    cancellation_income,
    pass_through,
    ops_cost,
    driver_cost,
    vendor_cost,
    margin,
    margin_pct: pct(margin, revenue),
    trips,
  };
}

async function cashSlice(start: Date, end: Date) {
  const [receipts, refunds, settledPayables] = await Promise.all([
    prisma.receipt.aggregate({
      _sum: { amount: true },
      where: { payment_date: { gte: start, lte: end } },
    }),
    prisma.orderRefund.aggregate({
      _sum: { amount: true },
      where: { refunded_at: { gte: start, lte: end } },
    }),
    prisma.payable.aggregate({
      _sum: { total_amount: true },
      where: { status: 'PAID', paid_at: { gte: start, lte: end } },
    }),
  ]);
  const collected = n(receipts._sum.amount);
  const refunded = n(refunds._sum.amount);
  const paid_out = n(settledPayables._sum.total_amount);
  return { collected, refunded, paid_out, net_cash: collected - refunded - paid_out };
}

// Per-channel accrual (internal vs vendor) for the Channel Split panel.
async function channelSplit(
  start: Date,
  end: Date,
  orderLevelP: Promise<OrderLevel> = orderLevelSlice(start, end),
) {
  const [lines, orderLevel] = await Promise.all([
    prisma.orderServiceItem.findMany({
      where: { service_date: { gte: start, lte: end } },
      select: {
        total_price: true,
        ops_cost: true,
        is_external: true,
        driver_fee: true,
        rtr_amount: true,
        line_status: true,
        order: { select: { order_status: true } },
        payable: { select: { extras_amount: true } },
      },
    }),
    orderLevelP,
  ]);
  const internal = { revenue: 0, ops_cost: 0, driver_cost: 0, margin: 0, trips: 0 };
  const vendor = { billed: 0, vendor_cost: 0, margin: 0, trips: 0 };
  for (const l of lines) {
    const earns = dayEarns(l);
    const price = earns ? n(l.total_price) : 0;
    if (l.is_external) {
      vendor.billed += price;
      vendor.vendor_cost +=
        n(l.rtr_amount) + n(l.ops_cost) + n(l.payable?.extras_amount);
      if (earns) vendor.trips += 1;
    } else {
      internal.revenue += price;
      internal.ops_cost += n(l.ops_cost);
      internal.driver_cost += n(l.driver_fee) + n(l.payable?.extras_amount);
      if (earns) internal.trips += 1;
    }
  }
  // Extra charges and cancellation fees, so the two cards add up to Revenue.
  internal.revenue += orderLevel.by_channel.internal;
  vendor.billed += orderLevel.by_channel.vendor;
  internal.margin = internal.revenue - internal.ops_cost - internal.driver_cost;
  vendor.margin = vendor.billed - vendor.vendor_cost;
  return {
    internal: { ...internal, margin_pct: pct(internal.margin, internal.revenue) },
    vendor: { ...vendor, margin_pct: pct(vendor.margin, vendor.billed) },
  };
}

// Current outstanding snapshot + overdue detail (top 5 each by amount).
async function outstandingSnapshot() {
  const today = wibTodayEnd();

  // AR: orders not paid in full. A cancelled order's final_price is its
  // cancellation fee, so an unpaid fee is owed too.
  const arOrders = await prisma.order.findMany({
    where: {
      payment_status: { not: 'PAID' },
    },
    select: {
      id: true,
      order_code: true,
      customer_name: true,
      final_price: true,
      paid_to_date: true,
      refunded_total: true,
      order_date: true,
      cancelled_at: true,
      service_items: {
        select: { service_date: true },
        orderBy: { service_date: 'asc' },
        take: 1,
      },
    },
  });
  let ar_outstanding = 0;
  type AROverdue = {
    id: string; order_code: string | null; customer: string;
    amount: number; service_date: string | null; days_overdue: number;
  };
  const arOverdue: AROverdue[] = [];
  for (const o of arOrders) {
    // Piutang on Net: money refunded is owed again.
    const due = n(o.final_price) - (n(o.paid_to_date) - n(o.refunded_total));
    if (due <= 0) continue;
    ar_outstanding += due;
    // Earliest service line determines the due date (Arasya: due day-1); a
    // cancellation fee is due from the cancellation.
    const sd = o.service_items[0]?.service_date ?? null;
    const ref = o.cancelled_at ?? sd ?? o.order_date;
    if (ref && ref <= today) {
      arOverdue.push({
        id: o.id,
        order_code: o.order_code,
        customer: o.customer_name,
        amount: due,
        service_date: sd ? sd.toISOString() : null,
        days_overdue: Math.max(0, Math.floor((today.getTime() - ref.getTime()) / DAY_MS)),
      });
    }
  }
  arOverdue.sort((a, b) => b.amount * (b.days_overdue + 1) - a.amount * (a.days_overdue + 1));

  // AP: payables unsettled.
  const apPayables = await prisma.payable.findMany({
    where: { status: 'UNPAID' },
    select: {
      id: true,
      kind: true,
      service_date: true,
      total_amount: true,
      order: { select: { id: true, order_code: true } },
      driver: { select: { name: true } },
      vendor: { select: { name: true } },
    },
  });
  let ap_outstanding = 0;
  type APOverdue = {
    id: string; kind: 'DRIVER' | 'VENDOR'; counterparty: string;
    amount: number; service_date: string | null; days_overdue: number;
    order_id: string | null; order_code: string | null;
  };
  const apOverdue: APOverdue[] = [];
  for (const p of apPayables) {
    const amt = n(p.total_amount);
    ap_outstanding += amt;
    if (p.service_date && p.service_date <= today) {
      apOverdue.push({
        id: p.id,
        kind: p.kind,
        counterparty:
          p.kind === 'DRIVER'
            ? p.driver?.name ?? 'Driver'
            : p.vendor?.name ?? 'Vendor',
        amount: amt,
        service_date: p.service_date.toISOString(),
        days_overdue: Math.max(0, Math.floor((today.getTime() - p.service_date.getTime()) / DAY_MS)),
        order_id: p.order?.id ?? null,
        order_code: p.order?.order_code ?? null,
      });
    }
  }
  apOverdue.sort((a, b) => b.amount * (b.days_overdue + 1) - a.amount * (a.days_overdue + 1));

  // Saldo lebih held for customers (not piutang, not revenue).
  const credit = await prisma.order.aggregate({ _sum: { credit_balance: true } });

  return {
    ar_outstanding,
    customer_credit: n(credit._sum.credit_balance),
    ap_outstanding,
    ar_overdue_count: arOverdue.length,
    ap_overdue_count: apOverdue.length,
    ar_overdue_top: arOverdue.slice(0, 5),
    ap_overdue_top: apOverdue.slice(0, 5),
  };
}

// Trailing 6 months ending at the period's end month (revenue bar + margin line).
async function trailing6mTrend(periodEnd: Date) {
  const endWib = new Date(periodEnd.getTime() + WIB_OFFSET_MS);
  const refY = endWib.getUTCFullYear();
  const refM = endWib.getUTCMonth();
  const months: { label: string; start: Date; end: Date }[] = [];
  for (let i = 5; i >= 0; i--) {
    const y = refY;
    const m = refM - i;
    const start = new Date(Date.UTC(y, m, 1, 0, 0, 0) - WIB_OFFSET_MS);
    const end = new Date(Date.UTC(y, m + 1, 1, 0, 0, 0) - WIB_OFFSET_MS - 1);
    const label = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7); // YYYY-MM
    months.push({ label, start, end });
  }
  const points = await Promise.all(
    months.map(async (mo) => {
      const a = await accrualSlice(mo.start, mo.end);
      return {
        month: mo.label,
        revenue: a.revenue,
        margin: a.margin,
        margin_pct: a.margin_pct,
      };
    }),
  );
  return points;
}

export async function dashboardV2(opts: RangeOpts = {}) {
  const { start, end } = wibMonthBounds(opts.date_from, opts.date_to);

  // Prior period = same length immediately before [start, end].
  const len = end.getTime() - start.getTime();
  const priorEnd = new Date(start.getTime() - 1);
  const priorStart = new Date(priorEnd.getTime() - len);

  // One order-level slice for the current range, shared by both users.
  const orderLevelCurr = orderLevelSlice(start, end);
  const [accCurr, accPrev, cashCurr, cashPrev, channel, outstanding, trend] =
    await Promise.all([
      accrualSlice(start, end, orderLevelCurr),
      accrualSlice(priorStart, priorEnd),
      cashSlice(start, end),
      cashSlice(priorStart, priorEnd),
      channelSplit(start, end, orderLevelCurr),
      outstandingSnapshot(),
      trailing6mTrend(end),
    ]);

  return {
    range: {
      date_from: start.toISOString(),
      date_to: end.toISOString(),
      prior_from: priorStart.toISOString(),
      prior_to: priorEnd.toISOString(),
    },
    accrual: {
      ...accCurr,
      delta: {
        revenue: delta(accCurr.revenue, accPrev.revenue),
        margin: delta(accCurr.margin, accPrev.margin),
        ops_cost: delta(accCurr.ops_cost, accPrev.ops_cost),
      },
      prior: accPrev,
    },
    cash: {
      ...cashCurr,
      delta: { net_cash: delta(cashCurr.net_cash, cashPrev.net_cash) },
      prior: cashPrev,
    },
    channel,
    outstanding,
    trend, // trailing 6 months (revenue + margin)
  };
}
