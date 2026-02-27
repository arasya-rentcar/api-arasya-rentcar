import express from 'express';
import * as ctrl from '../controllers/driversController.js';

const router = express.Router();

router.get('/', ctrl.listDrivers);
router.post('/', ctrl.createDriver);
router.get('/:id', ctrl.getDriverById);
router.put('/:id', ctrl.updateDriver);
router.patch('/:id/status', ctrl.updateDriverStatus);

export default router;
