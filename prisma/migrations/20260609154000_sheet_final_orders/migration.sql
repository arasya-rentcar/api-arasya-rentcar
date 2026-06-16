-- Sheet final-order migration layer. Keeps existing order flow intact.
CREATE TABLE IF NOT EXISTS "order_final_finances" (
  "id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "sheet_checked_raw" TEXT,
  "refund_cashback_raw" TEXT,
  "refund_cashback_amount" DECIMAL(12,2),
  "invoice_no_raw" TEXT,
  "service_date_raw" TEXT,
  "service_date" TIMESTAMP(3),
  "vehicle_raw" TEXT,
  "route_raw" TEXT,
  "duration_raw" TEXT,
  "package_raw" TEXT,
  "driver_vendor_raw" TEXT,
  "plate_no_raw" TEXT,
  "sell_price" DECIMAL(12,2),
  "rtr_amount" DECIMAL(12,2),
  "dp_amount" DECIMAL(12,2),
  "additional_amount" DECIMAL(12,2),
  "user_overtime_amount" DECIMAL(12,2),
  "user_overtime_hours_raw" TEXT,
  "parking_user_amount" DECIMAL(12,2),
  "total_user_amount" DECIMAL(12,2),
  "paid_off_date_raw" TEXT,
  "paid_off_date" TIMESTAMP(3),
  "fuel_amount" DECIMAL(12,2),
  "toll_amount" DECIMAL(12,2),
  "driver_fee_amount" DECIMAL(12,2),
  "driver_overtime_amount" DECIMAL(12,2),
  "parking_cash_amount" DECIMAL(12,2),
  "other_amount" DECIMAL(12,2),
  "finance_note" TEXT,
  "total_driver_amount" DECIMAL(12,2),
  "driver_paid_date_raw" TEXT,
  "driver_paid_date" TIMESTAMP(3),
  "total_ops_cost" DECIMAL(12,2),
  "unit_rental_price" DECIMAL(12,2),
  "margin_amount" DECIMAL(12,2),
  "margin_formula_version" TEXT,
  "raw_row_json" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "order_final_finances_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "sheet_import_rows" (
  "id" TEXT NOT NULL,
  "sheet_id" TEXT NOT NULL,
  "gid" TEXT NOT NULL,
  "row_number" INTEGER NOT NULL,
  "row_hash" TEXT NOT NULL,
  "raw_json" JSONB NOT NULL,
  "order_id" TEXT,
  "status" TEXT NOT NULL,
  "warnings" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "sheet_import_rows_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "order_final_finances_order_id_key" ON "order_final_finances"("order_id");
CREATE UNIQUE INDEX IF NOT EXISTS "sheet_import_rows_sheet_id_gid_row_number_key" ON "sheet_import_rows"("sheet_id", "gid", "row_number");
CREATE INDEX IF NOT EXISTS "sheet_import_rows_status_idx" ON "sheet_import_rows"("status");
CREATE INDEX IF NOT EXISTS "sheet_import_rows_order_id_idx" ON "sheet_import_rows"("order_id");

ALTER TABLE "order_final_finances" ADD CONSTRAINT "order_final_finances_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "sheet_import_rows" ADD CONSTRAINT "sheet_import_rows_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
