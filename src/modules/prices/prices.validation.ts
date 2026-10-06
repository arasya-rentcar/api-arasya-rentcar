import { z } from "zod";

// Empty form fields mean "not sent".
const blank = (v: unknown) => (v === "" || v === null ? undefined : v);
// Whole rupiah. No coercion: null is a real value here ("tanya admin").
const rupiah = z.number().int("Harga harus angka bulat").min(0, "Harga tidak boleh minus").max(100_000_000);
// Text that can be cleared: empty or null stores null, absent leaves it.
const clearableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v === undefined ? undefined : v || null));
const requiredText = (max: number, message: string) => z.string().trim().min(1, message).max(max);
const sortOrder = z.number().int().min(0).max(10_000);

/** "Simpan" on the price table: the rates the admin changed (or all of them). */
export const updateRatesSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string().uuid(),
        // null = "tanya admin".
        amount: rupiah.nullable(),
        is_proposal: z.boolean().optional(),
        note: clearableText(200),
      }),
    )
    .min(1)
    .max(200)
    .refine((items) => new Set(items.map((i) => i.id)).size === items.length, {
      message: "Tarif yang sama dikirim dua kali",
    }),
});
export type RateUpdate = z.infer<typeof updateRatesSchema>["items"][number];

export const createSurchargeSchema = z.object({
  zone_id: z.string().uuid(),
  area: requiredText(60, "Nama area wajib diisi"),
  amount: rupiah,
  sort_order: sortOrder.optional(),
});
export type CreateSurchargeInput = z.infer<typeof createSurchargeSchema>;

export const updateSurchargeSchema = z.object({
  area: requiredText(60, "Nama area wajib diisi").optional(),
  amount: rupiah.optional(),
  sort_order: sortOrder.optional(),
});
export type UpdateSurchargeInput = z.infer<typeof updateSurchargeSchema>;

export const updateZoneSchema = z.object({
  name: requiredText(80, "Nama tabel wajib diisi").optional(),
  included: requiredText(500, "Isi \"sudah termasuk\"").optional(),
  excluded: requiredText(500, "Isi \"belum termasuk\"").optional(),
  note: clearableText(300),
});
export type UpdateZoneInput = z.infer<typeof updateZoneSchema>;

export const updateExtraSchema = z.object({
  amount: rupiah.nullable().optional(),
  percent: z.number().min(0).max(100).nullable().optional(),
  note: clearableText(300),
});
export type UpdateExtraInput = z.infer<typeof updateExtraSchema>;

export const updateCitySchema = z.object({
  driver_zone_id: z.string().uuid().nullable().optional(),
  all_in_zone_id: z.string().uuid().nullable().optional(),
  quote: z.boolean().optional(),
});
export type UpdateCityInput = z.infer<typeof updateCitySchema>;

export const updateCarSchema = z.object({
  name: requiredText(80, "Nama mobil wajib diisi").optional(),
  price_class: clearableText(60),
  note: clearableText(300),
  sort_order: sortOrder.optional(),
});
export type UpdateCarInput = z.infer<typeof updateCarSchema>;

/** A car added to the website fleet: its slug must match the website (Sanity). */
export const createCarSchema = z.object({
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .max(80)
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Slug hanya huruf kecil, angka, dan tanda -"),
  name: requiredText(80, "Nama mobil wajib diisi"),
  price_class: clearableText(60),
});
export type CreateCarInput = z.infer<typeof createCarSchema>;

export const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export const publicationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** "Terbitkan ke website". client_ref makes a double click a no-op. */
export const publishSchema = z.object({
  note: z
    .string()
    .trim()
    .max(300)
    .nullish()
    .transform((v) => v || undefined),
  client_ref: z.preprocess(blank, z.string().uuid().optional()),
});
export type PublishInput = z.infer<typeof publishSchema>;
