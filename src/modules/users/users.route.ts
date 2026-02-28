import { Router } from 'express';
import { verifyTokenMiddleware, requireRole } from '../../middleware/auth.middleware';
import { createUserController, listUsersController } from './users.controller';

const router = Router();

router.use(verifyTokenMiddleware, requireRole('ADMIN'));

router.post('/', createUserController);
router.get('/', listUsersController);

export default router;
