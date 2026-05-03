#!/usr/bin/env python3
"""
som-detector — local OmniParser-class Set-of-Marks service.

HTTP endpoints:
  POST /detect  body: { "image": "<base64-png>" }
                returns: { "marks": [...], "elapsedMs": float }
  GET  /health  returns: {
                  "ok": true,
                  "model": "omniparser" | "opencv" | "missing",
                  "coldStartMs": float | null,
                  "requests": { "count", "mean", "p50", "p95", "p99", "max" }
                }

Design constraints (locked in by task #94 and #112):
  - Local-only (HIPAA): no cloud calls, no telemetry.
  - GPU-optional: must run on CPU for v1.
  - Always answers `200`. If the request is malformed or the detector blows
    up, the response is `{ "marks": [] }` so the Citrix and browser-Playwright
    adapters degrade to RawScreenshot rather than throw.

Two detector backends, picked in this order:
  1. ONNX OmniParser ("icon_detect.onnx" + "icon_caption.onnx" under
     `./models/`) when onnxruntime is installed. This is the production path.
  2. OpenCV heuristic detector — Canny edges + contour merge + MSER text
     regions, then NMS. Real bounding boxes; runs on CPU in tens of ms.

Both backends return the exact same mark shape so callers don't branch.
"""

import base64
import io
import json
import os
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get("SOM_DETECTOR_PORT", "8765"))
HOST = os.environ.get("SOM_DETECTOR_HOST", "127.0.0.1")
MAX_MARKS = int(os.environ.get("SOM_DETECTOR_MAX_MARKS", "120"))
LATENCY_WINDOW = int(os.environ.get("SOM_DETECTOR_LATENCY_WINDOW", "200"))

_MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")

_PROCESS_START = time.monotonic()
_model_lock = threading.Lock()
_model = None  # dict: { "kind": "omniparser"|"opencv", ... }
_model_load_attempted = False
_cold_start_ms = None  # set after the first successful model init

_lat_lock = threading.Lock()
_latencies_ms = deque(maxlen=LATENCY_WINDOW)
_request_count = 0


# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------

def _try_load_omniparser():
    """Load ONNX OmniParser checkpoints from `./models` if present.

    Expects `icon_detect.onnx` (YOLO-style detector). `icon_caption.onnx` is
    optional; without it, marks get a generic "icon" label rather than a
    semantic caption. Returns a dict descriptor or None.
    """
    detect_path = os.path.join(_MODEL_DIR, "icon_detect.onnx")
    if not os.path.isfile(detect_path):
        return None
    try:
        import onnxruntime as ort  # type: ignore
        import numpy as np  # noqa: F401
    except Exception as e:
        print(f"[som] onnxruntime unavailable ({e}); skipping OmniParser path.", flush=True)
        return None
    try:
        sess = ort.InferenceSession(detect_path, providers=["CPUExecutionProvider"])
        caption_path = os.path.join(_MODEL_DIR, "icon_caption.onnx")
        cap_sess = None
        if os.path.isfile(caption_path):
            try:
                cap_sess = ort.InferenceSession(caption_path, providers=["CPUExecutionProvider"])
            except Exception as e:
                print(f"[som] icon_caption load failed ({e}); marks will be generic.", flush=True)
        return {
            "kind": "omniparser",
            "detect": sess,
            "caption": cap_sess,
            "input": sess.get_inputs()[0].name,
            "input_shape": sess.get_inputs()[0].shape,
        }
    except Exception as e:
        print(f"[som] OmniParser ONNX load failed ({e}); falling back to opencv.", flush=True)
        return None


def _try_load_opencv():
    try:
        import cv2  # noqa: F401
        import numpy as np  # noqa: F401
    except Exception as e:
        print(f"[som] OpenCV unavailable ({e}); service will return empty marks.", flush=True)
        return None
    return {"kind": "opencv"}


def _try_load_model():
    """Load the best available detector. Records cold-start latency on first
    successful load. Falls through to None (empty marks) when nothing works."""
    global _model, _model_load_attempted, _cold_start_ms
    with _model_lock:
        if _model_load_attempted:
            return _model
        _model_load_attempted = True
        t0 = time.monotonic()
        m = _try_load_omniparser() or _try_load_opencv()
        if m is not None:
            _cold_start_ms = (time.monotonic() - _PROCESS_START) * 1000.0
            print(
                f"[som] detector ready: {m['kind']} "
                f"(load={ (time.monotonic() - t0) * 1000:.1f}ms, "
                f"cold_start={_cold_start_ms:.1f}ms)",
                flush=True,
            )
        else:
            print("[som] no detector available; serving empty marks", flush=True)
        _model = m
        return _model


# ---------------------------------------------------------------------------
# Detection backends
# ---------------------------------------------------------------------------

def _decode_image(image_bytes: bytes):
    """Decode PNG/JPEG bytes to a BGR numpy array. Returns None on failure."""
    try:
        import numpy as np
        import cv2
        arr = np.frombuffer(image_bytes, dtype=np.uint8)
        if arr.size == 0:
            return None
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        return img
    except Exception:
        return None


def _nms(boxes, iou_thresh=0.35):
    """Greedy NMS on (x, y, w, h, score) tuples. Returns survivors."""
    if not boxes:
        return []
    boxes = sorted(boxes, key=lambda b: b[4], reverse=True)
    kept = []
    for b in boxes:
        x1, y1, w1, h1, _ = b
        x2, y2 = x1 + w1, y1 + h1
        a1 = w1 * h1
        drop = False
        for k in kept:
            kx1, ky1, kw, kh, _ = k
            kx2, ky2 = kx1 + kw, ky1 + kh
            ix1, iy1 = max(x1, kx1), max(y1, ky1)
            ix2, iy2 = min(x2, kx2), min(y2, ky2)
            iw, ih = max(0, ix2 - ix1), max(0, iy2 - iy1)
            inter = iw * ih
            union = a1 + kw * kh - inter
            if union <= 0:
                continue
            if inter / union >= iou_thresh:
                drop = True
                break
        if not drop:
            kept.append(b)
    return kept


def _detect_opencv(img):
    """Heuristic UI element + text region detector.

    Honest engineering: this is *not* an OmniParser checkpoint, but it does
    produce real bounding boxes derived from the actual screenshot pixels.
    Use it when OmniParser ONNX is not vendored. The Citrix adapter will
    pick these up just like model marks.
    """
    import cv2
    import numpy as np

    h, w = img.shape[:2]
    if h == 0 or w == 0:
        return []
    min_dim = 10
    max_w, max_h = int(w * 0.85), int(h * 0.85)
    img_area = float(h * w)

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    boxes = []

    # Pass 1: edge-derived rectangular regions (buttons, panels, icons).
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    edges = cv2.Canny(blur, 60, 160)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    dilated = cv2.dilate(edges, kernel, iterations=1)
    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for c in contours:
        x, y, cw, ch = cv2.boundingRect(c)
        if cw < min_dim or ch < min_dim or cw > max_w or ch > max_h:
            continue
        area = cw * ch
        if area / img_area > 0.5:
            continue
        # score by area (clipped) — large clean regions win first.
        score = min(area, 50000)
        boxes.append((x, y, cw, ch, float(score), "ui-element"))

    # Pass 2: MSER for text-like regions.
    try:
        mser = cv2.MSER_create()
        mser.setMinArea(30)
        mser.setMaxArea(int(img_area * 0.05))
        regions, _ = mser.detectRegions(gray)
        for pts in regions:
            x, y, cw, ch = cv2.boundingRect(pts.reshape(-1, 1, 2))
            if cw < min_dim or ch < 8 or cw > max_w or ch > max_h:
                continue
            # text regions tend to be wider than tall
            aspect = cw / max(1, ch)
            if aspect < 0.3:
                continue
            boxes.append((x, y, cw, ch, float(cw * ch), "text"))
    except Exception:
        pass

    # NMS, separately preserving labels.
    scored = [(x, y, w_, h_, s) for (x, y, w_, h_, s, _l) in boxes]
    label_by_key = {(x, y, w_, h_): l for (x, y, w_, h_, _s, l) in boxes}
    kept = _nms(scored, iou_thresh=0.4)
    kept = kept[:MAX_MARKS]

    out = []
    for i, (x, y, cw, ch, _s) in enumerate(kept, start=1):
        out.append({
            "mark": str(i),
            "rect": {"x": int(x), "y": int(y), "w": int(cw), "h": int(ch)},
            "label": label_by_key.get((x, y, cw, ch), "ui-element"),
        })
    return out


def _detect_omniparser(model, img):
    """Run the ONNX OmniParser detect head. Best-effort; on any shape mismatch
    we fall back to the OpenCV path so callers always get something."""
    import numpy as np
    import cv2
    sess = model["detect"]
    in_name = model["input"]
    in_shape = model["input_shape"]
    # Most YOLO-style ONNX exports take NCHW float32 normalized to [0,1].
    target = 640
    for d in in_shape[2:]:
        if isinstance(d, int) and d > 0:
            target = d
            break
    h, w = img.shape[:2]
    scale = min(target / max(1, w), target / max(1, h))
    nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
    resized = cv2.resize(img, (nw, nh))
    canvas = np.zeros((target, target, 3), dtype=np.uint8)
    canvas[:nh, :nw] = resized
    blob = canvas[:, :, ::-1].astype(np.float32) / 255.0  # BGR->RGB
    blob = np.transpose(blob, (2, 0, 1))[None, ...]
    try:
        outputs = sess.run(None, {in_name: blob})
    except Exception as e:
        print(f"[som] omniparser inference failed ({e}); falling back to opencv.", flush=True)
        return _detect_opencv(img)
    # Parse the most common YOLO export shape: [1, N, 6] = (x1,y1,x2,y2,conf,cls)
    raw = outputs[0]
    boxes = []
    try:
        arr = np.asarray(raw)
        if arr.ndim == 3:
            arr = arr[0]
        if arr.shape[-1] >= 5:
            for row in arr:
                conf = float(row[4])
                if conf < 0.25:
                    continue
                x1, y1, x2, y2 = (float(row[0]), float(row[1]), float(row[2]), float(row[3]))
                # un-letterbox
                x1, x2 = x1 / scale, x2 / scale
                y1, y2 = y1 / scale, y2 / scale
                bw, bh = max(0.0, x2 - x1), max(0.0, y2 - y1)
                if bw < 6 or bh < 6:
                    continue
                boxes.append((int(x1), int(y1), int(bw), int(bh), conf, "icon"))
    except Exception as e:
        print(f"[som] omniparser parse failed ({e}); falling back to opencv.", flush=True)
        return _detect_opencv(img)

    if not boxes:
        return _detect_opencv(img)

    scored = [(x, y, w_, h_, s) for (x, y, w_, h_, s, _l) in boxes]
    kept = _nms(scored, iou_thresh=0.45)[:MAX_MARKS]
    return [
        {
            "mark": str(i),
            "rect": {"x": x, "y": y, "w": cw, "h": ch},
            "label": "icon",
        }
        for i, (x, y, cw, ch, _s) in enumerate(kept, start=1)
    ]


def _detect(image_bytes: bytes):
    model = _try_load_model()
    if model is None:
        return []
    img = _decode_image(image_bytes)
    if img is None:
        return []
    try:
        if model["kind"] == "omniparser":
            return _detect_omniparser(model, img)
        return _detect_opencv(img)
    except Exception as e:
        print(f"[som] detect error: {e}", flush=True)
        return []


# ---------------------------------------------------------------------------
# Latency stats
# ---------------------------------------------------------------------------

def _record_latency(ms: float):
    global _request_count
    with _lat_lock:
        _request_count += 1
        _latencies_ms.append(ms)


def _percentile(sorted_vals, pct):
    if not sorted_vals:
        return 0.0
    k = (len(sorted_vals) - 1) * pct
    lo = int(k)
    hi = min(lo + 1, len(sorted_vals) - 1)
    frac = k - lo
    return sorted_vals[lo] * (1 - frac) + sorted_vals[hi] * frac


def _latency_summary():
    with _lat_lock:
        vals = sorted(_latencies_ms)
        count = _request_count
    if not vals:
        return {"count": count, "mean": 0.0, "p50": 0.0, "p95": 0.0, "p99": 0.0, "max": 0.0}
    return {
        "count": count,
        "mean": round(sum(vals) / len(vals), 2),
        "p50": round(_percentile(vals, 0.50), 2),
        "p95": round(_percentile(vals, 0.95), 2),
        "p99": round(_percentile(vals, 0.99), 2),
        "max": round(vals[-1], 2),
    }


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class _Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return  # silence default access log

    def _json(self, code, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            model = _try_load_model()
            self._json(200, {
                "ok": True,
                "model": (model["kind"] if model else "missing"),
                "coldStartMs": (round(_cold_start_ms, 2) if _cold_start_ms is not None else None),
                "uptimeMs": round((time.monotonic() - _PROCESS_START) * 1000.0, 2),
                "requests": _latency_summary(),
            })
            return
        self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/detect":
            self._json(404, {"error": "not found"})
            return
        t0 = time.monotonic()
        try:
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length else b"{}"
            payload = json.loads(body.decode("utf-8") or "{}")
            image_b64 = payload.get("image", "")
            if image_b64.startswith("data:"):
                image_b64 = image_b64.split(",", 1)[-1]
            image_bytes = base64.b64decode(image_b64) if image_b64 else b""
            marks = _detect(image_bytes) if image_bytes else []
            elapsed_ms = (time.monotonic() - t0) * 1000.0
            _record_latency(elapsed_ms)
            self._json(200, {"marks": marks, "elapsedMs": round(elapsed_ms, 2)})
        except Exception as e:
            elapsed_ms = (time.monotonic() - t0) * 1000.0
            _record_latency(elapsed_ms)
            print(f"[som] request error: {e}", flush=True)
            self._json(200, {"marks": [], "error": str(e), "elapsedMs": round(elapsed_ms, 2)})


def main():
    # Eager-load so cold-start latency is paid before the first request and
    # `/health` reports a useful number on the first scrape.
    _try_load_model()
    print(f"[som] som-detector listening on http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), _Handler).serve_forever()


if __name__ == "__main__":
    sys.exit(main() or 0)
