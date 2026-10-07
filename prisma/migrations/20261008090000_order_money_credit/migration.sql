-- CreateEnum
CREATE TYPE "CreditEntryKind" AS ENUM ('OPENING', 'OVERPAYMENT', 'RELEASE', 'APPLIED', 'UNAPPLIED', 'REFUND');

-- AlterEnum
ALTER TYPE "InvoiceType" ADD VALUE 'ADJUSTMENT';

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "cancel_client_ref" TEXT,
ADD COLUMN     "cancellation_rule" TEXT,
ADD COLUMN     "credit_balance" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "refunded_total" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "adjusts_invoice_id" TEXT,
ADD COLUMN     "amount_received" DECIMAL(12,2),
ADD COLUMN     "client_ref" TEXT,
ADD COLUMN     "credit_applied" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "order_adjustments" ADD COLUMN     "client_ref" TEXT;

-- CreateTable
CREATE TABLE "order_refunds" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "refunded_at" TIMESTAMP(3) NOT NULL,
    "proof_url" TEXT,
    "note" TEXT,
    "client_ref" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_credit_entries" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "kind" "CreditEntryKind" NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "invoice_id" TEXT,
    "refund_id" TEXT,
    "service_item_id" TEXT,
    "note" TEXT,
    "actor" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_credit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "order_refunds_client_ref_key" ON "order_refunds"("client_ref");

-- CreateIndex
CREATE INDEX "order_refunds_order_id_idx" ON "order_refunds"("order_id");

-- CreateIndex
CREATE INDEX "order_credit_entries_order_id_idx" ON "order_credit_entries"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "orders_cancel_client_ref_key" ON "orders"("cancel_client_ref");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_client_ref_key" ON "invoices"("client_ref");

-- CreateIndex
CREATE UNIQUE INDEX "order_adjustments_client_ref_key" ON "order_adjustments"("client_ref");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_adjusts_invoice_id_fkey" FOREIGN KEY ("adjusts_invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_refunds" ADD CONSTRAINT "order_refunds_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_credit_entries" ADD CONSTRAINT "order_credit_entries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_credit_entries" ADD CONSTRAINT "order_credit_entries_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_credit_entries" ADD CONSTRAINT "order_credit_entries_refund_id_fkey" FOREIGN KEY ("refund_id") REFERENCES "order_refunds"("id") ON DELETE SET NULL ON UPDATE CASCADE;



-- Hand-written (Prisma cannot express CHECK constraints or partial indexes),
-- finance design §4 migration 1 and §6.
-- 'ADJUSTMENT' (added above) is not used anywhere in this migration: Prisma
-- runs the file as one transaction, and a new enum value cannot be used before
-- that transaction commits.
ALTER TABLE "orders" ADD CONSTRAINT "orders_credit_balance_nonneg" CHECK ("credit_balance" >= 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_refunded_total_nonneg" CHECK ("refunded_total" >= 0);
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_credit_applied_nonneg" CHECK ("credit_applied" >= 0);
ALTER TABLE "order_refunds" ADD CONSTRAINT "order_refunds_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "order_credit_entries" ADD CONSTRAINT "order_credit_entries_amount_nonzero" CHECK ("amount" <> 0);

-- Foreign keys used in lookups (Postgres does not index them by itself).
CREATE INDEX "invoices_adjusts_invoice_id_idx" ON "invoices"("adjusts_invoice_id");
CREATE INDEX "order_credit_entries_invoice_id_idx" ON "order_credit_entries"("invoice_id");
CREATE INDEX "order_credit_entries_refund_id_idx" ON "order_credit_entries"("refund_id");

-- INV-8: at most one OVERPAYMENT entry per invoice and one REFUND entry per refund.
CREATE UNIQUE INDEX "credit_one_overpayment_per_invoice" ON "order_credit_entries"("invoice_id") WHERE "kind" = 'OVERPAYMENT';
CREATE UNIQUE INDEX "credit_one_entry_per_refund" ON "order_credit_entries"("refund_id") WHERE "kind" = 'REFUND';


-- Supabase: the public schema runs with RLS on and no policies (the API
-- connects as the table owner). New tables must follow, or anon/authenticated
-- could reach them through the REST API.
ALTER TABLE "order_refunds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order_credit_entries" ENABLE ROW LEVEL SECURITY;


-- Backfill (finance design §10). Only reads columns that existed before, and
-- safe to run again by hand: nothing is inserted twice or overwritten.

-- 1. Refunds: refunded_total, and one order_refunds row per refunded order
--    (the old endpoint kept one refund per order, overwritten on re-marking).
UPDATE "orders"
SET "refunded_total" = "refund_amount"
WHERE "is_refunded" AND COALESCE("refund_amount", 0) > 0;

INSERT INTO "order_refunds" ("id", "order_id", "amount", "refunded_at", "proof_url", "note", "client_ref", "created_by", "created_at")
SELECT gen_random_uuid()::text, o."id", o."refund_amount", COALESCE(o."refunded_at", o."updated_at"),
       o."refund_proof_url", o."refund_note", 'legacy-' || o."id", 'migration', COALESCE(o."refunded_at", o."updated_at")
FROM "orders" o
WHERE o."is_refunded" AND COALESCE(o."refund_amount", 0) > 0
ON CONFLICT ("client_ref") DO NOTHING;

-- 2. The money actually taken on each payment: the first receipt (the one
--    paid_to_date counts), or the invoice amount for old rows without one.
UPDATE "invoices" i
SET "amount_received" = COALESCE(
  (SELECT r."amount" FROM "receipts" r WHERE r."invoice_id" = i."id" ORDER BY r."created_at" ASC, r."id" ASC LIMIT 1),
  i."amount")
WHERE (i."status" = 'PAID' OR (i."status" = 'CANCELLED' AND i."paid_at" IS NOT NULL))
  AND i."amount_received" IS NULL;

-- 3. Saldo lebih already held: money received beyond the order total, net of
--    refunds (so legacy refunds need no REFUND entry). Sheet imports
--    (paid_to_date = 0) are skipped.
INSERT INTO "order_credit_entries" ("id", "order_id", "kind", "amount", "note", "actor", "created_at")
SELECT gen_random_uuid()::text, o."id", 'OPENING', o."paid_to_date" - o."refunded_total" - o."final_price",
       'Saldo lebih awal (migrasi): uang diterima dikurangi pengembalian dan total order', 'migration', CURRENT_TIMESTAMP
FROM "orders" o
WHERE o."paid_to_date" > 0 AND o."paid_to_date" - o."refunded_total" - o."final_price" > 0
  AND NOT EXISTS (SELECT 1 FROM "order_credit_entries" e WHERE e."order_id" = o."id" AND e."kind" = 'OPENING');

-- credit_balance = Σ entries (INV-2).
UPDATE "orders" o
SET "credit_balance" = e."total"
FROM (SELECT "order_id", SUM("amount") AS "total" FROM "order_credit_entries" GROUP BY "order_id") e
WHERE e."order_id" = o."id";

-- 4. Orders cancelled before this release used the whole-order fee and keep
--    their frozen final_price.
UPDATE "orders"
SET "cancellation_rule" = 'ORDER_V1'
WHERE "cancellation_fee" IS NOT NULL;
