-- CreateEnum
CREATE TYPE "PayableKind" AS ENUM ('DRIVER', 'VENDOR');

-- CreateEnum
CREATE TYPE "PayableStatus" AS ENUM ('UNPAID', 'PAID');

-- CreateTable
CREATE TABLE "payables" (
    "id" TEXT NOT NULL,
    "kind" "PayableKind" NOT NULL,
    "status" "PayableStatus" NOT NULL DEFAULT 'UNPAID',
    "service_item_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "driver_id" TEXT,
    "vendor_id" TEXT,
    "service_date" TIMESTAMP(3),
    "base_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "extras_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "keterangan" TEXT,
    "paid_at" TIMESTAMP(3),
    "payment_method" "PaymentMethod",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payable_extras" (
    "id" TEXT NOT NULL,
    "payable_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payable_extras_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payables_service_item_id_key" ON "payables"("service_item_id");

-- CreateIndex
CREATE INDEX "payables_kind_idx" ON "payables"("kind");

-- CreateIndex
CREATE INDEX "payables_status_idx" ON "payables"("status");

-- CreateIndex
CREATE INDEX "payables_driver_id_idx" ON "payables"("driver_id");

-- CreateIndex
CREATE INDEX "payables_vendor_id_idx" ON "payables"("vendor_id");

-- CreateIndex
CREATE INDEX "payables_order_id_idx" ON "payables"("order_id");

-- CreateIndex
CREATE INDEX "payables_service_date_idx" ON "payables"("service_date");

-- CreateIndex
CREATE INDEX "payable_extras_payable_id_idx" ON "payable_extras"("payable_id");

-- AddForeignKey
ALTER TABLE "payables" ADD CONSTRAINT "payables_service_item_id_fkey" FOREIGN KEY ("service_item_id") REFERENCES "order_service_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payables" ADD CONSTRAINT "payables_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payables" ADD CONSTRAINT "payables_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payables" ADD CONSTRAINT "payables_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "external_vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payable_extras" ADD CONSTRAINT "payable_extras_payable_id_fkey" FOREIGN KEY ("payable_id") REFERENCES "payables"("id") ON DELETE CASCADE ON UPDATE CASCADE;
