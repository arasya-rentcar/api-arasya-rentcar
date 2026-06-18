import { Request, Response, NextFunction } from 'express';
import {
  createVendorSchema,
  updateVendorSchema,
  createVendorCarSchema,
  updateVendorCarSchema,
  listVendorsQuerySchema,
} from './external-vendors.validation';
import {
  createVendor,
  listVendors,
  getVendorById,
  updateVendor,
  deleteVendor,
  addVendorCar,
  updateVendorCar,
  deleteVendorCar,
} from './external-vendors.service';
import { getVendorDetail } from '../drivers/drivers.service';

export async function getVendorDetailController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const data = await getVendorDetail(req.params.id);
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
}

export async function createVendorController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = createVendorSchema.parse(req.body);
    const vendor = await createVendor(input);
    res.status(201).json({ status: 'success', data: vendor });
  } catch (err) {
    next(err);
  }
}

export async function listVendorsController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = listVendorsQuerySchema.parse(req.query);
    const result = await listVendors(query);
    res.json({ status: 'success', ...result });
  } catch (err) {
    next(err);
  }
}

export async function getVendorByIdController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const vendor = await getVendorById(req.params.id, {
      carsPage: req.query.cars_page ? Number(req.query.cars_page) : 1,
      ordersPage: req.query.orders_page ? Number(req.query.orders_page) : 1,
    });
    res.json({ status: 'success', data: vendor });
  } catch (err) {
    next(err);
  }
}

export async function updateVendorController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = updateVendorSchema.parse(req.body);
    const vendor = await updateVendor(req.params.id, input);
    res.json({ status: 'success', data: vendor });
  } catch (err) {
    next(err);
  }
}

export async function deleteVendorController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await deleteVendor(req.params.id);
    res.json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
}

export async function addVendorCarController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = createVendorCarSchema.parse(req.body);
    const car = await addVendorCar(req.params.id, input);
    res.status(201).json({ status: 'success', data: car });
  } catch (err) {
    next(err);
  }
}

export async function updateVendorCarController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = updateVendorCarSchema.parse(req.body);
    const car = await updateVendorCar(req.params.carId, input);
    res.json({ status: 'success', data: car });
  } catch (err) {
    next(err);
  }
}

export async function deleteVendorCarController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const result = await deleteVendorCar(req.params.carId);
    res.json({ status: 'success', data: result });
  } catch (err) {
    next(err);
  }
}
