import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Admin user
  // const adminPassword = await bcrypt.hash('admin123', 12);
  // const admin = await prisma.user.upsert({
  //   where: { email: 'admin@arasya.com' },
  //   update: {},
  //   create: {
  //     email: 'admin@arasya.com',
  //     password: adminPassword,
  //     role: 'ADMIN',
  //   },
  // });
  // console.log('Admin user:', admin.email);

  // Driver user
  const driverPassword = await bcrypt.hash('driver123', 12);
  const driverArr = [{ user: {
    email: 'driver1@arasya.com', password: driverPassword, role: 'DRIVER', name: 'Sasuke', phone: '081234567891', status: 'AVAILABLE'
  }
}, {
  user: {
    email: 'driver2@arasya.com', password: driverPassword, role: 'DRIVER', name: 'Rock Lee', phone: '081234567892', status: 'AVAILABLE' 
  }
}, {
  user: { email: 'driver3@arasya.com', password: driverPassword, role: 'DRIVER', name: 'Sakura', phone: '081234567893', status: 'AVAILABLE'}
}, {
  user: { email: 'driver4@arasya.com', password: driverPassword, role: 'DRIVER', name: 'Kakashi', phone: '081234567894', status: 'AVAILABLE' }
}, {
  user: { email: 'driver5@arasya.com', password: driverPassword, role: 'DRIVER', name: 'Hinata', phone: '081234567895', status: 'AVAILABLE' }
}];

for(let i = 0; i < driverArr.length; i++) {
  const driverUser = await prisma.user.upsert({
    where: { email: driverArr[i].user.email },
    update: {},
    create: {
      email: driverArr[i].user.email,
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
      name: driverArr[i].user.name,
      phone: driverArr[i].user.phone,
      status: 'AVAILABLE',
    },
  });
  console.log('Driver profile:', driver.name);
}



const carArr = [{ plate_number: 'B 1234 XYZ', model: 'Toyota Innova 2023', status: 'AVAILABLE' }, { plate_number: 'B 5678 ABC', model: 'Honda CR-V 2023', status: 'AVAILABLE' }, {
  plate_number: 'B 9012 DEF', model: 'Suzuki Ertiga 2023', status: 'AVAILABLE' }, {
    plate_number: 'B 3456 GHI', model: 'Mitsubishi Xpander 2023', status: 'AVAILABLE' }, {
      plate_number: 'B 7890 JKL', model: 'Daihatsu Terios 2023', status: 'AVAILABLE' }, {
        plate_number: 'B 2345 MNO', model: 'Nissan Livina 2023', status: 'AVAILABLE' }, {
          plate_number: 'B 6789 PQR', model: 'Isuzu MU-X 2023', status: 'AVAILABLE' }, {
            plate_number: 'B 0123 STU', model: 'Chevrolet Captiva 2023', status: 'AVAILABLE' }, {
              plate_number: 'B 4567 VWX', model: 'Ford Everest 2023', status: 'AVAILABLE' }];
  // Sample car

  for(let i = 0; i < carArr.length; i++) {
    const car = await prisma.car.upsert({
      where: { plate_number: carArr[i].plate_number },
      update: {},
      create: {
        plate_number: carArr[i].plate_number,
        model: carArr[i].model,
        status: 'AVAILABLE',
      },
    });
    console.log('Car:', car.plate_number, '-', car.model);
  }

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
