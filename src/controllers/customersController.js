import { query } from '../config/db.js';

export async function list(_, res) {
  const { rows } = await query('SELECT * FROM customers ORDER BY created_at DESC');
  res.json(rows);
}

export async function create(req, res) {
  const { name, phone, email } = req.body;
  const { rows } = await query(
    'INSERT INTO customers (name, phone, email) VALUES ($1,$2,$3) RETURNING *',
    [name, phone, email]
  );
  res.status(201).json(rows[0]);
}
