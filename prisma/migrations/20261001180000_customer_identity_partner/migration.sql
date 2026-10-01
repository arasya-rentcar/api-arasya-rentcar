-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "address" TEXT,
ADD COLUMN     "company_name" TEXT,
ADD COLUMN     "id_number" TEXT,
ADD COLUMN     "id_verified_at" TIMESTAMP(3),
ADD COLUMN     "id_verified_by" TEXT;

-- AlterTable
ALTER TABLE "external_vendors" ADD COLUMN     "area" TEXT,
ADD COLUMN     "bank_account" TEXT,
ADD COLUMN     "bank_holder" TEXT,
ADD COLUMN     "bank_name" TEXT,
ADD COLUMN     "pic_name" TEXT;

-- AlterTable
ALTER TABLE "order_service_items" ADD COLUMN     "driver_phone_raw" TEXT;

-- CreateTable
CREATE TABLE "customer_documents" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "file_path" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "note" TEXT,
    "uploaded_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_documents_customer_id_idx" ON "customer_documents"("customer_id");

-- AddForeignKey
ALTER TABLE "customer_documents" ADD CONSTRAINT "customer_documents_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

