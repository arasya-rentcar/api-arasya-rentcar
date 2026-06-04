ALTER TABLE "cars" ADD COLUMN "unit_code" TEXT;
CREATE UNIQUE INDEX "cars_unit_code_key" ON "cars"("unit_code");
