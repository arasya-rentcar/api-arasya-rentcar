import prisma from '../../prisma/client';
import { AppError } from '../../utils/AppError';
import {
  CreateVendorInput,
  UpdateVendorInput,
  CreateVendorCarInput,
  UpdateVendorCarInput,
  ListVendorsQuery,
} from './external-vendors.validation';
import type { Prisma } from '@prisma/client';

const TAB_PAGE_SIZE = 10;

type Db = Prisma.TransactionClient | typeof prisma;

/** Find a vendor by case-insensitive name or create it. */
export async function findOrCreateVendor(
  client: Db,
  params: { name: string; phone?: string | null },
) {
  const name = (params.name || '').trim();
  if (!name) return null;
  const existing = await client.externalVendor.findFirst({
    where: { name: { equals: name, mode: 'insensitive' } },
  });
  if (existing) {
    // backfill phone if we now have one and it was missing
    if (params.phone && !existing.phone) {
      return client.externalVendor.update({
        where: { id: existing.id },
        data: { phone: params.phone },
      });
    }
    return existing;
  }
  return client.externalVendor.create({
    data: { name, phone: params.phone || null },
  });
}

/** Find a vendor car by model (+plate when given) or create it. */
export async function findOrCreateVendorCar(
  client: Db,
  vendorId: string,
  params: { model?: string | null; plate_number?: string | null },
) {
  const model = (params.model || '').trim();
  const plate = (params.plate_number || '').trim();
  if (!model && !plate) return null;

  const existing = await client.externalCar.findFirst({
    where: {
      vendor_id: vendorId,
      ...(plate
        ? { plate_number: { equals: plate, mode: 'insensitive' } }
        : { model: { equals: model || '-', mode: 'insensitive' } }),
    },
  });
  if (existing) return existing;

  return client.externalCar.create({
    data: {
      vendor_id: vendorId,
      model: model || 'Unknown',
      plate_number: plate || null,
    },
  });
}

export async function createVendor(input: CreateVendorInput) {
  return prisma.externalVendor.create({
    data: {
      name: input.name,
      phone: input.phone || null,
      notes: input.notes || null,
    },
  });
}

export async function listVendors(query: ListVendorsQuery) {
  const page = query.page ?? 1;
  const pageSize = query.page_size ?? 20;
  const sort = query.sort ?? 'order_count';
  const order = query.order ?? 'desc';

  const where: Prisma.ExternalVendorWhereInput = {};
  if (query.search?.trim()) {
    const q = query.search.trim();
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { phone: { contains: q, mode: 'insensitive' } },
    ];
  }

  const [total, data] = await Promise.all([
    prisma.externalVendor.count({ where }),
    prisma.externalVendor.findMany({
      where,
      orderBy: { [sort]: order },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { _count: { select: { cars: true, orders: true } } },
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

/** Vendor detail with separately-paginated Cars and Orders tabs. */
export async function getVendorById(
  id: string,
  opts: { carsPage?: number; ordersPage?: number } = {},
) {
  const vendor = await prisma.externalVendor.findUnique({
    where: { id },
    include: { _count: { select: { cars: true, orders: true } } },
  });
  if (!vendor) throw new AppError('External vendor not found', 404);

  const carsPage = Math.max(1, opts.carsPage ?? 1);
  const ordersPage = Math.max(1, opts.ordersPage ?? 1);

  const [carsTotal, cars, ordersTotal, orders] = await Promise.all([
    prisma.externalCar.count({ where: { vendor_id: id } }),
    prisma.externalCar.findMany({
      where: { vendor_id: id },
      orderBy: { created_at: 'desc' },
      skip: (carsPage - 1) * TAB_PAGE_SIZE,
      take: TAB_PAGE_SIZE,
      include: { _count: { select: { orders: true } } },
    }),
    prisma.order.count({ where: { external_vendor_id: id } }),
    prisma.order.findMany({
      where: { external_vendor_id: id },
      orderBy: { order_date: 'desc' },
      skip: (ordersPage - 1) * TAB_PAGE_SIZE,
      take: TAB_PAGE_SIZE,
      select: {
        id: true,
        order_code: true,
        order_date: true,
        service_start_at: true,
        customer_name: true,
        pickup_location: true,
        dropoff_location: true,
        final_price: true,
        order_status: true,
        payment_status: true,
        external_car: { select: { id: true, model: true, plate_number: true } },
      },
    }),
  ]);

  return {
    ...vendor,
    cars,
    cars_pagination: {
      page: carsPage,
      page_size: TAB_PAGE_SIZE,
      total: carsTotal,
      page_count: Math.max(1, Math.ceil(carsTotal / TAB_PAGE_SIZE)),
    },
    orders,
    orders_pagination: {
      page: ordersPage,
      page_size: TAB_PAGE_SIZE,
      total: ordersTotal,
      page_count: Math.max(1, Math.ceil(ordersTotal / TAB_PAGE_SIZE)),
    },
  };
}

export async function updateVendor(id: string, input: UpdateVendorInput) {
  const vendor = await prisma.externalVendor.findUnique({ where: { id } });
  if (!vendor) throw new AppError('External vendor not found', 404);
  return prisma.externalVendor.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.phone !== undefined ? { phone: input.phone || null } : {}),
      ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
    },
  });
}

export async function deleteVendor(id: string) {
  const vendor = await prisma.externalVendor.findUnique({ where: { id } });
  if (!vendor) throw new AppError('External vendor not found', 404);
  const orderCount = await prisma.order.count({
    where: { external_vendor_id: id },
  });
  if (orderCount > 0)
    throw new AppError(
      'Cannot delete a vendor that still has orders attached',
      409,
    );
  await prisma.externalVendor.delete({ where: { id } });
  return { deleted: true };
}

// ── Vendor cars ──────────────────────────────────────────────────────────
export async function addVendorCar(
  vendorId: string,
  input: CreateVendorCarInput,
) {
  const vendor = await prisma.externalVendor.findUnique({
    where: { id: vendorId },
  });
  if (!vendor) throw new AppError('External vendor not found', 404);
  return prisma.externalCar.create({
    data: {
      vendor_id: vendorId,
      model: input.model,
      plate_number: input.plate_number || null,
      notes: input.notes || null,
    },
  });
}

export async function updateVendorCar(
  carId: string,
  input: UpdateVendorCarInput,
) {
  const car = await prisma.externalCar.findUnique({ where: { id: carId } });
  if (!car) throw new AppError('External car not found', 404);
  return prisma.externalCar.update({
    where: { id: carId },
    data: {
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.plate_number !== undefined
        ? { plate_number: input.plate_number || null }
        : {}),
      ...(input.notes !== undefined ? { notes: input.notes || null } : {}),
    },
  });
}

export async function deleteVendorCar(carId: string) {
  const car = await prisma.externalCar.findUnique({ where: { id: carId } });
  if (!car) throw new AppError('External car not found', 404);
  const orderCount = await prisma.order.count({
    where: { external_car_id: carId },
  });
  if (orderCount > 0)
    throw new AppError(
      'Cannot delete a car that still has orders attached',
      409,
    );
  await prisma.externalCar.delete({ where: { id: carId } });
  return { deleted: true };
}
