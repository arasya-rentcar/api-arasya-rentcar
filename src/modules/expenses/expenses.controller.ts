import { Request, Response, NextFunction } from 'express';
import { createExpenseSchema } from './expenses.validation';
import { createExpense, listExpensesByTrip } from './expenses.service';

export async function createExpenseController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = createExpenseSchema.parse(req.body);
    const expense = await createExpense(
      req.params.id,
      input,
      req.user!.user_id,
      req.user!.role,
    );
    res.status(201).json({ status: 'success', data: expense });
  } catch (err) {
    next(err);
  }
}

export async function listExpensesController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const expenses = await listExpensesByTrip(req.params.id);
    res.json({ status: 'success', data: expenses });
  } catch (err) {
    next(err);
  }
}
