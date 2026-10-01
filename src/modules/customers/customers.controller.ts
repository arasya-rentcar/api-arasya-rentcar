import { Request, Response, NextFunction } from 'express';
import {
  createCustomerSchema,
  updateCustomerSchema,
  listCustomersQuerySchema,
  lookupCustomerQuerySchema,
  uploadCustomerDocumentSchema,
  verifyCustomerSchema,
} from './customers.validation';
import {
  createCustomer,
  listCustomers,
  getCustomerById,
  updateCustomer,
  lookupCustomerByPhone,
  addCustomerDocument,
  getCustomerDocumentUrl,
  deleteCustomerDocument,
  setCustomerVerified,
} from './customers.service';

export async function createCustomerController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = createCustomerSchema.parse(req.body);
    const customer = await createCustomer(input);
    res.status(201).json({ status: 'success', data: customer });
  } catch (err) {
    next(err);
  }
}

export async function listCustomersController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const query = listCustomersQuerySchema.parse(req.query);
    const result = await listCustomers(query);
    res.json({ status: 'success', ...result });
  } catch (err) {
    next(err);
  }
}

export async function getCustomerByIdController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const ordersPage = req.query.orders_page
      ? Number(req.query.orders_page)
      : 1;
    const customer = await getCustomerById(req.params.id, ordersPage);
    res.json({ status: 'success', data: customer });
  } catch (err) {
    next(err);
  }
}

export async function updateCustomerController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = updateCustomerSchema.parse(req.body);
    const customer = await updateCustomer(req.params.id, input);
    res.json({ status: 'success', data: customer });
  } catch (err) {
    next(err);
  }
}

/** GET /customers/lookup?phone= — repeat-customer match for the order form. */
export async function lookupCustomerController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { phone } = lookupCustomerQuerySchema.parse(req.query);
    const data = await lookupCustomerByPhone(phone);
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
}

/** POST /customers/:id/documents (multipart: file, kind, note). */
export async function uploadCustomerDocumentController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const input = uploadCustomerDocumentSchema.parse(req.body);
    const doc = await addCustomerDocument(
      req.params.id,
      req.file,
      input,
      req.user?.user_id,
    );
    res.status(201).json({ status: 'success', data: doc });
  } catch (err) {
    next(err);
  }
}

/** GET /customers/:id/documents/:docId/url — 5-minute signed URL. */
export async function getCustomerDocumentUrlController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const data = await getCustomerDocumentUrl(req.params.id, req.params.docId);
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
}

/** DELETE /customers/:id/documents/:docId */
export async function deleteCustomerDocumentController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await deleteCustomerDocument(req.params.id, req.params.docId);
    res.status(204).end();
  } catch (err) {
    next(err);
  }
}

/** POST /customers/:id/verify { verified } */
export async function verifyCustomerController(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const { verified } = verifyCustomerSchema.parse(req.body);
    const data = await setCustomerVerified(
      req.params.id,
      verified,
      req.user?.user_id,
    );
    res.json({ status: 'success', data });
  } catch (err) {
    next(err);
  }
}
