#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo ""
echo "  Rachael TUI Setup"
echo "  =================="
echo ""

if ! command -v python3 &>/dev/null; then
  echo "[error] Python 3 is required but not found."
  exit 1
fi

PYTHON_VERSION=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
echo "  Python: ${PYTHON_VERSION}"

echo "[1/3] Installing notcurses system library..."
if command -v apt-get &>/dev/null; then
  apt-get install -y -qq libnotcurses-dev libnotcurses3 python3-pip 2>/dev/null || true
  apt-get install -y -qq python3-notcurses 2>/dev/null || true
fi

echo "[2/3] Installing Python dependencies..."
pip3 install --break-system-packages notcurses 2>/dev/null || pip3 install notcurses 2>/dev/null || echo "  [warn] notcurses pip install failed; will use curses fallback"

echo "[3/3] Making TUI executable..."
chmod +x "${SCRIPT_DIR}/rachael_tui.py"

CONF_DIR="$HOME/.rachael"
mkdir -p "$CONF_DIR"

if [ ! -f "$CONF_DIR/tui.conf" ]; then
  echo '{"theme": "phosphor"}' > "$CONF_DIR/tui.conf"
  echo "  Default config written to $CONF_DIR/tui.conf"
fi

echo ""
echo "  TUI installed. Run with:"
echo "    python3 ${SCRIPT_DIR}/rachael_tui.py"
echo ""
echo "  Options:"
echo "    --url URL       Server URL (default: http://localhost:5000)"
echo "    --key KEY       API key"
echo "    --theme NAME    phosphor|amber|cool-blue|solarized|dracula|red-alert"
echo ""
