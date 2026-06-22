-- Batch 2.5: drop the redundant per-line trip_status column.
-- The line IS the trip; line_status (ScheduleStatus) is the single per-line
-- state. trip_status would have duplicated it 1:1. Column held no real data
-- (added same day, never populated). Timestamps trip_started_at /
-- trip_finished_at are retained for the per-line timeline.

DROP INDEX IF EXISTS "order_service_items_trip_status_idx";

ALTER TABLE "order_service_items" DROP COLUMN IF EXISTS "trip_status";
