ALTER TABLE "orders"
ADD COLUMN IF NOT EXISTS "service_start_at" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "service_end_at" TIMESTAMP(3);

UPDATE "orders"
SET "service_start_at" = "order_date"
WHERE "service_start_at" IS NULL;

CREATE INDEX IF NOT EXISTS "orders_service_start_at_idx" ON "orders"("service_start_at");
CREATE INDEX IF NOT EXISTS "orders_service_end_at_idx" ON "orders"("service_end_at");
