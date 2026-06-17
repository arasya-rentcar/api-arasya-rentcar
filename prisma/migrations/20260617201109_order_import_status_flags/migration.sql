-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "invoice_missing" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_final" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "is_refunded" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "orders_is_final_idx" ON "orders"("is_final");

-- CreateIndex
CREATE INDEX "orders_invoice_missing_idx" ON "orders"("invoice_missing");

-- CreateIndex
CREATE INDEX "orders_is_refunded_idx" ON "orders"("is_refunded");
