-- Add driver classification and origin/location tracking for bot-created orders.
CREATE TYPE "DriverType" AS ENUM ('INTERNAL', 'EXTERNAL');

ALTER TABLE "drivers"
  ADD COLUMN "email" TEXT,
  ADD COLUMN "location" TEXT,
  ADD COLUMN "type" "DriverType" NOT NULL DEFAULT 'INTERNAL';

CREATE INDEX "drivers_phone_idx" ON "drivers"("phone");
CREATE INDEX "drivers_type_idx" ON "drivers"("type");
