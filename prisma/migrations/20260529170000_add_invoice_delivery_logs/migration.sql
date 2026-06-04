CREATE TYPE "InvoiceDeliveryChannel" AS ENUM ('WHATSAPP');
CREATE TYPE "InvoiceDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

CREATE TABLE "invoice_delivery_logs" (
    "id" TEXT NOT NULL,
    "invoice_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "channel" "InvoiceDeliveryChannel" NOT NULL DEFAULT 'WHATSAPP',
    "target_name" TEXT,
    "target_phone" TEXT NOT NULL,
    "message_text" TEXT,
    "file_url" TEXT NOT NULL,
    "invoice_number_snapshot" TEXT NOT NULL,
    "amount_snapshot" DECIMAL(12,2) NOT NULL,
    "status_snapshot" "InvoiceStatus" NOT NULL,
    "status" "InvoiceDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "provider_message_id" TEXT,
    "error_message" TEXT,
    "sent_by_user_id" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "invoice_delivery_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "invoice_delivery_logs_invoice_id_idx" ON "invoice_delivery_logs"("invoice_id");
CREATE INDEX "invoice_delivery_logs_order_id_idx" ON "invoice_delivery_logs"("order_id");
CREATE INDEX "invoice_delivery_logs_status_idx" ON "invoice_delivery_logs"("status");

ALTER TABLE "invoice_delivery_logs" ADD CONSTRAINT "invoice_delivery_logs_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "invoice_delivery_logs" ADD CONSTRAINT "invoice_delivery_logs_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
