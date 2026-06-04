-- Arasya bot/web operational integration fields

CREATE TYPE "OrderSource" AS ENUM ('WEB', 'WHATSAPP', 'IMPORT');
CREATE TYPE "ReportInputType" AS ENUM ('TEXT', 'IMAGE', 'PDF', 'DOCUMENT', 'MIXED');
CREATE TYPE "ReportSource" AS ENUM ('WHATSAPP', 'WEB', 'API');
CREATE TYPE "ReportStatus" AS ENUM ('MATCHED', 'UNMATCHED', 'NEEDS_REVIEW');

ALTER TABLE "orders"
  ADD COLUMN "order_code" TEXT,
  ADD COLUMN "source" "OrderSource" NOT NULL DEFAULT 'WEB',
  ADD COLUMN "service_type" TEXT,
  ADD COLUMN "passenger_count" INTEGER,
  ADD COLUMN "notes" TEXT,
  ADD COLUMN "area" TEXT,
  ADD COLUMN "driver_origin" TEXT,
  ADD COLUMN "raw_order_text" TEXT,
  ADD COLUMN "whatsapp_message_id" TEXT,
  ADD COLUMN "driver_message_sent_at" TIMESTAMP(3),
  ADD COLUMN "needs_review" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "review_reason" TEXT;

CREATE UNIQUE INDEX "orders_order_code_key" ON "orders"("order_code");
CREATE INDEX "orders_order_code_idx" ON "orders"("order_code");
CREATE INDEX "orders_source_idx" ON "orders"("source");
CREATE INDEX "orders_order_status_idx" ON "orders"("order_status");
CREATE INDEX "orders_needs_review_idx" ON "orders"("needs_review");

CREATE TABLE "order_customers" (
  "id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "phone" TEXT,
  "is_primary" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_customers_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "order_customers_order_id_idx" ON "order_customers"("order_id");
ALTER TABLE "order_customers" ADD CONSTRAINT "order_customers_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "trip_reports" (
  "id" TEXT NOT NULL,
  "order_id" TEXT,
  "trip_id" TEXT,
  "order_code" TEXT,
  "driver_id" TEXT,
  "driver_phone" TEXT,
  "report_type" TEXT NOT NULL,
  "input_type" "ReportInputType" NOT NULL DEFAULT 'TEXT',
  "notes" TEXT,
  "extracted_text" TEXT,
  "file_url" TEXT,
  "file_mime" TEXT,
  "match_method" TEXT,
  "source" "ReportSource" NOT NULL DEFAULT 'WHATSAPP',
  "status" "ReportStatus" NOT NULL DEFAULT 'MATCHED',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "trip_reports_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "trip_reports_order_id_idx" ON "trip_reports"("order_id");
CREATE INDEX "trip_reports_trip_id_idx" ON "trip_reports"("trip_id");
CREATE INDEX "trip_reports_order_code_idx" ON "trip_reports"("order_code");
CREATE INDEX "trip_reports_driver_phone_idx" ON "trip_reports"("driver_phone");
CREATE INDEX "trip_reports_report_type_idx" ON "trip_reports"("report_type");
CREATE INDEX "trip_reports_status_idx" ON "trip_reports"("status");
ALTER TABLE "trip_reports" ADD CONSTRAINT "trip_reports_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "trip_reports" ADD CONSTRAINT "trip_reports_trip_id_fkey" FOREIGN KEY ("trip_id") REFERENCES "trips"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "trip_reports" ADD CONSTRAINT "trip_reports_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "order_summaries" (
  "id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "start_received" BOOLEAN NOT NULL DEFAULT false,
  "finish_received" BOOLEAN NOT NULL DEFAULT false,
  "docs_received" INTEGER NOT NULL DEFAULT 0,
  "photos_count" INTEGER NOT NULL DEFAULT 0,
  "missing_items" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "e_toll_start" DECIMAL(12,2),
  "e_toll_used" DECIMAL(12,2),
  "e_toll_end" DECIMAL(12,2),
  "bbm_total" DECIMAL(12,2),
  "parking_total" DECIMAL(12,2),
  "odometer_start" DECIMAL(12,2),
  "odometer_finish" DECIMAL(12,2),
  "distance_km" DECIMAL(12,2),
  "fuel_liters" DECIMAL(12,2),
  "km_per_liter" DECIMAL(12,2),
  "generated_summary" TEXT,
  "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "order_summaries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "order_summaries_order_id_key" ON "order_summaries"("order_id");
ALTER TABLE "order_summaries" ADD CONSTRAINT "order_summaries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
