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

## Vision-only surface (planned)

Once the [cu-core abstraction](./computer-use.md) lands, Citrix is
wrapped by the **`citrix-vision`** adapter. It is **vision-only** by
design: Citrix's HDX channel does not expose UIA / accessibility / DOM
through to the client side, so neither `AxTree`, `UiaTree`, nor
`DomSnapshot` are obtainable — only `RawScreenshot` and the
SoM-marked variant `SomScreenshot`. An **OmniParser SoM detector
service** fronts the screenshot path: OmniParser detects clickable
elements and labels them with marks, the smart router binds locators
to `ElementMark`, and OCR / hint overlays act as the next-tier
fallback. See [desktop-tools](./desktop-tools.md) for how this fits
with the Windows-native adapter.

## Citrix launcher program

A scheduled program `citrix-launcher` discovers available Citrix-published
apps from `cwp.ucsd.edu` and writes them into agent_config / TreeView.
Bridge-only; must be triggered manually.
