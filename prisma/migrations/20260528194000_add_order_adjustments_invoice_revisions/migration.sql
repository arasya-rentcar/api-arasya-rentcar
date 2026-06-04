-- Order adjustment and invoice revision foundation.
ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'DRAFT';
ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'REVISED';
ALTER TYPE "InvoiceStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "InvoiceType" ADD VALUE IF NOT EXISTS 'ADDITIONAL';

CREATE TYPE "OrderAdjustmentType" AS ENUM (
  'ROUTE_CHANGE',
  'TIME_CHANGE',
  'EXTRA_DESTINATION',
  'OVERTIME',
  'PARKING',
  'TOLL',
  'FUEL',
  'DISCOUNT',
  'OTHER'
);

ALTER TABLE "invoices"
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "parent_id" TEXT,
  ADD COLUMN "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_parent_id_fkey"
  FOREIGN KEY ("parent_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "invoices_order_id_idx" ON "invoices"("order_id");
CREATE INDEX "invoices_parent_id_idx" ON "invoices"("parent_id");
CREATE INDEX "invoices_status_idx" ON "invoices"("status");

CREATE TABLE "order_adjustments" (
  "id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "type" "OrderAdjustmentType" NOT NULL DEFAULT 'OTHER',
  "description" TEXT NOT NULL,
  "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "is_billable" BOOLEAN NOT NULL DEFAULT true,
  "created_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_adjustments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "order_adjustments_order_id_idx" ON "order_adjustments"("order_id");
CREATE INDEX "order_adjustments_type_idx" ON "order_adjustments"("type");
ALTER TABLE "order_adjustments"
  ADD CONSTRAINT "order_adjustments_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "order_change_logs" (
  "id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "field" TEXT,
  "old_value" TEXT,
  "new_value" TEXT,
  "note" TEXT,
  "actor" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_change_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "order_change_logs_order_id_idx" ON "order_change_logs"("order_id");
ALTER TABLE "order_change_logs"
  ADD CONSTRAINT "order_change_logs_order_id_fkey"
  FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
