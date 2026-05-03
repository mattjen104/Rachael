# Integrations — Epic Hyperspace

Sources:
- [`tools/epic_agent.py`](../../tools/epic_agent.py) (9621 lines) — desktop polling agent
- [`tools/epic_scan.py`](../../tools/epic_scan.py) — vision-based menu discovery
- [`tools/epic_tree.py`](../../tools/epic_tree.py) — UIA tree explorer
- [`tools/ocr_overlay.py`](../../tools/ocr_overlay.py) — replay overlay
- `server/cli-engine.ts` — `epic` command group
- `server/routes.ts` — `/api/epic/*` routes

## Why a desktop layer

Epic Hyperspace is a Citrix-published Windows app. The web bridge can't
reach it; instead a Python agent runs **on the user's local Windows
machine** and:

- Polls Rachael for commands.
- Drives Hyperspace via vision LLMs (Claude via OpenRouter), pyautogui, and
  the Windows SendInput API for keyboard.
- Posts back screenshots and OCR results.

## Required env vars (on the desktop)

- `OPENROUTER_API_KEY` — for Claude vision.
- `BRIDGE_TOKEN` — to authenticate with the Rachael server.

No hardcoded defaults — the script refuses to start without these.

## Polling protocol

- 3 s heartbeat → `POST /api/epic/agent/heartbeat`.
- Server marks `connected` until 60 s of silence.
- Commands queued via `POST /api/epic/agent/send` and pulled by the agent
  from `GET /api/epic/agent/commands`.
- Results posted to `POST /api/epic/agent/results`.
- Screenshots stored in-memory (max 50), retrieved as base64 PNG via
  `GET /api/epic/agent/screenshot/:id`.

These routes **bypass the global auth gate** (see [server bootstrap](./backend-server.md))
to make polling work; sensitive subsets check the bridge token internally.

## CLI

- `epic activities <env>` — list discovered activities for environment
  (SUP/POC/TST).
- `epic launch <env> <name>` — launch via the search bar.
- `epic go <env> <screen-name>` — checks activity tree first, then nav-tree
  fuzzy match + replay (see [replay engine](./replay.md)).
- `epic navigate <env> <target>` — direct navigation.
- `epic screenshot <env>` — capture current screen.
- `epic click <env> <element>` — click named element.
- `epic scan` — run the vision menu scan.
- `epic status` — agent connectivity.
- `epic setup` — instructions for installing the desktop agent.
- `epic clear <env>` — wipe activities cache.

## Critical Hyperspace gotchas

(See `replit.md` for the canonical list.)

- The Epic search bar **requires ≥2 characters** before showing results.
  Single-letter prefixes return nothing.
- Search is **fuzzy** — typing `ch` may return both "Chart Review" and
  "Discharge". Crawl logic must collect all visible results, not only those
  starting with the typed prefix.
- All keyboard input uses Windows **SendInput via ctypes** (matches real
  hardware keystrokes; Citrix forwards correctly). pyautogui is reserved
  for mouse clicks and as fallback.

## Activity discovery

`epic_scan.py` screenshots Hyperspace menus, sends them to Claude vision,
and stores discovered activities under `agent_config` keys
`epic_activities_sup` / `_poc` / `_tst`. The Tree view groups them under
EPIC > Activities by environment + category.

## UIA tree

`epic_tree.py` walks the Windows UI Automation tree and POSTs it to
`POST /api/epic/uia-tree`. Used by the Tree view to render screen state
and by the replay engine to compute fingerprints.

## Recording

- `POST /api/epic/record/start` — start a desktop workflow recording.
- `POST /api/epic/record/stop` — stop and return ordered steps.
- Recorded steps are submitted as a navigation path proposal.

## Local-only: grammar endpoint

`POST /api/epic/grammar` is allowed only from `127.0.0.1` (a local
calibration helper that injects synthetic grammar fixes into the
agent's vocabulary).
