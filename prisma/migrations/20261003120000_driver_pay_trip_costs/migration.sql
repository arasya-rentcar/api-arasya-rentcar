-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ExpensePayer" AS ENUM ('DRIVER', 'COMPANY');

-- AlterTable
ALTER TABLE "order_service_items" ADD COLUMN     "driver_fee" DECIMAL(12,2),
ADD COLUMN     "driver_fee_note" TEXT,
ADD COLUMN     "travel_advance" DECIMAL(12,2);

-- AlterTable
ALTER TABLE "payables" ADD COLUMN     "advance_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "reimburse_amount" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "expenses" ADD COLUMN     "adjustment_id" TEXT,
ADD COLUMN     "bill_to_customer" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "created_by" TEXT,
ADD COLUMN     "paid_by" "ExpensePayer" NOT NULL DEFAULT 'DRIVER',
ADD COLUMN     "review_note" TEXT,
ADD COLUMN     "reviewed_at" TIMESTAMP(3),
ADD COLUMN     "reviewed_by" TEXT,
ADD COLUMN     "status" "ExpenseStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "trip_report_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "expenses_trip_report_id_key" ON "expenses"("trip_report_id");

-- CreateIndex
CREATE UNIQUE INDEX "expenses_adjustment_id_key" ON "expenses"("adjustment_id");

-- CreateIndex
CREATE INDEX "expenses_status_idx" ON "expenses"("status");

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_trip_report_id_fkey" FOREIGN KEY ("trip_report_id") REFERENCES "trip_reports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_adjustment_id_fkey" FOREIGN KEY ("adjustment_id") REFERENCES "order_adjustments"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Backfill: until now "Biaya Ops" on an internal day was the driver's pay
-- (it was the driver payable base). Move it to driver_fee; ops_cost now holds
-- Arasya's share of approved trip costs (none approved yet). The day margin
-- (revenue − old ops_cost) equals revenue − driver_fee, so it stays valid.
-- One-time data move (reviewed 3 Oct): only days that had a driver and were
-- not cancelled; a cancelled day keeps its old value as a trip cost.
UPDATE "order_service_items"
SET "driver_fee" = "ops_cost", "ops_cost" = 0
WHERE "is_external" = false AND "driver_fee" IS NULL AND "ops_cost" > 0
  AND "driver_id" IS NOT NULL AND "line_status" <> 'CANCELLED';
