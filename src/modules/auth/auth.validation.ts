import { z } from 'zod';

// `identifier` is an email or a driver's phone number (driver app); `email`
// is kept for the dashboard. One of the two is required.
export const loginSchema = z
  .object({
    email: z.string().email('Invalid email format').optional(),
    identifier: z.string().trim().min(3).optional(),
    password: z.string().min(1, 'Password is required'),
  })
  .refine((v) => v.email || v.identifier, {
    message: 'Email or phone is required',
    path: ['identifier'],
  });

export type LoginInput = z.infer<typeof loginSchema>;
