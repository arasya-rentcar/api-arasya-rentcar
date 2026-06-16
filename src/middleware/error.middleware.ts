import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { AppError } from '../utils/AppError';
import { logger } from '../config/logger';

export function errorMiddleware(
  err: Error,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    res.status(400).json({
      status: 'error',
      message: 'Validation error',
      errors: err.errors.map((e) => ({
        field: e.path.join('.'),
        message: e.message,
      })),
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
    });
    return;
  }

  logger.error({ err }, 'Unhandled error');

  res.status(500).json({
    status: 'error',
    message: 'Internal server error',
  });
}
