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
                    _key_fn(vk, up=False)
                    time.sleep(0.015)
                    _key_fn(vk, up=True)
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

        VK_C = 0x43
        VK_X = 0x58
        VK_S = 0x53
        VK_A = 0x41

        hotkey_map = {
            HOTKEY_CAPTURE: ("capture", VK_C, "Alt+C"),
            HOTKEY_COMMAND: ("command", VK_X, "Alt+X"),
            HOTKEY_SEARCH:  ("search",  VK_S, "Alt+S"),
            HOTKEY_AGENDA:  ("agenda",  VK_A, "Alt+A"),
        }

        registered = []
        for hk_id, (mode, vk, label) in hotkey_map.items():
            ok = user32.RegisterHotKey(None, hk_id, mods, vk)
            if ok:
                registered.append(label)
            else:
                print(f"  [hotkey] WARNING: {label} could not be registered (may be in use by another app)")

        if registered:
            print(f"  [hotkey] Global hotkeys registered: {', '.join(registered)}")
            print("    Alt+C = Capture  |  Alt+X = Command (M-x)")
            print("    Alt+S = Search   |  Alt+A = Agenda")
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
    for w in gw.getAllWindows():
        title = w.title or ""
        t = title.upper()
        if env_upper in t and ("TEXT" in t or "TERMINAL" in t or "SESSION" in t or "CACHE" in t):
            return w
    for w in gw.getAllWindows():
        title = w.title or ""
        t = title.upper()
        if env_upper in t and ("EXCEED" in t or "PUTTY" in t or "TERATERM" in t):
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


def send_heartbeat(windows_found):
    resp = _bridge_request(
        "post", "/api/epic/agent/heartbeat", "heartbeat", timeout=5,
        headers={
            "Authorization": f"Bearer {BRIDGE_TOKEN}",
            "Content-Type": "application/json",
        },
        json={"windows": windows_found, "timestamp": time.time()},
    )
    if resp and resp.status_code != 200:
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

    prompt = """Describe what you see on this Epic Hyperspace/Hyperdrive screen.
Include:
- What area/activity/screen is currently displayed
- Any patient context visible (no PHI - just "patient context is visible" or "no patient context")
- What menu items, tabs, buttons are available
- Any alerts, notifications, or status messages

Return a JSON object:
{
  "screen": "name/description of current screen",
  "area": "which Epic area (e.g., Schedule, Patient Lookup, Orders, etc.)",
  "availableActions": ["list", "of", "clickable", "items"],
  "alerts": ["any", "visible", "alerts"],
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
        f"Find the menu item or button labeled \"{item_name}\" in this screenshot.\n"
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
        f"After clicking '{expected_item}'{(' (' + context + ')') if context else ''}, what happened?\n"
        "Classify the current screen state:\n"
        f"- 'menu': A menu or submenu is visible (indicating '{expected_item}' expanded or a new menu appeared)\n"
        "- 'activity': An activity, workspace, or form opened (the menu is gone)\n"
        "- 'dialog': A dialog box or popup appeared\n"
        "- 'desktop': Back to the main Epic desktop, no menus open\n"
        "- 'same': Nothing seems to have changed\n\n"
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
                        {"type": "text", "text": "Describe in one sentence what NAVIGATION action the user took between these two screens. Also identify the current screen/activity name. IMPORTANT: Only describe menu clicks, button presses, and screen transitions. Do NOT mention any patient names, MRNs, dates of birth, or any clinical/PHI data visible on screen. Reply as JSON: {\"action\": \"...\", \"screen\": \"...\"}"},
                    ]
                })
            else:
                messages.append({
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "This is an Epic Hyperspace screen. Identify the current screen/activity name. IMPORTANT: Do NOT mention any patient names, MRNs, dates of birth, or any clinical/PHI data. Reply as JSON: {\"action\": \"Initial screen\", \"screen\": \"...\"}"},
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
            f"Look at this Epic Hyperspace screen{(' (' + context + ')') if context else ''}.\n\n"
            "Determine the current screen state by looking for these specific visual cues:\n\n"
            "'menu': A dropdown/popup menu panel is visible OVERLAYING the main window. This looks like:\n"
            "  - A floating panel/popup with a list of items\n"
            "  - The Epic button menu has TWO columns: left=Pinned/Recent, right=Navigation categories\n"
            "  - Submenu popups appear as additional floating panels\n"
            "  - The menu panel has a distinct border/shadow separating it from the background\n\n"
            "'desktop': The main Epic workspace/dashboard is showing with NO overlay menus. This is:\n"
            "  - The normal working view with tabs, patient lists, or a dashboard\n"
            "  - No floating menu panels visible\n"
            "  - The toolbar/ribbon is visible at the top but no dropdown is open\n\n"
            "'activity': A specific clinical activity/form has opened (like a patient chart, lab results, etc.)\n\n"
            "'dialog': A modal dialog box (save prompt, confirmation, error message) is showing\n\n"
            "IMPORTANT: If you see the Epic desktop/workspace with NO floating menu panels, that is 'desktop', not 'menu'.\n"
            "A menu must be a FLOATING OVERLAY panel, not just the toolbar.\n\n"
            "Return ONLY: {\"state\": \"menu\"|\"activity\"|\"dialog\"|\"desktop\", \"description\": \"brief description of what you see\"}"
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
        f"You are looking at an Epic Hyperspace screen.\n"
        f"{focus_hint}"
        "Extract ALL visible data into structured JSON. Include:\n"
        "- Patient demographics (name, MRN, DOB, age, sex, location, room)\n"
        "- Current activity/workspace name\n"
        "- Any visible clinical data (vitals, labs, meds, orders, allergies, diagnoses)\n"
        "- Navigation breadcrumb or current location in Epic\n"
        "- Status messages or alerts visible on screen\n"
        "- Any table/grid data with column headers and row values\n\n"
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
    pyautogui.typewrite(text, interval=0.04)

def _build_type_methods(window):
    """Build ordered list of (name, type_fn) for adaptive text input.
    Each type_fn(text) sends text using a different input method."""
    hwnd = getattr(window, '_hWnd', None)
    methods = [
        ("clipboard", _type_via_clipboard),
        ("scancode", _type_via_scancode),
        ("unicode", _type_via_unicode),
        ("keybd_vk", _type_via_keybd_vk),
        ("sendinput_vk", _type_via_sendinput_vk),
        ("pyautogui", _type_via_pyautogui),
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

def _adaptive_type_text(window, text, field_description, proven_method=None, is_password=False):
    """Try multiple input methods to type text into a field.
    Verifies via vision after each attempt. Returns (success, method_name).
    For password fields, vision checks for dots/bullets/masked chars."""
    methods = _build_type_methods(window)

    if proven_method:
        proven = [(n, fn) for n, fn in methods if n == proven_method]
        rest = [(n, fn) for n, fn in methods if n != proven_method]
        methods = proven + rest

    prev_text = _text_method
    prev_backend = _active_backend
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
        time.sleep(2.0)
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
                    return False, f"login error: {vresult.get('detail', 'unknown')}"
                elif state == "login_screen":
                    return False, f"still on login screen after submit (method: {method})"
                else:
                    return False, f"login unconfirmed — unknown state (method: {method})"
    except Exception:
        pass
    return False, f"login verification failed (method: {method})"


def _login_text_window(window, label, username, password):
    """Login to a Text/terminal window using adaptive input methods."""
    proven = _load_proven_login_method()
    try:
        activate_window(window)
        time.sleep(0.5)

        print(f"  [login] {label}: terminal login — typing username")
        success, method = _adaptive_type_text(window, username, "username/login prompt", proven)
        if not success:
            return False, "all input methods failed for username"

        _keybd_event_key(0x0D, up=False)
        time.sleep(0.02)
        _keybd_event_key(0x0D, up=True)
        time.sleep(1.5)

        print(f"  [login] {label}: typing password")
        pw_success, pw_method = _adaptive_type_text(window, password, "password prompt", method, is_password=True)
        if not pw_success:
            return False, "all input methods failed for password"
        time.sleep(0.3)

        _keybd_event_key(0x0D, up=False)
        time.sleep(0.02)
        _keybd_event_key(0x0D, up=True)
        time.sleep(1.0)

        return _verify_login_result(window, method, pw_method)
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


def _login_hyperspace_window(window, label, username, password):
    """Login to a Hyperspace/Hyperdrive GUI window using keyboard-only flow.
    Username field is already focused when window launches maximized from Citrix.
    Alt+O submits login, selects department, and confirms (3 presses)."""
    proven = _load_proven_login_method()
    try:
        activate_window(window)
        time.sleep(1.0)

        print(f"  [login] {label}: typing username (keyboard-only, window: {window.title})")
        success, method = _adaptive_type_text_no_verify(window, username, "username field", proven)
        if not success:
            return False, "all input methods failed for username"

        _keybd_event_key(0x09, up=False)
        time.sleep(0.02)
        _keybd_event_key(0x09, up=True)
        time.sleep(0.3)

        print(f"  [login] {label}: typing password")
        pw_success, pw_method = _adaptive_type_text_no_verify(window, password, "password field", method)
        if not pw_success:
            return False, "all input methods failed for password"
        time.sleep(0.3)

        print(f"  [login] {label}: sending Alt+O (login)")
        _send_alt_o()
        time.sleep(3.0)

        print(f"  [login] {label}: sending Alt+O (department)")
        _send_alt_o()
        time.sleep(3.0)

        print(f"  [login] {label}: sending Alt+O (confirm)")
        _send_alt_o()
        time.sleep(3.0)

        return _verify_login_result(window, method, pw_method)

    except Exception as e:
        return False, str(e)[:60]


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

    if target_env and target_client:
        envs_clients = [(target_env, target_client)]
    elif target_env:
        envs_clients = [(target_env, "hyperspace"), (target_env, "text")]
    else:
        envs_clients = [(e, c) for e in ["SUP", "POC", "TST"] for c in ["hyperspace", "text"]]

    results = []
    logged_in = 0

    for env, client in envs_clients:
        window = find_window(env, client=client)
        if not window:
            for attempt in range(1, 6):
                print(f"  [login] {env} {client}: no window found, retry {attempt}/5 in 3s...")
                time.sleep(3)
                window = find_window(env, client=client)
                if window:
                    break
        if not window:
            print(f"  [login] {env} {client}: no window found after retries")
            results.append(f"  [~] {env} {client}: no window found after retries")
            continue

        label = f"{env} {client}"
        print(f"  [login] Checking {label}: {window.title}")

        if client == "text":
            success, msg = _login_text_window(window, label, username, password)
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
        elif cmd_type == "patient":
            execute_patient(cmd)
        elif cmd_type == "read_screen":
            execute_read_screen(cmd)
        elif cmd_type == "batch":
            execute_batch(cmd)
        elif cmd_type == "shortcuts":
            execute_shortcuts(cmd)
        elif cmd_type == "login":
            execute_login(cmd)
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
                send_heartbeat(list(windows.keys()))
                last_heartbeat = now

            commands = poll_commands()
            for cmd in commands:
                execute_command(cmd)

            recording_capture_tick()

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
