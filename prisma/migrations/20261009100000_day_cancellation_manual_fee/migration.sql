-- Finance A3 (owner, 8 Oct 2026): the admin may set a cancelled day's fee by
-- hand. cancel_fee stays the fee charged; cancel_fee_auto keeps the automatic
-- fee (manual = cancel_fee <> cancel_fee_auto). Additive only.
ALTER TABLE "order_service_items" ADD COLUMN     "cancel_fee_auto" DECIMAL(12,2);

-- Hand-written (Prisma does not model CHECK constraints).
ALTER TABLE "order_service_items" ADD CONSTRAINT "osi_cancel_fee_auto_nonneg"
  CHECK ("cancel_fee_auto" IS NULL OR "cancel_fee_auto" >= 0);
