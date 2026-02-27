import express from 'express';
import * as ctrl from '../controllers/customersController.js';

const router = express.Router();
router.get('/', ctrl.list);
router.post('/', ctrl.create);
export default router;
