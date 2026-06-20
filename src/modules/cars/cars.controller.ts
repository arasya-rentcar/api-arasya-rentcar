import { Request, Response, NextFunction } from 'express';
import { createCarSchema, updateCarSchema } from './cars.validation';
import {
  createCar,
  listCars,
  getCarById,
  updateCar,
  uploadCarPhoto,
} from './cars.service';

export async function createCarController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = createCarSchema.parse(req.body);
    const car = await createCar(input);
    res.status(201).json({ status: 'success', data: car });
  } catch (err) {
    next(err);
  }
}

export async function listCarsController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const cars = await listCars();
    res.json({ status: 'success', data: cars });
  } catch (err) {
    next(err);
  }
}

export async function getCarByIdController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const car = await getCarById(req.params.id);
    res.json({ status: 'success', data: car });
  } catch (err) {
    next(err);
  }
}

export async function uploadCarPhotoController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    const car = await uploadCarPhoto(
      req.params.id,
      file
        ? {
            buffer: file.buffer,
            mimetype: file.mimetype,
            size: file.size,
            originalname: file.originalname,
          }
        : undefined,
    );
    res.json({ status: 'success', data: car });
  } catch (err) {
    next(err);
  }
}

export async function updateCarController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const input = updateCarSchema.parse(req.body);
    const car = await updateCar(req.params.id, input);
    res.json({ status: 'success', data: car });
  } catch (err) {
    next(err);
  }
}
