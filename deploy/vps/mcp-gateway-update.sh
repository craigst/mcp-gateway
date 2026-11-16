#!/usr/bin/env bash
# Pull-based updater for the MCP gateway on the USA VPS.
#
# GitHub Actions builds and publishes ghcr.io/craigst/mcp-gateway:<version>.
# This script runs from mcp-gateway-update.timer and asks the registry whether
# the configured tag changed. Only when it has does it stop the container, take
# a clean SQLite backup, start the new image, health-check it, and roll back to
# the previous image if the check fails.
#
# It never rebuilds anything, and needs no credentials: the GHCR package is
# public, so anonymous pulls work.
#
# Manual run:  systemctl start mcp-gateway-update.service
# Dry check:   /opt/mcp-gateway/mcp-gateway-update.sh
set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/opt/mcp-gateway}"
CONTAINER="${CONTAINER:-mcp-gateway}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:8484/mcp/v1/health}"
BACKUP_DIR="${BACKUP_DIR:-$COMPOSE_DIR/backups}"
FAILED_IMAGE_FILE="${FAILED_IMAGE_FILE:-$BACKUP_DIR/failed-image-id}"
HEALTH_TRIES="${HEALTH_TRIES:-30}"
HEALTH_SLEEP="${HEALTH_SLEEP:-2}"
COMPOSE=(docker compose -f "$COMPOSE_DIR/docker-compose.yml")
LOCK_FILE="${LOCK_FILE:-/run/mcp-gateway-update.lock}"

log() { printf '%s updater: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }
die() { log "ERROR: $*"; exit 1; }

[ -d "$COMPOSE_DIR" ] || die "no $COMPOSE_DIR"
cd "$COMPOSE_DIR"

exec 9>"$LOCK_FILE"
flock -n 9 || { log "another update is already running; skipping"; exit 0; }

# Resolve the image compose will actually use, honouring MCP_IMAGE_TAG and .env,
# so this script has no version of its own to drift.
IMAGE="$("${COMPOSE[@]}" config --images | head -n1)"
[ -n "$IMAGE" ] || die "could not resolve the compose image"
case "$IMAGE" in
  *:*) ;;
  *) die "resolved image has no tag: $IMAGE" ;;
esac
REPO="${IMAGE%:*}"
TAG_VERSION="${IMAGE##*:}"
log "tracking $IMAGE"

current_id="$(docker inspect -f '{{.Image}}' "$CONTAINER" 2>/dev/null || true)"

log "checking the registry"
"${COMPOSE[@]}" pull --quiet gateway || die "pull failed (registry unreachable?)"

new_id="$(docker image inspect -f '{{.Id}}' "$IMAGE" 2>/dev/null || true)"
[ -n "$new_id" ] || die "pulled image $IMAGE is not present locally"

if [ "$current_id" = "$new_id" ]; then
  log "already running $IMAGE ($new_id); nothing to do"
  exit 0
fi

if [ -f "$FAILED_IMAGE_FILE" ] && [ "$(cat "$FAILED_IMAGE_FILE")" = "$new_id" ]; then
  die "image $new_id previously failed; investigate and remove $FAILED_IMAGE_FILE to retry"
fi

# Guard the mislabelled-tag failure recorded in docs/VPS-DEPLOY.md.
label_version="$(docker image inspect \
  -f '{{index .Config.Labels "org.opencontainers.image.version"}}' \
  "$IMAGE" 2>/dev/null || true)"
if [ -n "$label_version" ] && [ "$label_version" != "$TAG_VERSION" ]; then
  log "WARNING: tag $TAG_VERSION but the image labels itself $label_version"
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"

# Keep the outgoing image under a stable tag so a rollback is a tag change, not
# a file edit.
[ -n "$current_id" ] || die "cannot identify the running image; refusing to stop the gateway"
docker tag "$current_id" "$REPO:rollback" || die "could not tag the previous image"

backup="$BACKUP_DIR/gateway-pre-${TAG_VERSION}-${stamp}.db"
snapshot_ready=0
rollback_needed=1

# Once a stop is attempted, recover on *any* error, including failed backup or
# compose commands. Until a complete snapshot exists, leave the database as-is.
recover_on_exit() {
  local status=$?
  trap - EXIT
  [ "$rollback_needed" -eq 1 ] || return "$status"
  set +e
  log "ERROR: update interrupted (status $status); attempting rollback"
  printf '%s\n' "$new_id" > "$FAILED_IMAGE_FILE" || log "WARNING: could not record failed image"
  if ! "${COMPOSE[@]}" stop gateway >/dev/null 2>&1; then
    log "ERROR: unable to stop gateway; database left untouched; manual intervention required"
    exit 1
  fi
  running="$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" || {
    log "ERROR: unable to verify gateway is stopped; database left untouched"
    exit 1
  }
  if [ "$running" != false ]; then
    log "ERROR: gateway is still running; database left untouched; manual intervention required"
    exit 1
  fi
  if [ "$snapshot_ready" -eq 1 ]; then
    cp -a "$backup" "$COMPOSE_DIR/data/gateway.db" || {
      log "ERROR: database restore failed; gateway left stopped"
      exit 1
    }
    if [ -f "${backup}-wal" ]; then
      cp -a "${backup}-wal" "$COMPOSE_DIR/data/gateway.db-wal" || {
        log "ERROR: WAL restore failed; gateway left stopped"
        exit 1
      }
    else
      rm -f "$COMPOSE_DIR/data/gateway.db-wal"
    fi
    # SQLite can rebuild the shared-memory index from the restored WAL.
    rm -f "$COMPOSE_DIR/data/gateway.db-shm"
  fi
  if ! MCP_IMAGE_TAG=rollback "${COMPOSE[@]}" up -d gateway >/dev/null; then
    log "ERROR: previous image could not be started; manual intervention required"
    exit 1
  fi
  for i in $(seq 1 "$HEALTH_TRIES"); do
    if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then
      log "previous image is healthy after rollback"
      exit 1
    fi
    sleep "$HEALTH_SLEEP"
  done
  log "ERROR: previous image did not become healthy; manual intervention required"
  exit 1
}
trap recover_on_exit EXIT
trap 'exit 1' HUP INT TERM

log "stopping $CONTAINER for a clean SQLite snapshot"
"${COMPOSE[@]}" stop gateway >/dev/null

if [ -f "$COMPOSE_DIR/data/gateway.db" ]; then
  cp -a "$COMPOSE_DIR/data/gateway.db" "$backup"
  # WAL/shm are copied alongside only while the container is stopped, which is
  # what makes this a consistent snapshot rather than a torn one.
  if [ -f "$COMPOSE_DIR/data/gateway.db-wal" ]; then
    cp -a "$COMPOSE_DIR/data/gateway.db-wal" "${backup}-wal"
  fi
  snapshot_ready=1
  log "backup: $backup"
else
  die "no gateway.db found; refusing to update without a database backup"
fi

log "starting $IMAGE"
"${COMPOSE[@]}" up -d gateway >/dev/null

healthy=0
for i in $(seq 1 "$HEALTH_TRIES"); do
  if curl -fsS --max-time 3 "$HEALTH_URL" >/dev/null 2>&1; then healthy=1; break; fi
  sleep "$HEALTH_SLEEP"
done

if [ "$healthy" -eq 1 ]; then
  reported="$(curl -fsS --max-time 3 "$HEALTH_URL" 2>/dev/null | tr -d '\n' || true)"
  log "healthy after ${i} checks; update to $IMAGE complete"
  log "health: $reported"
  rm -f "$FAILED_IMAGE_FILE" || log "WARNING: could not clear failed-image marker"
  rollback_needed=0
  exit 0
fi

log "ERROR: $IMAGE did not become healthy; rolling back"
docker logs --tail 40 "$CONTAINER" 2>&1 | sed 's/^/  | /' || true
exit 1

