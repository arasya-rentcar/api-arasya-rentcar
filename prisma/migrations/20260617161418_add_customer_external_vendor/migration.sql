-- AlterTable
ALTER TABLE "invoices" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "order_final_finances" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "customer_id" TEXT,
ADD COLUMN     "external_car_id" TEXT,
ADD COLUMN     "external_vendor_id" TEXT,
ADD COLUMN     "is_external" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "sheet_import_rows" ALTER COLUMN "updated_at" DROP DEFAULT;

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "total_orders" INTEGER NOT NULL DEFAULT 0,
    "total_spent" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "first_order_at" TIMESTAMP(3),
    "last_order_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_vendors" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "notes" TEXT,
    "order_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_cars" (
    "id" TEXT NOT NULL,
    "vendor_id" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "plate_number" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_cars_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customers_phone_key" ON "customers"("phone");

-- CreateIndex
CREATE INDEX "customers_phone_idx" ON "customers"("phone");

-- CreateIndex
CREATE INDEX "customers_total_orders_idx" ON "customers"("total_orders");

-- CreateIndex
CREATE INDEX "external_vendors_name_idx" ON "external_vendors"("name");

-- CreateIndex
CREATE INDEX "external_cars_vendor_id_idx" ON "external_cars"("vendor_id");

-- CreateIndex
CREATE INDEX "orders_customer_id_idx" ON "orders"("customer_id");

-- CreateIndex
CREATE INDEX "orders_external_vendor_id_idx" ON "orders"("external_vendor_id");

-- CreateIndex
CREATE INDEX "orders_external_car_id_idx" ON "orders"("external_car_id");

-- CreateIndex
CREATE INDEX "orders_is_external_idx" ON "orders"("is_external");

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_external_vendor_id_fkey" FOREIGN KEY ("external_vendor_id") REFERENCES "external_vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_external_car_id_fkey" FOREIGN KEY ("external_car_id") REFERENCES "external_cars"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_cars" ADD CONSTRAINT "external_cars_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "external_vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;
