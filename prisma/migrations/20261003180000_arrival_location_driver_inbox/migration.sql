-- AlterTable
ALTER TABLE "trip_reports" ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "location_accuracy_m" INTEGER,
ADD COLUMN     "location_at" TIMESTAMP(3),
ADD COLUMN     "location_mocked" BOOLEAN,
ADD COLUMN     "longitude" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "driver_notifications" (
    "id" TEXT NOT NULL,
    "driver_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "driver_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "driver_notifications_driver_id_created_at_idx" ON "driver_notifications"("driver_id", "created_at");

-- AddForeignKey
ALTER TABLE "driver_notifications" ADD CONSTRAINT "driver_notifications_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Supabase: the public schema runs with RLS on and no policies (the API
-- connects as the table owner). New tables must follow, or anon/authenticated
-- could reach them through the REST API.
ALTER TABLE "driver_notifications" ENABLE ROW LEVEL SECURITY;
