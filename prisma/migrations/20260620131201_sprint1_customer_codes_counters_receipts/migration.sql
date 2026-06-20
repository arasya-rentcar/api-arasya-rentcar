-- AlterTable
ALTER TABLE "cars" ADD COLUMN     "photo_url" TEXT,
ADD COLUMN     "photos" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "code" TEXT NOT NULL,
ADD COLUMN     "invoice_seq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "kwitansi_seq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "order_seq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "total_billed" DECIMAL(14,2) NOT NULL DEFAULT 0,
ADD COLUMN     "total_paid" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "customer_seq" INTEGER,
ADD COLUMN     "payment_proof_url" TEXT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "customer_seq" INTEGER,
ADD COLUMN     "paid_to_date" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "payables" ADD COLUMN     "payment_proof_url" TEXT;

-- CreateTable
CREATE TABLE "counters" (
    "scope" TEXT NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "counters_pkey" PRIMARY KEY ("scope")
);

-- CreateTable
CREATE TABLE "receipts" (
    "id" TEXT NOT NULL,
    "receipt_number" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "customer_seq" INTEGER NOT NULL,
    "payment_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "amount" DECIMAL(12,2) NOT NULL,
    "payment_method" "PaymentMethod" NOT NULL DEFAULT 'CASH',
    "payment_proof_url" TEXT,
    "file_url" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "receipts_receipt_number_key" ON "receipts"("receipt_number");

-- CreateIndex
CREATE INDEX "receipts_invoice_id_idx" ON "receipts"("invoice_id");

-- CreateIndex
CREATE INDEX "receipts_customer_id_idx" ON "receipts"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "customers_code_key" ON "customers"("code");

-- CreateIndex
CREATE INDEX "customers_code_idx" ON "customers"("code");

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Seed the global customer counter
INSERT INTO "counters" ("scope", "value", "updated_at") VALUES ('customer', 0, now()) ON CONFLICT ("scope") DO NOTHING;
