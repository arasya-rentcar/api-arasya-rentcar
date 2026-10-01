import { findDriverByPhone } from '../bot/bot.service';
import prisma from '../../prisma/client';
import { comparePassword } from '../../utils/password';
import { signToken } from '../../utils/jwt';
import { AppError } from '../../utils/AppError';
import { LoginInput } from './auth.validation';

export async function login(input: LoginInput) {
  const id = (input.email || input.identifier || '').trim();
  let user = id.includes('@')
    ? await prisma.user.findUnique({ where: { email: id.toLowerCase() } })
    : null;
  if (id.includes('@') && !user) user = await prisma.user.findUnique({ where: { email: id } });
  if (!id.includes('@')) {
    // Driver app: log in with the phone number on the driver profile, typed
    // any way ("0812 3456-7890", "(0812) 3456.7890", "+62 812…").
    const driver = await findDriverByPhone(id.replace(/[\s\-.()]/g, ''));
    user = driver ? await prisma.user.findUnique({ where: { id: driver.user_id } }) : null;
  }

  if (!user) {
    throw new AppError('Invalid email or password', 401);
  }

  const isValid = await comparePassword(input.password, user.password);

  if (!isValid) {
    throw new AppError('Invalid email or password', 401);
  }

  // Drivers stay signed in on their phone; admins keep JWT_EXPIRES_IN.
  const token = signToken(
    { user_id: user.id, role: user.role },
    user.role === 'DRIVER' ? '90d' : undefined,
  );

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
    },
  };
}
