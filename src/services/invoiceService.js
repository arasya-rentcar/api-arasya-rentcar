import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';

export async function generatePDF({ invoiceNumber, order }) {
  const html = `
    <html>
      <body>
        <h1>Invoice ${invoiceNumber}</h1>
        <p>Customer: ${order.customer_name}</p>
        <p>Total: Rp ${order.total_price}</p>
      </body>
    </html>
  `;

  const dir = './tmp';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);

  const filePath = path.join(dir, `${invoiceNumber}.pdf`);

  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setContent(html);
  await page.pdf({ path: filePath, format: 'A4' });
  await browser.close();

  return `file://${filePath}`;
}
