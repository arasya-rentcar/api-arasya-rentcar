import { Request, Response, NextFunction } from 'express';
import {
  createCustomerSchema,
  updateCustomerSchema,
  listCustomersQuerySchema,
} from './customers.validation';
import {
  createCustomer,
  listCustomers,
  getCustomerById,
  updateCustomer,
} from './customers.service';

export async function createCustomerController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = createCustomerSchema.parse(req.body);
    const customer = await createCustomer(input);
    res.status(201).json({ status: 'success', data: customer });
  } catch (err) {
    next(err);
  }
}

export async function listCustomersController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = listCustomersQuerySchema.parse(req.query);
    const result = await listCustomers(query);
    res.json({ status: 'success', ...result });
  } catch (err) {
    next(err);
  }
}

export async function getCustomerByIdController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const ordersPage = req.query.orders_page
      ? Number(req.query.orders_page)
      : 1;
    const customer = await getCustomerById(req.params.id, ordersPage);
    res.json({ status: 'success', data: customer });
  } catch (err) {
    next(err);
  }
}

export async function updateCustomerController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = updateCustomerSchema.parse(req.body);
    const customer = await updateCustomer(req.params.id, input);
    res.json({ status: 'success', data: customer });
  } catch (err) {
    next(err);
  }
}
