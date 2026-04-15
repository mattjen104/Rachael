#!/usr/bin/env python3
"""
ocr_overlay.py — OCR-based Vimium overlay for Epic Hyperspace via Citrix.

Runs on local Windows machine. No cloud APIs — fully local, HIPAA-compliant.
Uses PaddleOCR for text detection, PyQt5 for the transparent overlay.

Epic's layout is pre-defined from EPIC_VISUAL_REFERENCE:
  Layer 1: Title bar         (~25px from top)       — search bar only
  Layer 2: Shortcut toolbar  (~20px, y≈25–45)       — user-specific buttons
  Layer 3: Workspace tabs    (~22px, y≈45–67)       — open tabs
  Layer 4: Breadcrumb        (~28px, y≈67–95)       — current screen title
  Layer 5: Left sidebar      (left ~120px, full h)  — nav items
  Layer 6: Workspace         (rest of screen)       — forms, tables, content
  Layer 7: Bottom bar        (~25px from bottom)    — Accept, Cancel, Sign

Usage:
  python tools/ocr_overlay.py                  # interactive overlay
  python tools/ocr_overlay.py --scan           # one-shot scan, print elements
  python tools/ocr_overlay.py --correct        # correction mode
"""

import os
import sys
import re
import time
import json
import math
import hashlib
import sqlite3
import threading
import argparse
from dataclasses import dataclass, field, asdict
from typing import Optional

# ─────────────────────────────────────────────────────────────────────────────
# SECTION 1 — Epic Layer Band Definitions
# ─────────────────────────────────────────────────────────────────────────────

# Pixel offsets from TOP of Epic window (absolute px, not relative).
# These are the same regardless of window size — Epic renders fixed-height strips.
LAYER_BANDS = {
    "title_bar":        {"y": 0,   "h": 25,  "x": 0,   "w_frac": 1.0},
    "shortcut_toolbar": {"y": 25,  "h": 20,  "x": 0,   "w_frac": 1.0},
    "workspace_tabs":   {"y": 45,  "h": 22,  "x": 0,   "w_frac": 1.0},
    "activity_tabs":    {"y": 67,  "h": 22,  "x": 0,   "w_frac": 1.0},  # conditional
    "breadcrumb":       {"y": 67,  "h": 28,  "x": 0,   "w_frac": 1.0},  # y adjusts if activity_tabs present
    "sidebar":          {"y": 95,  "h": -1,  "x": 0,   "w": 130},       # h=-1 means to bottom bar
    "workspace":        {"y": 95,  "h": -1,  "x": 130, "w_frac": 1.0},  # x=130 past sidebar
    "bottom_bar":       {"y": -25, "h": 25,  "x": 0,   "w_frac": 1.0},  # y=-25 means from bottom
}

# Layers used for PHI-safe screen fingerprinting
FINGERPRINT_LAYERS = ["shortcut_toolbar", "workspace_tabs", "breadcrumb"]

# Universal elements pre-seeded at confidence=confirmed (appear for all users)
UNIVERSAL_ELEMENTS = [
    {"text": "Log Out",    "layer": "shortcut_toolbar", "semantic": None},
    {"text": "Accept",     "layer": "bottom_bar",       "semantic": "a"},
    {"text": "Cancel",     "layer": "bottom_bar",       "semantic": "c"},
    {"text": "Sign",       "layer": "bottom_bar",       "semantic": None},
    {"text": "Submit",     "layer": "bottom_bar",       "semantic": None},
]

# Permanent semantic shortcuts (user can extend these)
DEFAULT_SEMANTICS = {
    "Accept":   "a",
    "Cancel":   "c",
    "Sign":     "s",
    "Log Out":  "l",   # lowercase — CLI lowercases all hint input before dispatch
}

# PHI patterns to exclude from fingerprinting
_PHI_PATTERNS = [
    re.compile(r"\b[A-Z][a-z]+,\s+[A-Z][a-z]+\b"),          # LastName, FirstName
    re.compile(r"\b\d{1,2}/\d{1,2}/\d{2,4}\b"),              # DOB 01/15/1980
    re.compile(r"\b\d{6,10}\b"),                               # MRN
    re.compile(r"\b\d{1,3}\s*(y|yo|yr|yrs)\b", re.I),        # age
    re.compile(r"\bDOB\b|\bMRN\b|\bDOD\b", re.I),            # explicit PHI labels
]

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ocr_kb.sqlite3")
BRIDGE_URL = os.environ.get("BRIDGE_URL", "http://localhost:5000")
BRIDGE_TOKEN = os.environ.get("BRIDGE_TOKEN", "")


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 2 — OCR Pipeline
# ─────────────────────────────────────────────────────────────────────────────

_ocr_engine = None
_ocr_lock = threading.Lock()


def _get_ocr():
    global _ocr_engine
    if _ocr_engine is None:
        with _ocr_lock:
            if _ocr_engine is None:
                try:
                    from paddleocr import PaddleOCR
                    _ocr_engine = PaddleOCR(
                        use_angle_cls=False,
                        use_gpu=False,
                        show_log=False,
                        lang="en",
                    )
                    print("[ocr] PaddleOCR initialized")
                except ImportError:
                    print("[ocr] PaddleOCR not found — install: pip install paddlepaddle paddleocr")
                    _ocr_engine = "unavailable"
    return _ocr_engine if _ocr_engine != "unavailable" else None


@dataclass
class OcrElement:
    text: str
    layer: str
    rel_x: float    # center x as fraction of window width
    rel_y: float    # center y as fraction of window height
    rel_w: float    # width fraction
    rel_h: float    # height fraction
    confidence: float = 0.0
    abs_cx: int = 0  # absolute screen center x (for clicking)
    abs_cy: int = 0  # absolute screen center y


def _looks_like_phi(text: str) -> bool:
    for pat in _PHI_PATTERNS:
        if pat.search(text):
            return True
    return False


def _get_layer_crop(img_arr, layer_name: str, win_w: int, win_h: int):
    """Compute crop coords for a named layer band. Returns (x1,y1,x2,y2) or None."""
    b = LAYER_BANDS.get(layer_name)
    if not b:
        return None
    x1 = b.get("x", 0)
    w = int(b.get("w_frac", 0) * win_w) if "w_frac" in b else b.get("w", win_w)
    x2 = min(x1 + w, win_w)
    y_raw = b.get("y", 0)
    y1 = y_raw if y_raw >= 0 else max(0, win_h + y_raw)
    h = b.get("h", 0)
    y2 = (y1 + h) if h > 0 else max(0, win_h - 25)  # h=-1 means to bottom_bar top
    y2 = min(y2, win_h)
    if x2 <= x1 or y2 <= y1:
        return None
    return (x1, y1, x2, y2)


def scan_window(window_title: str, with_activity_tabs: bool = False) -> list[OcrElement]:
    """Screenshot the named window and run per-layer OCR. Returns OcrElement list."""
    try:
        import mss
        import numpy as np
        from PIL import Image
    except ImportError:
        print("[ocr] mss/PIL not available")
        return []

    ocr = _get_ocr()
    if not ocr:
        return []

    # Find window
    try:
        import pygetwindow as gw
        wins = [w for w in gw.getAllWindows() if window_title.lower() in (w.title or "").lower() and w.width > 100]
    except Exception:
        wins = []
    if not wins:
        print(f"[ocr] Window not found: {window_title}")
        return []
    win = wins[0]
    win_left, win_top, win_w, win_h = win.left, win.top, win.width, win.height

    # Capture
    with mss.mss() as sct:
        region = {"left": win_left, "top": win_top, "width": win_w, "height": win_h}
        shot = sct.grab(region)
        img_arr = np.array(shot)  # BGRA
        img_arr = img_arr[:, :, :3]  # drop alpha → BGR

    elements: list[OcrElement] = []

    # Determine which layers to scan
    scan_layers = list(LAYER_BANDS.keys())
    # Adjust breadcrumb y if activity tabs visible
    if with_activity_tabs:
        LAYER_BANDS["breadcrumb"]["y"] = 89
    else:
        LAYER_BANDS["breadcrumb"]["y"] = 67
    # Don't scan activity_tabs if not in patient chart (reduces noise)
    if not with_activity_tabs:
        scan_layers = [l for l in scan_layers if l != "activity_tabs"]
    # Skip title_bar (rarely clickable, search bar handled separately)
    scan_layers = [l for l in scan_layers if l != "title_bar"]

    for layer_name in scan_layers:
        crop = _get_layer_crop(img_arr, layer_name, win_w, win_h)
        if crop is None:
            continue
        x1, y1, x2, y2 = crop
        band = img_arr[y1:y2, x1:x2]
        if band.size == 0:
            continue

        try:
            result = ocr.ocr(band, cls=False)
        except Exception as e:
            print(f"[ocr] OCR error on layer {layer_name}: {e}")
            continue

        if not result or not result[0]:
            continue

        for line in result[0]:
            bbox_pts, (text, conf) = line
            text = text.strip()
            if not text or conf < 0.5:
                continue

            # bbox_pts = [[x1,y1],[x2,y1],[x2,y2],[x1,y2]] relative to band
            xs = [p[0] for p in bbox_pts]
            ys = [p[1] for p in bbox_pts]
            bx1, bx2 = min(xs), max(xs)
            by1, by2 = min(ys), max(ys)

            # Convert to absolute window coords (center)
            abs_bx1 = x1 + bx1
            abs_by1 = y1 + by1
            abs_bx2 = x1 + bx2
            abs_by2 = y1 + by2
            abs_cx = (abs_bx1 + abs_bx2) // 2
            abs_cy = (abs_by1 + abs_by2) // 2

            elements.append(OcrElement(
                text=text,
                layer=layer_name,
                rel_x=(abs_bx1 + abs_bx2) / 2 / win_w,
                rel_y=(abs_by1 + abs_by2) / 2 / win_h,
                rel_w=(abs_bx2 - abs_bx1) / win_w,
                rel_h=(abs_by2 - abs_by1) / win_h,
                confidence=conf,
                abs_cx=win_left + abs_cx,
                abs_cy=win_top + abs_cy,
            ))

    return elements


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 3 — SQLite Knowledge Base
# ─────────────────────────────────────────────────────────────────────────────

_SCHEMA = """
CREATE TABLE IF NOT EXISTS elements (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    text          TEXT NOT NULL,
    layer         TEXT NOT NULL,
    rel_x         REAL NOT NULL,
    rel_y         REAL NOT NULL,
    rel_w         REAL NOT NULL,
    rel_h         REAL NOT NULL,
    screen_fps    TEXT DEFAULT '[]',
    confidence    TEXT DEFAULT 'seen',
    click_count   INTEGER DEFAULT 0,
    semantic      TEXT DEFAULT NULL,
    is_correction INTEGER DEFAULT 0,
    created_at    REAL NOT NULL,
    updated_at    REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS screen_fingerprints (
    fp            TEXT PRIMARY KEY,
    activity_name TEXT,
    layer_texts   TEXT DEFAULT '{}',
    first_seen    REAL NOT NULL,
    last_seen     REAL NOT NULL,
    visit_count   INTEGER DEFAULT 1
);
CREATE TABLE IF NOT EXISTS fp_bridge (
    phash_fp  TEXT PRIMARY KEY,
    ocr_fp    TEXT NOT NULL,
    updated_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_elements_text ON elements(text);
CREATE INDEX IF NOT EXISTS idx_elements_layer ON elements(layer);
CREATE INDEX IF NOT EXISTS idx_elements_confidence ON elements(confidence);
CREATE INDEX IF NOT EXISTS idx_fp_bridge_ocr ON fp_bridge(ocr_fp);
"""

CONFIDENCE_TIERS = ["seen", "confirmed", "reliable", "named"]
RELIABLE_THRESHOLD = 5


def _db_connect():
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    conn.commit()
    return conn


def _seed_universal_elements(conn):
    """Pre-seed universal Epic elements (Accept, Cancel, etc.) at 'confirmed' confidence."""
    now = time.time()
    for elem in UNIVERSAL_ELEMENTS:
        existing = conn.execute(
            "SELECT id FROM elements WHERE text=? AND layer=? AND is_correction=0",
            (elem["text"], elem["layer"])
        ).fetchone()
        if not existing:
            semantic = elem.get("semantic") or DEFAULT_SEMANTICS.get(elem["text"])
            conn.execute(
                "INSERT INTO elements (text,layer,rel_x,rel_y,rel_w,rel_h,confidence,semantic,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?,?,?)",
                (elem["text"], elem["layer"], 0.5, 0.98, 0.05, 0.02, "confirmed", semantic, now, now)
            )
    conn.commit()


def upsert_element(conn, elem: OcrElement, screen_fp: str) -> int:
    """Insert or update an element in the KB. Returns element id."""
    now = time.time()
    # Find existing by text+layer within proximity (±5% of window)
    existing = conn.execute(
        "SELECT id, confidence, click_count, screen_fps, semantic FROM elements "
        "WHERE text=? AND layer=? AND ABS(rel_x-?)<=0.08 AND ABS(rel_y-?)<=0.05 AND is_correction=0",
        (elem.text, elem.layer, elem.rel_x, elem.rel_y)
    ).fetchone()

    if existing:
        fps = json.loads(existing["screen_fps"] or "[]")
        if screen_fp and screen_fp not in fps:
            fps.append(screen_fp)
        conn.execute(
            "UPDATE elements SET rel_x=?, rel_y=?, rel_w=?, rel_h=?, screen_fps=?, updated_at=? WHERE id=?",
            (elem.rel_x, elem.rel_y, elem.rel_w, elem.rel_h, json.dumps(fps), now, existing["id"])
        )
        conn.commit()
        return existing["id"]
    else:
        fps = [screen_fp] if screen_fp else []
        semantic = DEFAULT_SEMANTICS.get(elem.text)
        cur = conn.execute(
            "INSERT INTO elements (text,layer,rel_x,rel_y,rel_w,rel_h,screen_fps,confidence,semantic,created_at,updated_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (elem.text, elem.layer, elem.rel_x, elem.rel_y, elem.rel_w, elem.rel_h,
             json.dumps(fps), "seen", semantic, now, now)
        )
        conn.commit()
        return cur.lastrowid


def promote_element(conn, elem_id: int, label: str = None):
    """Promote an element's confidence tier after a confirmed click."""
    now = time.time()
    row = conn.execute(
        "SELECT text, confidence, click_count, semantic FROM elements WHERE id=?", (elem_id,)
    ).fetchone()
    if not row:
        return
    count = (row["click_count"] or 0) + 1
    current = row["confidence"]
    tier_idx = CONFIDENCE_TIERS.index(current) if current in CONFIDENCE_TIERS else 0
    if current != "named":
        if count >= RELIABLE_THRESHOLD and tier_idx < CONFIDENCE_TIERS.index("reliable"):
            tier_idx = CONFIDENCE_TIERS.index("reliable")
        elif count == 1 and current == "seen":
            tier_idx = CONFIDENCE_TIERS.index("confirmed")
    new_confidence = "named" if label else CONFIDENCE_TIERS[tier_idx]
    semantic = label if label else row["semantic"]
    # Auto-assign semantic from DEFAULT_SEMANTICS when element first reaches reliable/named
    if not semantic and new_confidence in ("reliable", "named"):
        semantic = DEFAULT_SEMANTICS.get(row["text"])
    conn.execute(
        "UPDATE elements SET click_count=?, confidence=?, semantic=?, updated_at=? WHERE id=?",
        (count, new_confidence, semantic, now, elem_id)
    )
    conn.commit()


def get_semantic_map(conn) -> dict[str, str]:
    """
    Return a text → shortcut-key mapping from the KB (confirmed+ elements with semantic set).
    This loads user-learned semantics across sessions, not just the hardcoded DEFAULT_SEMANTICS.
    All shortcut keys are normalized to lowercase so they match the CLI which calls
    hint.toLowerCase() before dispatching (cli-engine.ts line ~5407).
    """
    rows = conn.execute(
        "SELECT text, semantic FROM elements WHERE semantic IS NOT NULL AND semantic != '' "
        "AND confidence IN ('confirmed','reliable','named')"
    ).fetchall()
    # Normalize semantic keys to lowercase for consistent CLI dispatch
    result = {r["text"]: r["semantic"].lower() for r in rows}
    # Fill in defaults for anything not in KB yet (DEFAULT_SEMANTICS already all lowercase)
    for text, key in DEFAULT_SEMANTICS.items():
        if text not in result:
            result[text] = key
    return result


def get_reliable_elements(conn, screen_fp: str, layer: str = None) -> list[dict]:
    """Return reliable/confirmed elements for a screen, optionally filtered by layer."""
    query = "SELECT * FROM elements WHERE confidence IN ('confirmed','reliable','named')"
    params = []
    if screen_fp:
        query += " AND (screen_fps LIKE ? OR screen_fps='[]' OR is_correction=1)"
        params.append(f'%{screen_fp}%')
    if layer:
        query += " AND layer=?"
        params.append(layer)
    rows = conn.execute(query, params).fetchall()
    return [dict(r) for r in rows]


def save_correction(conn, text: str, layer: str, rel_x: float, rel_y: float,
                    rel_w: float, rel_h: float, screen_fp: str, semantic: str = None):
    """Save a user correction at highest confidence."""
    now = time.time()
    fps = json.dumps([screen_fp] if screen_fp else [])
    conn.execute(
        "INSERT INTO elements (text,layer,rel_x,rel_y,rel_w,rel_h,screen_fps,confidence,semantic,is_correction,created_at,updated_at) "
        "VALUES (?,?,?,?,?,?,?,'named',?,1,?,?)",
        (text, layer, rel_x, rel_y, rel_w, rel_h, fps, semantic, now, now)
    )
    conn.commit()


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 4 — Text-based Screen Fingerprinter
# ─────────────────────────────────────────────────────────────────────────────

def compute_screen_fp(elements: list[OcrElement]) -> str:
    """
    Hash the stable text labels from Layers 2+3+4 only, excluding PHI.
    Returns a hex string fingerprint.
    """
    stable_texts = []
    for e in elements:
        if e.layer not in FINGERPRINT_LAYERS:
            continue
        if _looks_like_phi(e.text):
            continue
        if len(e.text) < 2 or len(e.text) > 60:
            continue
        stable_texts.append(e.text.strip().lower())
    stable_texts.sort()
    blob = "|".join(stable_texts)
    return hashlib.sha1(blob.encode()).hexdigest()[:16]


def save_screen_fp(conn, fp: str, elements: list[OcrElement]):
    """Record a screen fingerprint with its layer text snapshot."""
    layer_texts: dict[str, list[str]] = {}
    for e in elements:
        if e.layer in FINGERPRINT_LAYERS and not _looks_like_phi(e.text):
            layer_texts.setdefault(e.layer, []).append(e.text)

    now = time.time()
    existing = conn.execute("SELECT visit_count FROM screen_fingerprints WHERE fp=?", (fp,)).fetchone()
    if existing:
        conn.execute(
            "UPDATE screen_fingerprints SET last_seen=?, visit_count=visit_count+1 WHERE fp=?",
            (now, fp)
        )
    else:
        conn.execute(
            "INSERT INTO screen_fingerprints (fp,layer_texts,first_seen,last_seen) VALUES (?,?,?,?)",
            (fp, json.dumps(layer_texts), now, now)
        )
    conn.commit()


def get_activity_for_fp(conn, fp: str) -> str:
    """Look up the activity name associated with a screen fingerprint."""
    row = conn.execute("SELECT activity_name FROM screen_fingerprints WHERE fp=?", (fp,)).fetchone()
    return row["activity_name"] if row and row["activity_name"] else ""


def tag_fp_activity(conn, fp: str, activity_name: str):
    """Associate an activity name with a screen fingerprint."""
    conn.execute(
        "UPDATE screen_fingerprints SET activity_name=? WHERE fp=?",
        (activity_name, fp)
    )
    conn.commit()


def _compute_window_phash(win_title: str) -> str:
    """
    Compute the same 8×8 average perceptual hash that epic_agent.py uses
    (_session_phash / _SESSION_HASH_SIZE=8) so that OCR-KB fingerprints can
    be cross-referenced with navigation-tree node keys.

    Returns a 16-char hex string, or '0' on failure.
    """
    try:
        import pygetwindow as _gw
        import mss as _mss
        from PIL import Image as _Image
        wins = [w for w in _gw.getAllWindows()
                if win_title.lower() in (w.title or "").lower() and w.width > 100]
        if not wins:
            return "0"
        w = wins[0]
        with _mss.mss() as sct:
            region = {"left": w.left, "top": w.top, "width": w.width, "height": w.height}
            shot = sct.grab(region)
            img = _Image.frombytes("RGB", shot.size, shot.rgb)
        SZ = 8
        small = img.resize((SZ, SZ), _Image.LANCZOS).convert("L")
        pixels = list(small.getdata())
        avg = sum(pixels) / len(pixels) if pixels else 128
        bits = "".join("1" if p > avg else "0" for p in pixels)
        return hex(int(bits, 2))[2:].zfill((SZ * SZ) // 4)
    except Exception:
        return "0"


def save_fp_bridge(conn, phash_fp: str, ocr_fp: str):
    """
    Record the mapping from a pHash fingerprint (used by epic_agent navigation
    tree nodes) to the OCR text fingerprint (used by this module's KB entries).
    This is the key cross-reference that lets get_ocr_kb_summary work correctly
    when called from the agent heartbeat loop (which passes pHash fps).
    """
    if not phash_fp or phash_fp == "0":
        return
    conn.execute(
        "INSERT OR REPLACE INTO fp_bridge (phash_fp, ocr_fp, updated_at) VALUES (?,?,?)",
        (phash_fp, ocr_fp, time.time())
    )
    conn.commit()


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 5 — Hint Key Generation (mirror of epic_agent.py _generate_hint_keys)
# ─────────────────────────────────────────────────────────────────────────────

def generate_hint_keys(count: int) -> list[str]:
    """Generate Vimium-style two-char hint keys: as, sd, df, ..."""
    singles = "1234567890asdfghjklqwertyuiopzxcvbnm"
    keys = list(singles)
    if count <= len(keys):
        return keys[:count]
    for a in "asdfghjkl":
        for b in singles:
            keys.append(a + b)
            if len(keys) >= count:
                return keys[:count]
    return keys[:count]


# Layer display colors for hints (terminal ANSI; Qt uses these too)
LAYER_COLORS = {
    "shortcut_toolbar": "#FFD700",   # gold
    "workspace_tabs":   "#87CEEB",   # sky blue
    "activity_tabs":    "#98FB98",   # pale green
    "breadcrumb":       "#DDA0DD",   # plum
    "sidebar":          "#F0E68C",   # khaki
    "workspace":        "#FFFFFF",   # white
    "bottom_bar":       "#FFA07A",   # light salmon
}


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 6 — PyQt5 Transparent Overlay
# ─────────────────────────────────────────────────────────────────────────────

def _parse_hotkey_combo(combo: str):
    """
    Parse a hotkey combo string like "ctrl+shift+h" into (mods_frozenset, trigger).

    mods_frozenset — frozenset of modifier names e.g. frozenset({'ctrl','shift'})
    trigger        — lowercase single char e.g. 'h', or a pynput Key name e.g. 'f9'

    Examples:
        "ctrl+shift+h"  → (frozenset({'ctrl','shift'}), 'h')
        "ctrl+alt+f9"   → (frozenset({'ctrl','alt'}),   'f9')
        "scroll_lock"   → (frozenset(), 'scroll_lock')
    """
    _MODS = {"ctrl", "control", "shift", "alt", "cmd", "super", "win"}
    parts = [p.strip().lower() for p in combo.replace("-", "+").split("+")]
    mods = frozenset(p for p in parts if p in _MODS or p in ("control",))
    # Normalise "control" → "ctrl"
    mods = frozenset("ctrl" if m == "control" else m for m in mods)
    trigger_parts = [p for p in parts if p not in _MODS and p != "control"]
    trigger = trigger_parts[0] if trigger_parts else ""
    return mods, trigger


def _hotkey_matches(mods_held: set, key, mods_wanted: frozenset, trigger: str) -> bool:
    """
    Return True when the currently-held modifiers match mods_wanted and key
    matches the trigger character/name.
    """
    try:
        from pynput import keyboard as pk
        # Normalise held modifiers to simple names
        norm = set()
        for m in mods_held:
            s = str(m)
            if "ctrl" in s or "control" in s:   norm.add("ctrl")
            elif "shift" in s:                   norm.add("shift")
            elif "alt" in s:                     norm.add("alt")
            elif "cmd" in s or "super" in s:     norm.add("cmd")
        if norm != set(mods_wanted):
            return False
        # Match trigger: single char
        if len(trigger) == 1:
            return hasattr(key, 'char') and key.char and key.char.lower() == trigger
        # Match trigger: named key (f9, scroll_lock, pause …)
        try:
            wanted_key = getattr(pk.Key, trigger)
            return key == wanted_key
        except AttributeError:
            return False
    except Exception:
        return False


class OverlayWindow:
    """
    PyQt5 transparent always-on-top overlay that draws Vimium hints over Epic.

    Hotkeys (configurable via --hint-key / --correct-key; defaults avoid Epic conflicts):
      Ctrl+Shift+H — Toggle hints on/off
      Ctrl+Shift+C — Toggle correction mode
      Escape      — Hide hints / cancel input
      0-9, a-z    — Hint selection (multi-char, fires after 600ms idle)
      Backspace   — Delete last hint char
    """

    def __init__(self, win_title: str, db_path: str = DB_PATH,
                 hint_key: str = "ctrl+shift+h", correct_key: str = "ctrl+shift+c"):
        self.win_title = win_title
        self.db_path = db_path
        self.conn = _db_connect()
        _seed_universal_elements(self.conn)

        self._hint_key_name    = hint_key
        self._correct_key_name = correct_key
        self._hint_mods,    self._hint_trigger    = _parse_hotkey_combo(hint_key)
        self._correct_mods, self._correct_trigger = _parse_hotkey_combo(correct_key)

        self.elements: list[OcrElement] = []
        self.hint_map: dict[str, OcrElement] = {}
        self.current_input = ""
        self.visible = False
        self.correction_mode = False
        self._current_phash: str = "0"    # updated by refresh(); same algo as epic_agent._session_phash
        self._pending_input_timer = None

        self._app = None
        self._window = None
        self._scene = None

        # Correction mode state
        self._corr_selected: Optional[dict] = None     # currently selected KB element
        self._corr_drawing: bool = False               # True while rubber-band drawing
        self._corr_drag_start: Optional[tuple] = None  # (scene_x, scene_y) drag start
        self._corr_new_rect: Optional[tuple] = None    # (x, y, w, h) in scene coords
        self._corr_resize_mode: bool = False           # True when resizing (vs moving) selected
        self._QInputDialog = None                      # set during run() when Qt is available

    def _find_epic_window(self):
        try:
            import pygetwindow as gw
            wins = [w for w in gw.getAllWindows()
                    if self.win_title.lower() in (w.title or "").lower() and w.width > 100]
            return wins[0] if wins else None
        except Exception:
            return None

    def refresh(self):
        """Re-scan and update hints on the overlay."""
        win = self._find_epic_window()
        if not win:
            print(f"[overlay] Epic window not found: {self.win_title}")
            return

        has_activity_tabs = self._check_activity_tabs()
        self.elements = scan_window(self.win_title, with_activity_tabs=has_activity_tabs)

        fp = compute_screen_fp(self.elements)
        self._current_phash = _compute_window_phash(self.win_title)
        save_screen_fp(self.conn, fp, self.elements)
        for e in self.elements:
            upsert_element(self.conn, e, fp)
        # Bridge pHash (navigation tree key) ↔ OCR text fp (KB key)
        save_fp_bridge(self.conn, self._current_phash, fp)

        # Merge in reliable KB elements for this screen
        reliable = get_reliable_elements(self.conn, fp)
        reliable_set = {(r["text"], r["layer"]) for r in reliable}
        seen_set = {(e.text, e.layer) for e in self.elements}
        for r in reliable:
            if (r["text"], r["layer"]) not in seen_set:
                win_obj = self._find_epic_window()
                if win_obj:
                    self.elements.append(OcrElement(
                        text=r["text"], layer=r["layer"],
                        rel_x=r["rel_x"], rel_y=r["rel_y"],
                        rel_w=r["rel_w"], rel_h=r["rel_h"],
                        confidence=0.99,
                        abs_cx=win_obj.left + int(r["rel_x"] * win_obj.width),
                        abs_cy=win_obj.top + int(r["rel_y"] * win_obj.height),
                    ))

        # Build collision-free hint map:
        # 1. Load semantic map from KB (user-learned) merged with DEFAULT_SEMANTICS
        # 2. Reserve semantic keys so positional keys never collide with them
        sem_map = get_semantic_map(self.conn)   # text -> shortcut key (KB + defaults)
        reserved_keys = set(sem_map.values())
        # Generate enough candidates then strip reserved keys for positional use
        candidates = generate_hint_keys(len(self.elements) + len(reserved_keys) + 10)
        positional_keys = [k for k in candidates if k not in reserved_keys]

        self.hint_map = {}
        # First pass: assign semantic shortcuts (exact matches from KB/defaults)
        for e in self.elements:
            sem = sem_map.get(e.text)
            if sem and sem not in self.hint_map:
                self.hint_map[sem] = e

        # Second pass: positional hints for everything without a semantic shortcut
        ki = 0
        for e in self.elements:
            if any(self.hint_map.get(k) is e for k in self.hint_map):
                continue
            while ki < len(positional_keys) and positional_keys[ki] in self.hint_map:
                ki += 1
            if ki < len(positional_keys):
                self.hint_map[positional_keys[ki]] = e
                ki += 1

        print(f"[overlay] {len(self.elements)} elements, fp={fp[:8]}")
        self._redraw()

    def _check_activity_tabs(self) -> bool:
        """Quick check: are activity tabs visible? (patient chart context)"""
        # Heuristic: scan just the activity_tabs y-band for known clinical tab names
        win = self._find_epic_window()
        if not win:
            return False
        try:
            import mss, numpy as np
            with mss.mss() as sct:
                region = {"left": win.left, "top": win.top + 45,
                          "width": win.width, "height": 24}
                shot = sct.grab(region)
                arr = np.array(shot)[:, :, :3]
            ocr = _get_ocr()
            if not ocr:
                return False
            result = ocr.ocr(arr, cls=False)
            if not result or not result[0]:
                return False
            texts = [line[1][0].lower() for line in result[0] if line]
            clinical_tabs = {"snapshot", "chart review", "synopsis", "results", "demographics",
                             "allergies", "history", "problem list", "orders", "flowsheet"}
            return any(any(ct in t for ct in clinical_tabs) for t in texts)
        except Exception:
            return False

    def fire_hint(self, hint: str):
        """Execute the action for a given hint key."""
        elem = self.hint_map.get(hint)
        if not elem:
            print(f"[overlay] Unknown hint: {hint!r}  (available: {list(self.hint_map.keys())[:20]})")
            return

        print(f"[overlay] Firing hint '{hint}' → {elem.text!r} ({elem.layer}) at ({elem.abs_cx},{elem.abs_cy})")

        # Click the element
        try:
            import pyautogui
            pyautogui.moveTo(elem.abs_cx, elem.abs_cy)
            time.sleep(0.1)
            pyautogui.click(elem.abs_cx, elem.abs_cy)
        except Exception as e:
            print(f"[overlay] Click failed: {e}")
            return

        # Promote confidence in KB
        fp = compute_screen_fp(self.elements)
        existing = self.conn.execute(
            "SELECT id FROM elements WHERE text=? AND layer=? AND ABS(rel_x-?)<=0.08",
            (elem.text, elem.layer, elem.rel_x)
        ).fetchone()
        if existing:
            promote_element(self.conn, existing["id"])

        # Report to server
        self._report_click(elem, hint, fp)

        # Refresh hints after click settles
        time.sleep(0.8)
        self.refresh()

    def _report_click(self, elem: OcrElement, hint: str, fp: str):
        """Send confirmed element click to Rachael server via bridge."""
        if not BRIDGE_TOKEN:
            return
        try:
            import urllib.request
            win = self._find_epic_window()
            win_title = win.title if win else self.win_title
            payload = json.dumps({
                "fingerprint": fp,              # OCR text fp (KB key)
                "phashFingerprint": self._current_phash,   # pHash fp (navigation tree key)
                "windowTitle": win_title,
                "element": {
                    "text": elem.text,
                    "layer": elem.layer,
                    "rel_x": elem.rel_x,
                    "rel_y": elem.rel_y,
                    "rel_w": elem.rel_w,
                    "rel_h": elem.rel_h,
                    "hint": hint,
                },
            }).encode()
            req = urllib.request.Request(
                f"{BRIDGE_URL}/api/epic/ocr/click",
                data=payload,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {BRIDGE_TOKEN}",
                },
                method="POST",
            )
            urllib.request.urlopen(req, timeout=3)
        except Exception:
            pass

    def _redraw(self):
        """Update the Qt overlay scene with current hints."""
        if self._scene is None:
            return
        from PyQt5.QtWidgets import QGraphicsTextItem, QGraphicsRectItem
        from PyQt5.QtCore import Qt, QRectF
        from PyQt5.QtGui import QColor, QFont, QPen, QBrush

        self._scene.clear()
        if not self.visible:
            return

        win = self._find_epic_window()
        if not win:
            return
        ww, wh = win.width, win.height

        font = QFont("Consolas", 9, QFont.Bold)
        for hint_key, elem in self.hint_map.items():
            cx = int(elem.rel_x * ww)
            cy = int(elem.rel_y * wh)
            color_hex = LAYER_COLORS.get(elem.layer, "#FFFFFF")
            color = QColor(color_hex)

            # Background box
            text_w, text_h = max(len(hint_key) * 8 + 6, 20), 16
            rect = QGraphicsRectItem(cx - text_w // 2, cy - text_h // 2, text_w, text_h)
            rect.setBrush(QBrush(color))
            rect.setPen(QPen(QColor("#000000"), 1))
            rect.setOpacity(0.88)
            self._scene.addItem(rect)

            # Hint text
            text_item = QGraphicsTextItem(hint_key)
            text_item.setFont(font)
            text_item.setDefaultTextColor(QColor("#000000"))
            text_item.setPos(cx - text_w // 2 + 2, cy - text_h // 2)
            self._scene.addItem(text_item)

    def run(self):
        """Start the Qt event loop with the overlay window."""
        try:
            from PyQt5.QtWidgets import QApplication, QGraphicsView, QGraphicsScene, QInputDialog
            from PyQt5.QtCore import Qt, QTimer
            from PyQt5.QtGui import QColor
        except ImportError:
            print("[overlay] PyQt5 not installed — pip install PyQt5")
            return

        self._QInputDialog = QInputDialog
        overlay_ref = self  # closure ref for CorrectionView

        class CorrectionView(QGraphicsView):
            """QGraphicsView subclass that routes mouse events to correction mode handlers."""
            def mousePressEvent(self, event):
                if overlay_ref.correction_mode:
                    pos = self.mapToScene(event.pos())
                    overlay_ref.correction_press(
                        pos.x(), pos.y(),
                        right_button=(event.button() == Qt.RightButton)
                    )
                else:
                    super().mousePressEvent(event)

            def mouseMoveEvent(self, event):
                if overlay_ref.correction_mode and event.buttons():
                    pos = self.mapToScene(event.pos())
                    overlay_ref.correction_move(pos.x(), pos.y())
                else:
                    super().mouseMoveEvent(event)

            def mouseReleaseEvent(self, event):
                if overlay_ref.correction_mode:
                    pos = self.mapToScene(event.pos())
                    overlay_ref.correction_release(pos.x(), pos.y())
                else:
                    super().mouseReleaseEvent(event)

        self._app = QApplication.instance() or QApplication(sys.argv)

        self._scene = QGraphicsScene()
        self._window = CorrectionView(self._scene)
        self._window.setWindowFlags(
            Qt.WindowStaysOnTopHint |
            Qt.FramelessWindowHint |
            Qt.Tool
        )
        self._window.setAttribute(Qt.WA_TranslucentBackground)
        self._window.setAttribute(Qt.WA_ShowWithoutActivating)
        self._window.setStyleSheet("background: transparent; border: none;")
        self._window.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        self._window.setVerticalScrollBarPolicy(Qt.ScrollBarAlwaysOff)

        win = self._find_epic_window()
        if win:
            self._window.setGeometry(win.left, win.top, win.width, win.height)
            self._scene.setSceneRect(0, 0, win.width, win.height)
        self._window.show()

        # ── Hotkey listener setup ─────────────────────────────────────────────
        # Two separate pynput listeners:
        #   1. hotkey_listener (suppress=False) — always running; handles toggle combos only.
        #   2. hint_listener  (suppress=True)  — started when hints become visible so
        #      typed hint chars are consumed here and do NOT reach the Citrix/Epic app.
        # All Qt object access (QGraphicsScene etc.) is routed through QTimer.singleShot(0,…)
        # so it always executes on the Qt main thread.
        self._suppress_listener = None
        self._suppress_lock = threading.Lock()

        try:
            from pynput import keyboard as pk

            def _dispatch(fn):
                """Schedule fn() on the Qt main thread (thread-safe from any thread)."""
                QTimer.singleShot(0, fn)

            def _stop_suppress_listener():
                with self._suppress_lock:
                    if self._suppress_listener:
                        try:
                            self._suppress_listener.stop()
                        except Exception:
                            pass
                        self._suppress_listener = None

            def _start_suppress_listener():
                """Start a suppressing listener so hint keys don't reach the Epic app."""
                with self._suppress_lock:
                    if self._suppress_listener and getattr(self._suppress_listener, 'running', False):
                        return

                    def on_hint_press(key):
                        try:
                            k = key.char if hasattr(key, 'char') and key.char else None
                        except Exception:
                            k = None
                        if key == pk.Key.esc:
                            def _esc():
                                self.current_input = ""
                                self.visible = False
                                _stop_suppress_listener()
                                self._redraw()
                            _dispatch(_esc)
                        elif key == pk.Key.backspace:
                            def _bs():
                                self.current_input = self.current_input[:-1]
                                self._redraw()
                            _dispatch(_bs)
                        elif k:
                            def _char(c=k):
                                self.current_input += c
                                self._schedule_input_fire()
                            _dispatch(_char)

                    sl = pk.Listener(on_press=on_hint_press, suppress=True)
                    sl.daemon = True
                    sl.start()
                    self._suppress_listener = sl

            # Store helpers on self so toggle_hints can access them
            self._start_suppress_listener = _start_suppress_listener
            self._stop_suppress_listener = _stop_suppress_listener

            # Non-suppressing listener: tracks modifier state and fires on full combo match.
            # Uses on_press + on_release so Ctrl+Shift+H works reliably without
            # interfering with any Epic key bindings.
            _mods_held: set = set()
            _mods_lock = threading.Lock()

            def on_hotkey_press(key):
                with _mods_lock:
                    # Track held modifiers
                    try:
                        if key in (pk.Key.ctrl_l, pk.Key.ctrl_r, pk.Key.ctrl):
                            _mods_held.add(key)
                        elif key in (pk.Key.shift, pk.Key.shift_l, pk.Key.shift_r):
                            _mods_held.add(key)
                        elif key in (pk.Key.alt_l, pk.Key.alt_r, pk.Key.alt_gr, pk.Key.alt):
                            _mods_held.add(key)
                        elif key in (pk.Key.cmd, pk.Key.cmd_l, pk.Key.cmd_r):
                            _mods_held.add(key)
                    except Exception:
                        pass
                    held_snapshot = set(_mods_held)

                if _hotkey_matches(held_snapshot, key, self._hint_mods, self._hint_trigger):
                    _dispatch(self.toggle_hints)
                elif _hotkey_matches(held_snapshot, key, self._correct_mods, self._correct_trigger):
                    _dispatch(self.toggle_correction)

            def on_hotkey_release(key):
                with _mods_lock:
                    _mods_held.discard(key)

            hotkey_listener = pk.Listener(on_press=on_hotkey_press,
                                          on_release=on_hotkey_release,
                                          suppress=False)
            hotkey_listener.daemon = True
            hotkey_listener.start()
        except ImportError:
            print("[overlay] pynput not installed — hotkeys disabled (pip install pynput)")

        # Timer to track and reposition the overlay to Epic window
        def reposition():
            w = self._find_epic_window()
            if w and self._window:
                self._window.setGeometry(w.left, w.top, w.width, w.height)
                self._scene.setSceneRect(0, 0, w.width, w.height)

        timer = QTimer()
        timer.timeout.connect(reposition)
        timer.start(500)

        hk = self._hint_key_name.replace("_", " ").title()
        ck = self._correct_key_name.replace("_", " ").title()
        print(f"[overlay] Running. {hk}=toggle hints, {ck}=correction mode, Esc=cancel")
        self._app.exec_()

    def toggle_hints(self):
        self.visible = not self.visible
        if self.visible:
            self.refresh()
            # Start suppressing listener so hint keys don't reach Citrix/Epic
            getattr(self, '_start_suppress_listener', lambda: None)()
        else:
            self._scene and self._scene.clear()
            # Stop suppressing — normal keyboard input returns to Epic
            getattr(self, '_stop_suppress_listener', lambda: None)()
        print(f"[overlay] Hints {'visible' if self.visible else 'hidden'}")

    def toggle_correction(self):
        self.correction_mode = not self.correction_mode
        if self.correction_mode:
            self._draw_correction_grid()
        else:
            self._redraw()
        print(f"[overlay] Correction mode {'ON' if self.correction_mode else 'OFF'}")

    def _schedule_input_fire(self):
        if self._pending_input_timer:
            try:
                self._pending_input_timer.cancel()
            except Exception:
                pass
        # Timer fires on a background thread; use QTimer.singleShot(0, …) to
        # marshal _try_fire_input back onto the Qt main thread before touching any Qt objects.
        try:
            from PyQt5.QtCore import QTimer as _QTimer
            self._pending_input_timer = threading.Timer(
                0.6, lambda: _QTimer.singleShot(0, self._try_fire_input)
            )
        except ImportError:
            self._pending_input_timer = threading.Timer(0.6, self._try_fire_input)
        self._pending_input_timer.daemon = True
        self._pending_input_timer.start()

    def _try_fire_input(self):
        inp = self.current_input
        self.current_input = ""
        if inp in self.hint_map:
            self.fire_hint(inp)
        else:
            print(f"[overlay] No hint '{inp}'")


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 7 — Correction Mode (grid, mouse interaction, element editing)
# ─────────────────────────────────────────────────────────────────────────────

    def _classify_layer_by_pos(self, scene_x: float, scene_y: float) -> str:
        """Map scene coords to the nearest Epic layer name using fixed pixel bands."""
        win = self._find_epic_window()
        wh = win.height if win else 1080
        ww = win.width if win else 1920
        y = scene_y
        from_bottom = wh - y
        if y < 25:                                          return "title_bar"
        if y < 45:                                          return "shortcut_toolbar"
        if y < 67:                                          return "workspace_tabs"
        if y < 95:                                          return "breadcrumb"
        if from_bottom < 25:                                return "bottom_bar"
        if scene_x < 130:                                   return "sidebar"
        return "workspace"

    def _correction_hit_test(self, sx: float, sy: float) -> Optional[dict]:
        """Return the KB element whose bounding box contains scene point (sx, sy), or None."""
        win = self._find_epic_window()
        if not win:
            return None
        ww, wh = win.width, win.height
        fp = compute_screen_fp(self.elements)
        for r in get_reliable_elements(self.conn, fp):
            cx = r["rel_x"] * ww
            cy = r["rel_y"] * wh
            hw = max(r["rel_w"] * ww / 2, 14)
            hh = max(r["rel_h"] * wh / 2, 9)
            if abs(sx - cx) <= hw and abs(sy - cy) <= hh:
                return dict(r)
        return None

    def _corr_delete_element(self, elem_id: int):
        """Delete an element from the KB and refresh the correction grid."""
        row = self.conn.execute("SELECT text FROM elements WHERE id=?", (elem_id,)).fetchone()
        self.conn.execute("DELETE FROM elements WHERE id=?", (elem_id,))
        self.conn.commit()
        print(f"[correction] Deleted element id={elem_id} ({row['text'] if row else '?'})")
        self._draw_correction_grid()

    def correction_press(self, sx: float, sy: float, right_button: bool = False):
        """Handle a mouse press event in correction mode (called from CorrectionView)."""
        if right_button:
            hit = self._correction_hit_test(sx, sy)
            if hit:
                self._corr_delete_element(hit["id"])
            return
        hit = self._correction_hit_test(sx, sy)
        self._corr_resize_mode = False
        if hit:
            # If the hit box is already selected, check if user clicked near its
            # bottom-right corner (within 14px of each edge) → enter resize mode
            if self._corr_selected and hit["id"] == self._corr_selected.get("id"):
                win = self._find_epic_window()
                if win:
                    cx = hit["rel_x"] * win.width
                    cy = hit["rel_y"] * win.height
                    hw = max(hit["rel_w"] * win.width / 2, 14)
                    hh = max(hit["rel_h"] * win.height / 2, 9)
                    near_right  = abs(sx - (cx + hw)) < 14
                    near_bottom = abs(sy - (cy + hh)) < 14
                    if near_right or near_bottom:
                        self._corr_resize_mode = True
                        self._corr_drag_start = (sx, sy)
                        self._draw_correction_grid()
                        return
            self._corr_selected = hit
            self._corr_drawing = False
        else:
            self._corr_selected = None
            self._corr_drawing = True
        self._corr_drag_start = (sx, sy)
        self._corr_new_rect = None
        self._draw_correction_grid()

    def correction_move(self, sx: float, sy: float):
        """Handle mouse drag in correction mode — draw new box, move, or resize an element."""
        if self._corr_resize_mode and self._corr_selected and self._corr_drag_start:
            win = self._find_epic_window()
            if not win:
                return
            dx = (sx - self._corr_drag_start[0]) / win.width
            dy = (sy - self._corr_drag_start[1]) / win.height
            # Growing by the delta in each axis (×2 because rel_w/h span full width/height)
            self._corr_selected["rel_w"] = max(0.015, self._corr_selected.get("rel_w", 0.05) + dx * 2)
            self._corr_selected["rel_h"] = max(0.008, self._corr_selected.get("rel_h", 0.02) + dy * 2)
            self._corr_drag_start = (sx, sy)
            self._draw_correction_grid()
        elif self._corr_drawing and self._corr_drag_start:
            x1, y1 = self._corr_drag_start
            self._corr_new_rect = (min(x1, sx), min(y1, sy), abs(sx - x1), abs(sy - y1))
            self._draw_correction_grid()
        elif self._corr_selected and self._corr_drag_start:
            win = self._find_epic_window()
            if not win:
                return
            dx = (sx - self._corr_drag_start[0]) / win.width
            dy = (sy - self._corr_drag_start[1]) / win.height
            self._corr_selected["rel_x"] = max(0.0, min(1.0, self._corr_selected["rel_x"] + dx))
            self._corr_selected["rel_y"] = max(0.0, min(1.0, self._corr_selected["rel_y"] + dy))
            self._corr_drag_start = (sx, sy)
            self._draw_correction_grid()

    def correction_release(self, sx: float, sy: float):
        """Handle mouse release in correction mode — save changes to KB."""
        if self._corr_resize_mode and self._corr_selected:
            elem = self._corr_selected
            now = time.time()
            self.conn.execute(
                "UPDATE elements SET rel_w=?, rel_h=?, updated_at=? WHERE id=?",
                (max(0.015, elem.get("rel_w", 0.05)),
                 max(0.008, elem.get("rel_h", 0.02)),
                 now, elem["id"])
            )
            self.conn.commit()
            print(f"[correction] Resized '{elem['text']}' → w={elem.get('rel_w', 0.05):.3f} h={elem.get('rel_h', 0.02):.3f}")
            self._corr_resize_mode = False
            self._corr_selected = None
            self._corr_drag_start = None
            self._draw_correction_grid()
            return

        if self._corr_drawing and self._corr_new_rect:
            x, y, w, h = self._corr_new_rect
            if w < 8 or h < 8:
                self._corr_drawing = False
                self._corr_new_rect = None
                self._draw_correction_grid()
                return
            win = self._find_epic_window()
            if not win:
                return
            ww, wh = win.width, win.height
            rel_x = (x + w / 2) / ww
            rel_y = (y + h / 2) / wh
            rel_w = w / ww
            rel_h = h / wh
            layer = self._classify_layer_by_pos(x, y)
            if self._QInputDialog and self._window:
                text, ok = self._QInputDialog.getText(
                    self._window, "New Element",
                    f"Label for this element\n(layer: {layer.replace('_', ' ')}):"
                )
            else:
                text, ok = input(f"Label for new element in {layer}: "), True
            if ok and str(text).strip():
                fp = compute_screen_fp(self.elements)
                save_correction(self.conn, str(text).strip(), layer, rel_x, rel_y, rel_w, rel_h, fp)
                print(f"[correction] Added '{text}' in {layer} at ({rel_x:.3f},{rel_y:.3f})")
            self._corr_drawing = False
            self._corr_new_rect = None

        elif self._corr_selected and self._corr_drag_start:
            elem = self._corr_selected
            now = time.time()
            self.conn.execute(
                "UPDATE elements SET rel_x=?, rel_y=?, rel_w=?, rel_h=?, updated_at=? WHERE id=?",
                (elem["rel_x"], elem["rel_y"],
                 elem.get("rel_w", 0.05), elem.get("rel_h", 0.02),
                 now, elem["id"])
            )
            self.conn.commit()
            print(f"[correction] Moved '{elem['text']}' → ({elem['rel_x']:.3f},{elem['rel_y']:.3f})")
            self._corr_selected = None
            self._corr_drag_start = None

        self._draw_correction_grid()

    def _draw_correction_grid(self):
        """Draw Epic layer bands as colored zones + existing element boxes."""
        if self._scene is None:
            return
        from PyQt5.QtWidgets import QGraphicsRectItem, QGraphicsTextItem
        from PyQt5.QtCore import Qt, QRectF
        from PyQt5.QtGui import QColor, QFont, QPen, QBrush

        self._scene.clear()
        win = self._find_epic_window()
        if not win:
            return
        ww, wh = win.width, win.height

        # Draw layer bands as semi-transparent colored zones
        band_colors = {
            "shortcut_toolbar": QColor(255, 215, 0, 60),
            "workspace_tabs":   QColor(135, 206, 235, 60),
            "activity_tabs":    QColor(152, 251, 152, 60),
            "breadcrumb":       QColor(221, 160, 221, 60),
            "sidebar":          QColor(240, 230, 140, 60),
            "bottom_bar":       QColor(255, 160, 122, 60),
        }
        label_font = QFont("Consolas", 7)
        for layer_name, color in band_colors.items():
            crop = _get_layer_crop(None, layer_name, ww, wh)
            if crop is None:
                continue
            x1, y1, x2, y2 = crop
            rect = QGraphicsRectItem(x1, y1, x2 - x1, y2 - y1)
            rect.setBrush(QBrush(color))
            rect.setPen(QPen(QColor(255, 255, 255, 80), 1))
            self._scene.addItem(rect)
            lbl = QGraphicsTextItem(layer_name.replace("_", " "))
            lbl.setFont(label_font)
            lbl.setDefaultTextColor(QColor(255, 255, 255, 200))
            lbl.setPos(x1 + 2, y1 + 1)
            self._scene.addItem(lbl)

        # Draw existing elements as labeled boxes
        fp = compute_screen_fp(self.elements)
        reliable = get_reliable_elements(self.conn, fp)
        selected_id = self._corr_selected.get("id") if self._corr_selected else None
        for r in reliable:
            rx = int(r["rel_x"] * ww)
            ry = int(r["rel_y"] * wh)
            rw = max(int(r["rel_w"] * ww), 20)
            rh = max(int(r["rel_h"] * wh), 12)
            is_selected = selected_id is not None and r["id"] == selected_id
            color_hex = LAYER_COLORS.get(r["layer"], "#FFFFFF")
            c = QColor(color_hex)
            c.setAlpha(160)
            box = QGraphicsRectItem(rx - rw // 2, ry - rh // 2, rw, rh)
            box.setBrush(QBrush(c))
            if is_selected:
                box.setPen(QPen(QColor("#FF4400"), 2))  # orange-red for selected
            elif r["is_correction"]:
                box.setPen(QPen(QColor("#00FF00"), 1))  # green for corrections
            else:
                box.setPen(QPen(QColor("#FFFFFF"), 1))
            box.setOpacity(0.75)
            self._scene.addItem(box)
            conf_marker = {"seen": "·", "confirmed": "○", "reliable": "●", "named": "★"}.get(r["confidence"], "?")
            sem = f"[{r['semantic']}]" if r["semantic"] else ""
            txt = QGraphicsTextItem(f"{conf_marker}{r['text'][:12]}{sem}")
            txt.setFont(QFont("Consolas", 6))
            txt.setDefaultTextColor(QColor("#000000"))
            txt.setPos(rx - rw // 2 + 1, ry - rh // 2)
            self._scene.addItem(txt)
            # Resize handle: small orange square at bottom-right corner of selected box
            if is_selected:
                handle = QGraphicsRectItem(rx + rw // 2 - 8, ry + rh // 2 - 8, 8, 8)
                handle.setBrush(QBrush(QColor("#FF4400")))
                handle.setPen(QPen(QColor("#FFFFFF"), 1))
                self._scene.addItem(handle)

        # Rubber-band rect (new box being drawn)
        if self._corr_new_rect:
            rx2, ry2, rw2, rh2 = self._corr_new_rect
            layer = self._classify_layer_by_pos(rx2, ry2)
            rubber = QGraphicsRectItem(rx2, ry2, rw2, rh2)
            rubber.setPen(QPen(QColor("#00FF88"), 2))
            rubber.setBrush(QBrush(QColor(0, 255, 136, 35)))
            self._scene.addItem(rubber)
            lbl2 = QGraphicsTextItem(f"+ new [{layer.replace('_', ' ')}]")
            lbl2.setFont(QFont("Consolas", 7))
            lbl2.setDefaultTextColor(QColor("#00FF88"))
            lbl2.setPos(rx2 + 2, ry2 + 1)
            self._scene.addItem(lbl2)

        # Status line
        status_parts = [f"{self._correct_key_name.replace('_',' ').title()}=exit correction"]
        if self._corr_resize_mode and self._corr_selected:
            status_parts.insert(0, f"RESIZE '{self._corr_selected.get('text', '?')}' | drag=change size | release=save")
        elif self._corr_selected:
            status_parts.insert(0, f"Selected: '{self._corr_selected.get('text', '?')}' | drag=move | click corner-handle=resize | right-click=delete")
        elif self._corr_drawing and self._corr_new_rect:
            status_parts.insert(0, "Release to label new element")
        else:
            status_parts.insert(0, "Click=select | Drag empty area=new box | Right-click=delete")
        status = QGraphicsTextItem("  ".join(status_parts))
        status.setFont(QFont("Consolas", 7))
        status.setDefaultTextColor(QColor(255, 255, 100, 220))
        status.setPos(4, wh - 20)
        self._scene.addItem(status)


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 8 — Headless / CLI scan mode
# ─────────────────────────────────────────────────────────────────────────────

def cli_scan(window_title: str, output_json: bool = False):
    """One-shot scan — take a screenshot, run OCR, print elements."""
    print(f"[scan] Scanning: {window_title}")
    elements = scan_window(window_title)
    if not elements:
        print("[scan] No elements detected. Is the window visible?")
        return

    fp = compute_screen_fp(elements)
    print(f"[scan] Screen fingerprint: {fp}")
    print(f"[scan] {len(elements)} elements detected:\n")

    conn = _db_connect()
    _seed_universal_elements(conn)
    for e in elements:
        upsert_element(conn, e, fp)

    keys = generate_hint_keys(len(elements))
    for i, (e, k) in enumerate(zip(elements, keys)):
        sem = DEFAULT_SEMANTICS.get(e.text)
        sem_str = f" [{sem}]" if sem else ""
        phi_flag = " [!PHI?]" if _looks_like_phi(e.text) else ""
        print(f"  {k:>4}  {e.layer:<20}  {e.text[:40]:<40}  rel=({e.rel_x:.3f},{e.rel_y:.3f}){sem_str}{phi_flag}")

    save_screen_fp(conn, fp, elements)

    if output_json:
        data = [{"hint": k, "text": e.text, "layer": e.layer,
                 "rel_x": e.rel_x, "rel_y": e.rel_y} for e, k in zip(elements, keys)]
        print("\n" + json.dumps(data, indent=2))


def cli_list_kb(layer: str = None, min_confidence: str = "seen"):
    """List elements from the knowledge base."""
    conn = _db_connect()
    query = "SELECT * FROM elements WHERE confidence >= ?"
    conf_order = {c: i for i, c in enumerate(CONFIDENCE_TIERS)}
    rows = conn.execute("SELECT * FROM elements").fetchall()
    rows = [r for r in rows if conf_order.get(r["confidence"], 0) >= conf_order.get(min_confidence, 0)]
    if layer:
        rows = [r for r in rows if r["layer"] == layer]
    rows = sorted(rows, key=lambda r: (-conf_order.get(r["confidence"], 0), r["layer"], r["text"]))
    print(f"\n{'ID':>5}  {'Confidence':<10}  {'Layer':<20}  {'Clicks':>6}  {'Text'}")
    print("-" * 80)
    for r in rows:
        sem = f" [{r['semantic']}]" if r["semantic"] else ""
        corr = " [correction]" if r["is_correction"] else ""
        print(f"  {r['id']:>4}  {r['confidence']:<10}  {r['layer']:<20}  {r['click_count']:>6}  {r['text'][:35]}{sem}{corr}")
    print(f"\n{len(rows)} elements in knowledge base.")


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 9 — Agent Command Handlers (called from epic_agent.py)
# ─────────────────────────────────────────────────────────────────────────────

def _get_agent_fns():
    """Resolve post_result and find_window from the running epic_agent (__main__)."""
    import sys as _sys
    main = _sys.modules.get("__main__")
    if main is None:
        return None, None
    return getattr(main, "post_result", None), getattr(main, "find_window", None)


def execute_ocr_view(cmd: dict):
    """
    Command handler: scan Epic window via OCR and return hint map.
    Called from epic_agent.py command dispatch.
    """
    post_result, find_window = _get_agent_fns()
    if not post_result or not find_window:
        print("[ocr] execute_ocr_view: not running inside epic_agent context")
        return
    env = cmd.get("env", "SUP")
    command_id = cmd.get("id", "unknown")

    window = find_window(env)
    if not window:
        post_result(command_id, "error", error=f"No {env} window found")
        return

    win_title = window.title
    elements = scan_window(win_title)
    if not elements:
        post_result(command_id, "complete", data={"elements": [], "hintMap": {}, "elementCount": 0})
        return

    fp = compute_screen_fp(elements)
    phash_fp = _compute_window_phash(win_title)   # same algorithm as epic_agent.py
    conn = _db_connect()
    _seed_universal_elements(conn)
    save_screen_fp(conn, fp, elements)
    for e in elements:
        upsert_element(conn, e, fp)
    # Bridge pHash (navigation tree key) ↔ OCR text fp (KB key)
    save_fp_bridge(conn, phash_fp, fp)

    # Collision-proof hint map: KB semantics get reserved keys; positional keys never clash
    sem_map = get_semantic_map(conn)   # text → shortcut key (KB + defaults)
    reserved_keys = set(sem_map.values())
    candidates = generate_hint_keys(len(elements) + len(reserved_keys) + 10)
    positional_keys = [k for k in candidates if k not in reserved_keys]

    hint_map: dict = {}
    # First pass: semantic shortcuts from KB
    for e in elements:
        sem = sem_map.get(e.text)
        if sem and sem not in hint_map:
            hint_map[sem] = e
    # Second pass: positional keys for remaining elements
    ki = 0
    for e in elements:
        if any(hint_map.get(k) is e for k in hint_map):
            continue
        while ki < len(positional_keys) and positional_keys[ki] in hint_map:
            ki += 1
        if ki < len(positional_keys):
            hint_map[positional_keys[ki]] = e
            ki += 1

    # Build structured layer summary
    layer_summary: dict[str, list[str]] = {}
    for e in elements:
        layer_summary.setdefault(e.layer, []).append(e.text)

    serialized_map = {k: {"text": e.text, "layer": e.layer,
                          "rel_x": e.rel_x, "rel_y": e.rel_y,
                          "abs_cx": e.abs_cx, "abs_cy": e.abs_cy}
                      for k, e in hint_map.items()}

    post_result(command_id, "complete", data={
        "fingerprint": fp,
        "phashFingerprint": phash_fp,
        "activity": get_activity_for_fp(conn, fp),
        "elementCount": len(elements),
        "hintMap": serialized_map,
        "layerSummary": layer_summary,
        "elements": [
            {"hint": k, "text": e.text, "layer": e.layer,
             "rel_x": round(e.rel_x, 3), "rel_y": round(e.rel_y, 3)}
            for k, e in hint_map.items()
        ],
    })
    print(f"  [ocr-view] {len(elements)} elements, fp={fp[:8]}, phash={phash_fp[:8]}, env={env}")


def execute_ocr_do(cmd: dict):
    """
    Command handler: click an element by OCR hint key.
    """
    post_result, find_window = _get_agent_fns()
    if not post_result or not find_window:
        print("[ocr] execute_ocr_do: not running inside epic_agent context")
        return
    env = cmd.get("env", "SUP")
    hint = cmd.get("hint", "")
    command_id = cmd.get("id", "unknown")

    if not hint:
        post_result(command_id, "error", error="Missing hint parameter")
        return

    window = find_window(env)
    if not window:
        post_result(command_id, "error", error=f"No {env} window found")
        return

    elements = scan_window(window.title)
    if not elements:
        post_result(command_id, "error", error="No elements detected on screen")
        return

    fp = compute_screen_fp(elements)
    phash_fp2 = _compute_window_phash(window.title)
    conn2 = _db_connect()
    _seed_universal_elements(conn2)
    for e in elements:
        upsert_element(conn2, e, fp)
    # Bridge pHash (navigation tree key) ↔ OCR text fp (KB key)
    save_fp_bridge(conn2, phash_fp2, fp)

    # Collision-proof hint map using KB semantics (same logic as execute_ocr_view)
    sem_map2 = get_semantic_map(conn2)
    reserved2 = set(sem_map2.values())
    cands2 = generate_hint_keys(len(elements) + len(reserved2) + 10)
    pos_keys2 = [k for k in cands2 if k not in reserved2]

    hint_map: dict[str, OcrElement] = {}
    for e in elements:
        sem = sem_map2.get(e.text)
        if sem and sem not in hint_map:
            hint_map[sem] = e
    ki2 = 0
    for e in elements:
        if any(hint_map.get(k) is e for k in hint_map):
            continue
        while ki2 < len(pos_keys2) and pos_keys2[ki2] in hint_map:
            ki2 += 1
        if ki2 < len(pos_keys2):
            hint_map[pos_keys2[ki2]] = e
            ki2 += 1

    elem = hint_map.get(hint)
    if not elem:
        available = list(hint_map.keys())[:20]
        post_result(command_id, "error", error=f"Hint '{hint}' not found. Available: {available}")
        return

    try:
        import pyautogui
        pyautogui.moveTo(elem.abs_cx, elem.abs_cy)
        import time as _t; _t.sleep(0.1)
        pyautogui.click(elem.abs_cx, elem.abs_cy)
    except Exception as e:
        post_result(command_id, "error", error=f"Click failed: {e}")
        return

    existing = conn2.execute(
        "SELECT id FROM elements WHERE text=? AND layer=?", (elem.text, elem.layer)
    ).fetchone()
    if existing:
        promote_element(conn2, existing["id"])

    post_result(command_id, "complete", data={
        "clicked": elem.text,
        "layer": elem.layer,
        "abs_cx": elem.abs_cx,
        "abs_cy": elem.abs_cy,
        "fingerprint": fp,
        "phashFingerprint": phash_fp2,
    })
    print(f"  [ocr-do] Clicked '{elem.text}' ({elem.layer}) via hint '{hint}', phash={phash_fp2[:8]}")


def get_ocr_elements_for_heartbeat(window_title: str) -> dict:
    """
    Get current OCR element map for inclusion in agent heartbeat payload.
    Called from always-on capture drain.
    """
    try:
        elements = scan_window(window_title)
        if not elements:
            return {}
        fp = compute_screen_fp(elements)
        layer_summary: dict[str, list[str]] = {}
        for e in elements:
            if not _looks_like_phi(e.text):
                layer_summary.setdefault(e.layer, []).append(e.text)
        return {
            "fingerprint": fp,
            "layerSummary": layer_summary,
            "elementCount": len(elements),
        }
    except Exception:
        return {}


def get_ocr_kb_summary(fp: str) -> dict:
    """
    Read accumulated OCR element layer summary for a fingerprint from the KB.
    Does NOT run OCR — reads only from the local SQLite knowledge base.
    Safe to call frequently from the heartbeat loop.

    fp may be either a pHash fp (from epic_agent.py heartbeat) or an OCR text fp.
    The fp_bridge table is consulted first to resolve pHash → OCR fp when needed,
    so that node.ocrLayers is populated even when called with the canonical tree fp.
    """
    try:
        conn = _db_connect()
        # Resolve pHash fp → OCR text fp via bridge table.
        # If not in bridge (or fp IS an ocr_fp), use fp directly.
        bridge_row = conn.execute(
            "SELECT ocr_fp FROM fp_bridge WHERE phash_fp=?", (fp,)
        ).fetchone()
        ocr_fp = bridge_row["ocr_fp"] if bridge_row else fp

        rows = conn.execute(
            "SELECT layer, text, confidence FROM elements "
            "WHERE confidence IN ('confirmed','reliable','named') AND screen_fps LIKE ?",
            (f"%{ocr_fp}%",)
        ).fetchall()
        layer_summary: dict[str, list[str]] = {}
        for r in rows:
            if not _looks_like_phi(r["text"]):
                layer_summary.setdefault(r["layer"], []).append(r["text"])
        return {
            "phashFp": fp,
            "ocrFp": ocr_fp,
            "layerSummary": layer_summary,
            "elementCount": len(rows),
        } if rows else {}
    except Exception:
        return {}


# ─────────────────────────────────────────────────────────────────────────────
# SECTION 10 — CLI entry point
# ─────────────────────────────────────────────────────────────────────────────

def main():
    global BRIDGE_URL, BRIDGE_TOKEN  # declare before any reference to these names
    parser = argparse.ArgumentParser(description="OCR Vimium overlay for Epic Hyperspace")
    parser.add_argument("--window", default="",
                        help="Window title substring to find Epic (default: auto-detect)")
    parser.add_argument("--scan", action="store_true",
                        help="One-shot scan and print elements, then exit")
    parser.add_argument("--json", action="store_true",
                        help="Output scan results as JSON")
    parser.add_argument("--list-kb", action="store_true",
                        help="List knowledge base contents")
    parser.add_argument("--layer", default=None,
                        help="Filter KB list or scan by layer name")
    parser.add_argument("--correct", action="store_true",
                        help="Start in correction mode")
    parser.add_argument("--add", nargs=4, metavar=("TEXT", "LAYER", "REL_X", "REL_Y"),
                        help="Manually add an element to the KB")
    parser.add_argument("--tag", nargs=2, metavar=("FP", "ACTIVITY"),
                        help="Tag a screen fingerprint with an activity name")
    parser.add_argument("--bridge-url", default=BRIDGE_URL)
    parser.add_argument("--bridge-token", default=BRIDGE_TOKEN)
    parser.add_argument("--hint-key", default="ctrl+shift+h",
                        help="Hotkey to toggle hint overlay (default: ctrl+shift+h). "
                             "Supports combos like ctrl+shift+h, or bare keys like f12.")
    parser.add_argument("--correct-key", default="ctrl+shift+c",
                        help="Hotkey to toggle correction mode (default: ctrl+shift+c). "
                             "Supports combos like ctrl+shift+c, or bare keys like f11.")
    args = parser.parse_args()
    BRIDGE_URL = args.bridge_url
    BRIDGE_TOKEN = args.bridge_token

    # Auto-detect Epic window title
    win_title = args.window
    if not win_title:
        try:
            import pygetwindow as gw
            epic_keywords = ["hyperspace", "epic", "hyperdrive", "haiku", "canto"]
            for w in gw.getAllWindows():
                t = (w.title or "").lower()
                if any(k in t for k in epic_keywords) and w.width > 200:
                    win_title = w.title
                    print(f"[ocr] Auto-detected Epic window: {win_title!r}")
                    break
        except Exception:
            pass
    if not win_title:
        win_title = "Hyperspace"
        print(f"[ocr] Using default window title: {win_title!r}")

    if args.list_kb:
        cli_list_kb(layer=args.layer)
        return

    if args.add:
        text, layer, rel_x, rel_y = args.add[0], args.add[1], float(args.add[2]), float(args.add[3])
        conn = _db_connect()
        save_correction(conn, text, layer, rel_x, rel_y, 0.05, 0.02, "", None)
        print(f"[ocr] Added correction: '{text}' in {layer} at ({rel_x:.3f},{rel_y:.3f})")
        return

    if args.tag:
        fp, activity = args.tag
        conn = _db_connect()
        tag_fp_activity(conn, fp, activity)
        print(f"[ocr] Tagged fingerprint {fp} → '{activity}'")
        return

    if args.scan:
        cli_scan(win_title, output_json=args.json)
        return

    # Interactive overlay mode
    overlay = OverlayWindow(win_title,
                            hint_key=args.hint_key,
                            correct_key=args.correct_key)
    if args.correct:
        overlay.correction_mode = True

    print(f"[ocr] Starting overlay over: {win_title!r}")
    hkn = args.hint_key.replace("_", " ").title()
    ckn = args.correct_key.replace("_", " ").title()
    print(f"[ocr] {hkn}=toggle hints  {ckn}=correction mode  Esc=cancel")
    overlay.run()


if __name__ == "__main__":
    main()
