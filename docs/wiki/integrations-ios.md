# Integrations — iOS computer-use

> **Status: Planned** (see task task #102 (iOS adapter)).
>
> No iOS adapter, Shortcuts bridge, WebDriverAgent host code, or
> `tools/ios_wda_bridge.py` exists in the repo as of this wiki pass.
> [`tools/`](../../tools/) currently contains the Epic / OCR / TUI
> Python only. This page documents the **planned** iOS integration so
> the CU stack pages can refer to it as a first-class device surface.

## Intent (2-3 sentences)

iOS support gives Rachael two complementary ways to act on the user's
phone: a low-friction **Apple Shortcuts** bridge that handles common
"open this app, do this thing" actions, and a higher-fidelity
**WebDriverAgent (WDA)** adapter that runs from the user's Mac and
drives the phone over USB / wireless debug. The smart router escalates
from Shortcuts to WDA when Shortcuts can't do the job, and a per-app
takeover-required policy keeps sensitive apps (banking, MyChart) from
being driven without a human in the loop.

## Planned architecture

```
   ┌──────────────┐                  ┌──────────────────────┐
   │  iPhone      │                  │  Rachael server       │
   │              │                  │  (cu-router)          │
   │  Shortcut: ◀─── APNs / poll ────┤  /api/ios/cmd         │
   │  "Rachael"   │                  │                       │
   └──────┬───────┘                  └──────────────────────┘
          │
          │ (when Shortcuts can't, escalate to WDA)
          ▼
   ┌──────────────┐    USB / WiFi   ┌──────────────────────┐
   │  iPhone      │ ◀───────────────┤  Mac host             │
   │  WDA agent   │                 │  tools/ios_wda_bridge.py
   └──────────────┘                 │  ↳ wss → Rachael server│
                                    └──────────────────────┘
```

## Planned Shortcuts adapter

A single bridge Shortcut (importable via iCloud share link) installed
on the user's phone:

- **Trigger**: APNs push from Rachael (preferred), or 30 s polling
  fallback when the user has push disabled.
- **Action set**: each Rachael command maps to a Shortcut block —
  `open-app(name)`, `text(thread, body)`, `note(text)`,
  `set-timer(minutes)`, `play(uri)`, `read-clipboard()`, `share-text()`.
  The Shortcut posts results back to `POST /api/ios/result`.
- **Auth**: a paired-device token from the same `devices` table the
  [LilyGo keyboard](./integrations-lilygo-keyboard.md) uses; pairing
  flow is identical (6-digit code displayed in the Shortcut, entered
  in the Rachael web UI).

The Shortcut adapter is *not* a general-purpose driver — it can only
do what Apple Shortcuts can do. The router treats it as the cheap-tier
iOS surface and escalates to WDA when a request doesn't have a
Shortcut binding.

## Planned WebDriverAgent adapter

[WebDriverAgent](https://github.com/appium/WebDriverAgent) is a
Facebook-originated XCTest server that runs on the iPhone and exposes
the iOS UI to a JSON Wire Protocol. It needs to be *built and signed*
on a Mac, then `xcodebuild test`-launched against the device.

### Mac host setup (planned)

The user's Mac is a 2013 model that no longer receives macOS updates
through the supported path. Setup steps the documentation will spell
out:

1. **OpenCore Legacy Patcher** — install a current macOS via
   [OpenCore Legacy Patcher](https://dortania.github.io/OpenCore-Legacy-Patcher/)
   so Xcode 14+ can be installed.
2. **Apple Developer cert** — free or paid Apple ID; the WDA build
   needs a development signing identity. Free certs expire weekly and
   the launchd job re-signs+re-deploys on a schedule.
3. **WebDriverAgent** — clone, set bundle id + signing team in the
   `.xcodeproj`, run a one-shot `xcodebuild test-without-building`
   to verify, then hand off to launchd for steady-state.
4. **`tools/ios_wda_bridge.py`** — a small Python script that opens a
   WSS to the Rachael server, accepts `Action` / `Observation` /
   `Verifier` messages (cu-core wire format), translates them to WDA
   JSON-Wire calls, and ships the responses back. Runs as a launchd
   `KeepAlive` agent so it restarts if the phone wakes / the Mac
   reboots.
5. **launchd lifecycle** — `~/Library/LaunchAgents/io.rachael.wda.plist`
   manages: WDA process, the bridge, and a weekly re-sign cron for
   free Apple IDs.

### Wire format

The bridge speaks the cu-core [`Action`/`Observation`](./computer-use.md)
schema (Zod-codegen'd JSON), not raw WDA JSON. That keeps the
adapter swap-out behind the same contract every other surface uses.

## Planned per-app takeover policy

Stored in `agent_config` under `ios_app_policy`:

```ts
{
  "com.apple.mobilesafari": "autonomous",
  "com.apple.MobileSMS":    "autonomous",
  "com.epic.haiku":         "approval",   // MyChart-style — always ask
  "com.bankofamerica.…":    "blocked",
}
```

The smart router consults this before dispatching any iOS action. The
default for unknown bundle ids is `approval` (creates a takeover point
through the [control-bus](./control-bus.md)).

## Planned smart-router escalation

For each iOS task the router tries, in order:

1. Match a Shortcut binding → dispatch via Shortcut adapter.
2. Else, if WDA bridge is connected → escalate to WDA adapter.
3. Else, surface a takeover point.

Per-app policy gates the dispatch *after* the route is chosen.

## Planned routes

- `POST /api/ios/cmd` — server-side enqueue of an iOS action.
- `POST /api/ios/result` — Shortcut adapter posts back results.
- `wss://<host>/ws/wda` — WDA bridge transport.

See [backend-routes](./backend-routes.md) for the full list.

## Related pages

- [computer-use](./computer-use.md) — the cu-core abstraction the
  adapters sit behind
- [cu-router](./cu-router.md) — the escalation policy
- [integrations-lilygo-keyboard](./integrations-lilygo-keyboard.md) —
  shared `devices` / `pairing_codes` tables
- [control-bus](./control-bus.md) — takeover-point machinery
- [safety](./safety.md) — per-app policy + redaction
- [data-model](./data-model.md) — `devices`, `pairing_codes` columns
