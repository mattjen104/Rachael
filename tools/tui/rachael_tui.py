#!/usr/bin/env python3
import sys
import os
import time
import threading
import math
from collections import deque
from typing import Optional, Callable

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from api_client import RachaelAPI, APIError
from themes import ThemeEngine, THEMES, THEME_NAMES
from nc_widgets import (
    NC_AVAILABLE, NcPlane, Notcurses, NcInput, WidgetManager,
    check_capabilities, detect_media_capabilities, braille_sparkline_str,
    NCALPHA_BLEND, BRAILLE_BLOCKS, MEDIA_CAPS, activity_density_grid,
)
from tui_views import (
    VIEWS, SNOW_TABS, EVO_TABS, STATUS_CHARS, TreeState,
    current_items, format_item, format_detail,
    build_evolution_items, wrap_text,
)

VERSION = "1.0.0"
VIEW_KEYS = {
    "1": "agenda", "2": "tree", "3": "programs", "4": "results",
    "5": "reader", "6": "cockpit", "7": "snow", "8": "evolution",
    "9": "transcripts", "0": "voice",
}
LOGO = [
    " ____            _                _",
    "|  _ \\ __ _  ___| |__   __ _  ___| |",
    "| |_) / _` |/ __| '_ \\ / _` |/ _ \\ |",
    "|  _ < (_| | (__| | | | (_| |  __/ |",
    "|_| \\_\\__,_|\\___|_| |_|\\__,_|\\___|_|",
]
MENU_SECTIONS = [
    ("File", [("Quit", "C-x C-c"), ("Refresh", "C-l")]),
    ("View", [("Agenda", "1"), ("Tree", "2"), ("Programs", "3"),
              ("Results", "4"), ("Reader", "5"), ("Cockpit", "6"),
              ("SNOW", "7"), ("Evolution", "8"), ("Transcripts", "9"),
              ("Voice", "0")]),
    ("Actions", [("Capture", "c"), ("CLI", "X"), ("Search", "/"),
                 ("Toggle Runtime", "R"), ("Theme", "T"),
                 ("Multi-select Programs", "M"), ("Journal", "J")]),
    ("Help", [("Keybindings", "?")]),
]
PALETTE_ALL_CMDS = [
    ("quit", "Exit Rachael TUI"),
    ("theme phosphor", "Phosphor Green theme"),
    ("theme amber", "Amber CRT theme"),
    ("theme cool-blue", "Cool Blue theme"),
    ("theme solarized", "Solarized Dark theme"),
    ("theme dracula", "Dracula theme"),
    ("theme red-alert", "Red Alert theme"),
    ("view agenda", "Switch to Agenda"),
    ("view tree", "Switch to Tree"),
    ("view programs", "Switch to Programs"),
    ("view results", "Switch to Results"),
    ("view reader", "Switch to Reader"),
    ("view cockpit", "Switch to Cockpit"),
    ("view snow", "Switch to SNOW"),
    ("view evolution", "Switch to Evolution"),
    ("view transcripts", "Switch to Transcripts"),
    ("view voice", "Switch to Voice"),
    ("runtime-toggle", "Toggle runtime ON/OFF"),
    ("refresh", "Refresh all data"),
    ("consolidate", "Trigger evolution consolidation"),
    ("multi-select", "Multi-select programs to toggle"),
    ("journal", "Create journal entry"),
    ("reader-add", "Add reader page by URL"),
    ("help", "Show keybinding help"),
]


def _fuzzy_match(query: str, text: str) -> bool:
    query = query.lower()
    text = text.lower()
    qi = 0
    for ch in text:
        if qi < len(query) and ch == query[qi]:
            qi += 1
    return qi == len(query)


class RachaelTUI:
    def __init__(self, base_url: Optional[str] = None, api_key: Optional[str] = None):
        self.api = RachaelAPI(base_url=base_url, api_key=api_key)
        self.theme = ThemeEngine()
        self.nc: Optional[Notcurses] = None
        self.stdp = None
        self.wm: Optional[WidgetManager] = None
        self.header_plane = None
        self.sidebar_plane = None
        self.main_plane = None
        self.modeline_plane = None
        self.minibuffer_plane = None
        self.palette_plane = None
        self.running = False
        self.view = "agenda"
        self.prev_view = "agenda"
        self.selected_idx = 0
        self.scroll_offset = 0
        self.expanded_id = None
        self.minibuffer_active = False
        self.minibuffer_text = ""
        self.minibuffer_prompt = ""
        self.minibuffer_callback: Optional[Callable] = None
        self.minibuffer_history: list = []
        self.minibuffer_hist_idx = -1
        self.command_palette_active = False
        self.palette_idx = 0
        self.palette_filter = ""
        self.message = ""
        self.message_time = 0.0
        self.cockpit_events: deque = deque(maxlen=500)
        self.cockpit_connected = False
        self.data_cache: dict = {}
        self.data_lock = threading.Lock()
        self.last_refresh = 0.0
        self.refresh_interval = 5
        self.sidebar_width = 22
        self.sidebar_visible = True
        self.dims = (24, 80)
        self.ctrl_x_pending = False
        self.reader_reading_id = None
        self.evo_tab = "overview"
        self.snow_tab = "my-queue"
        self.tree_state = TreeState()
        self.sparkline_data: deque = deque(maxlen=60)
        self.new_item_ids: set = set()
        self.new_item_time: dict = {}
        self.nc_reader_active = False
        self.nc_selector_active = False
        self.nc_multiselector_active = False
        self._multiselector_programs: list = []
        self._snow_selector_active = False

    def run(self):
        detect_media_capabilities()
        if not NC_AVAILABLE:
            import sys
            print("WARNING: notcurses not available. Running in degraded curses mode.", file=sys.stderr)
            print("Install notcurses for full TUI capabilities: pip3 install notcurses", file=sys.stderr)
            degraded = check_capabilities()
            if degraded:
                print("Degraded widgets: " + ", ".join(degraded), file=sys.stderr)
            self._run_fallback()
            return
        try:
            self.nc = Notcurses()
            self.stdp = self.nc.stdplane()
            self.running = True
            self.dims = self.stdp.dim_yx()
            self.wm = WidgetManager(self.nc, self.stdp, self.dims, self.theme)
            self._create_planes()
            self.wm.create_menu(MENU_SECTIONS)
            self._create_sidebar_widgets()
            self._create_main_widgets()
            self._start_background()
            self._splash_nc()
            self._main_loop()
        except Exception as e:
            self.running = False
            if self.nc:
                try:
                    self.nc.stop()
                except (RuntimeError, OSError):
                    pass
                self.nc = None
            sys.stderr.write("notcurses init failed, falling back to curses: " + str(e) + "\n")
            self._run_fallback()
        finally:
            self.running = False
            self.api.stop_sse()
            self.api.stop()
            if self.nc:
                try:
                    self.nc.stop()
                except (RuntimeError, OSError):
                    pass

    def _create_planes(self):
        rows, cols = self.dims
        self.header_plane = NcPlane(self.stdp, 1, cols, 0, 0)
        sb_h = max(1, rows - 3)
        self.sidebar_plane = NcPlane(self.stdp, sb_h, self.sidebar_width, 1, 0)
        main_left = self.sidebar_width + 1
        main_w = max(2, cols - main_left)
        main_h = max(1, rows - 3)
        self.main_plane = NcPlane(self.stdp, main_h, main_w, 1, main_left)
        self.modeline_plane = NcPlane(self.stdp, 1, cols, max(0, rows - 2), 0)
        self.minibuffer_plane = NcPlane(self.stdp, 1, cols, max(0, rows - 1), 0)
        pal_w = min(54, cols - 4)
        pal_h = min(18, rows - 4)
        if pal_w > 12 and pal_h > 5:
            px = (cols - pal_w) // 2
            py = (rows - pal_h) // 2
            self.palette_plane = NcPlane(self.stdp, pal_h, pal_w, py, px)
            self.wm.set_bg_alpha(self.palette_plane)
            self.palette_plane.move_above(self.main_plane)

    def _create_sidebar_widgets(self):
        if self.sidebar_plane:
            sb_rows, sb_cols = self.sidebar_plane.dim_yx()
            pb_y = min(sb_rows - 3, len(VIEWS) + 6)
            if 0 < pb_y < sb_rows - 1:
                self.wm.create_progbar(self.sidebar_plane, pb_y, 2, max(2, sb_cols - 4))
            bpb_y = pb_y + 1
            if 0 < bpb_y < sb_rows - 1:
                self.wm.create_budget_progbar(self.sidebar_plane, bpb_y, 2, max(2, sb_cols - 4))

    def _create_main_widgets(self):
        if self.main_plane:
            m_rows, m_cols = self.main_plane.dim_yx()
            sp_w = min(30, m_cols - 4)
            if sp_w > 5 and m_rows > 6:
                self.wm.create_sparkline(self.main_plane, 4, sp_w, 1, m_cols - sp_w - 2)

    def _cancel_all(self):
        cancelled = False
        if self.minibuffer_active:
            self.minibuffer_active = False
            self.minibuffer_text = ""
            self.minibuffer_prompt = ""
            self.minibuffer_callback = None
            cancelled = True
        if self.command_palette_active:
            self.command_palette_active = False
            self.palette_filter = ""
            cancelled = True
        if self.nc_selector_active and self.wm:
            self.wm.destroy_selector()
            self.nc_selector_active = False
            self._snow_selector_active = False
            cancelled = True
        if self.nc_multiselector_active and self.wm:
            self.wm.destroy_multiselector()
            self.nc_multiselector_active = False
            cancelled = True
        if self.nc_reader_active and self.wm:
            self.wm.destroy_reader()
            self.nc_reader_active = False
            cancelled = True
        if self.ctrl_x_pending:
            self.ctrl_x_pending = False
            cancelled = True
        if self.reader_reading_id:
            self.reader_reading_id = None
            cancelled = True
        if self.expanded_id:
            self.expanded_id = None
            cancelled = True
        if cancelled:
            self._msg("Cancelled")
        else:
            self._msg("C-g")

    def _on_resize(self, rows: int, cols: int):
        self.dims = (rows, cols)
        if self.wm:
            self.wm.dims = self.dims
        self._resize_planes()

    def _resize_planes(self):
        rows, cols = self.dims
        for plane, y, h, w, x in [
            (self.header_plane, 0, 1, cols, 0),
            (self.sidebar_plane, 1, max(1, rows - 3), self.sidebar_width,
             0 if self.sidebar_visible else -9999),
            (self.main_plane, 1, max(1, rows - 3),
             max(2, cols - (self.sidebar_width + 1 if self.sidebar_visible else 0)),
             (self.sidebar_width + 1) if self.sidebar_visible else 0),
            (self.modeline_plane, max(0, rows - 2), 1, cols, 0),
            (self.minibuffer_plane, max(0, rows - 1), 1, cols, 0),
        ]:
            if plane:
                plane.resize(h, w)
                plane.move_yx(y, x)

    def _start_background(self):
        self.api.start()
        t = threading.Thread(target=self._refresh_loop, daemon=True)
        t.start()
        self.api.start_sse(self._on_cockpit_event)

    def _on_cockpit_event(self, event):
        self.cockpit_connected = True
        event_id = event.get("id")
        if event_id:
            self.new_item_ids.add(event_id)
            self.new_item_time[event_id] = time.time()
        self.cockpit_events.append(event)
        metric = event.get("data", {}).get("metric") if isinstance(event.get("data"), dict) else None
        if metric and isinstance(metric, (int, float)):
            self.sparkline_data.append(metric)
            if self.wm:
                self.wm.add_sparkline_sample(metric)
        if self.wm and self.view == "cockpit":
            self.wm.add_reel_tablet(self._cockpit_tablet_draw, event)

    def _refresh_loop(self):
        while self.running:
            self._refresh_data()
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
            "skills": lambda: self.api.skills(),
            "notes": lambda: self.api.notes(),
            "captures": lambda: self.api.captures(limit=30),
            "snow_records": lambda: self.api.snow_records(),
        }
        for key, fn in fetches.items():
            try:
                value = fn()
                with self.data_lock:
                    old = self.data_cache.get(key)
                    self.data_cache[key] = value
                    if isinstance(value, list) and isinstance(old, list):
                        old_ids = {i.get("id") for i in old if isinstance(i, dict) and i.get("id")}
                        for i in value:
                            if isinstance(i, dict):
                                iid = i.get("id")
                                if iid and iid not in old_ids:
                                    self.new_item_ids.add(iid)
                                    self.new_item_time[iid] = time.time()
            except APIError as ae:
                self.data_cache.setdefault("_errors", {})[key] = str(ae)
            except (ConnectionError, TimeoutError, OSError) as ne:
                self.data_cache.setdefault("_errors", {})[key] = str(ne)
        now = time.time()
        expired = [k for k, t in self.new_item_time.items() if now - t > 5]
        for k in expired:
            self.new_item_ids.discard(k)
            del self.new_item_time[k]
        budget = self.data_cache.get("budget", {})
        spent = budget.get("spent", 0)
        cap = budget.get("dailyCap", 0)
        if cap > 0 and self.wm:
            pct = spent / cap
            self.wm.set_progress(pct)
            self.wm.set_budget_progress(pct)
        with self.data_lock:
            self.last_refresh = time.time()

    def _msg(self, text: str):
        self.message = text
        self.message_time = time.time()

    def _is_new(self, item) -> bool:
        return isinstance(item, dict) and item.get("id") in self.new_item_ids

    def _pulse_fg(self, plane, item):
        if self._is_new(item):
            elapsed = time.time() - self.new_item_time.get(item.get("id"), 0)
            if self.wm and elapsed < 0.5:
                self.wm.pulse_plane(plane, 200)
            pulse = abs(math.sin(elapsed * 3.0))
            r0, g0, b0 = self.theme.rgb("accent")
            r1, g1, b1 = self.theme.rgb("fg")
            plane.set_fg_rgb8(int(r0 * pulse + r1 * (1 - pulse)),
                              int(g0 * pulse + g1 * (1 - pulse)),
                              int(b0 * pulse + b1 * (1 - pulse)))
            return True
        return False

    def _set_fg(self, plane, key):
        r, g, b = self.theme.rgb(key)
        plane.set_fg_rgb8(r, g, b)

    def _set_bg(self, plane, key):
        r, g, b = self.theme.rgb(key)
        plane.set_bg_rgb8(r, g, b)

    def _splash_nc(self):
        rows, cols = self.dims
        degraded = check_capabilities()
        if self.wm:
            degraded += [d for d in self.wm.degraded if d not in degraded]
        self.stdp.erase()
        self._set_fg(self.stdp, "accent")
        self._set_bg(self.stdp, "bg")
        for i, line in enumerate(LOGO):
            y = rows // 2 - len(LOGO) // 2 + i - 2
            x = max(0, (cols - len(line)) // 2)
            if 0 <= y < rows:
                self.stdp.putstr_yx(y, x, line)
        self._set_fg(self.stdp, "dim")
        tag = "v" + VERSION + " | " + self.theme.current["name"] + " | notcurses"
        self.stdp.putstr_yx(rows // 2 + 3, max(0, (cols - len(tag)) // 2), tag)
        offset = rows // 2 + 5
        scan = "\u2591" * min(40, cols - 4)
        if 0 <= offset < rows:
            self._set_fg(self.stdp, "border")
            self.stdp.putstr_yx(offset, max(0, (cols - len(scan)) // 2), scan)
        if degraded:
            offset += 1
            if offset < rows:
                self._set_fg(self.stdp, "warn")
                deg = "Degraded: " + ", ".join(degraded[:5])
                if len(degraded) > 5:
                    deg += " +" + str(len(degraded) - 5)
                self.stdp.putstr_yx(offset, max(0, (cols - len(deg)) // 2), deg[:cols - 2])
        media_info = [k for k, v in MEDIA_CAPS.items() if v]
        if media_info:
            offset += 1
            if offset < rows:
                self._set_fg(self.stdp, "success")
                ml = "Media: " + ", ".join(media_info)
                self.stdp.putstr_yx(offset, max(0, (cols - len(ml)) // 2), ml[:cols - 2])
        offset += 2
        if offset < rows:
            self._set_fg(self.stdp, "dim")
            self.stdp.putstr_yx(offset, max(0, (cols - 16) // 2), "Press any key...")
        self.nc.render()
        if self.wm:
            self.wm.pulse_plane(self.stdp, 600)
        self.nc.render()
        ni = NcInput()
        self.nc.get(ni)
        if self.wm:
            self.wm.fade_plane(self.stdp, 300)

    def _main_loop(self):
        ni = NcInput()
        if self.wm:
            self.wm.set_resize_callback(self._on_resize)
        while self.running:
            if self.wm:
                self.wm.check_resize()
            else:
                new_dims = self.stdp.dim_yx()
                if new_dims != self.dims:
                    self._on_resize(*new_dims)
            self._render_nc()
            self.nc.render()
            key = self.nc.get_nblock(ni)
            if key is None or key == 0:
                time.sleep(0.016)
                continue
            menu_result = self.wm.offer_menu_input(ni) if self.wm else None
            if menu_result:
                self._handle_menu_action(menu_result)
                continue
            self._handle_input(key, ni)

    def _handle_menu_action(self, action: str):
        action_lower = action.lower()
        if "quit" in action_lower:
            self.running = False
        elif "refresh" in action_lower:
            threading.Thread(target=self._refresh_data, daemon=True).start()
            self._msg("Refreshing...")
        elif "runtime" in action_lower:
            self._action_toggle_runtime()
        elif "theme" in action_lower:
            self.theme.next_theme()
            self._msg("Theme: " + self.theme.current["name"])
        elif "multi" in action_lower:
            self._open_multiselector()
        elif "journal" in action_lower:
            self._open_minibuffer("Journal: ", self._do_journal)
        else:
            for v in VIEWS:
                if v in action_lower:
                    self._switch_view(v)
                    return

    def _handle_input(self, key, ni):
        if self.nc_reader_active:
            self._handle_reader_input(key, ni)
            return
        if self.nc_multiselector_active:
            self._handle_multiselector_input(key, ni)
            return
        if self.nc_selector_active:
            self._handle_selector_input(key, ni)
            return
        if self.ctrl_x_pending:
            self._handle_ctrl_x(key)
            return
        if self.minibuffer_active:
            self._handle_minibuffer(key)
            return
        if self.command_palette_active:
            self._handle_palette(key)
            return
        char = chr(key) if 0 < key < 0x110000 else ""
        if key == 24:
            self.ctrl_x_pending = True
            self._msg("C-x-")
        elif key == 7:
            self._cancel_all()
        elif key == 19:
            self._open_minibuffer("I-search: ", self._do_search)
        elif key == 12:
            threading.Thread(target=self._refresh_data, daemon=True).start()
            self._msg("Refreshing...")
        elif key == 14:
            self._nav_down()
        elif key == 16:
            self._nav_up()
        elif ni.alt and char == "x":
            self._open_command_palette()
        elif char == "\t":
            if self.view == "snow":
                self._open_snow_tab_selector()
            else:
                self.sidebar_visible = not self.sidebar_visible
                self._resize_planes()
        elif char == "q":
            self.running = False
        elif char in VIEW_KEYS:
            self._switch_view(VIEW_KEYS[char])
        elif char == "T":
            self.theme.next_theme()
            self._msg("Theme: " + self.theme.current["name"])
        elif char == "/":
            self._open_minibuffer("Search: ", self._do_search)
        elif char == ":":
            self._open_minibuffer("M-x ", self._do_command)
        elif char == "M":
            self._open_multiselector()
        elif char == "J":
            self._open_minibuffer("Journal: ", self._do_journal)
        else:
            self._handle_view_keys(char, key)

    def _handle_reader_input(self, key, ni):
        if key == 7:
            self.wm.close_reader()
            self.nc_reader_active = False
            self._msg("Quit")
        elif key == 27:
            self.wm.close_reader()
            self.nc_reader_active = False
        elif key in (10, 13):
            text = self.wm.close_reader()
            self.nc_reader_active = False
            cb = self.minibuffer_callback
            if cb and text:
                self.minibuffer_history.append(text)
                cb(text)
        else:
            self.wm.reader_offer_input(ni)

    def _handle_multiselector_input(self, key, ni):
        if key == 7 or key == 27:
            self.wm.destroy_multiselector()
            self.nc_multiselector_active = False
            self._multiselector_programs = []
            self._msg("Cancelled")
        elif key in (10, 13):
            selected = self.wm.multiselector_selected()
            self.wm.destroy_multiselector()
            self.nc_multiselector_active = False
            self._execute_bulk_toggle(selected)
        else:
            self.wm.multiselector_offer_input(ni)

    def _execute_bulk_toggle(self, selected_items):
        if not selected_items:
            self._msg("No programs selected")
            self._multiselector_programs = []
            return
        programs = self._multiselector_programs
        toggled = 0
        errors = 0
        for sel_label in selected_items:
            for prog in programs:
                if prog.get("name") == sel_label or str(prog.get("id")) in sel_label:
                    try:
                        self.api.toggle_program(prog["id"])
                        toggled += 1
                    except APIError:
                        errors += 1
                    break
        self._multiselector_programs = []
        msg = "Toggled " + str(toggled) + " programs"
        if errors:
            msg += ", " + str(errors) + " failed"
        self._msg(msg)
        threading.Thread(target=self._refresh_data, daemon=True).start()

    def _handle_selector_input(self, key, ni):
        if key == 7 or key == 27:
            self.wm.destroy_selector()
            self.nc_selector_active = False
            self.command_palette_active = False
            self._snow_selector_active = False
            self.palette_filter = ""
        elif key in (10, 13):
            selected = self.wm.selector_selected()
            self.wm.destroy_selector()
            self.nc_selector_active = False
            was_snow = self._snow_selector_active
            was_palette = self.command_palette_active
            self.command_palette_active = False
            self._snow_selector_active = False
            self.palette_filter = ""
            if selected:
                if was_snow and selected in SNOW_TABS:
                    self.snow_tab = selected
                    self.selected_idx = 0
                    self._msg("SNOW: " + selected)
                elif was_palette:
                    self._do_command(selected)
                else:
                    self._do_command(selected)
        elif self.command_palette_active:
            char = chr(key) if 0 < key < 0x110000 else ""
            if key in (127, 263):
                self.palette_filter = self.palette_filter[:-1]
                self._rebuild_palette_selector()
            elif char and char.isprintable():
                self.palette_filter += char
                self._rebuild_palette_selector()
            else:
                self.wm.selector_offer_input(ni)
        else:
            self.wm.selector_offer_input(ni)

    def _rebuild_palette_selector(self):
        filtered = self._filtered_palette()
        if not filtered:
            return
        self.wm.rebuild_selector(filtered, title="M-x [" + self.palette_filter + "]")

    def _handle_ctrl_x(self, key):
        self.ctrl_x_pending = False
        char = chr(key) if 0 < key < 0x110000 else ""
        if key == 3 or char == "c":
            self.running = False
        elif char == "b" or key == 2:
            self._open_command_palette()

    def _nav_down(self):
        with self.data_lock:
            items = current_items(self.view, self.data_cache, self.api,
                                  self.evo_tab, self.reader_reading_id, self.cockpit_events,
                                  self.tree_state, self.snow_tab)
        self.selected_idx = min(self.selected_idx + 1, max(0, len(items) - 1))
        if self.view == "cockpit" and self.wm:
            self.wm.reel_next()

    def _nav_up(self):
        self.selected_idx = max(self.selected_idx - 1, 0)
        if self.view == "cockpit" and self.wm:
            self.wm.reel_prev()

    def _switch_view(self, new_view: str):
        if new_view == self.view:
            return
        self.prev_view = self.view
        if self.main_plane and self.wm:
            self.wm.fade_out(self.main_plane, 150)
        if self.view == "cockpit" and self.wm:
            self.wm.destroy_reel()
        if self.view == "evolution" and self.wm:
            self.wm.destroy_evo_plots()
        self.view = new_view
        self.selected_idx = 0
        self.scroll_offset = 0
        self.expanded_id = None
        self.reader_reading_id = None
        if new_view != "evolution":
            self.evo_tab = "overview"
        if self.view == "cockpit" and self.wm and self.main_plane:
            self._setup_cockpit_reel()
        if self.view == "evolution" and self.wm and self.main_plane:
            self._setup_evo_plots()
        if self.main_plane and self.wm:
            self.wm.fade_in(self.main_plane, 150)

    def _setup_cockpit_reel(self):
        m_rows, m_cols = self.main_plane.dim_yx()
        reel = self.wm.create_reel(self.main_plane, max(1, m_rows - 2), max(2, m_cols - 2), 1, 1)
        if reel:
            for evt in list(self.cockpit_events)[-20:]:
                self.wm.add_reel_tablet(self._cockpit_tablet_draw, evt)

    def _setup_evo_plots(self):
        m_rows, m_cols = self.main_plane.dim_yx()
        plot_w = min(30, m_cols - 4)
        if plot_w > 5 and m_rows > 12:
            plots = self.wm.create_evo_plots(self.main_plane, m_rows - 10, m_cols - plot_w - 2, plot_w)
            if plots:
                self._feed_evo_plot_data(plots)

    def _feed_evo_plot_data(self, plots):
        try:
            state = self.api.evolution_state()
            versions = state.get("recentVersions", [])
            for v in versions:
                ms = v.get("metricsSnapshot", {})
                if ms:
                    sr = ms.get("successRate", 0)
                    cr = ms.get("correctionRate", 0)
                    tokens = ms.get("tokensUsed", 0)
                    if "success" in plots:
                        self.wm.add_sparkline_sample(float(sr), "success")
                    if "corrections" in plots:
                        self.wm.add_sparkline_sample(float(cr), "corrections")
                    if "tokens" in plots:
                        self.wm.add_sparkline_sample(float(tokens), "tokens")
        except (APIError, ConnectionError, TimeoutError, KeyError):
            pass

    @staticmethod
    def _cockpit_tablet_draw(tablet_plane, data):
        if not data or not isinstance(data, dict):
            return 1
        try:
            _, cols = tablet_plane.dim_yx()
            etype = data.get("eventType", "")
            icon = "\u25CF"
            if etype == "error":
                icon = "\u2717"
            elif etype == "take-over-point":
                icon = "\u26A1"
            elif etype == "decision":
                icon = "\u25B6"
            ts = data.get("timestamp", 0)
            tstr = ""
            if ts:
                try:
                    import datetime
                    tstr = datetime.datetime.fromtimestamp(ts / 1000).strftime("%H:%M:%S")
                except (RuntimeError, AttributeError, ValueError, OSError):
                    pass
            src = data.get("source", "")[:10]
            desc = data.get("description", "")
            line = icon + " " + tstr + " [" + src + "] " + desc
            tablet_plane.putstr_yx(0, 0, line[:cols])
            event_data = data.get("data", {})
            if event_data and isinstance(event_data, dict) and cols > 20:
                try:
                    detail_parts = []
                    for k, v in list(event_data.items())[:3]:
                        detail_parts.append(str(k) + "=" + str(v)[:15])
                    if detail_parts:
                        tablet_plane.putstr_yx(1, 2, "  ".join(detail_parts)[:cols - 2])
                        return 2
                except (RuntimeError, AttributeError, ValueError, OSError):
                    pass
            return 1
        except (RuntimeError, AttributeError, TypeError, ValueError):
            return 1

    def _handle_view_keys(self, char: str, key: int = 0):
        with self.data_lock:
            items = current_items(self.view, self.data_cache, self.api,
                                  self.evo_tab, self.reader_reading_id, self.cockpit_events,
                                  self.tree_state, self.snow_tab)
        count = len(items) if items else 0
        if char == "j" or char == "n":
            self.selected_idx = min(self.selected_idx + 1, max(0, count - 1))
        elif char == "k" or char == "p":
            self.selected_idx = max(self.selected_idx - 1, 0)
        elif char == "g":
            self.selected_idx = 0
            self.scroll_offset = 0
        elif char == "G":
            self.selected_idx = max(0, count - 1)
        elif char == " ":
            if items and 0 <= self.selected_idx < len(items):
                item = items[self.selected_idx]
                if isinstance(item, dict) and item.get("_collapsible"):
                    sec_key = item.get("_sec_key", "")
                    if sec_key:
                        self.tree_state.toggle(sec_key)
                        return
                iid = item.get("id") if isinstance(item, dict) else None
                if iid is not None:
                    self.expanded_id = None if self.expanded_id == iid else iid
        elif key == 27:
            if self.expanded_id is not None:
                self.expanded_id = None
            elif self.reader_reading_id is not None:
                self.reader_reading_id = None
            else:
                self._switch_view("agenda")
        elif char == "\n" or char == "\r":
            self._action_enter(items)
        elif char == "r" and self.view == "programs":
            self._action_trigger(items)
        elif char == "R":
            self._action_toggle_runtime()
        elif char == "c":
            self._open_minibuffer("Capture: ", self._do_capture)
        elif char == "X":
            self._open_minibuffer("CLI> ", self._do_cli)
        elif char == "?":
            self._msg("C-x C-c:quit C-g:cancel C-n/C-p:nav Tab:sidebar/snow M-x:cmd /:srch c:cap T:theme M:multi J:capture SPC:expand/collapse")
        elif char == "d" and self.view == "reader":
            self._action_delete_reader(items)
        elif char == "r" and self.view == "snow":
            self._msg("Refreshing SNOW...")
            threading.Thread(target=self._refresh_snow, daemon=True).start()
        elif char == "l" and self.view == "evolution":
            idx = EVO_TABS.index(self.evo_tab) if self.evo_tab in EVO_TABS else 0
            self.evo_tab = EVO_TABS[(idx + 1) % len(EVO_TABS)]
            self.selected_idx = 0
        elif char == "u" and self.view == "reader":
            self._open_minibuffer("URL: ", self._do_add_reader)

    def _action_enter(self, items):
        if not items or self.selected_idx >= len(items):
            return
        item = items[self.selected_idx]
        if not isinstance(item, dict) or "_section" in item:
            if isinstance(item, dict) and item.get("_collapsible"):
                sec_key = item.get("_sec_key", "")
                if sec_key:
                    self.tree_state.toggle(sec_key)
            return
        if self.view == "programs":
            pid = item.get("id")
            if pid:
                try:
                    self.api.toggle_program(pid)
                    self._msg("Toggled: " + item.get("name", ""))
                except APIError as e:
                    self._msg("Error: " + str(e))
        elif self.view == "agenda":
            if item.get("status"):
                try:
                    self.api.toggle_task(item["id"])
                    self._msg("Toggled: " + item.get("title", ""))
                except APIError as e:
                    self._msg("Error: " + str(e))
            else:
                self.expanded_id = None if self.expanded_id == item.get("id") else item.get("id")
        elif self.view in ("results", "transcripts", "snow", "evolution"):
            self.expanded_id = None if self.expanded_id == item.get("id") else item.get("id")
        elif self.view == "reader":
            rid = item.get("id")
            if rid:
                self.reader_reading_id = rid
                if self.wm and any(MEDIA_CAPS.values()):
                    img_url = item.get("imageUrl") or item.get("thumbnailUrl")
                    if img_url:
                        self._msg("Media rendering: " + ", ".join(k for k, v in MEDIA_CAPS.items() if v))
        elif self.view == "cockpit":
            self.expanded_id = None if self.expanded_id == id(item) else id(item)

    def _action_trigger(self, items):
        if not items or self.selected_idx >= len(items):
            return
        item = items[self.selected_idx]
        if isinstance(item, dict) and item.get("id"):
            try:
                self.api.trigger_program(item["id"])
                self._msg("Triggered: " + item.get("name", ""))
            except APIError as e:
                self._msg("Error: " + str(e))

    def _action_toggle_runtime(self):
        try:
            result = self.api.toggle_runtime()
            self._msg("Runtime: " + ("ON" if result.get("active") else "OFF"))
        except APIError as e:
            self._msg("Error: " + str(e))

    def _action_delete_reader(self, items):
        if not items or self.selected_idx >= len(items):
            return
        item = items[self.selected_idx]
        if isinstance(item, dict) and item.get("id"):
            try:
                self.api.delete_reader_page(item["id"])
                self._msg("Deleted reader page")
            except APIError as e:
                self._msg("Error: " + str(e))

    def _action_accept(self, items):
        if not items or self.selected_idx >= len(items):
            return
        item = items[self.selected_idx]
        if isinstance(item, dict) and item.get("id"):
            try:
                self.api.accept_proposal(item["id"])
                self._msg("Accepted proposal #" + str(item["id"]))
            except APIError as e:
                self._msg("Error: " + str(e))

    def _action_reject(self, items):
        if not items or self.selected_idx >= len(items):
            return
        item = items[self.selected_idx]
        if isinstance(item, dict) and item.get("id"):
            try:
                self.api.reject_proposal(item["id"])
                self._msg("Rejected proposal #" + str(item["id"]))
            except APIError as e:
                self._msg("Error: " + str(e))

    def _open_minibuffer(self, prompt: str, callback):
        self.minibuffer_callback = callback
        if self.wm and self.wm.open_reader(prompt, self.stdp):
            self.nc_reader_active = True
            return
        self.minibuffer_active = True
        self.minibuffer_text = ""
        self.minibuffer_prompt = prompt
        self.minibuffer_hist_idx = -1

    def _close_minibuffer(self):
        if self.nc_reader_active and self.wm:
            self.wm.close_reader()
            self.nc_reader_active = False
        self.minibuffer_active = False
        self.minibuffer_text = ""
        self.minibuffer_prompt = ""
        self.minibuffer_callback = None

    def _handle_minibuffer(self, key):
        if key == 7:
            self._close_minibuffer()
            self._msg("Quit")
        elif key == 27:
            self._close_minibuffer()
        elif key in (10, 13):
            cb = self.minibuffer_callback
            text = self.minibuffer_text
            if text:
                self.minibuffer_history.append(text)
            self._close_minibuffer()
            if cb and text:
                cb(text)
        elif key in (127, 263):
            self.minibuffer_text = self.minibuffer_text[:-1]
        elif key == 11:
            self.minibuffer_text = ""
        elif key == 16 and self.minibuffer_history:
            if self.minibuffer_hist_idx < 0:
                self.minibuffer_hist_idx = len(self.minibuffer_history) - 1
            else:
                self.minibuffer_hist_idx = max(0, self.minibuffer_hist_idx - 1)
            self.minibuffer_text = self.minibuffer_history[self.minibuffer_hist_idx]
        elif key == 14 and self.minibuffer_hist_idx >= 0:
            self.minibuffer_hist_idx = min(len(self.minibuffer_history) - 1,
                                            self.minibuffer_hist_idx + 1)
            self.minibuffer_text = self.minibuffer_history[self.minibuffer_hist_idx]
        else:
            char = chr(key) if 0 < key < 0x110000 else ""
            if char and char.isprintable():
                self.minibuffer_text += char

    def _open_command_palette(self):
        self.palette_filter = ""
        self.palette_idx = 0
        if self.wm:
            items = [(cmd, desc) for cmd, desc in PALETTE_ALL_CMDS]
            sel = self.wm.create_selector(items, title="M-x (type to filter)")
            if sel:
                self.nc_selector_active = True
                self.command_palette_active = True
                return
        self.command_palette_active = True

    def _refresh_snow(self):
        try:
            self.api.snow_refresh()
            time.sleep(2)
            records = self.api.snow_records()
            with self.data_lock:
                self.data_cache["snow_records"] = records
                self.data_cache.pop("snow_queue", None)
            self._msg("SNOW refreshed: " + str(len(records)) + " records")
        except APIError as e:
            self._msg("SNOW refresh error: " + str(e))
        except (ConnectionError, TimeoutError, OSError) as e:
            self._msg("SNOW network error: " + str(e))

    def _open_snow_tab_selector(self):
        tab_labels = {"my-queue": "My Queue", "team": "Team Workload", "aging": "Aging / SLA Risk"}
        if self.wm:
            items = [(tab, tab_labels.get(tab, tab)) for tab in SNOW_TABS]
            sel = self.wm.create_selector(items, title="SNOW Tab")
            if sel:
                self.nc_selector_active = True
                self._snow_selector_active = True
                return
        idx = SNOW_TABS.index(self.snow_tab) if self.snow_tab in SNOW_TABS else 0
        self.snow_tab = SNOW_TABS[(idx + 1) % len(SNOW_TABS)]
        self.selected_idx = 0
        self._msg("SNOW: " + self.snow_tab)

    def _open_multiselector(self):
        programs = self.data_cache.get("programs", [])
        if not programs:
            self._msg("No programs loaded")
            return
        self._multiselector_programs = list(programs)
        if self.wm:
            items = [(p.get("name", "?"), "id:" + str(p.get("id", "")), p.get("enabled", False))
                     for p in programs]
            msel = self.wm.create_multiselector(items, title="Toggle Programs (Enter to apply)")
            if msel:
                self.nc_multiselector_active = True
                self._msg("Select programs, Enter to apply bulk toggle")
                return
        self._msg("NcMultiSelector not available")
        self._multiselector_programs = []

    def _handle_palette(self, key):
        if key == 7 or key == 27:
            self.command_palette_active = False
            self.palette_filter = ""
            return
        commands = self._filtered_palette()
        char = chr(key) if 0 < key < 0x110000 else ""
        if key == 14 or char == "j":
            self.palette_idx = min(self.palette_idx + 1, max(0, len(commands) - 1))
        elif key == 16 or char == "k":
            self.palette_idx = max(self.palette_idx - 1, 0)
        elif key in (10, 13):
            if 0 <= self.palette_idx < len(commands):
                cmd = commands[self.palette_idx][0]
                self.command_palette_active = False
                self.palette_filter = ""
                self._do_command(cmd)
        elif key in (127, 263):
            self.palette_filter = self.palette_filter[:-1]
            self.palette_idx = 0
        elif char and char.isprintable():
            self.palette_filter += char
            self.palette_idx = 0

    def _filtered_palette(self):
        if self.palette_filter:
            return [(c, d) for c, d in PALETTE_ALL_CMDS
                    if _fuzzy_match(self.palette_filter, c) or
                       _fuzzy_match(self.palette_filter, d)]
        return PALETTE_ALL_CMDS

    def _do_search(self, query: str):
        if not query.strip():
            return
        try:
            results = self.api.search(query)
            self._msg("Found " + str(len(results)) + " results for: " + query)
        except APIError as e:
            self._msg("Search error: " + str(e))

    def _do_capture(self, text: str):
        if not text.strip():
            return
        try:
            self.api.smart_capture(text)
            self._msg("Captured: " + text[:40])
        except APIError as e:
            self._msg("Capture error: " + str(e))

    def _do_cli(self, command: str):
        if not command.strip():
            return
        try:
            result = self.api.cli_execute(command)
            output = result.get("output", result.get("result", ""))
            self._msg(str(output)[:120])
        except APIError as e:
            self._msg("CLI error: " + str(e))

    def _do_journal(self, text: str):
        if not text.strip():
            return
        try:
            self.api.smart_capture(text)
            self._msg("Captured: " + text[:40])
        except APIError as e:
            self._msg("Journal error: " + str(e))

    def _do_add_reader(self, url: str):
        if not url.strip():
            return
        try:
            self.api.create_reader_page(url)
            self._msg("Added: " + url[:50])
        except APIError as e:
            self._msg("Reader error: " + str(e))

    def _do_command(self, cmd: str):
        if not cmd:
            return
        parts = cmd.strip().split(None, 1)
        verb = parts[0].lower() if parts else ""
        arg = parts[1] if len(parts) > 1 else ""
        if verb in ("quit", "q"):
            self.running = False
        elif verb == "theme":
            if arg and arg in THEMES:
                self.theme.set_theme(arg)
            else:
                self.theme.next_theme()
            self._msg("Theme: " + self.theme.current["name"])
        elif verb == "view" and arg in VIEWS:
            self._switch_view(arg)
        elif verb in ("runtime-toggle", "rt"):
            self._action_toggle_runtime()
        elif verb == "refresh":
            threading.Thread(target=self._refresh_data, daemon=True).start()
            self._msg("Refreshing...")
        elif verb == "consolidate":
            try:
                self.api.evolution_consolidate()
                self._msg("Consolidation triggered")
            except APIError as e:
                self._msg("Error: " + str(e))
        elif verb in ("capture", "cap"):
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
        elif verb == "multi-select":
            self._open_multiselector()
        elif verb == "journal":
            if arg:
                self._do_journal(arg)
            else:
                self._open_minibuffer("Journal: ", self._do_journal)
        elif verb == "reader-add":
            if arg:
                self._do_add_reader(arg)
            else:
                self._open_minibuffer("URL: ", self._do_add_reader)
        elif verb == "help":
            self._msg("C-x C-c:quit C-g:cancel C-n/C-p:nav Tab:sidebar/snow M-x:cmd /:search c:cap T:theme M:multi J:journal SPC:expand/collapse")
        else:
            self._do_cli(cmd)

    def _render_nc(self):
        self._render_header()
        if self.sidebar_visible and self.sidebar_plane:
            self._render_sidebar()
        if self.main_plane:
            if self.view == "cockpit" and self.wm and self.wm.reel:
                self._render_cockpit_main()
            else:
                self._render_main()
        self._render_modeline()
        if not self.nc_reader_active:
            self._render_minibuffer()
        if self.command_palette_active and not self.nc_selector_active and self.palette_plane:
            self._render_palette()
            self.palette_plane.move_above(self.main_plane)
        elif self.palette_plane and not self.nc_selector_active:
            self.palette_plane.move_below(self.stdp)

    def _render_header(self):
        p = self.header_plane
        if not p:
            return
        _, cols = p.dim_yx()
        p.erase()
        self._set_bg(p, "header_bg")
        self._set_fg(p, "header_fg")
        p.putstr_yx(0, 0, " " * cols)
        p.putstr_yx(0, 0, " RACHAEL")
        view_label = " " + self.view.upper() + " "
        p.putstr_yx(0, max(0, cols - len(view_label)), view_label)
        ctrl = self.data_cache.get("control", {})
        mode = ctrl.get("mode", "human")
        sse = "\u25CF" if self.cockpit_connected else "\u25CB"
        mid_label = sse + " [" + mode.upper() + "]"
        mid = cols // 2 - len(mid_label) // 2
        if mid > 10:
            p.putstr_yx(0, mid, mid_label)

    def _render_sidebar(self):
        p = self.sidebar_plane
        if not p:
            return
        rows, cols = p.dim_yx()
        p.erase()
        self._set_bg(p, "bg")
        self._set_fg(p, "dim")
        p.putstr_yx(0, 1, "VIEWS")
        for i, v in enumerate(VIEWS):
            y = 1 + i
            if y >= rows - 1:
                break
            is_active = v == self.view
            num = str(i + 1) if i < 9 else "0"
            prefix = "\u25B6 " if is_active else "  "
            label = num + " " + v
            self._set_fg(p, "accent" if is_active else "fg")
            p.putstr_yx(y, 1, (prefix + label)[:cols - 2])
        info_y = len(VIEWS) + 2
        if info_y < rows - 6:
            self._set_fg(p, "dim")
            p.putstr_yx(info_y, 1, "\u2500" * (cols - 2))
            runtime = self.data_cache.get("runtime", {})
            rt_on = runtime.get("active", False)
            self._set_fg(p, "success" if rt_on else "error")
            p.putstr_yx(info_y + 1, 1, ("Runtime: " + ("ON" if rt_on else "OFF"))[:cols - 2])
            budget = self.data_cache.get("budget", {})
            spent = budget.get("spent", 0)
            cap = budget.get("dailyCap", 0)
            self._set_fg(p, "dim")
            bstr = "$" + str(round(spent, 2)) + "/" + str(round(cap, 2))
            p.putstr_yx(info_y + 2, 1, ("Budget: " + bstr)[:cols - 2])
            ctrl = self.data_cache.get("control", {})
            mode = ctrl.get("mode", "human")
            self._set_fg(p, "info" if mode == "agent" else "warn")
            if info_y + 3 < rows:
                p.putstr_yx(info_y + 3, 1, ("Mode: " + mode.upper())[:cols - 2])
            if self.sparkline_data and info_y + 4 < rows - 1:
                self._set_fg(p, "accent")
                spark = braille_sparkline_str(list(self.sparkline_data)[-min(cols - 4, 20):])
                p.putstr_yx(info_y + 4, 1, spark[:cols - 3])
        for y in range(rows):
            self._set_fg(p, "border")
            p.putstr_yx(y, cols - 1, "\u2502")

    def _render_cockpit_main(self):
        p = self.main_plane
        if not p:
            return
        rows, cols = p.dim_yx()
        self._set_fg(p, "accent")
        title = "COCKPIT (" + str(len(self.cockpit_events)) + " events)"
        p.putstr_yx(0, 1, title[:cols - 2])
        conn = "\u25CF CONNECTED" if self.cockpit_connected else "\u25CB DISCONNECTED"
        self._set_fg(p, "success" if self.cockpit_connected else "error")
        p.putstr_yx(0, max(0, cols - len(conn) - 1), conn[:cols])
        if self.sparkline_data and rows > 6:
            grid = activity_density_grid(list(self.sparkline_data), width=min(20, cols - 4), height=3)
            self._set_fg(p, "dim")
            for gi, gline in enumerate(grid):
                if rows - 4 + gi < rows:
                    p.putstr_yx(rows - 4 + gi, 1, gline[:cols - 2])

    def _render_main(self):
        p = self.main_plane
        if not p:
            return
        rows, cols = p.dim_yx()
        p.erase()
        self._set_bg(p, "bg")
        if self.view == "reader" and self.reader_reading_id:
            self._render_reader_content(p, rows, cols)
            return
        with self.data_lock:
            items = current_items(self.view, self.data_cache, self.api,
                                  self.evo_tab, self.reader_reading_id, self.cockpit_events,
                                  self.tree_state, self.snow_tab)
        view_height = rows - 1
        if view_height < 1:
            return
        if self.selected_idx >= self.scroll_offset + view_height:
            self.scroll_offset = self.selected_idx - view_height + 1
        if self.selected_idx < self.scroll_offset:
            self.scroll_offset = self.selected_idx
        self._set_fg(p, "dim")
        title = self.view.upper()
        if items:
            title += " (" + str(len(items)) + ")"
        if self.view == "evolution":
            title += " [" + self.evo_tab + "] (l:cycle)"
        if self.view == "snow":
            title += " [" + self.snow_tab + "] (Tab:cycle)"
        p.putstr_yx(0, 1, title[:cols - 2])
        y = 1
        for i in range(self.scroll_offset, len(items)):
            if y >= rows:
                break
            item = items[i]
            is_sel = i == self.selected_idx
            is_exp = isinstance(item, dict) and item.get("id") == self.expanded_id
            is_collapsible = isinstance(item, dict) and item.get("_collapsible")
            if is_sel:
                self._set_bg(p, "sel_bg")
                self._set_fg(p, "sel_fg")
            elif isinstance(item, dict) and "_section" in item:
                self._set_fg(p, "accent")
                self._set_bg(p, "bg")
            elif isinstance(item, dict) and item.get("status") == "error":
                self._set_fg(p, "error")
                self._set_bg(p, "bg")
            elif self._is_new(item):
                self._pulse_fg(p, item)
                self._set_bg(p, "bg")
            else:
                self._set_fg(p, "fg")
                self._set_bg(p, "bg")
            line = format_item(item, cols - 2, self.view, self.data_cache)
            p.putstr_yx(y, 1, line.ljust(cols - 2)[:cols - 2])
            self._set_bg(p, "bg")
            y += 1
            if is_exp and isinstance(item, dict):
                details = format_detail(item, cols - 4, self.view, self.data_cache)
                for dl in details:
                    if y >= rows:
                        break
                    self._set_fg(p, "dim")
                    self._set_bg(p, "bg")
                    p.putstr_yx(y, 3, dl[:cols - 4])
                    y += 1

    def _render_reader_content(self, p, rows, cols):
        pages = self.data_cache.get("reader", [])
        page = None
        for pg in pages:
            if pg.get("id") == self.reader_reading_id:
                page = pg
                break
        if not page:
            try:
                page = self.api.reader_page(self.reader_reading_id)
            except (APIError, ConnectionError, TimeoutError):
                pass
        if not page:
            self._set_fg(p, "error")
            p.putstr_yx(1, 1, "Page not found")
            return
        self._set_fg(p, "accent")
        p.putstr_yx(0, 1, page.get("title", "?")[:cols - 12])
        self._set_fg(p, "dim")
        p.putstr_yx(0, max(1, cols - 11), "[Esc:back]")
        p.putstr_yx(1, 1, (page.get("domain", "") + " \u2014 " + page.get("url", ""))[:cols - 2])
        if self.wm and any(MEDIA_CAPS.values()):
            media_line = "[Media: " + ", ".join(k for k, v in MEDIA_CAPS.items() if v) + "]"
            self._set_fg(p, "success")
            p.putstr_yx(2, 1, media_line[:cols - 2])
            img_url = page.get("imageUrl") or page.get("thumbnailUrl") or page.get("ogImage")
            if img_url:
                local_path = None
                if os.path.exists(str(img_url)):
                    local_path = str(img_url)
                elif str(img_url).startswith("http"):
                    local_path = self.wm.download_and_cache_image(str(img_url))
                if local_path:
                    rendered = self.wm.render_visual_media(
                        p, local_path, 3, 1, min(8, rows - 6), min(30, cols - 4))
                    if not rendered:
                        self._set_fg(p, "dim")
                        p.putstr_yx(3, 1, "[Image: " + str(img_url)[:cols - 12] + "]")
        text = page.get("extractedText", "")
        y = 4 if any(MEDIA_CAPS.values()) else 3
        for line in wrap_text(text, cols - 2):
            if y >= rows:
                break
            self._set_fg(p, "fg")
            p.putstr_yx(y, 1, line[:cols - 2])
            y += 1

    def _render_modeline(self):
        p = self.modeline_plane
        if not p:
            return
        _, cols = p.dim_yx()
        p.erase()
        self._set_bg(p, "mode_line_bg")
        self._set_fg(p, "mode_line_fg")
        p.putstr_yx(0, 0, " " * cols)
        left = " " + self.view.upper()
        runtime = self.data_cache.get("runtime", {})
        rt = "ON" if runtime.get("active") else "OFF"
        t_name = self.theme.current["name"]
        age = str(int(time.time() - self.last_refresh)) + "s" if self.last_refresh > 0 else ""
        sb = "SB" if self.sidebar_visible else "  "
        right = t_name + " | RT:" + rt + " | " + sb + " | " + age + " "
        pad = max(0, cols - len(left) - len(right))
        p.putstr_yx(0, 0, left + " " * pad + right)

    def _render_minibuffer(self):
        p = self.minibuffer_plane
        if not p:
            return
        _, cols = p.dim_yx()
        p.erase()
        self._set_bg(p, "mini_bg")
        self._set_fg(p, "mini_fg")
        p.putstr_yx(0, 0, " " * cols)
        if self.minibuffer_active:
            text = self.minibuffer_prompt + self.minibuffer_text + "\u2588"
        elif self.ctrl_x_pending:
            text = "C-x-"
        elif self.message and time.time() - self.message_time < 5:
            text = self.message
        else:
            text = ""
        p.putstr_yx(0, 0, text[:cols])

    def _render_palette(self):
        p = self.palette_plane
        if not p:
            return
        rows, cols = p.dim_yx()
        p.erase()
        self._set_bg(p, "bg")
        self._set_fg(p, "border")
        p.putstr_yx(0, 0, "\u250C" + "\u2500" * (cols - 2) + "\u2510")
        for y in range(1, rows - 1):
            p.putstr_yx(y, 0, "\u2502")
            self._set_bg(p, "bg")
            p.putstr_yx(y, 1, " " * (cols - 2))
            self._set_fg(p, "border")
            p.putstr_yx(y, cols - 1, "\u2502")
        p.putstr_yx(rows - 1, 0, "\u2514" + "\u2500" * (cols - 2) + "\u2518")
        self._set_fg(p, "accent")
        p.putstr_yx(0, 2, " M-x ")
        self._set_fg(p, "fg")
        p.putstr_yx(1, 2, ("Filter: " + self.palette_filter + "\u2588")[:cols - 4])
        commands = self._filtered_palette()
        for i, (cmd, desc) in enumerate(commands):
            yy = 2 + i
            if yy >= rows - 1:
                break
            if i == self.palette_idx:
                self._set_bg(p, "sel_bg")
                self._set_fg(p, "sel_fg")
            else:
                self._set_fg(p, "fg")
                self._set_bg(p, "bg")
            p.putstr_yx(yy, 1, (" " + cmd).ljust(cols - 2)[:cols - 2])
        self._set_bg(p, "bg")

    def _run_fallback(self):
        import curses as _curses
        _curses.wrapper(lambda stdscr: CursesFallback(self, stdscr, _curses).run())


class CursesFallback:
    def __init__(self, tui: RachaelTUI, stdscr, curses):
        self.tui = tui
        self.stdscr = stdscr
        self.curses = curses

    def run(self):
        curses = self.curses
        stdscr = self.stdscr
        tui = self.tui
        curses.curs_set(0)
        curses.start_color()
        curses.use_default_colors()
        self._init_colors()
        tui.running = True
        tui._start_background()
        stdscr.timeout(100)
        self._splash()
        while tui.running:
            tui.dims = stdscr.getmaxyx()
            self._render()
            try:
                ch = stdscr.get_wch()
            except curses.error:
                continue
            except KeyboardInterrupt:
                break
            self._handle_input(ch)
        tui.api.stop_sse()
        tui.api.stop()

    def _init_colors(self):
        t = self.tui.theme.current
        curses = self.curses
        pairs = [
            (1, t["fg"], t["bg"]), (2, t["dim"], t["bg"]),
            (3, t["accent"], t["bg"]), (4, t["error"], t["bg"]),
            (5, t["warn"], t["bg"]), (6, t["success"], t["bg"]),
            (7, t["header_fg"], t["header_bg"]), (8, t["sel_fg"], t["sel_bg"]),
            (9, t["mode_line_fg"], t["mode_line_bg"]),
            (10, t["mini_fg"], t["mini_bg"]),
            (11, t["info"], t["bg"]), (12, t["border"], t["bg"]),
        ]
        for idx, fg_hex, bg_hex in pairs:
            try:
                fg_id = 16 + idx * 2
                bg_id = 17 + idx * 2
                curses.init_color(fg_id, ((fg_hex >> 16) & 0xFF) * 1000 // 255,
                                  ((fg_hex >> 8) & 0xFF) * 1000 // 255,
                                  (fg_hex & 0xFF) * 1000 // 255)
                curses.init_color(bg_id, ((bg_hex >> 16) & 0xFF) * 1000 // 255,
                                  ((bg_hex >> 8) & 0xFF) * 1000 // 255,
                                  (bg_hex & 0xFF) * 1000 // 255)
                curses.init_pair(idx, fg_id, bg_id)
            except curses.error:
                curses.init_pair(idx, curses.COLOR_GREEN, curses.COLOR_BLACK)

    def _splash(self):
        rows, cols = self.stdscr.getmaxyx()
        self.stdscr.clear()
        for i, line in enumerate(LOGO):
            y = rows // 2 - len(LOGO) // 2 + i - 2
            x = max(0, (cols - len(line)) // 2)
            if 0 <= y < rows - 1:
                try:
                    self.stdscr.addnstr(y, x, line, cols - x, self.curses.color_pair(3))
                except self.curses.error:
                    pass
        self.stdscr.refresh()
        self.stdscr.timeout(-1)
        self.stdscr.getch()
        self.stdscr.timeout(100)

    def _handle_input(self, ch):
        tui = self.tui
        curses = self.curses
        if isinstance(ch, int):
            if ch == 24:
                tui.ctrl_x_pending = True
                tui._msg("C-x-")
                return
            if tui.ctrl_x_pending:
                tui.ctrl_x_pending = False
                char = chr(ch) if 0 < ch < 128 else ""
                if ch == 3 or char == "c":
                    tui.running = False
                elif char == "b" or ch == 2:
                    tui._open_command_palette()
                return
            if ch == 7:
                if tui.minibuffer_active:
                    tui._close_minibuffer()
                elif tui.command_palette_active:
                    tui.command_palette_active = False
                    tui.palette_filter = ""
                else:
                    tui._msg("Quit")
                return
            if ch == 14:
                if tui.command_palette_active:
                    tui.palette_idx = min(tui.palette_idx + 1, max(0, len(tui._filtered_palette()) - 1))
                else:
                    tui._nav_down()
                return
            if ch == 16:
                if tui.command_palette_active:
                    tui.palette_idx = max(tui.palette_idx - 1, 0)
                else:
                    tui._nav_up()
                return
            if ch == 19:
                tui._open_minibuffer("I-search: ", tui._do_search)
                return
            if ch == 12:
                threading.Thread(target=tui._refresh_data, daemon=True).start()
                tui._msg("Refreshing...")
                return
            if ch == 9:
                if tui.view == "snow":
                    tui._open_snow_tab_selector()
                else:
                    tui.sidebar_visible = not tui.sidebar_visible
                return
            if ch == 27:
                self.stdscr.timeout(50)
                try:
                    ch2 = self.stdscr.get_wch()
                except curses.error:
                    ch2 = None
                self.stdscr.timeout(100)
                if ch2 == "x" or ch2 == ord("x"):
                    tui._open_command_palette()
                    return
                if ch2 is None:
                    if tui.minibuffer_active:
                        tui._close_minibuffer()
                    elif tui.command_palette_active:
                        tui.command_palette_active = False
                        tui.palette_filter = ""
                    elif tui.expanded_id is not None:
                        tui.expanded_id = None
                    elif tui.reader_reading_id is not None:
                        tui.reader_reading_id = None
                    else:
                        tui._switch_view("agenda")
                return
            char = chr(ch) if 0 < ch < 128 else ""
        else:
            char = str(ch)

        if tui.minibuffer_active:
            if isinstance(ch, int):
                tui._handle_minibuffer(ch)
            elif char and len(char) == 1 and char.isprintable():
                tui.minibuffer_text += char
            return
        if tui.command_palette_active:
            if isinstance(ch, int):
                tui._handle_palette(ch)
            elif char and len(char) == 1 and char.isprintable():
                tui.palette_filter += char
                tui.palette_idx = 0
            return
        if char == "q":
            tui.running = False
        elif char in VIEW_KEYS:
            tui._switch_view(VIEW_KEYS[char])
        elif char == "T":
            tui.theme.next_theme()
            self._init_colors()
            tui._msg("Theme: " + tui.theme.current["name"])
        elif char == "/":
            tui._open_minibuffer("Search: ", tui._do_search)
        elif char == ":":
            tui._open_minibuffer("M-x ", tui._do_command)
        elif char == "M":
            tui._open_multiselector()
        elif char == "J":
            tui._open_minibuffer("Journal: ", tui._do_journal)
        else:
            key_int = ch if isinstance(ch, int) else 0
            tui._handle_view_keys(char, key_int)

    def _render(self):
        tui = self.tui
        curses = self.curses
        stdscr = self.stdscr
        rows, cols = tui.dims
        stdscr.erase()
        header = " RACHAEL"
        right = tui.view.upper() + " "
        pad = max(0, cols - len(header) - len(right))
        try:
            stdscr.addnstr(0, 0, (header + " " * pad + right)[:cols], cols, curses.color_pair(7))
        except curses.error:
            pass
        top = 1
        bottom = rows - 2
        if tui.sidebar_visible:
            sw = min(tui.sidebar_width, cols - 10)
            if sw >= 5:
                for y in range(top, min(bottom + 1, rows)):
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
                    is_active = v == tui.view
                    num = str(i + 1) if i < 9 else "0"
                    prefix = "> " if is_active else "  "
                    cp = curses.color_pair(3) if is_active else curses.color_pair(1)
                    try:
                        stdscr.addnstr(y, 1, (prefix + num + " " + v)[:sw - 1], sw - 1, cp)
                    except curses.error:
                        pass
            main_left = tui.sidebar_width + 1
        else:
            main_left = 0
        main_w = cols - main_left
        if main_w > 2:
            with tui.data_lock:
                items = current_items(tui.view, tui.data_cache, tui.api,
                                      tui.evo_tab, tui.reader_reading_id, tui.cockpit_events,
                                      tui.tree_state, tui.snow_tab)
            vh = bottom - top
            if vh > 0:
                if tui.selected_idx >= tui.scroll_offset + vh:
                    tui.scroll_offset = tui.selected_idx - vh + 1
                if tui.selected_idx < tui.scroll_offset:
                    tui.scroll_offset = tui.selected_idx
                title = tui.view.upper()
                if items:
                    title += " (" + str(len(items)) + ")"
                if tui.view == "snow":
                    title += " [" + tui.snow_tab + "]"
                try:
                    stdscr.addnstr(top, main_left + 1, title[:main_w - 2], main_w - 2, curses.color_pair(2))
                except curses.error:
                    pass
                y = top + 1
                for i in range(tui.scroll_offset, len(items)):
                    if y >= bottom:
                        break
                    item = items[i]
                    is_sel = i == tui.selected_idx
                    line = format_item(item, main_w - 2, tui.view, tui.data_cache)
                    if is_sel:
                        cp = curses.color_pair(8)
                    elif isinstance(item, dict) and "_section" in item:
                        cp = curses.color_pair(3)
                    else:
                        cp = curses.color_pair(1)
                    try:
                        stdscr.addnstr(y, main_left + 1, line.ljust(main_w - 2)[:main_w - 2],
                                       main_w - 2, cp)
                    except curses.error:
                        pass
                    y += 1
                    is_exp = isinstance(item, dict) and item.get("id") == tui.expanded_id
                    if is_exp and isinstance(item, dict):
                        details = format_detail(item, main_w - 4, tui.view, tui.data_cache)
                        for dl in details:
                            if y >= bottom:
                                break
                            try:
                                stdscr.addnstr(y, main_left + 3, dl[:main_w - 4],
                                               main_w - 4, curses.color_pair(2))
                            except curses.error:
                                pass
                            y += 1
        left = " " + tui.view.upper()
        rt = "ON" if tui.data_cache.get("runtime", {}).get("active") else "OFF"
        age = str(int(time.time() - tui.last_refresh)) + "s" if tui.last_refresh > 0 else ""
        ml_right = tui.theme.current["name"] + " | RT:" + rt + " | " + age + " "
        ml_pad = max(0, cols - len(left) - len(ml_right))
        try:
            stdscr.addnstr(rows - 2, 0, (left + " " * ml_pad + ml_right)[:cols], cols,
                           curses.color_pair(9))
        except curses.error:
            pass
        if tui.minibuffer_active:
            mb = tui.minibuffer_prompt + tui.minibuffer_text + "_"
        elif tui.ctrl_x_pending:
            mb = "C-x-"
        elif tui.message and time.time() - tui.message_time < 5:
            mb = tui.message
        else:
            mb = ""
        try:
            stdscr.addnstr(rows - 1, 0, mb.ljust(cols)[:cols - 1], cols - 1, curses.color_pair(10))
        except curses.error:
            pass
        if tui.command_palette_active:
            commands = tui._filtered_palette()
            pw = min(54, cols - 4)
            ph = min(len(commands) + 3, rows - 4, 18)
            px = (cols - pw) // 2
            py = (rows - ph) // 2
            try:
                stdscr.addnstr(py, px, "\u250C" + "\u2500" * (pw - 2) + "\u2510", pw, curses.color_pair(12))
                for i in range(1, ph - 1):
                    stdscr.addnstr(py + i, px, "\u2502" + " " * (pw - 2) + "\u2502", pw, curses.color_pair(12))
                stdscr.addnstr(py + ph - 1, px, "\u2514" + "\u2500" * (pw - 2) + "\u2518", pw, curses.color_pair(12))
                stdscr.addnstr(py, px + 2, " M-x ", 5, curses.color_pair(3))
                filt = "Filter: " + tui.palette_filter + "_"
                stdscr.addnstr(py + 1, px + 2, filt[:pw - 4], pw - 4, curses.color_pair(1))
                for i, (cmd, desc) in enumerate(commands):
                    cy = py + 2 + i
                    if cy >= py + ph - 1:
                        break
                    cp = curses.color_pair(8) if i == tui.palette_idx else curses.color_pair(1)
                    stdscr.addnstr(cy, px + 2, cmd[:pw - 4], pw - 4, cp)
            except curses.error:
                pass
        stdscr.noutrefresh()
        curses.doupdate()


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
