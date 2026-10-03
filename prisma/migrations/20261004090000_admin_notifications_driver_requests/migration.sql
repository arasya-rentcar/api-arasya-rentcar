-- CreateEnum
CREATE TYPE "DriverRequestType" AS ENUM ('ETOLL_TOPUP');

-- CreateEnum
CREATE TYPE "DriverRequestStatus" AS ENUM ('OPEN', 'DONE', 'CANCELLED');

-- AlterTable
ALTER TABLE "drivers" ADD COLUMN     "etoll_card" TEXT;

-- AlterTable
ALTER TABLE "trip_reports" ADD COLUMN     "location_name" TEXT;

-- CreateTable
CREATE TABLE "driver_requests" (
    "id" TEXT NOT NULL,
    "driver_id" TEXT NOT NULL,
    "type" "DriverRequestType" NOT NULL,
    "card_label" TEXT,
    "balance" DECIMAL(12,2),
    "note" TEXT,
    "status" "DriverRequestStatus" NOT NULL DEFAULT 'OPEN',
    "client_ref" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handled_at" TIMESTAMP(3),
    "handled_by" TEXT,
    "handled_note" TEXT,

    CONSTRAINT "driver_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_notifications" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "order_id" TEXT,
    "order_code" TEXT,
    "service_item_id" TEXT,
    "driver_id" TEXT,
    "driver_request_id" TEXT,
    "expense_id" TEXT,
    "link" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_notification_reads" (
    "id" TEXT NOT NULL,
    "notification_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_notification_reads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "driver_requests_client_ref_key" ON "driver_requests"("client_ref");

-- CreateIndex
CREATE INDEX "driver_requests_driver_id_created_at_idx" ON "driver_requests"("driver_id", "created_at");

-- CreateIndex
CREATE INDEX "driver_requests_status_created_at_idx" ON "driver_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "admin_notifications_created_at_idx" ON "admin_notifications"("created_at");

-- CreateIndex
CREATE INDEX "admin_notifications_service_item_id_idx" ON "admin_notifications"("service_item_id");

-- CreateIndex
CREATE INDEX "admin_notification_reads_user_id_idx" ON "admin_notification_reads"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "admin_notification_reads_notification_id_user_id_key" ON "admin_notification_reads"("notification_id", "user_id");

-- AddForeignKey
ALTER TABLE "driver_requests" ADD CONSTRAINT "driver_requests_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_notification_reads" ADD CONSTRAINT "admin_notification_reads_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "admin_notifications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_notification_reads" ADD CONSTRAINT "admin_notification_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

