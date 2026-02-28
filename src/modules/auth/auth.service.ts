import prisma from '../../prisma/client';
import { comparePassword } from '../../utils/password';
import { signToken } from '../../utils/jwt';
import { AppError } from '../../utils/AppError';
import { LoginInput } from './auth.validation';

export async function login(input: LoginInput) {
  const user = await prisma.user.findUnique({
    where: { email: input.email },
  });

  if (!user) {
    throw new AppError('Invalid email or password', 401);
  }

  const isValid = await comparePassword(input.password, user.password);

  if (!isValid) {
    throw new AppError('Invalid email or password', 401);
  }

  const token = signToken({ user_id: user.id, role: user.role });

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
    },
  };
}
