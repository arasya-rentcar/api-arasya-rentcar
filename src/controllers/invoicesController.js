import db from '../config/db.js';
import { generatePDF } from '../services/invoiceService.js';
import { sendInvoiceMessage } from '../services/waService.js';

const query = db.query
export async function generateInvoice(req, res) {
  const { orderId } = req.params;

  const { rows } = await query(`
    SELECT o.*, c.name customer_name, c.phone
    FROM orders o
    JOIN customers c ON c.id = o.customer_id
    WHERE o.id = $1
  `, [orderId]);

  if (!rows.length) {
    return res.status(404).json({ message: 'Order not found' });
  }

  const order = rows[0];
  const invoiceNumber = `ARS-INV-${Date.now()}`;

  const pdfUrl = await generatePDF({ invoiceNumber, order });

  const invoice = await query(`
    INSERT INTO invoices (invoice_number, order_id, pdf_url, total_amount)
    VALUES ($1,$2,$3,$4)
    RETURNING *
  `, [invoiceNumber, orderId, pdfUrl, order.total_price]);

  await query(`UPDATE orders SET status='INVOICE_GENERATED' WHERE id=$1`, [orderId]);

  res.json(invoice.rows[0]);
}

export async function sendInvoice(req, res) {
  const { invoiceId } = req.params;

  const { rows } = await query(`
    SELECT i.*, c.phone
    FROM invoices i
    JOIN orders o ON o.id = i.order_id
    JOIN customers c ON c.id = o.customer_id
    WHERE i.id = $1
  `, [invoiceId]);

  if (!rows.length) {
    return res.status(404).json({ message: 'Invoice not found' });
  }

  const invoice = rows[0];

  await sendInvoiceMessage(
    invoice.phone,
    `Halo, berikut invoice Arasya Rentcar (${invoice.invoice_number})`,
    invoice.pdf_url
  );

  await query(`
    UPDATE invoices SET status='SENT', sent_at=now()
    WHERE id=$1
  `, [invoiceId]);

  res.json({ success: true });
}
