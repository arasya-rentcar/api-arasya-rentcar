import prisma from '../../prisma/client';
import { AppError } from '../../utils/AppError';
import { CreateCarInput, UpdateCarInput } from './cars.validation';

export async function createCar(input: CreateCarInput) {
  const existing = await prisma.car.findUnique({
    where: { plate_number: input.plate_number },
  });

  if (existing) throw new AppError('Plate number already registered', 409);

  return prisma.car.create({ data: input });
}

export async function listCars() {
  return prisma.car.findMany({ orderBy: { model: 'asc' } });
}

export async function getCarById(id: string) {
  const car = await prisma.car.findUnique({ where: { id } });
  if (!car) throw new AppError('Car not found', 404);
  return car;
}

export async function updateCar(id: string, input: UpdateCarInput) {
  const car = await prisma.car.findUnique({ where: { id } });
  if (!car) throw new AppError('Car not found', 404);

  if (input.plate_number && input.plate_number !== car.plate_number) {
    const duplicate = await prisma.car.findUnique({
      where: { plate_number: input.plate_number },
    });
    if (duplicate) throw new AppError('Plate number already registered', 409);
  }

  return prisma.car.update({ where: { id }, data: input });
}
