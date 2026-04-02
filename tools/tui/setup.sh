#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NC_SOURCE_TAG="v3.0.11"

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

echo "[1/7] Installing system libraries..."
if command -v apt-get &>/dev/null; then
  apt-get install -y -qq libnotcurses-dev libnotcurses3 python3-pip 2>/dev/null || true
  apt-get install -y -qq cmake build-essential pkg-config libncurses-dev libunistring-dev libdeflate-dev doctest-dev 2>/dev/null || true
fi

echo "[2/7] Installing cffi (notcurses dependency)..."
pip3 install --break-system-packages cffi 2>/dev/null || pip3 install cffi 2>/dev/null || echo "  [warn] cffi install failed"

echo "[3/7] Installing aiohttp async HTTP client..."
pip3 install --break-system-packages "aiohttp>=3.9.0" 2>/dev/null || pip3 install "aiohttp>=3.9.0" 2>/dev/null || {
  echo "  [error] aiohttp install failed. aiohttp is REQUIRED."
  exit 1
}

echo "[4/7] Checking for working notcurses..."
NC_OK=false
if python3 -c "from notcurses import Notcurses; print('  notcurses already working')" 2>/dev/null; then
  NC_OK=true
fi

if [ "$NC_OK" = false ]; then
  echo "[5/7] Trying pip install notcurses..."
  pip3 install --break-system-packages notcurses 2>/dev/null || pip3 install notcurses 2>/dev/null || true

  if python3 -c "from notcurses import Notcurses" 2>/dev/null; then
    NC_OK=true
    echo "  notcurses installed via pip"
  fi
fi

if [ "$NC_OK" = false ]; then
  echo "[5/7] pip failed — building notcurses ${NC_SOURCE_TAG} from source..."

  apt-get remove -y python3-notcurses 2>/dev/null || true

  BUILD_DIR=$(mktemp -d)
  trap "rm -rf $BUILD_DIR" EXIT

  cd "$BUILD_DIR"
  git clone --depth 1 --branch "$NC_SOURCE_TAG" https://github.com/dankamongmen/notcurses.git nc-src 2>/dev/null || {
    git clone --depth 1 https://github.com/dankamongmen/notcurses.git nc-src
  }
  cd nc-src
  mkdir build && cd build

  PYTHON_SITE=$(python3 -c "import sysconfig; print(sysconfig.get_path('purelib'))")

  cmake .. \
    -DCMAKE_INSTALL_PREFIX=/usr \
    -DCMAKE_BUILD_TYPE=Release \
    -DUSE_PANDOC=OFF \
    -DUSE_DOCTEST=OFF \
    -DUSE_POC=OFF \
    -DUSE_PYTHON=ON \
    -DUSE_STATIC=OFF \
    -DUSE_FFMPEG=OFF \
    -DUSE_OIIO=OFF \
    -DPYTHON_SITE_PACKAGES="$PYTHON_SITE" \
    2>&1 | tail -5

  make -j"$(nproc)" 2>&1 | tail -3
  make install 2>&1 | tail -3
  ldconfig

  cd "$SCRIPT_DIR"

  if python3 -c "from notcurses import Notcurses; print('  notcurses source build verified')" 2>/dev/null; then
    NC_OK=true
  else
    echo "  [warn] Source build completed but import still fails."
    echo "  TUI will use curses fallback mode."
  fi
fi

if [ "$NC_OK" = true ]; then
  echo "[6/7] notcurses verified"
else
  echo "[6/7] notcurses not available — TUI will use curses fallback"
  echo "  (All features work; notcurses adds inline plots and braille grids)"
fi

echo "[7/7] Making TUI executable..."
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
