import { Request, Response, NextFunction } from 'express';
import { createUserSchema } from './users.validation';
import { createUser, listUsers } from './users.service';

export async function createUserController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = createUserSchema.parse(req.body);
    const user = await createUser(input);
    res.status(201).json({ status: 'success', data: user });
  } catch (err) {
    next(err);
  }
}

export async function listUsersController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const users = await listUsers();
    res.json({ status: 'success', data: users });
  } catch (err) {
    next(err);
  }
}
