import { Request, Response, NextFunction } from 'express';
import { loginSchema } from './auth.validation';
import { login } from './auth.service';

export async function loginController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = loginSchema.parse(req.body);
    const result = await login(input);
    res.json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
}
