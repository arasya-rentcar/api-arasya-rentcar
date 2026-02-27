import { query } from '../config/db.js';

export async function create(req, res) {
  const { order_id, driver_id, type, amount, notes } = req.body;
  const { rows } = await query(
    'INSERT INTO driver_expenses (order_id, driver_id, type, amount, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [order_id, driver_id, type, amount, notes]
  );
  res.status(201).json(rows[0]);
}

export async function listByOrder(req, res) {
  const { rows } = await query(
    'SELECT * FROM driver_expenses WHERE order_id=$1',
    [req.params.orderId]
  );
  res.json(rows);
}
