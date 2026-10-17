#!/usr/bin/env bash
# Release-based deploy for the Arasya API and dashboard on the VPS.
#
#   ./deploy.sh api | dashboard          build a new release, flip, health-check
#   ./deploy.sh rollback api | dashboard back to the previous release
#
# GIT_SYNC=1 first resets the source clone to origin/main.
# Layout (see ops/README.md):
#   $ARASYA_SRC/<repo>                 git clone (source of releases)
#   $ARASYA_WWW/<repo>/releases/<id>   one directory per release
#   $ARASYA_WWW/<repo>/current         symlink to the live release (pm2 cwd)
#   $ARASYA_WWW/<repo>/shared/         env file, linked into every release
# A release only goes live after it built; it stays live only if it answers
# its health check, otherwise the previous release is restored.
set -euo pipefail

ARASYA_SRC="${ARASYA_SRC:-/opt/arasya/src}"
ARASYA_WWW="${ARASYA_WWW:-/var/www}"
KEEP_RELEASES="${KEEP_RELEASES:-5}"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"

log() { printf '[deploy %s] %s\n' "$(date '+%H:%M:%S')" "$*"; }
die() { log "ERROR: $*"; exit 1; }

usage() { echo "usage: $0 api|dashboard | rollback api|dashboard" >&2; exit 2; }

target_vars() {
  case "$1" in
    api)
      REPO=api-arasya-rentcar; PM2_NAME=api-arasya-rentcar; ENV_FILE=.env ;;
    dashboard)
      REPO=dashboard-arasya-rentcar; PM2_NAME=web-arasya-rentcar; ENV_FILE=.env.production ;;
    *) usage ;;
  esac
  SRC="$ARASYA_SRC/$REPO"
  APP="$ARASYA_WWW/$REPO"
}

# Port the app listens on: the API reads PORT from its env file, the dashboard
# is fixed at 3000 by its ecosystem.config.js.
app_port() {
  if [ "$TARGET" = api ]; then
    local p
    p="$(grep -E '^[[:space:]]*PORT=' "$APP/shared/$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d "\"' \r")"
    echo "${p:-3000}"
  else
    echo 3000
  fi
}

health_url() {
  if [ "$TARGET" = api ]; then echo "http://127.0.0.1:$(app_port)/health"; else echo "http://127.0.0.1:3000/"; fi
}

wait_healthy() {
  local url; url="$(health_url)"
  local end=$((SECONDS + HEALTH_TIMEOUT))
  while [ $SECONDS -lt $end ]; do
    if curl -fs -o /dev/null --max-time 5 "$url" 2>/dev/null; then return 0; fi
    sleep 3
  done
  return 1
}

# pm2 resolves the `current` symlink when a process starts, so a reload would
# keep the old release: delete and start again (a few seconds of downtime).
restart_app() {
  pm2 delete "$PM2_NAME" >/dev/null 2>&1 || true
  pm2 start "$APP/current/ecosystem.config.js" --only "$PM2_NAME" >/dev/null
  pm2 save >/dev/null
}

flip_to() {
  ln -sfn "$1" "$APP/current.tmp"
  mv -Tf "$APP/current.tmp" "$APP/current"
}

# The newest good release older than the live one (release names sort by time).
previous_release() {
  local cur; cur="$(basename "$(readlink -f "$APP/current" 2>/dev/null || echo /none)")"
  find "$APP/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r |
    while read -r r; do
      [[ "$r" < "$cur" ]] || continue
      [ -f "$APP/releases/$r/.built" ] && { echo "$APP/releases/$r"; break; }
    done
}

prune_releases() {
  local cur; cur="$(readlink -f "$APP/current")"
  find "$APP/releases" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort -r |
    tail -n +$((KEEP_RELEASES + 1)) | while read -r r; do
      [ "$APP/releases/$r" = "$cur" ] || rm -rf "${APP:?}/releases/$r"
    done
}

rollback() {
  local prev cur
  prev="$(previous_release)"
  cur="$(readlink -f "$APP/current" 2>/dev/null || true)"
  [ -n "$prev" ] || die "no earlier release to roll back to"
  log "rolling $TARGET back to $(basename "$prev")"
  flip_to "$prev"
  restart_app
  if wait_healthy; then
    log "rollback done (database migrations are never undone)"
  else
    if [ -n "$cur" ]; then flip_to "$cur"; restart_app; fi
    die "$(basename "$prev") is not healthy; stayed on $(basename "$cur")"
  fi
}

deploy() {
  [ -d "$SRC/.git" ] || die "no git clone at $SRC (see ops/README.md)"
  [ -f "$APP/shared/$ENV_FILE" ] || die "missing $APP/shared/$ENV_FILE (see ops/README.md)"
  mkdir -p "$APP/releases"

  if [ "${GIT_SYNC:-0}" = 1 ]; then
    log "syncing $SRC to origin/main"
    git -C "$SRC" fetch -q origin main
    git -C "$SRC" reset -q --hard origin/main
  fi
  local sha id rel
  sha="$(git -C "$SRC" rev-parse --short HEAD)"
  id="$(date '+%Y%m%d%H%M%S')-$sha"
  rel="$APP/releases/$id"
  log "building $TARGET $sha in $rel"
  mkdir -p "$rel"
  git -C "$SRC" archive HEAD | tar -x -C "$rel"
  ln -sfn "$APP/shared/$ENV_FILE" "$rel/$ENV_FILE"

  (
    cd "$rel"
    # Dev dependencies (typescript, prisma CLI) are needed to build.
    unset NODE_ENV
    npm ci --no-audit --no-fund
    if [ "$TARGET" = api ]; then
      npx prisma generate
      npm run build
      log "applying database migrations"
      npx prisma migrate deploy
    else
      npm run build
    fi
  ) || { rm -rf "$rel"; die "build failed; the live release was not touched"; }
  touch "$rel/.built"

  local prev; prev="$(readlink -f "$APP/current" 2>/dev/null || true)"
  flip_to "$rel"
  restart_app
  if wait_healthy; then
    log "$TARGET $sha is live"
    prune_releases
  else
    log "health check failed: $(health_url)"
    if [ -n "$prev" ] && [ -d "$prev" ]; then
      flip_to "$prev"
      restart_app
      wait_healthy && log "restored $(basename "$prev")" || log "previous release unhealthy too"
    fi
    # Never offer a release that failed its health check to a later rollback.
    rm -rf "$rel"
    die "deploy of $sha failed; see: pm2 logs $PM2_NAME"
  fi
}

case "${1:-}" in
  rollback) [ $# -eq 2 ] || usage; TARGET="$2"; target_vars "$TARGET"; rollback ;;
  api|dashboard) TARGET="$1"; target_vars "$TARGET"; deploy ;;
  *) usage ;;
esac
