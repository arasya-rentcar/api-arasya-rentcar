import axios from 'axios';

const WA_PROVIDER = process.env.WA_PROVIDER || 'MOCK'; 
// 'FONNTE' | 'WABLAS' | 'MOCK'

const FONNTE_TOKEN = process.env.FONNTE_TOKEN;
const WABLAS_TOKEN = process.env.WABLAS_TOKEN;
const WABLAS_URL = process.env.WABLAS_URL;

/**
 * Normalize phone number to international format
 */
function normalizePhone(phone) {
  if (!phone) return null;
  if (phone.startsWith('0')) return '62' + phone.slice(1);
  if (phone.startsWith('+')) return phone.replace('+', '');
  return phone;
}

/**
 * Send invoice message
 */
export async function sendInvoiceMessage(phone, message, pdfUrl) {
  const to = normalizePhone(phone);

  if (WA_PROVIDER === 'MOCK') {
    console.log('📩 [MOCK WA]');
    console.log('To:', to);
    console.log('Message:', message);
    console.log('Invoice URL:', pdfUrl);
    return { success: true, provider: 'MOCK' };
  }

  if (WA_PROVIDER === 'FONNTE') {
    return sendViaFonnte(to, message, pdfUrl);
  }

  if (WA_PROVIDER === 'WABLAS') {
    return sendViaWablas(to, message, pdfUrl);
  }

  throw new Error('WA_PROVIDER not supported');
}

/**
 * Fonnte implementation
 */
async function sendViaFonnte(to, message, pdfUrl) {
  if (!FONNTE_TOKEN) {
    throw new Error('FONNTE_TOKEN not set');
  }

  const payload = {
    target: to,
    message: `${message}\n\nInvoice:\n${pdfUrl}`
  };

  const res = await axios.post(
    'https://api.fonnte.com/send',
    payload,
    {
      headers: {
        Authorization: FONNTE_TOKEN
      }
    }
  );

  return res.data;
}

/**
 * Wablas implementation
 */
async function sendViaWablas(to, message, pdfUrl) {
  if (!WABLAS_TOKEN || !WABLAS_URL) {
    throw new Error('WABLAS config not set');
  }

  const payload = {
    phone: to,
    message: `${message}\n\nInvoice:\n${pdfUrl}`
  };

  const res = await axios.post(WABLAS_URL, payload, {
    headers: {
      Authorization: WABLAS_TOKEN
    }
  });

  return res.data;
}
