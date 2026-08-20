#!/usr/bin/env bash
# Enable systemd logind linger + user Podman boot units so rootless containers
# survive SSH logout AND machine reboot. Idempotent — safe on every deploy.
#
# Linger keeps user@ running with no login session.
# podman-restart.service starts --restart=unless-stopped containers at boot.
#
# Usage (CI): ssh user@host "DEPLOY_USER=user bash -s" < scripts/ensure-podman-linger.sh
# Set SKIP_LINGER=1 to skip (rootful Podman or non-systemd hosts).

set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-$(id -un)}"
SKIP_LINGER="${SKIP_LINGER:-0}"

if [[ "$SKIP_LINGER" == "1" ]]; then
  echo "SKIP_LINGER=1: skipping linger / podman-restart setup"
  exit 0
fi

if ! command -v loginctl >/dev/null 2>&1; then
  echo "loginctl not found; skipping linger setup (non-systemd host?)"
  exit 0
fi

linger_status() {
  loginctl show-user "$DEPLOY_USER" -p Linger 2>/dev/null | cut -d= -f2
}

run_as_deploy_user() {
  if [[ "$(id -un)" == "$DEPLOY_USER" ]]; then
    "$@"
    return $?
  fi
  local uid
  uid="$(id -u "$DEPLOY_USER")"
  runuser -u "$DEPLOY_USER" -- env \
    XDG_RUNTIME_DIR="/run/user/${uid}" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${uid}/bus" \
    HOME="$(getent passwd "$DEPLOY_USER" | cut -d: -f6)" \
    "$@"
}

current="$(linger_status || true)"
if [[ "$current" == "yes" ]]; then
  echo "Linger already enabled for ${DEPLOY_USER}"
else
  echo "Enabling linger for ${DEPLOY_USER}..."
  if loginctl enable-linger "$DEPLOY_USER" 2>/dev/null; then
    :
  elif sudo -n loginctl enable-linger "$DEPLOY_USER" 2>/dev/null; then
    :
  else
    echo "Could not enable linger for ${DEPLOY_USER}. Run: loginctl enable-linger ${DEPLOY_USER}" >&2
    exit 1
  fi

  if [[ "$(linger_status)" != "yes" ]]; then
    echo "Linger is not yes after enable attempt for ${DEPLOY_USER}" >&2
    exit 1
  fi
  echo "Linger=yes for ${DEPLOY_USER}"
fi

# Reboot: unless-stopped containers only come back when this user unit is enabled.
if command -v systemctl >/dev/null 2>&1; then
  run_as_deploy_user systemctl --user daemon-reload 2>/dev/null || true
  if run_as_deploy_user systemctl --user list-unit-files podman.socket &>/dev/null; then
    run_as_deploy_user systemctl --user enable --now podman.socket 2>/dev/null || true
  fi
  if run_as_deploy_user systemctl --user list-unit-files podman-restart.service &>/dev/null; then
    if run_as_deploy_user systemctl --user enable --now podman-restart.service; then
      echo "Enabled podman-restart.service for ${DEPLOY_USER} (unless-stopped starts on boot)"
    else
      echo "Warning: failed to enable podman-restart.service for ${DEPLOY_USER}" >&2
    fi
  else
    echo "Warning: podman-restart.service not found for ${DEPLOY_USER}" >&2
  fi
fi
