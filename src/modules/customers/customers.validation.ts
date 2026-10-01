import { z } from 'zod';

// NIK (Nomor Induk Kependudukan): exactly 16 digits. Empty string clears it.
const idNumberField = z
  .string()
  .trim()
  .refine((v) => v === '' || /^\d{16}$/.test(v), {
    message: 'NIK harus 16 digit angka (NIK must be exactly 16 digits)',
  });

const identityFields = {
  id_number: idNumberField.nullable().optional(),
  address: z.string().nullable().optional(),
  company_name: z.string().nullable().optional(),
};

export const createCustomerSchema = z.object({
  name: z.string().min(1, 'Name is required'),
  phone: z.string().min(1, 'Phone is required'),
  email: z.string().email().optional().or(z.literal('')),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
  ...identityFields,
});

export const updateCustomerSchema = z.object({
  name: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  email: z.string().email().optional().or(z.literal('')),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional(),
  ...identityFields,
});

export const CUSTOMER_DOCUMENT_KINDS = [
  'KTP',
  'SIM',
  'NPWP',
  'PASPOR',
  'LAINNYA',
] as const;

export const uploadCustomerDocumentSchema = z.object({
  kind: z.enum(CUSTOMER_DOCUMENT_KINDS),
  note: z.string().optional(),
});

export const verifyCustomerSchema = z.object({
  verified: z.boolean(),
});

export const lookupCustomerQuerySchema = z.object({
  phone: z.string().min(1, 'phone is required'),
});

export type UploadCustomerDocumentInput = z.infer<
  typeof uploadCustomerDocumentSchema
>;

export const listCustomersQuerySchema = z.object({
  search: z.string().optional(),
  tag: z.string().optional(),
  sort: z.enum(['total_orders', 'last_order_at', 'name', 'created_at']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
  page: z.coerce.number().int().positive().optional(),
  page_size: z.coerce.number().int().positive().max(200).optional(),
});

export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;
export type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;

/**
 * Normalize an Indonesian phone number to the canonical identity key stored on
 * Customer.phone: digits only, local form `08…`. `0812…`, `62812…`,
 * `+62 812-…` and a bare `812…` all map to `0812…`. Shared by customer
 * create/update, lookup and the repeat-order upsert so they always agree.
 */
export function normalizePhone(raw: string): string {
  let p = (raw || '').replace(/\D/g, '');
  if (p.startsWith('62')) p = '0' + p.slice(2);
  else if (p.startsWith('8') && p.length >= 9) p = '0' + p;
  return p;
}

/**
 * Every stored spelling a phone may have (canonical `08…` plus legacy
 * `628…` / `+628…` rows written before normalisation was shared).
 */
export function phoneVariants(raw: string): string[] {
  const local = normalizePhone(raw);
  if (!local) return [];
  const intl = local.startsWith('0') ? `62${local.slice(1)}` : local;
  return Array.from(new Set([local, intl, `+${intl}`]));
}

/** NIK masked for lists: first 4 + 8 '*' + last 4 (null when unset). */
export function maskIdNumber(idNumber: string | null | undefined): string | null {
  if (!idNumber) return null;
  if (idNumber.length < 8) return '*'.repeat(idNumber.length);
  return `${idNumber.slice(0, 4)}${'*'.repeat(8)}${idNumber.slice(-4)}`;
}
