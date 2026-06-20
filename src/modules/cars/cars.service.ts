import prisma from '../../prisma/client';
import { AppError } from '../../utils/AppError';
import { CreateCarInput, UpdateCarInput } from './cars.validation';
import {
  uploadFile,
  assertValidUpload,
  CAR_PHOTOS_BUCKET,
  type UploadedFile,
} from '../../services/storage.service';

export async function createCar(input: CreateCarInput) {
  const existingPlate = await prisma.car.findUnique({
    where: { plate_number: input.plate_number },
  });

  if (existingPlate) throw new AppError('Plate number already registered', 409);

  if (input.unit_code) {
    const existingCode = await prisma.car.findUnique({ where: { unit_code: input.unit_code } });
    if (existingCode) throw new AppError('Unit code already registered', 409);
  }

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

// Sprint 3: upload a car photo to the public car-photos bucket and set it as
// the car's primary photo (also appended to the photos[] gallery).
export async function uploadCarPhoto(id: string, file?: UploadedFile) {
  const photo = assertValidUpload(file);
  const car = await prisma.car.findUnique({ where: { id } });
  if (!car) throw new AppError('Car not found', 404);

  const up = await uploadFile(photo, {
    bucket: CAR_PHOTOS_BUCKET,
    prefix: `car/${id}`,
    public: true,
  });

  const gallery = Array.from(
    new Set([...(car.photos ?? []), up.publicUrl].filter((u): u is string => !!u)),
  );
  return prisma.car.update({
    where: { id },
    data: { photo_url: up.publicUrl, photos: gallery },
  });
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

  if (input.unit_code && input.unit_code !== car.unit_code) {
    const duplicateCode = await prisma.car.findUnique({ where: { unit_code: input.unit_code } });
    if (duplicateCode) throw new AppError('Unit code already registered', 409);
  }

  return prisma.car.update({ where: { id }, data: input });
}
