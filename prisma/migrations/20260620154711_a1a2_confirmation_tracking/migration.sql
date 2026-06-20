-- AlterTable
ALTER TABLE "order_service_items" ADD COLUMN     "confirmation_sent_at" TIMESTAMP(3),
ADD COLUMN     "confirmation_sent_snapshot" JSONB,
ADD COLUMN     "driver_reminder_sent_at" TIMESTAMP(3),
ADD COLUMN     "driver_reminder_snapshot" JSONB;

