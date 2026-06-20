-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "refund_amount" DECIMAL(12,2),
ADD COLUMN     "refund_note" TEXT,
ADD COLUMN     "refund_proof_url" TEXT,
ADD COLUMN     "refunded_at" TIMESTAMP(3);

