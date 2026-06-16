import { Router } from "express";
import { verifyTokenMiddleware, requireRole } from "../../middleware/auth.middleware";
import { importSheetRowsController, latestSheetImportRowsController, previewSheetImportController } from "./sheet-imports.controller";

const router = Router();

router.use(verifyTokenMiddleware, requireRole("ADMIN"));
router.post("/preview", previewSheetImportController);
router.post("/import", importSheetRowsController);
router.get("/latest", latestSheetImportRowsController);

export default router;
