-- Additive per-line trip journey + ASSIGNED schedule status.
-- Purely additive: new enum value, 3 nullable columns, 1 index. No drops.

-- AlterEnum
ALTER TYPE "ScheduleStatus" ADD VALUE IF NOT EXISTS 'ASSIGNED';

-- AlterTable
ALTER TABLE "order_service_items"
  ADD COLUMN IF NOT EXISTS "trip_status" "TripStatus",
  ADD COLUMN IF NOT EXISTS "trip_started_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "trip_finished_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "order_service_items_trip_status_idx" ON "order_service_items"("trip_status");
