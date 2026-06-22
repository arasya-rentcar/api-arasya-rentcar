-- Batch 3a: re-point Expense + TripReport to the service-day line.
-- The line IS the trip. Additive + relaxing: adds order_service_item_id FKs,
-- makes Expense.trip_id nullable (legacy, dropped in batch 4). 0 rows so no
-- backfill needed. Old trip_id kept temporarily so nothing breaks mid-cutover.

-- expenses: make legacy trip_id nullable, add new line FK
ALTER TABLE "expenses" DROP CONSTRAINT IF EXISTS "expenses_trip_id_fkey";
ALTER TABLE "expenses" ALTER COLUMN "trip_id" DROP NOT NULL;
ALTER TABLE "expenses" ADD COLUMN IF NOT EXISTS "order_service_item_id" TEXT;
CREATE INDEX IF NOT EXISTS "expenses_order_service_item_id_idx" ON "expenses"("order_service_item_id");
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_trip_id_fkey"
  FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_order_service_item_id_fkey"
  FOREIGN KEY ("order_service_item_id") REFERENCES "order_service_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- trip_reports: add new line FK (trip_id already nullable)
ALTER TABLE "trip_reports" ADD COLUMN IF NOT EXISTS "order_service_item_id" TEXT;
CREATE INDEX IF NOT EXISTS "trip_reports_order_service_item_id_idx" ON "trip_reports"("order_service_item_id");
ALTER TABLE "trip_reports" ADD CONSTRAINT "trip_reports_order_service_item_id_fkey"
  FOREIGN KEY ("order_service_item_id") REFERENCES "order_service_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
