"""
Rachael iOS WDA Bridge
======================
Tiny long-running Python service that runs on the Mac host. Connects to
Rachael over a TLS WebSocket, accepts Action/Observation requests, translates
them to WebDriverAgent (WDA) HTTP calls, and ships back results.

Mirrors the shape of `tools/epic_agent.py` (the Windows desktop agent) so
maintenance is one mental model: pair-once, run-forever, JSON envelopes,
keychain-backed token.

Setup: see `docs/ios-wda-setup.md`. Quick form:

    python3 -m venv .venv && source .venv/bin/activate
    pip install requests websocket-client pillow
    cp tools/ios-wda/.env.example tools/ios-wda/.env  # edit
    python tools/ios_wda_bridge.py

The Mac launchd plist (`tools/ios-wda/com.rachael.iosbridge.plist`) keeps
this script alive across reboots and phone reconnects.
"""
from __future__ import annotations

import base64
import json
import os
import sys
import time
import subprocess
from pathlib import Path
from typing import Any, Dict, Optional

try:
    import requests
    import websocket  # websocket-client
except ImportError:
    print("ERROR: pip install requests websocket-client pillow", file=sys.stderr)
    sys.exit(1)


# ── env loading ────────────────────────────────────────────────────────────
def _load_env() -> None:
    env_path = Path(__file__).resolve().parent / "ios-wda" / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip())


_load_env()

WDA_URL = os.environ.get("WDA_URL", "http://localhost:8100").rstrip("/")
RACHAEL_WSS_URL = os.environ.get("RACHAEL_WSS_URL", "")
RACHAEL_DEVICE_TOKEN = os.environ.get("RACHAEL_DEVICE_TOKEN", "")
PAIRING_CODE = os.environ.get("PAIRING_CODE", "")
SCREENSHOT_DIR = Path(os.environ.get("SCREENSHOT_DIR", "/tmp/rachael-wda-screens"))
HEARTBEAT_SEC = int(os.environ.get("WDA_HEARTBEAT_SEC", "15"))

SCREENSHOT_DIR.mkdir(parents=True, exist_ok=True)


# ── Keychain helpers (macOS) ───────────────────────────────────────────────
KEYCHAIN_SERVICE = "rachael-wda"
KEYCHAIN_ACCOUNT = "device-token"


def keychain_get() -> Optional[str]:
    try:
        out = subprocess.run(
            ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
            capture_output=True, text=True, check=True,
        )
        return out.stdout.strip() or None
    except subprocess.CalledProcessError:
        return None


def keychain_set(token: str) -> None:
    subprocess.run(
        ["security", "add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", token],
        check=True,
    )


# ── WDA driver (single global session) ─────────────────────────────────────
_session_id: Optional[str] = None


def wda(method: str, path: str, body: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    url = f"{WDA_URL}{path}"
    r = requests.request(method, url, json=body, timeout=30)
    r.raise_for_status()
    return r.json()


def ensure_session() -> str:
    global _session_id
    if _session_id:
        return _session_id
    res = wda("POST", "/session", {"capabilities": {"alwaysMatch": {"platformName": "iOS"}}})
    _session_id = res.get("sessionId") or res.get("value", {}).get("sessionId")
    if not _session_id:
        raise RuntimeError(f"Failed to create WDA session: {res}")
    print(f"[wda] session={_session_id}")
    return _session_id


def wda_status() -> Dict[str, Any]:
    return wda("GET", "/status")


# ── Action handlers ────────────────────────────────────────────────────────
def act_tap(args: Dict[str, Any]) -> Dict[str, Any]:
    """Unified tap: routes to element-click when elementId is supplied,
    otherwise coordinate tap at (x, y)."""
    sid = ensure_session()
    if "elementId" in args:
        return wda("POST", f"/session/{sid}/element/{args['elementId']}/click", {})
    return wda("POST", f"/session/{sid}/wda/tap/0", {"x": args["x"], "y": args["y"]})


def act_type(args: Dict[str, Any]) -> Dict[str, Any]:
    sid = ensure_session()
    return wda("POST", f"/session/{sid}/wda/keys", {"value": list(args["text"])})


def act_swipe(args: Dict[str, Any]) -> Dict[str, Any]:
    sid = ensure_session()
    return wda("POST", f"/session/{sid}/wda/dragfromtoforduration", {
        "fromX": args["x1"], "fromY": args["y1"],
        "toX": args["x2"], "toY": args["y2"],
        "duration": args.get("durationSec", 0.4),
    })


def act_key_home(_args: Dict[str, Any]) -> Dict[str, Any]:
    sid = ensure_session()
    return wda("POST", f"/session/{sid}/wda/homescreen", {})


def act_launch_app(args: Dict[str, Any]) -> Dict[str, Any]:
    sid = ensure_session()
    return wda("POST", f"/session/{sid}/wda/apps/launch", {"bundleId": args["bundleId"]})


def act_screenshot(_args: Dict[str, Any]) -> Dict[str, Any]:
    """Capture a screenshot, save locally for the Mac operator's records, and
    return the base64 bytes so the server can persist the artifact for audit
    (the server applies redaction on ingest before writing to its store)."""
    sid = ensure_session()
    res = wda("GET", f"/session/{sid}/screenshot")
    b64 = res.get("value", "")
    fname = SCREENSHOT_DIR / f"shot_{int(time.time() * 1000)}.png"
    raw = base64.b64decode(b64)
    fname.write_bytes(raw)
    return {
        "localPath": str(fname),
        "size": len(raw),
        "imageBase64": b64,
        "mimeType": "image/png",
    }


def obs_accessibility_tree(_args: Dict[str, Any]) -> Dict[str, Any]:
    sid = ensure_session()
    return wda("GET", f"/session/{sid}/source")


HANDLERS = {
    "Tap": act_tap,
    "Type": act_type,
    "Swipe": act_swipe,
    "KeyHome": act_key_home,
    "LaunchApp": act_launch_app,
    "Screenshot": act_screenshot,
    "AccessibilityTree": obs_accessibility_tree,
}


def dispatch(action: str, args: Dict[str, Any]) -> Dict[str, Any]:
    handler = HANDLERS.get(action)
    if not handler:
        return {"error": f"unknown action: {action}"}
    try:
        return {"ok": True, "value": handler(args)}
    except requests.HTTPError as e:
        return {"ok": False, "error": f"WDA HTTP {e.response.status_code}: {e.response.text[:200]}"}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


# ── Pairing (one-time) ─────────────────────────────────────────────────────
def perform_pairing() -> str:
    """Exchange PAIRING_CODE for a long-lived device token via REST."""
    if not RACHAEL_WSS_URL:
        raise RuntimeError("RACHAEL_WSS_URL not set")
    rest_base = RACHAEL_WSS_URL.replace("wss://", "https://").replace("ws://", "http://").rsplit("/ws/", 1)[0]
    url = f"{rest_base}/api/ios/pair/confirm"
    r = requests.post(url, json={"code": PAIRING_CODE, "kind": "ios-wda", "deviceName": os.uname().nodename}, timeout=30)
    r.raise_for_status()
    token = r.json().get("token")
    if not token:
        raise RuntimeError(f"pairing did not return a token: {r.text}")
    keychain_set(token)
    print(f"[bridge] paired; token stored in Keychain (service={KEYCHAIN_SERVICE})")
    return token


def get_token() -> str:
    if RACHAEL_DEVICE_TOKEN:
        return RACHAEL_DEVICE_TOKEN
    tok = keychain_get()
    if tok:
        return tok
    if PAIRING_CODE:
        return perform_pairing()
    raise RuntimeError("No device token. Set PAIRING_CODE in .env (one-time) or RACHAEL_DEVICE_TOKEN.")


# ── WSS loop ───────────────────────────────────────────────────────────────
def run_loop() -> None:
    token = get_token()
    last_status = 0.0
    while True:
        try:
            ws = websocket.create_connection(
                RACHAEL_WSS_URL,
                header=[f"X-Device-Token: {token}"],
                timeout=30,
            )
            print(f"[bridge] connected to {RACHAEL_WSS_URL}")
            while True:
                if time.time() - last_status > HEARTBEAT_SEC:
                    try:
                        wda_status()
                        ws.send(json.dumps({"kind": "heartbeat", "ts": int(time.time())}))
                        last_status = time.time()
                    except Exception as e:
                        print(f"[wda] status check failed: {e}")
                ws.settimeout(1.0)
                try:
                    raw = ws.recv()
                except websocket.WebSocketTimeoutException:
                    continue
                if not raw:
                    break
                try:
                    msg = json.loads(raw)
                except Exception:
                    continue
                aid = msg.get("id")
                action = msg.get("action")
                args = msg.get("args") or {}
                print(f"[bridge] action {action} id={aid}")
                result = dispatch(action, args)
                ws.send(json.dumps({"kind": "result", "id": aid, **result}))
        except Exception as e:
            print(f"[bridge] disconnected: {e}; reconnecting in 5s")
            time.sleep(5)


if __name__ == "__main__":
    print(f"[bridge] WDA={WDA_URL}  RACHAEL={RACHAEL_WSS_URL}")
    try:
        wda_status()
        print("[wda] /status ok")
    except Exception as e:
        print(f"[wda] /status FAILED: {e}")
    run_loop()
