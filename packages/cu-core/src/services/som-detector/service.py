#!/usr/bin/env python3
"""
som-detector — local OmniParser-class Set-of-Marks service.

Single HTTP endpoint:
  POST /detect  body: { "image": "<base64-png>" }
                returns: { "marks": [ { "mark": "1", "rect": {x,y,w,h}, "label": "..." } ] }

Design constraints (from task #94):
  - Local-only (HIPAA): no cloud calls, no telemetry.
  - GPU-optional: must run on CPU for v1; falls back if torch+CUDA missing.
  - If the underlying detector model is missing, the service still answers
    `200 { "marks": [] }` so callers can degrade to RawScreenshot rather
    than throw.

This scaffold wires up the HTTP shape. The actual OmniParser model is loaded
lazily on first call; if the load fails (model files missing or torch
unavailable), the service continues to serve empty results so the Citrix
adapter's degradation path is exercised.
"""

import base64
import io
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("SOM_DETECTOR_PORT", "8765"))
HOST = os.environ.get("SOM_DETECTOR_HOST", "127.0.0.1")

_model = None
_model_lock = threading.Lock()
_model_load_attempted = False


_MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")


def _try_load_model():
    """Lazily load the OmniParser-class detector. Returns None on failure.

    The real model is expected to live under
    `packages/cu-core/src/services/som-detector/models/`. When that directory
    is empty (the default in this repo), the loader returns None and `/detect`
    answers `{ "marks": [] }`. Honest empty marks let the Citrix adapter's
    degradation path exercise itself rather than producing a misleading
    full-image bounding box.
    """
    global _model, _model_load_attempted
    with _model_lock:
        if _model_load_attempted:
            return _model
        _model_load_attempted = True
        if not (os.path.isdir(_MODEL_DIR) and os.listdir(_MODEL_DIR)):
            print(
                f"[som] No detector model in {_MODEL_DIR}; serving empty marks. "
                "Vendor an OmniParser-class checkpoint to enable real detection.",
                flush=True,
            )
            _model = None
            return _model
        try:
            # Real loader goes here once the model is vendored. We import torch
            # lazily so the service can boot without it.
            import torch  # noqa: F401
            # NOTE: replace with the real OmniParser load call when wired in.
            _model = {"loaded": True, "dir": _MODEL_DIR}
            print(f"[som] Loaded detector from {_MODEL_DIR}", flush=True)
        except Exception as e:
            print(f"[som] Could not load detector ({e}); service will return empty marks.", flush=True)
            _model = None
        return _model


def _detect(image_bytes: bytes):
    """Return marks for the image. Empty list when no model is loaded — the
    Citrix adapter relies on this to degrade to RawScreenshot."""
    model = _try_load_model()
    if model is None:
        return []
    try:
        # Real inference call goes here. Until the model is wired in, an
        # honest empty list keeps cost/router assumptions correct.
        return []
    except Exception as e:
        print(f"[som] detect error: {e}", flush=True)
        return []


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Silence default access log; we already log meaningful events.
        pass

    def _json(self, code, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "model": "loaded" if _try_load_model() else "missing"})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/detect":
            self._json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length else b"{}"
            payload = json.loads(body.decode("utf-8") or "{}")
            image_b64 = payload.get("image", "")
            image_bytes = base64.b64decode(image_b64) if image_b64 else b""
            marks = _detect(image_bytes) if image_bytes else []
            self._json(200, {"marks": marks})
        except Exception as e:
            # Always answer 200 with empty marks — callers degrade gracefully.
            print(f"[som] request error: {e}", flush=True)
            self._json(200, {"marks": [], "error": str(e)})


def main():
    print(f"[som] som-detector listening on http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), _Handler).serve_forever()


if __name__ == "__main__":
    sys.exit(main() or 0)
