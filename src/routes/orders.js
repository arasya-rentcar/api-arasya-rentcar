import express from 'express';
import ctrl from '../controllers/ordersController.js';

const router = express.Router();

router.get('/', ctrl.list);
router.post('/', ctrl.create);
router.get('/:id', ctrl.detail);
router.put('/:id', ctrl.update);
router.post('/:id/status', ctrl.addStatus);

export default router;