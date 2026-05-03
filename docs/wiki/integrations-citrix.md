# Integrations — Citrix workspace launcher

CLI: `citrix` (in [`server/cli-engine.ts`](../../server/cli-engine.ts)),
`cwp` for the UCSD CWP-specific browser.

## What it does

- Launches all 6 standard Citrix-published apps for the user simultaneously
  via the Chrome extension bridge:
  - SUP / POC / TST Hyperdrive (3)
  - SUP / POC / TST Text Access (3)
- Uses `submitJob` for fire-and-forget queuing (no sequential delays).
- Resolves the StoreFront API path `/Citrix/CWPSFWeb/Resources/List` (~238
  resources).
- Saves `.ica` files to:
  `C:/Users/mjensen/OneDrive - University of California, San Diego Health/Desktop`

## Subcommands

- `citrix workspace` — launch all 6 apps.
- `citrix keepalive on | off` — pings the portal every 10 min to prevent
  session timeout.
- `citrix launch <name>` — launch a single app by name.
- `citrix list` — list discoverable apps from CWP.
- `cwp` — browser session against UCSD CWP for ad-hoc navigation.

## Bridge dependency

UCSD `*.ucsd.edu` is a bridge-only domain — the extension must be
installed and connected. There is no direct fallback.

## Citrix launcher program

A scheduled program `citrix-launcher` discovers available Citrix-published
apps from `cwp.ucsd.edu` and writes them into agent_config / TreeView.
Bridge-only; must be triggered manually.
