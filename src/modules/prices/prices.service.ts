import { PriceCar, PriceExtra, PricePublication, PriceRate, PriceSurcharge, Prisma } from "@prisma/client";
import prisma from "../../prisma/client";
import { env } from "../../config/env";
import { logger } from "../../config/logger";
import { AppError } from "../../utils/AppError";
import type {
  CreateCarInput,
  CreateSurchargeInput,
  DeleteSurchargeInput,
  PublishInput,
  RateUpdate,
  UpdateCarInput,
  UpdateCityInput,
  UpdateExtraInput,
  UpdateSurchargeInput,
  UpdateZoneInput,
} from "./prices.validation";

/**
 * Official price list (2026-10-06). The dashboard edits a working copy: cars
 * (the website fleet), tables (zones: a package in an area), rates, area
 * surcharges, which tables each website city page shows, and driver costs.
 * Every change is logged, one row per field. "Terbitkan" freezes the working
 * copy into a snapshot (PricePublication) and calls the website's deploy hook;
 * the website build reads the latest snapshot from GET /public/prices, so a
 * half-edited table never reaches visitors.
 *
 * Every write and every publish take the same advisory lock, so they run one
 * after the other: a snapshot holds a change completely or not at all, and
 * "unpublished changes" (logs newer than the last publication) is exact.
 *
 * Every row in GET /prices carries updated_at. A write that sends it back as
 * expected_updated_at is refused (409) when the row changed since the page
 * was loaded, so a stale page never silently overwrites a newer price.
 */

type Tx = Prisma.TransactionClient;
type Entity = "rate" | "surcharge" | "extra" | "zone" | "city" | "car";

// Duration order in the snapshot and the history labels.
const DURATIONS = ["12H", "FULLDAY", "DROP"];
const DURATION_LABEL: Record<string, string> = { "12H": "12 jam", FULLDAY: "Fullday", DROP: "Drop" };
// Drop tables price one trip ("DROP"); the others 12 hours and Fullday.
const isDropZone = (code: string) => code.startsWith("DROP");
const durationsFor = (zoneCode: string) => (isDropZone(zoneCode) ? ["DROP"] : ["12H", "FULLDAY"]);

const num = (v: Prisma.Decimal | null) => (v == null ? null : Number(v));
const isUniqueViolation = (err: unknown) =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
const rank = (duration: string) => {
  const i = DURATIONS.indexOf(duration);
  return i < 0 ? DURATIONS.length : i;
};

/**
 * Every price list transaction: about ten serial round trips (~1s each over
 * the Supabase pooler) plus the wait for the advisory lock while another save
 * holds it, so Prisma's default 5s limit is not enough.
 */
const PRICE_TX = { maxWait: 15000, timeout: 30000 };

/**
 * Inside a transaction, before reading anything it changes. Returns the time
 * of this write: the timestamp of its change logs (or the publication) and
 * the updated_at of the rows it changes. It is set here, in lock order, and
 * is always later than every earlier log and publication (at least 1 ms, even
 * within one millisecond or when the clock steps back), so "logs newer than
 * the last publication" counts exactly the changes it does not hold.
 */
async function lockPriceList(tx: Tx): Promise<Date> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('price_list'))`;
  const log = await tx.priceChangeLog.aggregate({ _max: { created_at: true } });
  const pub = await tx.pricePublication.aggregate({ _max: { created_at: true } });
  const latest = Math.max(log._max.created_at?.getTime() ?? 0, pub._max.created_at?.getTime() ?? 0);
  return new Date(Math.max(Date.now(), latest + 1));
}

const CONFLICT_MESSAGE = "Harga ini sudah diubah admin lain. Muat ulang halaman lalu ulangi.";
/** The row changed after the admin's page loaded it (millisecond precision). */
const isStale = (row: { updated_at: Date }, expected: string | undefined) =>
  expected !== undefined && row.updated_at.getTime() !== new Date(expected).getTime();
const conflict = (ids: string[]) => new AppError(CONFLICT_MESSAGE, 409, { conflict_ids: ids });

// How a value is written in the change log: rupiah as plain numbers.
const logValue = (v: unknown): string | null =>
  v == null ? null : Prisma.Decimal.isDecimal(v) ? String(Number(v)) : String(v);

/** The fields of `data` that really differ from `row`, and one log row per field. */
function changes<D extends Record<string, unknown>>(
  entity: Entity,
  row: { id: string } & Record<string, unknown>,
  data: D,
  adminId: string,
  at: Date,
) {
  const changed: Partial<D> = {};
  const logs: Prisma.PriceChangeLogCreateManyInput[] = [];
  for (const field of Object.keys(data) as (keyof D & string)[]) {
    const value = data[field];
    if (value === undefined) continue;
    const before = logValue(row[field]);
    const after = logValue(value);
    if (before === after) continue;
    changed[field] = value;
    logs.push({ entity, entity_id: row.id, field, old_value: before, new_value: after, changed_by: adminId, created_at: at });
  }
  return { changed, logs };
}

/** A whole row added or removed, e.g. an area surcharge. */
const rowLog = (entity: Entity, id: string, kind: "created" | "deleted", text: string, adminId: string, at: Date) => ({
  entity,
  entity_id: id,
  field: kind,
  old_value: kind === "deleted" ? text : null,
  new_value: kind === "created" ? text : null,
  changed_by: adminId,
  created_at: at,
});

// ── Shapes returned to the dashboard ────────────────────────────────────────
function toRate(r: PriceRate) {
  return {
    id: r.id,
    car_id: r.car_id,
    duration: r.duration,
    amount: num(r.amount),
    is_proposal: r.is_proposal,
    note: r.note,
    updated_by: r.updated_by,
    updated_at: r.updated_at,
  };
}

function toSurcharge(s: PriceSurcharge) {
  return {
    id: s.id,
    zone_id: s.zone_id,
    area: s.area,
    amount: Number(s.amount),
    sort_order: s.sort_order,
    updated_by: s.updated_by,
    updated_at: s.updated_at,
  };
}

function toExtra(e: PriceExtra) {
  return {
    id: e.id,
    code: e.code,
    label: e.label,
    amount: num(e.amount),
    percent: num(e.percent),
    unit: e.unit,
    note: e.note,
    updated_by: e.updated_by,
    updated_at: e.updated_at,
  };
}

const publicationSelect = {
  id: true,
  created_at: true,
  published_by: true,
  note: true,
  deploy_status: true,
} satisfies Prisma.PricePublicationSelect;

const lastPublication = () =>
  prisma.pricePublication.findFirst({ select: publicationSelect, orderBy: { created_at: "desc" } });

/** Admin id → email, for "who changed it". */
async function userEmails(ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((v): v is string => !!v))];
  if (!unique.length) return {};
  const users = await prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, email: true } });
  return Object.fromEntries(users.map((u) => [u.id, u.email]));
}

/** The whole working copy, what every write returns too. */
export async function getPriceList() {
  const [cars, zones, cities, extras, last] = await Promise.all([
    prisma.priceCar.findMany({ orderBy: [{ sort_order: "asc" }, { name: "asc" }] }),
    prisma.priceZone.findMany({
      include: {
        rates: { orderBy: [{ car: { sort_order: "asc" } }, { duration: "asc" }] },
        surcharges: { orderBy: [{ sort_order: "asc" }, { area: "asc" }] },
      },
      orderBy: [{ sort_order: "asc" }, { code: "asc" }],
    }),
    prisma.priceCity.findMany({ orderBy: [{ sort_order: "asc" }, { name: "asc" }] }),
    prisma.priceExtra.findMany({ orderBy: { code: "asc" } }),
    lastPublication(),
  ]);
  const unpublished = await prisma.priceChangeLog.count({
    where: last ? { created_at: { gt: last.created_at } } : {},
  });
  const adminIds: (string | null)[] = [last?.published_by ?? null];
  for (const z of zones) {
    for (const r of z.rates) adminIds.push(r.updated_by);
    for (const s of z.surcharges) adminIds.push(s.updated_by);
  }
  for (const e of extras) adminIds.push(e.updated_by);
  return {
    cars,
    zones: zones.map(({ rates, surcharges, ...z }) => ({
      ...z,
      rates: rates.map(toRate),
      surcharges: surcharges.map(toSurcharge),
    })),
    cities,
    extras: extras.map(toExtra),
    last_publication: last,
    unpublished_changes: unpublished,
    // Rates not confirmed by the owner yet; publishing them needs confirm_proposals.
    proposal_count: zones.reduce((n, z) => n + z.rates.filter((r) => r.is_proposal).length, 0),
    users: await userEmails(adminIds),
  };
}

// ── Rates ───────────────────────────────────────────────────────────────────
/** "Simpan" on the price table: each rate the admin sent, unchanged ones skipped. */
export async function updateRates(items: RateUpdate[], adminId: string) {
  await prisma.$transaction(
    async (tx) => {
      const at = await lockPriceList(tx);
      const rows = await tx.priceRate.findMany({ where: { id: { in: items.map((i) => i.id) } } });
      const byId = new Map(rows.map((r) => [r.id, r]));
      if (items.some((i) => !byId.has(i.id))) throw new AppError("Tarif tidak ditemukan", 404);
      const stale = items.filter((i) => isStale(byId.get(i.id)!, i.expected_updated_at)).map((i) => i.id);
      if (stale.length) throw conflict(stale);
      const logs: Prisma.PriceChangeLogCreateManyInput[] = [];
      for (const { id, expected_updated_at: _expected, ...data } of items) {
        const c = changes("rate", byId.get(id)!, data, adminId, at);
        if (!c.logs.length) continue;
        await tx.priceRate.update({ where: { id }, data: { ...c.changed, updated_by: adminId, updated_at: at } });
        logs.push(...c.logs);
      }
      if (logs.length) await tx.priceChangeLog.createMany({ data: logs });
    },
    // Up to 200 rates in one save.
    PRICE_TX,
  );
  return getPriceList();
}

// ── Area surcharges ─────────────────────────────────────────────────────────
const surchargeText = (s: { area: string; amount: Prisma.Decimal | number }) => `${s.area}: ${Number(s.amount)}`;

/** One area per table, whatever the capitalisation ("Bekasi" = "bekasi"). */
async function assertAreaFree(tx: Tx, zoneId: string, area: string, exceptId?: string) {
  const other = await tx.priceSurcharge.findFirst({
    where: { zone_id: zoneId, area: { equals: area, mode: "insensitive" }, ...(exceptId ? { id: { not: exceptId } } : {}) },
  });
  if (other) throw new AppError(`Area ${other.area} sudah ada di tabel ini`, 409);
}

const duplicateArea = (area?: string) => new AppError(`Area ${area ?? "ini"} sudah ada di tabel ini`, 409);

export async function createSurcharge(input: CreateSurchargeInput, adminId: string) {
  try {
    await prisma.$transaction(async (tx) => {
      const at = await lockPriceList(tx);
      if (!(await tx.priceZone.findUnique({ where: { id: input.zone_id } }))) {
        throw new AppError("Tabel harga tidak ditemukan", 404);
      }
      await assertAreaFree(tx, input.zone_id, input.area);
      const last = await tx.priceSurcharge.aggregate({ where: { zone_id: input.zone_id }, _max: { sort_order: true } });
      const s = await tx.priceSurcharge.create({
        data: {
          zone_id: input.zone_id,
          area: input.area,
          amount: input.amount,
          sort_order: input.sort_order ?? (last._max.sort_order ?? -1) + 1,
          updated_by: adminId,
        },
      });
      await tx.priceChangeLog.create({ data: rowLog("surcharge", s.id, "created", surchargeText(s), adminId, at) });
    }, PRICE_TX);
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicateArea(input.area);
    throw err;
  }
  return getPriceList();
}

export async function updateSurcharge(id: string, input: UpdateSurchargeInput, adminId: string) {
  const { expected_updated_at, ...data } = input;
  try {
    await prisma.$transaction(async (tx) => {
      const at = await lockPriceList(tx);
      const s = await tx.priceSurcharge.findUnique({ where: { id } });
      if (!s) throw new AppError("Tambahan area tidak ditemukan", 404);
      if (isStale(s, expected_updated_at)) throw conflict([id]);
      if (data.area) await assertAreaFree(tx, s.zone_id, data.area, id);
      const c = changes("surcharge", s, data, adminId, at);
      if (!c.logs.length) return;
      await tx.priceSurcharge.update({ where: { id }, data: { ...c.changed, updated_by: adminId, updated_at: at } });
      await tx.priceChangeLog.createMany({ data: c.logs });
    }, PRICE_TX);
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicateArea(input.area);
    throw err;
  }
  return getPriceList();
}

/** Removed for good; the log keeps what it was. */
export async function deleteSurcharge(id: string, input: DeleteSurchargeInput, adminId: string) {
  await prisma.$transaction(async (tx) => {
    const at = await lockPriceList(tx);
    const s = await tx.priceSurcharge.findUnique({ where: { id } });
    if (!s) throw new AppError("Tambahan area tidak ditemukan", 404);
    if (isStale(s, input.expected_updated_at)) throw conflict([id]);
    await tx.priceSurcharge.delete({ where: { id } });
    await tx.priceChangeLog.create({ data: rowLog("surcharge", id, "deleted", surchargeText(s), adminId, at) });
  }, PRICE_TX);
  return getPriceList();
}

// ── Tables, driver costs, cities, cars ──────────────────────────────────────
export async function updateZone(id: string, input: UpdateZoneInput, adminId: string) {
  const { expected_updated_at, ...data } = input;
  await prisma.$transaction(async (tx) => {
    const at = await lockPriceList(tx);
    const zone = await tx.priceZone.findUnique({ where: { id } });
    if (!zone) throw new AppError("Tabel harga tidak ditemukan", 404);
    if (isStale(zone, expected_updated_at)) throw conflict([id]);
    const c = changes("zone", zone, data, adminId, at);
    if (!c.logs.length) return;
    await tx.priceZone.update({ where: { id }, data: { ...c.changed, updated_at: at } });
    await tx.priceChangeLog.createMany({ data: c.logs });
  }, PRICE_TX);
  return getPriceList();
}

export async function updateExtra(id: string, input: UpdateExtraInput, adminId: string) {
  const { expected_updated_at, ...data } = input;
  await prisma.$transaction(async (tx) => {
    const at = await lockPriceList(tx);
    const extra = await tx.priceExtra.findUnique({ where: { id } });
    if (!extra) throw new AppError("Biaya tidak ditemukan", 404);
    if (isStale(extra, expected_updated_at)) throw conflict([id]);
    const c = changes("extra", extra, data, adminId, at);
    if (!c.logs.length) return;
    await tx.priceExtra.update({ where: { id }, data: { ...c.changed, updated_by: adminId, updated_at: at } });
    await tx.priceChangeLog.createMany({ data: c.logs });
  }, PRICE_TX);
  return getPriceList();
}

/**
 * A city page shows one car + driver table (XOPS) and one all-in table, or is
 * a quote (priced per trip, e.g. abroad): quote clears both tables.
 */
export async function updateCity(id: string, input: UpdateCityInput, adminId: string) {
  await prisma.$transaction(async (tx) => {
    const at = await lockPriceList(tx);
    const city = await tx.priceCity.findUnique({ where: { id } });
    if (!city) throw new AppError("Kota tidak ditemukan", 404);
    if (isStale(city, input.expected_updated_at)) throw conflict([id]);
    const quote = input.quote ?? city.quote;
    const next = quote
      ? { quote, driver_zone_id: null, all_in_zone_id: null }
      : {
          quote,
          driver_zone_id: input.driver_zone_id !== undefined ? input.driver_zone_id : city.driver_zone_id,
          all_in_zone_id: input.all_in_zone_id !== undefined ? input.all_in_zone_id : city.all_in_zone_id,
        };
    if (!next.quote) {
      if (!next.driver_zone_id || !next.all_in_zone_id) {
        throw new AppError("Pilih tabel Mobil + Supir dan tabel All-in, atau tandai sebagai penawaran", 400);
      }
      const zones = await tx.priceZone.findMany({ where: { id: { in: [next.driver_zone_id, next.all_in_zone_id] } } });
      const driverZone = zones.find((z) => z.id === next.driver_zone_id);
      const allInZone = zones.find((z) => z.id === next.all_in_zone_id);
      if (!driverZone || !allInZone) throw new AppError("Tabel harga tidak ditemukan", 404);
      if (driverZone.service_package !== "XOPS") throw new AppError(`${driverZone.name} bukan tabel Mobil + Supir`, 400);
      if (allInZone.service_package === "XOPS" || isDropZone(allInZone.code)) {
        throw new AppError(`${allInZone.name} bukan tabel All-in`, 400);
      }
    }
    const c = changes("city", city, next, adminId, at);
    if (!c.logs.length) return;
    await tx.priceCity.update({ where: { id }, data: { ...c.changed, updated_at: at } });
    await tx.priceChangeLog.createMany({ data: c.logs });
  }, PRICE_TX);
  return getPriceList();
}

export async function updateCar(id: string, input: UpdateCarInput, adminId: string) {
  const { expected_updated_at, ...data } = input;
  await prisma.$transaction(async (tx) => {
    const at = await lockPriceList(tx);
    const car = await tx.priceCar.findUnique({ where: { id } });
    if (!car) throw new AppError("Mobil tidak ditemukan", 404);
    if (isStale(car, expected_updated_at)) throw conflict([id]);
    const c = changes("car", car, data, adminId, at);
    if (!c.logs.length) return;
    await tx.priceCar.update({ where: { id }, data: { ...c.changed, updated_at: at } });
    await tx.priceChangeLog.createMany({ data: c.logs });
  }, PRICE_TX);
  return getPriceList();
}

/**
 * A car added to the website fleet. It gets an empty rate ("tanya admin") in
 * every table, marked as a proposal until the owner sets its prices.
 */
export async function createCar(input: CreateCarInput, adminId: string) {
  const taken = () => new AppError(`Slug ${input.slug} sudah dipakai mobil lain`, 409);
  try {
    await prisma.$transaction(async (tx) => {
      const at = await lockPriceList(tx);
      if (await tx.priceCar.findUnique({ where: { slug: input.slug } })) throw taken();
      const last = await tx.priceCar.aggregate({ _max: { sort_order: true } });
      const car = await tx.priceCar.create({
        data: {
          slug: input.slug,
          name: input.name,
          price_class: input.price_class ?? null,
          sort_order: (last._max.sort_order ?? -1) + 1,
        },
      });
      const zones = await tx.priceZone.findMany({ select: { id: true, code: true } });
      await tx.priceRate.createMany({
        data: zones.flatMap((z) =>
          durationsFor(z.code).map((duration) => ({
            zone_id: z.id,
            car_id: car.id,
            duration,
            amount: null,
            is_proposal: true,
            updated_by: adminId,
          })),
        ),
      });
      await tx.priceChangeLog.create({ data: rowLog("car", car.id, "created", `${car.name} (${car.slug})`, adminId, at) });
    }, PRICE_TX);
  } catch (err) {
    if (isUniqueViolation(err)) throw taken();
    throw err;
  }
  return getPriceList();
}

// ── History ─────────────────────────────────────────────────────────────────
/** "Avanza · All-in Jakarta · 12 jam": what each log row is about (null when it is gone). */
async function entityLabels(logs: { entity: string; entity_id: string }[]) {
  const ids = (entity: Entity) => [...new Set(logs.filter((l) => l.entity === entity).map((l) => l.entity_id))];
  const [rates, surcharges, zones, cities, cars, extras] = await Promise.all([
    prisma.priceRate.findMany({
      where: { id: { in: ids("rate") } },
      select: { id: true, duration: true, zone: { select: { name: true } }, car: { select: { name: true } } },
    }),
    prisma.priceSurcharge.findMany({
      where: { id: { in: ids("surcharge") } },
      select: { id: true, area: true, zone: { select: { name: true } } },
    }),
    prisma.priceZone.findMany({ where: { id: { in: ids("zone") } }, select: { id: true, name: true } }),
    prisma.priceCity.findMany({ where: { id: { in: ids("city") } }, select: { id: true, name: true } }),
    prisma.priceCar.findMany({ where: { id: { in: ids("car") } }, select: { id: true, name: true } }),
    prisma.priceExtra.findMany({ where: { id: { in: ids("extra") } }, select: { id: true, label: true } }),
  ]);
  const labels = new Map<string, string>();
  for (const r of rates) {
    labels.set(`rate:${r.id}`, [r.car.name, r.zone.name, DURATION_LABEL[r.duration] ?? r.duration].join(" · "));
  }
  for (const s of surcharges) labels.set(`surcharge:${s.id}`, `${s.zone.name} · ${s.area}`);
  for (const z of zones) labels.set(`zone:${z.id}`, z.name);
  for (const c of cities) labels.set(`city:${c.id}`, c.name);
  for (const c of cars) labels.set(`car:${c.id}`, c.name);
  for (const e of extras) labels.set(`extra:${e.id}`, e.label);
  return labels;
}

/** Newest first. */
export async function getHistory(limit: number) {
  const rows = await prisma.priceChangeLog.findMany({ orderBy: [{ created_at: "desc" }, { id: "desc" }], take: limit });
  const labels = await entityLabels(rows);
  return {
    items: rows.map((r) => ({ ...r, label: labels.get(`${r.entity}:${r.entity_id}`) ?? null })),
    users: await userEmails(rows.map((r) => r.changed_by)),
  };
}

export async function listPublications(limit: number) {
  const items = await prisma.pricePublication.findMany({
    select: publicationSelect,
    orderBy: { created_at: "desc" },
    take: limit,
  });
  return { items, users: await userEmails(items.map((p) => p.published_by)) };
}

// ── Publishing ──────────────────────────────────────────────────────────────
/** { "toyota-avanza": { "12H": 500000, "FULLDAY": 700000 } }, cars in their order. */
function rateTable(rates: PriceRate[], cars: PriceCar[]) {
  const table: Record<string, Record<string, number | null>> = {};
  for (const car of cars) {
    const own = rates.filter((r) => r.car_id === car.id).sort((a, b) => rank(a.duration) - rank(b.duration));
    if (own.length) table[car.slug] = Object.fromEntries(own.map((r) => [r.duration, num(r.amount)]));
  }
  return table;
}

/**
 * What the website build consumes (version 1). Keep this shape stable: no
 * admin ids, no proposal flags, rupiah as numbers, null = "tanya admin".
 */
async function buildSnapshot(tx: Tx, at: Date) {
  const cars = await tx.priceCar.findMany({ orderBy: [{ sort_order: "asc" }, { name: "asc" }] });
  const zones = await tx.priceZone.findMany({
    include: { rates: true, surcharges: { orderBy: [{ sort_order: "asc" }, { area: "asc" }] } },
    orderBy: [{ sort_order: "asc" }, { code: "asc" }],
  });
  const cities = await tx.priceCity.findMany({ orderBy: [{ sort_order: "asc" }, { name: "asc" }] });
  const extras = await tx.priceExtra.findMany({ orderBy: { code: "asc" } });
  const codeOf = new Map(zones.map((z) => [z.id, z.code]));
  const zoneCode = (id: string | null) => (id ? codeOf.get(id) ?? null : null);
  return {
    version: 1,
    published_at: at.toISOString(),
    cars: cars.map((c) => ({ slug: c.slug, name: c.name, price_class: c.price_class })),
    zones: zones.map((z) => ({
      code: z.code,
      name: z.name,
      service_package: z.service_package,
      included: z.included,
      excluded: z.excluded,
      note: z.note,
      default_for_unlisted: z.default_for_unlisted,
      rates: rateTable(z.rates, cars),
      surcharges: z.surcharges.map((s) => ({ area: s.area, amount: Number(s.amount) })),
    })),
    cities: cities.map((c) => ({
      slug: c.slug,
      name: c.name,
      driver_zone: zoneCode(c.driver_zone_id),
      all_in_zone: zoneCode(c.all_in_zone_id),
      quote: c.quote,
    })),
    extras: Object.fromEntries(
      extras.map((e) => [e.code, { label: e.label, amount: num(e.amount), percent: num(e.percent), unit: e.unit, note: e.note }]),
    ),
  };
}

/**
 * Best effort: asks the website host to rebuild (it then reads the new
 * snapshot). Never logs the URL: it carries the hook's secret.
 */
async function triggerWebsiteDeploy(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(env.WEB_DEPLOY_HOOK_URL, { method: "POST", signal: controller.signal });
    if (!res.ok) {
      logger.warn({ status: res.status }, "website deploy hook not accepted");
      return false;
    }
    return true;
  } catch (err) {
    const e = err as { name?: string; cause?: { code?: string } };
    logger.warn({ reason: e.name === "AbortError" ? "timeout" : e.cause?.code ?? e.name }, "website deploy hook failed");
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const toPublication = (p: Prisma.PricePublicationGetPayload<{ select: typeof publicationSelect }>) => ({
  id: p.id,
  created_at: p.created_at,
  published_by: p.published_by,
  note: p.note,
  deploy_status: p.deploy_status,
});

/**
 * "Terbitkan ke website". A resend with the same client_ref returns the same
 * publication; when its deploy hook had failed, the resend calls it again.
 * Refused (409) while rates are still proposals, unless confirm_proposals.
 */
export async function publishPrices(input: PublishInput, adminId: string) {
  const byRef = async (retryHook: boolean) => {
    let p = await prisma.pricePublication.findUnique({ where: { client_ref: input.client_ref } });
    if (!p) return null;
    if (retryHook && p.deploy_status === "FAILED" && env.WEB_DEPLOY_HOOK_URL && (await triggerWebsiteDeploy())) {
      p = await prisma.pricePublication.update({ where: { id: p.id }, data: { deploy_status: "SENT" } });
    }
    return { created: false, publication: toPublication(p), snapshot: p.snapshot };
  };
  const prev = await byRef(true);
  if (prev) return prev;

  let row: PricePublication;
  try {
    row = await prisma.$transaction(async (tx) => {
      const at = await lockPriceList(tx);
      const proposals = await tx.priceRate.count({ where: { is_proposal: true } });
      if (proposals > 0 && input.confirm_proposals !== true) {
        throw new AppError(
          `Masih ada ${proposals} harga usulan yang belum dikonfirmasi owner. Centang konfirmasi untuk tetap menerbitkan.`,
          409,
          { proposal_count: proposals },
        );
      }
      return tx.pricePublication.create({
        data: {
          snapshot: await buildSnapshot(tx, at),
          note: input.note ?? null,
          client_ref: input.client_ref,
          published_by: adminId,
          // With a hook: not confirmed until it answers (below).
          deploy_status: env.WEB_DEPLOY_HOOK_URL ? "FAILED" : "SKIPPED",
          created_at: at,
        },
      });
    }, PRICE_TX);
  } catch (err) {
    // The same publish sent twice at once: the other copy was stored (and
    // calls the hook itself).
    if (isUniqueViolation(err)) {
      const again = await byRef(false);
      if (again) return again;
    }
    throw err;
  }
  // After the commit, so the build the hook starts reads this publication.
  if (env.WEB_DEPLOY_HOOK_URL && (await triggerWebsiteDeploy())) {
    row = await prisma.pricePublication.update({ where: { id: row.id }, data: { deploy_status: "SENT" } });
  }
  return { created: true, publication: toPublication(row), snapshot: row.snapshot };
}

/** Public: the latest published snapshot, for the website build. */
export async function getPublishedSnapshot() {
  const last = await prisma.pricePublication.findFirst({ select: { snapshot: true }, orderBy: { created_at: "desc" } });
  if (!last) throw new AppError("Daftar harga belum diterbitkan", 404);
  return last.snapshot;
}
