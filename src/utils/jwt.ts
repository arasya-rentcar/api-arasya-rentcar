import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface JwtPayload {
  user_id: string;
  role: 'ADMIN' | 'DRIVER';
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, env.JWT_SECRET) as JwtPayload;
}
