# LilyGo T-Keyboard — Rachael remote firmware

Dual-mode shell for the LilyGo T-Keyboard S3 (ESP32-S3 + BBQ10 keyboard + 128x64 SSD1306).

## Modes

- **CHAT** *(default)* — direct-to-OpenRouter chat, preserved bit-for-bit from the prior keyboard firmware: typed prompt → `POST https://openrouter.ai/api/v1/chat/completions` with the user's API key from NVS → reply rendered on the OLED with paging.
- **RACHAEL** — pairs with a Rachael server, opens a TLS WebSocket to `/ws/keyboard`, queues each line as an instruction (tagged `lilygo:<deviceId>`) and renders status / result frames.

Boot defaults to **CHAT**; RACHAEL is selected at boot only if a pairing token already exists in NVS *and* the user previously chose RACHAEL via `Sym+R` / `:mode rachael`.

| Chord     | Action                       |
|-----------|------------------------------|
| `Sym + R` | switch to RACHAEL mode       |
| `Sym + C` | switch to CHAT mode          |
| `Sym + N` | start pairing flow           |
| `Sym + P` | poll pairing status          |
| `↑` / `↓` | previous / next OLED page    |
| `Sym + ,` / `Sym + .` | page fallback if arrows are remapped |
| `Y` / `N` | answer a takeover prompt     |

The top-right OLED corner shows `R`/`C` for the active mode; in RACHAEL mode a filled square next to it indicates the WebSocket link is up. A `|/-\` spinner shows while an instruction is executing.

## Transport — TLS only

The firmware **never** uses plaintext HTTP or WS. All requests use `https://` / `wss://`. There are two independent TLS configurations:

- **Rachael server** (pairing REST + WebSocket): strict by default — connections fail closed unless a root CA is pinned (`:tls pin <PEM>`) or insecure mode is explicitly opted into (`:tls insecure`). `:tls strict` restores the secure default.
- **OpenRouter** (CHAT mode): uses a separate TLS client and defaults to `setInsecure()`, matching the prior CHAT firmware behavior bit-for-bit so the keyboard still chats out of the box on a device without a system root-CA store. Pin a CA explicitly with `:tls openrouter-ca <PEM>` if desired.

The Rachael pin is never reused for OpenRouter and vice versa.

## Reconnect

Failed WS connects (and disconnects) trigger an exponential backoff: 1 s → 2 s → 4 s → … capped at 60 s, with a small jitter, reset to 1 s on a successful connection.

## Local command line

Typed at the prompt (any mode):

```
:wifi <ssid> <pass>          save Wi-Fi credentials (NVS)
:host <host> <port>          set Rachael host (TLS only; default port 443)
:openrouter <api-key>        set OpenRouter API key (CHAT mode)
:model <model-id>            set OpenRouter model (default openrouter/auto)
:tls strict|insecure         Rachael server TLS validation policy
:tls pin <PEM>               pin a root CA for the Rachael server
:tls openrouter-ca <PEM>     pin a root CA for OpenRouter (CHAT mode)
:mode chat|rachael           force a mode
:pair                        request a pairing code
:poll                        check whether pairing has been confirmed
:reset                       clear NVS
```

## Pairing flow

The firmware drives the pairing — the keyboard requests a code and the user
types that code into the web UI:

1. On the keyboard: `Sym+N` (or type `:pair`) — the OLED shows a 6-digit code.
2. On the Rachael web UI: open **Cockpit → DEVICES**, type the 6-digit code
   into the **"Have a 6-digit code from your keyboard?"** field, give the
   device a friendly name, click **Confirm code**.
3. On the keyboard: `Sym+P` (or `:poll`) — once confirmed the device receives
   a long-lived bearer token, persists it to NVS, switches into RACHAEL mode
   and reconnects.

(The web UI also has a **+ Pair new** button that generates a code on the
server side; this is for testing or for pairing a device that can't display
its own code yet.)

The token is sent as `?token=` on the WebSocket URL. The server only answers WS upgrades on `/ws/keyboard` for clients presenting a known device token; the regular `OPENCLAW_API_KEY` is never accepted there.

## Per-device safety mode

New devices are paired in **echo-only** mode. The server logs every typed line into the audit + event stream tagged `lilygo:<deviceId>` and queues it via `enqueueCommand("human", …)` exactly like a Cockpit minibuffer instruction, but **does not** dispatch it to the CLI engine; instead it returns an `echo` frame with `would dispatch: <line>` and immediately marks the queued command complete with result `echo-only`. Toggle a device to **ARMED** in the web UI to allow real dispatch through `executeChain()`.

## Y / N takeover answers

When a takeover-point appears the server sends a `prompt` frame and the OLED shows `WAIT: <action>`; pressing `Y` or `N` resolves the takeover via the control bus.

## Libraries

Install (Arduino Library Manager or PlatformIO):

- `Adafruit GFX Library`
- `Adafruit SSD1306`
- `ArduinoJson` (>= 6.x)
- `ArduinoWebsockets` (gilmaimon)
- `BBQ10Keyboard` (arturo182)

PlatformIO `platformio.ini` snippet:

```ini
[env:lilygo-t-keyboard]
platform = espressif32
board = lilygo-t-display-s3
framework = arduino
lib_deps =
  adafruit/Adafruit GFX Library
  adafruit/Adafruit SSD1306
  bblanchon/ArduinoJson@^6.21.0
  gilmaimon/ArduinoWebsockets@^0.5.3
  arturo182/BBQ10Keyboard
monitor_speed = 115200
```
