import { z } from 'zod';

export const createOrderSchema = z.object({
  customer_name: z.string().min(1, 'Customer name is required'),
  customer_phone: z.string().min(1, 'Customer phone is required'),
  pickup_location: z.string().min(1, 'Pickup location is required'),
  dropoff_location: z.string().min(1, 'Dropoff location is required'),
  order_date: z.string().datetime({ message: 'order_date must be ISO 8601 datetime string' }),
  final_price: z.number().positive('final_price must be a positive number'),
});

export const updateOrderSchema = z.object({
  customer_name: z.string().min(1).optional(),
  customer_phone: z.string().min(1).optional(),
  pickup_location: z.string().min(1).optional(),
  dropoff_location: z.string().min(1).optional(),
  order_date: z.string().datetime().optional(),
  final_price: z.number().positive().optional(),
  payment_status: z.enum(['UNPAID', 'DP_PAID', 'PAID']).optional(),
});

export const assignOrderSchema = z.object({
  driver_id: z.string().uuid('Invalid driver_id format'),
  car_id: z.string().uuid('Invalid car_id format'),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;
export type AssignOrderInput = z.infer<typeof assignOrderSchema>;
