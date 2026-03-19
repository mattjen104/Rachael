"""
Epic Deep Navigation Tree Scanner
==================================
Runs on your Windows desktop. Uses pywinauto UI Automation for Hyperspace
and terminal buffer reading for Epic Text to build a complete, deterministic
navigation tree of every menu, submenu, and activity.

Requirements:
    pip install pywinauto requests

Usage:
    python epic_tree.py hyperspace SUP
    python epic_tree.py text SUP

Set these environment variables:
    ORGCLOUD_URL   - Your OrgCloud URL (default: https://i-cloud-sync-manager.replit.app)
    BRIDGE_TOKEN   - Your bridge token for API auth
"""

import sys
import os
import json
import time
import re
import traceback

try:
    import requests
except ImportError:
    print("Missing dependency: pip install requests")
    sys.exit(1)

ORGCLOUD_URL = os.environ.get("ORGCLOUD_URL", "https://i-cloud-sync-manager.replit.app")
BRIDGE_TOKEN = os.environ.get("BRIDGE_TOKEN", "")
if not BRIDGE_TOKEN:
    print("ERROR: BRIDGE_TOKEN environment variable required")
    print("  set BRIDGE_TOKEN=<your-bridge-token>")
    sys.exit(1)

SAFE_CONTROL_TYPES = frozenset([
    "MenuItem", "Menu", "MenuBar",
    "ToolBar", "ToolBarButton",
    "TabItem", "TabControl",
    "TreeItem", "TreeView",
    "Header", "HeaderItem",
    "SplitButton", "Hyperlink",
    "StatusBar",
])

UNSAFE_PATTERNS = frozenset([
    "save", "submit", "ok", "yes", "delete", "remove",
    "sign", "order", "confirm", "apply", "approve",
    "print", "send", "release", "finalize",
])

SAFE_CLOSE_PATTERNS = frozenset([
    "back", "cancel", "close", "return", "exit",
])

MAX_DEPTH = 10
MAX_ITEMS_PER_LEVEL = 200

CONTAINER_TYPES = frozenset([
    "Pane", "Window", "Group", "Custom",
    "Document", "List", "ListView",
])
SCAN_DELAY = 0.3


def is_safe_element(element):
    """Check if an element is safe to interact with (read-only navigation only)."""
    try:
        ctrl_type = element.element_info.control_type or ""
    except Exception:
        ctrl_type = ""

    if ctrl_type not in SAFE_CONTROL_TYPES:
        return False

    try:
        name = (element.element_info.name or "").lower().strip()
    except Exception:
        name = ""

    for pattern in UNSAFE_PATTERNS:
        if pattern in name:
            return False

    return True


def is_close_button(element):
    """Check if element is a safe close/back/cancel button."""
    try:
        name = (element.element_info.name or "").lower().strip()
    except Exception:
        return False
    for pattern in SAFE_CLOSE_PATTERNS:
        if pattern in name:
            return True
    return False


def get_element_info(element):
    """Extract displayable info from a UI element."""
    try:
        info = element.element_info
        return {
            "name": info.name or "",
            "control_type": info.control_type or "",
            "automation_id": getattr(info, "automation_id", "") or "",
            "class_name": getattr(info, "class_name", "") or "",
        }
    except Exception:
        return None


def scan_hyperspace(env):
    """Walk the Hyperspace UI tree using pywinauto UI Automation."""
    try:
        from pywinauto import Desktop
        from pywinauto.application import Application
    except ImportError:
        print("Missing dependency: pip install pywinauto")
        sys.exit(1)

    env_upper = env.upper()
    print(f"[hyperspace] Scanning {env_upper}...")

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
        print(f"[hyperspace] No window found for {env_upper}")
        print("Available windows:")
        for w in desktop.windows():
            try:
                print(f"  - {w.element_info.name}")
            except Exception:
                pass
        return None

    window_title = target_window.element_info.name or "Unknown"
    print(f"[hyperspace] Found: {window_title}")

    tree = {
        "client": "hyperspace",
        "environment": env_upper,
        "windowTitle": window_title,
        "scannedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "children": [],
    }

    try:
        target_window.set_focus()
        time.sleep(0.5)
    except Exception:
        pass

    total_found = [0]

    def walk_element(element, path, depth):
        """Recursively walk UI elements, expanding menus to discover full tree."""
        if depth > MAX_DEPTH:
            return []

        children_nodes = []
        try:
            child_elements = element.children()
        except Exception:
            return []

        count = 0
        for child in child_elements:
            if count >= MAX_ITEMS_PER_LEVEL:
                break

            info = get_element_info(child)
            if not info or not info["name"]:
                walk_deeper = walk_element(child, path, depth + 1)
                children_nodes.extend(walk_deeper)
                continue

            if not is_safe_element(child):
                ctrl_type = ""
                try:
                    ctrl_type = child.element_info.control_type or ""
                except Exception:
                    pass
                if ctrl_type in CONTAINER_TYPES:
                    walk_deeper = walk_element(child, path, depth + 1)
                    children_nodes.extend(walk_deeper)
                continue

            count += 1
            total_found[0] += 1

            child_path = path + [info["name"]]
            node = {
                "name": info["name"],
                "controlType": info["control_type"],
                "automationId": info["automation_id"],
                "path": " > ".join(child_path),
                "depth": depth,
                "replayAction": "click",
                "children": [],
            }

            is_expandable = info["control_type"] in (
                "MenuItem", "Menu", "MenuBar", "TreeItem",
                "TabItem", "ToolBar", "SplitButton",
            )

            if is_expandable and depth < MAX_DEPTH:
                sub = walk_element(child, child_path, depth + 1)

                if info["control_type"] in ("MenuItem", "Menu", "SplitButton") and not sub:
                    try:
                        child.expand()
                        time.sleep(SCAN_DELAY)
                        sub = walk_element(child, child_path, depth + 1)

                        if not sub:
                            try:
                                expanded_children = child.children()
                                for ec in expanded_children:
                                    ec_info = get_element_info(ec)
                                    if ec_info and ec_info["name"] and is_safe_element(ec):
                                        ec_path = child_path + [ec_info["name"]]
                                        ec_node = {
                                            "name": ec_info["name"],
                                            "controlType": ec_info["control_type"],
                                            "automationId": ec_info["automation_id"],
                                            "path": " > ".join(ec_path),
                                            "depth": depth + 1,
                                            "replayAction": "click",
                                            "children": [],
                                        }
                                        total_found[0] += 1
                                        ec_sub = walk_element(ec, ec_path, depth + 2)
                                        ec_node["children"] = ec_sub
                                        sub.append(ec_node)
                            except Exception:
                                pass

                        try:
                            child.collapse()
                            time.sleep(SCAN_DELAY * 0.5)
                        except Exception:
                            try:
                                pyautogui.press("escape")
                                time.sleep(SCAN_DELAY * 0.5)
                            except Exception:
                                pass
                    except Exception:
                        pass

                elif info["control_type"] == "TreeItem" and not sub:
                    try:
                        child.expand()
                        time.sleep(SCAN_DELAY)
                        sub = walk_element(child, child_path, depth + 1)
                        try:
                            child.collapse()
                        except Exception:
                            pass
                    except Exception:
                        pass

                node["children"] = sub

            children_nodes.append(node)

            if total_found[0] % 50 == 0:
                print(f"  [{total_found[0]} items scanned...]")

        return children_nodes

    print("[hyperspace] Walking UI Automation tree...")
    tree["children"] = walk_element(target_window, [], 0)
    print(f"[hyperspace] Scan complete: {total_found[0]} total elements found")

    return tree


def scan_text(env):
    """Walk Epic Text menus using keystroke sequences and terminal buffer reading."""
    try:
        from pywinauto import Desktop
    except ImportError:
        print("Missing dependency: pip install pywinauto")
        sys.exit(1)

    env_upper = env.upper()
    print(f"[text] Scanning Epic Text {env_upper}...")

    desktop = Desktop(backend="uia")
    target_window = None

    for w in desktop.windows():
        try:
            title = w.element_info.name or ""
            t = title.upper()
            if env_upper in t and ("TEXT" in t or "TERMINAL" in t or "SESSION" in t or "CACHE" in t):
                target_window = w
                break
        except Exception:
            continue

    if not target_window:
        for w in desktop.windows():
            try:
                title = w.element_info.name or ""
                t = title.upper()
                if env_upper in t and ("EXCEED" in t or "PUTTY" in t or "TERATERM" in t or "CMD" in t or "POWERSHELL" in t):
                    target_window = w
                    break
            except Exception:
                continue

    if not target_window:
        print(f"[text] No Epic Text terminal found for {env_upper}")
        return None

    window_title = target_window.element_info.name or "Unknown"
    print(f"[text] Found: {window_title}")

    tree = {
        "client": "text",
        "environment": env_upper,
        "windowTitle": window_title,
        "scannedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "children": [],
    }

    try:
        import pyautogui
    except ImportError:
        print("  pip install pyautogui for Text scanning")
        return tree

    try:
        target_window.set_focus()
        time.sleep(0.5)
    except Exception:
        pass

    def read_screen():
        """Read the terminal screen content using clipboard."""
        try:
            pyautogui.hotkey("ctrl", "a")
            time.sleep(0.2)
            pyautogui.hotkey("ctrl", "c")
            time.sleep(0.2)
            import subprocess
            result = subprocess.run(["powershell", "-command", "Get-Clipboard"],
                                    capture_output=True, text=True, timeout=5)
            return result.stdout
        except Exception:
            return ""

    def parse_menu_items(screen_text):
        """Parse numbered menu options from Epic Text screen output."""
        items = []
        for line in screen_text.split("\n"):
            line = line.strip()
            match = re.match(r'^(\d+)\s*[\.\)\-]\s*(.+)', line)
            if match:
                num = match.group(1)
                name = match.group(2).strip()
                if name and len(name) > 1 and not name.startswith("="):
                    items.append({"number": num, "name": name})
        return items

    visited_screens = set()

    def walk_text_menu(path, depth):
        """Walk through Text menus exhaustively by entering each numbered option."""
        if depth > MAX_DEPTH:
            return []

        screen = read_screen()
        screen_sig = screen.strip()[:200]
        if screen_sig in visited_screens:
            return []
        visited_screens.add(screen_sig)

        items = parse_menu_items(screen)
        nodes = []

        for item in items[:MAX_ITEMS_PER_LEVEL]:
            name_lower = item["name"].lower()
            skip = False
            for pattern in UNSAFE_PATTERNS:
                if pattern in name_lower:
                    skip = True
                    break
            if skip:
                continue

            child_path = path + [f"{item['number']} {item['name']}"]
            node = {
                "name": item["name"],
                "controlType": "TextMenuItem",
                "menuNumber": item["number"],
                "keystroke": item["number"],
                "replayAction": "keystroke",
                "path": " > ".join(child_path),
                "depth": depth,
                "children": [],
            }

            try:
                pyautogui.typewrite(item["number"], interval=0.05)
                pyautogui.press("enter")
                time.sleep(1.0)

                new_screen = read_screen()
                new_items = parse_menu_items(new_screen)

                if new_items and new_screen.strip()[:200] != screen_sig:
                    sub_nodes = walk_text_menu(child_path, depth + 1)
                    node["children"] = sub_nodes

                pyautogui.typewrite("0", interval=0.05)
                pyautogui.press("enter")
                time.sleep(0.8)
            except Exception:
                try:
                    pyautogui.typewrite("0", interval=0.05)
                    pyautogui.press("enter")
                    time.sleep(0.5)
                except Exception:
                    pass

            nodes.append(node)

        return nodes

    print("[text] Reading main menu and walking all branches...")
    tree["children"] = walk_text_menu([], 0)
    print(f"[text] Scan complete: {count_nodes(tree)} items found")

    return tree


def count_nodes(tree):
    """Count total nodes in tree."""
    count = 0
    for child in tree.get("children", []):
        count += 1
        count += count_nodes(child)
    return count


def flatten_tree(tree, prefix=""):
    """Flatten a tree into a list of activities with paths."""
    activities = []
    for child in tree.get("children", []):
        path = f"{prefix} > {child['name']}" if prefix else child["name"]
        activities.append({
            "name": child["name"],
            "path": child.get("path", path),
            "controlType": child.get("controlType", ""),
            "depth": child.get("depth", 0),
            "hasChildren": len(child.get("children", [])) > 0,
        })
        activities.extend(flatten_tree(child, path))
    return activities


def upload_tree(tree):
    """Upload the navigation tree to OrgCloud."""
    url = f"{ORGCLOUD_URL}/api/epic/tree"
    try:
        resp = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {BRIDGE_TOKEN}",
                "Content-Type": "application/json",
            },
            json=tree,
            timeout=30,
        )
        if resp.status_code == 200:
            data = resp.json()
            print(f"[upload] Tree uploaded: {data.get('nodeCount', '?')} nodes stored")
        else:
            print(f"[upload] Failed: {resp.status_code} {resp.text[:200]}")
    except Exception as e:
        print(f"[upload] Error: {e}")


def main():
    if len(sys.argv) < 3:
        print("Epic Deep Navigation Tree Scanner")
        print("==================================")
        print()
        print("Usage:")
        print("  python epic_tree.py hyperspace <ENV>")
        print("  python epic_tree.py text <ENV>")
        print()
        print("  ENV: SUP, POC, or TST")
        print()
        print("Environment variables:")
        print("  BRIDGE_TOKEN   - Required")
        print("  ORGCLOUD_URL   - Default: https://i-cloud-sync-manager.replit.app")
        sys.exit(1)

    client = sys.argv[1].lower()
    env = sys.argv[2].upper()

    if env not in ("SUP", "POC", "TST", "PRD"):
        print(f"Unknown environment: {env}")
        sys.exit(1)

    if client not in ("hyperspace", "text"):
        print(f"Unknown client: {client}")
        print("Use: hyperspace or text")
        sys.exit(1)

    print(f"Epic Tree Scanner - {client.upper()} / {env}")
    print("=" * 40)

    tree = None
    if client == "hyperspace":
        tree = scan_hyperspace(env)
    elif client == "text":
        tree = scan_text(env)

    if not tree:
        print("Scan failed or no window found.")
        sys.exit(1)

    total = count_nodes(tree)
    print(f"\nTotal nodes: {total}")

    out_file = f"epic_tree_{client}_{env.lower()}.json"
    with open(out_file, "w") as f:
        json.dump(tree, f, indent=2)
    print(f"Saved to {out_file}")

    print("\nUploading to OrgCloud...")
    upload_tree(tree)

    print(f"\nDone! {total} navigation items cataloged for {client} {env}")


if __name__ == "__main__":
    main()
