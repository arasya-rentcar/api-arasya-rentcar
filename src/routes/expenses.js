import express from 'express';
import * as ctrl from '../controllers/expensesController.js';

const router = express.Router();
router.post('/', ctrl.create);
router.get('/order/:orderId', ctrl.listByOrder);
export default router;
