import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { query } from '../config/db.js';
import { env } from '../config/env.js';

export async function login(req, res) {
  const { email, password } = req.body;

  const { rows } = await query(
    'SELECT * FROM admins WHERE email=$1',
    [email]
  );

  if (!rows.length) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  const admin = rows[0];
  const match = await bcrypt.compare(password, admin.password_hash);

  if (!match) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }

  const token = jwt.sign(
    { id: admin.id, role: admin.role },
    env.jwtSecret,
    { expiresIn: '8h' }
  );

  res.json({ token });
}
