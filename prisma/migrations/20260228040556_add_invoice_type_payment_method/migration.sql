-- CreateEnum
CREATE TYPE "InvoiceType" AS ENUM ('DP', 'SETTLEMENT', 'FULL');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'QRIS', 'OTHER');

-- DropIndex
DROP INDEX "invoices_order_id_key";

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "invoice_type" "InvoiceType" NOT NULL DEFAULT 'FULL',
ADD COLUMN     "note" TEXT,
ADD COLUMN     "payment_method" "PaymentMethod" NOT NULL DEFAULT 'CASH';
