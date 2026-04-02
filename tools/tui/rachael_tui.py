#!/usr/bin/env python3
import sys
import os
import time
import threading
import traceback
from collections import deque
from typing import Optional

try:
    from notcurses import Notcurses, NcInput, NcPlane
    HAS_NOTCURSES = True
except ImportError:
    HAS_NOTCURSES = False

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from api_client import RachaelAPI, APIError
from themes import ThemeEngine, THEMES, THEME_NAMES

VERSION = "1.0.0"
VIEWS = ["agenda", "tree", "programs", "results", "reader",
         "cockpit", "snow", "evolution", "transcripts", "voice"]
VIEW_KEYS = {
    "1": "agenda", "2": "tree", "3": "programs", "4": "results",
    "5": "reader", "6": "cockpit", "7": "snow", "8": "evolution",
    "9": "transcripts", "0": "voice",
}
STATUS_CHARS = {
    "running": "\u27F3", "queued": "\u2026", "error": "\u2717",
    "completed": "\u2713", "enabled": "\u25CF", "disabled": "\u25CB",
}
LOGO = [
    " ____            _                _",
    "|  _ \\ __ _  ___| |__   __ _  ___| |",
    "| |_) / _` |/ __| '_ \\ / _` |/ _ \\ |",
    "|  _ < (_| | (__| | | | (_| |  __/ |",
    "|_| \\_\\__,_|\\___|_| |_|\\__,_|\\___|_|",
]


class RachaelTUI:
    def __init__(self, base_url: Optional[str] = None, api_key: Optional[str] = None):
        self.api = RachaelAPI(base_url=base_url, api_key=api_key)
        self.theme = ThemeEngine()
        self.nc: Optional[Notcurses] = None
        self.stdp = None
        self.running = False
        self.view = "agenda"
        self.prev_view = "agenda"
        self.selected_idx = 0
        self.scroll_offset = 0
        self.expanded_id: Optional[int] = None
        self.minibuffer_active = False
        self.minibuffer_text = ""
        self.minibuffer_prompt = ""
        self.minibuffer_callback = None
        self.command_palette_active = False
        self.message = ""
        self.message_time = 0
        self.cockpit_events: deque = deque(maxlen=500)
        self.cockpit_connected = False
        self.data_cache: dict = {}
        self.data_lock = threading.Lock()
        self.last_refresh = 0
        self.refresh_interval = 5
        self.sidebar_width = 22
        self.sidebar_visible = True
        self.dims = (24, 80)

    def run(self):
        if not HAS_NOTCURSES:
            self._run_fallback()
            return
        try:
            self.nc = Notcurses()
            self.stdp = self.nc.stdplane()
            self.running = True
            self.dims = self.stdp.dim_yx()
            self._start_background()
            self._splash()
            self._main_loop()
        except Exception as e:
            self.running = False
            if self.nc:
                try:
                    self.nc.stop()
                except Exception:
                    pass
                self.nc = None
            sys.stderr.write("notcurses failed, falling back to curses: " + str(e) + "\n")
            self._run_fallback()
        finally:
            self.running = False
            self.api.stop_sse()
            if self.nc:
                try:
                    self.nc.stop()
                except Exception:
                    pass

    def _run_fallback(self):
        import curses
        curses.wrapper(self._curses_main)

    def _curses_main(self, stdscr):
        import curses
        curses.curs_set(0)
        curses.start_color()
        curses.use_default_colors()
        self._init_curses_colors(curses)
        self.stdscr = stdscr
        self.running = True
        self._start_background()
        stdscr.timeout(100)
        self._splash_curses(stdscr, curses)
        while self.running:
            self.dims = stdscr.getmaxyx()
            self._render_curses(stdscr, curses)
            try:
                ch = stdscr.get_wch()
            except curses.error:
                continue
            except KeyboardInterrupt:
                break
            self._handle_input_curses(ch, curses)
        self.api.stop_sse()

    def _init_curses_colors(self, curses):
        t = self.theme.current
        pairs = [
            (1, t["fg"], t["bg"]),
            (2, t["dim"], t["bg"]),
            (3, t["accent"], t["bg"]),
            (4, t["error"], t["bg"]),
            (5, t["warn"], t["bg"]),
            (6, t["success"], t["bg"]),
            (7, t["header_fg"], t["header_bg"]),
            (8, t["sel_fg"], t["sel_bg"]),
            (9, t["mode_line_fg"], t["mode_line_bg"]),
            (10, t["mini_fg"], t["mini_bg"]),
            (11, t["info"], t["bg"]),
            (12, t["border"], t["bg"]),
        ]
        for idx, fg_hex, bg_hex in pairs:
            try:
                fg_id = 16 + idx * 2
                bg_id = 17 + idx * 2
                curses.init_color(fg_id,
                                  ((fg_hex >> 16) & 0xFF) * 1000 // 255,
                                  ((fg_hex >> 8) & 0xFF) * 1000 // 255,
                                  (fg_hex & 0xFF) * 1000 // 255)
                curses.init_color(bg_id,
                                  ((bg_hex >> 16) & 0xFF) * 1000 // 255,
                                  ((bg_hex >> 8) & 0xFF) * 1000 // 255,
                                  (bg_hex & 0xFF) * 1000 // 255)
                curses.init_pair(idx, fg_id, bg_id)
            except curses.error:
                curses.init_pair(idx, curses.COLOR_GREEN, curses.COLOR_BLACK)

    def _start_background(self):
        t = threading.Thread(target=self._refresh_loop, daemon=True)
        t.start()
        self.api.start_sse(self._on_cockpit_event)

    def _on_cockpit_event(self, event):
        self.cockpit_connected = True
        self.cockpit_events.append(event)

    def _refresh_loop(self):
        while self.running:
            try:
                self._refresh_data()
            except Exception:
                pass
            time.sleep(self.refresh_interval)

    def _refresh_data(self):
        fetches = {
            "programs": lambda: self.api.programs(),
            "runtime": lambda: self.api.runtime(),
            "agenda": lambda: self.api.agenda(),
            "results": lambda: self.api.results(limit=50),
            "reader": lambda: self.api.reader_pages(),
            "budget": lambda: self.api.budget(),
            "control": lambda: self.api.control_state(),
            "proposals": lambda: self.api.proposals(),
            "transcripts": lambda: self.api.transcripts(),
        }
        for key, fn in fetches.items():
            try:
                value = fn()
                with self.data_lock:
                    self.data_cache[key] = value
            except Exception:
                pass
        with self.data_lock:
            self.last_refresh = time.time()

    def _msg(self, text: str):
        self.message = text
        self.message_time = time.time()

    def _splash(self):
        t = self.theme.current
        rows, cols = self.dims
        self.stdp.erase()
        r, g, b = self.theme.rgb("accent")
        self.stdp.set_fg_rgb8(r, g, b)
        for i, line in enumerate(LOGO):
            y = rows // 2 - len(LOGO) // 2 + i - 2
            x = max(0, (cols - len(line)) // 2)
            if 0 <= y < rows:
                self.stdp.putstr_yx(y, x, line)
        r, g, b = self.theme.rgb("dim")
        self.stdp.set_fg_rgb8(r, g, b)
        tag = "v" + VERSION + " | " + self.theme.current["name"]
        self.stdp.putstr_yx(rows // 2 + 3, max(0, (cols - len(tag)) // 2), tag)
        sub = "Press any key to continue..."
        self.stdp.putstr_yx(rows // 2 + 5, max(0, (cols - len(sub)) // 2), sub)
        self.nc.render()
        ni = NcInput()
        self.nc.get(ni)

    def _splash_curses(self, stdscr, curses):
        rows, cols = stdscr.getmaxyx()
        stdscr.clear()
        for i, line in enumerate(LOGO):
            y = rows // 2 - len(LOGO) // 2 + i - 2
            x = max(0, (cols - len(line)) // 2)
            if 0 <= y < rows - 1:
                try:
                    stdscr.addnstr(y, x, line, cols - x, curses.color_pair(3))
                except curses.error:
                    pass
        tag = "v" + VERSION + " | " + self.theme.current["name"]
        ty = rows // 2 + 3
        if 0 <= ty < rows - 1:
            try:
                stdscr.addnstr(ty, max(0, (cols - len(tag)) // 2), tag, cols, curses.color_pair(2))
            except curses.error:
                pass
        sub = "Press any key to continue..."
        sy = rows // 2 + 5
        if 0 <= sy < rows - 1:
            try:
                stdscr.addnstr(sy, max(0, (cols - len(sub)) // 2), sub, cols, curses.color_pair(2))
            except curses.error:
                pass
        stdscr.refresh()
        stdscr.timeout(-1)
        stdscr.getch()
        stdscr.timeout(100)

    def _main_loop(self):
        ni = NcInput()
        while self.running:
            self.dims = self.stdp.dim_yx()
            self._render_nc()
            self.nc.render()
            key = self.nc.get_nblock(ni)
            if key is None or key == 0:
                time.sleep(0.016)
                continue
            self._handle_input_nc(key, ni)

    def _handle_input_nc(self, key, ni):
        if self.minibuffer_active:
            self._handle_minibuffer_nc(key, ni)
            return
        if self.command_palette_active:
            self._handle_palette_nc(key, ni)
            return
        char = chr(key) if 0 < key < 0x110000 else ""
        if ni.alt and char == "x":
            self._open_command_palette()
            return
        if char == "q":
            self.running = False
            return
        if char in VIEW_KEYS:
            self.prev_view = self.view
            self.view = VIEW_KEYS[char]
            self.selected_idx = 0
            self.scroll_offset = 0
            self.expanded_id = None
            return
        if char == "T":
            self.theme.next_theme()
            self._msg("Theme: " + self.theme.current["name"])
            return
        if char == "b":
            self.sidebar_visible = not self.sidebar_visible
            return
        if char == "/":
            self._open_minibuffer("Search: ", self._do_search)
            return
        if char == ":":
            self._open_minibuffer("M-x ", self._do_command)
            return
        self._handle_view_keys(char)

    def _handle_input_curses(self, ch, curses):
        if isinstance(ch, int):
            if ch == 27:
                self.stdscr.timeout(50)
                try:
                    ch2 = self.stdscr.get_wch()
                except curses.error:
                    ch2 = None
                self.stdscr.timeout(100)
                if ch2 == "x" or ch2 == ord("x"):
                    self._open_command_palette()
                    return
                if ch2 is None:
                    if self.minibuffer_active:
                        self.minibuffer_active = False
                        return
                    if self.command_palette_active:
                        self.command_palette_active = False
                        return
                return
            char = chr(ch) if 0 < ch < 128 else ""
        else:
            char = str(ch)

        if self.minibuffer_active:
            self._handle_minibuffer_curses(ch, char)
            return
        if self.command_palette_active:
            self._handle_palette_curses(ch, char, curses)
            return
        if char == "q":
            self.running = False
            return
        if char in VIEW_KEYS:
            self.prev_view = self.view
            self.view = VIEW_KEYS[char]
            self.selected_idx = 0
            self.scroll_offset = 0
            self.expanded_id = None
            return
        if char == "T":
            self.theme.next_theme()
            self._init_curses_colors(curses)
            self._msg("Theme: " + self.theme.current["name"])
            return
        if char == "b":
            self.sidebar_visible = not self.sidebar_visible
            return
        if char == "/":
            self._open_minibuffer("Search: ", self._do_search)
            return
        if char == ":":
            self._open_minibuffer("M-x ", self._do_command)
            return
        self._handle_view_keys(char)

    def _handle_view_keys(self, char: str):
        with self.data_lock:
            items = self._current_items()
        count = len(items) if items else 0
        if char == "j" or char == "\x0e":
            self.selected_idx = min(self.selected_idx + 1, max(0, count - 1))
        elif char == "k" or char == "\x10":
            self.selected_idx = max(self.selected_idx - 1, 0)
        elif char == "g":
            self.selected_idx = 0
            self.scroll_offset = 0
        elif char == "G":
            self.selected_idx = max(0, count - 1)
        elif char == "\t":
            if items and 0 <= self.selected_idx < len(items):
                item = items[self.selected_idx]
                item_id = item.get("id") if isinstance(item, dict) else None
                if item_id is not None:
                    self.expanded_id = None if self.expanded_id == item_id else item_id
        elif char == "\n" or char == "\r":
            self._action_enter(items)
        elif char == "r" and self.view == "programs":
            self._action_trigger(items)
        elif char == "R" and self.view == "programs":
            self._action_toggle_runtime()
        elif char == "c":
            self._open_minibuffer("Capture: ", self._do_capture)
        elif char == "X":
            self._open_minibuffer("CLI> ", self._do_cli)
        elif char == "?":
            self._msg("Views:1-0 | j/k:nav | Tab:expand | Enter:act | /:search | M-x:cmd | T:theme | q:quit")

    def _current_items(self) -> list:
        if self.view == "programs":
            return self.data_cache.get("programs", [])
        elif self.view == "results":
            return self.data_cache.get("results", [])
        elif self.view == "reader":
            return self.data_cache.get("reader", [])
        elif self.view == "agenda":
            return self._build_agenda_items()
        elif self.view == "cockpit":
            return list(self.cockpit_events)
        elif self.view == "tree":
            return self._build_tree_items()
        elif self.view == "evolution":
            return self._build_evolution_items()
        elif self.view == "snow":
            return self.data_cache.get("proposals", [])
        elif self.view == "transcripts":
            return self.data_cache.get("transcripts", [])
        elif self.view == "voice":
            return []
        return []

    def _build_agenda_items(self) -> list:
        agenda = self.data_cache.get("agenda", {})
        items = []
        overdue = agenda.get("overdue", [])
        today = agenda.get("today", [])
        upcoming = agenda.get("upcoming", [])
        briefings = agenda.get("briefings", [])
        if overdue:
            items.append({"_section": "OVERDUE (" + str(len(overdue)) + ")", "_key": "overdue"})
            items.extend(overdue)
        items.append({"_section": "TODAY (" + str(len(today)) + ")", "_key": "today"})
        items.extend(today)
        if upcoming:
            items.append({"_section": "UPCOMING (" + str(len(upcoming)) + ")", "_key": "upcoming"})
            items.extend(upcoming)
        if briefings:
            items.append({"_section": "BRIEFINGS (" + str(len(briefings)) + ")", "_key": "briefings"})
            items.extend(briefings)
        return items

    def _build_tree_items(self) -> list:
        items = []
        programs = self.data_cache.get("programs", [])
        runtime = self.data_cache.get("runtime", {})
        budget = self.data_cache.get("budget", {})
        items.append({"_section": "RUNTIME", "_key": "runtime"})
        items.append({"_tree": "status", "_label": "Active: " + str(runtime.get("active", False))})
        rp = runtime.get("programs", [])
        running_count = sum(1 for p in rp if p.get("status") == "running")
        items.append({"_tree": "status", "_label": "Running: " + str(running_count) + "/" + str(len(rp))})
        items.append({"_section": "BUDGET", "_key": "budget"})
        items.append({"_tree": "budget", "_label": "Spent: $" + str(budget.get("spent", 0))})
        items.append({"_tree": "budget", "_label": "Cap: $" + str(budget.get("dailyCap", 0))})
        items.append({"_section": "PROGRAMS (" + str(len(programs)) + ")", "_key": "programs"})
        for p in programs:
            items.append(p)
        return items

    def _build_evolution_items(self) -> list:
        items = []
        try:
            state = self.api.evolution_state()
            items.append({"_section": "EVOLUTION v" + str(state.get("currentVersion", 0)), "_key": "evo"})
            m = state.get("metrics", {})
            sr = m.get("successRate", 0)
            items.append({"_tree": "metric", "_label": "Success Rate: " + str(round(sr * 100, 1)) + "%"})
            items.append({"_tree": "metric", "_label": "Total Runs: " + str(m.get("totalRuns", 0))})
            items.append({"_tree": "metric", "_label": "Corrections: " + str(m.get("corrections", 0))})
            items.append({"_tree": "metric", "_label": "Golden Suite: " + str(state.get("goldenSuiteSize", 0))})
            items.append({"_tree": "metric", "_label": "Pending Obs: " + str(state.get("unconsolidatedObservations", 0))})
            versions = state.get("recentVersions", [])
            if versions:
                items.append({"_section": "VERSIONS", "_key": "versions"})
                for v in versions:
                    items.append(v)
        except Exception:
            items.append({"_tree": "error", "_label": "Failed to load evolution state"})
        return items

    def _action_enter(self, items):
        if not items or self.selected_idx >= len(items):
            return
        item = items[self.selected_idx]
        if isinstance(item, dict):
            if "_section" in item:
                return
            if self.view == "programs":
                pid = item.get("id")
                if pid:
                    try:
                        self.api.toggle_program(pid)
                        self._msg("Toggled program: " + item.get("name", ""))
                    except Exception as e:
                        self._msg("Error: " + str(e))
            elif self.view == "agenda":
                tid = item.get("id")
                if tid and item.get("status"):
                    try:
                        self.api.toggle_task(tid)
                        self._msg("Toggled task: " + item.get("title", ""))
                    except Exception as e:
                        self._msg("Error: " + str(e))
                elif tid and item.get("summary"):
                    self.expanded_id = None if self.expanded_id == tid else tid

    def _action_trigger(self, items):
        if not items or self.selected_idx >= len(items):
            return
        item = items[self.selected_idx]
        pid = item.get("id") if isinstance(item, dict) else None
        if pid:
            try:
                self.api.trigger_program(pid)
                self._msg("Triggered: " + item.get("name", ""))
            except Exception as e:
                self._msg("Error: " + str(e))

    def _action_toggle_runtime(self):
        try:
            result = self.api.toggle_runtime()
            self._msg("Runtime: " + ("ON" if result.get("active") else "OFF"))
        except Exception as e:
            self._msg("Error: " + str(e))

    def _open_minibuffer(self, prompt: str, callback):
        self.minibuffer_active = True
        self.minibuffer_text = ""
        self.minibuffer_prompt = prompt
        self.minibuffer_callback = callback

    def _close_minibuffer(self):
        self.minibuffer_active = False
        self.minibuffer_text = ""
        self.minibuffer_prompt = ""
        self.minibuffer_callback = None

    def _handle_minibuffer_nc(self, key, ni):
        char = chr(key) if 0 < key < 0x110000 else ""
        if key == 27:
            self._close_minibuffer()
        elif key == 10 or key == 13:
            cb = self.minibuffer_callback
            text = self.minibuffer_text
            self._close_minibuffer()
            if cb:
                cb(text)
        elif key == 127 or key == 263:
            self.minibuffer_text = self.minibuffer_text[:-1]
        elif char and char.isprintable():
            self.minibuffer_text += char

    def _handle_minibuffer_curses(self, ch, char):
        if isinstance(ch, int):
            if ch == 27:
                self._close_minibuffer()
                return
            if ch == 10 or ch == 13:
                cb = self.minibuffer_callback
                text = self.minibuffer_text
                self._close_minibuffer()
                if cb:
                    cb(text)
                return
            if ch == 127 or ch == 263 or ch == 8:
                self.minibuffer_text = self.minibuffer_text[:-1]
                return
            char = chr(ch) if 0 < ch < 128 else ""
        if char and len(char) == 1 and char.isprintable():
            self.minibuffer_text += char

    def _open_command_palette(self):
        self.command_palette_active = True
        self.minibuffer_text = ""
        self._msg("M-x: type command...")

    def _handle_palette_nc(self, key, ni):
        char = chr(key) if 0 < key < 0x110000 else ""
        if key == 27:
            self.command_palette_active = False
        elif key == 10 or key == 13:
            cmd = self.minibuffer_text.strip()
            self.command_palette_active = False
            self.minibuffer_text = ""
            self._do_command(cmd)
        elif key == 127 or key == 263:
            self.minibuffer_text = self.minibuffer_text[:-1]
        elif char and char.isprintable():
            self.minibuffer_text += char

    def _handle_palette_curses(self, ch, char, curses):
        if isinstance(ch, int):
            if ch == 27:
                self.command_palette_active = False
                return
            if ch == 10 or ch == 13:
                cmd = self.minibuffer_text.strip()
                self.command_palette_active = False
                self.minibuffer_text = ""
                self._do_command(cmd)
                return
            if ch == 127 or ch == 263 or ch == 8:
                self.minibuffer_text = self.minibuffer_text[:-1]
                return
            char = chr(ch) if 0 < ch < 128 else ""
        if char and len(char) == 1 and char.isprintable():
            self.minibuffer_text += char

    def _do_search(self, query: str):
        if not query.strip():
            return
        try:
            results = self.api.search(query)
            self._msg("Found " + str(len(results)) + " results for: " + query)
        except Exception as e:
            self._msg("Search error: " + str(e))

    def _do_capture(self, text: str):
        if not text.strip():
            return
        try:
            self.api.smart_capture(text)
            self._msg("Captured: " + text[:40])
        except Exception as e:
            self._msg("Capture error: " + str(e))

    def _do_cli(self, command: str):
        if not command.strip():
            return
        try:
            result = self.api.cli_execute(command)
            output = result.get("output", result.get("result", ""))
            if isinstance(output, str):
                self._msg(output[:120])
            else:
                self._msg(str(output)[:120])
        except Exception as e:
            self._msg("CLI error: " + str(e))

    def _do_command(self, cmd: str):
        if not cmd:
            return
        parts = cmd.strip().split(None, 1)
        verb = parts[0].lower() if parts else ""
        arg = parts[1] if len(parts) > 1 else ""

        if verb == "quit" or verb == "q":
            self.running = False
        elif verb == "theme":
            if arg and arg in THEMES:
                self.theme.set_theme(arg)
                self._msg("Theme: " + self.theme.current["name"])
            else:
                self.theme.next_theme()
                self._msg("Theme: " + self.theme.current["name"])
        elif verb == "view":
            if arg in VIEWS:
                self.prev_view = self.view
                self.view = arg
                self.selected_idx = 0
                self.scroll_offset = 0
            else:
                self._msg("Views: " + ", ".join(VIEWS))
        elif verb == "runtime-toggle" or verb == "rt":
            self._action_toggle_runtime()
        elif verb == "refresh":
            threading.Thread(target=self._refresh_data, daemon=True).start()
            self._msg("Refreshing...")
        elif verb == "capture" or verb == "cap":
            if arg:
                self._do_capture(arg)
            else:
                self._open_minibuffer("Capture: ", self._do_capture)
        elif verb == "cli":
            if arg:
                self._do_cli(arg)
            else:
                self._open_minibuffer("CLI> ", self._do_cli)
        elif verb == "search":
            if arg:
                self._do_search(arg)
            else:
                self._open_minibuffer("Search: ", self._do_search)
        elif verb == "help":
            self._msg("Commands: quit theme view runtime-toggle refresh capture cli search help")
        else:
            self._do_cli(cmd)

    def _render_nc(self):
        rows, cols = self.dims
        t = self.theme.current
        self.stdp.erase()
        r, g, b = self.theme.rgb("bg")
        self.stdp.set_bg_rgb8(r, g, b)
        for y in range(rows):
            self.stdp.putstr_yx(y, 0, " " * cols)
        self._render_header_nc(cols)
        content_top = 1
        content_bottom = rows - 2
        if self.sidebar_visible:
            self._render_sidebar_nc(content_top, content_bottom, rows, cols)
            main_left = self.sidebar_width + 1
        else:
            main_left = 0
        main_width = cols - main_left
        if main_width > 2:
            self._render_main_nc(content_top, content_bottom, main_left, main_width)
        self._render_modeline_nc(rows - 2, cols)
        self._render_minibuffer_nc(rows - 1, cols)
        if self.command_palette_active:
            self._render_palette_nc(rows, cols)

    def _render_header_nc(self, cols):
        r, g, b = self.theme.rgb("header_bg")
        self.stdp.set_bg_rgb8(r, g, b)
        r, g, b = self.theme.rgb("header_fg")
        self.stdp.set_fg_rgb8(r, g, b)
        header = " RACHAEL"
        right = self.view.upper() + " "
        pad = cols - len(header) - len(right)
        if pad < 0:
            pad = 0
        self.stdp.putstr_yx(0, 0, header + " " * pad + right)
        r, g, b = self.theme.rgb("bg")
        self.stdp.set_bg_rgb8(r, g, b)

    def _render_sidebar_nc(self, top, bottom, rows, cols):
        sw = min(self.sidebar_width, cols - 10)
        if sw < 5:
            return
        r, g, b = self.theme.rgb("border")
        self.stdp.set_fg_rgb8(r, g, b)
        for y in range(top, min(bottom + 1, rows)):
            self.stdp.putstr_yx(y, sw, "\u2502")
        r, g, b = self.theme.rgb("dim")
        self.stdp.set_fg_rgb8(r, g, b)
        self.stdp.putstr_yx(top, 1, "VIEWS")
        for i, v in enumerate(VIEWS):
            y = top + 1 + i
            if y >= bottom:
                break
            is_active = v == self.view
            prefix = "\u25B6 " if is_active else "  "
            label = str(i + 1 if i < 9 else 0) + " " + v
            if is_active:
                r, g, b = self.theme.rgb("accent")
                self.stdp.set_fg_rgb8(r, g, b)
            else:
                r, g, b = self.theme.rgb("fg")
                self.stdp.set_fg_rgb8(r, g, b)
            self.stdp.putstr_yx(y, 1, (prefix + label)[:sw - 1])
        info_y = top + len(VIEWS) + 2
        if info_y < bottom:
            r, g, b = self.theme.rgb("dim")
            self.stdp.set_fg_rgb8(r, g, b)
            runtime = self.data_cache.get("runtime", {})
            rt_status = "ON" if runtime.get("active") else "OFF"
            rt_color = "success" if runtime.get("active") else "error"
            r2, g2, b2 = self.theme.rgb(rt_color)
            self.stdp.set_fg_rgb8(r2, g2, b2)
            self.stdp.putstr_yx(info_y, 1, ("RT: " + rt_status)[:sw - 1])
        if info_y + 1 < bottom:
            budget = self.data_cache.get("budget", {})
            spent = budget.get("spent", 0)
            cap = budget.get("dailyCap", 0)
            r, g, b = self.theme.rgb("dim")
            self.stdp.set_fg_rgb8(r, g, b)
            bstr = "$" + str(round(spent, 2)) + "/" + str(round(cap, 2))
            self.stdp.putstr_yx(info_y + 1, 1, bstr[:sw - 1])
        ctrl = self.data_cache.get("control", {})
        mode = ctrl.get("mode", "human")
        if info_y + 2 < bottom:
            mc = "info" if mode == "agent" else "warn"
            r, g, b = self.theme.rgb(mc)
            self.stdp.set_fg_rgb8(r, g, b)
            self.stdp.putstr_yx(info_y + 2, 1, mode.upper()[:sw - 1])

    def _render_main_nc(self, top, bottom, left, width):
        with self.data_lock:
            items = self._current_items()
        view_height = bottom - top
        if view_height < 1:
            return
        if self.selected_idx >= self.scroll_offset + view_height:
            self.scroll_offset = self.selected_idx - view_height + 1
        if self.selected_idx < self.scroll_offset:
            self.scroll_offset = self.selected_idx
        r, g, b = self.theme.rgb("dim")
        self.stdp.set_fg_rgb8(r, g, b)
        title = self.view.upper()
        if items:
            title += " (" + str(len(items)) + ")"
        self.stdp.putstr_yx(top, left + 1, title[:width - 2])
        y = top + 1
        for i in range(self.scroll_offset, len(items)):
            if y >= bottom:
                break
            item = items[i]
            is_sel = i == self.selected_idx
            is_exp = isinstance(item, dict) and item.get("id") == self.expanded_id
            line = self._format_item(item, width - 2)
            if is_sel:
                r, g, b = self.theme.rgb("sel_bg")
                self.stdp.set_bg_rgb8(r, g, b)
                r, g, b = self.theme.rgb("sel_fg")
                self.stdp.set_fg_rgb8(r, g, b)
            elif isinstance(item, dict) and "_section" in item:
                r, g, b = self.theme.rgb("accent")
                self.stdp.set_fg_rgb8(r, g, b)
                r2, g2, b2 = self.theme.rgb("bg")
                self.stdp.set_bg_rgb8(r2, g2, b2)
            elif isinstance(item, dict) and item.get("status") == "error":
                r, g, b = self.theme.rgb("error")
                self.stdp.set_fg_rgb8(r, g, b)
                r2, g2, b2 = self.theme.rgb("bg")
                self.stdp.set_bg_rgb8(r2, g2, b2)
            else:
                r, g, b = self.theme.rgb("fg")
                self.stdp.set_fg_rgb8(r, g, b)
                r2, g2, b2 = self.theme.rgb("bg")
                self.stdp.set_bg_rgb8(r2, g2, b2)
            padded = line.ljust(width - 2)[:width - 2]
            self.stdp.putstr_yx(y, left + 1, padded)
            r2, g2, b2 = self.theme.rgb("bg")
            self.stdp.set_bg_rgb8(r2, g2, b2)
            y += 1
            if is_exp and isinstance(item, dict):
                detail_lines = self._format_detail(item, width - 4)
                for dl in detail_lines:
                    if y >= bottom:
                        break
                    r, g, b = self.theme.rgb("dim")
                    self.stdp.set_fg_rgb8(r, g, b)
                    self.stdp.putstr_yx(y, left + 3, dl[:width - 4])
                    y += 1

    def _render_modeline_nc(self, y, cols):
        r, g, b = self.theme.rgb("mode_line_bg")
        self.stdp.set_bg_rgb8(r, g, b)
        r, g, b = self.theme.rgb("mode_line_fg")
        self.stdp.set_fg_rgb8(r, g, b)
        left = " " + self.view.upper()
        runtime = self.data_cache.get("runtime", {})
        rt = "ON" if runtime.get("active") else "OFF"
        right = self.theme.current["name"] + " | RT:" + rt + " "
        pad = cols - len(left) - len(right)
        if pad < 0:
            pad = 0
        self.stdp.putstr_yx(y, 0, left + " " * pad + right)
        r, g, b = self.theme.rgb("bg")
        self.stdp.set_bg_rgb8(r, g, b)

    def _render_minibuffer_nc(self, y, cols):
        r, g, b = self.theme.rgb("mini_bg")
        self.stdp.set_bg_rgb8(r, g, b)
        r, g, b = self.theme.rgb("mini_fg")
        self.stdp.set_fg_rgb8(r, g, b)
        if self.minibuffer_active:
            text = self.minibuffer_prompt + self.minibuffer_text + "\u2588"
        elif self.command_palette_active:
            text = "M-x " + self.minibuffer_text + "\u2588"
        elif self.message and time.time() - self.message_time < 5:
            text = self.message
        else:
            text = ""
        self.stdp.putstr_yx(y, 0, text.ljust(cols)[:cols])
        r, g, b = self.theme.rgb("bg")
        self.stdp.set_bg_rgb8(r, g, b)

    def _render_palette_nc(self, rows, cols):
        commands = ["quit", "theme <name>", "view <name>", "runtime-toggle",
                    "refresh", "capture <text>", "cli <cmd>", "search <q>", "help"]
        pw = min(40, cols - 4)
        ph = min(len(commands) + 2, rows - 4)
        px = (cols - pw) // 2
        py = (rows - ph) // 2
        r, g, b = self.theme.rgb("border")
        self.stdp.set_fg_rgb8(r, g, b)
        r2, g2, b2 = self.theme.rgb("bg")
        self.stdp.set_bg_rgb8(r2, g2, b2)
        self.stdp.putstr_yx(py, px, "\u250C" + "\u2500" * (pw - 2) + "\u2510")
        for i in range(1, ph - 1):
            self.stdp.putstr_yx(py + i, px, "\u2502" + " " * (pw - 2) + "\u2502")
        self.stdp.putstr_yx(py + ph - 1, px, "\u2514" + "\u2500" * (pw - 2) + "\u2518")
        r, g, b = self.theme.rgb("accent")
        self.stdp.set_fg_rgb8(r, g, b)
        self.stdp.putstr_yx(py, px + 2, " M-x Commands ")
        r, g, b = self.theme.rgb("fg")
        self.stdp.set_fg_rgb8(r, g, b)
        for i, cmd in enumerate(commands):
            cy = py + 1 + i
            if cy >= py + ph - 1:
                break
            self.stdp.putstr_yx(cy, px + 2, cmd[:pw - 4])

    def _render_curses(self, stdscr, curses):
        rows, cols = self.dims
        stdscr.erase()
        self._render_header_curses(stdscr, curses, cols)
        content_top = 1
        content_bottom = rows - 2
        if self.sidebar_visible:
            self._render_sidebar_curses(stdscr, curses, content_top, content_bottom, cols)
            main_left = self.sidebar_width + 1
        else:
            main_left = 0
        main_width = cols - main_left
        if main_width > 2:
            self._render_main_curses(stdscr, curses, content_top, content_bottom, main_left, main_width)
        self._render_modeline_curses(stdscr, curses, rows - 2, cols)
        self._render_minibuffer_curses(stdscr, curses, rows - 1, cols)
        if self.command_palette_active:
            self._render_palette_curses(stdscr, curses, rows, cols)
        stdscr.noutrefresh()
        curses.doupdate()

    def _render_header_curses(self, stdscr, curses, cols):
        header = " RACHAEL"
        right = self.view.upper() + " "
        pad = cols - len(header) - len(right)
        if pad < 0:
            pad = 0
        try:
            stdscr.addnstr(0, 0, (header + " " * pad + right)[:cols], cols, curses.color_pair(7))
        except curses.error:
            pass

    def _render_sidebar_curses(self, stdscr, curses, top, bottom, cols):
        sw = min(self.sidebar_width, cols - 10)
        if sw < 5:
            return
        for y in range(top, min(bottom + 1, self.dims[0])):
            try:
                stdscr.addch(y, sw, curses.ACS_VLINE, curses.color_pair(12))
            except curses.error:
                pass
        try:
            stdscr.addnstr(top, 1, "VIEWS", sw - 1, curses.color_pair(2))
        except curses.error:
            pass
        for i, v in enumerate(VIEWS):
            y = top + 1 + i
            if y >= bottom:
                break
            is_active = v == self.view
            prefix = "> " if is_active else "  "
            label = str(i + 1 if i < 9 else 0) + " " + v
            cp = curses.color_pair(3) if is_active else curses.color_pair(1)
            try:
                stdscr.addnstr(y, 1, (prefix + label)[:sw - 1], sw - 1, cp)
            except curses.error:
                pass
        info_y = top + len(VIEWS) + 2
        if info_y < bottom:
            runtime = self.data_cache.get("runtime", {})
            rt_status = "ON" if runtime.get("active") else "OFF"
            cp = curses.color_pair(6) if runtime.get("active") else curses.color_pair(4)
            try:
                stdscr.addnstr(info_y, 1, ("RT: " + rt_status)[:sw - 1], sw - 1, cp)
            except curses.error:
                pass
        if info_y + 1 < bottom:
            budget = self.data_cache.get("budget", {})
            spent = budget.get("spent", 0)
            cap = budget.get("dailyCap", 0)
            bstr = "$" + str(round(spent, 2)) + "/" + str(round(cap, 2))
            try:
                stdscr.addnstr(info_y + 1, 1, bstr[:sw - 1], sw - 1, curses.color_pair(2))
            except curses.error:
                pass

    def _render_main_curses(self, stdscr, curses, top, bottom, left, width):
        with self.data_lock:
            items = self._current_items()
        view_height = bottom - top
        if view_height < 1:
            return
        if self.selected_idx >= self.scroll_offset + view_height:
            self.scroll_offset = self.selected_idx - view_height + 1
        if self.selected_idx < self.scroll_offset:
            self.scroll_offset = self.selected_idx
        title = self.view.upper()
        if items:
            title += " (" + str(len(items)) + ")"
        try:
            stdscr.addnstr(top, left + 1, title[:width - 2], width - 2, curses.color_pair(2))
        except curses.error:
            pass
        y = top + 1
        for i in range(self.scroll_offset, len(items)):
            if y >= bottom:
                break
            item = items[i]
            is_sel = i == self.selected_idx
            is_exp = isinstance(item, dict) and item.get("id") == self.expanded_id
            line = self._format_item(item, width - 2)
            if is_sel:
                cp = curses.color_pair(8)
            elif isinstance(item, dict) and "_section" in item:
                cp = curses.color_pair(3)
            elif isinstance(item, dict) and item.get("status") == "error":
                cp = curses.color_pair(4)
            else:
                cp = curses.color_pair(1)
            padded = line.ljust(width - 2)[:width - 2]
            try:
                stdscr.addnstr(y, left + 1, padded, width - 2, cp)
            except curses.error:
                pass
            y += 1
            if is_exp and isinstance(item, dict):
                detail_lines = self._format_detail(item, width - 4)
                for dl in detail_lines:
                    if y >= bottom:
                        break
                    try:
                        stdscr.addnstr(y, left + 3, dl[:width - 4], width - 4, curses.color_pair(2))
                    except curses.error:
                        pass
                    y += 1

    def _render_modeline_curses(self, stdscr, curses, y, cols):
        left = " " + self.view.upper()
        runtime = self.data_cache.get("runtime", {})
        rt = "ON" if runtime.get("active") else "OFF"
        right = self.theme.current["name"] + " | RT:" + rt + " "
        pad = cols - len(left) - len(right)
        if pad < 0:
            pad = 0
        ml = (left + " " * pad + right)[:cols]
        try:
            stdscr.addnstr(y, 0, ml, cols, curses.color_pair(9))
        except curses.error:
            pass

    def _render_minibuffer_curses(self, stdscr, curses, y, cols):
        if self.minibuffer_active:
            text = self.minibuffer_prompt + self.minibuffer_text + "_"
        elif self.command_palette_active:
            text = "M-x " + self.minibuffer_text + "_"
        elif self.message and time.time() - self.message_time < 5:
            text = self.message
        else:
            text = ""
        try:
            stdscr.addnstr(y, 0, text.ljust(cols)[:cols - 1], cols - 1, curses.color_pair(10))
        except curses.error:
            pass

    def _render_palette_curses(self, stdscr, curses, rows, cols):
        commands = ["quit", "theme <name>", "view <name>", "runtime-toggle",
                    "refresh", "capture <text>", "cli <cmd>", "search <q>", "help"]
        pw = min(40, cols - 4)
        ph = min(len(commands) + 2, rows - 4)
        px = (cols - pw) // 2
        py = (rows - ph) // 2
        try:
            stdscr.addnstr(py, px, "+" + "-" * (pw - 2) + "+", pw, curses.color_pair(12))
            for i in range(1, ph - 1):
                stdscr.addnstr(py + i, px, "|" + " " * (pw - 2) + "|", pw, curses.color_pair(12))
            stdscr.addnstr(py + ph - 1, px, "+" + "-" * (pw - 2) + "+", pw, curses.color_pair(12))
            stdscr.addnstr(py, px + 2, " M-x Commands ", 14, curses.color_pair(3))
            for i, cmd in enumerate(commands):
                cy = py + 1 + i
                if cy >= py + ph - 1:
                    break
                stdscr.addnstr(cy, px + 2, cmd[:pw - 4], pw - 4, curses.color_pair(1))
        except curses.error:
            pass

    def _format_item(self, item, max_width: int) -> str:
        if not isinstance(item, dict):
            return str(item)[:max_width]
        if "_section" in item:
            return "\u2500\u2500 " + item["_section"] + " " + "\u2500" * max(0, max_width - len(item["_section"]) - 4)
        if "_tree" in item:
            return "  " + item.get("_label", "")
        if self.view == "programs":
            enabled = item.get("enabled", False)
            name = item.get("name", "?")
            cost = item.get("costTier", "")
            sched = item.get("schedule", "")
            runtime = self.data_cache.get("runtime", {})
            rp_list = runtime.get("programs", [])
            rp = None
            for p in rp_list:
                if p.get("name") == name:
                    rp = p
                    break
            if not enabled:
                sc = STATUS_CHARS["disabled"]
            elif rp:
                sc = STATUS_CHARS.get(rp.get("status", ""), STATUS_CHARS["enabled"])
            else:
                sc = STATUS_CHARS["enabled"]
            parts = [sc, " ", name]
            right = ""
            if cost:
                right += " [" + cost + "]"
            if sched:
                right += " " + sched
            avail = max_width - len(name) - len(right) - 2
            if avail < 0:
                return (sc + " " + name)[:max_width]
            return (sc + " " + name + " " * max(0, avail) + right)[:max_width]
        elif self.view == "results":
            status = item.get("status", "")
            sc = "\u2713" if status == "ok" else "\u2717"
            prog = (item.get("programName", "") or "")[:12]
            summary = item.get("summary", "") or ""
            metric = item.get("metric")
            line = sc + " " + prog.ljust(13) + summary
            if metric:
                line += " =" + str(metric)
            return line[:max_width]
        elif self.view == "reader":
            title = item.get("title", "?")
            domain = item.get("domain", "")
            return ("\u25A0 " + title + "  [" + domain + "]")[:max_width]
        elif self.view == "cockpit":
            desc = item.get("description", "")
            src = item.get("source", "")
            ts = item.get("timestamp", 0)
            tstr = ""
            if ts:
                try:
                    import datetime
                    tstr = datetime.datetime.fromtimestamp(ts / 1000).strftime("%H:%M:%S")
                except Exception:
                    pass
            return (tstr + " " + src + ": " + desc)[:max_width]
        elif self.view == "agenda":
            if item.get("status"):
                done = item.get("status") == "DONE"
                check = "[X]" if done else "[ ]"
                title = item.get("title", "")
                date = item.get("scheduledDate", "")
                pri = item.get("priority", "")
                right = ""
                if date:
                    right += " " + date
                if pri:
                    right += " [" + pri + "]"
                return (check + " " + title + right)[:max_width]
            elif item.get("summary"):
                prog = (item.get("programName", "") or "")[:12]
                summary = item.get("summary", "")
                return ("\u25B8 " + prog + ": " + summary)[:max_width]
        elif self.view == "evolution":
            if item.get("version") is not None:
                v = "v" + str(item.get("version", 0))
                st = item.get("status", "")
                return (v + " [" + st + "]")[:max_width]
        elif self.view == "snow":
            title = item.get("title", item.get("description", "?"))
            status = item.get("status", "")
            return (status[:8] + " " + str(title))[:max_width]
        return str(item.get("name", item.get("title", item.get("id", "?"))))[:max_width]

    def _format_detail(self, item: dict, max_width: int) -> list:
        lines = []
        if self.view == "programs":
            instr = item.get("instructions", "")
            if instr:
                lines.append(instr[:max_width * 2])
            lines.append("type: " + str(item.get("type", "?")) + "  lang: " + str(item.get("codeLang", "?")))
            runtime = self.data_cache.get("runtime", {})
            rp_list = runtime.get("programs", [])
            rp = None
            for p in rp_list:
                if p.get("name") == item.get("name"):
                    rp = p
                    break
            if rp:
                lines.append("iter: " + str(rp.get("iteration", 0)) + "  status: " + str(rp.get("status", "?")))
                last_out = rp.get("lastOutput", "")
                if last_out:
                    for ol in str(last_out)[:300].split("\n"):
                        lines.append("  " + ol)
                err = rp.get("error")
                if err:
                    lines.append("ERROR: " + str(err)[:max_width])
        elif self.view == "results":
            lines.append("model: " + str(item.get("model", "?")) +
                          "  tokens: " + str(item.get("tokensUsed", 0)) +
                          "  iter: " + str(item.get("iteration", 0)))
            raw = item.get("rawOutput") or item.get("summary") or ""
            for rl in str(raw)[:500].split("\n"):
                lines.append(rl)
        elif self.view == "reader":
            lines.append("URL: " + str(item.get("url", "")))
            text = item.get("extractedText", "")
            for rl in str(text)[:400].split("\n"):
                lines.append(rl)
        elif self.view == "cockpit":
            data = item.get("data", {})
            if data:
                for k, v in data.items():
                    lines.append(str(k) + ": " + str(v)[:max_width])
        elif self.view == "agenda":
            body = item.get("body") or item.get("rawOutput") or ""
            if body:
                for rl in str(body)[:400].split("\n"):
                    lines.append(rl)
        elif self.view == "evolution":
            ms = item.get("metricsSnapshot", {})
            if ms:
                sr = ms.get("successRate", 0)
                lines.append("Success: " + str(round(sr * 100, 1)) + "%")
            gr = item.get("gateResults", {})
            if gr:
                for gate, result in gr.items():
                    passed = result.get("passed", False)
                    reason = result.get("reason", "")
                    mark = "\u2713" if passed else "\u2717"
                    lines.append(mark + " " + gate + ": " + reason[:max_width - 10])
            applied = item.get("appliedAt", "")
            if applied:
                lines.append("Applied: " + applied)
        wrapped = []
        for line in lines:
            while len(line) > max_width and max_width > 0:
                wrapped.append(line[:max_width])
                line = line[max_width:]
            wrapped.append(line)
        return wrapped[:20]


def main():
    import argparse
    parser = argparse.ArgumentParser(description="Rachael TUI Client")
    parser.add_argument("--url", default=None,
                        help="Rachael server URL (default: http://localhost:5000)")
    parser.add_argument("--key", default=None,
                        help="API key (reads from OPENCLAW_API_KEY or /opt/rachael/.env)")
    parser.add_argument("--theme", default=None,
                        help="Color theme: " + ", ".join(THEME_NAMES))
    args = parser.parse_args()

    tui = RachaelTUI(base_url=args.url, api_key=args.key)
    if args.theme:
        tui.theme.set_theme(args.theme)
    tui.run()


if __name__ == "__main__":
    main()
