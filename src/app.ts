import express from 'express';
import cors from 'cors';

import authRoutes from './modules/auth/auth.route';
import usersRoutes from './modules/users/users.route';
import driversRoutes from './modules/drivers/drivers.route';
import carsRoutes from './modules/cars/cars.route';
import ordersRoutes from './modules/orders/orders.route';
import tripsRoutes from './modules/trips/trips.route';

import { errorMiddleware } from './middleware/error.middleware';

const app = express();

// app.use(cors());
app.use(cors({
  origin: [
    "https://management.arasyarentcar.com"
  ],
  credentials: true
}))

app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'arasya-rentcar-api' });
});

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/users', usersRoutes);
app.use('/api/v1/drivers', driversRoutes);
app.use('/api/v1/cars', carsRoutes);
app.use('/api/v1/orders', ordersRoutes);
app.use('/api/v1/trips', tripsRoutes);

app.use(errorMiddleware);

export default app;
