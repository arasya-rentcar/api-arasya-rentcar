/**
 * Sprint 2 — WhatsApp invoice/receipt caption builder (LOCKED 2026-06-20).
 *
 * These captions are the WhatsApp message body sent ALONGSIDE the PDF.
 * Bold uses WhatsApp `*asterisks*`. Overpayment/refund details live ONLY in
 * the PDF, never in these captions.
 *
 * All date/time logic is Asia/Jakarta (GMT+7). See SPRINT2_WORDING_SPEC.md.
 */

const TZ_OFFSET_MS = 7 * 60 * 60 * 1000; // GMT+7

const MONTHS_ID = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];
const DAYS_ID = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];

/** Shift a UTC date into Jakarta wall-clock and expose its parts. */
function jakartaParts(d: Date) {
  const j = new Date(d.getTime() + TZ_OFFSET_MS);
  return {
    dow: j.getUTCDay(),
    day: j.getUTCDate(),
    month: j.getUTCMonth(), // 0-11
    year: j.getUTCFullYear(),
    hour: j.getUTCHours(),
    minute: j.getUTCMinutes(),
  };
}

export function formatRp(value: number): string {
  const n = Math.round(value);
  return `Rp ${new Intl.NumberFormat("id-ID").format(n)}`;
}

/** Greeting bucket by Jakarta send-time. */
export function greetingFor(now: Date = new Date()): string {
  const { hour } = jakartaParts(now);
  if (hour < 11) return "pagi"; // 00:00–10:59
  if (hour < 15) return "siang"; // 11:00–14:59
  if (hour < 18) return "sore"; // 15:00–17:59
  return "malam"; // 18:00–23:59
}

/** "Sabtu, 28 Maret 2026 10:15" */
export function formatDayDateTimeId(d: Date): string {
  const p = jakartaParts(d);
  const hh = String(p.hour).padStart(2, "0");
  const mm = String(p.minute).padStart(2, "0");
  return `${DAYS_ID[p.dow]}, ${p.day} ${MONTHS_ID[p.month]} ${p.year} ${hh}:${mm}`;
}

/**
 * Build the trip-duration string from a list of service dates.
 * - 1 day            -> "1 April 2026"
 * - consecutive run  -> "1 - 3 April 2026" / "30 April - 2 Mei 2026"
 * - non-consecutive  -> "1, 3, 5 April 2026"
 */
export function formatTripDuration(dates: Date[]): string {
  const uniq = Array.from(
    new Map(
      dates
        .filter((d): d is Date => !!d)
        .map((d) => {
          const p = jakartaParts(d);
          // key by Jakarta calendar day; value = parts
          return [`${p.year}-${p.month}-${p.day}`, p] as const;
        }),
    ).values(),
  ).sort((a, b) =>
    a.year !== b.year
      ? a.year - b.year
      : a.month !== b.month
        ? a.month - b.month
        : a.day - b.day,
  );

  if (uniq.length === 0) return "-";

  const dmy = (p: { day: number; month: number; year: number }) =>
    `${p.day} ${MONTHS_ID[p.month]} ${p.year}`;

  if (uniq.length === 1) return dmy(uniq[0]);

  // consecutive if each step is exactly +1 calendar day
  let consecutive = true;
  for (let i = 1; i < uniq.length; i++) {
    const prev = Date.UTC(uniq[i - 1].year, uniq[i - 1].month, uniq[i - 1].day);
    const cur = Date.UTC(uniq[i].year, uniq[i].month, uniq[i].day);
    if (cur - prev !== 24 * 60 * 60 * 1000) {
      consecutive = false;
      break;
    }
  }

  if (consecutive) {
    const a = uniq[0];
    const b = uniq[uniq.length - 1];
    const sameYear = a.year === b.year;
    const sameMonth = sameYear && a.month === b.month;
    if (sameMonth) {
      // "1 - 3 April 2026"
      return `${a.day} - ${b.day} ${MONTHS_ID[a.month]} ${a.year}`;
    }
    if (sameYear) {
      // "30 April - 2 Mei 2026" (year only once, at the end)
      return `${a.day} ${MONTHS_ID[a.month]} - ${b.day} ${MONTHS_ID[b.month]} ${a.year}`;
    }
    // cross-year: spell both fully
    return `${dmy(a)} - ${dmy(b)}`;
  }

  // non-consecutive list: collapse trailing month/year onto last item only.
  // "1, 3, 5 April 2026" when all same month+year; otherwise spell each fully.
  const sameMonthYear = uniq.every(
    (p) => p.month === uniq[0].month && p.year === uniq[0].year,
  );
  if (sameMonthYear) {
    const days = uniq.map((p) => p.day).join(", ");
    return `${days} ${MONTHS_ID[uniq[0].month]} ${uniq[0].year}`;
  }
  return uniq.map(dmy).join(", ");
}

/** Same-day = service date equals order/today date (Jakarta calendar day). */
export function isSameDay(serviceDate: Date | null, ref: Date): boolean {
  if (!serviceDate) return false;
  const a = jakartaParts(serviceDate);
  const b = jakartaParts(ref);
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

// The only official account (owner decision). Never add personal accounts.
const BANK_BLOCK = [
  "Pembayaran dapat ditransfer ke rekening:",
  "*BCA 0954840782*",
  "a/n PT Ayomi Raya Karsa",
];

const CONTACT_LINE = "Info & konfirmasi: WhatsApp 0821-2402-4281 (Arasya Rent Car)";

const CANCELLATION_LINE =
  "Ketentuan pembatalan: sebelum hari H 20%, hari H s.d. pukul 10.00 WIB (perjalanan belum dimulai) 50%, setelahnya 100% dari total pesanan.";

export interface CaptionCtx {
  duration: string; // formatted trip duration
  total: number; // total biaya sewa / order total
  dp: number; // DP: this invoice's amount; settlement: the DP already paid
  sisa: number; // settlement = total - dp
  amount?: number; // this invoice's amount (FULL / COMBINED bill it whole)
  full?: boolean; // FULL / COMBINED: pay the whole amount, no DP split
  additionalTotal?: number;
  greeting: string;
  dpPaidAt?: Date | null;
  sameDay: boolean; // service date is today (no H-1)
}

export function buildDpInvoiceCaption(c: CaptionCtx): string {
  const handover = c.sameDay
    ? `Setelah ${c.full ? "pembayaran" : "DP"} kami terima, data mobil dan supir segera kami kirimkan ya kak.`
    : `Setelah ${c.full ? "pembayaran" : "DP"} kami terima, data mobil dan supir segera kami kirimkan maksimal *H-1* ya kak.`;
  const payLines = c.full
    ? [
        `Jika sudah sesuai, silakan transfer senilai *${formatRp(c.amount ?? c.total)}*.`,
      ]
    : [
        `Jika sudah sesuai, silakan transfer DP senilai *${formatRp(c.dp)}* (minimal DP 20%) pada saat pemesanan.`,
      ];
  return [
    `Berikut saya kirimkan invoice trip *${c.duration}*. Mohon dicek kembali ya kak 🙏🏻😃`,
    "",
    `Total biaya sewa senilai *${formatRp(c.total)}*`,
    "",
    ...payLines,
    "",
    ...BANK_BLOCK,
    "",
    "Atau scan QRIS resmi Arasya Rent Car di atas.",
    "",
    handover,
    "",
    ...(c.full
      ? []
      : [
          `Pelunasan senilai *${formatRp(c.sisa)}* dibayarkan saat mobil kami sudah sampai di lokasi penjemputan.`,
          "",
        ]),
    CANCELLATION_LINE,
    "",
    CONTACT_LINE,
    "Terima kasih 🙏🏻😃",
  ].join("\n");
}

export function buildSettlementInvoiceCaption(c: CaptionCtx): string {
  const dpLine = c.dpPaidAt
    ? `DP senilai *${formatRp(c.dp)}* telah kami terima pada saat pemesanan (*${formatDayDateTimeId(c.dpPaidAt)}*)`
    : `DP senilai *${formatRp(c.dp)}* telah kami terima pada saat pemesanan.`;
  return [
    `Selamat *${c.greeting}* kak,`,
    "izin reminder 🙏😃",
    "",
    `Total invoice senilai *${formatRp(c.total)}*`,
    "",
    dpLine,
    "",
    `Pelunasan senilai *${formatRp(c.sisa)}* dibayarkan saat mobil kami sudah sampai di lokasi penjemputan.`,
    "",
    ...BANK_BLOCK,
    "",
    CONTACT_LINE,
    "Terima kasih 🙏🏻😃",
  ].join("\n");
}

export function buildAdditionalInvoiceCaption(c: CaptionCtx): string {
  return [
    `Selamat *${c.greeting}*, Kak. 🙏🏻😃`,
    "",
    "Berikut kami kirimkan *Invoice Additional* untuk biaya tambahan yang tercatat selama perjalanan.",
    "",
    `Total tagihan: *${formatRp(c.additionalTotal ?? c.total)}*`,
    "",
    ...BANK_BLOCK,
    "",
    CONTACT_LINE,
    "Terima kasih 🙏🏻😃",
  ].join("\n");
}

/** "Invoice Penyesuaian": the shortfall of an earlier payment, billed again. */
export function buildAdjustmentInvoiceCaption(c: CaptionCtx): string {
  return [
    `Selamat *${c.greeting}*, Kak. 🙏🏻😃`,
    "",
    "Berikut kami kirimkan *Invoice Penyesuaian* untuk kekurangan pembayaran sebelumnya.",
    "",
    `Total tagihan: *${formatRp(c.amount ?? c.total)}*`,
    "",
    ...BANK_BLOCK,
    "",
    CONTACT_LINE,
    "Terima kasih 🙏🏻😃",
  ].join("\n");
}

export function buildRentalReceiptCaption(c: { sameDay: boolean }): string {
  const handover = c.sameDay
    ? "Selanjutnya, reservasi Kakak sudah kami proses. Data tim yang bertugas akan *segera* kami kirimkan."
    : "Selanjutnya, reservasi Kakak sudah kami proses. Data tim yang bertugas akan kami kirimkan *H-1* sebelum jadwal perjalanan.";
  return [
    "Baik Kak, terima kasih. 🙏🏻😃",
    "",
    "Pembayaran telah kami terima dengan baik. Berikut kami lampirkan *kwitansi pembayaran* sebagai bukti transaksi.",
    "",
    handover,
    "",
    "Terima kasih atas kepercayaannya. Sampai bertemu di hari perjalanan!",
  ].join("\n");
}

export function buildAdditionalReceiptCaption(): string {
  return [
    "Baik Kak, terima kasih ya. 🙏🏻😃",
    "",
    "Pembayaran biaya tambahan sudah kami terima dengan baik. Berikut kami lampirkan *kwitansi pembayaran* sebagai bukti transaksi.",
    "",
    "Terima kasih atas kepercayaannya. Sampai bertemu kembali di perjalanan berikutnya!",
  ].join("\n");
}

// ============================================================================
// #A1 / #A2 — Trip-team confirmation messaging (LOCKED 2026-06-20)
// Customer = "Data tim bertugas"; Driver = "Reminder Jadwal Perjalanan".
// Plus reassignment variants: customer UPDATE + driver stand-down.
// Bold (WhatsApp *asterisks*) = the service DATE only, except the driver
// stand-down which also bolds "tidak perlu berangkat".
// ============================================================================

/** "Sabtu, 20 Juni 2026" (date only, WIB). */
export function formatDayDateId(d: Date): string {
  const p = jakartaParts(d);
  return `${DAYS_ID[p.dow]}, ${p.day} ${MONTHS_ID[p.month]} ${p.year}`;
}

/** "08:00" in WIB (24h) from a Date. */
export function formatHourMinId(d: Date): string {
  const p = jakartaParts(d);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

export interface TripTeamCtx {
  service_date: Date; // line.service_date (WIB date)
  driver_name: string;
  driver_phone: string;
  car_plate: string; // Car.plate_number
  car_model: string; // Car.model
}

/** #A1 CUSTOMER — "Data tim bertugas {tanggal}". Bold = date only. */
export function buildTripTeamCustomerCaption(c: TripTeamCtx): string {
  return [
    `Data tim bertugas *${formatDayDateId(c.service_date)}*`,
    "",
    `Nama : ${c.driver_name}`,
    `No hp : ${c.driver_phone}`,
    `Nopol : ${c.car_plate}`,
    `Unit ${c.car_model}`,
    "",
    "====================",
  ].join("\n");
}

export interface TripTeamUpdateCtx extends TripTeamCtx {
  prev_driver_name?: string | null;
  prev_car_plate?: string | null;
  prev_car_model?: string | null;
}

/**
 * #A1 CUSTOMER UPDATE — sent when driver/car changed after the first send.
 * Shows old -> new so the customer isn't confused. Bold = date only.
 */
export function buildTripTeamUpdateCustomerCaption(c: TripTeamUpdateCtx): string {
  const driverLine =
    c.prev_driver_name && c.prev_driver_name !== c.driver_name
      ? `Nama : ${c.driver_name} (sebelumnya ${c.prev_driver_name})`
      : `Nama : ${c.driver_name}`;
  const prevPlate = c.prev_car_plate && c.prev_car_plate !== c.car_plate;
  const nopolLine = prevPlate
    ? `Nopol : ${c.car_plate} (sebelumnya ${c.prev_car_plate})`
    : `Nopol : ${c.car_plate}`;
  return [
    `Update tim bertugas — *${formatDayDateId(c.service_date)}*`,
    "",
    "Mohon maaf Kak, ada perubahan unit/driver untuk perjalanan Anda:",
    "",
    driverLine,
    `No hp : ${c.driver_phone}`,
    nopolLine,
    `Unit ${c.car_model}`,
    "",
    "====================",
  ].join("\n");
}

export interface DriverReminderCtx {
  service_date: Date;
  pickup_at?: Date | null; // line.start_at -> "HH:MM WIB"
  customer_name: string;
  customer_phone?: string | null;
  pickup_location?: string | null;
  dropoff_location?: string | null;
  service_type?: string | null; // Jenis Layanan
  passenger_count?: number | null; // Jumlah Penumpang
  car_plate: string;
  car_model: string;
  notes?: string | null; // Catatan
  order_code?: string | null; // Kode Order
}

/**
 * #A2 DRIVER — "Reminder Jadwal Perjalanan". Bold = date only.
 * Empty optional fields are hidden.
 */
export function buildDriverReminderCaption(c: DriverReminderCtx): string {
  const lines: string[] = [
    "Reminder Jadwal Perjalanan 🚐",
    "",
    `📅 *${formatDayDateId(c.service_date)}*`,
  ];
  if (c.pickup_at) lines.push(`🕒 ${formatHourMinId(c.pickup_at)} WIB`);
  lines.push("");
  lines.push(`Customer : ${c.customer_name}`);
  if (c.customer_phone) lines.push(`No hp : ${c.customer_phone}`);
  if (c.pickup_location) lines.push(`Lokasi Pickup : ${c.pickup_location}`);
  if (c.dropoff_location) lines.push(`Lokasi Dropoff : ${c.dropoff_location}`);
  if (c.service_type) lines.push(`Jenis Layanan : ${c.service_type}`);
  if (c.passenger_count != null)
    lines.push(`Jumlah Penumpang : ${c.passenger_count}`);
  lines.push(`Nopol : ${c.car_plate}`);
  lines.push(`Unit ${c.car_model}`);
  if (c.notes) lines.push(`Catatan : ${c.notes}`);
  if (c.order_code) lines.push(`Kode Order : ${c.order_code}`);
  lines.push("");
  lines.push(
    "Mohon memastikan kendaraan siap dan tiba di lokasi tepat waktu. Selamat bertugas 🙏🏻😃",
  );
  return lines.join("\n");
}

export interface DriverStandDownCtx {
  service_date: Date;
  pickup_at?: Date | null;
  driver_name: string;
  pickup_location?: string | null;
  dropoff_location?: string | null;
}

/**
 * #A2 DRIVER STAND-DOWN — polite notice that this driver was swapped out.
 * Bold = date + "tidak perlu berangkat" (LOCKED with TEN).
 */
export function buildDriverStandDownCaption(c: DriverStandDownCtx): string {
  const lines: string[] = [
    "Info Perubahan Jadwal",
    "",
    `Halo ${c.driver_name}, terima kasih atas kesiapannya. Untuk perjalanan berikut:`,
    "",
    `📅 *${formatDayDateId(c.service_date)}*`,
  ];
  if (c.pickup_at) lines.push(`🕒 ${formatHourMinId(c.pickup_at)} WIB`);
  if (c.pickup_location || c.dropoff_location)
    lines.push(`Rute : ${c.pickup_location ?? "-"} → ${c.dropoff_location ?? "-"}`);
  lines.push("");
  lines.push(
    "Penugasan Anda pada perjalanan ini kami alihkan ke unit/driver lain. Mohon *tidak perlu berangkat* untuk jadwal ini.",
  );
  lines.push("Terima kasih banyak, dan sampai jumpa di tugas berikutnya. 🙏🏻😃");
  return lines.join("\n");
}
