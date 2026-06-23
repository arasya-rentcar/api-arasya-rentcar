-- AlterTable
ALTER TABLE "order_service_items" ADD COLUMN     "actual_pickup_at" TIMESTAMP(3),
ADD COLUMN     "actual_start_at" TIMESTAMP(3),
ADD COLUMN     "finish_reported_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "awaiting_finalization" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "orders_awaiting_finalization_idx" ON "orders"("awaiting_finalization");
