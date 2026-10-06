export class AppError extends Error {
  public readonly statusCode: number;
  // Extra fields for the error body, e.g. { conflict_ids } on a 409.
  public readonly details?: Record<string, unknown>;

  constructor(message: string, statusCode: number = 500, details?: Record<string, unknown>) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}
