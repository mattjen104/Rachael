#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# Rachael — DigitalOcean Installer
# =============================================================================
# Run as root on a fresh Ubuntu 22.04+ droplet:
#   curl -sL https://raw.githubusercontent.com/mattjen104/Rachael/main/scripts/do-install.sh | bash
# Or clone first and run:
#   git clone https://github.com/mattjen104/Rachael.git && cd Rachael && bash scripts/do-install.sh
# =============================================================================

REPO_URL="https://github.com/mattjen104/Rachael.git"
APP_DIR="/opt/rachael"
APP_USER="rachael"
NODE_VERSION="20"

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║        Rachael — DO Installer         ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""

# --- Root check ---
if [ "$EUID" -ne 0 ]; then
  echo "[error] Please run as root (sudo bash scripts/do-install.sh)"
  exit 1
fi

# --- System packages ---
echo "[1/9] Installing system packages..."
apt-get update -qq
apt-get install -y -qq curl git build-essential ca-certificates gnupg lsb-release ufw python3 python3-pip cmake pkg-config libncurses-dev libunistring-dev libdeflate-dev libnotcurses-dev libnotcurses3

# --- Node.js ---
echo "[2/9] Installing Node.js ${NODE_VERSION}..."
if ! command -v node &>/dev/null || ! node -v | grep -q "v${NODE_VERSION}"; then
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash -
  apt-get install -y -qq nodejs
fi
echo "  Node $(node -v), npm $(npm -v)"

# --- PostgreSQL ---
echo "[3/9] Installing PostgreSQL..."
apt-get install -y -qq postgresql postgresql-contrib
systemctl enable postgresql
systemctl start postgresql

# --- Chromium (headless browser for future use) ---
echo "[4/9] Installing Chromium..."
apt-get install -y -qq chromium-browser || apt-get install -y -qq chromium || echo "  [warn] Chromium not available in repos, skipping"

# --- Create app user ---
echo "[5/9] Setting up app user and directory..."
if ! id "$APP_USER" &>/dev/null; then
  useradd -r -m -s /bin/bash "$APP_USER"
fi

# --- Clone or update repo ---
if [ -d "$APP_DIR/.git" ]; then
  echo "  Existing installation found, pulling latest..."
  cd "$APP_DIR"
  sudo -u "$APP_USER" git pull --ff-only || git pull --ff-only
else
  echo "  Cloning repository..."
  git clone "$REPO_URL" "$APP_DIR"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
fi
cd "$APP_DIR"

# --- Database setup ---
echo "[6/9] Setting up database..."
DB_PASSWORD=$(openssl rand -hex 16)

sudo -u postgres psql -tc "SELECT 1 FROM pg_roles WHERE rolname='${APP_USER}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE USER ${APP_USER} WITH PASSWORD '${DB_PASSWORD}';"

sudo -u postgres psql -tc "SELECT 1 FROM pg_database WHERE datname='${APP_USER}'" | grep -q 1 || \
  sudo -u postgres psql -c "CREATE DATABASE ${APP_USER} OWNER ${APP_USER};"

DATABASE_URL="postgresql://${APP_USER}:${DB_PASSWORD}@localhost:5432/${APP_USER}"
echo "  Database ready: ${APP_USER}@localhost/${APP_USER}"

# --- Environment file ---
echo "[7/9] Configuring environment..."
ENV_FILE="$APP_DIR/.env"

if [ -f "$ENV_FILE" ]; then
  echo "  Existing .env found, keeping it."
else
  OPENCLAW_KEY=$(openssl rand -hex 32)
  BRIDGE_TOKEN_VAL=$(cat /proc/sys/kernel/random/uuid)

  read -rp "  OpenRouter API key: " OPENROUTER_KEY
  read -rp "  Domain for HTTPS (leave blank for IP-only): " RACHAEL_DOMAIN
  read -rp "  ntfy channel (default: rachael-standup): " NTFY_CH
  NTFY_CH=${NTFY_CH:-rachael-standup}
  read -rp "  Email for ntfy (optional): " NTFY_EM

  cat > "$ENV_FILE" <<ENVEOF
DATABASE_URL=${DATABASE_URL}
OPENROUTER_API_KEY=${OPENROUTER_KEY}
OPENCLAW_API_KEY=${OPENCLAW_KEY}
BRIDGE_TOKEN=${BRIDGE_TOKEN_VAL}
PORT=5000
NODE_ENV=production
RACHAEL_SELF_HOSTED=true
NTFY_CHANNEL=${NTFY_CH}
NTFY_EMAIL=${NTFY_EM}
RACHAEL_DOMAIN=${RACHAEL_DOMAIN}
ENVEOF

  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  echo ""
  echo "  ┌─────────────────────────────────────────┐"
  echo "  │ Save these credentials:                  │"
  echo "  │                                          │"
  echo "  │ API Key:      ${OPENCLAW_KEY:0:16}...    │"
  echo "  │ Bridge Token: ${BRIDGE_TOKEN_VAL}        │"
  echo "  │ DB Password:  ${DB_PASSWORD}             │"
  echo "  └─────────────────────────────────────────┘"
  echo ""
fi

# --- Build app ---
echo "[8/9] Building application..."
cd "$APP_DIR"
sudo -u "$APP_USER" bash -c "cd $APP_DIR && npm install --production=false 2>&1 | tail -1"
sudo -u "$APP_USER" bash -c "cd $APP_DIR && source .env 2>/dev/null; export DATABASE_URL='${DATABASE_URL}'; npm run build 2>&1 | tail -3"
sudo -u "$APP_USER" bash -c "cd $APP_DIR && source .env 2>/dev/null; export DATABASE_URL='${DATABASE_URL}'; npx tsx scripts/push-schema.ts 2>&1"

# --- TUI client ---
echo "[9/9] Setting up TUI client..."
bash "${APP_DIR}/tools/tui/setup.sh" || echo "  [warn] TUI setup had issues; TUI may use curses fallback"
sudo -u "$APP_USER" mkdir -p "/home/${APP_USER}/.rachael"
if [ ! -f "/home/${APP_USER}/.rachael/tui.conf" ]; then
  echo '{"theme": "phosphor"}' > "/home/${APP_USER}/.rachael/tui.conf"
  chown "$APP_USER:$APP_USER" "/home/${APP_USER}/.rachael/tui.conf"
fi

# --- Systemd service ---
cat > /etc/systemd/system/rachael.service <<SVCEOF
[Unit]
Description=Rachael Agent Runtime
After=network.target postgresql.service
Wants=postgresql.service

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=/usr/bin/node dist/index.cjs
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=rachael

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable rachael

# --- Caddy reverse proxy ---
if ! command -v caddy &>/dev/null; then
  echo "  Installing Caddy..."
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -qq
  apt-get install -y -qq caddy
fi

DOMAIN_VAL=$(grep RACHAEL_DOMAIN "$ENV_FILE" | cut -d= -f2-)
if [ -n "$DOMAIN_VAL" ]; then
  cat > /etc/caddy/Caddyfile <<CADDYEOF
${DOMAIN_VAL} {
    reverse_proxy localhost:5000
}
CADDYEOF
else
  cat > /etc/caddy/Caddyfile <<CADDYEOF
:80 {
    reverse_proxy localhost:5000
}
:443 {
    tls internal
    reverse_proxy localhost:5000
}
CADDYEOF
fi

systemctl enable caddy
systemctl restart caddy

# --- Firewall ---
echo "  Configuring firewall..."
ufw --force enable >/dev/null 2>&1
ufw allow 22/tcp >/dev/null 2>&1
ufw allow 80/tcp >/dev/null 2>&1
ufw allow 443/tcp >/dev/null 2>&1

# --- Start ---
systemctl start rachael

echo ""
echo "  ╔═══════════════════════════════════════╗"
echo "  ║        Rachael is running!            ║"
echo "  ╚═══════════════════════════════════════╝"
echo ""
if [ -n "$DOMAIN_VAL" ]; then
  echo "  URL:          https://${DOMAIN_VAL}"
else
  IP=$(curl -4 -s ifconfig.me || hostname -I | awk '{print $1}')
  echo "  URL:          http://${IP}"
fi
echo "  Logs:         journalctl -u rachael -f"
echo "  Restart:      systemctl restart rachael"
echo "  Update:       bash ${APP_DIR}/scripts/do-update.sh"
echo ""
echo "  TUI client:   python3 ${APP_DIR}/tools/tui/rachael_tui.py"
echo "  TUI themes:   phosphor amber cool-blue solarized dracula red-alert"
echo ""
echo "  Chrome Extension setup:"
echo "  1. Open extension options"
echo "  2. Set server URL to your Rachael URL above"
echo "  3. Set bridge token from .env"
echo ""
