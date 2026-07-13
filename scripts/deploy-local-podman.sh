#!/usr/bin/env bash
# Local Podman deploy matching .github/workflows/deploy.yml (no rsync, no host podman build of app source).
#
# Usage (repo root):
#   ./scripts/deploy-local-podman.sh
#   TARGET=main ./scripts/deploy-local-podman.sh
#   ./scripts/deploy-local-podman.sh --skip-build
#
# Optional: .deploy.local.env for SSH_* / GHCR_* when using --remote

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SKIP_BUILD=0
DEPLOY_MODE="${DEPLOY_MODE:-local}"

for arg in "$@"; do
  case "$arg" in
    --skip-build) SKIP_BUILD=1 ;;
    --remote) DEPLOY_MODE=remote ;;
    -h|--help)
      head -n 12 "$0"
      exit 0
      ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

[[ -f "${REPO_ROOT}/.deploy.local.env" ]] && set -a && source "${REPO_ROOT}/.deploy.local.env" && set +a

TARGET="${TARGET:-development}"
APP_DIR="${APP_DIR:-~/servertest-app}"
APP_DIR="${APP_DIR/#\~/$HOME}"
APP_PORT="${APP_PORT:-9443}"
POD_NAME="${POD_NAME:-servertest-pod}"
APP_CONTAINER_NAME="${APP_CONTAINER_NAME:-servertest-container}"
NGINX_CONTAINER_NAME="${NGINX_CONTAINER_NAME:-servertest-nginx}"
REGISTRY="${REGISTRY:-ghcr.io}"
IMAGE_TAG="${IMAGE_TAG:-$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo local)}"

case "$TARGET" in
  development)
    NODE_ENV=development
    DOMAIN="${DOMAIN:-api.dihola.io}"
    APP_PORT="${APP_PORT:-9443}"
    FRONTEND_PORT="${FRONTEND_PORT:-}"
    ;;
  main)
    NODE_ENV=main
    DOMAIN="${DOMAIN:-api.slc.identyclaw.com}"
    APP_PORT="${APP_PORT:-444}"
    FRONTEND_PORT="${FRONTEND_PORT:-443}"
    ;;
  *) echo "TARGET must be development or main" >&2; exit 1 ;;
esac

default_repo() {
  local url
  url="$(git -C "$REPO_ROOT" config --get remote.origin.url 2>/dev/null || true)"
  case "$url" in
    git@github.com:*) echo "${url#git@github.com:}" | sed 's/\.git$//' ;;
    https://github.com/*) echo "${url#https://github.com/}" | sed 's/\.git$//' ;;
    *) echo "discernible-io/syntheticslastcradle" ;;
  esac
}
GITHUB_REPOSITORY="${GITHUB_REPOSITORY:-$(default_repo)}"
API_IMAGE="${REGISTRY}/${GITHUB_REPOSITORY}/servertest-api:${IMAGE_TAG}"
NGINX_IMAGE="${REGISTRY}/${GITHUB_REPOSITORY}/servertest-nginx:${IMAGE_TAG}"

if [[ "$DEPLOY_MODE" == "local" ]]; then
  if [[ "$SKIP_BUILD" -eq 0 ]]; then
    podman build -f api.Dockerfile --build-arg "NODE_ENV=${NODE_ENV}" -t "$API_IMAGE" .
    podman build -f nginx.Dockerfile --build-arg "NODE_ENV=${NODE_ENV}" -t "$NGINX_IMAGE" .
  fi

  DEPLOY_USER="${USER}"
  bash "${REPO_ROOT}/scripts/ensure-podman-linger.sh"

  mkdir -p "${APP_DIR}/"{certs,logs,data,nginx,secrets} "${APP_DIR}/logs/nginx"
  podman pod exists "$POD_NAME" && podman pod rm -f "$POD_NAME"
  if [[ -n "$FRONTEND_PORT" ]]; then
    podman pod create --name "$POD_NAME" -p "${APP_PORT}:${APP_PORT}" -p "${FRONTEND_PORT}:${FRONTEND_PORT}"
  else
    podman pod create --name "$POD_NAME" -p "${APP_PORT}:${APP_PORT}"
  fi

  podman run -d \
    --pod "$POD_NAME" \
    --name "$APP_CONTAINER_NAME" \
    --user 1000:1000 \
    --restart=unless-stopped \
    --env-file "${APP_DIR}/secrets/secrets.env" \
    -e "NODE_ENV=${NODE_ENV}" \
    -v "${APP_DIR}/logs:/app/logs:Z" \
    -v "${APP_DIR}/data:/app/data:Z" \
    -v "${APP_DIR}/certs:/app/certs:ro,Z" \
    "$API_IMAGE"

  podman run -d \
    --pod "$POD_NAME" \
    --name "$NGINX_CONTAINER_NAME" \
    --restart=unless-stopped \
    -v "${APP_DIR}/certs:/app/certs:ro,Z" \
    -v "${APP_DIR}/logs/nginx:/var/log/nginx:Z,U" \
    "$NGINX_IMAGE"

  sleep 5
  podman exec "$APP_CONTAINER_NAME" node /app/scripts/run-deployment-api-tests.js || true
  echo "Local deploy complete. Pod: $POD_NAME API port $APP_PORT${FRONTEND_PORT:+, frontend port $FRONTEND_PORT}"
else
  echo "Remote deploy: use GitHub Actions deploy.yml (GHCR pull + SSH)." >&2
  exit 1
fi
