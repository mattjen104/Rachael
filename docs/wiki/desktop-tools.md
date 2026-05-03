# Desktop automation tools

Source: [`tools/`](../../tools/)

> **Planned wrapping (see task #94 (surface adapters)).** Today the desktop
> Python lives outside any shared abstraction. Once
> [`cu-core`](./computer-use.md) lands, `tools/epic_agent.py` will be
> wrapped by two CU adapters: **`windows-uia`** (UIA tree + pywinauto
> for native Windows apps) and **`citrix-vision`** (vision-only — see
> [integrations-citrix](./integrations-citrix.md)). The Python ↔ server
> wire format becomes the cu-core `Action` / `Observation` schema,
> codegen'd from the Zod definitions in `packages/cu-core` so the
> Python side validates against the same contract as the TS adapters.
> The vision path layers
> **OmniParser SoM detection → OCR / vim hints → raw vision**, with
> the smart router walking that cascade per the
> [cheapest-reliable](./computer-use.md#planned-cheapest-reliable-loop)
> rule.

## tools/epic_agent.py (~9621 lines)

The polling agent that drives Epic Hyperspace. See
[Epic integration](./integrations-epic.md) for the protocol. Uses:

- `pyautogui` (mouse only)
- `pygetwindow`
- Windows `SendInput` via `ctypes` (all keyboard input)
- Pillow (screenshot processing)
- OpenRouter HTTP for vision calls

## tools/epic_scan.py (~338 lines)

Standalone vision-based menu scanner — sends Hyperspace screenshots to
Claude and writes activities back to `POST /api/epic/activities`.

## tools/epic_tree.py (~859 lines)

UI Automation tree walker. POSTs the tree to `POST /api/epic/uia-tree` so
Rachael can render the desktop state in the Tree view.

## tools/ocr_overlay.py (~3119 lines)

Replay overlay (Ctrl+Shift+Esc to kill). Highlights actions the desktop
agent is about to perform; an OCR layer maps screen text → click targets
during replay.

## tools/tui/ (notcurses TUI client)

Files:

- `rachael_tui.py` — main app
- `api_client.py` — HTTP client for the Rachael API
- `themes.py` — six color themes (phosphor, amber, cool-blue, solarized,
  dracula, red-alert), persisted to `~/.rachael/tui.conf`
- `nc_widgets.py` — notcurses widget helpers
- `tui_views.py` — view renderers (mirrors the web views 1-0)
- `setup.sh` — installs notcurses + Python deps (auto-run by step 9 of
  `do-install.sh`)
- `requirements.txt` — Python deps
- `smoke_test.py` — sanity check

Entry:

```
python3 tools/tui/rachael_tui.py [--url URL] [--key KEY] [--theme NAME]
```

Layout: header bar → sidebar (view list + runtime/budget) → main content →
mode line → minibuffer.

Keybindings: `j/k` move, `g/G` jump, Tab fold, Enter act, `/` search,
`:` or `M-x` palette, `T` cycle theme, `c` capture, `X` CLI, `q` quit.

Uses notcurses when available, falls back to curses (built into Python).
