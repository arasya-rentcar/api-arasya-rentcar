-- Finance A3: per-day cancellation fee (design §4 migration 2). Additive only.
ALTER TABLE "order_service_items"
ADD COLUMN     "cancel_fee" DECIMAL(12,2),
ADD COLUMN     "cancel_tier" INTEGER,
ADD COLUMN     "cancelled_at" TIMESTAMP(3),
ADD COLUMN     "cancel_reason" TEXT,
ADD COLUMN     "cancel_requested_at" TIMESTAMP(3);

-- Batalkan Pesanan idempotency (client_ref → cancel_client_ref from A1): the
-- stored response a resend with the same ref gets back.
ALTER TABLE "orders" ADD COLUMN "cancel_result" JSONB;

-- Hand-written (Prisma does not model CHECK constraints).
ALTER TABLE "order_service_items" ADD CONSTRAINT "osi_cancel_fee_nonneg"
  CHECK ("cancel_fee" IS NULL OR "cancel_fee" >= 0);
ALTER TABLE "order_service_items" ADD CONSTRAINT "osi_cancel_tier_range"
  CHECK ("cancel_tier" IS NULL OR "cancel_tier" BETWEEN 1 AND 3);

-- Orders cancelled by the whole-order rule after the A1 backfill (A2 did not
-- stamp the rule) keep their frozen numbers too.
UPDATE "orders"
SET "cancellation_rule" = 'ORDER_V1'
WHERE "cancellation_fee" IS NOT NULL AND "cancellation_rule" IS NULL;
