import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { AppError } from '../utils/AppError';

export function verifyBotToken(req: Request, _res: Response, next: NextFunction): void {
  if (!env.BOT_INTERNAL_TOKEN) {
    return next(new AppError('BOT_INTERNAL_TOKEN is not configured', 500));
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : String(req.headers['x-bot-token'] || '').trim();

  if (!token || token !== env.BOT_INTERNAL_TOKEN) {
    return next(new AppError('Invalid bot token', 401));
  }

  next();
}
