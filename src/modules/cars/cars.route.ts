import { Router } from 'express';
import multer from 'multer';
import { verifyTokenMiddleware, requireRole } from '../../middleware/auth.middleware';
import {
  createCarController,
  listCarsController,
  getCarByIdController,
  updateCarController,
  uploadCarPhotoController,
} from './cars.controller';

const router = Router();

// Sprint 3: in-memory upload for car photo (validated in the service layer).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

router.use(verifyTokenMiddleware, requireRole('ADMIN'));

router.post('/', createCarController);
router.get('/', listCarsController);
router.get('/:id', getCarByIdController);
router.put('/:id', updateCarController);
router.post('/:id/photo', upload.single('photo'), uploadCarPhotoController);

export default router;
