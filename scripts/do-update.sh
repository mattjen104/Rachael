#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Rachael — Update Script
# =============================================================================
# Pulls latest from GitHub, rebuilds, and restarts the service.
# Run as root: bash /opt/rachael/scripts/do-update.sh
# =============================================================================

APP_DIR="/opt/rachael"
APP_USER="rachael"

echo ""
echo "  [rachael] Updating..."

cd "$APP_DIR"

echo "  [1/4] Pulling latest code..."
sudo -u "$APP_USER" git pull --ff-only

echo "  [2/4] Installing dependencies..."
sudo -u "$APP_USER" npm install --production=false 2>&1 | tail -1

echo "  [3/4] Building..."
sudo -u "$APP_USER" bash -c "cd $APP_DIR && set -a && source .env && set +a && npm run build 2>&1 | tail -3"

echo "  [4/4] Running schema migrations..."
sudo -u "$APP_USER" bash -c "cd $APP_DIR && set -a && source .env && set +a && npx tsx scripts/push-schema.ts 2>&1"

echo "  Restarting service..."
systemctl restart rachael

sleep 2

if systemctl is-active --quiet rachael; then
  echo "  [ok] Rachael is running."
else
  echo "  [error] Rachael failed to start. Check: journalctl -u rachael -n 50"
  exit 1
fi

echo "  [done] Update complete."
echo ""
