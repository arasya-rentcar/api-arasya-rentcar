import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Admin user
  const adminPassword = await bcrypt.hash('admin123', 12);
  const admin = await prisma.user.upsert({
    where: { email: 'admin@arasya.com' },
    update: {},
    create: {
      email: 'admin@arasya.com',
      password: adminPassword,
      role: 'ADMIN',
    },
  });
  console.log('Admin user:', admin.email);

  // Driver user
  const driverPassword = await bcrypt.hash('driver123', 12);
  const driverUser = await prisma.user.upsert({
    where: { email: 'driver@arasya.com' },
    update: {},
    create: {
      email: 'driver@arasya.com',
      password: driverPassword,
      role: 'DRIVER',
    },
  });
  console.log('Driver user:', driverUser.email);

  // Driver profile
  const driver = await prisma.driver.upsert({
    where: { user_id: driverUser.id },
    update: {},
    create: {
      user_id: driverUser.id,
      name: 'Naruto',
      phone: '081234567890',
      status: 'AVAILABLE',
    },
  });
  console.log('Driver profile:', driver.name);

  // Sample car
  const car = await prisma.car.upsert({
    where: { plate_number: 'B 1234 XYZ' },
    update: {},
    create: {
      plate_number: 'B 1234 XYZ',
      model: 'Toyota Innova 2023',
      status: 'AVAILABLE',
    },
  });
  console.log('Car:', car.plate_number, '-', car.model);

  console.log('\nSeed complete!');
  console.log('────────────────────────────');
  console.log('Login credentials:');
  console.log('  ADMIN  → admin@arasya.com  / admin123');
  console.log('  DRIVER → driver@arasya.com / driver123');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
