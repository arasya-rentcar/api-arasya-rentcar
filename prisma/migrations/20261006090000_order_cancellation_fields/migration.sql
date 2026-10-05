-- AlterTable
ALTER TABLE "orders" ADD COLUMN     "cancellation_fee" DECIMAL(12,2),
ADD COLUMN     "cancellation_reason" TEXT,
ADD COLUMN     "cancelled_at" TIMESTAMP(3);


-- Backfill orders cancelled before these columns existed. cancelOrder has
-- always logged `CANCELLED (cancellation fee <amount> — <tier>)` with the
-- reason as the note; take the latest such row per order.
UPDATE "orders" AS o
SET "cancelled_at" = l."created_at",
    "cancellation_fee" = substring(l."new_value" from 'cancellation fee ([0-9]+(\.[0-9]+)?)')::DECIMAL(12,2),
    "cancellation_reason" = l."note"
FROM (
  SELECT DISTINCT ON ("order_id") "order_id", "created_at", "new_value", "note"
  FROM "order_change_logs"
  WHERE "field" = 'order_status' AND "new_value" LIKE 'CANCELLED (cancellation fee %'
  ORDER BY "order_id", "created_at" DESC
) AS l
WHERE l."order_id" = o."id" AND o."cancellation_fee" IS NULL;
