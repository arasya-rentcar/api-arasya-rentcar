import prisma from '../../prisma/client';
import { AppError } from '../../utils/AppError';
import {
  CreateCustomerInput,
  UpdateCustomerInput,
  ListCustomersQuery,
  normalizePhone,
} from './customers.validation';
import type { Prisma } from '@prisma/client';

const ORDERS_PAGE_SIZE = 10;

export async function createCustomer(input: CreateCustomerInput) {
  const phone = normalizePhone(input.phone);
  const existing = await prisma.customer.findUnique({ where: { phone } });
  if (existing) throw new AppError('Customer with this phone already exists', 409);
  return prisma.customer.create({
    data: {
      name: input.name,
      phone,
      email: input.email || null,
      tags: input.tags ?? [],
      notes: input.notes || null,
    },
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
    and.push({
      OR: [
        { name: { contains: q, mode: 'insensitive' } },
        { phone: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
      ],
    });
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
    }),
  ]);

  return {
    data,
    pagination: {
      page,
      page_size: pageSize,
      total,
      page_count: Math.max(1, Math.ceil(total / pageSize)),
    },
  };
}

export async function getCustomerById(id: string, ordersPage = 1) {
  const customer = await prisma.customer.findUnique({ where: { id } });
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
    const clash = await prisma.customer.findUnique({ where: { phone } });
    if (clash && clash.id !== id)
      throw new AppError('Another customer already uses this phone', 409);
    data.phone = phone;
  }
  if (input.email !== undefined) data.email = input.email || null;
  if (input.tags !== undefined) data.tags = input.tags;
  if (input.notes !== undefined) data.notes = input.notes || null;

  return prisma.customer.update({ where: { id }, data });
}

type Db = Prisma.TransactionClient | typeof prisma;

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
    const byPhone = await client.customer.findUnique({ where: { phone } });
    if (byPhone) return { customer: byPhone, created: false };
  } else {
    // No phone: match by exact (case-insensitive) name to avoid duplicates.
    const byName = await client.customer.findFirst({
      where: { phone: null, name: { equals: name, mode: 'insensitive' } },
    });
    if (byName) return { customer: byName, created: false };
  }

  const customer = await client.customer.create({
    data: { name, phone: phone || null },
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
  params: { name: string; phone?: string | null; amount: number; orderDate: Date },
) {
  const { customer } = await findOrCreateCustomer(client, {
    name: params.name,
    phone: params.phone,
  });

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
