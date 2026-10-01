import prisma from '../../prisma/client';
import { AppError } from '../../utils/AppError';
import {
  CreateCustomerInput,
  UpdateCustomerInput,
  ListCustomersQuery,
  UploadCustomerDocumentInput,
  normalizePhone,
  phoneVariants,
  maskIdNumber,
} from './customers.validation';
import type { Customer, Prisma } from '@prisma/client';
import { mintCustomerCode } from '../../utils/codes';
import {
  PAYMENT_PROOFS_BUCKET,
  UploadedFile,
  assertValidUpload,
  getSignedUrl,
  removeFile,
  uploadFile,
} from '../../services/storage.service';

/** Signed URLs for identity documents are short-lived (UU PDP). */
export const DOCUMENT_URL_TTL_SECONDS = 300;

/** Client-safe document fields (never the storage path). */
const documentSelect = {
  id: true,
  kind: true,
  mime: true,
  size: true,
  note: true,
  uploaded_by: true,
  created_at: true,
} satisfies Prisma.CustomerDocumentSelect;

const ktpCount = {
  _count: { select: { documents: { where: { kind: 'KTP' } } } },
} as const;

/** `''` → null, undefined stays undefined (= leave unchanged). */
function blankToNull(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  const t = (v ?? '').trim();
  return t ? t : null;
}

/**
 * List-safe view of a customer: full NIK replaced with `id_number_masked`,
 * plus `has_ktp` / `verified` flags.
 */
function toListCustomer<
  T extends Customer & { _count?: { documents: number } },
>(c: T) {
  const { id_number, _count, ...rest } = c;
  return {
    ...rest,
    id_number_masked: maskIdNumber(id_number),
    has_ktp: (_count?.documents ?? 0) > 0,
    verified: c.id_verified_at != null,
  };
}

/** Customer whose phone matches any spelling of `raw` (canonical first). */
async function findCustomerByPhone(client: Db, raw: string) {
  const variants = phoneVariants(raw);
  if (!variants.length) return null;
  const exact = await client.customer.findUnique({
    where: { phone: variants[0] },
  });
  if (exact) return exact;
  return client.customer.findFirst({
    where: { phone: { in: variants } },
    orderBy: { total_orders: 'desc' },
  });
}

const ORDERS_PAGE_SIZE = 10;

type Db = Prisma.TransactionClient | typeof prisma;

export async function createCustomer(input: CreateCustomerInput) {
  const phone = normalizePhone(input.phone);
  const existing = await findCustomerByPhone(prisma, phone);
  if (existing) throw new AppError('Customer with this phone already exists', 409);
  return prisma.$transaction(async (tx) => {
    const { code } = await mintCustomerCode(tx);
    return tx.customer.create({
      data: {
        code,
        name: input.name,
        phone,
        email: input.email || null,
        tags: input.tags ?? [],
        notes: input.notes || null,
        id_number: blankToNull(input.id_number) ?? null,
        address: blankToNull(input.address) ?? null,
        company_name: blankToNull(input.company_name) ?? null,
      },
    });
  });
}

export async function listCustomers(query: ListCustomersQuery) {
  const page = query.page ?? 1;
  const pageSize = query.page_size ?? 20;
  const sort = query.sort ?? 'total_orders';
  const order = query.order ?? 'desc';

  const where: Prisma.CustomerWhereInput = {};
  const and: Prisma.CustomerWhereInput[] = [];
  if (query.search?.trim()) {
    const q = query.search.trim();
    const or: Prisma.CustomerWhereInput[] = [
      { name: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q, mode: 'insensitive' } },
      { email: { contains: q, mode: 'insensitive' } },
      { company_name: { contains: q, mode: 'insensitive' } },
    ];
    // "+62 812…" / "62812…" should find the stored "0812…".
    const digits = q.replace(/\D/g, '');
    if (digits.length >= 4) {
      const local = normalizePhone(q);
      if (local && local !== q) or.push({ phone: { contains: local } });
      // A full 16-digit NIK finds its owner (the result is still masked).
      if (/^\d{16}$/.test(digits)) or.push({ id_number: digits });
    }
    and.push({ OR: or });
  }
  if (query.tag?.trim()) and.push({ tags: { has: query.tag.trim() } });
  if (and.length) where.AND = and;

  const [total, data] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      orderBy: { [sort]: order },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: ktpCount,
    }),
  ]);

  return {
    data: data.map(toListCustomer),
    pagination: {
      page,
      page_size: pageSize,
      total,
      page_count: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}

export async function getCustomerById(id: string, ordersPage = 1) {
  const customer = await prisma.customer.findUnique({
    where: { id },
    include: {
      documents: { select: documentSelect, orderBy: { created_at: 'desc' } },
    },
  });
  if (!customer) throw new AppError('Customer not found', 404);

  const page = Math.max(1, ordersPage);
  const [orderTotal, orders] = await Promise.all([
    prisma.order.count({ where: { customer_id: id } }),
    prisma.order.findMany({
      where: { customer_id: id },
      orderBy: { order_date: 'desc' },
      skip: (page - 1) * ORDERS_PAGE_SIZE,
      take: ORDERS_PAGE_SIZE,
      select: {
        id: true,
        order_code: true,
        order_date: true,
        service_start_at: true,
        pickup_location: true,
        dropoff_location: true,
        final_price: true,
        order_status: true,
        payment_status: true,
        is_external: true,
      },
    }),
  ]);

  return {
    ...customer,
    has_ktp: customer.documents.some((d) => d.kind === 'KTP'),
    verified: customer.id_verified_at != null,
    orders,
    orders_pagination: {
      page,
      page_size: ORDERS_PAGE_SIZE,
      total: orderTotal,
      page_count: Math.max(1, Math.ceil(orderTotal / ORDERS_PAGE_SIZE)),
    },
  };
}

export async function updateCustomer(id: string, input: UpdateCustomerInput) {
  const customer = await prisma.customer.findUnique({ where: { id } });
  if (!customer) throw new AppError('Customer not found', 404);

  const data: Prisma.CustomerUpdateInput = {};
  if (input.name !== undefined) data.name = input.name;
  if (input.phone !== undefined) {
    const phone = normalizePhone(input.phone);
    const clash = await findCustomerByPhone(prisma, phone);
    if (clash && clash.id !== id)
      throw new AppError('Another customer already uses this phone', 409);
    data.phone = phone;
  }
  if (input.email !== undefined) data.email = input.email || null;
  if (input.tags !== undefined) data.tags = input.tags;
  if (input.notes !== undefined) data.notes = input.notes || null;
  if (input.id_number !== undefined) data.id_number = blankToNull(input.id_number);
  if (input.address !== undefined) data.address = blankToNull(input.address);
  if (input.company_name !== undefined)
    data.company_name = blankToNull(input.company_name);

  return prisma.customer.update({ where: { id }, data });
}

// ── Identity: lookup, documents, verification ──────────────────────────────

/**
 * Repeat-customer lookup for the order form: phone in any spelling (0812…,
 * 62812…, +62 812…). Uses the same matcher as upsertCustomerForOrder, so the
 * customer shown here is the one the new order links to. NIK is masked.
 */
export async function lookupCustomerByPhone(phone: string) {
  const found = await findCustomerByPhone(prisma, phone);
  if (!found) return null;
  const ktp = await prisma.customerDocument.count({
    where: { customer_id: found.id, kind: 'KTP' },
  });
  return {
    id: found.id,
    code: found.code,
    name: found.name,
    phone: found.phone,
    email: found.email,
    company_name: found.company_name,
    total_orders: found.total_orders,
    last_order_at: found.last_order_at,
    has_ktp: ktp > 0,
    verified: found.id_verified_at != null,
    id_number_masked: maskIdNumber(found.id_number),
  };
}

async function assertCustomerExists(id: string) {
  const c = await prisma.customer.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!c) throw new AppError('Customer not found', 404);
}

/** Admin email for audit columns (uploaded_by / id_verified_by). */
async function actorEmail(userId?: string | null): Promise<string | null> {
  if (!userId) return null;
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });
  return u?.email ?? null;
}

/** Upload a KTP/SIM/NPWP/… into the PRIVATE bucket; returns the row, no path. */
export async function addCustomerDocument(
  customerId: string,
  file: UploadedFile | undefined,
  input: UploadCustomerDocumentInput,
  userId?: string | null,
) {
  await assertCustomerExists(customerId);
  const valid = assertValidUpload(file);
  const { path } = await uploadFile(valid, {
    bucket: PAYMENT_PROOFS_BUCKET,
    prefix: `customer-docs/${customerId}`,
    public: false,
  });
  return prisma.customerDocument.create({
    data: {
      customer_id: customerId,
      kind: input.kind,
      file_path: path,
      mime: valid.mimetype,
      size: valid.size,
      note: blankToNull(input.note) ?? null,
      uploaded_by: await actorEmail(userId),
    },
    select: documentSelect,
  });
}

async function findDocument(customerId: string, docId: string) {
  const doc = await prisma.customerDocument.findFirst({
    where: { id: docId, customer_id: customerId },
  });
  if (!doc) throw new AppError('Document not found', 404);
  return doc;
}

/** Short-lived (5 min) signed URL for viewing one document. */
export async function getCustomerDocumentUrl(customerId: string, docId: string) {
  const doc = await findDocument(customerId, docId);
  const url = await getSignedUrl(
    PAYMENT_PROOFS_BUCKET,
    doc.file_path,
    DOCUMENT_URL_TTL_SECONDS,
  );
  return { url, expires_in: DOCUMENT_URL_TTL_SECONDS };
}

/** Delete the row, then best-effort remove the stored object. */
export async function deleteCustomerDocument(customerId: string, docId: string) {
  const doc = await findDocument(customerId, docId);
  await prisma.customerDocument.delete({ where: { id: doc.id } });
  await removeFile(PAYMENT_PROOFS_BUCKET, doc.file_path);
}

/** Mark (or unmark) the customer's identity as checked by an admin. */
export async function setCustomerVerified(
  customerId: string,
  verified: boolean,
  userId?: string | null,
) {
  await assertCustomerExists(customerId);
  const updated = await prisma.customer.update({
    where: { id: customerId },
    data: verified
      ? { id_verified_at: new Date(), id_verified_by: await actorEmail(userId) }
      : { id_verified_at: null, id_verified_by: null },
    select: { id: true, id_verified_at: true, id_verified_by: true },
  });
  return { ...updated, verified: updated.id_verified_at != null };
}

/**
 * Find an existing customer (by normalized phone if available, otherwise by
 * case-insensitive name) or create one. Does NOT touch order rollups.
 */
export async function findOrCreateCustomer(
  client: Db,
  params: { name: string; phone?: string | null },
) {
  const phone = params.phone ? normalizePhone(params.phone) : '';
  const name = (params.name || '').trim() || 'Unknown customer';

  if (phone) {
    // Same matcher as the lookup endpoint: 0812… / 62812… / +62812… are one
    // customer (also catches legacy rows stored in international form).
    const byPhone = await findCustomerByPhone(client, phone);
    if (byPhone) return { customer: byPhone, created: false };
  } else {
    // No phone: match by exact (case-insensitive) name to avoid duplicates.
    const byName = await client.customer.findFirst({
      where: { phone: null, name: { equals: name, mode: 'insensitive' } },
    });
    if (byName) return { customer: byName, created: false };
  }

  const { code } = await mintCustomerCode(client);
  const customer = await client.customer.create({
    data: { code, name, phone: phone || null },
  });
  return { customer, created: true };
}

/**
 * Find-or-create the customer for an order AND roll up order stats. Call this
 * whenever an order is created so repeat-order counts stay accurate. Safe to
 * run inside a transaction (pass tx); otherwise uses the default client.
 */
export async function upsertCustomerForOrder(
  client: Db,
  params: {
    name: string;
    phone?: string | null;
    amount: number;
    orderDate: Date;
    // Sprint 5 #15: lock to a chosen master customer (skip phone fuzzy-match).
    customerId?: string | null;
  },
) {
  let customer;
  if (params.customerId) {
    const existing = await client.customer.findUnique({
      where: { id: params.customerId },
    });
    if (!existing) throw new AppError('Selected customer not found', 404);
    customer = existing;
  } else {
    ({ customer } = await findOrCreateCustomer(client, {
      name: params.name,
      phone: params.phone,
    }));
  }

  return client.customer.update({
    where: { id: customer.id },
    data: {
      name: customer.name || params.name,
      total_orders: { increment: 1 },
      total_spent: { increment: params.amount },
      last_order_at: params.orderDate,
      first_order_at: customer.first_order_at ?? params.orderDate,
    },
  });
}
