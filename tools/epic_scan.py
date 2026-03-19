"""
Epic Hyperspace Activity Scanner
================================
Runs on your desktop. Uses screenshots + Claude vision (via OpenRouter)
to explore Hyperspace menus and catalog all available activities.

Requirements:
    pip install pyautogui pillow requests pygetwindow

Usage:
    python epic_scan.py SUP
    python epic_scan.py POC
    python epic_scan.py TST

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

try:
    import pyautogui
    import pygetwindow as gw
    from PIL import Image, ImageGrab
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
    sys.exit(1)
MODEL = "anthropic/claude-sonnet-4"

pyautogui.PAUSE = 0.3
pyautogui.FAILSAFE = True


def find_hyperspace_window(env):
    """Find the Hyperspace window for the given environment (SUP, POC, TST)."""
    env_upper = env.upper()
    candidates = []
    for w in gw.getAllWindows():
        title = w.title or ""
        if env_upper in title.upper() and ("hyperspace" in title.lower() or "epic" in title.lower() or "hyperdrive" in title.lower()):
            candidates.append(w)
    if not candidates:
        for w in gw.getAllWindows():
            title = w.title or ""
            if env_upper in title.upper():
                candidates.append(w)
    return candidates[0] if candidates else None


def screenshot_window(window):
    """Capture a screenshot of the given window."""
    try:
        window.activate()
        time.sleep(0.5)
    except Exception:
        pass
    bbox = (window.left, window.top, window.left + window.width, window.top + window.height)
    img = ImageGrab.grab(bbox=bbox)
    return img


def img_to_base64(img):
    """Convert PIL Image to base64 string."""
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode("utf-8")


def ask_claude(screenshot_b64, prompt):
    """Send a screenshot to Claude via OpenRouter and get a response."""
    if not OPENROUTER_API_KEY:
        print("ERROR: OPENROUTER_API_KEY not set")
        sys.exit(1)

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
                            "image_url": {
                                "url": f"data:image/png;base64,{screenshot_b64}",
                            },
                        },
                        {
                            "type": "text",
                            "text": prompt,
                        },
                    ],
                }
            ],
            "max_tokens": 4096,
        },
        timeout=60,
    )

    if resp.status_code != 200:
        print(f"API error {resp.status_code}: {resp.text[:500]}")
        return None

    data = resp.json()
    return data["choices"][0]["message"]["content"]


def parse_activities(claude_response):
    """Parse Claude's response into a list of activities."""
    activities = []
    if not claude_response:
        return activities

    json_match = re.search(r'\[[\s\S]*\]', claude_response)
    if json_match:
        try:
            parsed = json.loads(json_match.group())
            if isinstance(parsed, list):
                for item in parsed:
                    if isinstance(item, dict):
                        activities.append(item)
                    elif isinstance(item, str):
                        activities.append({"name": item, "category": "Unknown"})
                return activities
        except json.JSONDecodeError:
            pass

    for line in claude_response.split("\n"):
        line = line.strip()
        if not line or line.startswith("#") or line.startswith("```"):
            continue
        line = re.sub(r'^[\-\*\d\.]+\s*', '', line).strip()
        if line:
            activities.append({"name": line, "category": "Menu"})

    return activities


def post_activities(env, activities):
    """Send discovered activities to OrgCloud API."""
    url = f"{ORGCLOUD_URL}/api/epic/activities"
    resp = requests.post(
        url,
        headers={
            "Authorization": f"Bearer {BRIDGE_TOKEN}",
            "Content-Type": "application/json",
        },
        json={
            "environment": env.upper(),
            "activities": activities,
        },
        timeout=30,
    )
    if resp.status_code == 200:
        data = resp.json()
        print(f"Posted {data.get('count', len(activities))} activities to OrgCloud")
    else:
        print(f"Failed to post activities: {resp.status_code} {resp.text[:200]}")


MENU_PROMPT = """You are looking at an Epic Hyperspace/Hyperdrive application window.
I need you to identify ALL visible menu items, buttons, tabs, navigation elements, and activity options on this screen.

For each item you can see, provide:
- name: the text label
- category: what section/menu/toolbar it belongs to
- type: "menu", "button", "tab", "activity", "link", or "toolbar"

Return a JSON array of objects. Example:
[
  {"name": "Patient Lookup", "category": "Main Menu", "type": "menu"},
  {"name": "Schedule", "category": "Navigation", "type": "tab"},
  {"name": "Orders", "category": "Toolbar", "type": "button"}
]

List EVERY visible clickable element. Be thorough. Return ONLY the JSON array, no other text."""

EXPLORE_PROMPT = """You are looking at an Epic Hyperspace/Hyperdrive application window.
I just clicked on a menu or button and this is what appeared.

Identify ALL visible items in any dropdown menu, submenu, dialog, panel, or list that appeared.
For each item provide:
- name: the text label
- category: the parent menu or section name
- type: "menu-item", "submenu", "activity", "option", or "link"
- has_submenu: true if this item has an arrow or indicator showing it has a submenu

Return a JSON array. Be thorough - list every single visible item.
Return ONLY the JSON array, no other text."""


def scan_main_screen(window, env):
    """Take initial screenshot and identify all visible elements."""
    print(f"\n[1/3] Scanning main screen for {env}...")
    img = screenshot_window(window)
    b64 = img_to_base64(img)
    response = ask_claude(b64, MENU_PROMPT)
    activities = parse_activities(response)
    print(f"  Found {len(activities)} items on main screen")
    return activities


def explore_menus(window, env, main_items):
    """Click into menu items and explore submenus."""
    all_activities = list(main_items)
    menu_items = [a for a in main_items if a.get("type") in ("menu", "tab", "toolbar", "button")]

    print(f"\n[2/3] Exploring {len(menu_items)} clickable items...")

    for i, item in enumerate(menu_items[:15]):
        name = item.get("name", "")
        print(f"  [{i+1}/{min(len(menu_items), 15)}] Clicking: {name}")

        try:
            window.activate()
            time.sleep(0.3)

            img = screenshot_window(window)
            b64 = img_to_base64(img)
            find_prompt = f'Find the exact pixel coordinates of the UI element labeled "{name}" in this screenshot. Return ONLY a JSON object: {{"x": <number>, "y": <number>}}. The coordinates should be relative to the image.'

            coord_response = ask_claude(b64, find_prompt)
            if not coord_response:
                continue

            coord_match = re.search(r'\{\s*"x"\s*:\s*(\d+)\s*,\s*"y"\s*:\s*(\d+)\s*\}', coord_response)
            if not coord_match:
                print(f"    Could not find coordinates for {name}")
                continue

            rel_x = int(coord_match.group(1))
            rel_y = int(coord_match.group(2))
            abs_x = window.left + rel_x
            abs_y = window.top + rel_y

            pyautogui.click(abs_x, abs_y)
            time.sleep(1.0)

            img2 = screenshot_window(window)
            b64_2 = img_to_base64(img2)
            response = ask_claude(b64_2, EXPLORE_PROMPT)
            sub_items = parse_activities(response)

            for si in sub_items:
                si["parent"] = name
            all_activities.extend(sub_items)
            print(f"    Found {len(sub_items)} sub-items")

            pyautogui.press("escape")
            time.sleep(0.5)

        except Exception as e:
            print(f"    Error exploring {name}: {e}")
            pyautogui.press("escape")
            time.sleep(0.3)

    return all_activities


def main():
    if len(sys.argv) < 2:
        print("Usage: python epic_scan.py <ENV>")
        print("  ENV: SUP, POC, or TST")
        sys.exit(1)

    env = sys.argv[1].upper()
    if env not in ("SUP", "POC", "TST", "PRD"):
        print(f"Unknown environment: {env}")
        print("Use: SUP, POC, or TST")
        sys.exit(1)

    print(f"Epic Hyperspace Scanner - {env}")
    print("=" * 40)

    if not OPENROUTER_API_KEY:
        print("ERROR: Set OPENROUTER_API_KEY environment variable")
        print("  set OPENROUTER_API_KEY=your-key-here")
        sys.exit(1)

    print(f"\nLooking for {env} Hyperspace window...")
    window = find_hyperspace_window(env)
    if not window:
        print(f"Could not find a window matching '{env}'")
        print("Available windows:")
        for w in gw.getAllWindows():
            if w.title:
                print(f"  - {w.title}")
        sys.exit(1)

    print(f"Found: {window.title}")

    main_items = scan_main_screen(window, env)

    all_activities = explore_menus(window, env, main_items)

    seen = set()
    unique = []
    for a in all_activities:
        key = (a.get("name", ""), a.get("category", ""), a.get("parent", ""))
        if key not in seen:
            seen.add(key)
            unique.append(a)

    print(f"\n[3/3] Posting {len(unique)} unique activities to OrgCloud...")
    post_activities(env, unique)

    out_file = f"epic_{env.lower()}_activities.json"
    with open(out_file, "w") as f:
        json.dump(unique, f, indent=2)
    print(f"Also saved to {out_file}")

    print(f"\nDone! {len(unique)} activities cataloged for {env}")


if __name__ == "__main__":
    main()
