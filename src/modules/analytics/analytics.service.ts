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

  // Billable adjustments per order (pure-markup revenue/margin), so the
  // order-level margin here matches OrderFinalFinance after rollup.
  const adjustmentRows = await prisma.orderAdjustment.findMany({
    where: { is_billable: true, order: { order_status: { not: 'CANCELLED' } } },
    select: { order_id: true, amount: true, quantity: true },
  });
  const adjByOrder = new Map<string, number>();
  for (const a of adjustmentRows) {
    adjByOrder.set(
      a.order_id,
      (adjByOrder.get(a.order_id) ?? 0) + n(a.amount) * (a.quantity ?? 1),
    );
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
    const adj = adjByOrder.get(oid) ?? 0;
    const revenue = v.revenue + adj;
    const margin = v.margin + adj;
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
interface RevenueOpts {
  date_from?: string;
  date_to?: string;
}

export async function revenueReport(opts: RevenueOpts = {}) {
  const { start, end } = wibMonthBounds(opts.date_from, opts.date_to);

  const lines = await prisma.orderServiceItem.findMany({
    where: {
      service_date: { gte: start, lte: end },
      order: { order_status: { not: 'CANCELLED' } },
      line_status: { not: 'CANCELLED' },
    },
    select: {
      id: true,
      total_price: true,
      ops_cost: true,
      margin_amount: true,
      rtr_amount: true,
      line_status: true,
      is_external: true,
      car_id: true,
      car: { select: { id: true, model: true, plate_number: true, unit_code: true } },
      external_vendor_id: true,
      external_vendor: { select: { id: true, name: true } },
      external_car_id: true,
      external_car: { select: { id: true, model: true, plate_number: true } },
      order: { select: { order_status: true } },
      payable: { select: { kind: true, total_amount: true } },
    },
  });

  const isFinal = (l: (typeof lines)[number]) =>
    l.order?.order_status === 'DONE' || l.line_status === 'DONE';

  // ── Section A — internal cars, GROUP BY car_id ──────────────────────────────
  type ABucket = {
    car_id: string | null;
    car_label: string;
    plate: string | null;
    unit_code: string | null;
    final: { gross: number; ops: number; net_margin: number; trips: number };
    estimated: { gross: number; ops: number; net_margin: number; trips: number };
    // null-margin tracking so we can show "—" instead of a misleading 0.
    final_margin_known: boolean;
    est_margin_known: boolean;
  };
  const aMap = new Map<string, ABucket>();

  // ── Section B — vendor margin, GROUP BY vendor -> external_car ───────────────
  type BUnit = {
    external_car_id: string | null;
    car_label: string;
    plate: string | null;
    final: { customer_billed: number; vendor_cost: number; arasya_margin: number; trips: number };
    estimated: { customer_billed: number; vendor_cost: number; arasya_margin: number; trips: number };
  };
  type BVendor = {
    vendor_id: string | null;
    vendor_name: string;
    final: { customer_billed: number; vendor_cost: number; arasya_margin: number; trips: number };
    estimated: { customer_billed: number; vendor_cost: number; arasya_margin: number; trips: number };
    units: Map<string, BUnit>;
  };
  const bMap = new Map<string, BVendor>();

  for (const l of lines) {
    const billed = n(l.total_price);
    const external = l.is_external || !!l.external_vendor_id || !!l.external_car_id;

    if (!external) {
      // Internal car line.
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
          final: { gross: 0, ops: 0, net_margin: 0, trips: 0 },
          estimated: { gross: 0, ops: 0, net_margin: 0, trips: 0 },
          final_margin_known: false,
          est_margin_known: false,
        });
      }
      const b = aMap.get(key)!;
      const slot = isFinal(l) ? b.final : b.estimated;
      slot.gross += billed;
      slot.ops += n(l.ops_cost);
      slot.trips += 1;
      if (l.margin_amount != null) {
        slot.net_margin += n(l.margin_amount);
        if (isFinal(l)) b.final_margin_known = true;
        else b.est_margin_known = true;
      }
    } else {
      // External / vendor line.
      const vkey = l.external_vendor_id ?? '__freelance__';
      if (!bMap.has(vkey)) {
        bMap.set(vkey, {
          vendor_id: l.external_vendor_id,
          vendor_name: l.external_vendor?.name ?? 'Freelance (tanpa vendor)',
          final: { customer_billed: 0, vendor_cost: 0, arasya_margin: 0, trips: 0 },
          estimated: { customer_billed: 0, vendor_cost: 0, arasya_margin: 0, trips: 0 },
          units: new Map(),
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
        });
      }
      const u = v.units.get(ukey)!;
      const vendorCost =
        l.payable && l.payable.kind === 'VENDOR' ? n(l.payable.total_amount) : 0;
      const final = isFinal(l);
      const vSlot = final ? v.final : v.estimated;
      const uSlot = final ? u.final : u.estimated;
      vSlot.customer_billed += billed;
      vSlot.vendor_cost += vendorCost;
      vSlot.arasya_margin += billed - vendorCost;
      vSlot.trips += 1;
      uSlot.customer_billed += billed;
      uSlot.vendor_cost += vendorCost;
      uSlot.arasya_margin += billed - vendorCost;
      uSlot.trips += 1;
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
        trips: b.final.trips,
      },
      estimated: {
        gross: round(b.estimated.gross),
        ops: round(b.estimated.ops),
        net_margin: b.est_margin_known ? round(b.estimated.net_margin) : null,
        trips: b.estimated.trips,
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
      },
      estimated: {
        customer_billed: round(v.estimated.customer_billed),
        vendor_cost: round(v.estimated.vendor_cost),
        arasya_margin: round(v.estimated.arasya_margin),
        trips: v.estimated.trips,
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
        },
        estimated: {
          customer_billed: round(u.estimated.customer_billed),
          vendor_cost: round(u.estimated.vendor_cost),
          arasya_margin: round(u.estimated.arasya_margin),
          trips: u.estimated.trips,
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
        trips: acc.trips + c[k].trips,
      }),
      { gross: 0, ops: 0, net_margin: 0, trips: 0 },
    );
  const sumB = (k: 'final' | 'estimated') =>
    sectionB.reduce(
      (acc, v) => ({
        customer_billed: acc.customer_billed + v[k].customer_billed,
        vendor_cost: acc.vendor_cost + v[k].vendor_cost,
        arasya_margin: acc.arasya_margin + v[k].arasya_margin,
        trips: acc.trips + v[k].trips,
      }),
      { customer_billed: 0, vendor_cost: 0, arasya_margin: 0, trips: 0 },
    );

  return {
    range: { from: start.toISOString(), to: end.toISOString() },
    internal_cars: {
      rows: sectionA,
      totals: { final: sumA('final'), estimated: sumA('estimated') },
    },
    vendor_margin: {
      rows: sectionB,
      totals: { final: sumB('final'), estimated: sumB('estimated') },
    },
  };
}
