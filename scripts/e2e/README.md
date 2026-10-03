# End-to-end checks (API)

Drives the real API the way the dashboard and the driver app do. It runs against a throwaway local Postgres, with Supabase Storage and Expo Push replaced by `mock-services.mjs`. Case ids (A1, C13, …) match `dashboard-arasya-rentcar/docs/TEST-PLAN.md`.

```bash
npm ci
scripts/e2e/run-local.sh                    # build, start Postgres + mocks + API, run, clean up
E2E_SKIP_BUILD=1 scripts/e2e/run-local.sh   # reuse an existing dist/
E2E_KEEP=1 scripts/e2e/run-local.sh         # keep the database and logs (path is printed)
```

Needs the Postgres 16 binaries (`PG_BIN`, default `/usr/lib/postgresql/16/bin`). When run as root it starts Postgres as the `postgres` user. Ports: `E2E_PG_PORT` (5544), `E2E_API_PORT` (3999), `E2E_MOCK_PORT` (4600).

Output: one line per check. `PASS`/`FAIL` count towards the exit code. `KNOWN` is a documented issue that does not fail the run; it turns into `FIXED` once the behaviour is corrected, and should then become a normal `check`. The run exits 1 when any check fails.

What is covered (about 205 checks):

| Group | Covers |
|---|---|
| A | `payment_status` follows money received against the order total: revisions never change it, a new total does |
| B | per-day assignment vs "Tetapkan untuk Semua" (current behaviour, T4) |
| C | Edit Order keeps days, drivers, payables, receipts and reports; refuses to delete days in use; new days on mixed orders start internal; Edit Order and a driver action at the same moment; double saves; moving a day tells the driver; removing the last open day refused |
| D | the full driver flow: accept, start (idempotent), arrive + GPS photo, pay-in-full gate, odometer order, receipts, finish, cost review, finalize, fee paid once, inbox |
| E | cancellation tier 1, releasing drivers, cancellation-fee invoice |
| F | login with any phone format, roles, duplicate phone numbers |
| G | DP/settlement/full rules, one receipt per payment (also on a double click), two invoices paid at once, pay vs revise at once, money kept after a cancellation (also on the statement), kwitansi PDF, one "lunas" push, invalid dates, overpayment and refund |
| H | website leads: idempotent intake, honeypot, sendBeacon, lead code as order code |
| I | partner days: allowed before DP, VENDOR payable, WhatsApp confirmation links |
| J | phone clock clamp, XOPS billing, day-H cancellation, old open trips ("Belum ditutup") |
| K | input limits: GPS pairs, file type/size, `client_ref` reuse, push tokens, unassigning |
| L | admin notification feed (one per real driver action, resends add none; TRIP_COST for receipts; per-admin read state, unread count), e-toll requests (idempotent, already_open, done once with push), `location_name`, `etoll_card` |
| M | trip costs: "Dibayar oleh" decides what the driver is owed, "Ditagih ke pelanggan" only moves the cost to the invoice (pass-through, margin unchanged); admin Biaya Tambahan never touches the payable; `/analytics/dashboard` margin matches the order card |

Safety: `lib.mjs` refuses to run unless both the API and the database are on localhost (`E2E_ALLOW_REMOTE=1` overrides it, for a disposable copy only). The checks create users, drivers, orders and payments.

`scripts/e2e-test-orders.js` (older) calls endpoints that no longer exist; use this suite instead.
