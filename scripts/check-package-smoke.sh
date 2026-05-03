#!/usr/bin/env bash
# scripts/check-package-smoke.sh — pack each TS package, extract the
# tarball into a temp dir, link only declared peer dependencies, and
# import the entrypoint. Exits non-zero on any ERR_MODULE_NOT_FOUND or
# resolution error. Catches the class of bug where a packaged file
# imports a relative path that does not exist in the tarball.
#
#   bash scripts/check-package-smoke.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

PEERS_cu_browser="@rachael/cu-core zod"
PEERS_cu_windows="@rachael/cu-core zod"
PEERS_cu_router="@rachael/cu-core zod"
PEERS_cu_skills="@rachael/cu-core zod"
PEERS_cu_inspector_data="zod"
PEERS_cu_bench="@rachael/cu-core"
PEERS_cu_core="zod"

for p in cu-core cu-browser cu-windows cu-router cu-skills cu-inspector-data cu-bench; do
  TMP=$(mktemp -d)
  (cd "$ROOT/packages/$p" && TARBALL=$(npm pack 2>/dev/null | tail -1) && mv "$TARBALL" "$TMP/")
  (cd "$TMP" && for t in *.tgz; do tar xzf "$t"; done)
  cd "$TMP/package"
  mkdir -p node_modules/@rachael
  var="PEERS_${p//-/_}"
  for peer in ${!var}; do
    case "$peer" in
      @rachael/cu-core) ln -s "$ROOT/packages/cu-core" node_modules/@rachael/cu-core ;;
      *)                ln -s "$ROOT/node_modules/$peer" "node_modules/$peer" ;;
    esac
  done
  npx --yes tsx -e "import('./src/index.ts').then(m => console.log('$p OK exports:', Object.keys(m).length)).catch(e => { console.error('FAIL $p:', e.message); process.exit(2); })"
  cd "$ROOT"
  rm -rf "$TMP"
  rm -f "packages/$p"/*.tgz
done
echo "[smoke] OK — all 7 tarballs import cleanly with only their declared peers."
