# End-to-end checks (API)

Drives the real API the way the dashboard and the driver app do. It runs against a throwaway local Postgres, with Supabase Storage, Expo Push and the GA4 collector (`GA4_COLLECT_URL`) replaced by `mock-services.mjs`. Case ids (A1, C13, …) match `dashboard-arasya-rentcar/docs/TEST-PLAN.md`.

```bash
npm ci
scripts/e2e/run-local.sh                    # build, start Postgres + mocks + API, run, clean up
E2E_SKIP_BUILD=1 scripts/e2e/run-local.sh   # reuse an existing dist/
E2E_KEEP=1 scripts/e2e/run-local.sh         # keep the database and logs (path is printed)
E2E_ONLY=R scripts/e2e/run-local.sh         # only the groups starting with these letters ("A,R")
```

Needs the Postgres 16 binaries (`PG_BIN`, default `/usr/lib/postgresql/16/bin`). When run as root it starts Postgres as the `postgres` user. Ports: `E2E_PG_PORT` (5544), `E2E_API_PORT` (3999), `E2E_MOCK_PORT` (4600).

Output: one line per check. `PASS`/`FAIL` count towards the exit code. `KNOWN` is a documented issue that does not fail the run; it turns into `FIXED` once the behaviour is corrected, and should then become a normal `check`. The run exits 1 when any check fails.

What is covered (about 380 checks):

| Group | Covers |
|---|---|
| A | `payment_status` follows money received against the order total: revisions never change it, a new total does |
| B | one way to assign (T4): per-day assign makes the day ASSIGNED but not accepted (`driver_accepted_at` stays empty in the app until "Terima tugas"), "Ganti Semua" after a per-day assign, taking the driver off → SCHEDULED, "Tetapkan untuk Semua" ends in the same state, overlapping days (also two days of one order given to one driver or car, and two admins assigning one driver at the same moment) and OFF drivers refused on both paths, a driver booked on other dates is free, ON_DUTY / IN_USE only on the trip's WIB day or while it runs |
| C | Edit Order keeps days, drivers, payables, receipts and reports; refuses to delete days in use; new days on mixed orders start internal; Edit Order and a driver action at the same moment; double saves; moving a day tells the driver; removing the last open day refused |
| D | the full driver flow: accept, start (idempotent), arrive + GPS photo, pay-in-full gate, odometer order, receipts, finish, cost review, finalize, fee paid once, inbox; the days of a finalized order are locked (T5) |
| E | cancellation tier 1, releasing drivers, no cancellation-fee invoice when the DP covers the fee, fee/date/reason stored on the order; the days of a cancelled order are locked (T5) |
| F | login with any phone format, roles, duplicate phone numbers |
| G | DP/settlement/full rules, one receipt per payment (also on a double click), two invoices paid at once, pay vs revise at once, money kept after a cancellation (also on the statement), kwitansi PDF, one "lunas" push, invalid dates, overpayment and refund |
| H | website leads: idempotent intake, honeypot, sendBeacon, lead code as order code |
| I | partner days: allowed before DP, VENDOR payable, WhatsApp confirmation links |
| J | phone clock clamp, XOPS billing, day-H cancellation, old open trips ("Belum ditutup") |
| K | input limits: GPS pairs, file type/size, `client_ref` reuse, push tokens, unassigning |
| L | admin notification feed (one per real driver action, resends add none; TRIP_COST for receipts; per-admin read state, unread count), e-toll requests (idempotent, already_open, done once with push), `location_name`, `etoll_card`, server stamp on checkpoint photos the phone did not stamp |
| M | trip costs: "Dibayar oleh" decides what the driver is owed, "Ditagih ke pelanggan" only moves the cost to the invoice (pass-through, margin unchanged); admin Biaya Tambahan never touches the payable; `/analytics/dashboard` margin matches the order card |
| N | office e-toll cards: add (digits only, unique number, first balance), driver list without the full number, take/return idempotent on `client_ref`, take-over closes the other driver's handover, two takes at once keep one open handover, older-app requests linked to the held card, one open request per card, "done" with the amount records the top-up (push says to update the balance on the card), admin top-up/toll/balance entries and void, estimate = last known balance ± entries since, deactivate closes the handover and cancels the request, delete only without history |
| O | one finance formula (`/analytics/dashboard-v2`, `/analytics/revenue`, order card), as before/after differences: overtime counts as revenue and margin, trip costs billed back are pass-through, a cancellation swaps the day price for the fee, a started day keeps its driver fee as a cost, the cancellation invoice asks only for what is unpaid (none when covered) and money already received is never billed again, an unpaid fee stays in receivables; cancel after day 1 is done: order stays open, keeps the fee as its total through later saves, refuses a second cancel / Edit Order / new charges, closes through finalize |
| P | official price list (`/prices`): the migration's seed (14 cars, 6 tables, 154 rates, 19 surcharges, 17 cities, 3 driver costs), rate edits logged per changed field and counted as unpublished (unchanged values log nothing), validation and roles, `/public/prices` 404 before the first publish, optimistic concurrency (`expected_updated_at` from a stale page → 409 with `conflict_ids`, on rates, surcharges incl. DELETE, zones, driver costs, cities, cars; absent = no check), unpublished count exact even after a publication stamped in the future, publish needs `client_ref` and `confirm_proposals` while rates are proposals (409 with the count), deploy hook (the mock's `/deploy-hook`) SENT, FAILED when down and retried by a resend with the same `client_ref`, publish idempotent on `client_ref`, the public snapshot (website contract v1: no proposal flags or admin ids, `Cache-Control`, CORS, works without an Origin), surcharge duplicates 409 and delete logged, city quote/tables, a new car gets the full empty rate matrix, history labels, publications list; invoice note lines per package (X Ops / All-in / mixed) from the built `packageNoteLines` |
| R | finance package A1 (the parts of design group R it covers): **R22** one lock order (B9): Batalkan Pesanan at the same moment as "Tandai terbayar", a driver "Berangkat" and Edit Hari cancelling a day, 10 rounds each (half of them queued behind a lock the test holds on the order), no 500 and the money consistent afterwards; **R23** invoice `client_ref` (B8): the same ref twice at once → one invoice and one stored PDF, a later resend → 200 without a new number, two refs that together pass the total → one 409 (cap checked under the order lock), revise with a ref, settlement and DP revision at once never bill past the total; **R24** charge `client_ref`; **R25** GA4 through the mock collector: a paid DP sends one purchase, a paid cancellation-fee invoice or a lead linked to a cancelled order sends none; **R33** invariant sweep over every order of the run: `credit_balance` = Σ credit entries ≥ 0, `refunded_total` = Σ refunds = the old refund columns, `paid_to_date` = Σ receipts and `amount_received` = the receipt, `money` on GET /orders/:id matches, no order billed past its total (INV-5/INV-6 in their saldo-lebih form come with A2) |

Safety: `lib.mjs` refuses to run unless both the API and the database are on localhost (`E2E_ALLOW_REMOTE=1` overrides it, for a disposable copy only). The checks create users, drivers, orders and payments.

`scripts/e2e-test-orders.js` (older) calls endpoints that no longer exist; use this suite instead.
