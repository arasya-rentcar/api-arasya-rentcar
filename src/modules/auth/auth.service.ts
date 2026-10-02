import prisma from '../../prisma/client';
import { phoneVariants } from '../customers/customers.validation';
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
    const drivers = await prisma.driver.findMany({
      where: { phone: { in: phoneVariants(id) } },
      select: { user_id: true },
    });
    if (drivers.length > 1) {
      // One number on several drivers would log in as whichever row comes
      // first. Refuse; only someone who knows one of their passwords is told
      // why (everyone else gets the usual message).
      const users = await prisma.user.findMany({
        where: { id: { in: drivers.map((d) => d.user_id) } },
      });
      for (const u of users) {
        if (await comparePassword(input.password, u.password)) {
          throw new AppError(
            'Nomor HP ini terdaftar untuk lebih dari satu driver. Minta admin memperbaiki nomor HP di data driver.',
            409,
          );
        }
      }
      throw new AppError('Nomor HP/email atau kata sandi salah', 401);
    }
    user = drivers[0] ? await prisma.user.findUnique({ where: { id: drivers[0].user_id } }) : null;
  }

  if (!user) {
    throw new AppError('Nomor HP/email atau kata sandi salah', 401);
  }

  const isValid = await comparePassword(input.password, user.password);

  if (!isValid) {
    throw new AppError('Nomor HP/email atau kata sandi salah', 401);
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
