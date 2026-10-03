import { Request, Response, NextFunction } from 'express';
import { createExpenseSchema, updateExpenseSchema } from './expenses.validation';
import {
  createExpense,
  listExpensesByTrip,
  updateExpense,
  deleteExpense,
} from './expenses.service';

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

export async function updateExpenseController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = updateExpenseSchema.parse(req.body);
    const expense = await updateExpense(req.params.expenseId, input, req.user!.user_id);
    res.json({ status: 'success', data: expense });
  } catch (err) {
    next(err);
  }
}

export async function deleteExpenseController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await deleteExpense(req.params.expenseId);
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
}
