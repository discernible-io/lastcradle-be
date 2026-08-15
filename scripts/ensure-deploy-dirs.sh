#!/usr/bin/env bash
# Create host app dirs for rootless Podman deploy. Run on the target as the deploy user.
# Usage (CI): ssh user@host "APP_DIR=~/app bash -s" < scripts/ensure-deploy-dirs.sh
#
# Do not chmod/chown logs/nginx from the login user. After the first nginx start,
# :Z,U (and userns uid 101) own that tree; host chmod is EPERM on every later deploy.
# Mode 0775 is already correct; nginx write access comes from the volume flag.

set -euo pipefail

APP_DIR="${APP_DIR:?APP_DIR is required}"
APP_DIR="${APP_DIR/#\~/${HOME}}"

mkdir -p "${APP_DIR}/certs" "${APP_DIR}/data" "${APP_DIR}/nginx" "${APP_DIR}/secrets"
podman unshare mkdir -p "${APP_DIR}/logs/nginx"

chmod 750 "${APP_DIR}/secrets"
chmod 711 "${APP_DIR}/certs" || true

if [[ ! -f "${APP_DIR}/secrets/secrets.env" ]]; then
  echo "Missing ${APP_DIR}/secrets/secrets.env" >&2
  exit 1
fi
