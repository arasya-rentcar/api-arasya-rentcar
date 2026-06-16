import { Request, Response, NextFunction } from "express";
import { z } from "zod";
import { importSheetRows, latestSheetImportRows, previewSheetImport } from "./sheet-imports.service";

const importOptionsSchema = z.object({
  sheetId: z.string().optional(),
  gid: z.string().optional(),
  csvText: z.string().optional(),
  url: z.string().url().optional(),
});

export async function previewSheetImportController(req: Request, res: Response, next: NextFunction) {
  try {
    const input = importOptionsSchema.parse(req.body || {});
    const data = await previewSheetImport(input);
    res.json({ status: "success", data });
  } catch (err) {
    next(err);
  }
}

export async function importSheetRowsController(req: Request, res: Response, next: NextFunction) {
  try {
    const input = importOptionsSchema.parse(req.body || {});
    const data = await importSheetRows(input);
    res.status(201).json({ status: "success", data });
  } catch (err) {
    next(err);
  }
}

export async function latestSheetImportRowsController(_req: Request, res: Response, next: NextFunction) {
  try {
    const data = await latestSheetImportRows();
    res.json({ status: "success", data });
  } catch (err) {
    next(err);
  }
}
