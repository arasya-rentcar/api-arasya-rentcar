import { Router } from 'express';
import multer from 'multer';
import {
  verifyTokenMiddleware,
  requireRole,
} from '../../middleware/auth.middleware';
import {
  createCustomerController,
  listCustomersController,
  getCustomerByIdController,
  updateCustomerController,
  lookupCustomerController,
  uploadCustomerDocumentController,
  getCustomerDocumentUrlController,
  deleteCustomerDocumentController,
  verifyCustomerController,
} from './customers.controller';

// Identity documents: in-memory upload, validated (mime/size) in the service.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const router = Router();

router.use(verifyTokenMiddleware, requireRole('ADMIN'));

router.post('/', createCustomerController);
router.get('/', listCustomersController);
// Must stay above GET /:id so "lookup" is not read as a customer id.
router.get('/lookup', lookupCustomerController);
router.get('/:id', getCustomerByIdController);
router.put('/:id', updateCustomerController);
router.post('/:id/verify', verifyCustomerController);
router.post(
  '/:id/documents',
  upload.single('file'),
  uploadCustomerDocumentController,
);
router.get('/:id/documents/:docId/url', getCustomerDocumentUrlController);
router.delete('/:id/documents/:docId', deleteCustomerDocumentController);

export default router;
