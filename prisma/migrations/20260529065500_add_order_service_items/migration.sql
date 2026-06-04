CREATE TABLE IF NOT EXISTS "order_service_items" (
  "id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "service_date" TIMESTAMP(3),
  "start_at" TIMESTAMP(3),
  "end_at" TIMESTAMP(3),
  "description" TEXT,
  "pickup_location" TEXT NOT NULL,
  "dropoff_location" TEXT NOT NULL,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "unit_price" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "total_price" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "notes" TEXT,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_service_items_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "order_service_items"
ADD CONSTRAINT "order_service_items_order_id_fkey"
FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "order_service_items_order_id_idx" ON "order_service_items"("order_id");
CREATE INDEX IF NOT EXISTS "order_service_items_service_date_idx" ON "order_service_items"("service_date");
