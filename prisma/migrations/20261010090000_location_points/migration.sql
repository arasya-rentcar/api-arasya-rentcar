-- AlterTable
ALTER TABLE "order_service_items" ADD COLUMN     "dropoff_lat" DOUBLE PRECISION,
ADD COLUMN     "dropoff_lng" DOUBLE PRECISION,
ADD COLUMN     "dropoff_place_id" TEXT,
ADD COLUMN     "pickup_lat" DOUBLE PRECISION,
ADD COLUMN     "pickup_lng" DOUBLE PRECISION,
ADD COLUMN     "pickup_place_id" TEXT;

-- AlterTable
ALTER TABLE "web_leads" ADD COLUMN     "destination_lat" DOUBLE PRECISION,
ADD COLUMN     "destination_lng" DOUBLE PRECISION,
ADD COLUMN     "destination_place_id" TEXT,
ADD COLUMN     "destination_place_name" TEXT,
ADD COLUMN     "pickup_lat" DOUBLE PRECISION,
ADD COLUMN     "pickup_lng" DOUBLE PRECISION,
ADD COLUMN     "pickup_place_id" TEXT,
ADD COLUMN     "pickup_place_name" TEXT;

