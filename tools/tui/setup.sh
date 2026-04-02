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

echo "[1/4] Installing notcurses system library..."
if command -v apt-get &>/dev/null; then
  apt-get install -y -qq libnotcurses-dev libnotcurses3 python3-pip 2>/dev/null || true
  apt-get install -y -qq python3-notcurses 2>/dev/null || true
fi

echo "[2/4] Installing aiohttp async HTTP client..."
pip3 install --break-system-packages "aiohttp>=3.9.0" 2>/dev/null || pip3 install "aiohttp>=3.9.0" 2>/dev/null || echo "  [error] aiohttp install failed"

echo "[3/4] Installing notcurses Python bindings..."
pip3 install --break-system-packages notcurses 2>/dev/null || pip3 install notcurses 2>/dev/null || echo "  [warn] notcurses pip install failed; will use curses fallback"

echo "[4/4] Making TUI executable..."
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
echo "  Key bindings:"
echo "    C-x C-c   Quit"
echo "    C-g        Cancel / escape"
echo "    C-n / C-p  Navigate down / up"
echo "    M-x        Command palette"
echo "    C-s        Incremental search"
echo "    C-l        Refresh data"
echo "    1-0        Switch views"
echo "    T          Cycle theme"
echo "    c          Smart capture"
echo "    X          CLI prompt"
echo ""
