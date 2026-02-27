import express from 'express';
import { generateInvoice, sendInvoice } from '../controllers/invoicesController.js';

const router = express.Router();

router.post('/generate/:orderId', generateInvoice);
router.post('/send/:invoiceId', sendInvoice);

export default router;
