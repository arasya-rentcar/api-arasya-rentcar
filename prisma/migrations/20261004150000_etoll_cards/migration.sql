-- CreateEnum
CREATE TYPE "EtollIssuer" AS ENUM ('MANDIRI', 'BCA', 'BRI', 'BNI', 'DKI', 'OTHER');

-- CreateEnum
CREATE TYPE "EtollCardStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "EtollTransactionType" AS ENUM ('TOPUP', 'TOLL', 'BALANCE_CHECK');

-- CreateEnum
CREATE TYPE "EtollTransactionSource" AS ENUM ('MANUAL', 'NFC');

-- AlterTable
ALTER TABLE "driver_requests" ADD COLUMN     "card_id" TEXT;

-- CreateTable
CREATE TABLE "etoll_cards" (
    "id" TEXT NOT NULL,
    "issuer" "EtollIssuer" NOT NULL,
    "name" TEXT NOT NULL,
    "card_number" TEXT NOT NULL,
    "balance" DECIMAL(12,2),
    "balance_at" TIMESTAMP(3),
    "status" "EtollCardStatus" NOT NULL DEFAULT 'ACTIVE',
    "inactive_reason" TEXT,
    "note" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "etoll_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "etoll_card_handovers" (
    "id" TEXT NOT NULL,
    "card_id" TEXT NOT NULL,
    "driver_id" TEXT NOT NULL,
    "service_item_id" TEXT,
    "taken_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "taken_by" TEXT,
    "returned_at" TIMESTAMP(3),
    "returned_by" TEXT,
    "return_kind" TEXT,
    "client_ref" TEXT,
    "return_ref" TEXT,

    CONSTRAINT "etoll_card_handovers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "etoll_transactions" (
    "id" TEXT NOT NULL,
    "card_id" TEXT NOT NULL,
    "type" "EtollTransactionType" NOT NULL,
    "amount" DECIMAL(12,2),
    "balance_after" DECIMAL(12,2),
    "source" "EtollTransactionSource" NOT NULL DEFAULT 'MANUAL',
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "driver_id" TEXT,
    "request_id" TEXT,
    "handover_id" TEXT,
    "service_item_id" TEXT,
    "note" TEXT,
    "created_by" TEXT,
    "client_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voided_at" TIMESTAMP(3),
    "voided_by" TEXT,
    "void_reason" TEXT,

    CONSTRAINT "etoll_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "etoll_cards_card_number_key" ON "etoll_cards"("card_number");

-- CreateIndex
CREATE INDEX "etoll_cards_status_idx" ON "etoll_cards"("status");

-- CreateIndex
CREATE UNIQUE INDEX "etoll_card_handovers_client_ref_key" ON "etoll_card_handovers"("client_ref");

-- CreateIndex
CREATE UNIQUE INDEX "etoll_card_handovers_return_ref_key" ON "etoll_card_handovers"("return_ref");

-- CreateIndex
CREATE INDEX "etoll_card_handovers_card_id_taken_at_idx" ON "etoll_card_handovers"("card_id", "taken_at");

-- CreateIndex
CREATE INDEX "etoll_card_handovers_driver_id_returned_at_idx" ON "etoll_card_handovers"("driver_id", "returned_at");

-- CreateIndex
CREATE UNIQUE INDEX "etoll_transactions_client_ref_key" ON "etoll_transactions"("client_ref");

-- CreateIndex
CREATE INDEX "etoll_transactions_card_id_occurred_at_idx" ON "etoll_transactions"("card_id", "occurred_at");

-- CreateIndex
CREATE INDEX "etoll_transactions_request_id_idx" ON "etoll_transactions"("request_id");

-- CreateIndex
CREATE INDEX "driver_requests_card_id_status_idx" ON "driver_requests"("card_id", "status");

-- AddForeignKey
ALTER TABLE "driver_requests" ADD CONSTRAINT "driver_requests_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "etoll_cards"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "etoll_card_handovers" ADD CONSTRAINT "etoll_card_handovers_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "etoll_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "etoll_card_handovers" ADD CONSTRAINT "etoll_card_handovers_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "etoll_transactions" ADD CONSTRAINT "etoll_transactions_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "etoll_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "etoll_transactions" ADD CONSTRAINT "etoll_transactions_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "drivers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "etoll_transactions" ADD CONSTRAINT "etoll_transactions_request_id_fkey" FOREIGN KEY ("request_id") REFERENCES "driver_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "etoll_transactions" ADD CONSTRAINT "etoll_transactions_handover_id_fkey" FOREIGN KEY ("handover_id") REFERENCES "etoll_card_handovers"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- At most one open handover per card (Prisma cannot express a partial index).
CREATE UNIQUE INDEX "etoll_card_handovers_one_open_per_card" ON "etoll_card_handovers"("card_id") WHERE "returned_at" IS NULL;
