-- CreateEnum
CREATE TYPE "ScheduleStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'DONE', 'CANCELLED');

-- AlterTable
ALTER TABLE "order_service_items" ADD COLUMN     "car_id" TEXT,
ADD COLUMN     "driver_id" TEXT,
ADD COLUMN     "driver_name_raw" TEXT,
ADD COLUMN     "external_car_id" TEXT,
ADD COLUMN     "external_vendor_id" TEXT,
ADD COLUMN     "is_external" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "line_status" "ScheduleStatus" NOT NULL DEFAULT 'SCHEDULED',
ADD COLUMN     "margin_amount" DECIMAL(12,2),
ADD COLUMN     "margin_formula_version" TEXT,
ADD COLUMN     "ops_cost" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "plate_raw" TEXT,
ADD COLUMN     "rtr_amount" DECIMAL(12,2);

-- CreateIndex
CREATE INDEX "order_service_items_driver_id_idx" ON "order_service_items"("driver_id");

-- CreateIndex
CREATE INDEX "order_service_items_car_id_idx" ON "order_service_items"("car_id");

-- CreateIndex
CREATE INDEX "order_service_items_external_vendor_id_idx" ON "order_service_items"("external_vendor_id");

-- CreateIndex
CREATE INDEX "order_service_items_line_status_idx" ON "order_service_items"("line_status");

-- AddForeignKey
ALTER TABLE "order_service_items" ADD CONSTRAINT "order_service_items_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_service_items" ADD CONSTRAINT "order_service_items_car_id_fkey" FOREIGN KEY ("car_id") REFERENCES "cars"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_service_items" ADD CONSTRAINT "order_service_items_external_vendor_id_fkey" FOREIGN KEY ("external_vendor_id") REFERENCES "external_vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_service_items" ADD CONSTRAINT "order_service_items_external_car_id_fkey" FOREIGN KEY ("external_car_id") REFERENCES "external_cars"("id") ON DELETE SET NULL ON UPDATE CASCADE;
