import prisma from '../../prisma/client';
import { hashPassword } from '../../utils/password';
import { AppError } from '../../utils/AppError';
import { CreateUserInput } from './users.validation';

const USER_SELECT = {
  id: true,
  email: true,
  role: true,
  created_at: true,
} as const;

export async function createUser(input: CreateUserInput) {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });

  if (existing) {
    throw new AppError('Email already in use', 409);
  }

  const hashedPassword = await hashPassword(input.password);

  return prisma.user.create({
    data: {
      email: input.email,
      password: hashedPassword,
      role: input.role,
    },
    select: USER_SELECT,
  });
}

export async function listUsers() {
  return prisma.user.findMany({
    select: USER_SELECT,
    orderBy: { created_at: 'desc' },
  });
}
