# Rachael iOS Shortcuts Bridge

This folder is the importable Shortcuts gallery for the iOS Shortcuts adapter.
The phone runs a single **Rachael Bridge** Shortcut plus one helper Shortcut
per supported action. The bridge is what Rachael talks to from the server;
the helpers are what the bridge invokes locally.

## Files

| File                              | Role                                              |
| --------------------------------- | ------------------------------------------------- |
| `bridge.shortcut.json`            | Rachael Bridge — entry point. APNs + polling.     |
| `send-imessage.shortcut.json`     | Send an iMessage to a contact.                    |
| `open-url.shortcut.json`          | Open a URL in Safari.                             |
| `run-named-shortcut.shortcut.json`| Run any user-authored Shortcut by name.           |
| `set-timer.shortcut.json`         | Start a timer in the Clock app.                   |
| `append-note.shortcut.json`       | Append a line to a Notes folder.                  |
| `append-reminder.shortcut.json`   | Add a reminder to a list.                         |
| `query-health.shortcut.json`      | Read a HealthKit metric.                          |
| `envelope.md`                     | The JSON envelope the bridge accepts.             |

The `.shortcut.json` files are **specs**, not signed `.shortcut` archives.
Apple's signed format is opaque. The recommended import flow uses the specs
plus the in-app builder steps in `IMPORT.md` — every step is one tap.

## Setup (one-time, ~5 minutes)

1. On the iPhone, install the Shortcuts app if it isn't already.
2. Pair the phone with Rachael:
   - In Rachael's web UI, open **Settings → Devices → Add iOS Shortcuts device**.
   - Rachael shows a one-time 6-digit code and the bridge URL.
   - On the phone, run the Rachael Bridge Shortcut once (after importing) and
     enter the code. The bridge stores a long-lived token in the keychain.
3. Choose a transport:
   - **APNs (preferred)** — instant, no battery cost. Requires an APNs sender
     configured server-side (`APNS_*` env vars, see `docs/ios-wda-setup.md`'s
     "APNs Setup" section). Fall back to polling if you don't want to set this up.
   - **Polling** — the bridge runs on a timed Personal Automation (every 1, 5,
     or 15 minutes) and pulls queued actions from
     `GET /api/ios/devices/:id/queue` using the device token.

## Importing the Shortcuts (no Mac required)

See `IMPORT.md` for tap-by-tap instructions. Each Shortcut is short — most are
3–6 actions. Apple won't let third parties ship pre-signed Shortcut archives
without a developer account, so we ship the specs and you build them from the
phone in a few minutes. Once built, you can share them via iCloud Shortcuts
between your own devices.

## How a dispatch flows

1. Rachael's smart router picks `ios-shortcuts` for an instruction (e.g. send
   iMessage to "Mom").
2. Server enqueues an action: `{ deviceId, action: "send-imessage",
   args: { recipient, body }, transport }`.
3. Transport delivers the envelope to the phone:
   - APNs: silent push wakes the bridge, which calls `GET .../queue` to fetch.
   - Polling: the timed automation calls `GET .../queue` on schedule.
4. Bridge dispatches to the named helper Shortcut with the args.
5. Helper runs and returns its result back through the bridge to
   `POST .../queue/:actionId/result`.

## Audit

Every action is recorded server-side with `adapter: "ios-shortcuts"` and the
resolved Shortcut name. You can see them in **Cockpit → Audit**.
