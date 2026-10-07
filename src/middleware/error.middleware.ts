import { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { MulterError } from 'multer';
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

  // Malformed JSON body (express.json): a client error. The error carries the
  // raw body and its message quotes part of it (passwords, names, map
  // points), so neither is logged.
  if ((err as { type?: string }).type === 'entity.parse.failed') {
    logger.warn('Request body is not valid JSON');
    res.status(400).json({ status: 'error', message: 'Invalid JSON body' });
    return;
  }

  if (err instanceof MulterError) {
    res.status(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({
      status: 'error',
      message: err.code === 'LIMIT_FILE_SIZE' ? 'File terlalu besar' : err.message,
    });
    return;
  }

  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      ...err.details,
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
