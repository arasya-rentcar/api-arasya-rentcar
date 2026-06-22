-- Batch 4: drop the dead order-level Trip model.
-- The line IS the trip now (OrderServiceItem carries driver/car/line_status +
-- trip_started_at/trip_finished_at). All trips/trip_logs are 0 rows and every
-- expense/trip_report already points at order_service_item_id (legacy trip_id
-- is null everywhere). Idempotent guards so deploy is replay-safe.

-- 1. Drop legacy trip_id FK columns + their constraints/indexes.
ALTER TABLE "expenses"      DROP CONSTRAINT IF EXISTS "expenses_trip_id_fkey";
ALTER TABLE "trip_reports"  DROP CONSTRAINT IF EXISTS "trip_reports_trip_id_fkey";
DROP INDEX IF EXISTS "trip_reports_trip_id_idx";
ALTER TABLE "expenses"      DROP COLUMN IF EXISTS "trip_id";
ALTER TABLE "trip_reports"  DROP COLUMN IF EXISTS "trip_id";

-- 2. Drop trip_logs (child) then trips (parent).
DROP TABLE IF EXISTS "trip_logs";
DROP TABLE IF EXISTS "trips";

-- 3. Drop now-unused enums.
DROP TYPE IF EXISTS "TripStatus";
DROP TYPE IF EXISTS "Actor";
