"""
Epic Desktop Agent
==================
Background agent that runs on your Windows desktop.
Polls OrgCloud for navigation commands and drives Hyperspace using
screenshots + Claude vision (via OpenRouter).

Requirements:
    pip install pyautogui pillow requests pygetwindow

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

try:
    import pyautogui
    import pygetwindow as gw
    from PIL import ImageGrab
    import requests
except ImportError:
    print("Missing dependencies. Run:")
    print("  pip install pyautogui pillow requests pygetwindow")
    sys.exit(1)

OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")
ORGCLOUD_URL = os.environ.get("ORGCLOUD_URL", "https://i-cloud-sync-manager.replit.app")
BRIDGE_TOKEN = os.environ.get("BRIDGE_TOKEN", "")
if not BRIDGE_TOKEN:
    print("ERROR: BRIDGE_TOKEN environment variable required")
    print("  set BRIDGE_TOKEN=<your-bridge-token>")
    sys.exit(1)
MODEL = "anthropic/claude-sonnet-4"
POLL_INTERVAL = 3

pyautogui.PAUSE = 0.2
pyautogui.FAILSAFE = True

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


def screenshot_window(window):
    try:
        window.activate()
        time.sleep(0.3)
    except Exception:
        pass
    bbox = (window.left, window.top, window.left + window.width, window.top + window.height)
    return ImageGrab.grab(bbox=bbox)


def img_to_base64(img):
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def ask_claude(screenshot_b64, prompt):
    if not OPENROUTER_API_KEY:
        return None
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
                                "image_url": {"url": f"data:image/png;base64,{screenshot_b64}"},
                            },
                            {"type": "text", "text": prompt},
                        ],
                    }
                ],
                "max_tokens": 4096,
            },
            timeout=60,
        )
        if resp.status_code != 200:
            print(f"  Claude API error: {resp.status_code}")
            return None
        return resp.json()["choices"][0]["message"]["content"]
    except Exception as e:
        print(f"  Claude error: {e}")
        return None


def poll_commands():
    try:
        resp = requests.get(
            f"{ORGCLOUD_URL}/api/epic/agent/commands",
            headers={
                "Authorization": f"Bearer {BRIDGE_TOKEN}",
                "X-Agent-Type": "epic-desktop",
            },
            timeout=10,
        )
        if resp.status_code == 200:
            data = resp.json()
            return data.get("commands", [])
        else:
            print(f"  [poll] HTTP {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        print(f"  [poll] Error: {e}")
    return []


def send_heartbeat(windows_found):
    try:
        resp = requests.post(
            f"{ORGCLOUD_URL}/api/epic/agent/heartbeat",
            headers={
                "Authorization": f"Bearer {BRIDGE_TOKEN}",
                "Content-Type": "application/json",
            },
            json={"windows": windows_found, "timestamp": time.time()},
            timeout=5,
        )
        if resp.status_code != 200:
            print(f"  [heartbeat] HTTP {resp.status_code}: {resp.text[:200]}")
    except Exception as e:
        print(f"  [heartbeat] Error: {e}")


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
    try:
        requests.post(
            f"{ORGCLOUD_URL}/api/epic/agent/results",
            headers={
                "Authorization": f"Bearer {BRIDGE_TOKEN}",
                "Content-Type": "application/json",
            },
            json=body,
            timeout=30,
        )
    except Exception as e:
        print(f"  Failed to post result: {e}")


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
                if key == "alt+space":
                    pyautogui.hotkey("alt", "space")
                elif "+" in key:
                    parts = key.split("+")
                    pyautogui.hotkey(*parts)
                else:
                    pyautogui.press(key)
                time.sleep(0.3)
            elif act_type == "search":
                pyautogui.hotkey("alt", "space")
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

    try:
        requests.post(
            f"{ORGCLOUD_URL}/api/epic/activities",
            headers={
                "Authorization": f"Bearer {BRIDGE_TOKEN}",
                "Content-Type": "application/json",
            },
            json={"environment": env, "activities": activities},
            timeout=30,
        )
    except Exception:
        pass

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
Return ONLY a JSON object: {{"x": <number>, "y": <number>, "found": true}}
If you cannot find it, return: {{"found": false, "reason": "why not found"}}
Coordinates should be relative to the image."""

    response = ask_claude(b64, prompt)
    if not response:
        post_result(command_id, "error", error="Claude did not respond")
        return

    try:
        json_match = re.search(r'\{[\s\S]*?\}', response)
        if not json_match:
            post_result(command_id, "error", error="Could not parse response")
            return
        result = json.loads(json_match.group())
    except Exception:
        post_result(command_id, "error", error="Invalid JSON")
        return

    if not result.get("found", False):
        post_result(command_id, "error", error=f"Element not found: {result.get('reason', 'unknown')}")
        return

    abs_x = window.left + result["x"]
    abs_y = window.top + result["y"]
    pyautogui.click(abs_x, abs_y)
    time.sleep(1.0)

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


def execute_navigate_path(cmd):
    """Navigate using a stored path by replaying deterministic clicks/keystrokes."""
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

    try:
        window.activate()
        time.sleep(0.5)
    except Exception:
        pass

    if client == "text":
        for i, step in enumerate(steps):
            num_match = re.match(r'^(\d+)$', step.strip())
            if not num_match:
                num_match = re.match(r'^(\d+)\s', step.strip())
            if not num_match:
                post_result(command_id, "error", error=f"Safety block: Text step {i+1} '{step}' is not a valid numeric menu option. Only numeric selections are allowed.")
                return
            keystroke = num_match.group(1)
            print(f"  [step {i+1}/{len(steps)}] Typing: {keystroke} ({step})")
            pyautogui.typewrite(keystroke, interval=0.05)
            pyautogui.press("enter")
            time.sleep(1.0)
    else:
        try:
            from pywinauto import Desktop
            desktop = Desktop(backend="uia")
            uia_window = None
            env_upper = env.upper()
            for w in desktop.windows():
                try:
                    title = w.element_info.name or ""
                    t = title.upper()
                    if env_upper in t and ("HYPERSPACE" in t or "EPIC" in t or "HYPERDRIVE" in t):
                        uia_window = w
                        break
                except Exception:
                    continue

            if not uia_window:
                post_result(command_id, "error", error=f"No {env} UIA window found for path replay")
                return

            NAV_SAFE_TYPES = frozenset([
                "MenuItem", "Menu", "MenuBar",
                "ToolBar", "ToolBarButton",
                "TabItem", "TabControl",
                "TreeItem", "TreeView",
                "Header", "HeaderItem",
                "SplitButton", "Hyperlink",
                "StatusBar",
            ])
            NAV_UNSAFE_PATTERNS = frozenset([
                "save", "submit", "yes", "delete", "remove",
                "sign", "confirm", "apply", "approve",
                "print", "send", "release", "finalize",
            ])
            NAV_UNSAFE_EXACT = frozenset([
                "ok", "okay", "order",
            ])

            current_parent = uia_window
            for i, step in enumerate(steps):
                print(f"  [step {i+1}/{len(steps)}] UIA find+click: {step}")
                element = find_uia_element_by_name(current_parent, step)
                if not element:
                    element = find_uia_element_by_name(uia_window, step)
                if not element:
                    post_result(command_id, "error", error=f"UIA element not found at step {i+1}: {step}")
                    return
                try:
                    ctrl_type = element.element_info.control_type or ""
                    el_name = (element.element_info.name or "").lower()

                    if ctrl_type not in NAV_SAFE_TYPES:
                        post_result(command_id, "error", error=f"Safety block: {step} has control type '{ctrl_type}' (not in navigation allowlist)")
                        return
                    for unsafe in NAV_UNSAFE_PATTERNS:
                        if unsafe in el_name:
                            post_result(command_id, "error", error=f"Safety block: {step} matches unsafe pattern '{unsafe}'")
                            return
                    el_words = set(re.split(r'[\s\-_/]+', el_name))
                    for exact in NAV_UNSAFE_EXACT:
                        if exact in el_words:
                            post_result(command_id, "error", error=f"Safety block: {step} matches unsafe word '{exact}'")
                            return

                    if ctrl_type in ("MenuItem", "Menu"):
                        try:
                            element.expand()
                        except Exception:
                            element.click_input()
                    else:
                        element.click_input()
                except Exception as e:
                    post_result(command_id, "error", error=f"Failed to click step {i+1} ({step}): {str(e)}")
                    return
                time.sleep(0.5)
                current_parent = element

        except ImportError:
            post_result(command_id, "error", error="pywinauto not installed for UIA path replay")
            return

    time.sleep(0.5)
    final_img = screenshot_window(window)
    final_b64 = img_to_base64(final_img)
    post_result(command_id, "complete", screenshot_b64=final_b64, data={
        "path": path,
        "client": client,
        "stepsCompleted": len(steps),
    })
    print(f"  [path-nav] Complete: {len(steps)} steps executed")


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
        window.activate()
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
            json_match = re.search(r'\{[^}]+\}', text)
            if json_match:
                parsed = json.loads(json_match.group())
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
        try:
            resp = requests.post(
                f"{ORGCLOUD_URL}/api/epic/record/steps",
                headers={
                    "Authorization": f"Bearer {BRIDGE_TOKEN}",
                    "Content-Type": "application/json",
                },
                json={"steps": recording_state["pending_steps"]},
                timeout=10,
            )
            if resp.status_code == 200:
                recording_state["pending_steps"] = []
            elif resp.status_code == 409:
                print("  [record] Server says recording stopped, halting capture")
                recording_state["active"] = False
                recording_state["pending_steps"] = []
            else:
                print(f"  [record] Upload failed ({resp.status_code}), will retry")
        except Exception as e:
            print(f"  [record] Upload error: {e}")


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
        try:
            requests.post(
                f"{ORGCLOUD_URL}/api/epic/record/steps",
                headers={
                    "Authorization": f"Bearer {BRIDGE_TOKEN}",
                    "Content-Type": "application/json",
                },
                json={"steps": recording_state["pending_steps"]},
                timeout=10,
            )
            recording_state["pending_steps"] = []
        except Exception as e:
            print(f"  [record] Final upload error: {e}")
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
                    json_match = re.search(r'\{[^}]+\}', text)
                    if json_match:
                        parsed = json.loads(json_match.group())
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


def uia_find_by_name(parent, name, exact=True):
    """Find a UI element by name, searching children."""
    name_lower = name.lower().strip()
    try:
        for child in parent.children():
            try:
                child_name = (child.element_info.name or "").strip()
                if exact:
                    if child_name.lower() == name_lower:
                        return child
                else:
                    if name_lower in child_name.lower():
                        return child
            except Exception:
                continue
        for child in parent.children():
            try:
                found = uia_find_by_name(child, name, exact)
                if found:
                    return found
            except Exception:
                continue
    except Exception:
        pass
    return None


def uia_collect_named_children(element, max_depth=2, current_depth=0):
    """Collect all named children of an element as a flat list."""
    items = []
    if current_depth >= max_depth:
        return items
    try:
        for child in element.children():
            try:
                name = (child.element_info.name or "").strip()
                ctrl_type = child.element_info.control_type or ""
                if not name:
                    sub = uia_collect_named_children(child, max_depth, current_depth + 1)
                    items.extend(sub)
                    continue
                if ctrl_type in ("TitleBar", "ScrollBar", "Thumb", "Image", "Separator", "Text"):
                    continue
                if len(name) > 100:
                    continue
                items.append({"name": name, "controlType": ctrl_type, "element": child})
            except Exception:
                continue
    except Exception:
        pass
    return items


def execute_menu_crawl(cmd):
    """Crawl Epic menus by clicking the Epic button, then each menu category.
    Uses pywinauto to programmatically click and read - no mouse control needed."""
    env = cmd.get("env", "SUP")
    command_id = cmd.get("id", "unknown")
    depth = cmd.get("depth", 2)

    print(f"  [menu-crawl] Starting Epic menu crawl for {env} (depth={depth})")

    try:
        from pywinauto import Desktop
    except ImportError:
        post_result(command_id, "error", error="pywinauto not installed. Run: pip install pywinauto")
        return

    window = find_window(env)
    if not window:
        post_result(command_id, "error", error=f"No {env} window found")
        return

    try:
        desktop = Desktop(backend="uia")
        uia_window = None
        env_upper = env.upper()
        for w in desktop.windows():
            try:
                title = w.element_info.name or ""
                t = title.upper()
                if env_upper in t and ("HYPERSPACE" in t or "EPIC" in t or "HYPERDRIVE" in t):
                    uia_window = w
                    break
            except Exception:
                continue

        if not uia_window:
            post_result(command_id, "error", error=f"No {env} UIA window found")
            return

        print(f"  [menu-crawl] Found UIA window: {uia_window.element_info.name}")

        try:
            uia_window.set_focus()
            time.sleep(0.5)
        except Exception:
            pass

        epic_button = None
        for search_name in ["Epic", "Epic Button", "EpicButton", "Menu"]:
            epic_button = uia_find_by_name(uia_window, search_name)
            if epic_button:
                print(f"  [menu-crawl] Found Epic button: '{epic_button.element_info.name}' ({epic_button.element_info.control_type})")
                break

        if not epic_button:
            print(f"  [menu-crawl] No 'Epic' button found, searching for menu/toolbar...")
            top_items = uia_collect_named_children(uia_window, max_depth=3)
            print(f"  [menu-crawl] Found {len(top_items)} top-level elements:")
            for item in top_items[:30]:
                print(f"    - '{item['name']}' ({item['controlType']})")

            if not top_items:
                post_result(command_id, "error", error="No UI elements found in window")
                return

            menu_types = ("MenuItem", "Menu", "MenuBar", "Button", "SplitButton",
                          "ToolBar", "TabItem", "TreeItem", "ListItem", "Hyperlink",
                          "Pane", "Group", "Custom")
            menu_items = [i for i in top_items if i["controlType"] in menu_types]
            if not menu_items:
                menu_items = top_items

            tree_children = []
            for item in menu_items:
                node = {
                    "name": item["name"],
                    "controlType": item["controlType"],
                    "path": item["name"],
                    "children": []
                }
                tree_children.append(node)

            tree = {
                "name": "Epic Menu",
                "children": tree_children,
                "client": "hyperspace",
                "environment": env,
                "scannedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }

            try:
                requests.post(
                    f"{ORGCLOUD_URL}/api/epic/tree",
                    headers={
                        "Authorization": f"Bearer {BRIDGE_TOKEN}",
                        "Content-Type": "application/json",
                    },
                    json=tree,
                    timeout=30,
                )
            except Exception:
                pass

            post_result(command_id, "complete", data={
                "totalItems": len(tree_children),
                "topLevel": len(tree_children),
                "note": "Epic button not found - captured top-level elements only",
            })
            return

        try:
            ct = epic_button.element_info.control_type or ""
            if ct in ("MenuItem", "Menu"):
                epic_button.expand()
            else:
                epic_button.click_input()
            time.sleep(1.0)
            print(f"  [menu-crawl] Epic button clicked/expanded")
        except Exception as e:
            print(f"  [menu-crawl] Failed to click Epic button: {e}")
            try:
                epic_button.click_input()
                time.sleep(1.0)
            except Exception as e2:
                post_result(command_id, "error", error=f"Cannot click Epic button: {e2}")
                return

        top_menu_items = uia_collect_named_children(epic_button, max_depth=2)
        if not top_menu_items:
            time.sleep(0.5)
            top_menu_items = uia_collect_named_children(uia_window, max_depth=3)

        print(f"  [menu-crawl] Found {len(top_menu_items)} menu items after clicking Epic button")
        for item in top_menu_items:
            print(f"    - '{item['name']}' ({item['controlType']})")

        tree_children = []
        crawled_count = 0

        for item in top_menu_items:
            item_name = item["name"]
            ctrl_type = item["controlType"]
            element = item["element"]

            node = {
                "name": item_name,
                "controlType": ctrl_type,
                "path": item_name,
                "children": []
            }
            crawled_count += 1

            if depth >= 2 and ctrl_type in ("MenuItem", "Menu", "TreeItem", "ListItem", "TabItem", "Button", "Hyperlink"):
                print(f"  [menu-crawl] Expanding '{item_name}'...")
                try:
                    try:
                        element.expand()
                        time.sleep(0.5)
                    except Exception:
                        try:
                            element.click_input()
                            time.sleep(0.5)
                        except Exception:
                            pass

                    sub_items = uia_collect_named_children(element, max_depth=2)

                    if not sub_items:
                        sub_items = uia_collect_named_children(uia_window, max_depth=2)
                        sub_items = [s for s in sub_items if s["name"] != item_name]

                    if sub_items:
                        print(f"  [menu-crawl]   '{item_name}' -> {len(sub_items)} sub-items")
                        for si in sub_items:
                            sub_node = {
                                "name": si["name"],
                                "controlType": si["controlType"],
                                "path": f"{item_name} > {si['name']}",
                                "children": []
                            }

                            if depth >= 3 and si["controlType"] in ("MenuItem", "Menu", "TreeItem"):
                                try:
                                    si["element"].expand()
                                    time.sleep(0.3)
                                    sub_sub = uia_collect_named_children(si["element"], max_depth=1)
                                    if sub_sub:
                                        for ssi in sub_sub:
                                            sub_node["children"].append({
                                                "name": ssi["name"],
                                                "controlType": ssi["controlType"],
                                                "path": f"{item_name} > {si['name']} > {ssi['name']}",
                                                "children": []
                                            })
                                            crawled_count += 1
                                    try:
                                        si["element"].collapse()
                                    except Exception:
                                        pass
                                except Exception:
                                    pass

                            node["children"].append(sub_node)
                            crawled_count += 1

                    try:
                        element.collapse()
                        time.sleep(0.3)
                    except Exception:
                        pass

                except Exception as e:
                    print(f"  [menu-crawl]   Error expanding '{item_name}': {e}")

            tree_children.append(node)

        try:
            ct = epic_button.element_info.control_type or ""
            if ct in ("MenuItem", "Menu"):
                epic_button.collapse()
            else:
                pyautogui.press("escape")
            time.sleep(0.3)
        except Exception:
            pass

        tree = {
            "name": "Epic Menu",
            "children": tree_children,
            "client": "hyperspace",
            "environment": env,
            "scannedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }

        try:
            resp = requests.post(
                f"{ORGCLOUD_URL}/api/epic/tree",
                headers={
                    "Authorization": f"Bearer {BRIDGE_TOKEN}",
                    "Content-Type": "application/json",
                },
                json=tree,
                timeout=30,
            )
            if resp.status_code == 200:
                print(f"  [menu-crawl] Tree uploaded: {crawled_count} items")
            else:
                print(f"  [menu-crawl] Upload failed: HTTP {resp.status_code}")
        except Exception as e:
            print(f"  [menu-crawl] Upload error: {e}")

        final_img = screenshot_window(window)
        final_b64 = img_to_base64(final_img) if final_img else None
        post_result(command_id, "complete", screenshot_b64=final_b64, data={
            "totalItems": crawled_count,
            "topLevel": len(tree_children),
        })
        print(f"  [menu-crawl] Complete! {crawled_count} items across {len(tree_children)} sections")

    except Exception as e:
        print(f"  [menu-crawl] Error: {e}")
        traceback.print_exc()
        post_result(command_id, "error", error=str(e))


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
        else:
            post_result(cmd.get("id", "unknown"), "error", error=f"Unknown command type: {cmd_type}")
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
        except Exception as e:
            print(f"Loop error: {e}")
            time.sleep(5)


if __name__ == "__main__":
    main()
