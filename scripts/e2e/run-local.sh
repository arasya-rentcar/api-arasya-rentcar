#!/usr/bin/env bash
# End-to-end checks against the real API on a throwaway local Postgres, with
# Supabase Storage and Expo Push replaced by mock-services.mjs. Nothing here
# touches production. Usage (from the repo root):
#   scripts/e2e/run-local.sh            # build, start everything, run, clean up
#   E2E_SKIP_BUILD=1 scripts/e2e/run-local.sh   # reuse dist/
#   E2E_KEEP=1 scripts/e2e/run-local.sh         # keep the database + logs
set -euo pipefail

cd "$(dirname "$0")/../.."
PG_BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}
PG_PORT=${E2E_PG_PORT:-5544}
API_PORT=${E2E_API_PORT:-3999}
MOCK_PORT=${E2E_MOCK_PORT:-4600}
WORK=$(mktemp -d /var/tmp/arasya-e2e.XXXXXX)
chmod 755 "$WORK"
DB="postgresql://postgres@localhost:${PG_PORT}/arasya?host=${WORK}"

# initdb refuses to run as root: use the postgres user when we are root.
as_pg() {
  if [ "$(id -u)" = 0 ]; then su postgres -c "$*"; else bash -c "$*"; fi
}
if [ "$(id -u)" = 0 ]; then chown postgres "$WORK"; fi

MOCK_PID=""
API_PID=""
cleanup() {
  [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  [ -n "$MOCK_PID" ] && kill "$MOCK_PID" 2>/dev/null || true
  as_pg "$PG_BIN/pg_ctl -D $WORK/data -m fast stop" >/dev/null 2>&1 || true
  if [ -z "${E2E_KEEP:-}" ]; then rm -rf "$WORK"; else echo "kept $WORK"; fi
}
trap cleanup EXIT

echo "== postgres ($WORK)"
as_pg "$PG_BIN/initdb -D $WORK/data -A trust -U postgres" >"$WORK/initdb.log" 2>&1
as_pg "$PG_BIN/pg_ctl -D $WORK/data -o '-p $PG_PORT -k $WORK' -l $WORK/pg.log -w start" >/dev/null
as_pg "$PG_BIN/createdb -h $WORK -p $PG_PORT arasya"

echo "== migrations + client"
DATABASE_URL="$DB" DIRECT_URL="$DB" npx prisma migrate deploy >"$WORK/migrate.log" 2>&1
DATABASE_URL="$DB" DIRECT_URL="$DB" npx prisma generate >/dev/null 2>&1
if [ -z "${E2E_SKIP_BUILD:-}" ] || [ ! -f dist/src/server.js ]; then
  echo "== build"
  npm run build >"$WORK/build.log" 2>&1
fi

echo "== mock storage/push + API"
MOCK_PORT=$MOCK_PORT node scripts/e2e/mock-services.mjs >"$WORK/mock.log" 2>&1 &
MOCK_PID=$!
env PORT="$API_PORT" NODE_ENV=test JWT_SECRET=e2e-local-secret-0123456789 \
  SUPABASE_URL="http://localhost:$MOCK_PORT" SUPABASE_SERVICE_KEY=fake SUPABASE_STORAGE_BUCKET=invoices \
  EXPO_PUSH_URL="http://localhost:$MOCK_PORT/push" CONFIRMATION_SWEEP_ENABLED=false \
  GA4_MEASUREMENT_ID= GA4_API_SECRET= WA_DELIVERY= WEB_DEPLOY_HOOK_URL="http://localhost:$MOCK_PORT/deploy-hook" \
  DATABASE_URL="$DB" DIRECT_URL="$DB" node dist/src/server.js >"$WORK/api.log" 2>&1 &
API_PID=$!
for _ in $(seq 1 60); do
  curl -sf "http://localhost:$API_PORT/health" >/dev/null && break
  sleep 0.5
done
curl -sf "http://localhost:$API_PORT/health" >/dev/null || { echo "API did not start:"; tail -30 "$WORK/api.log"; exit 1; }

echo "== checks"
set +e
E2E_API="http://localhost:$API_PORT" E2E_MOCK="http://localhost:$MOCK_PORT" E2E_DATABASE_URL="$DB" \
  node scripts/e2e/flows.mjs
STATUS=$?
set -e
if [ $STATUS -ne 0 ]; then
  echo "== last API log lines"
  tail -40 "$WORK/api.log"
fi
exit $STATUS
