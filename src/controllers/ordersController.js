import db from '../config/db.js';

/**
 * GET /api/orders
 */
const list = async (req, res) => {
  const { status, from, to } = req.query;

  const q = `
    SELECT o.*, 
           c.name AS customer_name, 
           d.name AS driver_name, 
           car.plate_number
    FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN drivers d ON d.id = o.driver_id
    LEFT JOIN cars car ON car.id = o.car_id
  `;

  const { rows } = await db.query(q);
  res.json(rows);
};

/**
 * POST /api/orders
 */
const create = async (req, res) => {
  const {
    customer_id,
    pickup_datetime,
    pickup_location,
    drop_location,
    driver_id,
    car_id,
    base_price,
    extra_price,
    notes,
  } = req.body;

  const order_number = `ARS-ORD-${Date.now()}`;

  const q = `
    INSERT INTO orders
    (order_number, customer_id, driver_id, car_id, pickup_datetime,
     pickup_location, drop_location, base_price, extra_price, notes)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING *
  `;

  const values = [
    order_number,
    customer_id,
    driver_id,
    car_id,
    pickup_datetime,
    pickup_location,
    drop_location,
    base_price,
    extra_price,
    notes,
  ];

  const { rows } = await db.query(q, values);
  res.status(201).json(rows[0]);
};

/**
 * GET /api/orders/:id
 */
const detail = async (req, res) => {
  const id = req.params.id;

  const q = `
    SELECT o.*, 
           c.name AS customer_name, 
           d.name AS driver_name, 
           car.plate_number
    FROM orders o
    LEFT JOIN customers c ON c.id = o.customer_id
    LEFT JOIN drivers d ON d.id = o.driver_id
    LEFT JOIN cars car ON car.id = o.car_id
    WHERE o.id = $1
  `;

  const { rows } = await db.query(q, [id]);
  if (!rows[0]) {
    return res.status(404).json({ message: 'Not found' });
  }

  const exp = await db.query(
    'SELECT * FROM driver_expenses WHERE order_id = $1',
    [id]
  );
  const inv = await db.query(
    'SELECT * FROM invoices WHERE order_id = $1',
    [id]
  );

  res.json({
    order: rows[0],
    expenses: exp.rows,
    invoices: inv.rows,
  });
};

/**
 * PUT /api/orders/:id
 */
const update = async (req, res) => {
  const id = req.params.id;
  const fields = req.body;

  const sets = [];
  const vals = [];
  const keys = Object.keys(fields);

  keys.forEach((k, i) => {
    sets.push(`${k}=$${i + 1}`);
    vals.push(fields[k]);
  });

  const q = `
    UPDATE orders
    SET ${sets.join(',')},
        updated_at = NOW()
    WHERE id = $${keys.length + 1}
    RETURNING *
  `;

  vals.push(id);

  const { rows } = await db.query(q, vals);
  res.json(rows[0]);
};

/**
 * POST /api/orders/:id/status
 */
const addStatus = async (req, res) => {
  const id = req.params.id;
  const { status, note, lat, lng, changed_by } = req.body;

  await db.query(
    `
    INSERT INTO order_status_log
    (order_id, status, changed_by, note, latitude, longitude)
    VALUES ($1,$2,$3,$4,$5,$6)
    `,
    [id, status, changed_by, note, lat, lng]
  );

  await db.query(
    'UPDATE orders SET status=$1, updated_at=NOW() WHERE id=$2',
    [status, id]
  );

  res.json({ ok: true });
};

export default {
  list,
  create,
  detail,
  update,
  addStatus,
};
