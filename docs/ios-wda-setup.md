# iOS WebDriverAgent (WDA) Mac-Host Setup

This guide gets the WDA adapter running. The result: Rachael can drive the
iPhone over UI automation (tap, swipe, type, screenshot, accessibility tree).

## What you need

- Personal iPhone you fully own (not MDM-managed).
- A Mac on the home network. We try the user's existing 2013-era Mac first
  with **OpenCore Legacy Patcher** to get Sonoma + Xcode. If that doesn't
  work, fall back to a current Mac mini.
- Apple Developer account ($99/yr) — required for stable signing of WDA.
- USB-C/Lightning cable (faster than wireless for first install; wireless
  works after).

## A. Try the existing 2013 Mac (OpenCore Legacy Patcher)

This avoids buying new hardware.

1. Back up the Mac (Time Machine).
2. Download **OpenCore Legacy Patcher** (OCLP) from the official GitHub.
3. In OCLP: **Build OpenCore** → **Install to USB** → boot from USB once →
   **Install OpenCore to internal disk**.
4. Reboot, run **macOS Sonoma installer** from inside macOS.
5. After Sonoma boots, run OCLP **Post-Install Root Patcher** to restore the
   GPU drivers that Sonoma drops on legacy Macs.
6. Install **Xcode 15+** from the App Store. Accept the license:
   `sudo xcodebuild -license accept`.
7. Sign in to Xcode with your Apple Developer account (Xcode → Settings →
   Accounts).

If any step fails (kernel panic, GPU artifacts you can't live with, Xcode
won't install), abandon and use the Mac mini fallback below.

## B. Mac mini fallback

Plug in, install Xcode 15+, sign in to your Apple Developer account. No
patching needed. Skip to "Install WDA on the phone".

## C. Install WDA on the phone

1. `cd ~/src && git clone https://github.com/appium/WebDriverAgent.git`
2. Open `WebDriverAgent.xcodeproj` in Xcode.
3. For both `WebDriverAgentLib` and `WebDriverAgentRunner` targets:
   - **Signing & Capabilities** → check **Automatically manage signing**.
   - **Team** = your Developer account team.
   - **Bundle Identifier** — must be unique, e.g.
     `com.<yourname>.WebDriverAgentRunner`.
4. Plug in the iPhone, enable **Developer Mode** on the phone (Settings →
   Privacy & Security → Developer Mode → On → reboot).
5. In Xcode select the iPhone as the run destination, then run the
   **WebDriverAgentRunner** scheme as a test. It should install and launch
   the runner; in 10–20s the Xcode console prints
   `ServerURLHere->http://<phone-ip>:8100<-ServerURLHere`.
6. On the phone, **Settings → General → VPN & Device Management → Trust** the
   developer profile.

Test with `curl http://<phone-ip>:8100/status` from the Mac. You should see
JSON.

## D. Install the Rachael WDA bridge service on the Mac

```bash
cd ~/src
git clone <rachael-repo>
cd rachael/tools
python3 -m venv .venv && source .venv/bin/activate
pip install requests websocket-client pillow
cp ios-wda/.env.example ios-wda/.env
# Edit ios-wda/.env: set RACHAEL_WSS_URL, RACHAEL_DEVICE_TOKEN, WDA_URL
```

Run once in the foreground to verify:

```bash
python ios_wda_bridge.py
```

You should see `[bridge] connected to <RACHAEL_WSS_URL>` and `[wda] /status
ok`.

## E. Keep WDA + the bridge alive (launchd)

Install both plists into `~/Library/LaunchAgents/`:

```bash
cp tools/ios-wda/com.rachael.iosbridge.plist ~/Library/LaunchAgents/
cp tools/ios-wda/com.rachael.wda.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.rachael.iosbridge.plist
launchctl load -w ~/Library/LaunchAgents/com.rachael.wda.plist
```

The plists relaunch on crash and on phone reconnect (USB notification).

## F. APNs Setup (only for the Shortcuts adapter, optional but recommended)

If you want Rachael → phone dispatch to be instant rather than poll-based,
configure APNs:

1. In your Apple Developer account, create a **Key** with **Apple Push
   Notifications** enabled. Download the `.p8`.
2. Add to Rachael's environment:
   - `APNS_KEY_PATH` (absolute path to the `.p8`)
   - `APNS_KEY_ID` (10-char key id)
   - `APNS_TEAM_ID` (10-char team id)
   - `APNS_BUNDLE_ID` — the bundle id of any small companion iOS app you
     publish (TestFlight is fine) that holds the device token. The Shortcuts
     bridge alone can't receive silent pushes; the companion app stores the
     APNs token and posts it to Rachael at pairing time.
3. Restart Rachael. Server-side `registerApnsSender(...)` picks up the keys.

If you skip APNs, the Shortcuts bridge falls back to polling (every 1/5/15
minutes via a Personal Automation in the Shortcuts app).

## G. Pair the device

In Rachael web UI: **Settings → Devices → Add iOS WDA device**. Rachael shows
a one-time code; enter it in `tools/ios-wda/.env` as `PAIRING_CODE` and
restart the bridge once. The bridge consumes the code, gets a long-lived
token, and stores it in macOS Keychain (entry `rachael-wda-token`). The .env
`PAIRING_CODE` line should then be deleted.

## H. Troubleshooting

- **Phone disconnects every few minutes** — disable USB Restricted Mode on
  the phone (Settings → Face ID & Passcode → USB Accessories: ON).
- **Tests stop running after a few hours** — Apple revokes free signing
  daily; the Developer cert is good for 12 months. Make sure you're not on a
  free team.
- **`/status` returns but taps do nothing** — phone is locked. WDA can't
  drive a locked phone. Disable auto-lock on the phone for unattended runs
  or have Rachael open the phone via Watch unlock.
