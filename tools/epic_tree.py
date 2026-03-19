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
    "save", "submit", "yes", "delete", "remove",
    "sign", "confirm", "apply", "approve",
    "print", "send", "release", "finalize",
])

UNSAFE_EXACT = frozenset([
    "ok", "okay", "order",
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

    words = set(re.split(r'[\s\-_/]+', name))
    for exact in UNSAFE_EXACT:
        if exact in words:
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


TEXT_MENU_PATTERNS = [
    re.compile(r'^(\d+)\s*[\.\)\-:]\s*(.+)'),
    re.compile(r'^(\d+)\s{2,}(.+)'),
    re.compile(r'^\s*(\d+)\s+([A-Z][A-Za-z].{2,})'),
]

TEXT_PROMPT_PATTERNS = [
    re.compile(r'(?:choice|select|option|enter)\s*[:>]\s*$', re.IGNORECASE),
    re.compile(r'(?:menu|command)\s*[:>]\s*$', re.IGNORECASE),
    re.compile(r'[:>]\s*$'),
]

TEXT_SCREEN_TITLE_PATTERN = re.compile(
    r'^[=\-\*]{3,}.*[=\-\*]{3,}$|^[A-Z][A-Z\s\-/]{5,}$'
)

TEXT_NOT_MENU_INDICATORS = frozenset([
    "item number", "record #", "enter value", "press enter",
    "login", "password", "username", "user id",
])


def scan_text(env):
    """Walk Epic Text (Chronicles) menus using keystroke sequences and screen reading.

    Epic Text navigation conventions (VT220 terminal):
    - Numbered menu options: type the number + Enter to navigate
    - 0 or blank Enter: go back one level
    - Semicolon chaining: 1;3;5 navigates 3 levels deep in one command
    - HOME + F8: display masterfile INI and item number at current position
    - HOME + F9: fast-forward search to a text string
    - F1: help (or delete in edit mode - we never enter edit mode)
    - Shift+F: exit record from any screen
    """
    try:
        from pywinauto import Desktop
    except ImportError:
        print("Missing dependency: pip install pywinauto")
        sys.exit(1)

    env_upper = env.upper()
    print(f"[text] Scanning Epic Text {env_upper}...")

    desktop = Desktop(backend="uia")
    target_window = None

    terminal_keywords_primary = ("TEXT", "TERMINAL", "SESSION", "CACHE", "CHRONICLES")
    terminal_keywords_fallback = ("EXCEED", "PUTTY", "TERATERM", "XTERM", "CMD", "POWERSHELL", "SSH")

    for w in desktop.windows():
        try:
            title = w.element_info.name or ""
            t = title.upper()
            if env_upper in t and any(kw in t for kw in terminal_keywords_primary):
                target_window = w
                break
        except Exception:
            continue

    if not target_window:
        for w in desktop.windows():
            try:
                title = w.element_info.name or ""
                t = title.upper()
                if env_upper in t and any(kw in t for kw in terminal_keywords_fallback):
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

    import subprocess

    try:
        target_window.set_focus()
        time.sleep(0.5)
    except Exception:
        pass

    stats = {"screens_read": 0, "items_found": 0, "errors": 0, "back_failures": 0}

    def read_clipboard():
        """Read Windows clipboard content via PowerShell."""
        try:
            result = subprocess.run(
                ["powershell", "-command", "Get-Clipboard"],
                capture_output=True, text=True, timeout=5,
            )
            return result.stdout
        except Exception:
            return ""

    def read_screen(retries=2):
        """Read terminal screen via select-all + copy with stability check.

        Reads twice with a short delay to ensure the screen has stabilized
        (terminal emulators can be slow to render after navigation).
        """
        for attempt in range(retries):
            try:
                pyautogui.hotkey("ctrl", "a")
                time.sleep(0.15)
                pyautogui.hotkey("ctrl", "c")
                time.sleep(0.15)
                first = read_clipboard()

                if attempt == 0 and retries > 1:
                    time.sleep(0.3)
                    pyautogui.hotkey("ctrl", "a")
                    time.sleep(0.15)
                    pyautogui.hotkey("ctrl", "c")
                    time.sleep(0.15)
                    second = read_clipboard()
                    if second and second.strip() == first.strip():
                        stats["screens_read"] += 1
                        return first
                    if second:
                        stats["screens_read"] += 1
                        return second

                if first:
                    stats["screens_read"] += 1
                    return first
            except Exception:
                time.sleep(0.3)
        return ""

    def wait_for_screen_change(old_sig, timeout=3.0):
        """Wait until the screen content changes from old_sig, up to timeout seconds."""
        start = time.time()
        while time.time() - start < timeout:
            screen = read_screen(retries=1)
            new_sig = screen_signature(screen)
            if new_sig != old_sig and new_sig:
                return screen
            time.sleep(0.3)
        return read_screen(retries=1)

    def screen_signature(screen_text):
        """Generate a signature for screen comparison.
        Uses all non-blank lines joined together for reliable dedup."""
        if not screen_text:
            return ""
        lines = [l.strip() for l in screen_text.strip().split("\n") if l.strip()]
        return "\n".join(lines)

    def parse_menu_items(screen_text):
        """Parse numbered menu options from Epic Text screen output.

        Handles multiple formats:
        - '1. Menu Item' / '1) Menu Item' / '1- Menu Item' / '1: Menu Item'
        - '1  Menu Item' (space-separated, common in Chronicles)
        - ' 1  Patient Records' (indented)
        Deduplicates by number and filters noise.
        """
        items = []
        seen_numbers = set()
        for line in screen_text.split("\n"):
            stripped = line.strip()
            if not stripped:
                continue
            for pattern in TEXT_MENU_PATTERNS:
                match = pattern.match(stripped)
                if match:
                    num = match.group(1)
                    name = match.group(2).strip()
                    name = re.sub(r'\s{2,}.*$', '', name).strip()
                    if (
                        name
                        and len(name) > 1
                        and num not in seen_numbers
                        and not name.startswith("=")
                        and not name.startswith("-")
                        and not re.match(r'^[\-=_\*]{3,}$', name)
                    ):
                        seen_numbers.add(num)
                        items.append({"number": num, "name": name})
                    break
        return items

    def classify_screen(screen_text):
        """Classify what kind of screen we're looking at.

        Returns one of:
        - 'menu': has numbered menu items
        - 'prompt': asking for input (record ID, value, etc.)
        - 'record': displaying a record/data (no menu items)
        - 'empty': blank or unreadable
        """
        if not screen_text or not screen_text.strip():
            return "empty"

        lower = screen_text.lower()
        for indicator in TEXT_NOT_MENU_INDICATORS:
            if indicator in lower:
                return "prompt"

        items = parse_menu_items(screen_text)
        if len(items) >= 2:
            return "menu"

        for pattern in TEXT_PROMPT_PATTERNS:
            if pattern.search(screen_text):
                return "prompt"

        if len(items) == 1:
            return "menu"

        return "record"

    def extract_screen_title(screen_text):
        """Try to extract a title/header from the screen."""
        for line in screen_text.split("\n")[:5]:
            stripped = line.strip()
            if stripped and TEXT_SCREEN_TITLE_PATTERN.match(stripped):
                return stripped.strip("=-* ")
        for line in screen_text.split("\n")[:3]:
            stripped = line.strip()
            if stripped and len(stripped) > 3 and not re.match(r'^\d', stripped):
                return stripped[:60]
        return ""

    def get_item_info():
        """Press HOME + F8 to get masterfile INI and item number info.

        This is a read-only operation in Chronicles that displays metadata
        about the current position without changing state.
        Returns the info string or empty string.
        """
        try:
            pyautogui.press("home")
            time.sleep(0.1)
            pyautogui.press("f8")
            time.sleep(0.5)
            info = read_screen(retries=1)
            pyautogui.press("enter")
            time.sleep(0.3)
            ini_match = re.search(r'(?:INI|Master\s*[Ff]ile)\s*[=:]\s*(\w+)', info)
            item_match = re.search(r'(?:Item|#)\s*[=:]\s*(\d+)', info)
            if ini_match or item_match:
                return {
                    "ini": ini_match.group(1) if ini_match else "",
                    "itemNumber": item_match.group(1) if item_match else "",
                    "raw": info.strip()[:200],
                }
        except Exception:
            pass
        return None

    def go_back(current_sig):
        """Navigate back one level by typing 0 + Enter.

        Verifies the screen actually changed. If it didn't, tries
        pressing Enter alone (some prompts just need Enter to dismiss).
        Returns (success, new_screen_text).
        """
        pyautogui.typewrite("0", interval=0.05)
        pyautogui.press("enter")
        new_screen = wait_for_screen_change(current_sig, timeout=2.0)
        new_sig = screen_signature(new_screen)
        if new_sig != current_sig:
            return True, new_screen

        pyautogui.press("enter")
        time.sleep(0.5)
        new_screen = read_screen(retries=1)
        new_sig = screen_signature(new_screen)
        if new_sig != current_sig:
            return True, new_screen

        stats["back_failures"] += 1
        return False, new_screen

    def is_safe_text_item(name):
        """Check if a menu item name is safe to navigate into."""
        name_lower = name.lower().strip()
        for pattern in UNSAFE_PATTERNS:
            if pattern in name_lower:
                return False
        words = set(re.split(r'[\s\-_/]+', name_lower))
        for exact in UNSAFE_EXACT:
            if exact in words:
                return False
        return True

    visited_sigs = set()
    total_crawled = [0]

    def walk_text_menu(path, depth, parent_screen_sig=""):
        """Recursively walk Epic Text menus.

        For each numbered menu item:
        1. Read current screen and parse menu items
        2. Type the item number + Enter
        3. Wait for screen change and verify navigation worked
        4. If new screen is a menu, recurse into it
        5. Navigate back with '0' + Enter and verify return
        """
        if depth > MAX_DEPTH:
            print(f"  {'  ' * depth}[max-depth] Stopping at depth {depth}")
            return []

        screen = read_screen()
        sig = screen_signature(screen)

        if sig in visited_sigs:
            return []
        visited_sigs.add(sig)

        screen_type = classify_screen(screen)
        if screen_type != "menu":
            return []

        items = parse_menu_items(screen)
        title = extract_screen_title(screen)
        indent = "  " * (depth + 1)

        path_str = " > ".join(path) if path else "(root)"
        print(f"  [text]{indent}{path_str}: {len(items)} items ('{title}')")

        nodes = []

        for idx, item in enumerate(items[:MAX_ITEMS_PER_LEVEL]):
            if not is_safe_text_item(item["name"]):
                print(f"  [text]{indent}  SKIP '{item['name']}' (unsafe)")
                continue

            child_path = path + [f"{item['number']} {item['name']}"]
            chain = ";".join(p.split(" ")[0] for p in child_path)

            node = {
                "name": item["name"],
                "controlType": "TextMenuItem",
                "menuNumber": item["number"],
                "keystroke": item["number"],
                "chain": chain,
                "replayAction": "keystroke",
                "path": " > ".join(child_path),
                "depth": depth,
                "children": [],
            }
            total_crawled[0] += 1
            stats["items_found"] += 1

            try:
                before_sig = screen_signature(read_screen(retries=1))

                pyautogui.typewrite(item["number"], interval=0.05)
                pyautogui.press("enter")
                new_screen = wait_for_screen_change(before_sig, timeout=3.0)
                new_sig = screen_signature(new_screen)

                if new_sig == before_sig:
                    print(f"  [text]{indent}  '{item['name']}' ({item['number']}): no screen change (terminal/leaf)")
                    node["controlType"] = "TextActivity"
                    nodes.append(node)
                    continue

                new_type = classify_screen(new_screen)

                if new_type == "menu":
                    new_items = parse_menu_items(new_screen)
                    print(f"  [text]{indent}  -> '{item['name']}' ({item['number']}): submenu with {len(new_items)} items")
                    sub_nodes = walk_text_menu(child_path, depth + 1, before_sig)
                    node["children"] = sub_nodes
                elif new_type == "prompt":
                    print(f"  [text]{indent}  -> '{item['name']}' ({item['number']}): data prompt (leaf)")
                    node["controlType"] = "TextPrompt"
                elif new_type == "record":
                    print(f"  [text]{indent}  -> '{item['name']}' ({item['number']}): record view (leaf)")
                    node["controlType"] = "TextRecord"
                    item_info = get_item_info()
                    if item_info:
                        node["masterfileINI"] = item_info.get("ini", "")
                        node["itemNumber"] = item_info.get("itemNumber", "")
                else:
                    print(f"  [text]{indent}  -> '{item['name']}' ({item['number']}): {new_type}")

                success, _ = go_back(screen_signature(read_screen(retries=1)))
                if not success:
                    print(f"  [text]{indent}  !! Could not go back after '{item['name']}' - trying harder")
                    for recovery in range(3):
                        pyautogui.typewrite("0", interval=0.05)
                        pyautogui.press("enter")
                        time.sleep(0.5)
                    back_screen = read_screen(retries=1)
                    back_type = classify_screen(back_screen)
                    if back_type != "menu":
                        print(f"  [text]{indent}  !! Recovery failed (screen type: {back_type}), aborting this level")
                        stats["errors"] += 1
                        nodes.append(node)
                        break

            except Exception as e:
                print(f"  [text]{indent}  !! Error on '{item['name']}': {e}")
                stats["errors"] += 1
                try:
                    pyautogui.typewrite("0", interval=0.05)
                    pyautogui.press("enter")
                    time.sleep(0.5)
                except Exception:
                    pass

            nodes.append(node)

            if (idx + 1) % 10 == 0:
                print(f"  [text]{indent}  ... progress: {idx + 1}/{len(items)} items at this level, {total_crawled[0]} total")

        return nodes

    print("[text] Reading main menu and walking all branches...")
    print("[text] Navigation: number+Enter to go in, 0+Enter to go back")
    print("[text] Safety: skipping items matching unsafe patterns (save, submit, delete, etc.)")
    print()

    tree["children"] = walk_text_menu([], 0)
    tree["stats"] = stats

    total = count_nodes(tree)
    print()
    print(f"[text] Scan complete: {total} items found")
    print(f"[text] Stats: {stats['screens_read']} screens read, {stats['items_found']} items cataloged, {stats['errors']} errors, {stats['back_failures']} back-nav failures")

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
