import express from 'express';
import cors from 'cors';

import ordersRoutes from './routes/orders.js';
import invoicesRoutes from './routes/invoices.js';
// import expensesRoutes from './routes/expenses.js';

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.send('Arasya Backend API is running');
});

app.use('/api/orders', ordersRoutes);
app.use('/api/invoices', invoicesRoutes);
// app.use('/api/expenses', expensesRoutes);

export default app;
