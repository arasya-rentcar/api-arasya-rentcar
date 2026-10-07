# CLAUDE.md — api-arasya-rentcar

Express 4 + Prisma 5 (Postgres on Supabase) + Supabase Storage, TypeScript. Source of truth for the dashboard, driver app and website leads.

## Commands
- Install: `npm ci`
- Generate client (no DB needed): `DATABASE_URL=postgresql://u:p@localhost:5432/db DIRECT_URL=$DATABASE_URL npx prisma generate`
- Build / typecheck: `npm run build` (tsc + copy brand assets) → `dist/src/server.js`
- Dev: `npm run dev`

## Layout
- `src/app.ts` routes + CORS (public leads router is mounted **before** the dashboard CORS policy). `src/config/env.ts` zod-validated env.
- `src/modules/<name>/{route,controller,service,validation}.ts`. Controllers parse with zod and answer `{ status: "success", data }`; errors via `AppError(message, status)` → `middleware/error.middleware.ts` (also maps multer errors to 413/400).
- Key modules: `orders` (create/assign/cancel/finalize; `cancellation-policy.ts`: `dayCancellation` (per-day tiers), `pctRupiah`, `CANCELLATION_POLICY_TEXT` (the one policy text for PDF + captions); `order-money.ts`: `computeOrderMoney` = `money` on GET /orders/:id, `billedSoFar`, and the one lock order for money/day transactions (B9): days → order → invoices → payables → drivers/cars → customer counters), `schedule` (lines = trips, `assignScheduleLine`, `order-derive.service.ts` derives order/driver/car status), `invoices` (DP/settlement/receipts, WA sends), `confirmation` (trip-team messages, H-1 sweep), `leads` (public intake + admin inbox), `driver-app` (`/api/v1/driver/*`), `driver-requests` (e-toll top-up: driver side `/driver/requests`, admin side `/driver-requests`), `etoll-cards` (office e-toll card pool: admin `/etoll-cards` CRUD + history + give/return + top-up/toll/balance entries and void; driver `/driver/etoll-cards` list/take/return/balance; balance is an estimate recomputed from the non-voided transactions; one open handover per card (partial unique index); a top-up request names a card (`card_id`, one OPEN per card) and "done" with `amount` records the TOPUP), `admin-notifications` (dashboard bell `/notifications`, per-admin read state), `devices` (Expo push tokens), `customers` (identity, private documents, `/customers/lookup`), `external-vendors` (partners), `bot` (legacy WhatsApp bot endpoints).
- Services: `services/push.service.ts` (Expo push), `services/tripNotify.ts`, `services/adminNotify.ts` (dashboard feed; call after commit, only when the action really changed state; never throws), `services/ga4.service.ts` (purchase via Measurement Protocol, claimed once), `services/storage.service.ts` (`PAYMENT_PROOFS_BUCKET` is private; customer docs under `customer-docs/<id>/`). Captions: `utils/waCaptions.ts`; manual WA links: `utils/waManual.ts`.

## Conventions
- A service-day line (`OrderServiceItem`) **is** the trip. After changing `line_status` always call `deriveAndSetOrderStatus` + `syncDriverStatus`/`syncCarStatus` in the same transaction. Order DONE only via admin finalize.
- Money/day write transactions take their locks in the order documented in `order-money.ts` (B9) and cite it; invoice create/revise, charges and refunds take `client_ref` (optional on invoices and charges for now, required on `/refunds`): a resend answers 200 with the first row, caps are re-checked under the order lock.
- Money model (finance design §2, rule set v3, `order-money.ts`): Net = `paid_to_date − refunded_total`; saldo lebih C = `credit_balance` = Σ `order_credit_entries`; Covered = Net − C; Billable = T − Covered − OpenBilled. `payment_status`, `startPayment`/`start_ready` and piutang use Net; a new invoice's `amount` in the request is the gross, capped by Billable; saldo lebih is applied by default (`apply_credit`, APPLIED entry; the stored `amount` is the cash asked, `credit_applied` the rest) and an invoice it covers in full is created PAID with a 0 receipt. Mark-paid with an amount different from the invoice needs `amount_mismatch_ack` (else 409 `AMOUNT_MISMATCH`); more → OVERPAYMENT credit, less → the invoice stays PAID and the shortfall is billed with an ADJUSTMENT invoice (`adjusts_invoice_id`, may be below the DP minimum, never above the shortfall). Revising or voiding an unpaid invoice gives its credit back (UNAPPLIED); a total below Covered releases the excess (`settleCredit`, RELEASE, run by the rollup, mark-paid and cancel). Refunds: `POST /orders/:id/refunds` (several, each ≤ `credit_balance`); `mark-refunded` is a bounded alias for one release. Ledger entries are written only through `addCreditEntry`, under the order lock. INV-6 (A3): a change that lowers T (Edit Hari cancel, Edit Order price, a billed trip cost rejected/deleted/lowered) is refused with 409 `OPEN_INVOICE_EXCEEDS` (+ amounts) only when unpaid invoices ask more than max(0, T − Covered) (`assertOpenWithinTotal`); money beyond T is released as saldo lebih.
- Driver-app actions are exactly-once: guarded `updateMany` + report row with unique `client_ref` in one transaction; `eventTime(occurred_at)` clamps phone time to the last 7 days. Keep this pattern for anything a phone can resend.
- `driver_accepted_at` records acceptance only; it must not change `line_status` (would mark drivers ON_DUTY days ahead).
- Cancellation is per day (A3, rule `DAY_V2`): each cancelled day stores `cancel_fee` / `cancel_tier` / `cancelled_at` / `cancel_reason` / `cancel_requested_at` and bills its fee (dayBillable); T = Σ dayBillable + charges, base = T − charges. Edit Hari cancel (`PUT /schedule/lines/:id`) needs `cancel_reason`, takes `expected_cancel_fee` (409 `CANCEL_FEE_CHANGED` + quote) and `cancel_requested_at` (≤ now, ≥ now − 3 days); DONE days 409 `DONE_DAY`; last open day 409 `LAST_OPEN_DAY`; reopening clears the fee. Quotes: `GET /schedule/lines/:id/cancel-quote`, `GET /orders/:id/cancel-quote`. `cancelOrder` cancels every open day with its own fee, voids only unpaid invoices (UNAPPLIED), issues one CANCELLATION_FEE invoice for what is still owed after saldo lebih (none when covered; excess → RELEASE), sets `cancellation_fee` = Σ day fees and `cancellation_rule='DAY_V2'`; final_price is not frozen. Orders cancelled before A3 (`ORDER_V1`, `isLegacyCancelled`) keep their frozen numbers. Edit Order deletes a counted day only while the order has no money and no active/paid invoice (else 409 `DAY_DELETE_NEEDS_CANCEL`). Cancelled after some days were DONE: the order stays open and closes through finalize.
- Finance numbers follow one rule for the dashboard, the Revenue page and the order card: the header of the Dashboard v2 block in `analytics.service.ts` and `rollupOrderFinance`. Change them together, bump `MARGIN_FORMULA_VERSION`, and keep e2e group O passing.
- Lead → order: `order_code = lead_code`; linking a lead to an existing order keeps that order's code.
- Phone numbers: use the shared normaliser in `modules/customers/customers.validation.ts` (`08…`/`628…`/`+62…` are the same person).
- Lists never include full NIK (`id_number_masked`). Don't `include: { customer: true }` in anything returned to clients.

## Migrations
- **Additive only** (new nullable columns/tables). Generate SQL without a DB: copy the old schema, edit `prisma/schema.prisma`, then `npx prisma migrate diff --from-schema-datamodel <old> --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/<YYYYMMDDHHMMSS>_<name>/migration.sql`. `prisma format` realigns whitespace; that's fine.
- Applied in production by the deploy script (`prisma migrate deploy`).

## Local end-to-end testing
Postgres 16 binaries are in `/usr/lib/postgresql/16/bin`. Typical recipe: `initdb` a data dir under `/var/tmp`, start on port 5433 (`-k /var/tmp`), `DATABASE_URL=DIRECT_URL=postgresql://postgres@localhost:5433/arasya?host=/var/tmp npx prisma migrate deploy`, run `node dist/src/server.js` with `PORT`, `JWT_SECRET`, fake `SUPABASE_URL/KEY`, `CONFIRMATION_SWEEP_ENABLED=false`, `EXPO_PUSH_URL` pointing at a local mock. Create an admin with a bcrypt hash directly in `users`. Stop processes by PID (never `pkill -f` patterns that match your own shell).
`scripts/e2e/run-local.sh` does all of that and runs ~195 checks of the dashboard and driver-app flows (see `scripts/e2e/README.md`); run it before pushing API changes and add checks for new behaviour.
`.github/workflows/api-smoke.yml` (manual) checks the live API read-only.

## Deploy
Push to `main` that touches API paths (`src/**`, `prisma/**`, package files) runs `deploy.yml`: CI build, then SSH to the VPS and `cd /root/.openclaw/workspace/arasya-projects && GIT_SYNC=1 ./deploy-local.sh api` (release dir, migrations, health-gated flip; `./deploy-local.sh rollback api` to undo). The same command can be run by hand on the VPS. Note: `DRY_RUN=1` still runs migrations. The owner renewed the VPS (Oct 2026); no hosting move planned.
`keep-supabase-awake.yml` pings the DB every 3 days (secret `SUPABASE_KEEPALIVE_DB_URL`, login role `keepalive`).

## Env (see `.env.example`)
`DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN` (admins; drivers get 90d), `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `SUPABASE_STORAGE_BUCKET`, `BOT_INTERNAL_TOKEN`, `CORS_ORIGINS`, `PUBLIC_LEAD_ORIGINS`, `GA4_MEASUREMENT_ID`, `GA4_API_SECRET`, `GA4_COLLECT_URL` (optional; empty = Google, the e2e mock sets it), `WEB_DEPLOY_HOOK_URL` (website deploy hook called after the price list is published; secret, empty = off), `WA_DELIVERY` (manual default | bot), `CONFIRMATION_SWEEP_*`.

## Arasya system map (same section in all four repos)

Arasya Rent Car: car rental **with driver**, Bogor HQ, Indonesia. Legal entity **PT Ayomi Raya Karsa**. Brand name "Arasya Rent Car". Official WhatsApp 0821-2402-4281.

| Repo | What | Deploys to |
|---|---|---|
| `arasya-rentcar/arasya-web` | Marketing website (Astro + Sanity), booking form → lead | Vercel (push to `main`), arasya-web.vercel.app |
| `arasya-rentcar/api-arasya-rentcar` | Express + Prisma API, source of truth (Postgres + Storage on Supabase) | VPS via `deploy-local.sh api`, https://api.haikuy.com |
| `arasya-rentcar/dashboard-arasya-rentcar` | Admin dashboard (Next.js) | Vercel (push to `main`) **and** VPS `deploy-local.sh dashboard` → dashboard.haikuy.com |
| `arasya-rentcar/mobile-arasya-rentcar` | Driver app (Expo, Android first) | EAS build (APK) |
| `arasya-rentcar/wa-bot-arasya` (branch `development`) | Old WhatsApp bot (whatsapp-web.js) | **Being retired**, do not extend |

Flow: website form → `POST /api/v1/public/leads` (code `ARS-XXXXX`, also sent in the WhatsApp message and GA4 `generate_lead`) → dashboard "Lead Website" → order (order_code = lead code) → schedule lines assigned to drivers → driver app (accept / start / arrive / finish / reports) → invoices (DP ≥ 20%) → first PAID invoice sends GA4 `purchase` (Measurement Protocol).

Rules that apply everywhere:
- **Time is WIB (Asia/Jakarta, +07:00).** Never derive dates from `toISOString()` or the browser timezone; build `…T00:00:00+07:00` / `…:00+07:00` explicitly.
- **Payments only to BCA 0954840782 a.n. PT Ayomi Raya Karsa.** No personal accounts anywhere (captions, PDFs, site).
- **Cancellation (as enforced by `dayCancellation`, per day):** each cancelled day is charged from its own WIB date and its own price: cancelled on a day before that day 20%; on that day before 10:00 WIB (10:00:00 is already 100%) and the driver has not left 50%; otherwise 100%. Rounded per day to whole rupiah, then summed. Charges already incurred stay billed in full; money beyond the new total becomes saldo lebih. Website text, captions and PDFs must say the same (`CANCELLATION_POLICY_TEXT`).
- **Personal data:** NIK and KTP/document files are sensitive (UU PDP). Lists show masked NIK only; documents live in the private bucket and are served by 5-minute signed URLs; never return a full customer object from endpoints that don't need it.
- **Idempotency:** client-generated `client_ref` (uuid) + guarded conditional updates; resends must be no-ops.
- **WhatsApp:** default is manual mode (`WA_DELIVERY` unset/manual): the API returns `wa_url` links the admin opens; driver messages go to the app as push. `WA_DELIVERY=bot` only while the old bot still runs.
- Commits end with the trailers given by the session; never put model names in code or commits. Secrets never in chat or git.
- Deferred work lives in `dashboard-arasya-rentcar/docs/BACKLOG.md`; the latest handoff in `dashboard-arasya-rentcar/docs/HANDOFF.md`.
