# Bot Integration Endpoints

This API now has the foundation needed for WhatsApp Bot integration.

## Environment

Add this to API environment:

```env
BOT_INTERNAL_TOKEN=replace-with-long-random-token
```

Bot requests must send either:

```http
Authorization: Bearer <BOT_INTERNAL_TOKEN>
```

or:

```http
x-bot-token: <BOT_INTERNAL_TOKEN>
```

## New Prisma Models / Fields

Added to `Order`:

- `order_code`
- `source`
- `service_type`
- `passenger_count`
- `notes`
- `area`
- `driver_origin`
- `raw_order_text`
- `whatsapp_message_id`
- `driver_message_sent_at`
- `needs_review`
- `review_reason`

Added models:

- `OrderCustomer`
- `TripReport`
- `OrderSummary`

## Endpoints

Base path:

```text
/api/v1/bot
```

### Create order from WhatsApp

```http
POST /api/v1/bot/orders
```

Body:

```json
{
  "order_code": "ARS-20260530-001",
  "customer_name": "dyah",
  "customer_phone": "081321890543",
  "customers": [
    { "name": "dyah", "phone": "081321890543", "is_primary": true },
    { "name": "asah", "phone": "081222890547" }
  ],
  "pickup_location": "jl cendrawasih no 4",
  "dropoff_location": "Pemakaian area bandung - serang",
  "order_date": "2026-05-30T05:30:00.000Z",
  "final_price": 0,
  "service_type": "Fullday",
  "passenger_count": 5,
  "notes": "Paket all-include...",
  "area": "bandung - serang",
  "driver_origin": "bandung",
  "raw_order_text": "original whatsapp text",
  "whatsapp_message_id": "optional"
}
```

### Assign order

```http
POST /api/v1/bot/orders/:idOrOrderCode/assign
```

Body may use IDs:

```json
{ "driver_id": "uuid", "car_id": "uuid" }
```

or matching hints:

```json
{ "driver_phone": "081399909602", "car_query": "Veloz" }
```

### Mark driver message sent

Call this only after WhatsApp send to driver succeeds.

```http
POST /api/v1/bot/orders/:idOrOrderCode/driver-message-sent
```

Effect:

- sets `driver_message_sent_at`
- sets order status to `ASSIGNED`

### Add report/document/PDF

```http
POST /api/v1/bot/orders/:idOrOrderCode/reports
```

Body:

```json
{
  "driver_phone": "081399909602",
  "report_type": "ETOLL_DOCUMENT",
  "input_type": "PDF",
  "notes": "summary or extracted text",
  "extracted_text": "full extracted PDF text if available",
  "file_url": "https://...",
  "file_mime": "application/pdf",
  "match_method": "active driver assignment",
  "status": "MATCHED"
}
```

### START

```http
POST /api/v1/bot/orders/:idOrOrderCode/start
```

Optional body:

```json
{
  "report": {
    "driver_phone": "081399909602",
    "report_type": "START",
    "input_type": "TEXT",
    "notes": "START"
  }
}
```

Effect:

- creates report if provided
- sets trip to `ON_TRIP`
- sets order to `IN_PROGRESS`

### FINISH

```http
POST /api/v1/bot/orders/:idOrOrderCode/finish
```

Body:

```json
{
  "driver_phone": "081399909602",
  "notes": "selesai",
  "generated_summary": "finish summary text"
}
```

Effect:

- creates FINISH report
- sets trip to `COMPLETED`
- sets order to `DONE`
- creates/updates `OrderSummary`
- sets `needs_review` if START or expense/document is missing

### Lookups

```http
GET /api/v1/bot/orders/by-code/:orderCode
GET /api/v1/bot/active-order/by-driver-phone/:phone
GET /api/v1/bot/drivers/by-phone/:phone
GET /api/v1/bot/cars/match?q=Veloz
```

## Migration

New migration:

```text
prisma/migrations/20260528163000_add_bot_operational_models/migration.sql
```

Run with:

```bash
npm run prisma:deploy
```

Then generate client/build:

```bash
npm run prisma:generate
npm run build
```
