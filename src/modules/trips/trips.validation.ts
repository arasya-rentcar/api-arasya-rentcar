import { z } from 'zod';

// DRIVER_ASSIGNED is set by system on order assign – not accepted via API
export const nextStatusSchema = z.object({
  status: z.enum(
    [
      'DEPART_GARAGE',
      'ARRIVE_AT_CUSTOMER',
      'ON_TRIP',
      'DROP_CUSTOMER',
      'RETURN_GARAGE',
      'ARRIVE_GARAGE',
      'COMPLETED',
    ],
    { errorMap: () => ({ message: 'Invalid trip status value' }) },
  ),
});

export type NextStatusInput = z.infer<typeof nextStatusSchema>;
