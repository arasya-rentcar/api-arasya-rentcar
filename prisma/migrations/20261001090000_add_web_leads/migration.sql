-- CreateEnum
CREATE TYPE "WebLeadStatus" AS ENUM ('NEW', 'CONVERTED', 'IGNORED');

-- CreateTable
CREATE TABLE "web_leads" (
    "id" TEXT NOT NULL,
    "lead_code" TEXT NOT NULL,
    "status" "WebLeadStatus" NOT NULL DEFAULT 'NEW',
    "name" TEXT NOT NULL,
    "trip_date" TEXT,
    "pickup_time" TEXT,
    "pickup_location" TEXT NOT NULL,
    "destination" TEXT,
    "unit" TEXT,
    "passenger_count" INTEGER,
    "duration" TEXT,
    "notes" TEXT,
    "page_path" TEXT,
    "language" TEXT,
    "campaign" TEXT,
    "gclid" TEXT,
    "ga_client_id" TEXT,
    "ga_session_id" TEXT,
    "ignore_reason" TEXT,
    "order_id" TEXT,
    "purchase_reported_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "web_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "web_leads_lead_code_key" ON "web_leads"("lead_code");

-- CreateIndex
CREATE UNIQUE INDEX "web_leads_order_id_key" ON "web_leads"("order_id");

-- CreateIndex
CREATE INDEX "web_leads_status_idx" ON "web_leads"("status");

-- CreateIndex
CREATE INDEX "web_leads_created_at_idx" ON "web_leads"("created_at");

-- AddForeignKey
ALTER TABLE "web_leads" ADD CONSTRAINT "web_leads_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

