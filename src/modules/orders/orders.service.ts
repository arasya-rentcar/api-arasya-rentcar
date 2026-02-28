import prisma from '../../prisma/client';
import { AppError } from '../../utils/AppError';
import { CreateOrderInput, UpdateOrderInput, AssignOrderInput } from './orders.validation';

export async function createOrder(input: CreateOrderInput) {
  return prisma.order.create({
    data: {
      customer_name: input.customer_name,
      customer_phone: input.customer_phone,
      pickup_location: input.pickup_location,
      dropoff_location: input.dropoff_location,
      order_date: new Date(input.order_date),
      final_price: input.final_price,
    },
  });
}

export async function listOrders() {
  return prisma.order.findMany({
    orderBy: { created_at: 'desc' },
    include: {
      trip: {
        select: {
          id: true,
          current_status: true,
          driver: { select: { name: true } },
          car: { select: { plate_number: true, model: true } },
        },
      },
      invoices: {
        select: { id: true, invoice_number: true, invoice_type: true, status: true, amount: true },
        orderBy: { created_at: 'desc' as const },
      },
    },
  });
}

export async function getOrderById(id: string) {
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      trip: {
        include: {
          driver: true,
          car: true,
          logs: { orderBy: { created_at: 'asc' } },
          expenses: { orderBy: { created_at: 'desc' } },
        },
      },
      invoices: { orderBy: { created_at: 'desc' as const } },
    },
  });

  if (!order) throw new AppError('Order not found', 404);
  return order;
}

export async function updateOrder(id: string, input: UpdateOrderInput) {
  const order = await prisma.order.findUnique({ where: { id } });
  if (!order) throw new AppError('Order not found', 404);

  if (order.order_status === 'DONE' || order.order_status === 'CANCELLED') {
    throw new AppError(`Cannot update order with status ${order.order_status}`, 409);
  }

  return prisma.order.update({
    where: { id },
    data: {
      ...input,
      order_date: input.order_date ? new Date(input.order_date) : undefined,
    },
  });
}

export async function assignOrder(orderId: string, input: AssignOrderInput) {
  // Validate order
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) throw new AppError('Order not found', 404);
  if (order.order_status !== 'CREATED') {
    throw new AppError('Order must be in CREATED status to assign a driver', 409);
  }

  // Validate driver
  const driver = await prisma.driver.findUnique({ where: { id: input.driver_id } });
  if (!driver) throw new AppError('Driver not found', 404);
  if (driver.status !== 'AVAILABLE') {
    throw new AppError('Driver is not available', 409);
  }

  // Validate car
  const car = await prisma.car.findUnique({ where: { id: input.car_id } });
  if (!car) throw new AppError('Car not found', 404);
  if (car.status !== 'AVAILABLE') {
    throw new AppError('Car is not available', 409);
  }

  // Ensure driver has no active trip
  const driverActiveTrip = await prisma.trip.findFirst({
    where: {
      driver_id: input.driver_id,
      current_status: { not: 'COMPLETED' },
    },
  });
  if (driverActiveTrip) throw new AppError('Driver already has an active trip', 409);

  // Ensure car has no active trip
  const carActiveTrip = await prisma.trip.findFirst({
    where: {
      car_id: input.car_id,
      current_status: { not: 'COMPLETED' },
    },
  });
  if (carActiveTrip) throw new AppError('Car is already in use by another trip', 409);

  // Ensure order has no existing trip
  const existingTrip = await prisma.trip.findUnique({ where: { order_id: orderId } });
  if (existingTrip) throw new AppError('Order already has a trip assigned', 409);

  // Execute in a transaction
  const trip = await prisma.$transaction(async (tx) => {
    const newTrip = await tx.trip.create({
      data: {
        order_id: orderId,
        driver_id: input.driver_id,
        car_id: input.car_id,
        current_status: 'DRIVER_ASSIGNED',
      },
    });

    await tx.tripLog.create({
      data: {
        trip_id: newTrip.id,
        status: 'DRIVER_ASSIGNED',
        actor: 'ADMIN',
      },
    });

    await tx.driver.update({
      where: { id: input.driver_id },
      data: { status: 'ON_DUTY' },
    });

    await tx.car.update({
      where: { id: input.car_id },
      data: { status: 'IN_USE' },
    });

    await tx.order.update({
      where: { id: orderId },
      data: { order_status: 'ASSIGNED' },
    });

    return newTrip;
  });

  return trip;
}
