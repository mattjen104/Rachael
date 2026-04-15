"""
Epic Desktop Agent
==================
Background agent that runs on your Windows desktop.
Polls OrgCloud for navigation commands and drives Hyperspace using
screenshots + Claude vision (via OpenRouter).

Requirements:
    pip install pyautogui pillow requests pygetwindow keyboard

Usage:
    python epic_agent.py

Set these environment variables (or edit the config below):
    OPENROUTER_API_KEY  - Your OpenRouter API key
    ORGCLOUD_URL        - Your OrgCloud URL (default: https://i-cloud-sync-manager.replit.app)
    BRIDGE_TOKEN        - Your bridge token for API auth
"""

import sys
import os
import json
import time
import base64
import io
import re
import traceback
import random
import webbrowser
import threading
import collections
import wave
import struct

try:
    import numpy as _np
    _NUMPY_AVAILABLE = True
except ImportError:
    _NUMPY_AVAILABLE = False

# ── Audio capture constants ──
_AUDIO_SAMPLE_RATE = 16000
_AUDIO_CHANNELS = 1
_AUDIO_SAMPLE_WIDTH = 2  # 16-bit PCM
_AUDIO_CHUNK_FRAMES = 1024  # PortAudio callback frames
_AUDIO_CHUNK_SECONDS = 10   # encoder upload cadence
_AUDIO_PREROLL_FRAMES = int(_AUDIO_SAMPLE_RATE * 0.200)  # 200ms pre-roll
_AUDIO_SILENCE_THRESHOLD = 150          # default RMS threshold (~quiet room)
_AUDIO_RING_MAXLEN = int(30 * _AUDIO_SAMPLE_RATE / _AUDIO_CHUNK_FRAMES)  # 30s max
_AUDIO_MAX_DURATION_SECS = 7200         # 2-hour auto-stop safety net
_AUDIO_SPLIT_THRESHOLD_BYTES = 22 * 1024 * 1024  # auto-split at 22MB (server cap is 25MB)
_AUDIO_UPLOAD_RETRIES = 2               # retry attempts on upload failure

# Module-level audio session state (cleared on stop)
_audio_session: dict = {}

try:
    import ctypes
    ctypes.windll.shcore.SetProcessDpiAwareness(2)
except Exception:
    try:
        import ctypes
        ctypes.windll.user32.SetProcessDPIAware()
    except Exception:
        pass

try:
    import pyautogui
    import pygetwindow as gw
    from PIL import ImageGrab
    import requests
except ImportError:
    print("Missing dependencies. Run:")
    print("  pip install pyautogui pillow requests pygetwindow")
    sys.exit(1)

pyautogui.PAUSE = 0.05
pyautogui.MINIMUM_DURATION = 0
pyautogui.MINIMUM_SLEEP = 0

# ── Low-level Windows keyboard via multiple methods ──
# Citrix can intercept/drop keystrokes from pyautogui. We provide three
# injection methods and the calibration system picks whichever works:
#   1) SendInput with virtual key codes (modern Windows API)
#   2) keybd_event (legacy API, what pyautogui uses internally but with
#      better timing control)
#   3) pyautogui (fallback)
try:
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    INPUT_KEYBOARD = 1
    KEYEVENTF_KEYUP = 0x0002
    KEYEVENTF_EXTENDEDKEY = 0x0001

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [
            ("wVk", wintypes.WORD),
            ("wScan", wintypes.WORD),
            ("dwFlags", wintypes.DWORD),
            ("time", wintypes.DWORD),
            ("dwExtraInfo", ctypes.POINTER(ctypes.c_ulong)),
        ]

    class INPUT(ctypes.Structure):
        class _INPUT(ctypes.Union):
            _fields_ = [("ki", KEYBDINPUT)]
        _fields_ = [("type", wintypes.DWORD), ("_input", _INPUT)]

    VK_MAP = {
        "ctrl": 0x11, "control": 0x11, "shift": 0x10, "alt": 0x12, "menu": 0x12,
        "space": 0x20, "enter": 0x0D, "return": 0x0D,
        "escape": 0x1B, "esc": 0x1B,
        "backspace": 0x08, "delete": 0x2E,
        "tab": 0x09, "home": 0x24, "end": 0x23,
        "f3": 0x72, "f4": 0x73, "f5": 0x74,
        "a": 0x41, "b": 0x42, "c": 0x43, "d": 0x44, "e": 0x45,
        "f": 0x46, "g": 0x47, "h": 0x48, "i": 0x49, "j": 0x4A,
        "k": 0x4B, "l": 0x4C, "m": 0x4D, "n": 0x4E, "o": 0x4F,
        "p": 0x50, "q": 0x51, "r": 0x52, "s": 0x53, "t": 0x54,
        "u": 0x55, "v": 0x56, "w": 0x57, "x": 0x58, "y": 0x59,
        "z": 0x5A,
        "0": 0x30, "1": 0x31, "2": 0x32, "3": 0x33, "4": 0x34,
        "5": 0x35, "6": 0x36, "7": 0x37, "8": 0x38, "9": 0x39,
    }

    EXTENDED_KEYS = {0x2E, 0x24, 0x23}

    def _sendinput_key(vk, up=False):
        """SendInput with virtual key code only (no scan code flag)."""
        scan = user32.MapVirtualKeyW(vk, 0)
        flags = KEYEVENTF_KEYUP if up else 0
        if vk in EXTENDED_KEYS:
            flags |= KEYEVENTF_EXTENDEDKEY
        ki = KEYBDINPUT(wVk=vk, wScan=scan, dwFlags=flags, time=0,
                        dwExtraInfo=ctypes.pointer(ctypes.c_ulong(0)))
        inp = INPUT(type=INPUT_KEYBOARD)
        inp._input.ki = ki
        user32.SendInput(1, ctypes.byref(inp), ctypes.sizeof(INPUT))

    def _keybd_event_key(vk, up=False):
        """Legacy keybd_event API — simpler, widely compatible."""
        scan = user32.MapVirtualKeyW(vk, 0)
        flags = 0x0002 if up else 0
        if vk in EXTENDED_KEYS:
            flags |= 0x0001
        user32.keybd_event(vk, scan, flags, 0)

    KEYEVENTF_UNICODE = 0x0004

    def _sendinput_unicode_char(ch):
        """Send a single Unicode character via SendInput KEYEVENTF_UNICODE.
        This bypasses keyboard layout mapping — Citrix forwards these as text events."""
        code = ord(ch)
        ki_down = KEYBDINPUT(wVk=0, wScan=code, dwFlags=KEYEVENTF_UNICODE, time=0,
                             dwExtraInfo=ctypes.pointer(ctypes.c_ulong(0)))
        ki_up = KEYBDINPUT(wVk=0, wScan=code, dwFlags=KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time=0,
                           dwExtraInfo=ctypes.pointer(ctypes.c_ulong(0)))
        inp_down = INPUT(type=INPUT_KEYBOARD)
        inp_down._input.ki = ki_down
        inp_up = INPUT(type=INPUT_KEYBOARD)
        inp_up._input.ki = ki_up
        user32.SendInput(1, ctypes.byref(inp_down), ctypes.sizeof(INPUT))
        time.sleep(0.01)
        user32.SendInput(1, ctypes.byref(inp_up), ctypes.sizeof(INPUT))

    _active_backend = "sendinput"
    _key_fn = _sendinput_key
    _text_method = "pyautogui"

    def set_keyboard_backend(name):
        """Switch between 'sendinput' and 'keybd_event' backends."""
        global _active_backend, _key_fn
        if name == "keybd_event":
            _active_backend = "keybd_event"
            _key_fn = _keybd_event_key
        else:
            _active_backend = "sendinput"
            _key_fn = _sendinput_key
        print(f"  [input] Keyboard backend: {_active_backend}")

    def set_text_method(name):
        """Switch text input method: 'unicode', 'vk', or 'pyautogui'."""
        global _text_method
        _text_method = name
        print(f"  [input] Text input method: {_text_method}")

    def sendinput_press(key):
        """Press and release a single key via the active backend."""
        vk = VK_MAP.get(key.lower())
        if vk is None:
            pyautogui.press(key)
            return
        _key_fn(vk, up=False)
        time.sleep(0.03)
        _key_fn(vk, up=True)
        time.sleep(0.03)

    def sendinput_hotkey(*keys):
        """Press a key combination (e.g. sendinput_hotkey('ctrl', 'space')).
        Uses longer delays between modifier down and key down for Citrix reliability."""
        vks = []
        for k in keys:
            vk = VK_MAP.get(k.lower())
            if vk is None:
                pyautogui.hotkey(*keys)
                return
            vks.append(vk)
        for vk in vks:
            _key_fn(vk, up=False)
            time.sleep(0.05)
        time.sleep(0.05)
        for vk in reversed(vks):
            _key_fn(vk, up=True)
            time.sleep(0.05)

    def sendinput_typewrite(text, interval=0.03):
        """Type a string using the active text input method.
        Default is 'unicode' which sends raw Unicode chars — most reliable through Citrix."""
        if _text_method == "unicode":
            for ch in text:
                _sendinput_unicode_char(ch)
                time.sleep(interval)
        elif _text_method == "vk":
            for ch in text:
                vk = VK_MAP.get(ch.lower())
                if vk is not None:
                    needs_shift = ch.isupper()
                    if needs_shift:
                        _key_fn(0x10, up=False)
                        time.sleep(0.01)
                    _key_fn(vk, up=False)
                    time.sleep(0.015)
                    _key_fn(vk, up=True)
                    if needs_shift:
                        time.sleep(0.01)
                        _key_fn(0x10, up=True)
                    time.sleep(interval)
                else:
                    _sendinput_unicode_char(ch)
                    time.sleep(interval)
        else:
            pyautogui.typewrite(text, interval=interval)

    KEYEVENTF_SCANCODE = 0x0008

    def _sendinput_scancode_char(ch):
        """Send a character via scancode-only SendInput (hardware keyboard emulation).
        Maps char -> VK -> scancode, then sends with wVk=0 and KEYEVENTF_SCANCODE.
        This is the closest to a real physical keypress."""
        vk = VK_MAP.get(ch.lower())
        if vk is None:
            _sendinput_unicode_char(ch)
            return
        scan = user32.MapVirtualKeyW(vk, 0)
        needs_shift = ch.isupper() or ch in '!@#$%^&*()_+{}|:"<>?~'
        if needs_shift:
            shift_scan = user32.MapVirtualKeyW(0x10, 0)
            ki_s = KEYBDINPUT(wVk=0, wScan=shift_scan, dwFlags=KEYEVENTF_SCANCODE, time=0,
                              dwExtraInfo=ctypes.pointer(ctypes.c_ulong(0)))
            inp_s = INPUT(type=INPUT_KEYBOARD)
            inp_s._input.ki = ki_s
            user32.SendInput(1, ctypes.byref(inp_s), ctypes.sizeof(INPUT))
            time.sleep(0.01)
        ki_down = KEYBDINPUT(wVk=0, wScan=scan, dwFlags=KEYEVENTF_SCANCODE, time=0,
                             dwExtraInfo=ctypes.pointer(ctypes.c_ulong(0)))
        ki_up = KEYBDINPUT(wVk=0, wScan=scan, dwFlags=KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP, time=0,
                           dwExtraInfo=ctypes.pointer(ctypes.c_ulong(0)))
        inp_down = INPUT(type=INPUT_KEYBOARD)
        inp_down._input.ki = ki_down
        inp_up = INPUT(type=INPUT_KEYBOARD)
        inp_up._input.ki = ki_up
        user32.SendInput(1, ctypes.byref(inp_down), ctypes.sizeof(INPUT))
        time.sleep(0.01)
        user32.SendInput(1, ctypes.byref(inp_up), ctypes.sizeof(INPUT))
        if needs_shift:
            ki_su = KEYBDINPUT(wVk=0, wScan=shift_scan, dwFlags=KEYEVENTF_SCANCODE | KEYEVENTF_KEYUP, time=0,
                               dwExtraInfo=ctypes.pointer(ctypes.c_ulong(0)))
            inp_su = INPUT(type=INPUT_KEYBOARD)
            inp_su._input.ki = ki_su
            user32.SendInput(1, ctypes.byref(inp_su), ctypes.sizeof(INPUT))
            time.sleep(0.01)

    def _clipboard_paste(text):
        """Copy text to clipboard and paste via Ctrl+V.
        Uses Citrix's clipboard channel which is always enabled.
        Clears clipboard in finally block for security."""
        u32 = ctypes.windll.user32
        try:
            kernel32 = ctypes.windll.kernel32
            CF_UNICODETEXT = 13
            GMEM_MOVEABLE = 0x0002
            u32.OpenClipboard(0)
            u32.EmptyClipboard()
            encoded = text.encode('utf-16-le') + b'\x00\x00'
            h = kernel32.GlobalAlloc(GMEM_MOVEABLE, len(encoded))
            p = kernel32.GlobalLock(h)
            ctypes.memmove(p, encoded, len(encoded))
            kernel32.GlobalUnlock(h)
            u32.SetClipboardData(CF_UNICODETEXT, h)
            u32.CloseClipboard()
            time.sleep(0.05)
            _keybd_event_key(0x11, up=False)
            time.sleep(0.03)
            _keybd_event_key(0x56, up=False)
            time.sleep(0.03)
            _keybd_event_key(0x56, up=True)
            time.sleep(0.03)
            _keybd_event_key(0x11, up=True)
            time.sleep(0.1)
        except Exception as e:
            print(f"  [input] Clipboard paste failed: {e}")
            raise
        finally:
            try:
                u32.OpenClipboard(0)
                u32.EmptyClipboard()
                u32.CloseClipboard()
            except Exception:
                pass

    WM_CHAR = 0x0102

    def _postmessage_type(hwnd, text):
        """Send characters via PostMessageW WM_CHAR directly to window handle.
        Bypasses the input pipeline entirely."""
        try:
            for ch in text:
                user32.PostMessageW(hwnd, WM_CHAR, ord(ch), 0)
                time.sleep(0.02)
        except Exception as e:
            print(f"  [input] PostMessage type failed: {e}")
            raise

    HAS_SENDINPUT = True
    print(f"  [input] Low-level keyboard available (backend: {_active_backend})")
except Exception as e:
    HAS_SENDINPUT = False
    print(f"  [input] Low-level keyboard not available ({e}), using pyautogui only")
    def set_keyboard_backend(name):
        pass
    def set_text_method(name):
        pass
    def sendinput_press(key):
        pyautogui.press(key)
    def sendinput_hotkey(*keys):
        pyautogui.hotkey(*keys)
    def sendinput_typewrite(text, interval=0.03):
        pyautogui.typewrite(text, interval=interval)
    def _sendinput_scancode_char(ch):
        pass
    def _clipboard_paste(text):
        pass
    def _postmessage_type(hwnd, text):
        pass

def _load_env_file():
    """Load key=value pairs from .env file next to this script."""
    env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.exists(env_path):
        return
    print(f"  [config] Loading {env_path}")
    with open(env_path, "r") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                k, v = line.split("=", 1)
                k = k.strip()
                v = v.strip().strip('"').strip("'")
                if k and v and not os.environ.get(k):
                    os.environ[k] = v

_load_env_file()

OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
ORGCLOUD_URL = os.environ.get("ORGCLOUD_URL", "http://146.190.33.157:5000")
BRIDGE_TOKEN = os.environ.get("BRIDGE_TOKEN", "")
if not BRIDGE_TOKEN:
    print("ERROR: BRIDGE_TOKEN not set.")
    print("  Option 1: Create a .env file next to epic_agent.py with:")
    print("    BRIDGE_TOKEN=your-token-here")
    print("    OPENROUTER_API_KEY=your-key-here")
    print("  Option 2: set BRIDGE_TOKEN=<your-bridge-token>")
    sys.exit(1)
MODEL = "anthropic/claude-sonnet-4"
POLL_INTERVAL = 3

pyautogui.PAUSE = 0.2
pyautogui.FAILSAFE = True

_hotkeys_registered = False
_hotkey_thread = None

_orgcloud_popup_hwnd = None
_popup_visible = False
_POPUP_W = 420
_POPUP_H = 650
_POPUP_TITLE_MATCH = "orgcloud"

def _find_chrome_exe():
    """Find Chrome executable on Windows."""
    candidates = [
        os.path.join(os.environ.get("PROGRAMFILES", ""), "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(os.environ.get("PROGRAMFILES(X86)", ""), "Google", "Chrome", "Application", "chrome.exe"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Google", "Chrome", "Application", "chrome.exe"),
    ]
    for p in candidates:
        if p and os.path.exists(p):
            return p
    return None

def _find_orgcloud_window():
    """Find an existing OrgCloud popup window by title."""
    global _orgcloud_popup_hwnd
    user32 = ctypes.windll.user32
    found = [None]

    def enum_cb(hwnd, _):
        length = user32.GetWindowTextLengthW(hwnd)
        if length > 0:
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buf, length + 1)
            title = buf.value.lower()
            if _POPUP_TITLE_MATCH in title or "i-cloud-sync-manager" in title:
                found[0] = hwnd
        return True

    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.wintypes.HWND, ctypes.wintypes.LPARAM)
    user32.EnumWindows(WNDENUMPROC(enum_cb), 0)
    if found[0]:
        _orgcloud_popup_hwnd = found[0]
    return found[0]

def _get_screen_width():
    """Get primary monitor width."""
    try:
        return ctypes.windll.user32.GetSystemMetrics(0)
    except Exception:
        return 1920

def _open_orgcloud_mode(mode):
    """Toggle OrgCloud popup: show/hide if exists, create if not. Opens in main Chrome profile."""
    import subprocess
    global _orgcloud_popup_hwnd, _popup_visible
    url = f"{ORGCLOUD_URL}?mode={mode}"

    def do_toggle():
        global _orgcloud_popup_hwnd, _popup_visible
        user32 = ctypes.windll.user32
        SW_HIDE = 0
        SW_RESTORE = 9

        if _orgcloud_popup_hwnd and user32.IsWindow(_orgcloud_popup_hwnd):
            if _popup_visible:
                user32.ShowWindow(_orgcloud_popup_hwnd, SW_HIDE)
                _popup_visible = False
                print(f"  [hotkey] Hidden OrgCloud popup")
                return
            else:
                user32.ShowWindow(_orgcloud_popup_hwnd, SW_RESTORE)
                user32.SetForegroundWindow(_orgcloud_popup_hwnd)
                _popup_visible = True
                print(f"  [hotkey] Shown OrgCloud popup")
                return

        hwnd = _find_orgcloud_window()
        if hwnd:
            _orgcloud_popup_hwnd = hwnd
            if _popup_visible:
                user32.ShowWindow(hwnd, SW_HIDE)
                _popup_visible = False
                print(f"  [hotkey] Hidden OrgCloud popup (found existing)")
            else:
                user32.ShowWindow(hwnd, SW_RESTORE)
                user32.SetForegroundWindow(hwnd)
                _popup_visible = True
                print(f"  [hotkey] Shown OrgCloud popup (found existing)")
            return

        print(f"  [hotkey] Opening {mode} mode: {url}")
        chrome = _find_chrome_exe()
        if not chrome:
            print("  [hotkey] Chrome not found, opening in default browser")
            webbrowser.open(url)
            return

        screen_w = _get_screen_width()
        pos_x = screen_w - _POPUP_W - 20

        try:
            subprocess.Popen([
                chrome,
                f"--app={url}",
                f"--window-size={_POPUP_W},{_POPUP_H}",
                f"--window-position={pos_x},100",
            ])
            time.sleep(2)

            hwnd = _find_orgcloud_window()
            if hwnd:
                _orgcloud_popup_hwnd = hwnd
                user32.MoveWindow(hwnd, pos_x, 100, _POPUP_W, _POPUP_H, True)
                _popup_visible = True
                print(f"  [hotkey] OrgCloud popup opened ({_POPUP_W}x{_POPUP_H})")
            else:
                _popup_visible = True

        except Exception as e:
            print(f"  [hotkey] Chrome app-mode failed: {e}")
            webbrowser.open(url)

    threading.Thread(target=do_toggle, daemon=True).start()

def _hotkey_listener():
    """Win32 RegisterHotKey message loop — runs in a daemon thread.
    Uses user32.RegisterHotKey which works without admin privileges."""
    try:
        user32 = ctypes.windll.user32

        MOD_ALT = 0x0001
        MOD_NOREPEAT = 0x4000
        mods = MOD_ALT | MOD_NOREPEAT

        HOTKEY_CAPTURE = 1
        HOTKEY_COMMAND = 2
        HOTKEY_SEARCH  = 3
        HOTKEY_AGENDA  = 4
        HOTKEY_KILL_REPLAY = 5

        VK_C = 0x43
        VK_X = 0x58
        VK_S = 0x53
        VK_A = 0x41
        VK_ESCAPE = 0x1B

        MOD_CTRL = 0x0002
        MOD_SHIFT = 0x0004

        hotkey_map = {
            HOTKEY_CAPTURE: ("capture", VK_C, mods, "Alt+C"),
            HOTKEY_COMMAND: ("command", VK_X, mods, "Alt+X"),
            HOTKEY_SEARCH:  ("search",  VK_S, mods, "Alt+S"),
            HOTKEY_AGENDA:  ("agenda",  VK_A, mods, "Alt+A"),
            HOTKEY_KILL_REPLAY: ("kill_replay", VK_ESCAPE, MOD_CTRL | MOD_SHIFT | MOD_NOREPEAT, "Ctrl+Shift+Esc"),
        }

        registered = []
        for hk_id, (mode, vk, hk_mods, label) in hotkey_map.items():
            ok = user32.RegisterHotKey(None, hk_id, hk_mods, vk)
            if ok:
                registered.append(label)
            else:
                print(f"  [hotkey] WARNING: {label} could not be registered (may be in use by another app)")

        if registered:
            print(f"  [hotkey] Global hotkeys registered: {', '.join(registered)}")
            print("    Alt+C = Capture  |  Alt+X = Command (M-x)")
            print("    Alt+S = Search   |  Alt+A = Agenda")
            print("    Ctrl+Shift+Esc = Kill replay")
        else:
            print("  [hotkey] No hotkeys could be registered")
            return

        WM_HOTKEY = 0x0312
        msg = ctypes.wintypes.MSG()
        while user32.GetMessageW(ctypes.byref(msg), None, 0, 0) != 0:
            if msg.message == WM_HOTKEY:
                hk_id = msg.wParam
                if hk_id in hotkey_map:
                    mode_name = hotkey_map[hk_id][0]
                    if mode_name == "kill_replay":
                        _nav_replay_kill.set()
                        print("  [hotkey] KILL REPLAY triggered (Ctrl+Shift+Esc)")
                    else:
                        _open_orgcloud_mode(mode_name)

        for hk_id in hotkey_map:
            user32.UnregisterHotKey(None, hk_id)

    except Exception as e:
        print(f"  [hotkey] Hotkey listener error: {e}")

def register_global_hotkeys():
    """Register Alt+C/X/S/A as system-wide global hotkeys using Win32 RegisterHotKey."""
    global _hotkeys_registered, _hotkey_thread
    if _hotkeys_registered:
        return
    try:
        import ctypes.wintypes
        _hotkey_thread = threading.Thread(target=_hotkey_listener, daemon=True)
        _hotkey_thread.start()
        _hotkeys_registered = True
        time.sleep(0.3)
    except Exception as e:
        print(f"  [hotkey] Platform does not support Win32 hotkeys: {e}")


def safe_click(x, y, pause_before=0.15, pause_after=0.3, label=""):
    """Click with computer-use best practices from Anthropic + OpenAI baked in.

    Principles applied:
    1. Move-then-click (Anthropic): Hover first so the UI can react (highlight,
       tooltip) — confirms cursor is visually on the right target.
    2. Brief pause before click: Lets hover animations and UI transitions settle.
       'Some applications may take time to process actions' — Anthropic docs.
    3. Single click with pause after: Lets the UI process the event fully
       before next action. Prevents click-stacking where two fast clicks
       hit the wrong targets.
    4. Coordinates are absolute screen coords (already mapped from vision
       space through vision_to_screen).
    5. Center-of-element targeting: All vision prompts request center coords
       via VISION_COORD_INSTRUCTION. 'Click buttons, links, icons with the
       cursor tip in the center of the element' — Anthropic system prompt.
    """
    if label:
        print(f"    [click] '{label}' at ({x}, {y})")
    pyautogui.moveTo(x, y)
    time.sleep(pause_before)
    pyautogui.click(x, y)
    time.sleep(pause_after)


VISION_COORD_INSTRUCTION = (
    "IMPORTANT: Return the pixel coordinates of the CENTER of the text label, "
    "not the top-left corner, not the icon, not the arrow — the middle of the text itself. "
    "This ensures clicks land on the most clickable part of the element."
)

EPIC_VISUAL_REFERENCE = """EPIC HYPERSPACE VISUAL REFERENCE (from actual screenshots)
==========================================================
Epic Hyperspace has a fixed visual hierarchy from top to bottom:

LAYER 1 — TITLE BAR (topmost row, dark blue/navy, ~25px):
  Far left: "Epic" logo (small blue icon). Clicking this opens the Epic button navigation menu.
  Then: Full title string like "Hyperspace – EXE LUNG TXP – SUP Environment – MATTHEW E JENSEN"
    This contains: app name, department context, environment (SUP/PRD), logged-in user name.
    The department/environment part does NOT change when switching activities — it is constant.
  Center: Search bar with "Search (Ctrl+Space)" placeholder text.
    IMPORTANT: Pressing Ctrl+Space activates the search — the title bar turns RED, the search field
    expands and highlights BLUE, and the user can type an activity name to navigate. This is the
    PRIMARY navigation method. When the search is active, the entire title bar looks different.
  Right side: Notification badges (Staff Messages count, Open Non-Billable count, Referral Triage count),
    small icon buttons, then a green "SUP ENVIRONMENT" badge (in training), then user initials avatar (e.g., "MJ").

LAYER 2 — SHORTCUT TOOLBAR (gray bar with small icons + text labels, ~20px):
  A row of quick-launch shortcut buttons. These are NOT the current activity — they are shortcuts to OPEN activities.
  Common shortcuts: Builder, Unit Manager, In Basket, Schedule, Patient Lists, Chart, Manage Orders,
    Encounter, Telephone Call, Patient Station, Record Viewer, Build Comparison, Personalize,
    On-Call Finder, Census Inquiry Editor, More...
  Far right: Print button, Log Out button.
  These shortcuts are configurable per user/role — analysts may see Builder, Unit Manager, etc.

LAYER 3 — WORKSPACE TABS (horizontal tabs, ~22px, just below shortcut toolbar):
  These tabs show what is currently OPEN. Each tab = one open workspace or patient context.
  Tab types:
    - Patient tabs: Show patient name (e.g., "Nuno, David") with an "x" to close — means a patient chart is open.
    - Workspace tabs: Show workspace name (e.g., "Radar Admin", "Schedule", "In Basket").
    - Build tabs: Show record being edited (e.g., "Radar Admin", "Report Writer").
  The ACTIVE/SELECTED tab is the one currently displayed in the workspace below.
  Clicking a different tab switches the workspace content.

LAYER 3b — ACTIVITY TABS (ONLY inside a patient chart, below workspace tabs):
  When a patient tab is active, a SECOND row of tabs appears showing clinical activities:
    SnapShot, Chart Review, Review Flowsheets, Synopsis, Results Review, Demographics,
    Allergies, History, Problem List, Send Letter, Transplant, Dialysis Overview, iReport,
    Report, Identity Manager, etc.
  Some tabs may have special icons (e.g., Transplant has a colored icon).
  These activity tabs are specific to the patient chart context and do NOT appear in non-patient workspaces.
  The SELECTED activity tab determines what shows in the workspace below.

LAYER 4 — BREADCRUMB / RECORD TITLE (below tabs, shows current context):
  Back/forward navigation arrows (< >) on the left.
  Then the current record or screen title, often with an ID in brackets.
  Examples: "UCSD TXP Transplant Staff Dashboard [100645]", "Snapshot Report", "Patient Lookup".
  THIS IS THE BEST IDENTIFIER for what specific screen/record the user is working on.
  In patient chart context, may also show REPORT SUB-TABS below the title:
    e.g., Snapshot Report | PCAR | Due Meds | Vitals-Last Day | VS Graph | MAR | IO 72 | Wt

LAYER 5 — LEFT SIDEBAR (vertical navigation pane, colored background, ~120px wide):
  Context-dependent navigation categories. The sidebar content changes based on the active workspace:
    - Radar Admin / Builder: Dashboards, Components, Messages, Resources, Metrics, Queries,
      Properties, Notifications, Levels, Fields, Redirectors, Settings
    - Patient Chart: Patient-specific navigation (problems, allergies, medications, etc. with colored highlights)
    - Patient List: Department/unit folders, patient groupings
    - In Basket: Message folders (In, Sent, Results, Rx Requests, etc.)
    - Home/Dashboard: May not be visible (dashboard takes full width)
  The sidebar has its own highlighted/selected item showing the current sub-section.

LAYER 6 — MAIN WORKSPACE (center/right, largest area):
  Content varies per activity and sidebar selection:
    - HOME DASHBOARD: Multi-column report layout. Example — Transplant Staff Dashboard shows:
      Left column: "Kidney Reports" (Committee Review Reports, Pre Kidney patient lists, Post Kidney)
      Center column: Patient lists with "Ready to run" / "New" / "Total" status badges
      Right column: "Compliance Reports" (CMS Survey Reports) and "UNOS Forms Due" tables
    - Build/Admin screens: Form fields (Record name, Display title, Description, etc.) with sub-tabs
      (Basic Information, Content, Parameters, Distribution)
    - Patient Chart — Snapshot Report: Color-coded clinical summary sections (red/pink/purple headers),
      vitals, recent results, transplant-specific data, clinical notes
    - Patient Chart — Chart Review: Tabular report list or document viewer
    - Patient Chart — Flowsheets: Grid with time columns and parameter rows
    - Patient Chart — Orders: Order entry with search and order list
    - List screens: Tables with sortable columns
  May contain its own sub-tabs within the workspace area.

LAYER 7 — BOTTOM BAR (bottom of screen, ~25px):
  Action buttons: typically Cancel and Accept (for build/edit screens), or Sign/Submit (for clinical).
  Settings gear icon may appear on far left of bottom bar.
  May show status text (e.g., "UCSD TXP Post-Lung Overdue Tasks").

FLOATING ELEMENTS (higher z-index, overlaying the workspace):
  - Secure Chat popup (top-right corner): "You have N staff conversation(s) with unread messages. Open Chat"
  - BPA/BestPractice Advisory alerts: Yellow/orange warning dialogs
  - Modal dialogs: Order entry, medication reconciliation, print preview, etc.
  - EPIC BUTTON MENU (floating overlay from clicking the Epic logo, left side of screen):
      Top: "Search activities" text input field
      "Pinned" section (may say "No pinned items")
      "Recent" section: recently opened items (e.g., Dashboard Editor, Transplant Configuration)
      Navigation CATEGORIES (vertical list): Lab, Patient Care, Pharmacy, Radiology, Surgery,
        CRM/CM, Billing, HIM, Utilization Management, Referrals, Registration/ADT, Scheduling,
        Interfaces, Reports, Tools, Admin, My Settings
      Each category has ">" arrow and expands to show submenu items on the right
      Bottom: Log Out button, "Secure" indicator
  - Ctrl+Space SEARCH MODE: Title bar turns RED, search field expands with BLUE highlight,
      user types activity/record name to navigate directly. This is the primary navigation method.
  If any floating element is visible, identify IT as the primary screen element.

IDENTIFYING THE CURRENT SCREEN — priority order:
  1. Check for FLOATING ELEMENTS first (dialogs, Epic menu, Ctrl+Space search active) — if present, label it.
  2. Read the BREADCRUMB/RECORD TITLE (Layer 4) — this is the most specific identifier.
  3. Read the ACTIVE WORKSPACE TAB (Layer 3) — this tells you the workspace context.
  4. If patient chart is open, read the ACTIVITY TAB (Layer 3b) — which clinical activity is selected.
  5. Check the LEFT SIDEBAR selection (Layer 5) — this tells you the sub-section.
  6. Glance at workspace content (Layer 6) — confirms what type of screen it is.
  DO NOT read the title bar (Layer 1) for screen identification — it only shows department/environment.
"""


def wait_for_stable_screen(window, max_wait=3.0, interval=0.5, threshold=0.02):
    """Wait until the screen stops changing (application has settled).

    Anthropic best practice: 'Some applications may take time to start or process
    actions, so you may need to wait and take successive screenshots to see the
    results of your actions.'

    Takes screenshots at intervals and compares pixel differences.
    Returns when the screen is stable (< threshold difference) or max_wait reached.
    Returns the final stable screenshot.
    """
    import hashlib
    prev_hash = None
    stable_count = 0
    waited = 0.0

    while waited < max_wait:
        img = screenshot_window(window)
        b64 = img_to_base64(img)
        curr_hash = hashlib.md5(b64.encode()).hexdigest()

        if curr_hash == prev_hash:
            stable_count += 1
            if stable_count >= 2:
                return img, b64
        else:
            stable_count = 0

        prev_hash = curr_hash
        time.sleep(interval)
        waited += interval

    img = screenshot_window(window)
    b64 = img_to_base64(img)
    return img, b64

recording_state = {
    "active": False,
    "env": "SUP",
    "last_screen": "",
    "last_capture_time": 0,
    "capture_interval": 3,
    "pending_steps": [],
}


_window_snapshot = {}


# ────────────────────────────────────────────────────────────────────────────
# Universal Session Recorder — passive capture for any window
# Records keyboard/mouse events, change-detection screenshots, window title
# changes. Zero vision calls during recording; post-processed offline.
# ────────────────────────────────────────────────────────────────────────────

_SESSION_SCREENSHOT_INTERVAL = 1.0
_SESSION_PIXEL_DIFF_THRESHOLD = 0.005
_SESSION_CROP_SIZE = 150
_SESSION_HASH_SIZE = 8
_SESSION_DIR_BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sessions")

# ── Always-on capture state ──
_ALWAYS_ON_STREAM_INTERVAL = 10.0
_ALWAYS_ON_CAPTURES = {}
_always_on_lock = threading.Lock()

_SCREEN_LABELS = {}
_SCREEN_LABEL_LOCK = threading.Lock()
_LABEL_QUEUE = None
_LABEL_MODEL = "google/gemini-2.0-flash-001"


_EPIC_LABEL_PROMPT = EPIC_VISUAL_REFERENCE + """
TASK: Identify this screen and return a label + context.

Follow the IDENTIFYING THE CURRENT SCREEN priority order from the reference:
1. Is the title bar RED with a BLUE search field? -> LABEL: Search Active
2. Is the EPIC BUTTON MENU open (floating overlay on left)? -> LABEL: Epic Menu
3. Any other floating element (dialog, Secure Chat, BPA alert)? -> Label that element.
4. Read the BREADCRUMB / RECORD TITLE (Layer 4) — most specific identifier.
   Examples: "UCSD TXP Transplant Staff Dashboard [100645]" -> "TXP Staff Dashboard"
             "Snapshot Report" -> "Snapshot Report"
5. If in a patient chart, read the ACTIVITY TAB (Layer 3b): SnapShot, Chart Review, etc.
6. Read the ACTIVE WORKSPACE TAB (Layer 3): "Radar Admin", "Schedule", etc.
7. Check LEFT SIDEBAR selection (Layer 5) for sub-section context.
DO NOT use the title bar text (Layer 1) — it only shows department/environment.

RESPONSE FORMAT — reply with exactly these lines:
LABEL: <2-6 word screen/activity name>
CONTEXT: <none|patient|encounter>
EPHEMERAL: <true|false>
ACTIVITY: <current activity name or none>
PATIENT_TAB: <true|false>

Context detection rules:
- CONTEXT: none = no patient tabs visible in Layer 3, workspace-level screen
- CONTEXT: patient = patient name tab visible in Layer 3 (e.g. "Nuno, David" with x close button), viewing patient chart in review mode
- CONTEXT: encounter = patient tab visible AND encounter-specific indicators (order entry, documentation, encounter-level flowsheets)
- EPHEMERAL: true = floating overlay (dialog, BPA alert, Epic Menu, search overlay, right-click menu) — dismissing returns to previous screen
- EPHEMERAL: false = persistent screen (workspace, patient chart, activity)
- ACTIVITY: the specific activity name from Layer 3b activity tabs or Layer 4 breadcrumb (e.g. "Chart Review", "Flowsheets", "InBasket"). Write "none" if no specific activity.
- PATIENT_TAB: true if Layer 3 has patient name tabs with close buttons, false otherwise

Examples:
LABEL: TXP Staff Dashboard
CONTEXT: none
EPHEMERAL: false
ACTIVITY: TXP Staff Dashboard
PATIENT_TAB: false

LABEL: Chart Review
CONTEXT: patient
EPHEMERAL: false
ACTIVITY: Chart Review
PATIENT_TAB: true

LABEL: Epic Menu
CONTEXT: none
EPHEMERAL: true
ACTIVITY: none
PATIENT_TAB: false

LABEL: BPA Alert Dialog
CONTEXT: patient
EPHEMERAL: true
ACTIVITY: none
PATIENT_TAB: true

If the screen is blank, loading, or unrecognizable: LABEL: Unknown Screen
Do NOT include patient names, MRNs, or PHI in the LABEL."""


_SCREEN_CONTEXTS = {}
_SCREEN_CONTEXT_LOCK = threading.Lock()

_CONTEXT_STACKS = {}
_CONTEXT_STACK_LOCK = threading.Lock()


def _update_context_stack(window_key, prev_fp, fp, from_ctx, to_ctx, nav_strategy):
    with _CONTEXT_STACK_LOCK:
        if window_key not in _CONTEXT_STACKS:
            _CONTEXT_STACKS[window_key] = {
                "base": "none",
                "ephemeral_depth": 0,
                "history": [],
                "current_fp": None,
                "current_ctx": {},
            }
        stack = _CONTEXT_STACKS[window_key]

        to_level = to_ctx.get("contextLevel", "none") if to_ctx else "none"
        to_ephemeral = to_ctx.get("ephemeral", False) if to_ctx else False
        from_ephemeral = from_ctx.get("ephemeral", False) if from_ctx else False

        if from_ephemeral and not to_ephemeral:
            stack["ephemeral_depth"] = max(0, stack["ephemeral_depth"] - 1)
        elif to_ephemeral and not from_ephemeral:
            stack["ephemeral_depth"] += 1

        if not to_ephemeral:
            stack["base"] = to_level

        stack["current_fp"] = fp
        stack["current_ctx"] = to_ctx or {}
        stack["history"].append({
            "fp": fp,
            "ctx": to_level,
            "ephemeral": to_ephemeral,
            "strategy": nav_strategy,
            "ts": time.time(),
        })
        if len(stack["history"]) > 50:
            stack["history"] = stack["history"][-30:]

        return stack.copy()


def _parse_label_response(raw):
    label = None
    context = {"contextLevel": "none", "ephemeral": False, "activity": None, "patientTab": False}
    for line in raw.strip().split("\n"):
        line = line.strip()
        if line.startswith("LABEL:"):
            label = line.split("LABEL:", 1)[1].strip().strip('"').strip("'").strip()
        elif line.startswith("CONTEXT:"):
            val = line.split("CONTEXT:", 1)[1].strip().lower()
            if val in ("none", "patient", "encounter"):
                context["contextLevel"] = val
        elif line.startswith("EPHEMERAL:"):
            context["ephemeral"] = line.split("EPHEMERAL:", 1)[1].strip().lower() == "true"
        elif line.startswith("ACTIVITY:"):
            val = line.split("ACTIVITY:", 1)[1].strip()
            if val.lower() != "none" and val:
                context["activity"] = val
        elif line.startswith("PATIENT_TAB:"):
            context["patientTab"] = line.split("PATIENT_TAB:", 1)[1].strip().lower() == "true"
    return label, context


def _screen_labeler_thread():
    while True:
        try:
            fp, img = _LABEL_QUEUE.get(timeout=5)
        except Exception:
            continue
        with _SCREEN_LABEL_LOCK:
            if fp in _SCREEN_LABELS:
                continue
        try:
            b64 = img_to_base64(img, use_jpeg=True)
            resp = requests.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": _LABEL_MODEL,
                    "messages": [{"role": "user", "content": [
                        {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
                        {"type": "text", "text": _EPIC_LABEL_PROMPT},
                    ]}],
                    "max_tokens": 120,
                },
                timeout=30,
            )
            if resp.status_code == 200:
                raw = resp.json()["choices"][0]["message"]["content"].strip()
                label, context = _parse_label_response(raw)
                if label and len(label) < 80 and label.lower() != "unknown screen":
                    with _SCREEN_LABEL_LOCK:
                        _SCREEN_LABELS[fp] = label
                    with _SCREEN_CONTEXT_LOCK:
                        _SCREEN_CONTEXTS[fp] = context
                    ctx_str = context["contextLevel"]
                    if context["ephemeral"]:
                        ctx_str += "/ephemeral"
                    if context["activity"]:
                        ctx_str += f"/{context['activity']}"
                    print(f"  [label] {fp[:12]}.. = {label} [{ctx_str}]")
                else:
                    print(f"  [label] {fp[:12]}.. unrecognized: {raw[:60]}")
            else:
                detail = ""
                try:
                    detail = resp.json().get("error", {}).get("message", resp.text[:120])
                except Exception:
                    detail = resp.text[:120]
                print(f"  [label] API {resp.status_code} for {fp[:12]}.. : {detail}")
        except Exception as e:
            print(f"  [label] error for {fp[:12]}..: {e}")


def _always_on_window_key(title):
    import re
    return re.sub(r'[^a-zA-Z0-9_ -]', '', title)[:60].strip().replace(' ', '_').lower()


def _always_on_get_capture(window_title):
    key = _always_on_window_key(window_title)
    with _always_on_lock:
        return _ALWAYS_ON_CAPTURES.get(key)


def _always_on_start_capture(window_title):
    key = _always_on_window_key(window_title)
    with _always_on_lock:
        if key in _ALWAYS_ON_CAPTURES and _ALWAYS_ON_CAPTURES[key]["active"]:
            return _ALWAYS_ON_CAPTURES[key]

    session_id = f"aon_{int(time.time())}_{random.randint(1000, 9999)}"
    os.makedirs(_SESSION_DIR_BASE, exist_ok=True)
    session_dir = os.path.join(_SESSION_DIR_BASE, session_id)
    os.makedirs(session_dir, exist_ok=True)

    stop_event = threading.Event()

    cap = {
        "active": True,
        "window_title": window_title,
        "window_key": key,
        "session_id": session_id,
        "session_dir": session_dir,
        "start_time": time.time(),
        "stop_event": stop_event,
        "last_fingerprint": None,
        "last_img": None,
        "last_title": "",
        "fingerprints": {},
        "pending_transitions": [],
        "pending_fingerprints": {},
        "pending_lock": threading.Lock(),
        "node_count": 0,
        "edge_count": 0,
        "transition_count": 0,
        "screenshot_seq": 0,
        "action_buffer": [],
        "action_buffer_lock": threading.Lock(),
        "last_fp_change_time": time.time(),
        "last_transition_ts": 0.0,
    }

    ss_thread = threading.Thread(
        target=_always_on_screenshot_loop,
        args=(cap,),
        daemon=True, name=f"aon-ss-{key}"
    )
    title_thread = threading.Thread(
        target=_always_on_title_loop,
        args=(cap,),
        daemon=True, name=f"aon-title-{key}"
    )
    ss_thread.start()
    title_thread.start()
    cap["threads"] = [ss_thread, title_thread]

    with _always_on_lock:
        _ALWAYS_ON_CAPTURES[key] = cap

    _aon_ensure_global_input()

    global _LABEL_QUEUE
    if _LABEL_QUEUE is None:
        import queue
        _LABEL_QUEUE = queue.Queue()
        t = threading.Thread(target=_screen_labeler_thread, daemon=True, name="screen-labeler")
        t.start()
        print("  [label] Screen labeler thread started")

    input_status = "full" if _aon_global_input["active"] else "screenshot-only"
    print(f"  [always-on] Started capture: {window_title} (key={key}, sid={session_id}, input={input_status})")
    return cap


_aon_global_input = {
    "active": False,
    "listeners": [],
    "significant_keys": set(),
    "active_modifiers": set(),
}


def _aon_get_focused_capture():
    try:
        fg_title = ""
        try:
            import ctypes
            hwnd = ctypes.windll.user32.GetForegroundWindow()
            length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
            if length > 0:
                buf = ctypes.create_unicode_buffer(length + 1)
                ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1)
                fg_title = buf.value
        except Exception:
            try:
                fw = gw.getActiveWindow()
                fg_title = fw.title if fw else ""
            except Exception:
                pass

        if not fg_title:
            return None

        fg_lower = fg_title.lower()
        with _always_on_lock:
            for cap in _ALWAYS_ON_CAPTURES.values():
                if cap["active"] and cap["window_title"].lower() in fg_lower:
                    return cap
    except Exception:
        pass
    return None


def _aon_ensure_global_input():
    if _aon_global_input["active"]:
        return

    try:
        from pynput import mouse as pm, keyboard as pk
    except ImportError:
        print("  [always-on] pynput not installed — input capture disabled")
        return

    try:
        for kname in ["enter", "tab", "esc", "backspace", "delete",
                       "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8",
                       "f9", "f10", "f11", "f12", "home", "end",
                       "page_up", "page_down"]:
            try:
                _aon_global_input["significant_keys"].add(getattr(pk.Key, kname))
            except AttributeError:
                pass
    except Exception:
        pass

    def on_click(x, y, button, pressed):
        if not pressed:
            return
        cap = _aon_get_focused_capture()
        if not cap:
            return
        with cap["action_buffer_lock"]:
            cap["action_buffer"].append({
                "type": "click",
                "x": x, "y": y,
                "button": str(button),
                "ts": time.time(),
            })
        try:
            img, win = _session_grab_window(cap["window_title"])
            if img:
                w, h = img.size
                win_left = win.left if win else 0
                win_top = win.top if win else 0
                rel_x = x - win_left
                rel_y = y - win_top
                if 0 <= rel_x < w and 0 <= rel_y < h:
                    crop_fname = _session_save_crop(cap["session_dir"], img, rel_x, rel_y, cap["screenshot_seq"] + 50000)
                    with cap["action_buffer_lock"]:
                        cap["action_buffer"].append({
                            "type": "label_crop",
                            "file": crop_fname,
                            "rel_x": rel_x, "rel_y": rel_y,
                            "ts": time.time(),
                        })
        except Exception:
            pass

    def on_press(key):
        try:
            if key in (pk.Key.ctrl_l, pk.Key.ctrl_r, pk.Key.alt_l, pk.Key.alt_r,
                        pk.Key.shift_l, pk.Key.shift_r, pk.Key.cmd, pk.Key.cmd_r):
                _aon_global_input["active_modifiers"].add(key)
                return
        except Exception:
            pass

        is_sig = key in _aon_global_input["significant_keys"]
        has_modifier = len(_aon_global_input["active_modifiers"]) > 0
        is_ctrl_combo = has_modifier and hasattr(key, 'char') and key.char

        if is_sig or is_ctrl_combo:
            cap = _aon_get_focused_capture()
            if not cap:
                return
            if is_ctrl_combo:
                mod_names = []
                for m in _aon_global_input["active_modifiers"]:
                    try:
                        mod_names.append(m.name)
                    except Exception:
                        mod_names.append(str(m))
                key_desc = "+".join(mod_names) + "+" + (key.char if hasattr(key, 'char') and key.char else str(key))
            else:
                key_desc = key.name if hasattr(key, 'name') else str(key)
            with cap["action_buffer_lock"]:
                cap["action_buffer"].append({
                    "type": "key",
                    "key": key_desc,
                    "special": True,
                    "ts": time.time(),
                })

    def on_release(key):
        try:
            _aon_global_input["active_modifiers"].discard(key)
        except Exception:
            pass

    try:
        mouse_l = pm.Listener(on_click=on_click)
        key_l = pk.Listener(on_press=on_press, on_release=on_release)
        mouse_l.daemon = True
        key_l.daemon = True
        mouse_l.start()
        key_l.start()
        _aon_global_input["listeners"] = [mouse_l, key_l]
        _aon_global_input["active"] = True
        print("  [always-on] Global input listeners started (focus-aware dispatch)")
    except Exception as e:
        print(f"  [always-on] Input listener error: {e}")


def _aon_stop_global_input():
    if not _aon_global_input["active"]:
        return
    for listener in _aon_global_input["listeners"]:
        try:
            listener.stop()
        except Exception:
            pass
    _aon_global_input["listeners"] = []
    _aon_global_input["active"] = False
    _aon_global_input["active_modifiers"] = set()
    print("  [always-on] Global input listeners stopped")


def _always_on_drain_actions(cap):
    with cap["action_buffer_lock"]:
        actions = list(cap["action_buffer"])
        cap["action_buffer"] = []
    return actions


def _always_on_extract_action_keys(actions):
    keys = []
    label_crops = []
    for a in actions:
        if a["type"] == "key" and a.get("key"):
            keys.append(a["key"])
        elif a["type"] == "click":
            keys.append(f"click({a.get('x', 0)},{a.get('y', 0)})")
        elif a["type"] == "label_crop" and a.get("file"):
            label_crops.append(a["file"])
    return keys[-10:], label_crops[-3:]


def _always_on_screenshot_loop(cap):
    stop_event = cap["stop_event"]
    _dbg_cycle = 0
    while not stop_event.is_set():
        try:
            img, win = _session_grab_window(cap["window_title"])
            if img is None:
                stop_event.wait(_SESSION_SCREENSHOT_INTERVAL)
                continue

            if cap["last_img"] is not None:
                diff = _session_pixel_diff(cap["last_img"], img)
                _dbg_cycle += 1
                if _dbg_cycle % 5 == 0:
                    wk = cap.get("window_key", "?")[:30]
                    print(f"  [aon-diff] {wk}: diff={diff:.4f} (thresh={_SESSION_PIXEL_DIFF_THRESHOLD})")
                if diff < _SESSION_PIXEL_DIFF_THRESHOLD:
                    stop_event.wait(_SESSION_SCREENSHOT_INTERVAL)
                    continue

            fp_region = _session_fingerprint_region(img)
            fp = _session_phash(fp_region)
            if fp == "0":
                stop_event.wait(_SESSION_SCREENSHOT_INTERVAL)
                continue

            cap["screenshot_seq"] += 1
            _session_save_screenshot(cap["session_dir"], img.copy(), cap["screenshot_seq"])

            current_title = (win.title if win else None) or cap["window_title"]
            prev_fp = cap["last_fingerprint"]
            prev_title = cap.get("_last_win_title") or cap["window_title"]
            now = time.time()

            is_new_fp = fp not in cap["fingerprints"]

            with cap["pending_lock"]:
                if fp not in cap["pending_fingerprints"]:
                    cap["pending_fingerprints"][fp] = {"count": 0, "titles": []}
                cap["pending_fingerprints"][fp]["count"] += 1
                if current_title and current_title not in cap["pending_fingerprints"][fp]["titles"]:
                    cap["pending_fingerprints"][fp]["titles"].append(current_title)

                cap["fingerprints"][fp] = cap["fingerprints"].get(fp, 0) + 1

            if is_new_fp and _LABEL_QUEUE is not None:
                with _SCREEN_LABEL_LOCK:
                    already_labeled = fp in _SCREEN_LABELS
                if not already_labeled:
                    try:
                        _LABEL_QUEUE.put_nowait((fp, img.copy()))
                    except Exception:
                        pass

            with cap["pending_lock"]:
                if prev_fp and prev_fp != fp:
                    actions_since = _always_on_drain_actions(cap)
                    action_keys, label_crops = _always_on_extract_action_keys(actions_since)
                    transition_ms = int((now - cap.get("last_fp_change_time", now)) * 1000)

                    nav_strategy = "click"
                    for ak in action_keys:
                        ak_lower = ak.lower() if isinstance(ak, str) else ""
                        if "ctrl" in ak_lower and "space" in ak_lower:
                            nav_strategy = "search"
                            break
                        if ak_lower in ("f1","f2","f3","f4","f5","f6","f7","f8","f9","f10","f11","f12",
                                        "alt","tab","escape","enter","home","end"):
                            nav_strategy = "keyboard"
                        if "alt+" in ak_lower or "ctrl+" in ak_lower:
                            nav_strategy = "keyboard"

                    with _SCREEN_CONTEXT_LOCK:
                        from_ctx = _SCREEN_CONTEXTS.get(prev_fp, {})
                        to_ctx = _SCREEN_CONTEXTS.get(fp, {})

                    _update_context_stack(cap["window_key"], prev_fp, fp, from_ctx, to_ctx, nav_strategy)

                    cap["pending_transitions"].append({
                        "from_fp": prev_fp,
                        "to_fp": fp,
                        "from_title": prev_title,
                        "to_title": current_title,
                        "timestamp": now,
                        "transition_ms": transition_ms,
                        "action_keys": action_keys,
                        "label_crop": label_crops[0] if label_crops else None,
                        "nav_strategy": nav_strategy,
                        "from_context": from_ctx if from_ctx else None,
                        "to_context": to_ctx if to_ctx else None,
                    })
                    cap["transition_count"] += 1
                    cap["last_fp_change_time"] = now
                    cap["last_transition_ts"] = now

            cap["last_fingerprint"] = fp
            cap["last_img"] = img
            cap["_last_win_title"] = current_title
            cap["node_count"] = len(cap["fingerprints"])

        except Exception as e:
            print(f"  [always-on] screenshot error ({cap['window_key']}): {e}")

        stop_event.wait(_SESSION_SCREENSHOT_INTERVAL)


def _always_on_title_loop(cap):
    stop_event = cap["stop_event"]
    last_title = [""]
    while not stop_event.is_set():
        try:
            current_title = ""
            try:
                import ctypes
                hwnd = ctypes.windll.user32.GetForegroundWindow()
                length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
                if length > 0:
                    buf = ctypes.create_unicode_buffer(length + 1)
                    ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1)
                    current_title = buf.value
            except Exception:
                try:
                    fw = gw.getActiveWindow()
                    current_title = fw.title if fw else ""
                except Exception:
                    pass

            if current_title and current_title != last_title[0]:
                cap["last_title"] = current_title
                last_title[0] = current_title
        except Exception:
            pass
        stop_event.wait(0.5)


def _always_on_flush_loop(cap):
    stop_event = cap["stop_event"]
    while not stop_event.is_set():
        stop_event.wait(_ALWAYS_ON_STREAM_INTERVAL)
        if stop_event.is_set():
            break
        _always_on_flush(cap)


def _always_on_flush(cap):
    with cap["pending_lock"]:
        transitions = list(cap["pending_transitions"])
        fingerprints = dict(cap["pending_fingerprints"])
        cap["pending_transitions"] = []
        cap["pending_fingerprints"] = {}

    wk = cap.get("window_key", "?")[:28]
    print(f"  [aon-flush-dbg] {wk}: {len(fingerprints)} fps, {len(transitions)} trans")
    if not transitions and not fingerprints:
        return

    payload = {
        "windowKey": cap["window_key"],
        "windowTitle": cap["window_title"],
        "sessionId": cap["session_id"],
        "transitions": transitions,
        "fingerprints": fingerprints,
    }

    try:
        resp = _bridge_request(
            "post", "/api/sessions/stream", "stream-flush", timeout=15,
            headers={
                "Authorization": f"Bearer {BRIDGE_TOKEN}",
                "Content-Type": "application/json",
            },
            json=payload,
        )
        print(f"  [aon-flush-resp] resp={resp.status_code if resp else 'None'} body={resp.text[:120] if resp else 'N/A'}")
        if resp and resp.status_code == 200:
            rdata = resp.json()
            cap["node_count"] = rdata.get("treeNodes", cap["node_count"])
            cap["edge_count"] = rdata.get("treeEdges", cap["edge_count"])
            wk = cap.get("window_key", "?")[:28]
            print(f"  [always-on] flush OK {wk}: {cap['node_count']}n/{cap['edge_count']}e ({len(transitions)}t sent)")
        elif resp:
            print(f"  [always-on] stream flush HTTP {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        print(f"  [always-on] stream flush error: {e}")


def _always_on_stop_capture(window_key):
    with _always_on_lock:
        cap = _ALWAYS_ON_CAPTURES.get(window_key)
        if not cap or not cap["active"]:
            return None

    cap["active"] = False
    stop_event = cap.get("stop_event")
    if stop_event:
        stop_event.set()

    for thread in cap.get("threads", []):
        try:
            thread.join(timeout=3)
        except Exception:
            pass

    _always_on_flush(cap)

    with _always_on_lock:
        if window_key in _ALWAYS_ON_CAPTURES:
            del _ALWAYS_ON_CAPTURES[window_key]
        remaining = sum(1 for c in _ALWAYS_ON_CAPTURES.values() if c["active"])

    if remaining == 0:
        _aon_stop_global_input()

    print(f"  [always-on] Stopped capture: {cap['window_title']} ({cap['transition_count']} transitions)")
    return cap


def _always_on_get_capture_state():
    with _always_on_lock:
        result = {}
        for key, cap in _ALWAYS_ON_CAPTURES.items():
            if cap["active"]:
                result[key] = {
                    "recording_active": True,
                    "window": cap["window_title"],
                    "sessionId": cap["session_id"],
                    "elapsed_s": int(time.time() - cap["start_time"]),
                    "nodes": cap["node_count"],
                    "edges": cap["edge_count"],
                    "transitions": cap["transition_count"],
                    "screenshots": cap["screenshot_seq"],
                    "last_transition_ts": cap.get("last_transition_ts", 0),
                    "current_fp": cap.get("last_fingerprint", ""),
                }
                with _CONTEXT_STACK_LOCK:
                    cs = _CONTEXT_STACKS.get(key)
                    if cs:
                        result[key]["context"] = {
                            "base": cs["base"],
                            "ephemeral_depth": cs["ephemeral_depth"],
                            "current_ctx": cs["current_ctx"],
                        }
        return result


_AON_MIN_WINDOW_SIZE = 200
_AON_EXCLUDED_TITLES = {
    "", "program manager", "settings", "task switching",
    "start", "search", "cortana", "task view", "new notification",
}

_AON_CITRIX_PATTERNS = [
    "\\\\remote",
    "citrix",
    "hyperspace",
    "epic",
    "haiku",
    "canto",
    "willow",
    "caboodle",
    "radar",
    "cogito",
    "cheers",
    "resolute",
    "prelude",
    "cadence",
    "kaleidoscope",
    "tapestry",
    "beaker",
    "beacon",
    "stork",
    "optime",
    "rover",
    "cupid",
    "wisdom",
]


def _always_on_discover_windows():
    titles = []
    try:
        for w in gw.getAllWindows():
            t = (w.title or "").strip()
            if not t or t.lower() in _AON_EXCLUDED_TITLES:
                continue
            if w.width < _AON_MIN_WINDOW_SIZE or w.height < _AON_MIN_WINDOW_SIZE:
                continue
            if not w.visible:
                continue
            t_lower = t.lower()
            if not any(p in t_lower for p in _AON_CITRIX_PATTERNS):
                continue
            titles.append(t)
    except Exception:
        pass
    return titles


def _always_on_heartbeat_tick(epic_window_titles):
    desktop_titles = _always_on_discover_windows()
    all_titles = list(set(epic_window_titles + desktop_titles))

    for win_title in all_titles:
        key = _always_on_window_key(win_title)
        with _always_on_lock:
            if key in _ALWAYS_ON_CAPTURES and _ALWAYS_ON_CAPTURES[key]["active"]:
                continue
        try:
            _always_on_start_capture(win_title)
        except Exception as e:
            print(f"  [always-on] Failed to start capture for {win_title}: {e}")

    with _always_on_lock:
        active_keys = list(_ALWAYS_ON_CAPTURES.keys())
    found_keys = set(_always_on_window_key(w) for w in all_titles)
    for key in active_keys:
        if key not in found_keys:
            _always_on_stop_capture(key)

_session_rec = {
    "active": False,
    "window_title": "",
    "session_id": "",
    "session_dir": "",
    "start_time": 0.0,
    "stop_event": None,
    "events": [],
    "event_lock": None,
    "screenshot_count": 0,
    "event_count": 0,
    "listeners": [],
    "threads": [],
    "last_screenshot_hash": None,
    "last_screenshot_img": None,
    "fingerprints": {},
    "title_history": [],
}


def _session_phash(img):
    """Compute average perceptual hash of an image region."""
    try:
        from PIL import Image
        small = img.resize((_SESSION_HASH_SIZE, _SESSION_HASH_SIZE), Image.LANCZOS).convert("L")
        pixels = list(small.getdata())
        avg = sum(pixels) / len(pixels) if pixels else 128
        bits = "".join("1" if p > avg else "0" for p in pixels)
        return hex(int(bits, 2))[2:].zfill((_SESSION_HASH_SIZE * _SESSION_HASH_SIZE) // 4)
    except Exception:
        return "0"


def _session_pixel_diff(img1, img2):
    """Fraction of pixels that differ significantly between two images (0-1)."""
    try:
        if img1.size != img2.size:
            img2 = img2.resize(img1.size)
        p1 = list(img1.convert("L").getdata())
        p2 = list(img2.convert("L").getdata())
        if not p1:
            return 1.0
        diffs = sum(1 for a, b in zip(p1, p2) if abs(a - b) > 25)
        return diffs / len(p1)
    except Exception:
        return 1.0


def _session_fingerprint_region(img):
    """Use the full image for fingerprinting — phash downscales to 8x8 so this is fast.
    The old top-15% crop missed most of Hyperspace's content area which lives lower."""
    return img


def _session_grab_window(window_title):
    """Capture a screenshot of the window matching title. Returns PIL Image or None."""
    try:
        for w in gw.getAllWindows():
            t = w.title or ""
            if window_title.lower() in t.lower() and w.width > 50 and w.height > 50:
                bbox = (w.left, w.top, w.left + w.width, w.top + w.height)
                try:
                    full = ImageGrab.grab(all_screens=True)
                    img = full.crop(bbox)
                except Exception:
                    img = ImageGrab.grab(bbox=bbox, include_layered_windows=True)
                return img, w
    except Exception:
        pass
    return None, None


def _session_save_screenshot(session_dir, img, seq, annotation=None):
    """Save a screenshot PNG to the session directory. Returns filename."""
    fname = f"frame_{seq:05d}.png"
    fpath = os.path.join(session_dir, fname)
    if annotation:
        from PIL import ImageDraw
        draw = ImageDraw.Draw(img)
        x, y = annotation["x"], annotation["y"]
        r = 12
        draw.line([(x - r, y), (x + r, y)], fill="red", width=3)
        draw.line([(x, y - r), (x, y + r)], fill="red", width=3)
        draw.ellipse([(x - r, y - r), (x + r, y + r)], outline="red", width=2)
    img.save(fpath, format="PNG", compress_level=6)
    return fname


def _session_save_crop(session_dir, img, x, y, seq):
    """Save a 150x150 crop around click coordinates. Returns filename."""
    w, h = img.size
    half = _SESSION_CROP_SIZE // 2
    left = max(0, x - half)
    top = max(0, y - half)
    right = min(w, x + half)
    bottom = min(h, y + half)
    crop = img.crop((left, top, right, bottom))
    fname = f"crop_{seq:05d}.png"
    fpath = os.path.join(session_dir, fname)
    crop.save(fpath, format="PNG")
    return fname


def _session_add_event(ev):
    """Thread-safe append to session events."""
    lock = _session_rec.get("event_lock")
    if lock:
        with lock:
            _session_rec["events"].append(ev)
            _session_rec["event_count"] += 1
    else:
        _session_rec["events"].append(ev)
        _session_rec["event_count"] += 1


def _session_screenshot_thread(stop_event, window_title, session_dir):
    """Background thread: capture screenshots on change detection."""
    seq = [0]
    last_img = [None]

    while not stop_event.is_set():
        try:
            img, win = _session_grab_window(window_title)
            if img is None:
                stop_event.wait(_SESSION_SCREENSHOT_INTERVAL)
                continue

            if last_img[0] is not None:
                diff = _session_pixel_diff(last_img[0], img)
                if diff < _SESSION_PIXEL_DIFF_THRESHOLD:
                    stop_event.wait(_SESSION_SCREENSHOT_INTERVAL)
                    continue

            seq[0] += 1
            fname = _session_save_screenshot(session_dir, img.copy(), seq[0])
            fp_region = _session_fingerprint_region(img)
            fp = _session_phash(fp_region)

            lock = _session_rec.get("event_lock")
            if lock:
                with lock:
                    _session_rec["screenshot_count"] = seq[0]
                    _session_rec["fingerprints"][fp] = _session_rec["fingerprints"].get(fp, 0) + 1
                    _session_rec["last_screenshot_img"] = img
                    _session_rec["last_screenshot_hash"] = fp
            else:
                _session_rec["screenshot_count"] = seq[0]
                _session_rec["fingerprints"][fp] = _session_rec["fingerprints"].get(fp, 0) + 1
                _session_rec["last_screenshot_img"] = img
                _session_rec["last_screenshot_hash"] = fp

            _session_add_event({
                "timestamp": time.time(),
                "type": "screenshot",
                "data": {"file": fname, "fingerprint": fp, "seq": seq[0]},
            })

            last_img[0] = img

        except Exception as e:
            print(f"  [session-rec] screenshot error: {e}")

        stop_event.wait(_SESSION_SCREENSHOT_INTERVAL)

    _session_rec["_screenshot_seq"] = seq[0]


def _session_title_thread(stop_event, window_title):
    """Background thread: track foreground window title changes."""
    last_title = [""]

    while not stop_event.is_set():
        try:
            current_title = ""
            try:
                import ctypes
                hwnd = ctypes.windll.user32.GetForegroundWindow()
                length = ctypes.windll.user32.GetWindowTextLengthW(hwnd)
                if length > 0:
                    buf = ctypes.create_unicode_buffer(length + 1)
                    ctypes.windll.user32.GetWindowTextW(hwnd, buf, length + 1)
                    current_title = buf.value
            except Exception:
                try:
                    fw = gw.getActiveWindow()
                    current_title = fw.title if fw else ""
                except Exception:
                    pass

            if current_title and current_title != last_title[0]:
                now = time.time()
                _session_add_event({
                    "timestamp": now,
                    "type": "title_change",
                    "data": {"old": last_title[0], "new": current_title},
                })
                lock = _session_rec.get("event_lock")
                entry = {"timestamp": now, "title": current_title}
                if lock:
                    with lock:
                        _session_rec["title_history"].append(entry)
                else:
                    _session_rec["title_history"].append(entry)
                last_title[0] = current_title

        except Exception:
            pass

        stop_event.wait(0.5)


def _session_start_input_listeners(stop_event, session_dir, window_title):
    """Start pynput keyboard+mouse listeners for event capture."""
    listeners = []

    try:
        from pynput import mouse as pm, keyboard as pk
    except ImportError:
        print("  [session-rec] pynput not installed — input capture disabled. pip install pynput")
        return listeners

    screenshot_seq_ref = [0]

    def on_click(x, y, button, pressed):
        if not pressed:
            return
        if stop_event.is_set():
            return False
        now = time.time()
        _session_add_event({
            "timestamp": now,
            "type": "click",
            "data": {"x": x, "y": y, "button": str(button)},
        })
        try:
            img, win = _session_grab_window(window_title)
            if img:
                screenshot_seq_ref[0] += 1
                seq = _session_rec.get("_screenshot_seq", 0) + screenshot_seq_ref[0] + 10000
                win_obj_left = win.left if win else 0
                win_obj_top = win.top if win else 0
                rel_x = x - win_obj_left
                rel_y = y - win_obj_top
                img_w, img_h = img.size
                if 0 <= rel_x < img_w and 0 <= rel_y < img_h:
                    fname = _session_save_screenshot(
                        session_dir, img.copy(), seq,
                        annotation={"x": rel_x, "y": rel_y}
                    )
                    crop_fname = _session_save_crop(session_dir, img, rel_x, rel_y, seq)
                    _session_add_event({
                        "timestamp": now,
                        "type": "click_screenshot",
                        "data": {
                            "file": fname, "crop": crop_fname,
                            "x": x, "y": y, "rel_x": rel_x, "rel_y": rel_y,
                        },
                    })
        except Exception as e:
            print(f"  [session-rec] click screenshot error: {e}")

    significant_keys = set()
    try:
        for kname in ["enter", "tab", "esc", "backspace", "delete", "space",
                       "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8",
                       "f9", "f10", "f11", "f12", "home", "end",
                       "page_up", "page_down", "insert"]:
            try:
                significant_keys.add(getattr(pk.Key, kname))
            except AttributeError:
                pass
    except Exception:
        pass

    typing_buf = []
    typing_lock = threading.Lock()
    last_type_time = [0.0]

    def flush_typing():
        with typing_lock:
            if typing_buf:
                text = "".join(typing_buf)
                typing_buf.clear()
                _session_add_event({
                    "timestamp": last_type_time[0],
                    "type": "typing",
                    "data": {"text": text},
                })

    active_modifiers = set()

    def on_press(key):
        if stop_event.is_set():
            return False
        now = time.time()

        try:
            if key in (pk.Key.ctrl_l, pk.Key.ctrl_r, pk.Key.alt_l, pk.Key.alt_r,
                        pk.Key.shift_l, pk.Key.shift_r, pk.Key.cmd, pk.Key.cmd_r):
                active_modifiers.add(key)
                return
        except Exception:
            pass

        is_sig = key in significant_keys
        has_modifier = len(active_modifiers) > 0
        is_ctrl_combo = has_modifier and hasattr(key, 'char') and key.char

        if is_sig or is_ctrl_combo:
            flush_typing()
            if is_ctrl_combo:
                mod_names = []
                for m in active_modifiers:
                    try:
                        mod_names.append(m.name)
                    except Exception:
                        mod_names.append(str(m))
                key_desc = "+".join(mod_names) + "+" + (key.char if hasattr(key, 'char') and key.char else str(key))
            else:
                key_desc = key.name if hasattr(key, 'name') else str(key)
            ev = {
                "timestamp": now,
                "type": "key",
                "data": {"key": key_desc, "special": True, "modifiers": [str(m) for m in active_modifiers] if has_modifier else []},
            }
            _session_add_event(ev)
            try:
                img, win = _session_grab_window(window_title)
                if img:
                    screenshot_seq_ref[0] += 1
                    seq = _session_rec.get("_screenshot_seq", 0) + screenshot_seq_ref[0] + 20000
                    fname = _session_save_screenshot(session_dir, img.copy(), seq)
                    fp_region = _session_fingerprint_region(img)
                    fp = _session_phash(fp_region)
                    _session_add_event({
                        "timestamp": now,
                        "type": "key_screenshot",
                        "data": {"file": fname, "fingerprint": fp, "key": key_desc},
                    })
            except Exception:
                pass
        elif hasattr(key, 'char') and key.char:
            with typing_lock:
                typing_buf.append(key.char)
                last_type_time[0] = now
        elif hasattr(key, 'vk') and key.vk:
            flush_typing()
            _session_add_event({
                "timestamp": now,
                "type": "key",
                "data": {"key": str(key), "special": False},
            })

    def on_release(key):
        try:
            active_modifiers.discard(key)
        except Exception:
            pass

    mouse_l = pm.Listener(on_click=on_click)
    key_l = pk.Listener(on_press=on_press, on_release=on_release)
    mouse_l.daemon = True
    key_l.daemon = True
    mouse_l.start()
    key_l.start()
    listeners.extend([mouse_l, key_l])
    _session_rec["_flush_typing"] = flush_typing
    print(f"  [session-rec] Input listeners started (mouse + keyboard)")
    return listeners


def _session_post_process(session_dir, session_id, window_title, events, fingerprints, title_history):
    """Post-process a recording session: build transition graph, upload summary."""
    unique_screens = {}
    for fp, count in fingerprints.items():
        unique_screens[fp] = {"fingerprint": fp, "count": count, "titles": set()}

    screenshot_events = [e for e in events if e["type"] in ("screenshot", "click_screenshot", "key_screenshot")]
    click_screenshot_events = [e for e in events if e["type"] == "click_screenshot"]
    key_screenshot_events = [e for e in events if e["type"] == "key_screenshot"]

    fp_title_map = {}
    title_idx = 0
    sorted_titles = sorted(title_history, key=lambda x: x.get("timestamp", 0))
    for se in screenshot_events:
        se_ts = se["timestamp"]
        while title_idx < len(sorted_titles) - 1 and sorted_titles[title_idx + 1]["timestamp"] <= se_ts:
            title_idx += 1
        current_title = sorted_titles[title_idx]["title"] if title_idx < len(sorted_titles) else ""
        fp = se["data"].get("fingerprint", "")
        if fp and fp in unique_screens:
            unique_screens[fp]["titles"].add(current_title)
        if fp and current_title:
            if fp not in fp_title_map:
                fp_title_map[fp] = set()
            fp_title_map[fp].add(current_title)

    for fp in unique_screens:
        unique_screens[fp]["titles"] = list(unique_screens[fp]["titles"])

    transitions = []
    click_events = [e for e in events if e["type"] == "click"]
    title_events = [e for e in events if e["type"] == "title_change"]

    for i, tc in enumerate(title_events):
        prev_title = tc["data"].get("old", "")
        new_title = tc["data"].get("new", "")
        ts = tc["timestamp"]
        trigger_click = None
        trigger_click_ts = 0
        label_crop = None
        prev_screenshot = None
        after_screenshot = None
        for ce in reversed(click_events):
            if ce["timestamp"] < ts and ts - ce["timestamp"] < 5.0:
                trigger_click = ce["data"]
                trigger_click_ts = ce["timestamp"]
                for cse in reversed(click_screenshot_events):
                    if abs(cse["timestamp"] - ce["timestamp"]) < 1.0:
                        label_crop = cse["data"].get("crop", "")
                        prev_screenshot = cse["data"].get("file", "")
                        break
                break
        trigger_key = None
        key_events_list = [e for e in events if e["type"] == "key"]
        for ke in reversed(key_events_list):
            if ke["timestamp"] < ts and ts - ke["timestamp"] < 3.0:
                trigger_key = ke["data"]
                for kse in reversed(key_screenshot_events):
                    if abs(kse["timestamp"] - ke["timestamp"]) < 1.0:
                        prev_screenshot = prev_screenshot or kse["data"].get("file", "")
                        break
                break

        prev_fp = None
        for se in reversed(screenshot_events):
            if se["timestamp"] < ts:
                prev_fp = se["data"].get("fingerprint", "")
                if not prev_screenshot:
                    prev_screenshot = se["data"].get("file", "")
                break
        after_fp = None
        for se in screenshot_events:
            if se["timestamp"] > ts:
                after_fp = se["data"].get("fingerprint", "")
                after_screenshot = se["data"].get("file", "")
                break

        transition_ms = 0
        if trigger_click and trigger_click_ts > 0:
            transition_ms = int((ts - trigger_click_ts) * 1000)

        transitions.append({
            "from_title": prev_title,
            "to_title": new_title,
            "timestamp": ts,
            "trigger_click": trigger_click,
            "trigger_key": trigger_key,
            "from_fingerprint": prev_fp,
            "to_fingerprint": after_fp,
            "transition_ms": transition_ms,
            "label_crop": label_crop,
            "prev_screenshot": prev_screenshot,
            "after_screenshot": after_screenshot,
        })

    fp_title_serializable = {fp: list(titles) for fp, titles in fp_title_map.items()}

    summary = {
        "session_id": session_id,
        "window_title": window_title,
        "start_time": _session_rec["start_time"],
        "end_time": time.time(),
        "duration_s": int(time.time() - _session_rec["start_time"]),
        "event_count": len(events),
        "screenshot_count": _session_rec["screenshot_count"],
        "unique_screens": len(unique_screens),
        "transitions": transitions,
        "title_history": title_history,
        "fingerprints": {fp: d["count"] for fp, d in unique_screens.items()},
        "fingerprint_titles": fp_title_serializable,
        "click_count": len(click_events),
        "key_count": len([e for e in events if e["type"] == "key"]),
    }

    timeline_path = os.path.join(session_dir, "timeline.json")
    try:
        with open(timeline_path, "w") as f:
            json.dump({"summary": summary, "events": events}, f, indent=1)
        print(f"  [session-rec] Timeline saved: {timeline_path}")
    except Exception as e:
        print(f"  [session-rec] Timeline save error: {e}")

    try:
        _bridge_request(
            "post", "/api/sessions/upload", "session-upload", timeout=30,
            headers={
                "Authorization": f"Bearer {BRIDGE_TOKEN}",
                "Content-Type": "application/json",
            },
            json=summary,
        )
        print(f"  [session-rec] Summary uploaded to server")
    except Exception as e:
        print(f"  [session-rec] Upload failed (summary saved locally): {e}")

    return summary


def execute_record_session_start(cmd):
    """Start universal session recording for any window."""
    window_title = cmd.get("window", "")
    command_id = cmd.get("id", "unknown")

    if _session_rec["active"]:
        post_result(command_id, "error",
                    error=f"Session already recording: {_session_rec['window_title']}")
        return

    if not window_title:
        post_result(command_id, "error", error="Missing window title. Usage: record-session start <window title>")
        return

    img, win = _session_grab_window(window_title)
    if img is None:
        post_result(command_id, "error", error=f"No window matching '{window_title}'")
        return

    actual_title = win.title if win else window_title

    session_id = f"sess_{int(time.time())}_{random.randint(1000,9999)}"
    os.makedirs(_SESSION_DIR_BASE, exist_ok=True)
    session_dir = os.path.join(_SESSION_DIR_BASE, session_id)
    os.makedirs(session_dir, exist_ok=True)

    stop_event = threading.Event()

    _session_rec.update({
        "active": True,
        "window_title": actual_title,
        "session_id": session_id,
        "session_dir": session_dir,
        "start_time": time.time(),
        "stop_event": stop_event,
        "events": [],
        "event_lock": threading.Lock(),
        "screenshot_count": 0,
        "event_count": 0,
        "listeners": [],
        "threads": [],
        "last_screenshot_hash": None,
        "last_screenshot_img": None,
        "fingerprints": {},
        "title_history": [{"timestamp": time.time(), "title": actual_title}],
        "_screenshot_seq": 0,
    })

    ss_thread = threading.Thread(
        target=_session_screenshot_thread,
        args=(stop_event, actual_title, session_dir),
        daemon=True, name="session-screenshot"
    )
    title_thread = threading.Thread(
        target=_session_title_thread,
        args=(stop_event, actual_title),
        daemon=True, name="session-title"
    )
    ss_thread.start()
    title_thread.start()
    _session_rec["threads"] = [ss_thread, title_thread]

    listeners = _session_start_input_listeners(stop_event, session_dir, actual_title)
    _session_rec["listeners"] = listeners

    if not listeners:
        _session_rec["_input_degraded"] = True
        print(f"  [session-rec] WARNING: Input capture unavailable (pynput missing)")
        print(f"  [session-rec]   Screenshots and title tracking still active")
        print(f"  [session-rec]   Install pynput for full capture: pip install pynput")
    else:
        _session_rec["_input_degraded"] = False

    print(f"  [session-rec] Recording started: {actual_title}")
    print(f"  [session-rec] Session ID: {session_id}")
    print(f"  [session-rec] Session dir: {session_dir}")

    post_result(command_id, "complete", data={
        "recording": True,
        "window": actual_title,
        "sessionId": session_id,
        "inputCapture": not _session_rec.get("_input_degraded", False),
    })


def execute_record_session_stop(cmd):
    """Stop universal session recording and post-process."""
    command_id = cmd.get("id", "unknown")

    if not _session_rec["active"]:
        post_result(command_id, "error", error="No active session recording")
        return

    print(f"  [session-rec] Stopping recording...")

    flush_fn = _session_rec.get("_flush_typing")
    if callable(flush_fn):
        try:
            flush_fn()
        except Exception:
            pass

    _session_rec["active"] = False
    stop_event = _session_rec.get("stop_event")
    if stop_event:
        stop_event.set()

    for listener in _session_rec.get("listeners", []):
        try:
            listener.stop()
        except Exception:
            pass

    for thread in _session_rec.get("threads", []):
        try:
            thread.join(timeout=3)
        except Exception:
            pass

    events = list(_session_rec["events"])
    fingerprints = dict(_session_rec["fingerprints"])
    title_history = list(_session_rec["title_history"])
    session_id = _session_rec["session_id"]
    session_dir = _session_rec["session_dir"]
    window_title = _session_rec["window_title"]

    summary = _session_post_process(
        session_dir, session_id, window_title,
        events, fingerprints, title_history
    )

    print(f"  [session-rec] Recording stopped. {summary['event_count']} events, "
          f"{summary['screenshot_count']} screenshots, {summary['unique_screens']} unique screens, "
          f"{len(summary['transitions'])} transitions in {summary['duration_s']}s")

    post_result(command_id, "complete", data=summary)


def execute_record_session_status(cmd):
    """Get status of current session recording."""
    command_id = cmd.get("id", "unknown")

    if not _session_rec["active"]:
        sessions_list = []
        if os.path.isdir(_SESSION_DIR_BASE):
            for d in sorted(os.listdir(_SESSION_DIR_BASE), reverse=True)[:10]:
                timeline_path = os.path.join(_SESSION_DIR_BASE, d, "timeline.json")
                if os.path.exists(timeline_path):
                    try:
                        with open(timeline_path, "r") as f:
                            data = json.load(f)
                        s = data.get("summary", {})
                        sessions_list.append({
                            "session_id": s.get("session_id", d),
                            "window_title": s.get("window_title", ""),
                            "duration_s": s.get("duration_s", 0),
                            "event_count": s.get("event_count", 0),
                            "screenshot_count": s.get("screenshot_count", 0),
                            "transitions": len(s.get("transitions", [])),
                        })
                    except Exception:
                        pass
        post_result(command_id, "complete", data={
            "active": False,
            "sessions": sessions_list,
        })
        return

    elapsed = int(time.time() - _session_rec["start_time"])
    post_result(command_id, "complete", data={
        "active": True,
        "window": _session_rec["window_title"],
        "sessionId": _session_rec["session_id"],
        "elapsed_s": elapsed,
        "event_count": _session_rec["event_count"],
        "screenshot_count": _session_rec["screenshot_count"],
        "unique_screens": len(_session_rec["fingerprints"]),
        "title_changes": len(_session_rec["title_history"]),
    })


def _session_cross_session_patterns(window_title):
    """Analyze multiple sessions for the same window to find repeated patterns."""
    if not os.path.isdir(_SESSION_DIR_BASE):
        return []

    all_transitions = []
    for d in sorted(os.listdir(_SESSION_DIR_BASE)):
        timeline_path = os.path.join(_SESSION_DIR_BASE, d, "timeline.json")
        if not os.path.exists(timeline_path):
            continue
        try:
            with open(timeline_path, "r") as f:
                data = json.load(f)
            s = data.get("summary", {})
            if window_title.lower() not in s.get("window_title", "").lower():
                continue
            transitions = s.get("transitions", [])
            seq = [(t["from_title"], t["to_title"]) for t in transitions if t.get("from_title") and t.get("to_title")]
            all_transitions.append(seq)
        except Exception:
            continue

    if len(all_transitions) < 2:
        return []

    pair_counts = {}
    for seq in all_transitions:
        seen_in_session = set()
        for pair in seq:
            if pair not in seen_in_session:
                seen_in_session.add(pair)
                pair_counts[pair] = pair_counts.get(pair, 0) + 1

    patterns = []
    for (from_t, to_t), count in sorted(pair_counts.items(), key=lambda x: -x[1]):
        if count >= 2:
            patterns.append({
                "from": from_t,
                "to": to_t,
                "frequency": count,
                "sessions_total": len(all_transitions),
                "confidence": round(count / len(all_transitions), 2),
            })

    return patterns[:50]


def find_window_by_hwnd(hwnd):
    for w in gw.getAllWindows():
        if getattr(w, '_hWnd', None) == hwnd:
            return w
    return None


def find_window(env, client=None):
    """Find a window for the given env, optionally filtered by client type."""
    env_upper = env.upper()
    if client == "text":
        return find_text_window(env_upper)
    if client == "hyperspace":
        return find_hyperspace_window(env_upper)
    w = find_hyperspace_window(env_upper)
    if w:
        return w
    return find_text_window(env_upper)


def find_hyperspace_window(env_upper):
    for w in gw.getAllWindows():
        title = w.title or ""
        t = title.upper()
        if env_upper in t and ("HYPERSPACE" in t or "EPIC" in t or "HYPERDRIVE" in t):
            return w
    for w in gw.getAllWindows():
        title = w.title or ""
        if env_upper in title.upper() and w.width > 400 and w.height > 300:
            t = title.upper()
            if "TEXT" not in t and "TERMINAL" not in t and "SESSION" not in t:
                return w
    return None


def find_text_window(env_upper):
    HYPERSPACE_KEYWORDS = ("HYPERSPACE", "EPIC", "HYPERDRIVE")
    for w in gw.getAllWindows():
        title = w.title or ""
        t = title.upper()
        if env_upper in t and ("TEXT" in t or "TERMINAL" in t or "SESSION" in t or "CACHE" in t):
            return w
    for w in gw.getAllWindows():
        title = w.title or ""
        t = title.upper()
        if env_upper in t and ("EXCEED" in t or "PUTTY" in t or "TERATERM" in t or "REFLECTION" in t or "ATTACHMATE" in t):
            return w
    for w in gw.getAllWindows():
        title = w.title or ""
        t = title.upper().strip()
        if t == env_upper or (env_upper in t and not any(kw in t for kw in HYPERSPACE_KEYWORDS) and w.width > 100 and w.height > 100):
            if "COMPONENT DETAILS" not in t:
                return w
    return None


def activate_window(window, maximize=False):
    """Reliably bring a window to the foreground.

    Windows restricts SetForegroundWindow to prevent focus-stealing.
    pygetwindow's activate() silently fails when the calling process
    doesn't own the foreground. We use AttachThreadInput to temporarily
    attach our thread to the foreground window's thread, which bypasses
    the restriction.

    If maximize=True, the window is maximized to fill the screen so all
    UI elements (like the Epic button) are visible.
    """
    try:
        if hasattr(window, 'isMinimized') and window.isMinimized:
            window.restore()
            time.sleep(0.2)
    except Exception:
        pass
    try:
        kernel32 = ctypes.windll.kernel32
        user32 = ctypes.windll.user32
        hwnd = window._hWnd
        foreground_hwnd = user32.GetForegroundWindow()
        current_thread = kernel32.GetCurrentThreadId()
        fg_thread = user32.GetWindowThreadProcessId(foreground_hwnd, None)
        attached = False
        try:
            if current_thread != fg_thread:
                attached = bool(user32.AttachThreadInput(current_thread, fg_thread, True))
            if maximize:
                user32.ShowWindow(hwnd, 3)
            else:
                user32.BringWindowToTop(hwnd)
                user32.ShowWindow(hwnd, 9)
            result = user32.SetForegroundWindow(hwnd)
            if not result:
                print(f"  [focus] SetForegroundWindow failed for hwnd={hwnd}, falling back")
                window.activate()
        finally:
            if attached:
                user32.AttachThreadInput(current_thread, fg_thread, False)
    except Exception:
        try:
            window.activate()
        except Exception:
            pass
    if maximize:
        time.sleep(0.3)
        try:
            user32 = ctypes.windll.user32
            user32.ShowWindow(window._hWnd, 3)
        except Exception:
            try:
                window.maximize()
            except Exception:
                pass
        time.sleep(0.3)


def get_dpi_scale():
    """Get the DPI scaling factor for coordinate correction."""
    try:
        import ctypes
        hdc = ctypes.windll.user32.GetDC(0)
        dpi = ctypes.windll.gdi32.GetDeviceCaps(hdc, 88)
        ctypes.windll.user32.ReleaseDC(0, hdc)
        return dpi / 96.0
    except Exception:
        return 1.0

DPI_SCALE = 1.0

MAX_SCREENSHOT_WIDTH = 1280
MAX_SCREENSHOT_HEIGHT = 800

def screenshot_window(window):
    """Capture window screenshot, auto-downscale to <=1280x800 for vision accuracy.

    Anthropic best practice: 'Do not send screenshots above XGA/WXGA resolution.
    Higher resolutions degrade model accuracy. Scale down and map coordinates back.'
    OpenAI best practice: 'Use 1440x900 or 1600x900. Use detail:original.'

    We capture at native resolution for coordinate precision, then downscale to
    1280x800 max. vision_to_screen() maps coordinates back using DPI_SCALE and
    the screenshot_scale factor.
    """
    global DPI_SCALE
    activate_window(window)
    time.sleep(0.3)
    bbox = (window.left, window.top, window.left + window.width, window.top + window.height)
    img = ImageGrab.grab(bbox=bbox, include_layered_windows=True)
    win_w = window.width
    img_w, img_h = img.size
    if win_w > 0 and img_w > 0 and abs(img_w - win_w) > 10:
        DPI_SCALE = img_w / win_w
        print(f"  [dpi] Detected DPI scale: {DPI_SCALE:.2f} (image={img_w}px, window={win_w}px)")

    global SCREENSHOT_SCALE_RATIO
    if img_w > MAX_SCREENSHOT_WIDTH or img_h > MAX_SCREENSHOT_HEIGHT:
        ratio = min(MAX_SCREENSHOT_WIDTH / img_w, MAX_SCREENSHOT_HEIGHT / img_h)
        new_w = int(img_w * ratio)
        new_h = int(img_h * ratio)
        img = img.resize((new_w, new_h), resample=1)
        SCREENSHOT_SCALE_RATIO = ratio
    else:
        SCREENSHOT_SCALE_RATIO = 1.0

    return img


def img_to_base64(img, use_jpeg=False):
    buf = io.BytesIO()
    if use_jpeg:
        img.save(buf, format="JPEG", quality=80)
    else:
        img.save(buf, format="PNG", compress_level=6)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


SCREENSHOT_SCALE_RATIO = 1.0

def vision_to_screen(window, img_x, img_y):
    """Convert vision AI pixel coords (relative to downscaled image) to absolute screen coords.

    Pipeline: vision coords (downscaled image space)
      -> original image space (divide by screenshot scale ratio)
      -> screen space (divide by DPI scale, add window offset)

    Anthropic: 'Scale the image down, let the model interact with scaled version,
    map coordinates back to original resolution proportionally.'
    """
    real_img_x = img_x / SCREENSHOT_SCALE_RATIO if SCREENSHOT_SCALE_RATIO != 1.0 else img_x
    real_img_y = img_y / SCREENSHOT_SCALE_RATIO if SCREENSHOT_SCALE_RATIO != 1.0 else img_y

    screen_x = window.left + int(real_img_x / DPI_SCALE)
    screen_y = window.top + int(real_img_y / DPI_SCALE)
    return screen_x, screen_y


def ask_claude(screenshot_b64, prompt, max_retries=3, image_format="png"):
    if not OPENROUTER_API_KEY:
        return None
    mime = "image/jpeg" if image_format == "jpeg" else "image/png"
    base_delay = 1.0
    max_delay = 60.0
    for attempt in range(max_retries + 1):
        try:
            resp = requests.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": MODEL,
                    "messages": [
                        {
                            "role": "user",
                            "content": [
                                {
                                    "type": "image_url",
                                    "image_url": {"url": f"data:{mime};base64,{screenshot_b64}"},
                                },
                                {"type": "text", "text": prompt},
                            ],
                        }
                    ],
                    "max_tokens": 4096,
                },
                timeout=60,
            )
            if resp.status_code == 200:
                return resp.json()["choices"][0]["message"]["content"]
            detail = ""
            try:
                detail = resp.json().get("error", {}).get("message", resp.text[:200])
            except Exception:
                detail = resp.text[:200]
            if resp.status_code == 429 or resp.status_code >= 500:
                retry_after = resp.headers.get("Retry-After")
                wait = None
                if retry_after:
                    try:
                        wait = float(retry_after)
                    except (ValueError, TypeError):
                        try:
                            from email.utils import parsedate_to_datetime
                            retry_dt = parsedate_to_datetime(retry_after)
                            wait = max(0, (retry_dt - __import__('datetime').datetime.now(retry_dt.tzinfo)).total_seconds())
                        except Exception:
                            wait = None
                if wait is None:
                    backoff = min(base_delay * (2 ** attempt), max_delay)
                    wait = backoff + random.uniform(0, backoff * 0.25)
                if attempt < max_retries:
                    print(f"  Claude API {resp.status_code} (attempt {attempt + 1}/{max_retries + 1}) - retrying in {wait:.1f}s: {detail}")
                    time.sleep(wait)
                    continue
            print(f"  Claude API error: {resp.status_code} - {detail}")
            if resp.status_code == 401:
                print(f"  -> Check your OPENROUTER_API_KEY environment variable. It may be expired or invalid.")
                print(f"  -> Key starts with: {OPENROUTER_API_KEY[:8]}..." if len(OPENROUTER_API_KEY) > 8 else "  -> Key appears empty or too short")
            return None
        except requests.exceptions.RequestException as e:
            if attempt < max_retries:
                backoff = min(base_delay * (2 ** attempt), max_delay)
                wait = backoff + random.uniform(0, backoff * 0.25)
                print(f"  Claude network error (attempt {attempt + 1}/{max_retries + 1}) - retrying in {wait:.1f}s: {e}")
                time.sleep(wait)
                continue
            print(f"  Claude error after {max_retries + 1} attempts: {e}")
            return None
        except Exception as e:
            print(f"  Claude error: {e}")
            return None
    return None


def _extract_json_object(text):
    """Extract the first complete JSON object from text, handling nested braces."""
    start = text.find('{')
    if start == -1:
        return None
    depth = 0
    in_string = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if escape:
            escape = False
            continue
        if ch == '\\' and in_string:
            escape = True
            continue
        if ch == '"' and not escape:
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(text[start:i + 1])
                except json.JSONDecodeError:
                    return None
    return None


def _bridge_request(method, path, label, timeout=10, max_retries=2, **kwargs):
    base_delay = 0.5
    for attempt in range(max_retries + 1):
        try:
            resp = getattr(requests, method)(
                f"{ORGCLOUD_URL}{path}",
                timeout=timeout,
                **kwargs,
            )
            if resp.status_code >= 500 and attempt < max_retries:
                wait = base_delay * (2 ** attempt) + random.uniform(0, 0.5)
                print(f"  [{label}] HTTP {resp.status_code} (attempt {attempt + 1}/{max_retries + 1}) - retrying in {wait:.1f}s")
                time.sleep(wait)
                continue
            return resp
        except (requests.exceptions.Timeout, requests.exceptions.ConnectionError) as e:
            if attempt < max_retries:
                wait = base_delay * (2 ** attempt) + random.uniform(0, 0.5)
                print(f"  [{label}] Network error (attempt {attempt + 1}/{max_retries + 1}) - retrying in {wait:.1f}s: {e}")
                time.sleep(wait)
                continue
            print(f"  [{label}] Failed after {max_retries + 1} attempts: {e}")
            return None
        except Exception as e:
            print(f"  [{label}] Error: {e}")
            return None
    return None


def _read_search_bar(window):
    """Module-level helper: read search bar text via vision."""
    img = screenshot_window(window)
    b64 = img_to_base64(img)
    if not b64:
        return None
    prompt = (
        "Look at this Epic Hyperspace screen. "
        "Is the search bar at the top ACTIVATED/FOCUSED? "
        "An ACTIVATED search bar has TWO key visual indicators: "
        "(1) It has a BLUE BORDER/OUTLINE around it, and "
        "(2) It is horizontally MUCH WIDER/LONGER than its resting state. "
        "If an activated search bar is visible, read the EXACT text typed in it. "
        "Return ONLY: {\"visible\": true/false, \"text\": \"exact contents or empty string\"}"
    )
    resp_text = ask_claude(b64, prompt)
    if not resp_text:
        return None
    try:
        m = re.search(r'\{[\s\S]*?\}', resp_text)
        if m:
            return json.loads(m.group())
    except Exception:
        pass
    return None


_cached_clear_method = None


def adaptive_clear_search_bar(window, open_search_fn=None):
    """Module-level adaptive clear: tries multiple strategies to empty the search bar.
    Verifies via vision after each attempt. Caches the first working method.
    Returns True if bar is confirmed empty.
    If open_search_fn is provided, uses it for escape+reopen strategy."""
    global _cached_clear_method

    def _do_end_bksp():
        pyautogui.press("end")
        time.sleep(0.05)
        for _ in range(50):
            pyautogui.press("backspace")

    def _do_home_shift_end_bksp():
        pyautogui.press("home")
        time.sleep(0.05)
        pyautogui.keyDown("shift")
        time.sleep(0.05)
        pyautogui.press("end")
        time.sleep(0.05)
        pyautogui.keyUp("shift")
        time.sleep(0.05)
        pyautogui.press("backspace")

    def _do_escape_reopen():
        pyautogui.press("escape")
        time.sleep(0.4)
        if open_search_fn:
            open_search_fn()
        else:
            sendinput_hotkey("ctrl", "space")
        time.sleep(0.5)

    def _do_50x_delete():
        pyautogui.press("home")
        time.sleep(0.05)
        for _ in range(50):
            pyautogui.press("delete")

    all_approaches = [
        ("end+backspace", _do_end_bksp),
        ("home+shift_end+bksp", _do_home_shift_end_bksp),
        ("escape+reopen", _do_escape_reopen),
        ("50x_delete", _do_50x_delete),
    ]

    if _cached_clear_method:
        cached = [(n, fn) for n, fn in all_approaches if n == _cached_clear_method]
        rest = [(n, fn) for n, fn in all_approaches if n != _cached_clear_method]
        approaches = cached + rest
    else:
        approaches = all_approaches

    for name, fn in approaches:
        fn()
        time.sleep(0.3)
        state = _read_search_bar(window)
        if state is None:
            continue
        if not state.get("visible", False):
            if name == "escape+reopen":
                print(f"  [clear] {name}: bar not visible after reopen — trying next")
            else:
                print(f"  [clear] {name}: bar closed — trying next")
            continue
        bar_text = state.get("text", "").strip()
        if len(bar_text) == 0:
            print(f"  [clear] Bar cleared via {name}")
            if _cached_clear_method != name:
                _cached_clear_method = name
                print(f"  [clear] Cached clear method: {name}")
            return True
        print(f"  [clear] {name} didn't clear (still: '{bar_text}'), trying next...")
    print(f"  [clear] WARNING: All clear methods failed")
    return False


def fast_clear_search_bar():
    """Quick clear using End+Backspace (no vision verification).
    Used in hot loops to avoid API calls."""
    pyautogui.press("end")
    time.sleep(0.05)
    for _ in range(50):
        pyautogui.press("backspace")
    time.sleep(0.1)


def poll_commands():
    resp = _bridge_request(
        "get", "/api/epic/agent/commands", "poll", timeout=10,
        headers={
            "Authorization": f"Bearer {BRIDGE_TOKEN}",
            "X-Agent-Type": "epic-desktop",
        },
    )
    if resp and resp.status_code == 200:
        data = resp.json()
        return data.get("commands", [])
    elif resp:
        print(f"  [poll] HTTP {resp.status_code}: {resp.text[:200]}")
    return []


def _drain_all_stream_data():
    stream_data = []
    with _always_on_lock:
        cap_keys = list(_ALWAYS_ON_CAPTURES.keys())
    for key in cap_keys:
        with _always_on_lock:
            cap = _ALWAYS_ON_CAPTURES.get(key)
        if not cap or not cap["active"]:
            continue
        with cap["pending_lock"]:
            transitions = list(cap["pending_transitions"])
            fingerprints = dict(cap["pending_fingerprints"])
            cap["pending_transitions"] = []
            cap["pending_fingerprints"] = {}

        with _SCREEN_LABEL_LOCK:
            for fp_key in list(cap["fingerprints"].keys()):
                if fp_key in _SCREEN_LABELS:
                    label = _SCREEN_LABELS[fp_key]
                    if fp_key not in fingerprints:
                        fingerprints[fp_key] = {"count": 0, "titles": []}
                    if label not in fingerprints[fp_key]["titles"]:
                        fingerprints[fp_key]["titles"].insert(0, label)
        with _SCREEN_CONTEXT_LOCK:
            for fp_key in list(cap["fingerprints"].keys()):
                if fp_key in _SCREEN_CONTEXTS:
                    if fp_key not in fingerprints:
                        fingerprints[fp_key] = {"count": 0, "titles": []}
                    fingerprints[fp_key]["context"] = _SCREEN_CONTEXTS[fp_key]

        transitions = [t for t in transitions if (t.get("from_fingerprint") or t.get("from_fp", "")) != (t.get("to_fingerprint") or t.get("to_fp", ""))]

        if not transitions and not fingerprints:
            continue
        stream_data.append({
            "windowKey": cap["window_key"],
            "windowTitle": cap["window_title"],
            "sessionId": cap["session_id"],
            "transitions": transitions,
            "fingerprints": fingerprints,
        })
    return stream_data


def send_heartbeat(windows_found):
    capture_state = _always_on_get_capture_state()
    stream_data = _drain_all_stream_data()
    payload = {
        "windows": windows_found,
        "timestamp": time.time(),
        "capture": capture_state if capture_state else None,
    }
    if stream_data:
        payload["streamData"] = stream_data
    resp = _bridge_request(
        "post", "/api/epic/agent/heartbeat", "heartbeat", timeout=15,
        headers={
            "Authorization": f"Bearer {BRIDGE_TOKEN}",
            "Content-Type": "application/json",
        },
        json=payload,
    )
    if resp and resp.status_code == 200:
        rdata = resp.json()
        results = rdata.get("streamResults", [])
        for r in results:
            if r.get("ok"):
                wk = (r.get("windowKey") or "?")[:28]
                print(f"  [heartbeat] tree updated {wk}: {r.get('treeNodes', 0)}n/{r.get('treeEdges', 0)}e")
            else:
                print(f"  [heartbeat] tree error: {r.get('error', '?')}")
    elif resp:
        print(f"  [heartbeat] HTTP {resp.status_code}: {resp.text[:200]}")


def post_result(command_id, status, screenshot_b64=None, data=None, error=None):
    body = {
        "commandId": command_id,
        "status": status,
    }
    if screenshot_b64:
        body["screenshot"] = screenshot_b64
    if data:
        body["data"] = data
    if error:
        body["error"] = error
    resp = _bridge_request(
        "post", "/api/epic/agent/results", "result", timeout=30, max_retries=3,
        headers={
            "Authorization": f"Bearer {BRIDGE_TOKEN}",
            "Content-Type": "application/json",
        },
        json=body,
    )
    if not resp:
        print(f"  Failed to post result for {command_id}")


def execute_navigate(cmd):
    env = cmd.get("env", "SUP")
    target = cmd.get("target", "")
    command_id = cmd.get("id", "unknown")

    print(f"  [nav] {env} -> {target}")

    window = find_window(env)
    if not window:
        post_result(command_id, "error", error=f"No {env} Hyperspace window found")
        return

    img = screenshot_window(window)
    b64 = img_to_base64(img)

    prompt = f"""You are controlling an Epic Hyperspace/Hyperdrive application window.
The user wants to navigate to: "{target}"

Look at the current screen and determine:
1. What is currently visible on screen
2. What clicks/actions are needed to navigate to "{target}"

Return a JSON object with:
{{
  "currentScreen": "description of what you see",
  "actions": [
    {{"type": "click", "description": "what to click", "x": <pixel_x>, "y": <pixel_y>}},
    {{"type": "type", "text": "text to type"}},
    {{"type": "key", "key": "keyname like enter, tab, escape"}},
    {{"type": "wait", "seconds": 1}},
    {{"type": "search", "text": "search term to type after Alt+Space"}}
  ],
  "confidence": "high/medium/low",
  "notes": "any relevant observations"
}}

{VISION_COORD_INSTRUCTION}
Coordinates should be relative to the screenshot image.
If you can see the target already on screen, just click it.
If you need to use Epic search (Alt+Space), use the "search" action type.
Return ONLY the JSON object."""

    response = ask_claude(b64, prompt)
    if not response:
        post_result(command_id, "error", error="Claude did not respond")
        return

    try:
        json_match = re.search(r'\{[\s\S]*\}', response)
        if not json_match:
            post_result(command_id, "error", error="Could not parse Claude response")
            return
        plan = json.loads(json_match.group())
    except json.JSONDecodeError:
        post_result(command_id, "error", error="Invalid JSON from Claude")
        return

    print(f"  [plan] {plan.get('currentScreen', 'unknown')}")
    print(f"  [plan] {len(plan.get('actions', []))} actions, confidence: {plan.get('confidence', '?')}")

    for i, action in enumerate(plan.get("actions", [])):
        act_type = action.get("type", "")
        print(f"  [action {i+1}] {act_type}: {action.get('description', action.get('text', action.get('key', '')))}")

        try:
            if act_type == "click":
                abs_x = window.left + action["x"]
                abs_y = window.top + action["y"]
                pyautogui.click(abs_x, abs_y)
                time.sleep(0.5)
            elif act_type == "type":
                pyautogui.typewrite(action["text"], interval=0.05)
                time.sleep(0.3)
            elif act_type == "key":
                key = action["key"].lower()
                if "+" in key:
                    parts = key.split("+")
                    pyautogui.hotkey(*parts)
                else:
                    pyautogui.press(key)
                time.sleep(0.3)
            elif act_type == "search":
                sendinput_hotkey("ctrl", "space")
                time.sleep(0.8)
                pyautogui.typewrite(action["text"], interval=0.05)
                time.sleep(1.0)
                pyautogui.press("enter")
                time.sleep(1.0)
            elif act_type == "wait":
                time.sleep(action.get("seconds", 1))
        except Exception as e:
            print(f"  [action error] {e}")

    time.sleep(1.0)
    final_img = screenshot_window(window)
    final_b64 = img_to_base64(final_img)

    post_result(command_id, "complete", screenshot_b64=final_b64, data={
        "currentScreen": plan.get("currentScreen", ""),
        "actionsExecuted": len(plan.get("actions", [])),
        "confidence": plan.get("confidence", "unknown"),
        "notes": plan.get("notes", ""),
    })
    print(f"  [done] Screenshot sent to OrgCloud")


def execute_screenshot(cmd):
    env = cmd.get("env", "SUP")
    command_id = cmd.get("id", "unknown")

    window = find_window(env)
    if not window:
        post_result(command_id, "error", error=f"No {env} window found")
        return

    img = screenshot_window(window)
    b64 = img_to_base64(img)

    prompt = EPIC_VISUAL_REFERENCE + """
TASK: Describe this Epic Hyperspace screen using the visual reference above.

Read each layer:
1. TITLE BAR (Layer 1): Is Ctrl+Space search active (red bar, blue search field)?
2. WORKSPACE TABS (Layer 3): What tabs are open? Which is active? Any patient name tabs?
3. ACTIVITY TABS (Layer 3b): If patient chart is open, which clinical activity tab is selected?
4. BREADCRUMB/TITLE (Layer 4): What record/screen title and any report sub-tabs?
5. LEFT SIDEBAR (Layer 5): Navigation categories visible? Which is selected?
6. WORKSPACE (Layer 6): Main content — dashboard reports, form, list, clinical data?
7. FLOATING: Epic menu open? Secure Chat? BPA alert? Ctrl+Space search active?

Return a JSON object:
{
  "screen": "breadcrumb/record title from Layer 4",
  "activeTab": "which workspace tab is selected (Layer 3)",
  "activityTab": "which patient chart activity tab if applicable (Layer 3b)",
  "area": "which Epic area (e.g., Home Dashboard, Radar Admin, Chart Review, Patient List, etc.)",
  "patientContext": true/false,
  "openTabs": ["list of all open workspace tabs"],
  "sidebarSection": "which sidebar item is highlighted (Layer 5)",
  "workspaceContent": "brief description of main content area",
  "availableActions": ["list", "of", "clickable", "items"],
  "floatingElements": ["any", "visible", "popups/alerts/menus"],
  "notes": "other observations"
}
Return ONLY the JSON object."""

    response = ask_claude(b64, prompt)
    data = {}
    if response:
        try:
            json_match = re.search(r'\{[\s\S]*\}', response)
            if json_match:
                data = json.loads(json_match.group())
        except Exception:
            data = {"raw": response[:500]}

    post_result(command_id, "complete", screenshot_b64=b64, data=data)
    print(f"  [screenshot] Sent for {env}")


def execute_scan(cmd):
    env = cmd.get("env", "SUP")
    command_id = cmd.get("id", "unknown")

    window = find_window(env)
    if not window:
        post_result(command_id, "error", error=f"No {env} window found")
        return

    img = screenshot_window(window)
    b64 = img_to_base64(img)

    prompt = """You are looking at an Epic Hyperspace/Hyperdrive application window.
Identify ALL visible menu items, buttons, tabs, navigation elements, toolbar items, and activity options.

For each item provide:
- name: the text label
- category: what section/menu/toolbar it belongs to
- type: "menu", "button", "tab", "activity", "link", or "toolbar"

Return a JSON array of objects. Be thorough - list every single visible clickable element.
Return ONLY the JSON array."""

    response = ask_claude(b64, prompt)
    activities = []
    if response:
        try:
            json_match = re.search(r'\[[\s\S]*\]', response)
            if json_match:
                activities = json.loads(json_match.group())
        except Exception:
            pass

    _bridge_request(
        "post", "/api/epic/activities", "activities-upload", timeout=30,
        headers={
            "Authorization": f"Bearer {BRIDGE_TOKEN}",
            "Content-Type": "application/json",
        },
        json={"environment": env, "activities": activities},
    )

    post_result(command_id, "complete", screenshot_b64=b64, data={
        "activitiesFound": len(activities),
        "activities": activities[:20],
    })
    print(f"  [scan] Found {len(activities)} activities for {env}")


def execute_click(cmd):
    env = cmd.get("env", "SUP")
    target = cmd.get("target", "")
    command_id = cmd.get("id", "unknown")

    window = find_window(env)
    if not window:
        post_result(command_id, "error", error=f"No {env} window found")
        return

    img = screenshot_window(window)
    b64 = img_to_base64(img)

    prompt = f"""Find the exact pixel coordinates of the UI element labeled "{target}" in this screenshot.
{VISION_COORD_INSTRUCTION}
Return ONLY a JSON object: {{"x": <number>, "y": <number>, "found": true}}
If you cannot find it, return: {{"found": false, "reason": "why not found"}}
Coordinates should be relative to the image."""

    response = ask_claude(b64, prompt)
    if not response:
        post_result(command_id, "error", error="Claude did not respond")
        return

    try:
        result = _extract_json_object(response)
        if not result:
            post_result(command_id, "error", error="Could not parse response")
            return
    except Exception:
        post_result(command_id, "error", error="Invalid JSON")
        return

    if not result.get("found", False):
        post_result(command_id, "error", error=f"Element not found: {result.get('reason', 'unknown')}")
        return

    abs_x, abs_y = vision_to_screen(window, result["x"], result["y"])
    safe_click(abs_x, abs_y, pause_after=0.8, label=f"{target} (vision_click)")

    final_img = screenshot_window(window)
    final_b64 = img_to_base64(final_img)
    post_result(command_id, "complete", screenshot_b64=final_b64, data={"clicked": target})
    print(f"  [click] Clicked '{target}' at ({result['x']}, {result['y']})")


def find_uia_element_by_name(parent, name):
    """Find a UI Automation element by name within parent, searching breadth-first."""
    try:
        from pywinauto import Desktop
    except ImportError:
        return None
    name_lower = name.lower().strip()
    try:
        for child in parent.children():
            try:
                child_name = (child.element_info.name or "").strip()
                if child_name.lower() == name_lower:
                    return child
            except Exception:
                continue
        for child in parent.children():
            try:
                found = find_uia_element_by_name(child, name)
                if found:
                    return found
            except Exception:
                continue
    except Exception:
        pass
    return None


def _iter_nodes(node):
    """Yield all nodes in a tree (depth-first) for counting."""
    yield node
    for child in node.get("children", []):
        yield from _iter_nodes(child)


def fetch_cached_tree(env, client="hyperspace"):
    """Fetch the saved Epic tree from the server (cached coordinates)."""
    resp = _bridge_request(
        "get", f"/api/epic/tree/{env.upper()}", "tree-cache", timeout=10,
        headers={"Authorization": f"Bearer {BRIDGE_TOKEN}"},
    )
    if resp and resp.status_code == 200:
        data = resp.json()
        trees = data.get("trees", {})
        return trees.get(client)
    return None


def find_node_in_tree(tree, steps):
    """Walk the tree to find the node matching the given path steps.
    Returns list of nodes for each step found."""
    if not tree or not steps:
        return []

    found_path = []
    current_children = tree.get("children", [])

    for step in steps:
        step_lower = step.lower().strip()
        match = None
        for child in current_children:
            child_name = (child.get("name", "")).lower().strip()
            if child_name == step_lower:
                match = child
                break
        if not match:
            for child in current_children:
                child_name = (child.get("name", "")).lower().strip()
                if step_lower in child_name or child_name in step_lower:
                    match = child
                    break
        if match:
            found_path.append(match)
            current_children = match.get("children", [])
        else:
            break

    return found_path


def compute_drift(tree, window):
    """Compute coordinate drift between when the tree was crawled and now.
    The tree stores image-space pixel coords. If the window size changed,
    the image dimensions changed too, so we need to scale the cached coords.

    Returns (scale_x, scale_y, confidence) where:
    - scale_x/y: multiply cached imgX/imgY by these to get current image coords
    - confidence: 'high' if geometry matches, 'medium' if small change, 'low' if big change
    """
    crawl_win_w = tree.get("windowWidth", 0)
    crawl_win_h = tree.get("windowHeight", 0)
    crawl_img_w = tree.get("imageWidth", 0)
    crawl_img_h = tree.get("imageHeight", 0)

    if crawl_img_w <= 0 or crawl_img_h <= 0:
        return 1.0, 1.0, "unknown"

    current_img = screenshot_window(window)
    cur_w, cur_h = current_img.size

    scale_x = cur_w / crawl_img_w
    scale_y = cur_h / crawl_img_h

    drift_pct = max(abs(1.0 - scale_x), abs(1.0 - scale_y)) * 100

    if drift_pct < 1:
        confidence = "high"
    elif drift_pct < 10:
        confidence = "medium"
    else:
        confidence = "low"

    if drift_pct > 0.5:
        print(f"  [drift] Window geometry changed: crawl image was {crawl_img_w}x{crawl_img_h}, now {cur_w}x{cur_h}")
        print(f"  [drift] Scale factors: x={scale_x:.3f} y={scale_y:.3f} (drift={drift_pct:.1f}%, confidence={confidence})")

    return scale_x, scale_y, confidence


def vision_find_on_screen(window, item_name):
    """Use vision to find an item on the current screen. Returns (img_x, img_y) or None."""
    img = screenshot_window(window)
    b64 = img_to_base64(img)
    find_prompt = (
        f"{EPIC_VISUAL_REFERENCE}\n"
        f"TASK: Find the UI element labeled \"{item_name}\" in this Epic Hyperspace screenshot.\n"
        f"Check each layer: toolbar buttons, activity tabs, sidebar items, workspace controls, dialog buttons.\n"
        f"{VISION_COORD_INSTRUCTION}\n"
        f"Return ONLY: {{\"x\": <number>, \"y\": <number>, \"found\": true}}\n"
        f"If not found: {{\"found\": false, \"reason\": \"why\"}}"
    )
    resp = ask_claude(b64, find_prompt)
    if not resp:
        return None
    try:
        fm = re.search(r'\{[\s\S]*?\}', resp)
        if fm:
            loc = json.loads(fm.group())
            if loc.get("found"):
                return loc["x"], loc["y"]
    except Exception:
        pass
    return None


def verify_click(window, expected_item, context=""):
    """After clicking, verify the click had the expected effect.

    Anthropic best practice: 'After each step, take a screenshot and carefully
    evaluate if you have achieved the right outcome.'

    Uses wait_for_stable_screen to handle slow-loading UIs before checking.
    Returns: 'menu' (submenu opened), 'activity' (activity launched),
             'same' (nothing changed), 'dialog', 'unknown'"""
    img, b64 = wait_for_stable_screen(window, max_wait=2.0, interval=0.4)
    prompt = (
        f"{EPIC_VISUAL_REFERENCE}\n"
        f"TASK: After clicking '{expected_item}'{(' (' + context + ')') if context else ''}, classify the result.\n\n"
        "Using the visual reference above, check:\n"
        "- Is a FLOATING MENU PANEL visible (Epic button menu or submenu overlay)? -> 'menu'\n"
        "- Did a new ACTIVITY open (check toolbar activity name, check if activity tabs changed)? -> 'activity'\n"
        "- Did a DIALOG/POPUP appear (modal overlay with dimmed background)? -> 'dialog'\n"
        "- Is the main workspace/desktop showing with NO overlays? -> 'desktop'\n"
        "- Did nothing change from before? -> 'same'\n\n"
        "Return ONLY: {\"state\": \"menu\"|\"activity\"|\"dialog\"|\"desktop\"|\"same\", "
        "\"description\": \"brief description of what you see\"}"
    )
    resp = ask_claude(b64, prompt)
    if not resp:
        return "unknown"
    try:
        m = re.search(r'\{[\s\S]*?\}', resp)
        if m:
            result = json.loads(m.group())
            return result.get("state", "unknown")
    except Exception:
        pass
    return "unknown"


def click_with_verification(window, img_x, img_y, item_name, max_retries=2):
    """Click at coordinates and verify it worked. If miss, retry with vision.
    Returns the screen state after click ('menu', 'activity', etc.)."""
    sx, sy = vision_to_screen(window, img_x, img_y)
    safe_click(sx, sy, pause_after=0.8, label=f"{item_name} img({img_x},{img_y})")

    state = verify_click(window, item_name)
    if state == "same" and max_retries > 0:
        print(f"    [click] Click may have missed '{item_name}' (screen unchanged) - retrying with vision")
        coords = vision_find_on_screen(window, item_name)
        if coords:
            new_x, new_y = coords
            new_sx, new_sy = vision_to_screen(window, new_x, new_y)
            safe_click(new_sx, new_sy, pause_after=0.8, label=f"{item_name} retry")
            state = verify_click(window, item_name)
        else:
            print(f"    [click] Vision could not find '{item_name}' on screen")
    return state


def execute_navigate_path(cmd):
    """Navigate using cached pixel coordinates from the crawled tree.
    Features: drift correction, click verification, confidence-based fallback."""
    env = cmd.get("env", "SUP")
    path = cmd.get("path", "")
    client = cmd.get("client", "hyperspace")
    command_id = cmd.get("id", "unknown")

    if not path:
        post_result(command_id, "error", error="No path provided")
        return

    window = find_window(env, client)
    if not window:
        post_result(command_id, "error", error=f"No {env} {client} window found")
        return

    steps = [s.strip() for s in path.split(">") if s.strip()]
    print(f"  [path-nav] {env}/{client}: {' > '.join(steps)} ({len(steps)} steps)")

    activate_window(window)
    time.sleep(0.5)

    if client == "text":
        nums = []
        for i, step in enumerate(steps):
            num_match = re.match(r'^(\d+)(?:\s|$)', step.strip())
            if not num_match:
                post_result(command_id, "error", error=f"Safety block: Text step {i+1} '{step}' is not a valid numeric menu option. Only numeric selections are allowed.")
                return
            nums.append(num_match.group(1))

        for i, keystroke in enumerate(nums):
            print(f"  [step {i+1}/{len(nums)}] Typing: {keystroke} ({steps[i]})")
            pyautogui.typewrite(keystroke, interval=0.05)
            pyautogui.press("enter")
            time.sleep(1.0)
    else:
        tree = fetch_cached_tree(env, client)
        found_nodes = find_node_in_tree(tree, steps) if tree else []
        has_coords = len(found_nodes) == len(steps) and all(
            n.get("imgX", 0) > 0 and n.get("imgY", 0) > 0 for n in found_nodes
        )

        scale_x, scale_y, confidence = (1.0, 1.0, "unknown")
        if has_coords and tree:
            scale_x, scale_y, confidence = compute_drift(tree, window)

        use_cache = has_coords and confidence != "low"
        api_calls = 0

        if use_cache and tree:
            mode = "cached" if confidence == "high" else "cached+drift-corrected"
            print(f"  [path-nav] Mode: {mode} (confidence={confidence})")

            epic_btn_x = tree.get("epicButtonImgX", 0)
            epic_btn_y = tree.get("epicButtonImgY", 0)

            if epic_btn_x > 0 and epic_btn_y > 0:
                adj_x = int(epic_btn_x * scale_x)
                adj_y = int(epic_btn_y * scale_y)
                btn_sx, btn_sy = vision_to_screen(window, adj_x, adj_y)
                print(f"  [step 0] Epic button: cached({epic_btn_x},{epic_btn_y}) -> adjusted({adj_x},{adj_y}) -> screen({btn_sx},{btn_sy})")
                safe_click(btn_sx, btn_sy, pause_after=1.2, label="Epic button (cached)")

                state = verify_click(window, "Epic button")
                api_calls += 1
                if state != "menu":
                    print(f"  [step 0] Epic button click result: {state} - retrying with vision")
                    coords = vision_find_on_screen(window, "Epic")
                    api_calls += 1
                    if coords:
                        nav_sx, nav_sy = vision_to_screen(window, coords[0], coords[1])
                        safe_click(nav_sx, nav_sy, pause_after=1.2, label="Epic button (vision retry)")
                    else:
                        post_result(command_id, "error", error="Cannot find Epic button after retry")
                        return
            else:
                print(f"  [step 0] No cached Epic button coords, using vision...")
                coords = vision_find_on_screen(window, "Epic")
                api_calls += 1
                if not coords:
                    post_result(command_id, "error", error="Cannot find Epic button")
                    return
                nav_sx, nav_sy = vision_to_screen(window, coords[0], coords[1])
                safe_click(nav_sx, nav_sy, pause_after=1.2, label="Epic button (vision)")

            for i, node in enumerate(found_nodes):
                node_name = node.get("name", "?")
                raw_x = node.get("imgX", 0)
                raw_y = node.get("imgY", 0)
                adj_x = int(raw_x * scale_x)
                adj_y = int(raw_y * scale_y)
                is_last = (i == len(found_nodes) - 1)

                if confidence == "high":
                    sx, sy = vision_to_screen(window, adj_x, adj_y)
                    print(f"  [step {i+1}/{len(steps)}] Cached click: '{node_name}' ({adj_x},{adj_y}) -> ({sx},{sy})")
                    safe_click(sx, sy, pause_after=0.8, label=f"{node_name} (cached)")

                    if not is_last:
                        state = verify_click(window, node_name, f"step {i+1}")
                        api_calls += 1
                        if state == "same":
                            print(f"  [step {i+1}] Click missed - falling back to vision for '{node_name}'")
                            coords = vision_find_on_screen(window, node_name)
                            api_calls += 1
                            if coords:
                                vsx, vsy = vision_to_screen(window, coords[0], coords[1])
                                safe_click(vsx, vsy, pause_after=0.8, label=f"{node_name} (vision fallback)")
                            else:
                                post_result(command_id, "error", error=f"Cannot find '{node_name}' after retry")
                                return
                        elif state == "activity":
                            print(f"  [step {i+1}] '{node_name}' launched an activity instead of submenu")
                            break
                else:
                    state = click_with_verification(window, adj_x, adj_y, node_name)
                    api_calls += 1
                    if state == "same":
                        print(f"  [step {i+1}] Could not click '{node_name}' even after retry")
                        post_result(command_id, "error", error=f"Failed to click '{node_name}' at step {i+1}")
                        return
                    elif state == "activity" and not is_last:
                        print(f"  [step {i+1}] '{node_name}' launched activity prematurely")
                        break
                    time.sleep(0.5 if is_last else 0.3)

        else:
            if has_coords and confidence == "low":
                print(f"  [path-nav] Window geometry changed too much (confidence=low), using full vision")
            elif not has_coords:
                matched = len(found_nodes)
                print(f"  [path-nav] Cache miss ({matched}/{len(steps)} steps matched), using vision")
            else:
                print(f"  [path-nav] No cached tree, using vision navigation")

            coords = vision_find_on_screen(window, "Epic")
            api_calls += 1
            if not coords:
                post_result(command_id, "error", error="Vision could not find Epic button")
                return
            nav_x, nav_y = vision_to_screen(window, coords[0], coords[1])
            safe_click(nav_x, nav_y, pause_after=1.2, label="Epic button (vision full)")

            for i, step in enumerate(steps):
                print(f"  [step {i+1}/{len(steps)}] Vision-click: {step}")
                vis_coords = vision_find_on_screen(window, step)
                api_calls += 1
                if vis_coords:
                    sx, sy = vision_to_screen(window, vis_coords[0], vis_coords[1])
                    safe_click(sx, sy, pause_after=0.8, label=f"{step} (vision)")

                    if i < len(steps) - 1:
                        state = verify_click(window, step, f"step {i+1}")
                        api_calls += 1
                        if state == "same":
                            print(f"  [step {i+1}] Click missed '{step}' - retrying")
                            vis_coords2 = vision_find_on_screen(window, step)
                            api_calls += 1
                            if vis_coords2:
                                sx2, sy2 = vision_to_screen(window, vis_coords2[0], vis_coords2[1])
                                safe_click(sx2, sy2, pause_after=0.8, label=f"{step} (vision retry)")
                            else:
                                post_result(command_id, "error", error=f"Cannot find '{step}' after retry")
                                return
                        elif state == "activity":
                            print(f"  [step {i+1}] '{step}' launched activity")
                            break
                else:
                    post_result(command_id, "error", error=f"Vision could not find '{step}'")
                    return

    time.sleep(0.5)
    nav_mode = "cached" if (client != "text" and has_coords and use_cache) else "vision"
    post_result(command_id, "complete", data={
        "path": path,
        "client": client,
        "stepsCompleted": len(steps),
        "mode": nav_mode,
        "apiCalls": api_calls if client != "text" else 0,
        "driftConfidence": confidence if client != "text" else "n/a",
    })
    print(f"  [path-nav] Complete: {len(steps)} steps ({nav_mode}, {api_calls} API calls, drift={confidence})")


def execute_uia_tree(cmd):
    """Live UIA tree scan — list all windows or detail a specific window's control tree."""
    command_id = cmd.get("id", "unknown")
    target = cmd.get("target", "")
    try:
        max_depth = min(max(1, int(cmd.get("depth", 4))), 8)
    except (TypeError, ValueError):
        max_depth = 4

    try:
        from pywinauto import Desktop
    except ImportError:
        post_result(command_id, "error", error="pywinauto not installed")
        return

    desktop = Desktop(backend="uia")

    if not target:
        print("  [uia-tree] Listing all windows...")
        windows = []
        for w in desktop.windows():
            try:
                info = w.element_info
                title = info.name or ""
                if not title.strip():
                    continue
                hwnd = int(info.handle) if info.handle else 0
                pid = getattr(info, "process_id", 0) or 0
                class_name = getattr(info, "class_name", "") or ""
                proc_name = ""
                try:
                    import ctypes
                    from ctypes import wintypes
                    h = ctypes.windll.kernel32.OpenProcess(0x0410, False, pid)
                    if h:
                        buf = ctypes.create_unicode_buffer(260)
                        size = wintypes.DWORD(260)
                        if ctypes.windll.kernel32.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(size)):
                            proc_name = os.path.basename(buf.value)
                        ctypes.windll.kernel32.CloseHandle(h)
                except Exception:
                    pass
                rect_raw = getattr(info, "rectangle", None)
                rect = None
                if rect_raw:
                    try:
                        rect = {"left": rect_raw.left, "top": rect_raw.top,
                                "width": rect_raw.width(), "height": rect_raw.height()}
                    except Exception:
                        pass
                windows.append({
                    "title": title,
                    "hwnd": hwnd,
                    "processName": proc_name,
                    "className": class_name,
                    "rect": rect,
                })
            except Exception:
                continue
        print(f"  [uia-tree] Found {len(windows)} windows")
        post_result(command_id, "complete", data={"mode": "list", "windows": windows})
        _post_uia_cache({"mode": "list", "windows": windows, "scannedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())})
        return

    print(f"  [uia-tree] Scanning window matching '{target}' (depth={max_depth})...")
    target_upper = target.upper()
    target_window = None
    for w in desktop.windows():
        try:
            title = w.element_info.name or ""
            if target_upper in title.upper():
                target_window = w
                break
        except Exception:
            continue

    if not target_window:
        post_result(command_id, "error", error=f"No window matching '{target}'")
        return

    window_title = target_window.element_info.name or "Unknown"
    window_hwnd = int(target_window.element_info.handle) if target_window.element_info.handle else 0
    print(f"  [uia-tree] Found: {window_title}")

    total_scanned = [0]

    def scan_element(element, depth, parent_path):
        if depth > max_depth:
            return []
        try:
            children = element.children()
        except Exception:
            return []

        nodes = []
        for child in children:
            if total_scanned[0] > 5000:
                break
            try:
                info = child.element_info
                ctrl_type = info.control_type or ""
                name = info.name or ""
                auto_id = getattr(info, "automation_id", "") or ""
                class_name = getattr(info, "class_name", "") or ""
                is_enabled = True
                is_visible = True
                try:
                    is_enabled = child.is_enabled()
                except Exception:
                    pass
                try:
                    is_visible = child.is_visible()
                except Exception:
                    pass

                if not is_visible:
                    continue

                path_part = f"{ctrl_type}:{name}" if name else ctrl_type
                element_path = f"{parent_path}/{path_part}" if parent_path else path_part

                patterns = []
                try:
                    iface = child.iface_invoke
                    if iface:
                        patterns.append({"name": "InvokePattern", "tag": "clickable"})
                except Exception:
                    pass
                try:
                    iface = child.iface_value
                    if iface:
                        val = ""
                        try:
                            val = iface.CurrentValue or ""
                        except Exception:
                            pass
                        patterns.append({"name": "ValuePattern", "tag": "editable", "value": val[:200]})
                except Exception:
                    pass
                try:
                    iface = child.iface_expand_collapse
                    if iface:
                        state = "unknown"
                        try:
                            st = iface.CurrentExpandCollapseState
                            state = "expanded" if st == 1 else "collapsed" if st == 0 else "partial"
                        except Exception:
                            pass
                        patterns.append({"name": "ExpandCollapsePattern", "tag": "expandable", "state": state})
                except Exception:
                    pass
                try:
                    iface = child.iface_selection_item
                    if iface:
                        selected = False
                        try:
                            selected = bool(iface.CurrentIsSelected)
                        except Exception:
                            pass
                        patterns.append({"name": "SelectionItemPattern", "tag": "selectable", "isSelected": selected})
                except Exception:
                    pass
                try:
                    iface = child.iface_toggle
                    if iface:
                        toggle_state = "unknown"
                        try:
                            ts = iface.CurrentToggleState
                            toggle_state = "on" if ts == 1 else "off" if ts == 0 else "indeterminate"
                        except Exception:
                            pass
                        patterns.append({"name": "TogglePattern", "tag": "toggleable", "state": toggle_state})
                except Exception:
                    pass
                try:
                    iface = child.iface_scroll
                    if iface:
                        patterns.append({"name": "ScrollPattern", "tag": "scrollable"})
                except Exception:
                    pass
                try:
                    iface = child.iface_text
                    if iface:
                        patterns.append({"name": "TextPattern", "tag": "readable"})
                except Exception:
                    pass
                try:
                    iface = child.iface_range_value
                    if iface:
                        patterns.append({"name": "RangeValuePattern", "tag": "adjustable"})
                except Exception:
                    pass

                rect = None
                try:
                    r = info.rectangle
                    if r:
                        rect = {"left": r.left, "top": r.top, "width": r.width(), "height": r.height()}
                except Exception:
                    pass

                total_scanned[0] += 1
                sub_children = scan_element(child, depth + 1, element_path)

                node = {
                    "controlType": ctrl_type,
                    "name": name,
                    "automationId": auto_id,
                    "className": class_name,
                    "isEnabled": is_enabled,
                    "isVisible": is_visible,
                    "depth": depth,
                    "path": element_path,
                    "patterns": patterns,
                    "children": sub_children,
                }
                if rect:
                    node["rect"] = rect
                nodes.append(node)
            except Exception:
                continue
        return nodes

    tree = scan_element(target_window, 0, "")
    print(f"  [uia-tree] Scan complete: {total_scanned[0]} elements")

    result_data = {
        "mode": "detail",
        "window": {
            "title": window_title,
            "hwnd": window_hwnd,
            "tree": tree,
        },
    }
    post_result(command_id, "complete", data=result_data)
    _post_uia_cache({
        **result_data,
        "scannedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "target": target,
    })


def _post_uia_cache(data):
    """Post UIA tree scan result to server cache."""
    try:
        _bridge_request(
            "post", "/api/epic/uia-tree", "uia-cache", timeout=10,
            headers={
                "Authorization": f"Bearer {BRIDGE_TOKEN}",
                "Content-Type": "application/json",
            },
            json=data,
        )
    except Exception:
        pass


def execute_tree_scan(cmd):
    """Trigger a pywinauto tree scan and upload results."""
    env = cmd.get("env", "SUP")
    command_id = cmd.get("id", "unknown")

    print(f"  [tree-scan] Starting pywinauto scan for {env}...")

    try:
        import subprocess
        script_dir = os.path.dirname(os.path.abspath(__file__))
        tree_script = os.path.join(script_dir, "epic_tree.py")

        if not os.path.exists(tree_script):
            post_result(command_id, "error", error="epic_tree.py not found in tools directory")
            return

        combined_output = ""
        for client in ["hyperspace", "text"]:
            print(f"  [tree-scan] Scanning {client}...")
            result = subprocess.run(
                [sys.executable, tree_script, client, env],
                capture_output=True, text=True, timeout=300,
                env={**os.environ, "BRIDGE_TOKEN": BRIDGE_TOKEN, "ORGCLOUD_URL": ORGCLOUD_URL},
            )
            combined_output += f"--- {client} (exit {result.returncode}) ---\n"
            combined_output += result.stdout + result.stderr + "\n"

        post_result(command_id, "complete", data={
            "output": combined_output[-2000:],
        })
        print(f"  [tree-scan] Both scans complete")

    except subprocess.TimeoutExpired:
        post_result(command_id, "error", error="Tree scan timed out (5 min limit)")
    except Exception as e:
        post_result(command_id, "error", error=f"Tree scan error: {str(e)}")


def execute_masterfile(cmd):
    """Send keystrokes for Epic Text masterfile lookup."""
    masterfile = cmd.get("masterfile", "")
    item = cmd.get("item", "")
    command_id = cmd.get("id", "unknown")
    env = cmd.get("env", "SUP")

    if not masterfile:
        post_result(command_id, "error", error="No masterfile specified")
        return

    print(f"  [masterfile] {masterfile} -> {item}")

    window = find_window(env, "text")
    if not window:
        post_result(command_id, "error", error=f"No {env} Text window found for masterfile lookup")
        return

    try:
        activate_window(window)
        time.sleep(0.5)

        pyautogui.typewrite(masterfile, interval=0.05)
        time.sleep(0.3)
        pyautogui.press("enter")
        time.sleep(1.0)

        if item:
            pyautogui.typewrite(item, interval=0.05)
            time.sleep(0.3)
            pyautogui.press("enter")
            time.sleep(1.0)

        final_img = screenshot_window(window)
        final_b64 = img_to_base64(final_img)
        post_result(command_id, "complete", screenshot_b64=final_b64, data={
            "masterfile": masterfile,
            "item": item,
        })
        print(f"  [masterfile] Complete")

    except Exception as e:
        post_result(command_id, "error", error=f"Masterfile error: {str(e)}")


def recording_capture_tick():
    """Called each loop iteration when recording is active. Captures screenshot,
    uses vision to describe what changed, and posts steps to the server."""
    if not recording_state["active"]:
        return
    now = time.time()
    if now - recording_state["last_capture_time"] < recording_state["capture_interval"]:
        return
    recording_state["last_capture_time"] = now

    env = recording_state["env"]
    window = find_window(env)
    if not window:
        return

    img = screenshot_window(window)
    if img is None:
        return
    b64 = img_to_base64(img)
    prev_screen = recording_state["last_screen"]

    if prev_screen == b64:
        return

    description = "Screen changed"
    screen_name = ""

    if OPENROUTER_API_KEY:
        try:
            messages = []
            if prev_screen:
                messages.append({
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Previous Epic Hyperspace screen:"},
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{prev_screen}"}},
                        {"type": "text", "text": "Current Epic Hyperspace screen:"},
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                        {"type": "text", "text": f"{EPIC_VISUAL_REFERENCE}\nTASK: Compare these two Epic Hyperspace screens.\n1. Read the BREADCRUMB/TITLE (Layer 4) on each screen — what changed?\n2. Check if WORKSPACE TABS (Layer 3) changed — did the user switch tabs?\n3. Check if LEFT SIDEBAR selection (Layer 5) changed — did user click a different section?\n4. Check if a dialog/popup appeared or disappeared.\n5. Describe the navigation action in one sentence (shortcut click, tab switch, sidebar click, breadcrumb navigation, dialog interaction).\n\nIMPORTANT: Do NOT mention patient names, MRNs, DOB, or any PHI.\nReply as JSON: {{\"action\": \"what user clicked/did\", \"fromScreen\": \"previous breadcrumb/title\", \"screen\": \"current breadcrumb/title\"}}"},
                    ]
                })
            else:
                messages.append({
                    "role": "user",
                    "content": [
                        {"type": "text", "text": f"{EPIC_VISUAL_REFERENCE}\nTASK: Identify this Epic Hyperspace screen.\nRead the BREADCRUMB/TITLE (Layer 4) and the ACTIVE WORKSPACE TAB (Layer 3).\nCheck if any patient name tabs are open (Layer 3) — just note 'patient context open', no PHI.\nIMPORTANT: Do NOT mention patient names, MRNs, DOB, or any PHI.\nReply as JSON: {{\"action\": \"Initial screen\", \"screen\": \"breadcrumb/record title\"}}"},
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                    ]
                })

            resp = requests.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": MODEL,
                    "messages": messages,
                    "max_tokens": 200,
                },
                timeout=30,
            )
            data = resp.json()
            text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            parsed = _extract_json_object(text)
            if parsed:
                description = parsed.get("action", description)
                screen_name = parsed.get("screen", "")
        except Exception as e:
            print(f"  [record] Vision error: {e}")

    recording_state["last_screen"] = b64
    step = {
        "description": description,
        "screen": screen_name,
        "timeDelta": int(now - (recording_state.get("started_at", now))),
    }
    recording_state["pending_steps"].append(step)
    print(f"  [record] Step: {description} [{screen_name}]")

    if len(recording_state["pending_steps"]) >= 1:
        resp = _bridge_request(
            "post", "/api/epic/record/steps", "record-upload", timeout=10,
            headers={
                "Authorization": f"Bearer {BRIDGE_TOKEN}",
                "Content-Type": "application/json",
            },
            json={"steps": recording_state["pending_steps"]},
        )
        if resp and resp.status_code == 200:
            recording_state["pending_steps"] = []
        elif resp and resp.status_code == 409:
            print("  [record] Server says recording stopped, halting capture")
            recording_state["active"] = False
            recording_state["pending_steps"] = []
        elif resp:
            print(f"  [record] Upload failed ({resp.status_code}), will retry")


def execute_record_start(cmd):
    """Start recording mode."""
    env = cmd.get("env", "SUP").upper()
    recording_state["active"] = True
    recording_state["env"] = env
    recording_state["last_screen"] = ""
    recording_state["last_capture_time"] = 0
    recording_state["pending_steps"] = []
    recording_state["started_at"] = time.time()
    print(f"  [record] Recording started for {env}")
    post_result(cmd.get("id", "unknown"), "complete", data={"recording": True, "env": env})


def execute_record_stop(cmd):
    """Stop recording mode."""
    recording_state["active"] = False
    if recording_state["pending_steps"]:
        _bridge_request(
            "post", "/api/epic/record/steps", "record-flush", timeout=10,
            headers={
                "Authorization": f"Bearer {BRIDGE_TOKEN}",
                "Content-Type": "application/json",
            },
            json={"steps": recording_state["pending_steps"]},
        )
        recording_state["pending_steps"] = []
    print(f"  [record] Recording stopped")
    post_result(cmd.get("id", "unknown"), "complete", data={"recording": False})


# ────────────────────────────────────────────────────────────────────────────
# WASAPI Loopback Audio Capture  (execute_audio_start / stop / status)
# ────────────────────────────────────────────────────────────────────────────

def _audio_compute_rms(pcm_bytes: bytes) -> float:
    """RMS amplitude of 16-bit LE PCM. Uses numpy when available."""
    if _NUMPY_AVAILABLE:
        samples = _np.frombuffer(pcm_bytes, dtype=_np.int16)
        if len(samples) == 0:
            return 0.0
        return float(_np.sqrt(_np.mean(samples.astype(_np.float32) ** 2)))
    n = len(pcm_bytes) // 2
    if n == 0:
        return 0.0
    total = sum(s * s for s in struct.unpack_from(f"<{n}h", pcm_bytes))
    return (total / n) ** 0.5


def _audio_pcm_to_wav(pcm_bytes: bytes) -> bytes:
    """Wrap raw 16-bit mono PCM in a WAV container (no disk I/O)."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(_AUDIO_CHANNELS)
        wf.setsampwidth(_AUDIO_SAMPLE_WIDTH)
        wf.setframerate(_AUDIO_SAMPLE_RATE)
        wf.writeframes(pcm_bytes)
    return buf.getvalue()


def _audio_mix_pcm(loopback: bytes, mic: bytes) -> bytes:
    """Mix two 16-bit mono PCM streams (average). Handles length mismatch gracefully."""
    if not mic:
        return loopback
    if not loopback:
        return mic
    if _NUMPY_AVAILABLE:
        a = _np.frombuffer(loopback, dtype=_np.int16).astype(_np.int32)
        b = _np.frombuffer(mic, dtype=_np.int16).astype(_np.int32)
        n = min(len(a), len(b))
        mixed = _np.clip((a[:n] + b[:n]) >> 1, -32768, 32767).astype(_np.int16)
        return mixed.tobytes()
    n_lo = len(loopback) // 2
    n_mic = len(mic) // 2
    n = min(n_lo, n_mic)
    lo_s = struct.unpack_from(f"<{n}h", loopback)
    mi_s = struct.unpack_from(f"<{n}h", mic)
    return struct.pack(f"<{n}h", *(max(-32768, min(32767, (a + b) >> 1)) for a, b in zip(lo_s, mi_s)))


def _audio_new_server_session(title: str) -> tuple:
    """Create a new server-side recording session. Returns (session_id, transcript_id) or (None, None)."""
    try:
        resp = requests.post(
            f"{ORGCLOUD_URL}/api/transcripts/record/start",
            headers={"Authorization": f"Bearer {BRIDGE_TOKEN}", "Content-Type": "application/json"},
            json={"sourceUrl": "", "tabTitle": title or "Windows audio recording", "recordingType": "system"},
            timeout=15,
        )
        if resp and resp.status_code == 200:
            d = resp.json()
            return d.get("sessionId"), d.get("transcriptId")
    except Exception as exc:
        print(f"  [audio] New session error: {exc}")
    return None, None


def _audio_stop_server_session(session_id: str) -> None:
    """Tell server to finalize and queue transcription for a session."""
    try:
        requests.post(
            f"{ORGCLOUD_URL}/api/transcripts/record/{session_id}/stop",
            headers={"Authorization": f"Bearer {BRIDGE_TOKEN}"},
            timeout=15,
        )
    except Exception as exc:
        print(f"  [audio] Stop session error: {exc}")


def _audio_upload_chunk(session_id: str, wav_bytes: bytes) -> bool:
    """Upload a WAV chunk with exponential-backoff retry. Returns True on success."""
    for attempt in range(_AUDIO_UPLOAD_RETRIES + 1):
        try:
            resp = requests.post(
                f"{ORGCLOUD_URL}/api/transcripts/record/{session_id}/chunk",
                headers={"Authorization": f"Bearer {BRIDGE_TOKEN}"},
                files={"audio": ("audio.wav", wav_bytes, "audio/wav")},
                timeout=30,
            )
            if resp and resp.status_code == 200:
                return True
            code = resp.status_code if resp else "timeout"
            print(f"  [audio] Chunk HTTP {code} (attempt {attempt + 1}/{_AUDIO_UPLOAD_RETRIES + 1})")
        except Exception as exc:
            print(f"  [audio] Chunk error: {exc} (attempt {attempt + 1}/{_AUDIO_UPLOAD_RETRIES + 1})")
        if attempt < _AUDIO_UPLOAD_RETRIES:
            time.sleep(1.5 * (attempt + 1))
    return False


def _audio_encoder_loop(stop_event: threading.Event, ring_buf: collections.deque) -> None:
    """Daemon thread: drains ring buffers every CHUNK_SECONDS, mixes dual-track,
    silence-gates with RMS, uploads with retry, auto-splits sessions at 22MB."""
    global _audio_session
    threshold = _audio_session.get("silence_threshold", _AUDIO_SILENCE_THRESHOLD)
    preroll_bytes = b""
    try:
        while not stop_event.is_set():
            stop_event.wait(timeout=_AUDIO_CHUNK_SECONDS)

            # Drain loopback ring buffer
            frames: list = []
            while True:
                try:
                    frames.append(ring_buf.popleft())
                except IndexError:
                    break

            # Drain mic ring buffer if dual-track
            mic_frames: list = []
            mic_ring = _audio_session.get("mic_ring_buf")
            if mic_ring is not None:
                while True:
                    try:
                        mic_frames.append(mic_ring.popleft())
                    except IndexError:
                        break

            if not frames:
                continue

            loopback_pcm = b"".join(frames)
            mic_pcm = b"".join(mic_frames) if mic_frames else b""
            pcm = _audio_mix_pcm(loopback_pcm, mic_pcm) if mic_pcm else loopback_pcm
            rms = _audio_compute_rms(pcm)
            upload_pcm = preroll_bytes + pcm
            preroll_bytes = pcm[-(_AUDIO_PREROLL_FRAMES * _AUDIO_SAMPLE_WIDTH):]

            if rms < threshold:
                _audio_session["chunks_skipped"] = _audio_session.get("chunks_skipped", 0) + 1
                print(f"  [audio] Silent (RMS={rms:.0f}<{threshold}) — skipped")
                continue

            wav_bytes = _audio_pcm_to_wav(upload_pcm)
            session_id = _audio_session.get("session_id")
            if not session_id:
                continue

            # ── Auto-split: start new session when approaching server size limit ──
            projected = _audio_session.get("bytes_uploaded", 0) + len(wav_bytes)
            if projected >= _AUDIO_SPLIT_THRESHOLD_BYTES:
                title = _audio_session.get("title", "Windows audio recording")
                part = _audio_session.get("split_count", 0) + 1
                print(f"  [audio] Auto-split at {projected // 1024}KB → part {part + 1}")
                _audio_stop_server_session(session_id)
                new_sid, new_tid = _audio_new_server_session(f"{title} (part {part + 1})")
                if new_sid:
                    _audio_session["session_id"] = new_sid
                    _audio_session["transcript_id"] = new_tid
                    _audio_session["bytes_uploaded"] = 0
                    _audio_session["split_count"] = part
                    session_id = new_sid
                else:
                    print(f"  [audio] Auto-split failed — continuing current session")

            if _audio_upload_chunk(session_id, wav_bytes):
                _audio_session["bytes_uploaded"] = _audio_session.get("bytes_uploaded", 0) + len(wav_bytes)
                track = " [dual]" if mic_pcm else ""
                print(f"  [audio] Chunk {len(wav_bytes) // 1024}KB RMS={rms:.0f}{track}")
            else:
                print(f"  [audio] Chunk dropped after {_AUDIO_UPLOAD_RETRIES + 1} attempts")

    except Exception as exc:
        print(f"  [audio-encoder] Crashed: {exc}")
        traceback.print_exc()
        _audio_session["encoder_crashed"] = True
    print("  [audio] Encoder thread exit")


def _audio_emergency_stop(reason: str) -> None:
    """Lightweight auto-stop triggered by watchdog. No post_result — cleans up streams + server."""
    global _audio_session
    if not _audio_session.get("active"):
        return
    session_id = _audio_session.get("session_id")
    stop_event = _audio_session.get("stop_event")
    if stop_event:
        stop_event.set()
    try:
        stream = _audio_session.get("stream")
        mic_stream = _audio_session.get("mic_stream")
        p = _audio_session.get("pyaudio")
        if stream:
            stream.stop_stream(); stream.close()
        if mic_stream:
            mic_stream.stop_stream(); mic_stream.close()
        if p:
            p.terminate()
    except Exception:
        pass
    if session_id:
        _audio_stop_server_session(session_id)
    dur = int(time.time() - _audio_session.get("session_start", time.time()))
    print(f"  [audio] Emergency stop: {reason} (duration={dur}s)")
    _audio_session = {}


def _audio_watchdog_tick() -> None:
    """Called from main agent loop every poll cycle.
    Detects encoder crashes and enforces the 2-hour max-duration safety net."""
    if not _audio_session.get("active"):
        return
    if _audio_session.get("encoder_crashed"):
        print("  [audio-watchdog] Encoder crashed — emergency stop")
        _audio_emergency_stop("encoder crash")
        return
    enc = _audio_session.get("encoder_thread")
    if enc and not enc.is_alive():
        print("  [audio-watchdog] Encoder thread dead — emergency stop")
        _audio_emergency_stop("encoder thread died unexpectedly")
        return
    elapsed = time.time() - _audio_session.get("session_start", time.time())
    if elapsed > _AUDIO_MAX_DURATION_SECS:
        print(f"  [audio-watchdog] {_AUDIO_MAX_DURATION_SECS // 3600}h limit reached — auto-stopping")
        _audio_emergency_stop(f"max duration ({_AUDIO_MAX_DURATION_SECS // 3600}h) reached")


def execute_audio_start(cmd: dict) -> None:
    """Start WASAPI loopback + optional microphone dual-track recording."""
    global _audio_session
    command_id = cmd.get("id", "unknown")
    title = cmd.get("title", "")
    threshold = int(cmd.get("silenceThreshold", _AUDIO_SILENCE_THRESHOLD))

    if _audio_session.get("active"):
        post_result(command_id, "error",
                    error=f"Already recording session {_audio_session.get('session_id')}. Stop first.")
        return

    # Create server-side transcript session
    session_id, transcript_id = _audio_new_server_session(title)
    if not session_id:
        post_result(command_id, "error", error="Failed to create server recording session.")
        return

    def _cancel():
        _audio_stop_server_session(session_id)

    # Import pyaudio (prefer pyaudiowpatch for WASAPI loopback)
    try:
        import pyaudiowpatch as pyaudio  # type: ignore
    except ImportError:
        try:
            import pyaudio  # type: ignore
        except ImportError:
            _cancel()
            post_result(command_id, "error",
                        error="pyaudiowpatch not installed. Run: pip install pyaudiowpatch")
            return

    # Find loopback device
    p = pyaudio.PyAudio()
    loopback = None
    try:
        if hasattr(p, "get_default_wasapi_loopback"):
            loopback = p.get_default_wasapi_loopback()
    except Exception:
        pass
    if not loopback:
        for i in range(p.get_device_count()):
            info = p.get_device_info_by_index(i)
            if info.get("isLoopbackDevice") or "loopback" in str(info.get("name", "")).lower():
                loopback = info
                break
    if not loopback:
        try:
            loopback = p.get_default_input_device_info()
        except Exception:
            p.terminate()
            _cancel()
            post_result(command_id, "error", error="No audio capture device found.")
            return

    device_name = loopback.get("name", "unknown")
    print(f"  [audio] Loopback: {device_name}")

    ring_buf: collections.deque = collections.deque(maxlen=_AUDIO_RING_MAXLEN)
    stop_event = threading.Event()

    def _cb(in_data, frame_count, time_info, status):
        ring_buf.append(in_data)
        return (None, pyaudio.paContinue)

    try:
        stream = p.open(
            format=pyaudio.paInt16,
            channels=_AUDIO_CHANNELS,
            rate=_AUDIO_SAMPLE_RATE,
            input=True,
            frames_per_buffer=_AUDIO_CHUNK_FRAMES,
            input_device_index=loopback.get("index"),
            stream_callback=_cb,
        )
    except Exception as exc:
        p.terminate()
        _cancel()
        post_result(command_id, "error", error=f"Audio stream open failed: {exc}")
        return

    stream.start_stream()

    # ── Dual-track: open microphone stream if it's a different device ──
    mic_stream = None
    mic_ring_buf = None
    mic_name = None
    try:
        mic_info = p.get_default_input_device_info()
        if mic_info and mic_info.get("index") != loopback.get("index"):
            mic_ring_buf = collections.deque(maxlen=_AUDIO_RING_MAXLEN)

            def _mic_cb(in_data, frame_count, time_info, status):
                mic_ring_buf.append(in_data)
                return (None, pyaudio.paContinue)

            mic_stream = p.open(
                format=pyaudio.paInt16,
                channels=_AUDIO_CHANNELS,
                rate=_AUDIO_SAMPLE_RATE,
                input=True,
                frames_per_buffer=_AUDIO_CHUNK_FRAMES,
                input_device_index=mic_info.get("index"),
                stream_callback=_mic_cb,
            )
            mic_stream.start_stream()
            mic_name = mic_info.get("name", "microphone")
            print(f"  [audio] Mic: {mic_name}")
    except Exception as exc:
        print(f"  [audio] Mic unavailable (loopback-only): {exc}")
        mic_stream = None
        mic_ring_buf = None

    # ── Level check: sample 2s to verify audio is actually flowing ──
    time.sleep(2.0)
    level_frames: list = []
    while True:
        try:
            level_frames.append(ring_buf.popleft())
        except IndexError:
            break
    level_pcm = b"".join(level_frames)
    ambient_rms = _audio_compute_rms(level_pcm) if level_pcm else 0.0
    device_active = ambient_rms > 1.0
    if not device_active:
        print(f"  [audio] WARNING: ambient RMS={ambient_rms:.1f} — device may be silent or muted")
    else:
        print(f"  [audio] Level check OK: RMS={ambient_rms:.1f}")

    _audio_session = {
        "active": True,
        "session_id": session_id,
        "transcript_id": transcript_id,
        "session_start": time.time(),
        "title": title or "Windows audio recording",
        "ring_buf": ring_buf,
        "mic_ring_buf": mic_ring_buf,
        "stop_event": stop_event,
        "stream": stream,
        "mic_stream": mic_stream,
        "pyaudio": p,
        "bytes_uploaded": 0,
        "chunks_skipped": 0,
        "split_count": 0,
        "silence_threshold": threshold,
        "device_name": device_name,
        "mic_name": mic_name,
        "dual_track": mic_stream is not None,
        "ambient_rms": round(ambient_rms, 1),
    }

    enc = threading.Thread(target=_audio_encoder_loop,
                           args=(stop_event, ring_buf),
                           daemon=True, name="audio-encoder")
    enc.start()
    _audio_session["encoder_thread"] = enc

    print(f"  [audio] Started: session={session_id} dual={mic_stream is not None}")
    post_result(command_id, "complete", data={
        "sessionId": session_id,
        "transcriptId": transcript_id,
        "device": device_name,
        "micDevice": mic_name,
        "dualTrack": mic_stream is not None,
        "sampleRate": _AUDIO_SAMPLE_RATE,
        "silenceThreshold": threshold,
        "ambientRms": round(ambient_rms, 1),
        "deviceActive": device_active,
        "warning": "Device may be silent (ambient RMS near zero)" if not device_active else None,
    })


def execute_audio_stop(cmd: dict) -> None:
    """Stop audio recording, flush remaining frames, trigger server transcription."""
    global _audio_session
    command_id = cmd.get("id", "unknown")

    if not _audio_session.get("active"):
        post_result(command_id, "error", error="No active audio recording.")
        return

    session_id = _audio_session.get("session_id")

    # Signal encoder thread to stop and wait
    stop_event = _audio_session.get("stop_event")
    if stop_event:
        stop_event.set()
    enc = _audio_session.get("encoder_thread")
    if enc and enc.is_alive():
        enc.join(timeout=15)

    # Final drain — loopback + mic, mixed, VAD-gated, uploaded
    ring_buf = _audio_session.get("ring_buf")
    mic_ring = _audio_session.get("mic_ring_buf")
    loopback_frames: list = []
    mic_frames_final: list = []
    if ring_buf:
        while True:
            try:
                loopback_frames.append(ring_buf.popleft())
            except IndexError:
                break
    if mic_ring:
        while True:
            try:
                mic_frames_final.append(mic_ring.popleft())
            except IndexError:
                break
    if loopback_frames:
        loopback_pcm = b"".join(loopback_frames)
        mic_pcm = b"".join(mic_frames_final) if mic_frames_final else b""
        pcm = _audio_mix_pcm(loopback_pcm, mic_pcm) if mic_pcm else loopback_pcm
        rms = _audio_compute_rms(pcm)
        if rms >= _audio_session.get("silence_threshold", _AUDIO_SILENCE_THRESHOLD):
            wav_bytes = _audio_pcm_to_wav(pcm)
            if _audio_upload_chunk(session_id, wav_bytes):
                _audio_session["bytes_uploaded"] = _audio_session.get("bytes_uploaded", 0) + len(wav_bytes)
                print(f"  [audio] Final chunk {len(wav_bytes) // 1024}KB uploaded")
            else:
                print(f"  [audio] Final chunk upload failed")

    # Close all PortAudio streams
    try:
        stream = _audio_session.get("stream")
        mic_stream = _audio_session.get("mic_stream")
        p = _audio_session.get("pyaudio")
        if stream:
            stream.stop_stream(); stream.close()
        if mic_stream:
            mic_stream.stop_stream(); mic_stream.close()
        if p:
            p.terminate()
    except Exception as exc:
        print(f"  [audio] Stream close error: {exc}")

    # Signal server to transcribe
    _audio_stop_server_session(session_id)

    duration = int(time.time() - _audio_session.get("session_start", time.time()))
    result = {
        "sessionId": session_id,
        "durationSeconds": duration,
        "bytesUploaded": _audio_session.get("bytes_uploaded", 0),
        "chunksSkipped": _audio_session.get("chunks_skipped", 0),
        "splitSessions": _audio_session.get("split_count", 0),
        "dualTrack": _audio_session.get("dual_track", False),
    }
    _audio_session = {}
    post_result(command_id, "complete", data=result)
    print(f"  [audio] Stopped. Duration={duration}s "
          f"uploaded={result['bytesUploaded'] // 1024}KB splits={result['splitSessions']}")


def execute_audio_status(cmd: dict) -> None:
    """Return current audio recording status."""
    command_id = cmd.get("id", "unknown")
    if not _audio_session.get("active"):
        post_result(command_id, "complete", data={"active": False})
        return
    elapsed = int(time.time() - _audio_session.get("session_start", time.time()))
    enc = _audio_session.get("encoder_thread")
    encoder_healthy = enc is not None and enc.is_alive() and not _audio_session.get("encoder_crashed")
    post_result(command_id, "complete", data={
        "active": True,
        "sessionId": _audio_session.get("session_id"),
        "transcriptId": _audio_session.get("transcript_id"),
        "elapsedSeconds": elapsed,
        "maxDurationSeconds": _AUDIO_MAX_DURATION_SECS,
        "bytesUploaded": _audio_session.get("bytes_uploaded", 0),
        "chunksSkipped": _audio_session.get("chunks_skipped", 0),
        "splitCount": _audio_session.get("split_count", 0),
        "device": _audio_session.get("device_name", "unknown"),
        "micDevice": _audio_session.get("mic_name"),
        "dualTrack": _audio_session.get("dual_track", False),
        "silenceThreshold": _audio_session.get("silence_threshold", _AUDIO_SILENCE_THRESHOLD),
        "ambientRms": _audio_session.get("ambient_rms", 0),
        "encoderHealthy": encoder_healthy,
    })


_nav_replay_kill = threading.Event()


def _nav_replay_vision_click(win_title, to_title, target_desc=""):
    """Use LLM vision to find and click a target element on the current screen."""
    if not OPENROUTER_API_KEY:
        return False
    try:
        img, win = _session_grab_window(win_title)
        if not img or not win:
            return False
        b64 = img_to_base64(img)
        prompt_target = target_desc or to_title
        resp = requests.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": MODEL,
                "messages": [{
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                        {"type": "text", "text": f"{EPIC_VISUAL_REFERENCE}\nTASK: Navigate to '{prompt_target}' in this Epic Hyperspace screen.\n\nUsing the visual reference, identify what to click:\n- Check toolbar buttons and search bar (Layer 1)\n- Check activity tabs (Layer 3) — is '{prompt_target}' already an open tab?\n- Check sidebar/navigator items (Layer 4)\n- Check workspace controls, links, or buttons (Layer 4)\n- If the Epic button menu is open, check menu items\n\n{VISION_COORD_INSTRUCTION}\nDo NOT reference patient names, MRNs, or PHI.\nReply as JSON only: {{\"action\": \"click\", \"x\": <int>, \"y\": <int>, \"target\": \"element description\"}} or {{\"action\": \"not_found\", \"reason\": \"...\"}}"},
                    ]
                }],
                "max_tokens": 200,
            },
            timeout=30,
        )
        data = resp.json()
        text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
        parsed = _extract_json_object(text)
        if parsed and parsed.get("action") == "click" and parsed.get("x") and parsed.get("y"):
            wx, wy = win.left, win.top
            click_x = wx + int(parsed["x"])
            click_y = wy + int(parsed["y"])
            pyautogui.click(click_x, click_y)
            print(f"  [nav-replay] Vision click at ({parsed['x']},{parsed['y']}): {parsed.get('target', '?')}")
            return True
        else:
            reason = parsed.get("reason", "unknown") if parsed else "no JSON response"
            print(f"  [nav-replay] Vision could not find target: {reason}")
            return False
    except Exception as e:
        print(f"  [nav-replay] Vision click error: {e}")
        return False


def execute_nav_replay(cmd):
    """Replay a navigation path using recorded fingerprint-verified steps."""
    command_id = cmd.get("id", "unknown")
    steps = cmd.get("steps", [])
    window_key = cmd.get("windowKey", "")
    target_title = cmd.get("targetTitle", "")
    alternate_edges = cmd.get("alternateEdges", {})

    _nav_replay_kill.clear()

    print(f"  [nav-replay] Starting replay to '{target_title}' ({len(steps)} hops)")

    cap = None
    with _always_on_lock:
        cap = _ALWAYS_ON_CAPTURES.get(window_key)

    if not cap or not cap.get("active"):
        all_windows = list(gw.getAllWindows())
        target_win = None
        wk_spaces = window_key.replace("_", " ")
        for w in all_windows:
            t = (w.title or "").lower()
            if wk_spaces and wk_spaces in t and w.width > 200:
                target_win = w
                break
        if not target_win:
            post_result(command_id, "error", error=f"No window found for key '{window_key}'")
            return
        win_title = target_win.title
    else:
        win_title = cap["window_title"]

    results = []
    for i, step in enumerate(steps):
        if _nav_replay_kill.is_set():
            results.append({"step": i + 1, "status": "killed", "fromTitle": step.get("fromTitle", "?"), "toTitle": step.get("toTitle", "?")})
            break

        step_num = step.get("step", i + 1)
        from_title = step.get("fromTitle", "?")
        to_title = step.get("toTitle", "?")
        expected_fp = step.get("expectedFp", "")
        trigger_keys = step.get("triggerKeys", [])
        actions = step.get("actions", [])
        wait_ms = step.get("waitMs", 1000)

        print(f"  [nav-replay] Step {step_num}/{len(steps)}: {from_title} -> {to_title}")

        success = False
        max_retries = 2

        for attempt in range(max_retries + 1):
            if _nav_replay_kill.is_set():
                break

            executed_action = False
            if trigger_keys:
                for tk in trigger_keys:
                    if "+" in tk:
                        parts = tk.split("+")
                        try:
                            sendinput_hotkey(*parts)
                        except Exception:
                            pyautogui.hotkey(*parts)
                    else:
                        try:
                            sendinput_press(tk)
                        except Exception:
                            pyautogui.press(tk)
                    time.sleep(0.3)
                executed_action = True
            elif actions:
                for act in actions:
                    act_type = act.get("action", "click")
                    act_key = act.get("key", "")
                    act_target = act.get("target", "")
                    act_wait = act.get("waitMs", 500)

                    if act_type == "key" and act_key:
                        try:
                            sendinput_press(act_key)
                        except Exception:
                            pyautogui.press(act_key)
                        executed_action = True
                    elif act_type == "hotkey" and act_key:
                        parts = act_key.split("+")
                        try:
                            sendinput_hotkey(*parts)
                        except Exception:
                            pyautogui.hotkey(*parts)
                        executed_action = True
                    elif act_type == "click":
                        clicked = _nav_replay_vision_click(win_title, to_title, act_target)
                        executed_action = clicked
                    elif act_type == "wait":
                        time.sleep(act_wait / 1000.0)

                    time.sleep(min(act_wait / 1000.0, 2.0))

            if not executed_action:
                clicked = _nav_replay_vision_click(win_title, to_title)
                executed_action = clicked

            time.sleep(max(0.5, wait_ms / 1000.0))

            if expected_fp:
                img, win = _session_grab_window(win_title)
                if img:
                    fp_region = _session_fingerprint_region(img)
                    current_fp = _session_phash(fp_region)

                    if current_fp == expected_fp:
                        results.append({
                            "step": step_num,
                            "status": "verified",
                            "attempt": attempt + 1,
                            "fromTitle": from_title,
                            "toTitle": to_title,
                        })
                        success = True
                        break
                    elif attempt < max_retries:
                        print(f"  [nav-replay] Step {step_num} mismatch (attempt {attempt + 1}), expected={expected_fp[:12]}, got={current_fp[:12]}")
                        if attempt == max_retries - 1:
                            alt_edges = alternate_edges.get(expected_fp, [])
                            for alt in alt_edges:
                                alt_keys = alt.get("triggerKeys", [])
                                if alt_keys:
                                    print(f"  [nav-replay] Trying alternate edge: {alt_keys}")
                                    for tk in alt_keys:
                                        if "+" in tk:
                                            try: sendinput_hotkey(*tk.split("+"))
                                            except: pyautogui.hotkey(*tk.split("+"))
                                        else:
                                            try: sendinput_press(tk)
                                            except: pyautogui.press(tk)
                                        time.sleep(0.3)
                                    time.sleep(max(0.5, wait_ms / 1000.0))
                                    img2, _ = _session_grab_window(win_title)
                                    if img2:
                                        fp2 = _session_phash(_session_fingerprint_region(img2))
                                        if fp2 == expected_fp:
                                            results.append({"step": step_num, "status": "verified_alt", "attempt": attempt + 1, "fromTitle": from_title, "toTitle": to_title})
                                            success = True
                                            break
                            if success:
                                break
                        time.sleep(1.0)
                        continue
                    else:
                        results.append({
                            "step": step_num,
                            "status": "fp_mismatch",
                            "attempt": attempt + 1,
                            "expectedFp": expected_fp[:16],
                            "actualFp": current_fp[:16],
                            "fromTitle": from_title,
                            "toTitle": to_title,
                        })
                        success = False
                        break
            else:
                results.append({
                    "step": step_num,
                    "status": "executed_unverified",
                    "attempt": attempt + 1,
                    "fromTitle": from_title,
                    "toTitle": to_title,
                })
                success = True
                break

        if not success:
            if not any(r.get("step") == step_num for r in results):
                results.append({"step": step_num, "status": "failed", "fromTitle": from_title, "toTitle": to_title})
            break

    final_img, _ = _session_grab_window(win_title)
    final_b64 = img_to_base64(final_img) if final_img else ""

    verified_count = sum(1 for r in results if r.get("status") in ("verified", "verified_alt"))
    total = len(steps)
    killed = _nav_replay_kill.is_set()
    overall = "killed" if killed else ("complete" if verified_count == total else "partial")

    post_result(command_id, "complete", screenshot_b64=final_b64, data={
        "mode": "nav_replay",
        "target": target_title,
        "steps_total": total,
        "steps_verified": verified_count,
        "overall": overall,
        "results": results,
    })
    print(f"  [nav-replay] Done: {verified_count}/{total} verified ({overall})")


def execute_replay(cmd):
    """Replay a saved workflow by navigating through each step."""
    command_id = cmd.get("id", "unknown")
    env = cmd.get("env", "SUP").upper()
    steps = cmd.get("steps", [])
    window = find_window(env)
    if not window:
        post_result(command_id, "error", error=f"No Hyperspace window found for {env}")
        return

    print(f"  [replay] Starting replay of {len(steps)} steps on {env}")
    results = []
    for i, step in enumerate(steps):
        screen = step.get("screen", "")
        desc = step.get("description", "")
        print(f"  [replay] Step {i+1}/{len(steps)}: {desc} -> {screen}")

        if screen and OPENROUTER_API_KEY:
            img = screenshot_window(window)
            if img:
                b64 = img_to_base64(img)
                try:
                    resp = requests.post(
                        "https://openrouter.ai/api/v1/chat/completions",
                        headers={
                            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                            "Content-Type": "application/json",
                        },
                        json={
                            "model": MODEL,
                            "messages": [{
                                "role": "user",
                                "content": [
                                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
                                    {"type": "text", "text": f"I need to navigate to '{screen}' in Epic Hyperspace. Looking at the current screen, what should I click or what menu should I open? Give precise coordinates or element name. Do NOT reference any patient names, MRNs, or PHI data visible on screen. Reply as JSON: {{\"action\": \"click\", \"target\": \"...\", \"x\": ..., \"y\": ...}} or {{\"action\": \"already_there\"}} or {{\"action\": \"failed\", \"reason\": \"...\"}}"},
                                ]
                            }],
                            "max_tokens": 200,
                        },
                        timeout=30,
                    )
                    data = resp.json()
                    text = data.get("choices", [{}])[0].get("message", {}).get("content", "")
                    parsed = _extract_json_object(text)
                    if parsed:
                        if parsed.get("action") == "already_there":
                            results.append({"step": i+1, "status": "already_there"})
                        elif parsed.get("action") == "failed":
                            results.append({"step": i+1, "status": "failed", "reason": parsed.get("reason", "")})
                        elif parsed.get("action") == "click" and parsed.get("x") and parsed.get("y"):
                            wx, wy = window.left, window.top
                            pyautogui.click(wx + parsed["x"], wy + parsed["y"])
                            time.sleep(2)
                            verify_img = screenshot_window(window)
                            verified = False
                            if verify_img and screen:
                                vb64 = img_to_base64(verify_img)
                                try:
                                    vresp = requests.post(
                                        "https://openrouter.ai/api/v1/chat/completions",
                                        headers={
                                            "Authorization": f"Bearer {OPENROUTER_API_KEY}",
                                            "Content-Type": "application/json",
                                        },
                                        json={
                                            "model": MODEL,
                                            "messages": [{
                                                "role": "user",
                                                "content": [
                                                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{vb64}"}},
                                                    {"type": "text", "text": f"Am I now on the '{screen}' screen in Epic Hyperspace? Do NOT reference any patient names or PHI. Reply as JSON: {{\"on_target\": true/false, \"current_screen\": \"...\"}}"},
                                                ]
                                            }],
                                            "max_tokens": 100,
                                        },
                                        timeout=30,
                                    )
                                    vdata = vresp.json()
                                    vtext = vdata.get("choices", [{}])[0].get("message", {}).get("content", "")
                                    vjson = re.search(r'\{[^}]+\}', vtext)
                                    if vjson:
                                        vparsed = json.loads(vjson.group())
                                        verified = vparsed.get("on_target", False)
                                        results.append({"step": i+1, "status": "verified" if verified else "unverified", "current": vparsed.get("current_screen", "")})
                                    else:
                                        results.append({"step": i+1, "status": "navigated_unverified"})
                                except Exception as ve:
                                    print(f"  [replay] Verify error: {ve}")
                                    results.append({"step": i+1, "status": "navigated_verify_error"})
                            else:
                                results.append({"step": i+1, "status": "navigated"})
                        else:
                            results.append({"step": i+1, "status": "no_action"})
                    else:
                        results.append({"step": i+1, "status": "no_action"})
                except Exception as e:
                    print(f"  [replay] Vision error at step {i+1}: {e}")
                    results.append({"step": i+1, "status": "error", "error": str(e)})
        else:
            results.append({"step": i+1, "status": "skipped_no_vision"})

        time.sleep(1)

    final_img = screenshot_window(window)
    final_b64 = img_to_base64(final_img) if final_img else ""
    post_result(command_id, "complete", screenshot_b64=final_b64, data={
        "replay_steps": len(steps),
        "results": results,
    })
    print(f"  [replay] Replay complete")


def uia_crawl_children(element, depth, max_depth, parent_path=""):
    """Recursively crawl UI Automation element children to build a tree."""
    children = []
    if depth >= max_depth:
        return children
    try:
        for child in element.children():
            try:
                name = (child.element_info.name or "").strip()
                ctrl_type = child.element_info.control_type or ""
                if not name:
                    continue
                if ctrl_type in ("TitleBar", "ScrollBar", "Thumb", "Image", "Separator"):
                    continue
                if len(name) > 100:
                    continue
                path = f"{parent_path} > {name}" if parent_path else name
                node = {
                    "name": name,
                    "controlType": ctrl_type,
                    "path": path,
                    "children": []
                }
                if ctrl_type in ("MenuItem", "Menu", "TreeItem", "TabItem", "ListItem", "Group", "Pane"):
                    try:
                        if ctrl_type in ("MenuItem", "Menu", "TreeItem"):
                            try:
                                child.expand()
                                time.sleep(0.3)
                            except Exception:
                                pass
                        sub_children = uia_crawl_children(child, depth + 1, max_depth, path)
                        if sub_children:
                            node["children"] = sub_children
                        if ctrl_type in ("MenuItem", "Menu", "TreeItem"):
                            try:
                                child.collapse()
                                time.sleep(0.2)
                            except Exception:
                                pass
                    except Exception:
                        pass
                children.append(node)
            except Exception:
                continue
    except Exception:
        pass
    return children


EPIC_MENU_CATEGORIES = [
    "Lab", "Patient Care", "Pharmacy", "Radiology", "Surgery",
    "CRM/CM", "Billing", "HIM", "Utilization Management",
    "Referrals", "Registration/ADT", "Scheduling", "Interfaces",
    "Reports", "Tools", "Admin", "My Settings",
    "My Toolbar Default Items", "Help",
]

EPIC_MENU_CATEGORY_POSITIONS = {
    "Lab":                      {"relX": 0.62, "relY": 0.10},
    "Patient Care":             {"relX": 0.62, "relY": 0.14},
    "Pharmacy":                 {"relX": 0.62, "relY": 0.18},
    "Radiology":                {"relX": 0.62, "relY": 0.22},
    "Surgery":                  {"relX": 0.62, "relY": 0.26},
    "CRM/CM":                   {"relX": 0.62, "relY": 0.32},
    "Billing":                  {"relX": 0.62, "relY": 0.36},
    "HIM":                      {"relX": 0.62, "relY": 0.40},
    "Utilization Management":   {"relX": 0.62, "relY": 0.44},
    "Referrals":                {"relX": 0.62, "relY": 0.48},
    "Registration/ADT":         {"relX": 0.62, "relY": 0.52},
    "Scheduling":               {"relX": 0.62, "relY": 0.56},
    "Interfaces":               {"relX": 0.62, "relY": 0.60},
    "Reports":                  {"relX": 0.62, "relY": 0.67},
    "Tools":                    {"relX": 0.62, "relY": 0.71},
    "Admin":                    {"relX": 0.62, "relY": 0.75},
    "My Settings":              {"relX": 0.62, "relY": 0.79},
    "My Toolbar Default Items": {"relX": 0.62, "relY": 0.83},
    "Help":                     {"relX": 0.62, "relY": 0.87},
}


def execute_text_menu_crawl(cmd):
    """Crawl Epic Text menus using the dedicated text scanner in epic_tree.py.

    Unlike Hyperspace (vision-based), Text menus are navigated by reading the
    terminal buffer and typing numbered menu selections. This delegates to
    epic_tree.py scan_text() which handles the full recursive crawl.
    """
    env = cmd.get("env", "SUP")
    command_id = cmd.get("id", "unknown")

    print(f"  [text-crawl] Starting Epic Text menu crawl for {env}")
    print(f"  [text-crawl] This will type menu numbers into the terminal window.")

    try:
        import subprocess
        script_dir = os.path.dirname(os.path.abspath(__file__))
        tree_script = os.path.join(script_dir, "epic_tree.py")

        if not os.path.exists(tree_script):
            post_result(command_id, "error", error="epic_tree.py not found in tools directory")
            return

        print(f"  [text-crawl] Running text scanner...")
        result = subprocess.run(
            [sys.executable, tree_script, "text", env],
            capture_output=True, text=True, timeout=600,
            env={**os.environ, "BRIDGE_TOKEN": BRIDGE_TOKEN, "ORGCLOUD_URL": ORGCLOUD_URL},
        )

        output = result.stdout + result.stderr
        print(f"  [text-crawl] Scanner exit code: {result.returncode}")
        for line in output.split("\n")[-20:]:
            if line.strip():
                print(f"  [text-crawl] {line}")

        if result.returncode == 0:
            post_result(command_id, "complete", data={
                "output": output[-2000:],
                "client": "text",
            })
        else:
            post_result(command_id, "error", error=f"Text scan failed (exit {result.returncode}): {output[-500:]}")

    except subprocess.TimeoutExpired:
        post_result(command_id, "error", error="Text menu crawl timed out (10 min limit)")
    except Exception as e:
        post_result(command_id, "error", error=f"Text crawl error: {str(e)}")


def execute_menu_crawl(cmd):
    """Crawl Epic menus using screenshot + vision AI.
    Strategy: click Epic button -> find each known category by vision -> click ->
    read sub-items -> repeat. Results are saved permanently so you only crawl once.

    For Text client, delegates to execute_text_menu_crawl which uses the
    keystroke-based scanner instead of vision."""
    env = cmd.get("env", "SUP")
    command_id = cmd.get("id", "unknown")
    depth = cmd.get("depth", 2)
    client = cmd.get("client", "hyperspace")

    if client == "text":
        return execute_text_menu_crawl(cmd)

    print(f"  [menu-crawl] Starting Epic menu crawl for {env} (depth={depth})")
    print(f"  [menu-crawl] NOTE: This will briefly control your mouse to click menu items.")
    print(f"  [menu-crawl] Please don't move the mouse during the crawl.")
    print(f"  [menu-crawl] Known categories: {len(EPIC_MENU_CATEGORIES)}")

    window = find_window(env)
    if not window:
        post_result(command_id, "error", error=f"No {env} window found")
        return

    print(f"  [menu-crawl] Maximizing {env} window to ensure all UI is visible...")
    activate_window(window, maximize=True)
    time.sleep(0.5)
    window = find_window(env)
    if not window:
        post_result(command_id, "error", error=f"Lost {env} window after maximize")
        return

    print(f"  [menu-crawl] Window: '{window.title}' at ({window.left},{window.top}) size {window.width}x{window.height}")

    def safe_screenshot():
        """Take screenshot of the Epic window."""
        try:
            img = screenshot_window(window)
            return img, img_to_base64(img)
        except Exception as e:
            print(f"  [menu-crawl] Screenshot error: {e}")
            return None, None

    def vision_find_epic_button(b64):
        """Use vision to find the Epic button coordinates."""
        prompt = (
            "Find the 'Epic' button in this Epic Hyperspace window screenshot.\n\n"
            "IMPORTANT DETAILS:\n"
            "- The Epic button is a SMALL button in the TOP-LEFT corner of the window\n"
            "- It typically shows the Epic logo (a flame/torch icon) and may say 'Epic' next to it\n"
            "- It is in the TITLE BAR or TOOLBAR area, NOT in the main content area\n"
            "- It is usually the FIRST button on the left side of the toolbar ribbon\n"
            "- Do NOT confuse it with any menu items, search bars, or dashboard items below\n"
            "- Do NOT click on any text in the main workspace area\n"
            "- The button is typically at the very top of the window, y coordinate should be small (under 100 pixels from top)\n\n"
            f"{VISION_COORD_INSTRUCTION}\n"
            "Return ONLY a JSON object: {\"x\": <number>, \"y\": <number>, \"found\": true, \"label\": \"text on button\"}\n"
            "Coordinates should be pixel positions relative to the image.\n"
            "If you cannot find it, return: {\"found\": false, \"reason\": \"why\"}"
        )
        resp = ask_claude(b64, prompt)
        if not resp:
            return None
        try:
            m = re.search(r'\{[\s\S]*?\}', resp)
            if m:
                result = json.loads(m.group())
                if result.get("found") and result.get("y", 999) > 200:
                    print(f"  [menu-crawl] WARNING: Epic button y={result['y']} seems too far down, may be wrong element")
                return result
        except Exception:
            pass
        return None

    def vision_read_menu(b64, context="", is_submenu=False):
        """Use vision to read all visible menu items with their coordinates."""
        if is_submenu:
            prompt = (
                f"You are looking at an Epic Hyperspace screen where a SUBMENU has just been opened ({context}).\n"
                "There may be multiple menu panels visible. Focus ONLY on the RIGHTMOST or TOPMOST popup/submenu panel "
                "that just appeared — this is the newly opened submenu.\n\n"
                "CRITICAL RULES:\n"
                "- IGNORE the main Epic menu categories on the left/background (like Lab, Patient Care, Pharmacy, Radiology, "
                "Surgery, Billing, HIM, Admin, Scheduling, Reports, Tools, etc.) — those are parent menu items, NOT submenu items.\n"
                "- IGNORE any 'Pinned' or 'Recent' sections — those belong to the main menu.\n"
                "- ONLY list items that are inside the NEWLY OPENED submenu panel/popup.\n"
                "- The submenu panel is usually a separate floating panel or popup that appeared after clicking.\n"
                "- If NO submenu panel is visible (the click may have opened an activity instead), return an empty array [].\n\n"
                "For EACH submenu item, provide:\n"
                "- name: the text label\n"
                f"- x, y: pixel coordinates of the CENTER of the text label (not edges/icons)\n"
                "- hasSubmenu: true if it has a right-arrow (>) indicating another level\n\n"
                "Return ONLY a JSON array:\n"
                "[{\"name\": \"item text\", \"y\": <number>, \"x\": <number>, \"hasSubmenu\": true/false}]\n\n"
                "If no submenu items are visible, return: []\n"
                "Return ONLY the JSON array, no other text."
            )
        else:
            prompt = (
                f"You are looking at an Epic Hyperspace menu{(' (' + context + ')') if context else ''}.\n"
                "List every visible menu item, category, or clickable option you can see.\n\n"
                "IMPORTANT STRUCTURE NOTES:\n"
                "- The Epic button menu typically has RECENTLY ACCESSED items at the top (with pin icons).\n"
                "- Below the recent items are the PERMANENT MENU CATEGORIES (like Patient Care, Lab, Pharmacy, Admin, etc.).\n"
                "- Mark recently accessed/pinned items with \"section\": \"recent\".\n"
                "- Mark the permanent navigation categories with \"section\": \"nav\".\n"
                "- Items with a right-arrow (>) or triangle indicator have submenus.\n"
                "- Items without arrows are terminal activities.\n\n"
                "For EACH item, provide its name and the CENTER coordinates of its text label (pixels from top-left of image).\n\n"
                "Return ONLY a JSON array:\n"
                "[{\"name\": \"item text\", \"y\": <number>, \"x\": <number>, \"hasSubmenu\": true/false, \"section\": \"recent\" or \"nav\" or \"other\"}]\n\n"
                "Be thorough - list EVERY visible menu item.\n"
                "Order items from top to bottom by Y coordinate.\n"
                "Return ONLY the JSON array, no other text."
            )
        resp = ask_claude(b64, prompt)
        if not resp:
            return []
        try:
            m = re.search(r'\[[\s\S]*\]', resp)
            if m:
                items = json.loads(m.group())
                if is_submenu:
                    known_cats_lower = [c.lower() for c in EPIC_MENU_CATEGORIES]
                    filtered = []
                    for item in items:
                        name_lower = (item.get("name", "")).lower().strip()
                        if name_lower in known_cats_lower:
                            continue
                        if name_lower in ("pinned", "recent", "recently accessed"):
                            continue
                        filtered.append(item)
                    if len(items) != len(filtered):
                        print(f"  [menu-crawl]   (filtered out {len(items) - len(filtered)} parent menu items from submenu results)")
                    return filtered
                return items
        except Exception:
            pass
        return []

    def check_screen_state(context=""):
        """Check what's on screen: menu visible, activity opened, or something else.
        Returns: ('state', b64_screenshot) where state is 'menu', 'activity', 'desktop', 'dialog', or 'unknown'"""
        check_img, check_b64 = safe_screenshot()
        if not check_b64:
            return "unknown", None
        prompt = (
            f"{EPIC_VISUAL_REFERENCE}\n"
            f"TASK: Classify this Epic screen state{(' (' + context + ')') if context else ''}.\n\n"
            "Using the visual reference, check for these IN ORDER:\n\n"
            "'menu': Is the EPIC BUTTON MENU visible? (floating two-column overlay panel from the top-left Epic button, or a submenu panel). Must be a floating overlay with distinct border/shadow, NOT the toolbar itself.\n\n"
            "'dialog': Is a DIALOG/POPUP visible? (modal overlay centered on screen with dimmed background — BPA alert, order dialog, print preview, etc.)\n\n"
            "'activity': Is a specific activity/workspace open with a patient chart or clinical form? (Check: does the toolbar show an activity name? Is a patient header visible?)\n\n"
            "'desktop': The main Epic workspace with toolbar visible but NO floating overlays (no menu panels, no dialogs). Normal working view with tabs, patient lists, or dashboard.\n\n"
            "IMPORTANT: The toolbar/ribbon is ALWAYS visible — that alone does NOT make it 'menu'. A menu requires a FLOATING OVERLAY panel.\n\n"
            "Return ONLY: {\"state\": \"menu\"|\"activity\"|\"dialog\"|\"desktop\", \"description\": \"brief description\"}"
        )
        resp = ask_claude(check_b64, prompt)
        if not resp:
            return "unknown", check_b64
        try:
            m = re.search(r'\{[\s\S]*?\}', resp)
            if m:
                result = json.loads(m.group())
                state = result.get("state", "unknown")
                desc = result.get("description", "")
                print(f"  [state-check] {state}: {desc}")
                return state, check_b64
        except Exception:
            pass
        return "unknown", check_b64

    def recover_to_menu():
        """Get back to the Epic menu from any state. Returns True if successful."""
        for attempt in range(3):
            state, _ = check_screen_state("recovery attempt")
            if state == "menu":
                print(f"  [recovery] Menu is visible")
                return True
            elif state == "dialog":
                print(f"  [recovery] Dialog detected - pressing Escape")
                pyautogui.press("escape")
                time.sleep(0.5)
            elif state == "activity":
                print(f"  [recovery] Activity opened - pressing Escape to close")
                pyautogui.press("escape")
                time.sleep(0.5)
                state2, _ = check_screen_state("after escape")
                if state2 == "activity":
                    print(f"  [recovery] Still in activity - trying Alt+F4")
                    pyautogui.hotkey("alt", "F4")
                    time.sleep(0.5)
                    state3, _ = check_screen_state("after alt-f4")
                    if state3 == "dialog":
                        print(f"  [recovery] Close dialog - pressing N for No/Don't Save")
                        pyautogui.press("n")
                        time.sleep(0.5)
            elif state == "desktop":
                print(f"  [recovery] At desktop - reopening Epic menu")
                reopen_epic_menu()
                time.sleep(0.5)
                continue
            else:
                print(f"  [recovery] Unknown state - pressing Escape")
                pyautogui.press("escape")
                time.sleep(0.5)

        state_final, _ = check_screen_state("final check")
        if state_final == "menu":
            return True
        print(f"  [recovery] Reopening Epic menu as last resort")
        pyautogui.press("escape")
        time.sleep(0.3)
        pyautogui.press("escape")
        time.sleep(0.3)
        reopen_epic_menu()
        return True

    def vision_check_scrollable(b64, context=""):
        """Ask vision if the current menu/panel has a scrollbar or more items below."""
        prompt = (
            f"Look at this Epic Hyperspace menu screenshot{(' (' + context + ')') if context else ''}.\n\n"
            "Does this menu panel have a VERTICAL SCROLLBAR on its right edge, or a scroll indicator "
            "(down arrow, more items below the visible area, a scroll thumb/track)?\n\n"
            "Look specifically for:\n"
            "- A vertical scrollbar track on the right side of the menu/submenu panel\n"
            "- A small down-arrow at the bottom of the menu\n"
            "- A scroll thumb that is NOT at the bottom (meaning more content below)\n"
            "- Any visual indicator that the list continues beyond what is visible\n\n"
            "Return ONLY a JSON object:\n"
            "{\"scrollable\": true/false, \"scrollbarX\": <x pixel of scrollbar center or right edge of menu>, "
            "\"menuTopY\": <top y of menu panel>, \"menuBottomY\": <bottom y of menu panel>, "
            "\"reason\": \"brief explanation\"}\n\n"
            "If not scrollable or no scrollbar visible, set scrollbarX/menuTopY/menuBottomY to 0."
        )
        resp = ask_claude(b64, prompt)
        if not resp:
            return {"scrollable": False}
        try:
            m = re.search(r'\{[\s\S]*?\}', resp)
            if m:
                return json.loads(m.group())
        except Exception:
            pass
        return {"scrollable": False}

    def scroll_and_read_all_items(b64, context, is_submenu, indent):
        """Read all menu items including those below the scroll fold.

        Takes the initial screenshot b64, reads visible items, then checks
        for a scrollbar. If scrollable, scrolls down and reads more items,
        deduplicating by name. Repeats until no new items appear.

        Each item gets a '_scroll_round' field (0 = first screen, 1+ = after scrolling)
        so the crawler knows which items need scroll repositioning before clicking.
        """
        all_items = vision_read_menu(b64, context, is_submenu=is_submenu)
        for item in all_items:
            item["_scroll_round"] = 0
        seen_names = set(item.get("name", "").lower().strip() for item in all_items)

        scroll_info = vision_check_scrollable(b64, context)
        if not scroll_info.get("scrollable", False):
            return all_items

        scrollbar_x = scroll_info.get("scrollbarX", 0)
        menu_top = scroll_info.get("menuTopY", 0)
        menu_bottom = scroll_info.get("menuBottomY", 0)
        print(f"  [menu-crawl]{indent}  Scrollbar detected ({scroll_info.get('reason', '?')}), scrolling for more items...")

        if scrollbar_x > 0 and menu_top > 0 and menu_bottom > 0:
            menu_center_x = scrollbar_x - 40
            menu_center_y = (menu_top + menu_bottom) // 2
            scroll_screen_x, scroll_screen_y = vision_to_screen(window, menu_center_x, menu_center_y)
        else:
            last_item = all_items[-1] if all_items else None
            if last_item and last_item.get("x", 0) > 0:
                scroll_screen_x, scroll_screen_y = vision_to_screen(window, last_item["x"], last_item["y"])
            else:
                return all_items

        max_scrolls = 8
        scrolls_done = 0
        for scroll_round in range(max_scrolls):
            pyautogui.moveTo(scroll_screen_x, scroll_screen_y)
            time.sleep(0.1)
            pyautogui.scroll(-5)
            time.sleep(0.5)
            scrolls_done += 1

            new_img, new_b64 = safe_screenshot()
            if not new_b64:
                break

            new_items = vision_read_menu(new_b64, f"{context} (scrolled {scroll_round + 1}x)", is_submenu=is_submenu)
            added = 0
            for item in new_items:
                name_key = item.get("name", "").lower().strip()
                if name_key and name_key not in seen_names:
                    seen_names.add(name_key)
                    item["_scroll_round"] = scroll_round + 1
                    all_items.append(item)
                    added += 1

            print(f"  [menu-crawl]{indent}  Scroll {scroll_round + 1}: found {added} new items ({len(all_items)} total)")

            if added == 0:
                break

            still_scrollable = vision_check_scrollable(new_b64, f"{context} after scroll {scroll_round + 1}")
            if not still_scrollable.get("scrollable", False):
                break

        if scrolls_done > 0:
            print(f"  [menu-crawl]{indent}  Scrolling back to top...")
            pyautogui.moveTo(scroll_screen_x, scroll_screen_y)
            time.sleep(0.1)
            pyautogui.scroll(5 * scrolls_done + 10)
            time.sleep(0.3)

        return all_items, scrolls_done, scroll_screen_x, scroll_screen_y

    def crawl_submenu(parent_path, current_depth, max_depth, reopen_epic_fn):
        """Recursively crawl a submenu. Returns (children_list, item_count).
        Self-healing: detects when clicks go wrong and recovers automatically.
        Handles scrollable menus by scrolling down and reading additional items."""
        sub_img, sub_b64 = safe_screenshot()
        if not sub_b64:
            return [], 0

        context = f"submenu of '{parent_path}'" if parent_path else "Epic menu"
        indent = "  " * (current_depth + 1)

        items = scroll_and_read_all_items(sub_b64, context, is_submenu=(current_depth > 1), indent=indent)
        print(f"  [menu-crawl]{indent}'{parent_path}' -> {len(items)} items (after scroll check)")

        if len(items) == 0:
            state, _ = check_screen_state(f"after clicking {parent_path}")
            if state == "activity":
                print(f"  [menu-crawl]{indent}  (click launched an activity instead of submenu - recovering)")
                recover_to_menu()
            elif state == "desktop":
                print(f"  [menu-crawl]{indent}  (menu closed - recovering)")
                recover_to_menu()
            return [], 0

        children = []
        count = 0

        for si in items:
            si_name = si.get("name", "?")
            si_path = f"{parent_path} > {si_name}" if parent_path else si_name
            has_sub = si.get("hasSubmenu", False)

            si_x = si.get("x", 0)
            si_y = si.get("y", 0)
            si_node = {
                "name": si_name,
                "controlType": "MenuItem" if has_sub else "Activity",
                "path": si_path,
                "imgX": si_x,
                "imgY": si_y,
                "children": []
            }
            count += 1

            if has_sub and current_depth < max_depth:
                try:
                    print(f"  [menu-crawl]{indent}  -> Expanding '{si_name}'...")
                    click_x, click_y = vision_to_screen(window, si_x, si_y)

                    safe_click(click_x, click_y, pause_after=0.8, label=f"{si_name} (submenu expand)")
                    time.sleep(0.4)

                    state, _ = check_screen_state(f"after expanding {si_name}")
                    if state == "activity":
                        print(f"  [menu-crawl]{indent}     '{si_name}' opened an activity (not a submenu) - recovering")
                        si_node["controlType"] = "Activity"
                        recover_to_menu()
                        reopen_epic_fn()
                        time.sleep(0.5)
                    elif state == "desktop":
                        print(f"  [menu-crawl]{indent}     Menu closed after clicking '{si_name}' - recovering")
                        recover_to_menu()
                    elif state == "menu":
                        sub_children, sub_count = crawl_submenu(si_path, current_depth + 1, max_depth, reopen_epic_fn)
                        si_node["children"] = sub_children
                        count += sub_count
                        pyautogui.press("escape")
                        time.sleep(0.5)
                    else:
                        print(f"  [menu-crawl]{indent}     Unknown state after clicking '{si_name}': {state} - recovering")
                        recover_to_menu()

                except Exception as e:
                    print(f"  [menu-crawl]{indent}  !! Error expanding '{si_name}': {e}")
                    try:
                        recover_to_menu()
                    except Exception:
                        pass
            else:
                print(f"  [menu-crawl]{indent}  -> Activity: '{si_name}' (recorded, not clicked)")

            children.append(si_node)

        return children, count

    try:
        img, b64 = safe_screenshot()
        if not b64:
            post_result(command_id, "error", error="Cannot take screenshot")
            return

        print(f"  [menu-crawl] Step 1: Finding Epic button...")
        epic_loc = vision_find_epic_button(b64)

        if not epic_loc or not epic_loc.get("found"):
            reason = epic_loc.get("reason", "unknown") if epic_loc else "vision failed"
            print(f"  [menu-crawl] Epic button not found: {reason}")
            post_result(command_id, "error", error=f"Could not find Epic button: {reason}")
            return

        epic_abs_x, epic_abs_y = vision_to_screen(window, epic_loc["x"], epic_loc["y"])
        print(f"  [menu-crawl] Found Epic button at img({epic_loc['x']}, {epic_loc['y']}) -> screen({epic_abs_x}, {epic_abs_y}): '{epic_loc.get('label', '?')}'")

        def reopen_epic_menu():
            """Re-open the Epic button menu with verification."""
            for attempt in range(3):
                safe_click(epic_abs_x, epic_abs_y, pause_after=1.2, label="Epic button (reopen)")
                state, _ = check_screen_state("after clicking Epic button")
                if state == "menu":
                    print(f"  [menu] Epic menu opened successfully")
                    return True
                elif state == "desktop":
                    print(f"  [menu] Menu didn't open (attempt {attempt+1}/3) - clicking again")
                    time.sleep(0.5)
                elif state == "activity":
                    print(f"  [menu] Activity visible instead of menu - pressing Escape first")
                    pyautogui.press("escape")
                    time.sleep(0.5)
                else:
                    print(f"  [menu] State after click: {state} (attempt {attempt+1}/3)")
                    pyautogui.press("escape")
                    time.sleep(0.3)
            print(f"  [menu] WARNING: Could not confirm menu opened after 3 attempts")
            return False

        menu_opened = reopen_epic_menu()
        if not menu_opened:
            post_result(command_id, "error", error="Could not open Epic menu after multiple attempts")
            return

        print(f"  [menu-crawl] Step 2: Detecting menu boundaries...")
        img, b64 = safe_screenshot()
        if not b64:
            post_result(command_id, "error", error="Cannot screenshot after Epic button click")
            return

        def vision_detect_menu_bounds(b64_img):
            """Use ONE vision call to detect the Epic menu popup boundaries."""
            prompt = (
                "This screenshot shows the Epic Hyperspace application with its main menu popup open.\n"
                "The menu popup is a large floating panel that covers part of the screen.\n"
                "It has a search bar at the top, a left panel (Pinned/Recent), and a right panel (navigation categories).\n\n"
                "I need you to identify the BOUNDING BOX of the entire menu popup in pixel coordinates.\n"
                "Also identify the pixel coordinates of these TWO specific items to calibrate positioning:\n"
                "1. The 'Lab' category (first item in the right column)\n"
                "2. The 'Help' category (last item in the right column)\n\n"
                "Return ONLY: {\"menuLeft\": <int>, \"menuTop\": <int>, \"menuRight\": <int>, \"menuBottom\": <int>, "
                "\"labX\": <int>, \"labY\": <int>, \"helpX\": <int>, \"helpY\": <int>, \"found\": true}\n"
                "All coordinates are pixels relative to the image.\n"
                "If the menu is not visible: {\"found\": false}"
            )
            resp = ask_claude(b64_img, prompt)
            if not resp:
                return None
            try:
                fm = re.search(r'\{[\s\S]*?\}', resp)
                if fm:
                    return json.loads(fm.group())
            except Exception:
                pass
            return None

        menu_bounds = vision_detect_menu_bounds(b64)
        if not menu_bounds or not menu_bounds.get("found"):
            print(f"  [menu-crawl] Could not detect menu boundaries, falling back to vision per-item")
            menu_bounds = None
        else:
            m_left = menu_bounds["menuLeft"]
            m_top = menu_bounds["menuTop"]
            m_right = menu_bounds["menuRight"]
            m_bottom = menu_bounds["menuBottom"]
            m_width = m_right - m_left
            m_height = m_bottom - m_top
            lab_x = menu_bounds.get("labX", 0)
            lab_y = menu_bounds.get("labY", 0)
            help_x = menu_bounds.get("helpX", 0)
            help_y = menu_bounds.get("helpY", 0)
            print(f"  [menu-crawl] Menu bounds: ({m_left},{m_top}) to ({m_right},{m_bottom}) = {m_width}x{m_height}px")
            print(f"  [menu-crawl] Lab at ({lab_x},{lab_y}), Help at ({help_x},{help_y})")
            print(f"  [menu-crawl] Will use hardcoded positions interpolated between Lab and Help")

        def get_category_img_coords(cat_name):
            """Get pixel coordinates for a category using calibrated menu bounds."""
            if not menu_bounds:
                return None
            pos = EPIC_MENU_CATEGORY_POSITIONS.get(cat_name)
            if not pos:
                return None
            lab_y = menu_bounds.get("labY", 0)
            help_y = menu_bounds.get("helpY", 0)
            cat_x = menu_bounds.get("labX", 0)

            lab_rel = EPIC_MENU_CATEGORY_POSITIONS["Lab"]["relY"]
            help_rel = EPIC_MENU_CATEGORY_POSITIONS["Help"]["relY"]
            cat_rel = pos["relY"]

            if help_rel != lab_rel:
                t = (cat_rel - lab_rel) / (help_rel - lab_rel)
                cat_y = int(lab_y + t * (help_y - lab_y))
            else:
                cat_y = lab_y

            return {"x": cat_x, "y": cat_y, "found": True, "method": "calibrated"}

        def vision_find_item(b64_img, item_name):
            """Fallback: use vision to find a specific category if calibration failed."""
            prompt = (
                f"Find the navigation category labeled \"{item_name}\" in this Epic menu.\n"
                f"It should be in the RIGHT column with a > arrow. The left column is Pinned/Recent - ignore it.\n"
                f"Return ONLY: {{\"x\": <int>, \"y\": <int>, \"found\": true}}\n"
                f"If not found: {{\"found\": false}}"
            )
            resp = ask_claude(b64_img, prompt)
            if not resp:
                return None
            try:
                fm = re.search(r'\{[\s\S]*?\}', resp)
                if fm:
                    return json.loads(fm.group())
            except Exception:
                pass
            return None

        existing_tree = fetch_cached_tree(env, "hyperspace")
        existing_cats = {}
        if existing_tree and existing_tree.get("children"):
            for child in existing_tree["children"]:
                cname = child.get("name", "")
                if cname and child.get("children"):
                    existing_cats[cname.lower()] = child
            if existing_cats:
                print(f"  [menu-crawl] Found existing tree with {len(existing_cats)} populated categories — will skip those")

        print(f"  [menu-crawl] Step 2b: Reading recent items from left panel...")
        recent_prompt = (
            "Look at the LEFT panel of this Epic menu. It shows 'Pinned' and 'Recent' sections.\n"
            "List every item under Pinned and Recent.\n"
            "Return ONLY a JSON array: [{\"name\": \"item text\", \"section\": \"pinned\" or \"recent\"}]\n"
            "If no items, return []"
        )
        recent_resp = ask_claude(b64, recent_prompt)
        recent_items = []
        if recent_resp:
            try:
                rm = re.search(r'\[[\s\S]*\]', recent_resp)
                if rm:
                    recent_items = json.loads(rm.group())
            except Exception:
                pass

        if recent_items:
            print(f"  [menu-crawl] Recent/pinned items ({len(recent_items)}):")
            for ri in recent_items:
                print(f"    [{ri.get('section', '?')}] '{ri.get('name', '?')}'")

        tree_children = []
        crawled_count = 0

        if recent_items:
            recent_node = {
                "name": "Recently Accessed",
                "controlType": "Section",
                "path": "Recently Accessed",
                "children": []
            }
            for ri in recent_items:
                recent_node["children"].append({
                    "name": ri.get("name", "?"),
                    "controlType": "Activity",
                    "path": f"Recently Accessed > {ri.get('name', '?')}",
                    "children": []
                })
                crawled_count += 1
            tree_children.append(recent_node)
            crawled_count += 1

        cats_to_crawl = []
        cats_reused = []
        for cat_name in EPIC_MENU_CATEGORIES:
            cached = existing_cats.get(cat_name.lower())
            if cached and len(cached.get("children", [])) > 0:
                tree_children.append(cached)
                reused_count = sum(1 for _ in _iter_nodes(cached))
                crawled_count += reused_count
                cats_reused.append(cat_name)
            else:
                cats_to_crawl.append(cat_name)

        if cats_reused:
            print(f"  [menu-crawl] Reusing {len(cats_reused)} already-crawled categories: {', '.join(cats_reused)}")
        if not cats_to_crawl:
            print(f"  [menu-crawl] All categories already crawled! Nothing new to scan.")
            print(f"  [menu-crawl] To force a full re-crawl, clear the tree first with: epic tree --clear {env}")
        else:
            print(f"  [menu-crawl] Will crawl {len(cats_to_crawl)} new categories: {', '.join(cats_to_crawl)}")

        print(f"  [menu-crawl] Step 3: Crawling {len(cats_to_crawl)} categories...")

        consecutive_failures = 0
        menu_confirmed_open = True
        for i, cat_name in enumerate(cats_to_crawl):
            print(f"  [menu-crawl] === [{i+1}/{len(cats_to_crawl)}] '{cat_name}' ===")

            if consecutive_failures >= 5:
                print(f"  [menu-crawl] 5 consecutive failures - stopping crawl early to save what we have")
                break

            node = {
                "name": cat_name,
                "controlType": "MenuItem",
                "path": cat_name,
                "children": []
            }
            crawled_count += 1

            try:
                if not menu_confirmed_open:
                    state_before, _ = check_screen_state(f"before looking for {cat_name}")
                    if state_before != "menu":
                        print(f"  [menu-crawl]   Menu not open (state={state_before}), reopening...")
                        pyautogui.press("escape")
                        time.sleep(0.3)
                        pyautogui.press("escape")
                        time.sleep(0.3)
                        if not reopen_epic_menu():
                            print(f"  [menu-crawl]   Cannot reopen menu, skipping '{cat_name}'")
                            consecutive_failures += 1
                            tree_children.append(node)
                            continue
                    menu_confirmed_open = True

                loc = get_category_img_coords(cat_name)
                if loc and loc.get("found"):
                    print(f"  [menu-crawl]   Using calibrated position for '{cat_name}' (no vision call needed)")
                else:
                    img, b64 = safe_screenshot()
                    if not b64:
                        print(f"  [menu-crawl]   Screenshot failed, skipping '{cat_name}'")
                        consecutive_failures += 1
                        tree_children.append(node)
                        continue
                    loc = vision_find_item(b64, cat_name)
                    if not loc or not loc.get("found"):
                        reason = loc.get("reason", "not found") if loc else "vision failed"
                        print(f"  [menu-crawl]   Could not find '{cat_name}': {reason}")
                        consecutive_failures += 1
                        tree_children.append(node)
                        continue

                cat_img_x = loc["x"]
                cat_img_y = loc["y"]
                click_x, click_y = vision_to_screen(window, cat_img_x, cat_img_y)
                print(f"  [menu-crawl]   Found '{cat_name}' at img({cat_img_x},{cat_img_y}) -> screen({click_x},{click_y})")

                node["imgX"] = cat_img_x
                node["imgY"] = cat_img_y

                safe_click(click_x, click_y, pause_after=0.8, label=f"{cat_name} (category)")

                state_after_click, _ = check_screen_state(f"after clicking category {cat_name}")
                if state_after_click == "activity":
                    print(f"  [menu-crawl]   '{cat_name}' opened an activity (not a submenu) - recovering")
                    node["controlType"] = "Activity"
                    recover_to_menu()
                    menu_confirmed_open = reopen_epic_menu()
                    consecutive_failures = 0
                elif state_after_click == "desktop":
                    print(f"  [menu-crawl]   Click closed the menu - reopening and retrying '{cat_name}'...")
                    menu_confirmed_open = reopen_epic_menu()
                    if menu_confirmed_open:
                        img_retry, b64_retry = safe_screenshot()
                        if b64_retry:
                            loc_retry = get_category_img_coords(cat_name)
                            if not loc_retry or not loc_retry.get("found"):
                                loc_retry = vision_find_item(b64_retry, cat_name)
                            if loc_retry and loc_retry.get("found"):
                                retry_x, retry_y = vision_to_screen(window, loc_retry["x"], loc_retry["y"])
                                safe_click(retry_x, retry_y, pause_after=0.8, label=f"{cat_name} (retry)")
                                state_retry, _ = check_screen_state(f"retry click {cat_name}")
                                if state_retry in ("menu", "unknown"):
                                    sub_children, sub_count = crawl_submenu(cat_name, 2, depth + 1, reopen_epic_menu)
                                    node["children"] = sub_children
                                    crawled_count += sub_count
                                    pyautogui.press("escape")
                                    time.sleep(0.3)
                                    pyautogui.press("escape")
                                    time.sleep(0.3)
                                    menu_confirmed_open = reopen_epic_menu()
                                    consecutive_failures = 0
                                elif state_retry == "activity":
                                    node["controlType"] = "Activity"
                                    recover_to_menu()
                                    menu_confirmed_open = reopen_epic_menu()
                                    consecutive_failures = 0
                                else:
                                    print(f"  [menu-crawl]   Retry also failed for '{cat_name}' - moving on")
                                    recover_to_menu()
                                    menu_confirmed_open = reopen_epic_menu()
                                    consecutive_failures += 1
                            else:
                                print(f"  [menu-crawl]   Could not relocate '{cat_name}' on retry")
                                consecutive_failures += 1
                        else:
                            consecutive_failures += 1
                    else:
                        consecutive_failures += 1
                elif state_after_click in ("menu", "unknown"):
                    sub_children, sub_count = crawl_submenu(cat_name, 2, depth + 1, reopen_epic_menu)
                    node["children"] = sub_children
                    crawled_count += sub_count

                    pyautogui.press("escape")
                    time.sleep(0.3)
                    pyautogui.press("escape")
                    time.sleep(0.3)
                    menu_confirmed_open = reopen_epic_menu()
                    consecutive_failures = 0
                else:
                    print(f"  [menu-crawl]   Unexpected state: {state_after_click} - recovering")
                    recover_to_menu()
                    menu_confirmed_open = reopen_epic_menu()
                    consecutive_failures += 1

            except Exception as e:
                print(f"  [menu-crawl] !! Error crawling '{cat_name}': {e}")
                traceback.print_exc()
                consecutive_failures += 1
                menu_confirmed_open = False
                try:
                    recover_to_menu()
                    menu_confirmed_open = reopen_epic_menu()
                except Exception:
                    pass

            tree_children.append(node)
            print(f"  [menu-crawl]   '{cat_name}' done: {len(node.get('children', []))} children")

            print(f"  [menu-crawl]   Saving progress ({len(tree_children)} categories so far)...")
            progress_tree = {
                "name": "Epic Menu",
                "children": tree_children[:],
                "client": "hyperspace",
                "environment": env,
                "scannedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "locked": True,
                "epicButtonImgX": epic_loc.get("x", 0),
                "epicButtonImgY": epic_loc.get("y", 0),
                "windowWidth": window.width,
                "windowHeight": window.height,
                "windowLeft": window.left,
                "windowTop": window.top,
                "imageWidth": 0,
                "imageHeight": 0,
                "dpiScale": DPI_SCALE,
            }
            save_resp = _bridge_request(
                "post", "/api/epic/tree", "tree-progress-save", timeout=30, max_retries=2,
                headers={
                    "Authorization": f"Bearer {BRIDGE_TOKEN}",
                    "Content-Type": "application/json",
                },
                json=progress_tree,
            )
            if save_resp and save_resp.status_code == 200:
                print(f"  [menu-crawl]   Progress saved OK")
            else:
                print(f"  [menu-crawl]   Progress save failed (non-fatal)")

        pyautogui.press("escape")
        time.sleep(0.3)

        print(f"  [menu-crawl] Step 3: Uploading final tree ({crawled_count} items)...")

        crawl_img = screenshot_window(window)
        crawl_img_w, crawl_img_h = crawl_img.size if crawl_img else (0, 0)

        tree = {
            "name": "Epic Menu",
            "children": tree_children,
            "client": "hyperspace",
            "environment": env,
            "scannedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "locked": True,
            "epicButtonImgX": epic_loc.get("x", 0),
            "epicButtonImgY": epic_loc.get("y", 0),
            "windowWidth": window.width,
            "windowHeight": window.height,
            "windowLeft": window.left,
            "windowTop": window.top,
            "imageWidth": crawl_img_w,
            "imageHeight": crawl_img_h,
            "dpiScale": DPI_SCALE,
        }

        resp = _bridge_request(
            "post", "/api/epic/tree", "tree-upload", timeout=30, max_retries=3,
            headers={
                "Authorization": f"Bearer {BRIDGE_TOKEN}",
                "Content-Type": "application/json",
            },
            json=tree,
        )
        if resp and resp.status_code == 200:
            print(f"  [menu-crawl] Tree uploaded and locked: {crawled_count} items")
        elif resp:
            print(f"  [menu-crawl] Upload failed: HTTP {resp.status_code}")
        else:
            print(f"  [menu-crawl] Upload failed: no response")

        final_img = screenshot_window(window)
        final_b64 = img_to_base64(final_img) if final_img else None
        post_result(command_id, "complete", screenshot_b64=final_b64, data={
            "totalItems": crawled_count,
            "topLevel": len(tree_children),
            "locked": True,
        })
        print(f"  [menu-crawl] COMPLETE! {crawled_count} items across {len(tree_children)} sections")
        print(f"  [menu-crawl] Tree is locked. Future navigation uses the saved map - no re-crawling needed.")

    except Exception as e:
        print(f"  [menu-crawl] Error: {e}")
        traceback.print_exc()
        post_result(command_id, "error", error=str(e))


def execute_search_crawl(cmd):
    """Discover all Epic activities by iterating through prefixes in the search bar.
    Phase 1: Discover working search opener shortcut and verify bar can be cleared
             using shared adaptive_clear_search_bar (end+bksp, shift-select, escape+reopen, delete).
    Phase 2: Smart prefix search - starts with 2-letter combos (aa-zz) since
             Epic search requires minimum 2 chars. Expands to 3-4 char prefixes
             only where results are truncated. Search is FUZZY so all returned
             items are collected regardless of prefix match. Saves progress
             after every batch."""
    env = cmd.get("env", "SUP")
    command_id = cmd.get("id", "unknown")

    print(f"  [search-crawl] Starting activity discovery via search bar for {env}")

    window = find_window(env)
    if not window:
        post_result(command_id, "error", error=f"No {env} window found")
        return

    activate_window(window, maximize=True)
    time.sleep(0.5)
    window = find_window(env)
    if not window:
        post_result(command_id, "error", error=f"Lost {env} window after maximize")
        return

    existing_key = f"epic_activities_{env.lower()}"
    existing_activities = {}
    completed_prefixes = set()
    proven_clear_method = None
    proven_search_method_saved = None
    try:
        resp = _bridge_request(
            "get", f"/api/config/{existing_key}", "fetch-activities", timeout=10,
            headers={"Authorization": f"Bearer {BRIDGE_TOKEN}"},
        )
        if resp and resp.status_code == 200:
            data = resp.json()
            val = data.get("value", "")
            if val:
                existing_data = json.loads(val) if isinstance(val, str) else val
                for act in existing_data.get("activities", []):
                    existing_activities[act.get("name", "").lower().strip()] = act
                completed_prefixes = set(existing_data.get("completedPrefixes", []))
                proven_clear_method = existing_data.get("clearMethod", None)
                proven_search_method_saved = existing_data.get("searchMethod", None)
                print(f"  [search-crawl] Resumed: {len(existing_activities)} activities, {len(completed_prefixes)} prefixes done")
                if proven_clear_method:
                    print(f"  [search-crawl] Previously proven clear method: {proven_clear_method}")
                if proven_search_method_saved:
                    print(f"  [search-crawl] Previously proven search method: {proven_search_method_saved}")
    except Exception as e:
        print(f"  [search-crawl] Could not load existing activities: {e}")

    all_activities = dict(existing_activities)

    TRUNCATION_THRESHOLD = 8
    MAX_PREFIX_LEN = 4

    def save_progress(completed):
        act_list = list(all_activities.values())
        payload = {
            "activities": act_list,
            "environment": env,
            "discoveredAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "totalCount": len(act_list),
            "completedPrefixes": sorted(list(completed)),
            "clearMethod": proven_clear_method,
            "searchMethod": proven_search_method,
        }
        _bridge_request(
            "put", f"/api/config/{existing_key}", "save-activities", timeout=30, max_retries=2,
            headers={"Authorization": f"Bearer {BRIDGE_TOKEN}", "Content-Type": "application/json"},
            json={"value": json.dumps(payload), "category": "epic"},
        )

    def read_search_bar_text():
        """Lightweight vision call that ONLY reads the search bar text (no item listing).
        Used during calibration to minimize cost."""
        img = screenshot_window(window)
        b64 = img_to_base64(img)
        if not b64:
            return None
        prompt = (
            "Look at this Epic Hyperspace screen. "
            "Is the search bar at the top ACTIVATED/FOCUSED? "
            "An ACTIVATED search bar has TWO key visual indicators: "
            "(1) It has a BLUE BORDER/OUTLINE around it, and "
            "(2) It is horizontally MUCH WIDER/LONGER than its resting state — "
            "it expands to take up most of the toolbar width. "
            "It also shows placeholder text 'Search (Ctrl+Space)' when empty and focused. "
            "If the search bar is narrow/short with no blue border, it is NOT activated. "
            "If an activated search bar is visible: "
            "  - Read the EXACT text typed in it "
            "  - Estimate the CENTER coordinates of the text input area as x,y (as percentage of image width/height, 0-100) "
            "Return ONLY: {\"visible\": true/false, \"text\": \"exact contents or empty string\", "
            "\"centerX\": number 0-100, \"centerY\": number 0-100}"
        )
        resp_text = ask_claude(b64, prompt)
        if not resp_text:
            return None
        try:
            m = re.search(r'\{[\s\S]*?\}', resp_text)
            if m:
                return json.loads(m.group())
        except Exception:
            pass
        return None

    def read_search_results():
        """Full vision call that reads search bar text AND autocomplete dropdown items."""
        img = screenshot_window(window)
        b64 = img_to_base64(img)
        if not b64:
            return None
        prompt = (
            "You are looking at an Epic Hyperspace screen.\n\n"
            "FIRST: Check if the SEARCH BAR at the top is EXPANDED (wide/lengthened).\n"
            "- When activated (Ctrl+Space), the search bar expands horizontally to become much wider.\n"
            "- An expanded/wide search bar = active and focused (searchBarVisible: true).\n"
            "- A narrow/collapsed search bar or no search bar = NOT active (searchBarVisible: false).\n"
            "- If the search bar is expanded, read the EXACT text currently in it.\n\n"
            "SECOND: If a search dropdown/autocomplete list is showing, list every item:\n"
            "- name: the full activity name as displayed\n"
            "- category: if a category/section label is shown\n\n"
            "THIRD: Check if the dropdown appears TRUNCATED:\n"
            "- Scrollbar on the dropdown\n"
            "- 'more results' or '...' text\n"
            "- List cut off at bottom edge\n"
            "- 8+ results suggesting more exist\n\n"
            "Return ONLY a JSON object:\n"
            "{\"searchBarVisible\": true/false, "
            "\"searchBarText\": \"exact text in search field or empty string\", "
            "\"items\": [{\"name\": \"Activity Name\", \"category\": \"Category\"}], "
            "\"truncated\": true/false, "
            "\"reason\": \"brief explanation\"}\n\n"
            "Return ONLY the JSON, no other text."
        )
        resp_text = ask_claude(b64, prompt)
        if not resp_text:
            return None
        try:
            m = re.search(r'\{[\s\S]*\}', resp_text)
            if m:
                parsed = json.loads(m.group())
                items = parsed.get("items", [])
                if not parsed.get("truncated", False) and len(items) >= TRUNCATION_THRESHOLD:
                    parsed["truncated"] = True
                return parsed
        except Exception:
            pass
        return None

    proven_search_method = proven_search_method_saved

    def _kbd_ctrl_space():
        set_keyboard_backend("keybd_event")
        sendinput_hotkey("ctrl", "space")
        set_keyboard_backend("sendinput")

    def _kbd_alt_space():
        set_keyboard_backend("keybd_event")
        sendinput_hotkey("alt", "space")
        set_keyboard_backend("sendinput")

    SEARCH_OPENERS = [
        ("sendinput_ctrl_space", lambda: sendinput_hotkey("ctrl", "space")),
        ("keybd_event_ctrl_space", _kbd_ctrl_space),
        ("pyautogui_ctrl_space", lambda: pyautogui.hotkey("ctrl", "space")),
        ("sendinput_alt_space", lambda: sendinput_hotkey("alt", "space")),
        ("keybd_event_alt_space", _kbd_alt_space),
        ("pyautogui_alt_space", lambda: pyautogui.hotkey("alt", "space")),
        ("sendinput_ctrl_f", lambda: sendinput_hotkey("ctrl", "f")),
        ("sendinput_f3", lambda: sendinput_press("f3")),
    ]

    search_method_successes = 0
    search_method_failures = 0

    def _is_bar_open():
        """Quick vision check: is the search bar already open?"""
        state = read_search_bar_text()
        return (state is not None and state.get("visible", False)), state

    def _fast_clear():
        """Quick clear using End+Backspace (no vision verification)."""
        fast_clear_search_bar()

    def _clear_bar():
        """Adaptive clear with vision verification. Delegates to shared module-level function."""
        return adaptive_clear_search_bar(window, open_search_fn=_open_search_bar)

    def _try_search_opener(name, fn):
        """Try a single search opener, return True if search bar appeared."""
        print(f"  [search-crawl]     Trying: {name}")
        fn()
        time.sleep(1.0)
        state = read_search_bar_text()
        if state and state.get("visible", False):
            print(f"  [search-crawl]     === {name}: WORKS (search bar visible) ===")
            return True
        visible = state.get("visible", False) if state else "vision_failed"
        print(f"  [search-crawl]     {name}: FAILED (visible={visible})")
        pyautogui.press("escape")
        time.sleep(0.3)
        return False

    def ensure_search_focused():
        """Open the search bar if not already open. Toggle-aware.
        Returns True if confirmed open, False if all methods failed."""
        nonlocal proven_search_method, search_method_successes, search_method_failures
        activate_window(window)
        time.sleep(0.3)

        already_open, _ = _is_bar_open()
        if already_open:
            print(f"  [search-crawl]   Search bar already open, skipping shortcut")
            return True

        if proven_search_method:
            found_in_list = False
            for name, fn in SEARCH_OPENERS:
                if name == proven_search_method:
                    found_in_list = True
                    if search_method_successes >= 3:
                        fn()
                        time.sleep(0.8)
                        if search_method_successes % 5 == 0:
                            bar_open, _ = _is_bar_open()
                            if not bar_open:
                                search_method_failures += 1
                                print(f"  [search-crawl]   Trusted method {name} failed periodic check ({search_method_failures})")
                                if search_method_failures >= 2:
                                    print(f"  [search-crawl]   Re-discovering search method...")
                                    search_method_successes = 0
                                    search_method_failures = 0
                                    proven_search_method = None
                                    pyautogui.press("escape")
                                    time.sleep(0.3)
                                    break
                                pyautogui.press("escape")
                                time.sleep(0.3)
                                fn()
                                time.sleep(1.0)
                                bar_open2, _ = _is_bar_open()
                                if bar_open2:
                                    search_method_failures = 0
                                    search_method_successes += 1
                                    return True
                                print(f"  [search-crawl]   Retry failed, re-discovering...")
                                search_method_successes = 0
                                search_method_failures = 0
                                proven_search_method = None
                                pyautogui.press("escape")
                                time.sleep(0.3)
                                break
                        search_method_successes += 1
                        return True

                    print(f"  [search-crawl]   Using saved search method: {name}")
                    fn()
                    time.sleep(1.0)
                    bar_open, _ = _is_bar_open()
                    if bar_open:
                        search_method_successes += 1
                        search_method_failures = 0
                        print(f"  [search-crawl]   Saved method {name}: confirmed working (streak: {search_method_successes})")
                        return True
                    search_method_failures += 1
                    if search_method_failures >= 2:
                        print(f"  [search-crawl]   Saved method {name} FAILED {search_method_failures}x — re-discovering...")
                        pyautogui.press("escape")
                        time.sleep(0.3)
                        search_method_successes = 0
                        search_method_failures = 0
                        proven_search_method = None
                    else:
                        print(f"  [search-crawl]   Saved method {name} FAILED (1st failure, retrying once)")
                        pyautogui.press("escape")
                        time.sleep(0.5)
                        fn()
                        time.sleep(1.0)
                        bar_open2, _ = _is_bar_open()
                        if bar_open2:
                            search_method_failures = 0
                            search_method_successes += 1
                            return True
                        print(f"  [search-crawl]   Retry failed too, re-discovering...")
                        pyautogui.press("escape")
                        time.sleep(0.3)
                        search_method_successes = 0
                        search_method_failures = 0
                        proven_search_method = None
                    break
            if not found_in_list:
                print(f"  [search-crawl]   Saved method '{proven_search_method}' not in openers, clearing...")
                proven_search_method = None

        print(f"  [search-crawl]   === DISCOVERING SEARCH BAR SHORTCUT ({len(SEARCH_OPENERS)} methods to try) ===")
        tried = []
        for name, fn in SEARCH_OPENERS:
            tried.append(name)
            if _try_search_opener(name, fn):
                proven_search_method = name
                search_method_successes = 1
                search_method_failures = 0
                return True

        print(f"  [search-crawl]   FAILED: All {len(tried)} methods tried, none opened the search bar:")
        for t in tried:
            print(f"  [search-crawl]     - {t}: failed")
        return False

    def _open_search_bar():
        """Use the proven search opener or default to sendinput ctrl+space."""
        if proven_search_method:
            for name, fn in SEARCH_OPENERS:
                if name == proven_search_method:
                    fn()
                    time.sleep(0.5)
                    return
        sendinput_hotkey("ctrl", "space")
        time.sleep(0.5)

    # ── PHASE 1: DISCOVER SEARCH BAR SHORTCUT ──
    # Only discovers which keyboard shortcut opens the search bar.
    # NO typing tests — no "zz"/"qq" garbage left in the bar.
    # Text clearing is handled by _clear_bar() during Phase 2.
    if not proven_search_method:
        print(f"  [search-crawl] === PHASE 1: DISCOVERING SEARCH BAR SHORTCUT ===")

        search_ok = ensure_search_focused()

        if not search_ok:
            print(f"  [search-crawl]   First attempt failed. Waiting 2s and retrying...")
            time.sleep(2.0)
            search_ok = ensure_search_focused()

        if not search_ok:
            methods_tried = [name for name, _ in SEARCH_OPENERS]
            error_msg = (
                f"FATAL: Cannot open Epic search bar. "
                f"Tried {len(methods_tried)} keyboard methods: {', '.join(methods_tried)}. "
                f"None produced a visible expanded search bar. "
                f"Please verify: (1) Epic Hyperspace window is in the foreground, "
                f"(2) You are on the main Epic menu (not inside an activity), "
                f"(3) The search bar shortcut works when you press it manually."
            )
            print(f"  [search-crawl]   {error_msg}")
            post_result(command_id, "error", error=error_msg)
            return

        print(f"  [search-crawl]   Search bar opens with: {proven_search_method}")
        _clear_bar()
        proven_clear_method = "adaptive"
        save_progress(completed_prefixes)
    else:
        print(f"  [search-crawl] Using previously proven search method: {proven_search_method}")
        proven_clear_method = "adaptive"

    search_bar_open = False

    verified_streak = 0
    VERIFY_THRESHOLD = 3

    def type_and_read(prefix, max_attempts=5):
        """Clear bar, type prefix, read results.
        Self-healing: detects accumulated text, garbled input, focus loss.
        Uses _fast_clear() normally, _clear_bar() (verified) on failures."""
        nonlocal search_bar_open, verified_streak

        for attempt in range(max_attempts):
            if not search_bar_open:
                if not ensure_search_focused():
                    print(f"  [search-crawl]   Cannot open search bar on attempt {attempt+1}")
                    time.sleep(1.0)
                    continue
                search_bar_open = True

            if attempt == 0:
                _fast_clear()
            else:
                print(f"  [search-crawl]   Using verified clear (attempt {attempt+1})")
                clear_ok = _clear_bar()
                if not clear_ok:
                    print(f"  [search-crawl]   Clear failed — bar closed or text remains, reopening...")
                    search_bar_open = False
                    continue

            pyautogui.typewrite(prefix, interval=0.05)
            time.sleep(1.0)

            state = read_search_results()
            if state is None:
                print(f"  [search-crawl]   Vision failed on attempt {attempt+1}/{max_attempts}")
                search_bar_open = False
                verified_streak = 0
                continue

            if not state.get("searchBarVisible", True):
                print(f"  [search-crawl]   Search bar closed on attempt {attempt+1}, reopening...")
                search_bar_open = False
                verified_streak = 0
                continue

            actual = state.get("searchBarText", "").strip().lower()
            expected = prefix.lower()

            if actual == expected:
                verified_streak += 1
                return state

            if len(actual) >= len(expected) and actual.startswith(expected):
                verified_streak += 1
                print(f"  [search-crawl]   Bar shows '{actual}' (autocomplete of '{expected}') — accepting")
                return state

            if verified_streak >= VERIFY_THRESHOLD and len(actual) == 0:
                print(f"  [search-crawl]   Bar empty but trusted (streak={verified_streak}), accepting")
                return state

            foreign_chars = set(actual) - set(expected) - set(" ")
            if len(foreign_chars) == 0 and len(actual) > 0:
                print(f"  [search-crawl]   Bar shows '{actual}' — only contains chars from '{expected}', accepting")
                verified_streak += 1
                return state

            results = state.get("items", [])
            if len(results) > 0 and any(r.get("name", "").lower().startswith(expected) for r in results):
                print(f"  [search-crawl]   Bar shows '{actual}' but results match '{expected}' — accepting")
                verified_streak += 1
                return state

            print(f"  [search-crawl]   Search bar shows '{actual}' but expected '{expected}' (attempt {attempt+1})")
            verified_streak = 0

            if len(actual) > len(expected) and expected in actual:
                print(f"  [search-crawl]   Text accumulated — clear didn't work. Escape+reopen...")
                pyautogui.press("escape")
                time.sleep(0.4)
                search_bar_open = False
            elif len(actual) > 0:
                print(f"  [search-crawl]   Wrong text (foreign chars: {foreign_chars}). Escape+reopen...")
                pyautogui.press("escape")
                time.sleep(0.4)
                search_bar_open = False
            elif len(actual) == 0:
                print(f"  [search-crawl]   Bar empty — typing not reaching field. Escape+reopen...")
                pyautogui.press("escape")
                time.sleep(0.4)
                search_bar_open = False
            else:
                pyautogui.press("escape")
                time.sleep(0.3)
                search_bar_open = False

            if attempt == max_attempts - 2:
                print(f"  [search-crawl]   Last-resort recovery: re-activate window, double-escape, wait 2s...")
                activate_window(window)
                time.sleep(0.3)
                pyautogui.press("escape")
                time.sleep(0.3)
                pyautogui.press("escape")
                time.sleep(2.0)
                search_bar_open = False

        print(f"  [search-crawl]   Could not get '{prefix}' into search bar after {max_attempts} attempts")
        return None

    # ── PHASE 2: SMART PREFIX SEARCH ──
    # Start with 2-letter combos (aa-zz) since Epic requires min 2 chars.
    # If results are truncated, expand to 3-4 char prefixes.
    # Search is FUZZY so all returned items are collected regardless of prefix match.
    print(f"  [search-crawl] === PHASE 2: ACTIVITY DISCOVERY ===")

    VOWELS = set("aeiou")
    COMMON_CONSONANT_PAIRS = {
        "bl", "br", "ch", "cl", "cr", "dr", "fl", "fr", "gl", "gr",
        "kn", "ph", "pl", "pr", "qu", "sc", "sh", "sk", "sl", "sm",
        "sn", "sp", "sq", "st", "sw", "th", "tr", "tw", "wh", "wr",
    }
    RARE_STARTERS = {"bx", "cx", "dx", "fq", "fx", "gx", "hx", "jq", "jx", "jz",
                     "kx", "kz", "mx", "mz", "px", "pz", "qb", "qc", "qd", "qe",
                     "qf", "qg", "qh", "qi", "qj", "qk", "ql", "qm", "qn", "qo",
                     "qp", "qq", "qr", "qs", "qt", "qv", "qw", "qx", "qy", "qz",
                     "sx", "sz", "tx", "vb", "vc", "vd", "vf", "vg", "vh", "vj",
                     "vk", "vm", "vn", "vp", "vq", "vr", "vs", "vt", "vw", "vx",
                     "vy", "vz", "wc", "wd", "wf", "wg", "wj", "wk", "wm", "wn",
                     "wp", "wq", "wv", "ww", "wx", "wy", "wz", "xb", "xc", "xd",
                     "xf", "xg", "xh", "xj", "xk", "xl", "xm", "xn", "xp", "xq",
                     "xr", "xs", "xv", "xw", "xx", "xy", "xz", "yb", "yc", "yd",
                     "yf", "yg", "yh", "yj", "yk", "ym", "yn", "yp", "yq", "yr",
                     "ys", "yt", "yv", "yw", "yx", "yy", "yz", "zb", "zc", "zd",
                     "zf", "zg", "zh", "zj", "zk", "zl", "zm", "zn", "zp", "zq",
                     "zr", "zs", "zt", "zv", "zw", "zx", "zy", "zz"}
    prefix_queue = []
    for a in "abcdefghijklmnopqrstuvwxyz":
        for b in "abcdefghijklmnopqrstuvwxyz":
            pair = a + b
            if pair in RARE_STARTERS:
                continue
            prefix_queue.append(pair)
    print(f"  [search-crawl] {len(prefix_queue)} plausible 2-letter prefixes (skipped {676 - len(prefix_queue)} rare combos)")
    consecutive_errors = 0
    total_searched = 0
    search_bar_open = False

    while prefix_queue:
        prefix = prefix_queue.pop(0)

        if prefix in completed_prefixes:
            continue

        if consecutive_errors >= 5:
            print(f"  [search-crawl] Too many consecutive errors ({consecutive_errors}), stopping")
            break

        known_covering = sum(1 for name in all_activities if name.startswith(prefix.lower()))
        remaining = sum(1 for p in prefix_queue if p not in completed_prefixes)

        if len(prefix) >= 3 and known_covering > 0 and known_covering < TRUNCATION_THRESHOLD:
            parent = prefix[:-1]
            if parent in completed_prefixes:
                print(f"  [search-crawl] '{prefix}' skipped ({known_covering} known, parent '{parent}' non-truncated)")
                completed_prefixes.add(prefix)
                continue

        print(f"  [search-crawl] '{prefix}' ({remaining} left, {len(all_activities)} total, {known_covering} known for this prefix)")

        try:
            state = type_and_read(prefix)

            if state is None:
                print(f"  [search-crawl]   Could not verify '{prefix}' in search bar")
                consecutive_errors += 1
                continue

            if not state.get("searchBarVisible", True):
                print(f"  [search-crawl]   Search bar not visible, marking error")
                consecutive_errors += 1
                search_bar_open = False
                continue

            results = state.get("items", [])
            truncated = state.get("truncated", False)
            consecutive_errors = 0

            new_count = 0
            for item in results:
                name = item.get("name", "").strip()
                if not name:
                    continue
                name_key = name.lower()
                if name_key not in all_activities:
                    all_activities[name_key] = {
                        "name": name,
                        "category": item.get("category", ""),
                        "discoveredBy": f"search:{prefix}",
                    }
                    new_count += 1

            total_visible = len(results)
            is_actually_truncated = truncated or total_visible >= TRUNCATION_THRESHOLD

            print(f"  [search-crawl]   {total_visible} results (fuzzy), {new_count} new"
                  f"{' [TRUNCATED]' if is_actually_truncated else ''}")

            if is_actually_truncated and len(prefix) < MAX_PREFIX_LEN:
                expansions = [prefix + c for c in "abcdefghijklmnopqrstuvwxyz"]
                added = 0
                insert_at = 0
                for exp in expansions:
                    if exp not in completed_prefixes:
                        prefix_queue.insert(insert_at, exp)
                        insert_at += 1
                        added += 1
                if added > 0:
                    print(f"  [search-crawl]   Queued {added} sub-prefixes: {prefix}a..{prefix}z")

            completed_prefixes.add(prefix)

            if total_searched % 3 == 0:
                save_progress(completed_prefixes)
                print(f"  [search-crawl]   Saved ({len(all_activities)} activities, {len(completed_prefixes)} prefixes)")

            total_searched += 1

        except Exception as e:
            print(f"  [search-crawl]   Error: {e}")
            traceback.print_exc()
            consecutive_errors += 1
            search_bar_open = False
            try:
                pyautogui.press("escape")
                time.sleep(0.3)
            except Exception:
                pass

    try:
        pyautogui.press("escape")
        time.sleep(0.2)
    except Exception:
        pass

    print(f"  [search-crawl] COMPLETE! {len(all_activities)} activities from {total_searched} searches")
    save_progress(completed_prefixes)

    final_img = screenshot_window(window)
    final_b64 = img_to_base64(final_img) if final_img else None
    post_result(command_id, "complete", screenshot_b64=final_b64, data={
        "totalActivities": len(all_activities),
        "prefixesCompleted": len(completed_prefixes),
        "clearMethod": proven_clear_method,
    })


def execute_launch(cmd):
    """Launch an activity using Epic's search bar - fastest way to open anything.
    Uses Ctrl+Space to open the search bar, clears any existing text using the
    proven clear method (from search-crawl calibration if available), types the
    activity name, and presses Enter to launch."""
    env = cmd.get("env", "SUP")
    activity_name = cmd.get("activity", "")
    command_id = cmd.get("id", "unknown")

    if not activity_name:
        post_result(command_id, "error", error="No activity name provided")
        return

    window = find_window(env)
    if not window:
        post_result(command_id, "error", error=f"No {env} window found")
        return

    print(f"  [launch] Opening '{activity_name}' via search bar in {env}")

    clear_method = None
    search_method = None
    existing_key = f"epic_activities_{env.lower()}"
    try:
        resp = _bridge_request(
            "get", f"/api/config/{existing_key}", "fetch-methods", timeout=5,
            headers={"Authorization": f"Bearer {BRIDGE_TOKEN}"},
        )
        if resp and resp.status_code == 200:
            data = resp.json()
            val = data.get("value", "")
            if val:
                existing_data = json.loads(val) if isinstance(val, str) else val
                clear_method = existing_data.get("clearMethod")
                search_method = existing_data.get("searchMethod")
                if clear_method:
                    print(f"  [launch] Proven clear method: {clear_method}")
                if search_method:
                    print(f"  [launch] Proven search method: {search_method}")
    except Exception:
        pass

    def _launch_kbd_ctrl_space():
        set_keyboard_backend("keybd_event")
        sendinput_hotkey("ctrl", "space")
        set_keyboard_backend("sendinput")

    def _launch_kbd_alt_space():
        set_keyboard_backend("keybd_event")
        sendinput_hotkey("alt", "space")
        set_keyboard_backend("sendinput")

    SEARCH_FNS = {
        "sendinput_ctrl_space": lambda: sendinput_hotkey("ctrl", "space"),
        "keybd_event_ctrl_space": _launch_kbd_ctrl_space,
        "pyautogui_ctrl_space": lambda: pyautogui.hotkey("ctrl", "space"),
        "sendinput_alt_space": lambda: sendinput_hotkey("alt", "space"),
        "keybd_event_alt_space": _launch_kbd_alt_space,
        "pyautogui_alt_space": lambda: pyautogui.hotkey("alt", "space"),
        "sendinput_ctrl_f": lambda: sendinput_hotkey("ctrl", "f"),
        "sendinput_f3": lambda: sendinput_press("f3"),
        "ctrl_space": lambda: sendinput_hotkey("ctrl", "space"),
        "alt_space": lambda: sendinput_hotkey("alt", "space"),
        "epic_button_e": lambda: sendinput_hotkey("alt", "e"),
        "f3": lambda: sendinput_press("f3"),
        "ctrl_f": lambda: sendinput_hotkey("ctrl", "f"),
    }

    activate_window(window)
    time.sleep(0.3)

    open_search = SEARCH_FNS.get(search_method, SEARCH_FNS["sendinput_ctrl_space"])
    open_search()
    time.sleep(0.6)

    cleared = adaptive_clear_search_bar(window, open_search_fn=open_search)
    if not cleared:
        print(f"  [launch] Clear failed, attempting escape+reopen recovery")
        pyautogui.press("escape")
        time.sleep(0.5)
        open_search()
        time.sleep(0.8)
        adaptive_clear_search_bar(window, open_search_fn=open_search)

    pyautogui.typewrite(activity_name, interval=0.03)
    time.sleep(1.0)

    pyautogui.press("enter")
    time.sleep(1.5)

    final_img = screenshot_window(window)
    final_b64 = img_to_base64(final_img)
    post_result(command_id, "complete", screenshot_b64=final_b64, data={
        "launched": activity_name,
    })
    print(f"  [launch] Launched '{activity_name}' via search bar")


def execute_patient(cmd):
    """Search for a patient in Epic."""
    env = cmd.get("env", "SUP")
    patient_name = cmd.get("patient", "")
    command_id = cmd.get("id", "unknown")

    if not patient_name:
        post_result(command_id, "error", error="No patient name provided")
        return

    window = find_window(env)
    if not window:
        post_result(command_id, "error", error=f"No {env} window found")
        return

    print(f"  [patient] Searching for '{patient_name}' in {env}")

    activate_window(window)
    time.sleep(0.5)

    img = screenshot_window(window)
    b64 = img_to_base64(img)
    prompt = (
        "Find the patient search field, patient lookup button, or any element that would let me search for a patient.\n"
        "Common locations: toolbar with a magnifying glass icon, or a 'Patient Lookup' / 'Find Patient' button.\n"
        f"{VISION_COORD_INSTRUCTION}\n"
        "Return ONLY: {\"x\": <number>, \"y\": <number>, \"found\": true, \"type\": \"search_field\" or \"button\"}\n"
        "If not found: {\"found\": false}"
    )
    resp = ask_claude(b64, prompt)
    loc = None
    if resp:
        try:
            m = re.search(r'\{[\s\S]*?\}', resp)
            if m:
                loc = json.loads(m.group())
        except Exception:
            pass

    if loc and loc.get("found"):
        px, py = vision_to_screen(window, loc["x"], loc["y"])
        safe_click(px, py, pause_after=0.8, label="patient search")

        pyautogui.typewrite(patient_name, interval=0.03)
        time.sleep(0.5)
        pyautogui.press("enter")
        time.sleep(2.0)
    else:
        execute_launch({"env": env, "activity": "Patient Lookup", "id": command_id + "-sub"})
        time.sleep(2.0)
        pyautogui.typewrite(patient_name, interval=0.03)
        time.sleep(0.5)
        pyautogui.press("enter")
        time.sleep(2.0)

    final_img = screenshot_window(window)
    final_b64 = img_to_base64(final_img)
    post_result(command_id, "complete", screenshot_b64=final_b64, data={
        "searched": patient_name,
    })
    print(f"  [patient] Patient search completed for '{patient_name}'")


def execute_read_screen(cmd):
    """Read and extract structured data from the current Epic screen."""
    env = cmd.get("env", "SUP")
    focus = cmd.get("focus", "")
    command_id = cmd.get("id", "unknown")

    window = find_window(env)
    if not window:
        post_result(command_id, "error", error=f"No {env} window found")
        return

    print(f"  [read] Reading screen data from {env}")

    img = screenshot_window(window)
    b64 = img_to_base64(img, use_jpeg=True)

    focus_hint = f"Focus on: {focus}\n" if focus else ""
    prompt = (
        f"{EPIC_VISUAL_REFERENCE}\n"
        f"TASK: Extract structured data from this Epic Hyperspace screen.\n"
        f"{focus_hint}\n"
        "Using the visual reference above, read each layer:\n"
        "1. TITLE BAR (Layer 1): Department, environment, user\n"
        "2. WORKSPACE TABS (Layer 3): List of open tabs, which is active, any patient name tabs\n"
        "3. BREADCRUMB/TITLE (Layer 4): Current record/screen name\n"
        "4. LEFT SIDEBAR (Layer 5): Navigation categories and selected item\n"
        "5. WORKSPACE (Layer 6): All visible data — form fields, clinical data, tables/grids with column headers and row values, vitals, labs, meds, orders, allergies, diagnoses\n"
        "6. FLOATING ELEMENTS: Any popups, Secure Chat, dialogs\n\n"
        "Return ONLY a JSON object with the extracted data.\n"
        "Use descriptive keys. Include everything visible.\n"
        "If a section has no data, omit it.\n"
        "Return ONLY the JSON object."
    )

    response = ask_claude(b64, prompt, image_format="jpeg")
    screen_data = {}
    if response:
        try:
            json_match = re.search(r'\{[\s\S]*\}', response)
            if json_match:
                screen_data = json.loads(json_match.group())
        except Exception:
            screen_data = {"raw": response}

    post_result(command_id, "complete", screenshot_b64=b64, data={
        "screenData": screen_data,
    })
    print(f"  [read] Screen data extracted: {len(screen_data)} fields")


def execute_batch(cmd):
    """Execute a sequence of commands in order."""
    env = cmd.get("env", "SUP")
    steps = cmd.get("steps", [])
    command_id = cmd.get("id", "unknown")

    if not steps:
        post_result(command_id, "error", error="No steps provided")
        return

    print(f"  [batch] Executing {len(steps)} steps in {env}")
    results = []

    for i, step in enumerate(steps):
        step_type = step.get("type", "")
        print(f"  [batch] Step {i+1}/{len(steps)}: {step_type}")

        step["env"] = step.get("env", env)
        step["id"] = f"{command_id}-step-{i+1}"

        if step_type == "launch":
            execute_launch(step)
        elif step_type == "navigate_path":
            execute_navigate_path(step)
        elif step_type == "click":
            execute_click(step)
        elif step_type == "screenshot":
            execute_screenshot(step)
        elif step_type == "read_screen":
            execute_read_screen(step)
        elif step_type == "patient":
            execute_patient(step)
        elif step_type == "wait":
            wait_secs = step.get("seconds", 2)
            print(f"  [batch]   Waiting {wait_secs}s...")
            time.sleep(wait_secs)
        elif step_type == "keypress":
            keys = step.get("keys", "")
            if keys:
                print(f"  [batch]   Pressing: {keys}")
                parts = keys.split("+")
                if len(parts) > 1:
                    pyautogui.hotkey(*[p.strip() for p in parts])
                else:
                    pyautogui.press(parts[0].strip())
                time.sleep(0.2)
        elif step_type == "type":
            text = step.get("text", "")
            if text:
                print(f"  [batch]   Typing: {text}")
                pyautogui.typewrite(text, interval=0.03)
                time.sleep(0.3)
        else:
            print(f"  [batch]   Unknown step type: {step_type}")

        results.append({"step": i + 1, "type": step_type, "status": "done"})

        delay = step.get("delay", 0.5)
        time.sleep(delay)

    final_img = screenshot_window(find_window(env))
    final_b64 = img_to_base64(final_img) if final_img else None
    post_result(command_id, "complete", screenshot_b64=final_b64, data={
        "stepsCompleted": len(results),
        "results": results,
    })
    print(f"  [batch] All {len(steps)} steps completed")


def execute_shortcuts(cmd):
    """Discover keyboard shortcuts from the current Epic screen."""
    env = cmd.get("env", "SUP")
    command_id = cmd.get("id", "unknown")

    window = find_window(env)
    if not window:
        post_result(command_id, "error", error=f"No {env} window found")
        return

    print(f"  [shortcuts] Discovering keyboard shortcuts in {env}")

    activate_window(window)
    time.sleep(0.5)

    img = screenshot_window(window)
    b64 = img_to_base64(img)

    prompt = (
        "Look at this Epic Hyperspace screen carefully.\n"
        "Identify ALL keyboard shortcuts visible in the interface. These appear as:\n"
        "- Underlined letters in menu items (Alt+letter shortcuts)\n"
        "- Shortcut hints next to menu items (like Ctrl+S, F5, etc.)\n"
        "- Toolbar tooltips showing keyboard shortcuts\n"
        "- Any visible key bindings\n\n"
        "Also list common Epic keyboard shortcuts you know:\n"
        "- Alt+F4: Close\n"
        "- Ctrl+1: Patient Station\n"
        "- Ctrl+2: Schedule\n"
        "- F5: Refresh\n\n"
        "Return a JSON array of shortcuts:\n"
        "[{\"keys\": \"Ctrl+1\", \"action\": \"Open Patient Station\", \"source\": \"visible\" or \"known\"}]\n"
        "Return ONLY the JSON array."
    )

    response = ask_claude(b64, prompt)
    shortcuts = []
    if response:
        try:
            json_match = re.search(r'\[[\s\S]*\]', response)
            if json_match:
                shortcuts = json.loads(json_match.group())
        except Exception:
            pass

    _bridge_request(
        "post", "/api/epic/activities", "shortcuts-upload", timeout=30,
        headers={
            "Authorization": f"Bearer {BRIDGE_TOKEN}",
            "Content-Type": "application/json",
        },
        json={"environment": env, "activities": [
            {"name": s.get("keys", ""), "category": "Keyboard Shortcuts", "type": "shortcut",
             "description": s.get("action", "")}
            for s in shortcuts
        ]},
    )

    post_result(command_id, "complete", screenshot_b64=b64, data={
        "shortcuts": shortcuts,
        "count": len(shortcuts),
    })
    print(f"  [shortcuts] Found {len(shortcuts)} shortcuts")


def execute_search(cmd):
    """One-shot search: open search bar, type query, read fuzzy results, return them."""
    env = cmd.get("env", "SUP")
    query_text = cmd.get("query", "")
    command_id = cmd.get("id", "unknown")

    if not query_text:
        post_result(command_id, "error", error="Missing query parameter")
        return

    print(f"  [search] Searching '{query_text}' in {env}")

    window = find_window(env)
    if not window:
        post_result(command_id, "error", error=f"No {env} window found")
        return

    activate_window(window)
    time.sleep(0.3)

    existing_key = f"epic_activities_{env.lower()}"
    search_method = "sendinput_ctrl_space"
    try:
        cfg_raw = _bridge_request(
            "get",
            f"/api/agent-config/{existing_key}",
            "config",
            timeout=10,
            headers={"Authorization": f"Bearer {BRIDGE_TOKEN}"},
        )
        if cfg_raw:
            cfg_data = cfg_raw.json()
            if cfg_data.get("value"):
                parsed = json.loads(cfg_data["value"])
                if isinstance(parsed, dict):
                    search_method = parsed.get("searchMethod", search_method)
    except Exception:
        pass

    def _launch_kbd_ctrl_space():
        set_keyboard_backend("keybd_event")
        sendinput_hotkey("ctrl", "space")
        set_keyboard_backend("sendinput")

    def _launch_kbd_alt_space():
        set_keyboard_backend("keybd_event")
        sendinput_hotkey("alt", "space")
        set_keyboard_backend("sendinput")

    SEARCH_FNS = {
        "sendinput_ctrl_space": lambda: sendinput_hotkey("ctrl", "space"),
        "keybd_event_ctrl_space": _launch_kbd_ctrl_space,
        "pyautogui_ctrl_space": lambda: pyautogui.hotkey("ctrl", "space"),
        "sendinput_alt_space": lambda: sendinput_hotkey("alt", "space"),
        "keybd_event_alt_space": _launch_kbd_alt_space,
        "pyautogui_alt_space": lambda: pyautogui.hotkey("alt", "space"),
        "sendinput_ctrl_f": lambda: sendinput_hotkey("ctrl", "f"),
        "sendinput_f3": lambda: sendinput_press("f3"),
        "ctrl_space": lambda: sendinput_hotkey("ctrl", "space"),
        "alt_space": lambda: sendinput_hotkey("alt", "space"),
        "epic_button_e": lambda: sendinput_hotkey("alt", "e"),
        "f3": lambda: sendinput_press("f3"),
        "ctrl_f": lambda: sendinput_hotkey("ctrl", "f"),
    }

    open_search = SEARCH_FNS.get(search_method, SEARCH_FNS["sendinput_ctrl_space"])
    open_search()
    time.sleep(0.6)

    cleared = adaptive_clear_search_bar(window, open_search_fn=open_search)
    if not cleared:
        print(f"  [search] Clear failed, attempting escape+reopen recovery")
        pyautogui.press("escape")
        time.sleep(0.5)
        open_search()
        time.sleep(0.8)
        adaptive_clear_search_bar(window, open_search_fn=open_search)

    pyautogui.typewrite(query_text, interval=0.04)
    time.sleep(1.2)

    img = screenshot_window(window)
    b64 = img_to_base64(img)
    if not b64:
        post_result(command_id, "error", error="Failed to capture screenshot")
        return

    prompt = (
        "You are looking at an Epic Hyperspace screen.\n\n"
        "FIRST: Check if the SEARCH BAR at the top is EXPANDED (wide/lengthened).\n"
        "- When activated (Ctrl+Space), the search bar expands horizontally to become much wider.\n"
        "- An expanded/wide search bar = active and focused (searchBarVisible: true).\n"
        "- A narrow/collapsed search bar or no search bar = NOT active (searchBarVisible: false).\n"
        "- If the search bar is expanded, read the EXACT text currently in it.\n\n"
        "SECOND: If a search dropdown/autocomplete list is showing, list every item:\n"
        "- name: the full activity name as displayed\n"
        "- category: if a category/section label is shown\n\n"
        "THIRD: Check if the dropdown appears TRUNCATED:\n"
        "- Scrollbar on the dropdown\n"
        "- 'more results' or '...' text\n"
        "- List cut off at bottom edge\n"
        "- 8+ results suggesting more exist\n\n"
        "Return ONLY a JSON object:\n"
        "{\"searchBarVisible\": true/false, "
        "\"searchBarText\": \"exact text in search field or empty string\", "
        "\"items\": [{\"name\": \"Activity Name\", \"category\": \"Category\"}], "
        "\"truncated\": true/false, "
        "\"reason\": \"brief explanation\"}\n\n"
        "Return ONLY the JSON, no other text."
    )

    resp_text = ask_claude(b64, prompt)
    items = []
    truncated = False
    bar_text = ""
    if resp_text:
        try:
            m = re.search(r'\{[\s\S]*\}', resp_text)
            if m:
                parsed = json.loads(m.group())
                items = parsed.get("items", [])
                truncated = parsed.get("truncated", False)
                bar_text = parsed.get("searchBarText", "")
        except Exception:
            pass

    pyautogui.press("escape")
    time.sleep(0.3)

    post_result(command_id, "complete", screenshot_b64=b64, data={
        "query": query_text,
        "barText": bar_text,
        "items": items,
        "truncated": truncated,
        "resultCount": len(items),
    })
    print(f"  [search] Found {len(items)} results for '{query_text}'")


INTERACTIVE_CONTROL_TYPES = frozenset([
    "Button", "Edit", "MenuItem", "Menu", "MenuBar",
    "TabItem", "TabControl", "CheckBox", "ComboBox",
    "Hyperlink", "ListItem", "TreeItem", "DataItem",
    "RadioButton", "Slider", "Spinner", "SplitButton",
    "ToolBar",
])

CONTAINER_CONTROL_TYPES = frozenset([
    "Pane", "Window", "Group", "Custom", "Document",
    "List", "ListView", "TreeView", "Table", "DataGrid",
    "Tab", "ToolBar", "StatusBar",
])

_vimium_element_maps = {}
_last_activity_label = {}


def _detect_current_activity(window_title, env_upper):
    """Detect the current activity from the Epic window title."""
    if not window_title:
        return ""
    skip_words = {"EPIC", "HYPERSPACE", "HYPERDRIVE", env_upper, "SUP", "POC", "TST", "PRD", "BLD", "REL", "DEM", "MST"}
    parts = window_title.split(" - ")
    for part in reversed(parts):
        candidate = part.strip()
        if candidate and len(candidate) > 1 and candidate.upper() not in skip_words:
            if not any(k in candidate.upper() for k in ["EPIC", "HYPERSPACE", "HYPERDRIVE"]):
                return candidate
    return ""


def _generate_hint_keys(count):
    """Generate Vimium-style hint keys: a-z, then aa-az, ba-bz, etc."""
    keys = []
    singles = "asdfghjklqwertyuiopzxcvbnm"
    for ch in singles:
        keys.append(ch)
        if len(keys) >= count:
            return keys[:count]
    for first in singles:
        for second in singles:
            keys.append(first + second)
            if len(keys) >= count:
                return keys[:count]
    return keys[:count]


_walk_deadline = 0.0
_walk_node_count = 0
_WALK_MAX_NODES = 1000
_WALK_TIME_LIMIT = 20.0


def _walk_uia_tree(element, depth, max_depth, show_all, parent_name=""):
    """Walk the UI Automation tree and collect elements with metadata."""
    global _walk_node_count
    if depth > max_depth:
        return []
    if _walk_node_count >= _WALK_MAX_NODES or time.time() > _walk_deadline:
        return []
    results = []
    try:
        children = element.children()
    except Exception:
        return []

    for child in children:
        _walk_node_count += 1
        if _walk_node_count >= _WALK_MAX_NODES or time.time() > _walk_deadline:
            break

        try:
            info = child.element_info
            ctrl_type = info.control_type or ""
            name = (info.name or "").strip()
            auto_id = getattr(info, "automation_id", "") or ""
            class_name = getattr(info, "class_name", "") or ""
            is_enabled = True
            try:
                is_enabled = info.enabled
            except Exception:
                pass
        except Exception:
            continue

        is_interactive = ctrl_type in INTERACTIVE_CONTROL_TYPES
        is_container = ctrl_type in CONTAINER_CONTROL_TYPES

        value = ""
        if ctrl_type in ("Edit", "ComboBox", "Spinner"):
            try:
                iface = child.iface_value
                if iface:
                    value = iface.CurrentValue or ""
            except Exception:
                try:
                    value = child.window_text() or ""
                except Exception:
                    pass

        is_checked = None
        if ctrl_type in ("CheckBox", "RadioButton"):
            try:
                toggle = child.iface_toggle
                if toggle:
                    state = toggle.CurrentToggleState
                    is_checked = (state == 1)
            except Exception:
                pass

        rect = None
        try:
            r = info.rectangle
            if r and r.width() > 0 and r.height() > 0:
                rect = {"left": r.left, "top": r.top, "right": r.right, "bottom": r.bottom,
                        "cx": (r.left + r.right) // 2, "cy": (r.top + r.bottom) // 2}
        except Exception:
            pass

        container_label = parent_name
        display_name = name if name else f"({ctrl_type})"

        if is_interactive and (name or ctrl_type in ("Edit", "ComboBox")):
            entry = {
                "name": display_name,
                "controlType": ctrl_type,
                "automationId": auto_id,
                "className": class_name,
                "enabled": is_enabled,
                "value": value,
                "checked": is_checked,
                "rect": rect,
                "depth": depth,
                "parent": container_label,
            }
            results.append(entry)

        if show_all and not is_interactive and not is_container and name:
            entry = {
                "name": display_name,
                "controlType": ctrl_type,
                "automationId": auto_id,
                "className": class_name,
                "enabled": is_enabled,
                "value": value,
                "checked": is_checked,
                "rect": rect,
                "depth": depth,
                "parent": container_label,
                "static": True,
            }
            results.append(entry)

        should_recurse = depth < max_depth and (
            is_container
            or not is_interactive
            or ctrl_type in ("Menu", "MenuBar", "TreeItem", "TabControl", "ToolBar", "Tab", "TabItem")
        )
        if should_recurse:
            sub_parent = name if name else container_label
            sub = _walk_uia_tree(child, depth + 1, max_depth, show_all, sub_parent)
            results.extend(sub)

    return results


def _find_subtree_by_focus(element, focus_term, depth=0, max_search=5):
    """Find a subtree element matching focus_term by name or automation_id."""
    if depth > max_search:
        return None
    try:
        children = element.children()
    except Exception:
        return []
    for child in children:
        try:
            info = child.element_info
            name = (info.name or "").lower()
            auto_id = (getattr(info, "automation_id", "") or "").lower()
            term = focus_term.lower()
            if term in name or term in auto_id:
                return child
        except Exception:
            continue
        found = _find_subtree_by_focus(child, focus_term, depth + 1, max_search)
        if found:
            return found
    return None


def execute_view(cmd):
    """Read the live UI Automation accessibility tree and return Vimium-style hint keys."""
    env = cmd.get("env", "SUP")
    command_id = cmd.get("id", "unknown")
    show_all = cmd.get("showAll", False)
    focus_target = cmd.get("focus", "")
    max_depth = 8

    print(f"  [view] Reading accessibility tree for {env}")

    try:
        from pywinauto import Desktop
    except ImportError:
        post_result(command_id, "error", error="pywinauto not installed. pip install pywinauto")
        return

    desktop = Desktop(backend="uia")
    env_upper = env.upper()
    target_window = None

    for w in desktop.windows():
        try:
            title = w.element_info.name or ""
            t = title.upper()
            if env_upper in t and ("HYPERSPACE" in t or "EPIC" in t or "HYPERDRIVE" in t):
                target_window = w
                break
        except Exception:
            continue

    if not target_window:
        for w in desktop.windows():
            try:
                title = w.element_info.name or ""
                if env_upper in title.upper():
                    target_window = w
                    break
            except Exception:
                continue

    if not target_window:
        post_result(command_id, "error", error=f"No {env} window found")
        return

    window_title = target_window.element_info.name or "Unknown"
    print(f"  [view] Window: {window_title}")

    try:
        target_window.set_focus()
        time.sleep(0.3)
    except Exception:
        pass

    root_element = target_window
    focus_label = ""
    if focus_target:
        focused = _find_subtree_by_focus(target_window, focus_target)
        if focused:
            root_element = focused
            try:
                focus_label = focused.element_info.name or focus_target
            except Exception:
                focus_label = focus_target
            print(f"  [view] Focused on: {focus_label}")
        else:
            print(f"  [view] Focus target '{focus_target}' not found, showing full window")

    global _walk_deadline, _walk_node_count
    _walk_deadline = time.time() + _WALK_TIME_LIMIT
    _walk_node_count = 0
    elements = _walk_uia_tree(root_element, 0, max_depth, show_all, "")
    walked_nodes = _walk_node_count
    timed_out = time.time() > _walk_deadline
    print(f"  [view] Tree walk: {walked_nodes} nodes visited, {len(elements)} elements found" + (" (time limit reached)" if timed_out else ""))
    if not elements:
        post_result(command_id, "complete", data={
            "window": window_title,
            "focus": focus_label,
            "elements": [],
            "hintMap": {},
            "elementCount": 0,
        })
        print(f"  [view] No elements found")
        return

    interactive_elements = [e for e in elements if not e.get("static", False)]
    hint_keys = _generate_hint_keys(len(interactive_elements))

    hint_map = {}
    for i, elem in enumerate(interactive_elements):
        key = hint_keys[i] if i < len(hint_keys) else f"z{i}"
        elem["hint"] = key
        hint_map[key] = {
            "name": elem["name"],
            "controlType": elem["controlType"],
            "automationId": elem["automationId"],
            "rect": elem["rect"],
            "value": elem.get("value", ""),
        }

    for elem in elements:
        if elem.get("static"):
            elem["hint"] = ""

    _vimium_element_maps[env_upper] = hint_map

    activity_label = cmd.get("_activity_label", "") or _detect_current_activity(window_title, env_upper)
    if activity_label:
        _last_activity_label[env_upper] = activity_label

    post_result(command_id, "complete", data={
        "window": window_title,
        "focus": focus_label,
        "activity": activity_label,
        "elements": elements,
        "hintMap": hint_map,
        "elementCount": len(elements),
        "interactiveCount": len(interactive_elements),
    })
    print(f"  [view] Found {len(interactive_elements)} interactive, {len(elements)} total elements" +
          (f" (activity: {activity_label})" if activity_label else ""))


def execute_do(cmd):
    """Interact with an element by its Vimium hint key, then auto re-view."""
    env = cmd.get("env", "SUP")
    command_id = cmd.get("id", "unknown")
    hint = cmd.get("hint", "").lower().strip()
    value = cmd.get("value", "")

    if not hint:
        post_result(command_id, "error", error="Missing hint key")
        return

    env_upper = env.upper()
    hint_map = _vimium_element_maps.get(env_upper, {})
    if not hint_map:
        post_result(command_id, "error", error=f"No element map for {env}. Run 'epic view {env}' first.")
        return

    elem_info = hint_map.get(hint)
    if not elem_info:
        available = ", ".join(sorted(hint_map.keys())[:20])
        post_result(command_id, "error", error=f"Unknown hint '{hint}'. Available: {available}")
        return

    ctrl_type = elem_info.get("controlType", "")
    name = elem_info.get("name", "")
    rect = elem_info.get("rect")

    print(f"  [do] {hint} -> {ctrl_type} '{name}'" + (f" = '{value}'" if value else ""))

    try:
        from pywinauto import Desktop
    except ImportError:
        post_result(command_id, "error", error="pywinauto not installed")
        return

    desktop = Desktop(backend="uia")
    target_window = None
    for w in desktop.windows():
        try:
            title = w.element_info.name or ""
            t = title.upper()
            if env_upper in t and ("HYPERSPACE" in t or "EPIC" in t or "HYPERDRIVE" in t):
                target_window = w
                break
        except Exception:
            continue
    if not target_window:
        for w in desktop.windows():
            try:
                title = w.element_info.name or ""
                if env_upper in title.upper():
                    target_window = w
                    break
            except Exception:
                continue

    if not target_window:
        post_result(command_id, "error", error=f"No {env} window found")
        return

    try:
        target_window.set_focus()
        time.sleep(0.2)
    except Exception:
        pass

    auto_id = elem_info.get("automationId", "")
    uia_element = None
    if auto_id:
        try:
            found = target_window.child_window(auto_id=auto_id, control_type=ctrl_type)
            if found.exists():
                uia_element = found
        except Exception:
            pass

    if not uia_element and name:
        try:
            found = target_window.child_window(title=name, control_type=ctrl_type)
            if found.exists():
                uia_element = found
        except Exception:
            pass

    action_taken = "none"
    try:
        if uia_element:
            if ctrl_type in ("Edit", "ComboBox", "Spinner") and value:
                try:
                    uia_element.set_edit_text(value)
                    action_taken = f"typed '{value}'"
                except Exception:
                    uia_element.click_input()
                    time.sleep(0.2)
                    pyautogui.hotkey("ctrl", "a")
                    time.sleep(0.05)
                    pyautogui.typewrite(value, interval=0.03)
                    action_taken = f"typed '{value}' (fallback)"
            elif ctrl_type in ("CheckBox", "RadioButton"):
                try:
                    uia_element.toggle()
                    action_taken = "toggled"
                except Exception:
                    uia_element.click_input()
                    action_taken = "clicked (toggle fallback)"
            elif ctrl_type in ("ListItem", "TreeItem"):
                try:
                    uia_element.select()
                    action_taken = "selected"
                except Exception:
                    uia_element.click_input()
                    action_taken = "clicked (select fallback)"
            else:
                uia_element.click_input()
                action_taken = "clicked"
        elif rect:
            cx, cy = rect["cx"], rect["cy"]
            print(f"  [do] UIA element not found, falling back to coordinate click ({cx}, {cy})")
            safe_click(cx, cy, pause_after=0.5, label=f"vimium-{hint}")
            if ctrl_type in ("Edit", "ComboBox") and value:
                time.sleep(0.2)
                pyautogui.hotkey("ctrl", "a")
                time.sleep(0.05)
                pyautogui.typewrite(value, interval=0.03)
                action_taken = f"clicked+typed '{value}'"
            else:
                action_taken = "clicked (coordinates)"
        else:
            post_result(command_id, "error", error=f"Cannot interact with '{name}': no UIA element or coordinates")
            return
    except Exception as e:
        print(f"  [do] Interaction error: {e}")
        if rect:
            cx, cy = rect["cx"], rect["cy"]
            safe_click(cx, cy, pause_after=0.5, label=f"vimium-fallback-{hint}")
            if ctrl_type in ("Edit", "ComboBox") and value:
                time.sleep(0.2)
                pyautogui.typewrite(value, interval=0.03)
            action_taken = f"clicked (error fallback at {cx},{cy})"
        else:
            post_result(command_id, "error", error=f"Interaction failed: {e}")
            return

    print(f"  [do] Action: {action_taken}")
    time.sleep(0.5)

    print(f"  [do] Auto re-reading screen...")
    execute_view({"env": env, "id": command_id, "showAll": False})


def _find_window_by_title(title_substring):
    """Find a window by title substring (case-insensitive). Returns (window, title) or (None, None)."""
    try:
        from pywinauto import Desktop
    except ImportError:
        return None, None
    desktop = Desktop(backend="uia")
    term = title_substring.lower()
    for w in desktop.windows():
        try:
            title = w.element_info.name or ""
            if term in title.lower():
                return w, title
        except Exception:
            continue
    return None, None


def _get_hwnd(pywinauto_win):
    """Extract the HWND from a pywinauto window object."""
    try:
        return pywinauto_win.element_info.handle
    except Exception:
        try:
            return pywinauto_win.handle
        except Exception:
            return None


def _walk_win32_backend(hwnd, max_depth=8):
    """Walk the accessibility tree using the win32/MSAA backend (fallback for Citrix)."""
    results = []
    try:
        from pywinauto import Desktop, Application
        desktop_w32 = Desktop(backend="win32")
        win_w32 = None
        for w in desktop_w32.windows():
            try:
                if w.handle == hwnd:
                    win_w32 = w
                    break
            except Exception:
                continue
        if not win_w32:
            try:
                app = Application(backend="win32").connect(handle=hwnd)
                win_w32 = app.window(handle=hwnd)
            except Exception as e:
                print(f"  [nav_view:win32] connect failed: {e}")
                return []

        def _recurse_w32(elem, depth, parent_name):
            if depth > max_depth:
                return
            try:
                children = elem.children()
            except Exception:
                return
            for child in children:
                try:
                    text = ""
                    try:
                        text = child.window_text() or ""
                    except Exception:
                        pass
                    cls = ""
                    try:
                        cls = child.class_name() or ""
                    except Exception:
                        pass
                    rect = None
                    try:
                        r = child.rectangle()
                        if r and r.width() > 0 and r.height() > 0:
                            rect = {"left": r.left, "top": r.top, "right": r.right, "bottom": r.bottom,
                                    "cx": (r.left + r.right) // 2, "cy": (r.top + r.bottom) // 2}
                    except Exception:
                        pass
                    ctrl_type = cls
                    is_interactive = any(k in cls.lower() for k in ("button", "edit", "combo", "list", "check", "radio", "scroll", "tab", "tree", "menu"))
                    if text or cls:
                        entry = {
                            "name": text if text else f"({cls})",
                            "controlType": ctrl_type,
                            "automationId": "",
                            "className": cls,
                            "enabled": True,
                            "value": "",
                            "checked": None,
                            "rect": rect,
                            "depth": depth,
                            "parent": parent_name,
                        }
                        if not is_interactive:
                            entry["static"] = True
                        results.append(entry)
                    _recurse_w32(child, depth + 1, text if text else parent_name)
                except Exception:
                    continue

        _recurse_w32(win_w32, 0, "")
        print(f"  [nav_view:win32] {len(results)} elements via MSAA/win32 backend")
    except Exception as e:
        print(f"  [nav_view:win32] failed: {e}")
    return results


def _walk_comtypes_uia(hwnd, max_depth=8):
    """Walk UIA tree directly via comtypes IUIAutomation, bypassing pywinauto."""
    results = []
    try:
        import comtypes.client
        import comtypes
        try:
            from comtypes.gen import UIAutomationClient as uiac
        except ImportError:
            try:
                comtypes.client.GetModule("UIAutomationCore.dll")
                from comtypes.gen import UIAutomationClient as uiac
            except Exception as e:
                print(f"  [nav_view:comtypes] module load failed: {e}")
                return []

        uia_clsid = comtypes.GUID("{FF48DBA4-60EF-4201-AA87-54103EEF594E}")
        uia = comtypes.client.CreateObject(uia_clsid, interface=uiac.IUIAutomation)
        root = uia.ElementFromHandle(hwnd)
        if root is None:
            return []

        INTERACTIVE_TYPES = {"Button", "Edit", "ComboBox", "CheckBox", "RadioButton",
                              "ListItem", "MenuItem", "Hyperlink", "Slider", "Tab", "TabItem",
                              "TreeItem", "Spinner", "ScrollBar"}
        CONTAINER_TYPES = {"Pane", "Group", "List", "Tree", "MenuBar", "Menu",
                           "ToolBar", "StatusBar", "Window", "Document", "DataGrid"}

        def _recurse_ct(elem, depth, parent_name):
            if depth > max_depth:
                return
            try:
                ctrl_type_id = elem.CurrentControlType
                ctrl_name_map = {
                    50000: "Button", 50001: "Calendar", 50002: "CheckBox", 50003: "ComboBox",
                    50004: "Edit", 50005: "Hyperlink", 50006: "Image", 50007: "ListItem",
                    50008: "List", 50009: "Menu", 50010: "MenuBar", 50011: "MenuItem",
                    50012: "ProgressBar", 50013: "RadioButton", 50014: "ScrollBar",
                    50015: "Slider", 50016: "Spinner", 50017: "StatusBar", 50018: "Tab",
                    50019: "TabItem", 50020: "Text", 50021: "ToolBar", 50022: "ToolTip",
                    50023: "Tree", 50024: "TreeItem", 50025: "Custom", 50026: "Group",
                    50027: "Thumb", 50028: "DataGrid", 50029: "DataItem", 50030: "Document",
                    50031: "SplitButton", 50032: "Window", 50033: "Pane", 50034: "Header",
                    50035: "HeaderItem", 50036: "Table", 50037: "TitleBar", 50038: "Separator",
                }
                ctrl_type = ctrl_name_map.get(ctrl_type_id, f"Type{ctrl_type_id}")
                name = ""
                try:
                    name = elem.CurrentName or ""
                except Exception:
                    pass
                auto_id = ""
                try:
                    auto_id = elem.CurrentAutomationId or ""
                except Exception:
                    pass
                rect = None
                try:
                    r = elem.CurrentBoundingRectangle
                    w = r.right - r.left
                    h = r.bottom - r.top
                    if w > 0 and h > 0:
                        rect = {"left": r.left, "top": r.top, "right": r.right, "bottom": r.bottom,
                                "cx": (r.left + r.right) // 2, "cy": (r.top + r.bottom) // 2}
                except Exception:
                    pass
                is_interactive = ctrl_type in INTERACTIVE_TYPES
                is_container = ctrl_type in CONTAINER_TYPES
                if name or is_interactive:
                    entry = {
                        "name": name if name else f"({ctrl_type})",
                        "controlType": ctrl_type,
                        "automationId": auto_id,
                        "className": "",
                        "enabled": True,
                        "value": "",
                        "checked": None,
                        "rect": rect,
                        "depth": depth,
                        "parent": parent_name,
                    }
                    if not is_interactive:
                        entry["static"] = True
                    results.append(entry)
                if depth < max_depth and (is_container or not is_interactive):
                    cond = uia.CreateTrueCondition()
                    children = elem.FindAll(uiac.TreeScope_Children, cond)
                    if children:
                        for i in range(children.Length):
                            try:
                                child = children.GetElement(i)
                                sub_parent = name if name else parent_name
                                _recurse_ct(child, depth + 1, sub_parent)
                            except Exception:
                                continue
            except Exception:
                pass

        cond = uia.CreateTrueCondition()
        children = root.FindAll(uiac.TreeScope_Children, cond)
        if children:
            for i in range(children.Length):
                try:
                    child = children.GetElement(i)
                    _recurse_ct(child, 0, "")
                except Exception:
                    continue
        print(f"  [nav_view:comtypes] {len(results)} elements via IUIAutomation direct")
    except Exception as e:
        print(f"  [nav_view:comtypes] failed: {e}")
    return results


def _walk_enum_child_windows(hwnd):
    """Enumerate all child HWNDs via raw win32gui — always works, even for Citrix."""
    results = []
    try:
        import win32gui
        import win32con

        def _enum_cb(child_hwnd, _):
            try:
                if not win32gui.IsWindowVisible(child_hwnd):
                    return True
                text = win32gui.GetWindowText(child_hwnd) or ""
                cls = win32gui.GetClassName(child_hwnd) or ""
                rect = win32gui.GetWindowRect(child_hwnd)
                left, top, right, bottom = rect
                w = right - left
                h = bottom - top
                if w <= 0 or h <= 0:
                    return True
                is_interactive = any(k in cls.lower() for k in ("button", "edit", "combo", "listbox", "check", "scroll", "tab", "richedit", "static", "spin"))
                entry = {
                    "name": text if text else f"({cls})",
                    "controlType": cls,
                    "automationId": f"hwnd:{child_hwnd}",
                    "className": cls,
                    "enabled": True,
                    "value": "",
                    "checked": None,
                    "rect": {"left": left, "top": top, "right": right, "bottom": bottom,
                             "cx": (left + right) // 2, "cy": (top + bottom) // 2},
                    "depth": 0,
                    "parent": "",
                }
                if not is_interactive:
                    entry["static"] = True
                results.append(entry)
            except Exception:
                pass
            return True

        win32gui.EnumChildWindows(hwnd, _enum_cb, None)
        print(f"  [nav_view:enum] {len(results)} child windows via EnumChildWindows")
    except Exception as e:
        print(f"  [nav_view:enum] failed: {e}")
    return results


def execute_nav_view(cmd):
    """Read the live UIA accessibility tree for ANY window by title substring."""
    window_title_arg = cmd.get("window", "")
    command_id = cmd.get("id", "unknown")
    show_all = cmd.get("showAll", False)
    search_term = cmd.get("search", "")
    max_depth = 8

    if not window_title_arg:
        print(f"  [nav_view] Listing all windows")
        try:
            from pywinauto import Desktop
        except ImportError:
            post_result(command_id, "error", error="pywinauto not installed")
            return
        desktop = Desktop(backend="uia")
        windows = []
        for w in desktop.windows():
            try:
                info = w.element_info
                title = info.name or ""
                if not title.strip():
                    continue
                rect = None
                try:
                    r = info.rectangle
                    if r:
                        rect = {"left": r.left, "top": r.top, "right": r.right, "bottom": r.bottom,
                                "width": r.width(), "height": r.height()}
                except Exception:
                    pass
                pid = getattr(info, "process_id", None)
                windows.append({"title": title, "processId": pid, "rect": rect})
            except Exception:
                continue
        post_result(command_id, "complete", data={
            "mode": "list",
            "windows": windows,
            "windowCount": len(windows),
        })
        _post_uia_cache({"mode": "list", "windows": windows})
        print(f"  [nav_view] Found {len(windows)} windows")
        return

    print(f"  [nav_view] Scanning window: {window_title_arg}")
    target_window, actual_title = _find_window_by_title(window_title_arg)
    if not target_window:
        post_result(command_id, "error", error=f"No window matching '{window_title_arg}'")
        return

    print(f"  [nav_view] Window: {actual_title}")
    try:
        target_window.set_focus()
        time.sleep(0.3)
    except Exception:
        pass

    global _walk_deadline, _walk_node_count
    _walk_deadline = time.time() + _WALK_TIME_LIMIT
    _walk_node_count = 0
    elements = _walk_uia_tree(target_window, 0, max_depth, show_all, "")
    walked_nodes = _walk_node_count
    timed_out = time.time() > _walk_deadline
    print(f"  [nav_view] UIA walk: {walked_nodes} nodes, {len(elements)} elements" + (" (timed out)" if timed_out else ""))

    if len(elements) == 0 and not timed_out:
        hwnd = _get_hwnd(target_window)
        if hwnd:
            print(f"  [nav_view] UIA returned 0 — trying comtypes IUIAutomation direct (hwnd={hwnd})...")
            elements = _walk_comtypes_uia(hwnd, max_depth)
        if len(elements) == 0 and hwnd:
            print(f"  [nav_view] comtypes returned 0 — trying win32/MSAA backend...")
            elements = _walk_win32_backend(hwnd, max_depth)
        if len(elements) == 0 and hwnd:
            print(f"  [nav_view] MSAA returned 0 — trying raw EnumChildWindows...")
            elements = _walk_enum_child_windows(hwnd)
        if len(elements) == 0:
            print(f"  [nav_view] All backends returned 0. Citrix accessibility virtual channel may not be enabled.")

    if not show_all:
        elements = [e for e in elements if not e.get("static", False)]

    if search_term:
        search_lower = search_term.lower()
        elements = [e for e in elements if search_lower in (e.get("name", "")).lower()
                    or search_lower in (e.get("controlType", "")).lower()
                    or search_lower in (e.get("automationId", "")).lower()]
        print(f"  [nav_view] Search '{search_term}': {len(elements)} matches")

    interactive_elements = [e for e in elements if not e.get("static", False)]
    hint_keys = _generate_hint_keys(len(interactive_elements))
    hint_map = {}
    for i, elem in enumerate(interactive_elements):
        key = hint_keys[i] if i < len(hint_keys) else f"z{i}"
        elem["hint"] = key
        hint_map[key] = {
            "name": elem["name"],
            "controlType": elem["controlType"],
            "automationId": elem["automationId"],
            "rect": elem["rect"],
            "value": elem.get("value", ""),
        }
    for elem in elements:
        if elem.get("static"):
            elem["hint"] = ""

    cache_key = f"NAV:{actual_title}"
    _vimium_element_maps[cache_key] = hint_map

    post_result(command_id, "complete", data={
        "mode": "detail",
        "window": actual_title,
        "elements": elements,
        "hintMap": hint_map,
        "elementCount": len(elements),
        "interactiveCount": len(interactive_elements),
        "searchTerm": search_term,
        "matchCount": len(elements) if search_term else None,
    })

    _post_uia_cache({
        "mode": "detail",
        "target": window_title_arg,
        "window": {
            "title": actual_title,
            "elements": elements,
            "hintMap": hint_map,
        },
    })
    print(f"  [nav_view] {len(interactive_elements)} interactive, {len(elements)} total")


def execute_nav_do(cmd):
    """Interact with an element by hint key in ANY window, then auto re-scan."""
    window_title_arg = cmd.get("window", "")
    command_id = cmd.get("id", "unknown")
    hint = cmd.get("hint", "").lower().strip()
    value = cmd.get("value", "")

    if not hint:
        post_result(command_id, "error", error="Missing hint key")
        return
    if not window_title_arg:
        post_result(command_id, "error", error="Missing window title")
        return

    cache_key = None
    hint_map = None
    exact_key = f"NAV:{window_title_arg}"
    if exact_key in _vimium_element_maps:
        cache_key = exact_key
        hint_map = _vimium_element_maps[exact_key]
    else:
        for k, v in _vimium_element_maps.items():
            if k.startswith("NAV:") and window_title_arg.lower() in k.lower():
                cache_key = k
                hint_map = v
                break
    if not hint_map:
        post_result(command_id, "error", error=f"No element map for '{window_title_arg}'. Run nav_view first.")
        return

    elem_info = hint_map.get(hint)
    if not elem_info:
        available = ", ".join(sorted(hint_map.keys())[:20])
        post_result(command_id, "error", error=f"Unknown hint '{hint}'. Available: {available}")
        return

    ctrl_type = elem_info.get("controlType", "")
    name = elem_info.get("name", "")
    rect = elem_info.get("rect")
    print(f"  [nav_do] {hint} -> {ctrl_type} '{name}'" + (f" = '{value}'" if value else ""))

    target_window, actual_title = _find_window_by_title(window_title_arg)
    if not target_window:
        post_result(command_id, "error", error=f"No window matching '{window_title_arg}'")
        return

    try:
        target_window.set_focus()
        time.sleep(0.2)
    except Exception:
        pass

    auto_id = elem_info.get("automationId", "")
    uia_element = None
    if auto_id:
        try:
            found = target_window.child_window(auto_id=auto_id, control_type=ctrl_type)
            if found.exists():
                uia_element = found
        except Exception:
            pass
    if not uia_element and name:
        try:
            found = target_window.child_window(title=name, control_type=ctrl_type)
            if found.exists():
                uia_element = found
        except Exception:
            pass

    action_taken = "none"
    try:
        if uia_element:
            if ctrl_type in ("Edit", "ComboBox", "Spinner") and value:
                try:
                    uia_element.set_edit_text(value)
                    action_taken = f"typed '{value}'"
                except Exception:
                    uia_element.click_input()
                    time.sleep(0.2)
                    pyautogui.hotkey("ctrl", "a")
                    time.sleep(0.05)
                    pyautogui.typewrite(value, interval=0.03)
                    action_taken = f"typed '{value}' (fallback)"
            elif ctrl_type in ("CheckBox", "RadioButton"):
                try:
                    uia_element.toggle()
                    action_taken = "toggled"
                except Exception:
                    uia_element.click_input()
                    action_taken = "clicked (toggle fallback)"
            elif ctrl_type in ("ListItem", "TreeItem"):
                try:
                    uia_element.select()
                    action_taken = "selected"
                except Exception:
                    uia_element.click_input()
                    action_taken = "clicked (select fallback)"
            else:
                uia_element.click_input()
                action_taken = "clicked"
        elif rect:
            cx, cy = rect["cx"], rect["cy"]
            print(f"  [nav_do] Fallback to coordinate click ({cx}, {cy})")
            safe_click(cx, cy, pause_after=0.5, label=f"nav-{hint}")
            if ctrl_type in ("Edit", "ComboBox") and value:
                time.sleep(0.2)
                pyautogui.hotkey("ctrl", "a")
                time.sleep(0.05)
                pyautogui.typewrite(value, interval=0.03)
                action_taken = f"clicked+typed '{value}'"
            else:
                action_taken = "clicked (coordinates)"
        else:
            post_result(command_id, "error", error=f"Cannot interact with '{name}': no UIA element or coordinates")
            return
    except Exception as e:
        print(f"  [nav_do] Interaction error: {e}")
        if rect:
            cx, cy = rect["cx"], rect["cy"]
            safe_click(cx, cy, pause_after=0.5, label=f"nav-fallback-{hint}")
            if ctrl_type in ("Edit", "ComboBox") and value:
                time.sleep(0.2)
                pyautogui.typewrite(value, interval=0.03)
            action_taken = f"clicked (error fallback at {cx},{cy})"
        else:
            post_result(command_id, "error", error=f"Interaction failed: {e}")
            return

    print(f"  [nav_do] Action: {action_taken}")
    time.sleep(0.5)

    print(f"  [nav_do] Auto re-scanning...")
    execute_nav_view({"window": window_title_arg, "id": command_id, "showAll": False})


def _post_uia_cache(data):
    """Post UIA scan data to the server cache (best-effort, server also updates from results)."""
    try:
        resp = requests.post(
            f"{ORGCLOUD_URL}/api/epic/uia-tree",
            json=data,
            headers={"Authorization": f"Bearer {BRIDGE_TOKEN}"},
            timeout=5,
        )
        if resp.status_code == 200:
            print(f"  [cache] UIA tree cached")
    except Exception:
        pass


_LOGIN_CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "login_input_method.json")

def _load_proven_login_method():
    """Load the proven login input method from persistent config."""
    try:
        if os.path.exists(_LOGIN_CONFIG_FILE):
            with open(_LOGIN_CONFIG_FILE, "r") as f:
                data = json.load(f)
            method = data.get("proven_method")
            if method:
                print(f"  [login] Loaded proven input method: {method}")
            return method
    except Exception as e:
        print(f"  [login] Could not load login config: {e}")
    return None

def _save_proven_login_method(method_name):
    """Save a proven login input method to persistent config."""
    try:
        with open(_LOGIN_CONFIG_FILE, "w") as f:
            json.dump({"proven_method": method_name, "saved_at": time.strftime("%Y-%m-%dT%H:%M:%S")}, f)
        print(f"  [login] Saved proven input method: {method_name}")
    except Exception as e:
        print(f"  [login] Could not save login config: {e}")

def _invalidate_proven_login_method():
    """Delete the proven method file when login fails — forces re-discovery next time."""
    try:
        if os.path.exists(_LOGIN_CONFIG_FILE):
            os.remove(_LOGIN_CONFIG_FILE)
            print(f"  [login] Invalidated proven method (login failed, will re-discover next time)")
    except Exception as e:
        print(f"  [login] Could not delete login config: {e}")

def _type_via_clipboard(text):
    _clipboard_paste(text)

def _type_via_scancode(text):
    for ch in text:
        _sendinput_scancode_char(ch)
        time.sleep(0.03)

def _type_via_unicode(text):
    set_text_method("unicode")
    sendinput_typewrite(text, interval=0.03)

def _type_via_keybd_vk(text):
    set_keyboard_backend("keybd_event")
    set_text_method("vk")
    sendinput_typewrite(text, interval=0.03)

def _type_via_sendinput_vk(text):
    set_keyboard_backend("sendinput")
    set_text_method("vk")
    sendinput_typewrite(text, interval=0.03)

def _type_via_pyautogui(text):
    for ch in text:
        if ch.isupper():
            pyautogui.hotkey('shift', ch.lower())
        else:
            pyautogui.press(ch)
        time.sleep(0.04)

def _build_type_methods(window):
    """Build ordered list of (name, type_fn) for adaptive text input.
    Each type_fn(text) sends text using a different input method."""
    hwnd = getattr(window, '_hWnd', None)
    methods = [
        ("sendinput_vk", _type_via_sendinput_vk),
        ("keybd_vk", _type_via_keybd_vk),
        ("pyautogui", _type_via_pyautogui),
        ("unicode", _type_via_unicode),
        ("scancode", _type_via_scancode),
        ("clipboard", _type_via_clipboard),
    ]
    if hwnd:
        def _type_via_postmessage(text, _hwnd=hwnd):
            _postmessage_type(_hwnd, text)
        methods.append(("postmessage", _type_via_postmessage))
    return methods

def _clear_field():
    """Select all text in a field and delete it (Ctrl+A, Delete)."""
    _keybd_event_key(0x11, up=False)
    time.sleep(0.02)
    _keybd_event_key(0x41, up=False)
    time.sleep(0.02)
    _keybd_event_key(0x41, up=True)
    time.sleep(0.02)
    _keybd_event_key(0x11, up=True)
    time.sleep(0.05)
    _keybd_event_key(0x2E, up=False)
    time.sleep(0.02)
    _keybd_event_key(0x2E, up=True)
    time.sleep(0.1)

def _verify_field_has_text(window, field_description):
    """Take a screenshot and ask vision if the field has text in it.
    Returns True if text is detected in the field."""
    try:
        img = screenshot_window(window)
        b64 = img_to_base64(img)
        prompt = f"""Look at this screenshot. Focus on the {field_description}.
Does the field contain typed text (not placeholder/hint text)?
Return ONLY a JSON object: {{"has_text": true}} or {{"has_text": false}}"""
        response = ask_claude(b64, prompt)
        if not response:
            return None
        result = _extract_json_object(response)
        if result:
            return result.get("has_text", False)
    except Exception as e:
        print(f"  [login] Verify field error: {e}")
    return None

def _adaptive_type_text(window, text, field_description, proven_method=None, is_password=False, skip_verify=False):
    """Try multiple input methods to type text into a field.
    Verifies via vision after each attempt. Returns (success, method_name).
    For password fields, vision checks for dots/bullets/masked chars.
    When skip_verify=True, use proven/first method without vision check (for blind password fields)."""
    methods = _build_type_methods(window)

    if proven_method:
        proven = [(n, fn) for n, fn in methods if n == proven_method]
        rest = [(n, fn) for n, fn in methods if n != proven_method]
        methods = proven + rest

    prev_text = _text_method
    prev_backend = _active_backend

    if skip_verify and methods:
        for name, type_fn in methods:
            print(f"  [login] Using method '{name}' for {field_description} (blind/no-verify mode)")
            try:
                type_fn(text)
            except Exception as e:
                print(f"  [login] Method '{name}' threw exception in blind mode: {e}")
                set_text_method(prev_text)
                set_keyboard_backend(prev_backend)
                continue
            set_text_method(prev_text)
            set_keyboard_backend(prev_backend)
            time.sleep(0.3)
            return True, name
        print(f"  [login] ALL input methods threw exceptions for {field_description} (blind mode)")
        return False, None

    inconclusive_method = None

    for name, type_fn in methods:
        print(f"  [login] Trying input method '{name}' for {field_description}...")
        try:
            type_fn(text)
        except Exception as e:
            print(f"  [login] Method '{name}' threw exception: {e}")
            set_text_method(prev_text)
            set_keyboard_backend(prev_backend)
            continue

        set_text_method(prev_text)
        set_keyboard_backend(prev_backend)
        time.sleep(0.4)

        if is_password:
            has_text = _verify_field_has_text(window, f"{field_description} (look for dots, bullets, or masked characters indicating typed password)")
        else:
            has_text = _verify_field_has_text(window, field_description)

        if has_text is True:
            print(f"  [login] Method '{name}' WORKED for {field_description}")
            return True, name
        elif has_text is False:
            print(f"  [login] Method '{name}' did NOT work for {field_description}, clearing and trying next...")
            _clear_field()
            time.sleep(0.2)
        else:
            print(f"  [login] Method '{name}' — vision verification inconclusive, trying next method...")
            if inconclusive_method is None:
                inconclusive_method = name
            _clear_field()
            time.sleep(0.2)

    if inconclusive_method:
        print(f"  [login] No confirmed method — falling back to first inconclusive method '{inconclusive_method}'")
        for name, type_fn in methods:
            if name == inconclusive_method:
                try:
                    type_fn(text)
                except Exception:
                    pass
                set_text_method(prev_text)
                set_keyboard_backend(prev_backend)
                return True, inconclusive_method

    print(f"  [login] ALL input methods failed for {field_description}")
    return False, None


def _verify_login_result(window, method, pw_method=None):
    """Take a post-login screenshot and check if login succeeded.
    Only saves proven method if login is confirmed successful.
    Uses pw_method if it differs from username method (both worked)."""
    try:
        time.sleep(0.5)
        img = screenshot_window(window)
        b64 = img_to_base64(img)
        prompt = f"""Look at this screenshot. Is this showing:
1. A login error or "invalid credentials" message
2. A successfully logged-in application (patient list, menu, toolbar, schedule, etc.)
3. Still on the login/credential prompt

Return ONLY: {{"state": "error", "detail": "..."}} or {{"state": "logged_in"}} or {{"state": "login_screen"}}"""
        response = ask_claude(b64, prompt)
        if response:
            vresult = _extract_json_object(response)
            if vresult:
                state = vresult.get("state", "unknown")
                if state == "logged_in":
                    save_method = pw_method if pw_method else method
                    if save_method:
                        _save_proven_login_method(save_method)
                    return True, f"logged in (method: {save_method})"
                elif state == "error":
                    _invalidate_proven_login_method()
                    return False, f"login error: {vresult.get('detail', 'unknown')}"
                elif state == "login_screen":
                    _invalidate_proven_login_method()
                    return False, f"still on login screen after submit (method: {method})"
                else:
                    _invalidate_proven_login_method()
                    return False, f"login unconfirmed — unknown state (method: {method})"
    except Exception:
        pass
    _invalidate_proven_login_method()
    return False, f"login verification failed (method: {method})"


def _check_text_login_screen_uia(window):
    """Use the accessibility tree to check Text window login state (<100ms vs 2-5s for LLM)."""
    try:
        from pywinauto import Desktop
    except ImportError:
        return "UNKNOWN", "pywinauto not available"
    try:
        desktop = Desktop(backend="uia")
        hwnd = getattr(window, '_hWnd', None)
        if not hwnd:
            return "UNKNOWN", "no hwnd"
        target = None
        for w in desktop.windows():
            try:
                if w.element_info.handle == hwnd:
                    target = w
                    break
            except Exception:
                continue
        if not target:
            return "UNKNOWN", "window not found in UIA"
        texts = []
        has_edit = False
        try:
            for child in target.descendants(depth=3):
                try:
                    name = (child.element_info.name or "").strip()
                    ctrl_type = child.element_info.control_type or ""
                    if ctrl_type == "Edit":
                        has_edit = True
                    if name:
                        texts.append(name.lower())
                except Exception:
                    continue
        except Exception:
            pass
        combined = " ".join(texts)
        if has_edit or "login" in combined or "user" in combined or "password" in combined:
            if "password" in combined and "login" not in combined and "user" not in combined:
                result = "PASSWORD_PROMPT"
            else:
                result = "LOGIN_PROMPT"
        elif any(kw in combined for kw in ["patient", "schedule", "menu", "command", "epic", "welcome"]):
            result = "LOGGED_IN"
        else:
            result = "UNKNOWN"
        print(f"  [login] Text screen check (UIA): {result} (edit={has_edit}, texts={len(texts)})")
        return result, combined[:200]
    except Exception as e:
        print(f"  [login] UIA screen check error: {e}")
    return "UNKNOWN", ""


def _check_text_login_screen(window):
    """Use vision to check if a Text window is showing a login/credential prompt.
    Slow fallback (~2-5s) — prefer _check_text_login_screen_uia."""
    try:
        img = screenshot_window(window)
        b64 = img_to_base64(img)
        prompt = """Look at this screenshot of a terminal/text window. Is this showing:
1. A login prompt asking for username or credentials (e.g. "Login:", "Username:", "User ID:", or a blinking cursor at a login field)
2. A password prompt (e.g. "Password:", masked input field)
3. A successfully logged-in application (menu, command prompt, patient list, etc.)
4. Something else (error message, blank screen, etc.)

Reply with exactly one of: LOGIN_PROMPT, PASSWORD_PROMPT, LOGGED_IN, OTHER
Then on the next line, a brief description of what you see."""
        resp = ask_claude(b64, prompt)
        if resp:
            first_line = resp.strip().split("\n")[0].strip().upper()
            normalized = first_line
            for tag in ("LOGIN_PROMPT", "PASSWORD_PROMPT", "LOGGED_IN", "OTHER"):
                if tag in first_line:
                    normalized = tag
                    break
            print(f"  [login] Text screen check (vision): {normalized}")
            return normalized, resp
    except Exception as e:
        print(f"  [login] Text screen check error: {e}")
    return "UNKNOWN", ""


def _check_text_screen_fast(window):
    """Try UIA first (<100ms), fall back to LLM vision only if UIA returns UNKNOWN."""
    state, desc = _check_text_login_screen_uia(window)
    if state != "UNKNOWN":
        return state, desc
    print(f"  [login] UIA inconclusive, falling back to vision check")
    return _check_text_login_screen(window)


def _login_text_window(window, label, username, password, already_open=False):
    """Login to a Text/terminal window using adaptive input methods.
    Handles up to 2 sequential login prompts (system login then Epic login).
    Uses UIA accessibility tree for fast screen classification (<100ms).
    When already_open=True, checks for already-logged-in state before any keystrokes.
    When already_open=False (freshly launched), skips round-1 check for speed."""
    proven = _load_proven_login_method()
    try:
        activate_window(window)
        time.sleep(0.15)

        if already_open:
            pre_state, pre_desc = _check_text_login_screen_uia(window)
            if pre_state == "LOGGED_IN":
                print(f"  [login] {label}: already logged in (detected via UIA: {pre_desc})")
                return True, "already logged in"
            print(f"  [login] {label}: pre-existing window, UIA state: {pre_state}")

        if _uia_focus_input_field(window):
            time.sleep(0.1)

        for login_round in range(1, 3):
            round_label = f"login {login_round}/2" if login_round == 1 else "second login"

            activate_window(window)
            time.sleep(0.1)

            if login_round == 1 and not already_open:
                pre_state = "LOGIN_PROMPT"
                print(f"  [login] {label}: {round_label} — assuming LOGIN_PROMPT (freshly launched, skip check)")
            elif login_round == 1 and already_open:
                pre_state, _ = _check_text_login_screen_uia(window)
                print(f"  [login] {label}: {round_label} — pre-existing window, UIA state: {pre_state}")
                if pre_state == "UNKNOWN":
                    pre_state = "LOGIN_PROMPT"
            else:
                pre_state, _ = _check_text_screen_fast(window)

            if pre_state == "LOGGED_IN":
                print(f"  [login] {label}: {round_label} — already logged in")
                return True, "already logged in"
            elif pre_state in ("UNKNOWN", "OTHER") and login_round > 1:
                print(f"  [login] {label}: {round_label} — screen state {pre_state}, falling through to verification")
                return _verify_login_result(window, proven or "sendinput_vk")
            elif pre_state == "PASSWORD_PROMPT":
                print(f"  [login] {label}: {round_label} — password-only prompt detected, typing password (blind)")
                pw_success, pw_method = _adaptive_type_text(window, password, "password prompt", proven, is_password=True, skip_verify=True)
                if not pw_success:
                    return False, f"all input methods failed for password ({round_label})"
                method = pw_method
            elif pre_state in ("LOGIN_PROMPT", "UNKNOWN", "OTHER"):
                print(f"  [login] {label}: {round_label} — typing username")
                success, method = _adaptive_type_text(window, username, "username/login prompt", proven)
                if not success:
                    return False, f"all input methods failed for username ({round_label})"

                _keybd_event_key(0x0D, up=False)
                time.sleep(0.02)
                _keybd_event_key(0x0D, up=True)
                _wait_for_screen_change(window, timeout=3.0, poll_interval=0.3)

                activate_window(window)
                time.sleep(0.1)
                _uia_focus_input_field(window)

                print(f"  [login] {label}: {round_label} — typing password (blind)")
                pw_success, pw_method = _adaptive_type_text(window, password, "password prompt", method, is_password=True, skip_verify=True)
                if not pw_success:
                    return False, f"all input methods failed for password ({round_label})"

            time.sleep(0.1)
            _keybd_event_key(0x0D, up=False)
            time.sleep(0.02)
            _keybd_event_key(0x0D, up=True)
            _wait_for_screen_change(window, timeout=3.0, poll_interval=0.3)

            activate_window(window)
            time.sleep(0.1)
            screen_state, desc = _check_text_screen_fast(window)

            if screen_state == "LOGGED_IN":
                if login_round == 1:
                    print(f"  [login] {label}: first login succeeded, checking for second prompt...")
                    time.sleep(0.3)
                    screen_state2, _ = _check_text_screen_fast(window)
                    if screen_state2 in ("LOGIN_PROMPT", "PASSWORD_PROMPT"):
                        print(f"  [login] {label}: second login prompt detected, repeating credentials")
                        proven = method
                        continue
                print(f"  [login] {label}: login complete after {login_round} round(s)")
                _save_proven_login_method(method)
                return True, f"logged in (text, {login_round} round(s), method: {method})"
            elif screen_state in ("LOGIN_PROMPT", "PASSWORD_PROMPT"):
                if login_round == 1:
                    print(f"  [login] {label}: still on login prompt after first round, retrying")
                    proven = method
                    continue
                else:
                    _invalidate_proven_login_method()
                    return False, f"still on login screen after {login_round} rounds"
            else:
                return _verify_login_result(window, method, pw_method)

        _invalidate_proven_login_method()
        return False, "login failed after 2 rounds"
    except Exception as e:
        return False, str(e)[:60]


def _send_alt_o():
    _keybd_event_key(0x12, up=False)
    time.sleep(0.02)
    _keybd_event_key(0x4F, up=False)
    time.sleep(0.02)
    _keybd_event_key(0x4F, up=True)
    time.sleep(0.02)
    _keybd_event_key(0x12, up=True)


def _adaptive_type_text_no_verify(window, text, field_description, proven_method=None):
    methods = _build_type_methods(window)

    if proven_method:
        proven = [(n, fn) for n, fn in methods if n == proven_method]
        rest = [(n, fn) for n, fn in methods if n != proven_method]
        methods = proven + rest

    prev_text = _text_method
    prev_backend = _active_backend

    for name, type_fn in methods:
        print(f"  [login] Trying input method '{name}' for {field_description}...")
        try:
            type_fn(text)
        except Exception as e:
            print(f"  [login] Method '{name}' threw exception: {e}")
            set_text_method(prev_text)
            set_keyboard_backend(prev_backend)
            continue

        set_text_method(prev_text)
        set_keyboard_backend(prev_backend)
        time.sleep(0.3)
        print(f"  [login] Method '{name}' used for {field_description} (no vision verify)")
        return True, name

    print(f"  [login] ALL input methods failed for {field_description}")
    return False, None


def _is_window_past_login_uia(window):
    """Check if a window is past the login screen using the UIA accessibility tree.
    Returns: 'LOGGED_IN', 'LOGIN_SCREEN', or 'UNKNOWN'.
    Uses tri-state logic: only returns LOGGED_IN with positive evidence (app controls).
    Returns UNKNOWN when uncertain — caller should proceed with normal flow.
    Fast: <100ms. No vision/LLM calls."""
    try:
        from pywinauto import Desktop
    except ImportError:
        return "UNKNOWN"
    try:
        desktop = Desktop(backend="uia")
        hwnd = getattr(window, '_hWnd', None)
        if not hwnd:
            return "UNKNOWN"
        target = None
        for w in desktop.windows():
            try:
                if w.element_info.handle == hwnd:
                    target = w
                    break
            except Exception:
                continue
        if not target:
            return "UNKNOWN"
        edits = target.descendants(control_type="Edit")
        visible_edits = []
        for edit in edits:
            try:
                if edit.is_enabled() and edit.is_visible():
                    name = (edit.element_info.name or "").lower()
                    visible_edits.append(name)
                    if any(kw in name for kw in ("user", "login", "password", "credential")):
                        print(f"  [uia] Found login Edit control: '{edit.element_info.name}' — login screen")
                        return "LOGIN_SCREEN"
            except Exception:
                continue
        if len(visible_edits) == 0:
            print(f"  [uia] No visible Edit controls found — window is past login screen")
            return "LOGGED_IN"
        if len(visible_edits) <= 2:
            app_control_types = frozenset(["MenuBar", "ToolBar", "StatusBar", "TabControl", "DataGrid", "TreeView"])
            has_app_controls = False
            for child in target.descendants(depth=2):
                try:
                    if (child.element_info.control_type or "") in app_control_types:
                        has_app_controls = True
                        break
                except Exception:
                    continue
            if has_app_controls:
                print(f"  [uia] {len(visible_edits)} Edit(s) with app controls — already logged in (search/filter bars)")
                return "LOGGED_IN"
            print(f"  [uia] {len(visible_edits)} Edit(s) without app controls — likely login screen")
            return "LOGIN_SCREEN"
        print(f"  [uia] {len(visible_edits)} Edit controls — past login screen")
        return "LOGGED_IN"
    except Exception as e:
        print(f"  [uia] _is_window_past_login_uia failed: {e}")
    return "UNKNOWN"


def _login_hyperspace_window(window, label, username, password):
    """Login to a Hyperspace/Hyperdrive GUI window using keyboard-only flow.
    Username field is already focused when window launches maximized from Citrix.
    Alt+O submits login, selects department, and confirms (3 presses).
    Checks UIA accessibility tree first — skips login if already logged in."""
    proven = _load_proven_login_method()
    try:
        activate_window(window)
        time.sleep(0.15)

        uia_state = _is_window_past_login_uia(window)
        if uia_state == "LOGGED_IN":
            print(f"  [login] {label}: already logged in (app controls detected via UIA, no login fields)")
            return True, "already logged in"
        elif uia_state == "LOGIN_SCREEN":
            print(f"  [login] {label}: login screen detected via UIA, proceeding with credentials")

        if _uia_focus_input_field(window):
            time.sleep(0.1)
        else:
            print(f"  [login] {label}: UIA field focus unavailable, using default focus")
            time.sleep(0.15)

        print(f"  [login] {label}: typing username (vision-verified, window: {window.title})")
        success, method = _adaptive_type_text(window, username, "username field", proven)
        if not success:
            return False, "all input methods failed for username"
        print(f"  [login] {label}: username confirmed via vision, method: {method}")

        _keybd_event_key(0x09, up=False)
        time.sleep(0.02)
        _keybd_event_key(0x09, up=True)
        time.sleep(0.1)

        print(f"  [login] {label}: typing password (using proven method: {method})")
        pw_success, pw_method = _adaptive_type_text_no_verify(window, password, "password field", method)
        if not pw_success:
            return False, "all input methods failed for password"
        time.sleep(0.1)

        activate_window(window)
        time.sleep(0.1)
        print(f"  [login] {label}: sending Alt+O (login submit)")
        _send_alt_o()
        _wait_for_screen_change(window, timeout=5.0, poll_interval=0.3)

        activate_window(window)
        time.sleep(0.1)
        print(f"  [login] {label}: sending Alt+O (department continue)")
        _send_alt_o()
        _wait_for_screen_change(window, timeout=3.0, poll_interval=0.3)

        activate_window(window)
        time.sleep(0.1)
        print(f"  [login] {label}: sending Alt+O (message continue)")
        _send_alt_o()
        _wait_for_screen_change(window, timeout=3.0, poll_interval=0.3)

        return _verify_login_result(window, method, pw_method)

    except Exception as e:
        return False, str(e)[:60]


def _uia_focus_input_field(window, field_type="edit"):
    """Use pywinauto UIA to find and focus an input field in the window.
    Returns True if a field was found and focused, False otherwise."""
    try:
        from pywinauto import Desktop
    except ImportError:
        return False
    try:
        desktop = Desktop(backend="uia")
        hwnd = getattr(window, '_hWnd', None)
        if not hwnd:
            return False
        target = None
        for w in desktop.windows():
            try:
                if w.element_info.handle == hwnd:
                    target = w
                    break
            except Exception:
                continue
        if not target:
            return False
        edits = target.descendants(control_type="Edit")
        for edit in edits:
            try:
                if edit.is_enabled() and edit.is_visible():
                    edit.set_focus()
                    print(f"  [uia] Focused Edit control: '{edit.element_info.name or 'unnamed'}'")
                    return True
            except Exception:
                continue
        panes = target.descendants(control_type="Pane")
        for pane in panes:
            try:
                if pane.is_enabled() and pane.is_visible():
                    rect = pane.rectangle()
                    if rect.width() > 50 and rect.height() > 20:
                        pane.set_focus()
                        print(f"  [uia] Focused Pane: '{pane.element_info.name or 'unnamed'}'")
                        return True
            except Exception:
                continue
    except Exception as e:
        print(f"  [uia] Field focus failed: {e}")
    return False


def _compare_images_pil(img1, img2, sample_size=80):
    """Compare two PIL images by sampling pixels. Returns diff ratio 0.0-1.0."""
    s1 = img1.resize((sample_size, sample_size)).convert("RGB")
    s2 = img2.resize((sample_size, sample_size)).convert("RGB")
    b1 = s1.tobytes()
    b2 = s2.tobytes()
    total_diff = 0
    for v1, v2 in zip(b1, b2):
        total_diff += abs(v1 - v2)
    max_diff = len(b1) * 255
    return total_diff / max_diff if max_diff > 0 else 0.0


def _wait_for_screen_change(window, timeout=8.0, poll_interval=0.5, threshold=0.02):
    """Poll until the window screenshot changes significantly or timeout.
    Returns True if a change was detected, False on timeout."""
    try:
        bbox = (window.left, window.top, window.left + window.width, window.top + window.height)
        baseline = ImageGrab.grab(bbox=bbox, include_layered_windows=True)
        start = time.time()
        while time.time() - start < timeout:
            time.sleep(poll_interval)
            current = ImageGrab.grab(bbox=bbox, include_layered_windows=True)
            diff = _compare_images_pil(baseline, current)
            if diff > threshold:
                print(f"  [poll] Screen change detected ({diff:.3f} > {threshold}) after {time.time() - start:.1f}s")
                return True
        print(f"  [poll] No screen change after {timeout}s timeout")
        return False
    except Exception as e:
        print(f"  [poll] Screen change poll error: {e}, falling back to sleep")
        time.sleep(timeout * 0.5)
        return False


def _classify_window_uia(hwnd):
    """Read a shallow accessibility tree of a window by hwnd and classify it."""
    try:
        from pywinauto import Desktop
    except ImportError:
        return "unknown"
    try:
        desktop = Desktop(backend="uia")
        target = None
        for w in desktop.windows():
            try:
                if w.element_info.handle == hwnd:
                    target = w
                    break
            except Exception:
                continue
        if not target:
            return "unknown"
        title = (target.element_info.name or "").upper()
        if "HYPERSPACE" in title or "EPIC" in title or "HYPERDRIVE" in title:
            return "hyperspace"
        texts = []
        try:
            for child in target.descendants(depth=3):
                try:
                    name = child.element_info.name or ""
                    ctrl_type = child.element_info.control_type or ""
                    if name:
                        texts.append(name.lower())
                    if ctrl_type == "Edit":
                        texts.append("[edit_control]")
                except Exception:
                    continue
        except Exception:
            pass
        combined = " ".join(texts)
        if "login" in combined or "password" in combined or "user" in combined or "[edit_control]" in combined:
            return "text_login"
        if any(kw in combined for kw in ["patient", "schedule", "menu", "command", "epic"]):
            return "logged_in"
        return "other"
    except Exception as e:
        print(f"  [uia] Classification error: {e}")
        return "unknown"


def execute_snapshot_windows(cmd):
    """Snapshot all current window handles and titles."""
    global _window_snapshot
    command_id = cmd.get("id", "unknown")
    _window_snapshot = {}
    for w in gw.getAllWindows():
        hwnd = getattr(w, '_hWnd', None)
        title = w.title or ""
        if hwnd and title.strip():
            _window_snapshot[hwnd] = title
    count = len(_window_snapshot)
    print(f"  [snapshot] Captured {count} windows")
    post_result(command_id, "complete", data={"count": count})


def execute_detect_new_window(cmd):
    """Detect new windows that appeared after the last snapshot.
    Classifies each via shallow UIA tree inspection."""
    global _window_snapshot
    command_id = cmd.get("id", "unknown")
    env_hint = cmd.get("env", "").upper()
    new_windows = []
    for w in gw.getAllWindows():
        hwnd = getattr(w, '_hWnd', None)
        title = w.title or ""
        if hwnd and title.strip() and hwnd not in _window_snapshot:
            if w.width > 50 and w.height > 50:
                classification = _classify_window_uia(hwnd)
                new_windows.append({
                    "hwnd": hwnd,
                    "title": title,
                    "classification": classification,
                    "width": w.width,
                    "height": w.height,
                })
                print(f"  [detect] New window: '{title}' (hwnd={hwnd}, class={classification})")
    if not new_windows:
        all_current = [(getattr(w, '_hWnd', None), w.title) for w in gw.getAllWindows() if w.title and w.title.strip()]
        print(f"  [detect] No new windows found. Current: {len(all_current)}, Snapshot: {len(_window_snapshot)}")
    best = None
    if env_hint and new_windows:
        for nw in new_windows:
            if env_hint in nw["title"].upper():
                best = nw
                break
    if not best and new_windows:
        for nw in new_windows:
            if nw["classification"] in ("hyperspace", "text_login"):
                best = nw
                break
    if not best and new_windows:
        best = new_windows[0]
    post_result(command_id, "complete", data={
        "newWindows": new_windows,
        "best": best,
    })


def execute_login(cmd):
    command_id = cmd.get("id", "unknown")
    credentials = cmd.get("credentials", {})
    username = credentials.get("username", "")
    password = credentials.get("password", "")

    if not username or not password:
        post_result(command_id, "error", error="Missing username or password in credentials")
        return

    target_env = cmd.get("env", "").upper() if cmd.get("env") else ""
    target_client = cmd.get("client", "")
    target_hwnd = cmd.get("hwnd")

    if target_env and target_client:
        envs_clients = [(target_env, target_client)]
    elif target_env:
        envs_clients = [(target_env, "hyperspace"), (target_env, "text")]
    else:
        envs_clients = [(e, c) for e in ["SUP", "POC", "TST"] for c in ["hyperspace", "text"]]

    results = []
    logged_in = 0

    for env, client in envs_clients:
        window = None
        if target_hwnd:
            candidate = find_window_by_hwnd(target_hwnd)
            if candidate:
                window = candidate
                print(f"  [login] {env} {client}: using hwnd={target_hwnd} directly ('{candidate.title}')")
            else:
                print(f"  [login] {env} {client}: hwnd={target_hwnd} not found, falling back to title search")
        if not window:
            window = find_window(env, client=client)
        if not window:
            max_retries = 10 if client == "text" else 5
            retry_delay = 1.5 if client == "text" else 3
            for attempt in range(1, max_retries + 1):
                print(f"  [login] {env} {client}: no window found, retry {attempt}/{max_retries} in {retry_delay}s...")
                time.sleep(retry_delay)
                if target_hwnd:
                    window = find_window_by_hwnd(target_hwnd)
                if not window:
                    window = find_window(env, client=client)
                if window:
                    break
        if not window:
            print(f"  [login] {env} {client}: no window found after retries")
            results.append(f"  [~] {env} {client}: no window found after retries")
            continue

        label = f"{env} {client}"
        already_open = not bool(target_hwnd)
        print(f"  [login] Checking {label}: {window.title} (already_open={already_open}, hwnd={'set' if target_hwnd else 'none'})")
        # NOTE: already_open derivation — boot flow in cli-engine.ts only passes hwnd for
        # NEWLY detected windows (via pollForNewWindow after Citrix launch). Pre-existing
        # windows (found by checkAgentWindowExists before launch) get hwnd=null/omitted.
        # So: target_hwnd=None => pre-existing window (already_open=True)
        #     target_hwnd=<number> => freshly launched from Citrix (already_open=False)

        if client == "text":
            success, msg = _login_text_window(window, label, username, password, already_open=already_open)
        else:
            success, msg = _login_hyperspace_window(window, label, username, password)

        if success:
            logged_in += 1
            results.append(f"  [+] {label}: {msg}")
            print(f"  [login] {label}: {msg}")
        else:
            results.append(f"  [~] {label}: {msg}")
            print(f"  [login] {label}: {msg}")

    post_result(command_id, "complete", data={"logged_in": logged_in, "details": results})
    print(f"  [login] Done: {logged_in} windows")


def execute_check_windows(cmd):
    """Check if windows exist for given env/client without logging in."""
    command_id = cmd.get("id", "unknown")
    target_env = cmd.get("env", "").upper() if cmd.get("env") else ""
    target_client = cmd.get("client", "hyperspace")
    window = find_window(target_env, client=target_client)
    found = window is not None
    title = window.title if window else None
    if not found:
        all_titles = [w.title for w in gw.getAllWindows() if w.title and target_env in (w.title or "").upper()]
        print(f"  [check] {target_env} {target_client}: not found. Windows with '{target_env}': {all_titles[:10]}")
    else:
        print(f"  [check] {target_env} {target_client}: found ({title})")
    post_result(command_id, "complete", data={"found": found, "title": title})


def execute_command(cmd):
    cmd_type = cmd.get("type", "")
    print(f"\n>> Command: {cmd_type} (id: {cmd.get('id', '?')})")

    try:
        if cmd_type == "navigate":
            execute_navigate(cmd)
        elif cmd_type == "navigate_path":
            execute_navigate_path(cmd)
        elif cmd_type == "screenshot":
            execute_screenshot(cmd)
        elif cmd_type == "scan":
            execute_scan(cmd)
        elif cmd_type == "tree-scan":
            execute_tree_scan(cmd)
        elif cmd_type == "uia_tree":
            execute_uia_tree(cmd)
        elif cmd_type == "click":
            execute_click(cmd)
        elif cmd_type == "masterfile":
            execute_masterfile(cmd)
        elif cmd_type == "record_start":
            execute_record_start(cmd)
        elif cmd_type == "record_stop":
            execute_record_stop(cmd)
        elif cmd_type == "replay":
            execute_replay(cmd)
        elif cmd_type == "nav_replay":
            execute_nav_replay(cmd)
        elif cmd_type == "menu_crawl":
            execute_menu_crawl(cmd)
        elif cmd_type == "search_crawl":
            execute_search_crawl(cmd)
        elif cmd_type == "launch":
            execute_launch(cmd)
        elif cmd_type == "search":
            execute_search(cmd)
        elif cmd_type == "view":
            execute_view(cmd)
        elif cmd_type == "do":
            execute_do(cmd)
        elif cmd_type == "nav_view":
            execute_nav_view(cmd)
        elif cmd_type == "nav_do":
            execute_nav_do(cmd)
        elif cmd_type == "patient":
            execute_patient(cmd)
        elif cmd_type == "read_screen":
            execute_read_screen(cmd)
        elif cmd_type == "batch":
            execute_batch(cmd)
        elif cmd_type == "shortcuts":
            execute_shortcuts(cmd)
        elif cmd_type == "check_windows":
            execute_check_windows(cmd)
        elif cmd_type == "snapshot_windows":
            execute_snapshot_windows(cmd)
        elif cmd_type == "detect_new_window":
            execute_detect_new_window(cmd)
        elif cmd_type == "login":
            execute_login(cmd)
        elif cmd_type == "audio_start":
            execute_audio_start(cmd)
        elif cmd_type == "audio_stop":
            execute_audio_stop(cmd)
        elif cmd_type == "audio_status":
            execute_audio_status(cmd)
        elif cmd_type == "record_session_start":
            execute_record_session_start(cmd)
        elif cmd_type == "record_session_stop":
            execute_record_session_stop(cmd)
        elif cmd_type == "record_session_status":
            execute_record_session_status(cmd)
        elif cmd_type == "ocr_view":
            try:
                sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
                from ocr_overlay import execute_ocr_view
                execute_ocr_view(cmd)
            except ImportError as e:
                post_result(cmd.get("id", "unknown"), "error", error=f"ocr_overlay not available: {e}")
        elif cmd_type == "ocr_do":
            try:
                sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
                from ocr_overlay import execute_ocr_do
                execute_ocr_do(cmd)
            except ImportError as e:
                post_result(cmd.get("id", "unknown"), "error", error=f"ocr_overlay not available: {e}")
        else:
            post_result(cmd.get("id", "unknown"), "error", error=f"Unknown command type: {cmd_type}")
    except pyautogui.FailSafeException:
        raise
    except Exception as e:
        print(f"  [error] {e}")
        traceback.print_exc()
        post_result(cmd.get("id", "unknown"), "error", error=str(e))


def list_windows():
    envs = {}
    for env in ["SUP", "POC", "TST"]:
        w = find_window(env)
        if w:
            envs[env] = w.title
    return envs


def main():
    print("=" * 50)
    print("  Epic Desktop Agent")
    print("=" * 50)
    print(f"  OrgCloud: {ORGCLOUD_URL}")
    print(f"  Model:    {MODEL}")
    print(f"  Poll:     every {POLL_INTERVAL}s")
    print()

    if not OPENROUTER_API_KEY:
        print("WARNING: OPENROUTER_API_KEY not set — vision/AI commands disabled")
        print("  Deterministic commands (navigate_path, tree-scan, masterfile) will still work")
        print()

    register_global_hotkeys()

    windows = list_windows()
    if windows:
        print("Detected Hyperspace windows:")
        for env, title in windows.items():
            print(f"  {env}: {title}")
    else:
        print("No Hyperspace windows detected yet (will keep checking)")

    print()
    print("Agent running. Waiting for commands from OrgCloud...")
    print("Press Ctrl+C to stop.")
    print()

    heartbeat_interval = 30
    last_heartbeat = 0

    while True:
        try:
            now = time.time()
            if now - last_heartbeat > heartbeat_interval:
                windows = list_windows()
                window_titles = list(windows.values()) if windows else []
                try:
                    _always_on_heartbeat_tick(window_titles)
                except Exception as e:
                    print(f"  [always-on] tick error: {e}")
                send_heartbeat(list(windows.keys()))
                last_heartbeat = now

            commands = poll_commands()
            for cmd in commands:
                execute_command(cmd)

            recording_capture_tick()
            _audio_watchdog_tick()

            time.sleep(POLL_INTERVAL)

        except KeyboardInterrupt:
            print("\nAgent stopped.")
            break
        except pyautogui.FailSafeException:
            print("\n[FAILSAFE] Mouse moved to corner — agent paused for 10s. Move mouse away from corner to resume.")
            time.sleep(10)
        except Exception as e:
            print(f"Loop error: {e}")
            time.sleep(5)


if __name__ == "__main__":
    main()
