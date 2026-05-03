#!/usr/bin/env python3
"""rachael-cu-uia — HTTP bridge for the Windows UIA tree.

Endpoints:
  GET  /uia/tree                  → { elements: [...] }
  POST /uia/invoke  { name|automationId|controlType }
  POST /uia/setValue { target, value }
  POST /uia/sendKeys { chord }
  GET  /health                    → { ok, platform, uiautomation }

On non-Windows hosts the bridge starts in "shim" mode that returns empty
trees and `{ ok: false, reason: "non-windows" }` for actions, so the
WindowsUiaAdapter unit tests can run on CI.
"""
from __future__ import annotations

import json
import os
import platform
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("UIA_BRIDGE_PORT", "8766"))
HOST = os.environ.get("UIA_BRIDGE_HOST", "127.0.0.1")

_IS_WIN = platform.system() == "Windows"
_uia = None
if _IS_WIN:
    try:
        import uiautomation as _uia  # type: ignore
    except Exception as e:  # pragma: no cover - import-only path
        print(f"[uia] uiautomation unavailable ({e}); running in shim mode.", flush=True)
        _uia = None


def _walk_tree(max_nodes: int = 500):
    if _uia is None:
        return []
    out = []
    try:
        root = _uia.GetRootControl()
        for ctrl, _depth in _uia.WalkTree(root, includeTop=False, maxDepth=8):
            out.append({
                "name": getattr(ctrl, "Name", "") or "",
                "controlType": getattr(ctrl, "ControlTypeName", "") or "",
                "automationId": getattr(ctrl, "AutomationId", "") or "",
            })
            if len(out) >= max_nodes:
                break
    except Exception as e:
        print(f"[uia] tree walk error: {e}", flush=True)
    return out


def _find(target: dict):
    if _uia is None:
        return None
    name = target.get("name")
    aid = target.get("automationId")
    ctype = target.get("controlType")
    try:
        root = _uia.GetRootControl()
        for ctrl, _depth in _uia.WalkTree(root, includeTop=False, maxDepth=10):
            if name and getattr(ctrl, "Name", "") != name:
                continue
            if aid and getattr(ctrl, "AutomationId", "") != aid:
                continue
            if ctype and getattr(ctrl, "ControlTypeName", "") != ctype:
                continue
            return ctrl
    except Exception as e:
        print(f"[uia] find error: {e}", flush=True)
    return None


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):  # silence
        return

    def _json(self, code, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {
                "ok": True,
                "platform": platform.system(),
                "uiautomation": _uia is not None,
                "shim": _uia is None,
            })
            return
        if self.path == "/uia/tree":
            self._json(200, {"elements": _walk_tree()})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length else b"{}"
            payload = json.loads(body.decode("utf-8") or "{}")
        except Exception as e:
            self._json(400, {"ok": False, "error": str(e)})
            return

        if self.path == "/uia/invoke":
            ctrl = _find(payload)
            if ctrl is None:
                return self._json(200, {"ok": False, "method": "uia", "reason": "not-found" if _IS_WIN else "non-windows"})
            try:
                ctrl.Click()
            except Exception as e:
                return self._json(200, {"ok": False, "method": "uia", "reason": str(e)})
            return self._json(200, {"ok": True, "method": "uia"})

        if self.path == "/uia/setValue":
            tgt = payload.get("target") or {}
            value = payload.get("value", "")
            ctrl = _find(tgt)
            if ctrl is None:
                return self._json(200, {"ok": False, "method": "uia", "reason": "not-found" if _IS_WIN else "non-windows"})
            try:
                if hasattr(ctrl, "GetValuePattern"):
                    ctrl.GetValuePattern().SetValue(value)
                else:
                    ctrl.SendKeys(value)
            except Exception as e:
                return self._json(200, {"ok": False, "method": "uia", "reason": str(e)})
            return self._json(200, {"ok": True, "method": "uia"})

        if self.path == "/uia/sendKeys":
            chord = payload.get("chord", "")
            if _uia is None:
                return self._json(200, {"ok": False, "method": "uia", "reason": "non-windows"})
            try:
                _uia.SendKeys(chord)
            except Exception as e:
                return self._json(200, {"ok": False, "method": "uia", "reason": str(e)})
            return self._json(200, {"ok": True, "method": "uia"})

        self._json(404, {"error": "not found"})


def main():
    print(f"[uia] rachael-cu-uia listening on http://{HOST}:{PORT} (shim={_uia is None})", flush=True)
    ThreadingHTTPServer((HOST, PORT), _Handler).serve_forever()


if __name__ == "__main__":
    sys.exit(main() or 0)
