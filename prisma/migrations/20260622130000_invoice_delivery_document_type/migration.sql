-- Additive: track whether a delivery log carried the INVOICE or the RECEIPT (kwitansi).
-- Safe/backfill-friendly: new enum + nullable-with-default column; existing rows default to INVOICE.
CREATE TYPE "InvoiceDeliveryDocument" AS ENUM ('INVOICE', 'RECEIPT');

ALTER TABLE "invoice_delivery_logs"
  ADD COLUMN "document_type" "InvoiceDeliveryDocument" NOT NULL DEFAULT 'INVOICE';
