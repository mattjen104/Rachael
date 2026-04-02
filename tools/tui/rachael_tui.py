#!/usr/bin/env python3
import sys
import os
import time
import threading
import traceback
import datetime
import math
from collections import deque
from typing import Optional, Callable, Any

NC_AVAILABLE = False
NcReel = None
NcReelOptions = None
NcProgbar = None
NcReader = None
NcReaderOptions = None
NcSelector = None
NcSelectorItem = None
NcMultiSelector = None
NcMultiSelectorItem = None
NcMenu = None
NcMenuItem = None
NcPlot = None
NcDPlot = None
NCALPHA_BLEND = None
NCALPHA_TRANSPARENT = None
NCBLIT_BRAILLE = None
NCBLIT_2x2 = None
NCBLIT_4x2 = None

NC_CAPS = {}

def _try_import(name, fallback=None):
    try:
        mod = __import__("notcurses", fromlist=[name])
        val = getattr(mod, name, None)
        if val is not None:
            NC_CAPS[name] = True
            return val
    except (ImportError, AttributeError):
        pass
    NC_CAPS[name] = False
    return fallback

try:
    from notcurses import Notcurses, NcInput, NcPlane
    NC_AVAILABLE = True
    NcReel = _try_import("NcReel")
    NcReelOptions = _try_import("NcReelOptions")
    NcProgbar = _try_import("NcProgbar")
    NcReader = _try_import("NcReader")
    NcReaderOptions = _try_import("NcReaderOptions")
    NcSelector = _try_import("NcSelector")
    NcSelectorItem = _try_import("NcSelectorItem")
    NcMultiSelector = _try_import("NcMultiSelector")
    NcMultiSelectorItem = _try_import("NcMultiSelectorItem")
    NcMenu = _try_import("NcMenu")
    NcMenuItem = _try_import("NcMenuItem")
    NcPlot = _try_import("NcPlot")
    NcDPlot = _try_import("NcDPlot")
    NCALPHA_BLEND = _try_import("NCALPHA_BLEND")
    NCALPHA_TRANSPARENT = _try_import("NCALPHA_TRANSPARENT")
    NCBLIT_BRAILLE = _try_import("NCBLIT_BRAILLE")
    NCBLIT_2x2 = _try_import("NCBLIT_2x2")
    NCBLIT_4x2 = _try_import("NCBLIT_4x2")
except ImportError:
    pass

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
BRAILLE_BLOCKS = ["\u2800", "\u2801", "\u2803", "\u2807", "\u280F",
                  "\u281F", "\u283F", "\u287F", "\u28FF"]
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
                 ("Toggle Runtime", "R"), ("Theme", "T")]),
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
    ("help", "Show keybinding help"),
]


class PlaneSet:
    def __init__(self):
        self.header: Any = None
        self.sidebar: Any = None
        self.main: Any = None
        self.modeline: Any = None
        self.minibuffer: Any = None
        self.palette_overlay: Any = None
        self.progbar_widget: Any = None
        self.progbar_plane: Any = None
        self.reel_widget: Any = None
        self.reel_plane: Any = None
        self.reader_widget: Any = None
        self.reader_plane: Any = None
        self.selector_widget: Any = None
        self.selector_plane: Any = None
        self.menu_widget: Any = None
        self.sparkline_widget: Any = None
        self.sparkline_plane: Any = None


class RachaelTUI:
    def __init__(self, base_url: Optional[str] = None, api_key: Optional[str] = None):
        self.api = RachaelAPI(base_url=base_url, api_key=api_key)
        self.theme = ThemeEngine()
        self.nc: Optional[Notcurses] = None
        self.stdp = None
        self.planes = PlaneSet()
        self.running = False
        self.view = "agenda"
        self.prev_view = "agenda"
        self.selected_idx = 0
        self.scroll_offset = 0
        self.expanded_id: Optional[int] = None
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
        self.reader_reading_id: Optional[int] = None
        self.evo_tab = "overview"
        self.sparkline_data: deque = deque(maxlen=60)
        self.new_item_ids: set = set()
        self.new_item_time: dict = {}
        self._reel_tablets: list = []
        self._menu_created = False
        self._nc_reader_active = False
        self._degraded_widgets: list = []
        self._cap_report_shown = False

    def run(self):
        if not NC_AVAILABLE:
            self._run_fallback()
            return
        try:
            self.nc = Notcurses()
            self.stdp = self.nc.stdplane()
            self.running = True
            self.dims = self.stdp.dim_yx()
            self._create_planes()
            self._create_nc_menu()
            self._start_background()
            self._splash_nc()
            self._main_loop()
        except Exception as e:
            self.running = False
            if self.nc:
                try:
                    self.nc.stop()
                except Exception:
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
                except Exception:
                    pass

    def _create_planes(self):
        rows, cols = self.dims
        self.planes.header = NcPlane(self.stdp, 1, cols, 0, 0)
        sb_h = max(1, rows - 3)
        self.planes.sidebar = NcPlane(self.stdp, sb_h, self.sidebar_width, 1, 0)
        main_left = self.sidebar_width + 1
        main_w = max(2, cols - main_left)
        main_h = max(1, rows - 3)
        self.planes.main = NcPlane(self.stdp, main_h, main_w, 1, main_left)
        self.planes.modeline = NcPlane(self.stdp, 1, cols, max(0, rows - 2), 0)
        self.planes.minibuffer = NcPlane(self.stdp, 1, cols, max(0, rows - 1), 0)
        pal_w = min(54, cols - 4)
        pal_h = min(18, rows - 4)
        if pal_w > 12 and pal_h > 5:
            px = (cols - pal_w) // 2
            py = (rows - pal_h) // 2
            self.planes.palette_overlay = NcPlane(self.stdp, pal_h, pal_w, py, px)
            if NCALPHA_BLEND is not None:
                try:
                    self.planes.palette_overlay.set_bg_alpha(NCALPHA_BLEND)
                except Exception:
                    pass
            self.planes.palette_overlay.move_above(self.planes.main)
        self._create_nc_progbar()
        self._create_nc_sparkline()

    def _create_nc_menu(self):
        if NcMenu is None or NcMenuItem is None or self._menu_created:
            return
        try:
            sections = []
            for sec_name, sec_items in MENU_SECTIONS:
                items = []
                for label, shortcut in sec_items:
                    items.append(NcMenuItem(label, shortcut))
                sections.append((sec_name, items))
            self.planes.menu_widget = NcMenu.create(self.nc, sections)
            self._menu_created = True
        except Exception as e:
            self._degraded_widgets.append("NcMenu (init: " + str(e)[:30] + ")")

    def _create_nc_progbar(self):
        if NcProgbar is None or self.planes.sidebar is None:
            return
        try:
            sb_rows, sb_cols = self.planes.sidebar.dim_yx()
            pb_w = max(2, sb_cols - 4)
            pb_y = min(sb_rows - 3, len(VIEWS) + 6)
            if pb_y > 0 and pb_y < sb_rows - 1:
                self.planes.progbar_plane = NcPlane(self.planes.sidebar, 1, pb_w, pb_y, 2)
                self.planes.progbar_widget = NcProgbar(self.planes.progbar_plane)
        except Exception:
            pass

    def _create_nc_sparkline(self):
        plot_cls = NcDPlot or NcPlot
        if plot_cls is None or self.planes.main is None:
            if NcPlot is None and NcDPlot is None:
                self._degraded_widgets.append("NcPlot (sparkline)")
            return
        try:
            m_rows, m_cols = self.planes.main.dim_yx()
            sp_w = min(30, m_cols - 4)
            sp_h = 4
            if sp_w > 5 and m_rows > sp_h + 2:
                self.planes.sparkline_plane = NcPlane(self.planes.main, sp_h, sp_w, 1, m_cols - sp_w - 2)
                opts = {}
                blit = NCBLIT_BRAILLE or NCBLIT_4x2 or NCBLIT_2x2
                if blit is not None:
                    opts["gridtype"] = blit
                self.planes.sparkline_widget = plot_cls.create(
                    self.planes.sparkline_plane, **opts)
        except Exception as e:
            self._degraded_widgets.append("NcPlot/NcDPlot (init: " + str(e)[:30] + ")")

    def _create_nc_reel(self):
        if NcReel is None or self.planes.main is None:
            return
        try:
            m_rows, m_cols = self.planes.main.dim_yx()
            if self.planes.reel_plane:
                try:
                    self.planes.reel_plane.destroy()
                except Exception:
                    pass
            self.planes.reel_plane = NcPlane(self.planes.main, max(1, m_rows - 2), max(2, m_cols - 2), 1, 1)
            if NcReelOptions:
                opts = NcReelOptions()
                self.planes.reel_widget = NcReel.create(self.planes.reel_plane, opts)
            else:
                self.planes.reel_widget = NcReel.create(self.planes.reel_plane)
            self._reel_tablets = []
        except Exception:
            self.planes.reel_widget = None

    def _create_nc_selector(self, items_list: list, title: str = "Select"):
        if NcSelector is None or NcSelectorItem is None:
            return None
        try:
            rows, cols = self.dims
            sel_w = min(50, cols - 6)
            sel_h = min(len(items_list) + 4, rows - 6)
            sx = (cols - sel_w) // 2
            sy = (rows - sel_h) // 2
            sel_plane = NcPlane(self.stdp, sel_h, sel_w, sy, sx)
            nc_items = []
            for label, desc in items_list:
                nc_items.append(NcSelectorItem(label, desc))
            selector = NcSelector.create(sel_plane, nc_items, title=title, maxdisplay=sel_h - 3)
            self.planes.selector_plane = sel_plane
            self.planes.selector_widget = selector
            return selector
        except Exception:
            return None

    def _create_nc_multiselector(self, items_list: list, title: str = "Select"):
        if NcMultiSelector is None or NcMultiSelectorItem is None:
            return None
        try:
            rows, cols = self.dims
            sel_w = min(50, cols - 6)
            sel_h = min(len(items_list) + 4, rows - 6)
            sx = (cols - sel_w) // 2
            sy = (rows - sel_h) // 2
            sel_plane = NcPlane(self.stdp, sel_h, sel_w, sy, sx)
            nc_items = []
            for label, desc, selected in items_list:
                nc_items.append(NcMultiSelectorItem(label, desc, selected))
            mselector = NcMultiSelector.create(sel_plane, nc_items, title=title, maxdisplay=sel_h - 3)
            self.planes.selector_plane = sel_plane
            self.planes.selector_widget = mselector
            return mselector
        except Exception:
            return None

    def _destroy_nc_selector(self):
        if self.planes.selector_widget:
            try:
                self.planes.selector_widget.destroy()
            except Exception:
                pass
            self.planes.selector_widget = None
        if self.planes.selector_plane:
            try:
                self.planes.selector_plane.destroy()
            except Exception:
                pass
            self.planes.selector_plane = None

    def _open_nc_reader(self, prompt: str):
        if NcReader is None:
            return False
        try:
            rows, cols = self.dims
            if self.planes.reader_plane:
                try:
                    self.planes.reader_plane.destroy()
                except Exception:
                    pass
            self.planes.reader_plane = NcPlane(self.stdp, 1, cols, rows - 1, 0)
            self._set_fg(self.planes.reader_plane, "mini_fg")
            self._set_bg(self.planes.reader_plane, "mini_bg")
            self.planes.reader_plane.putstr_yx(0, 0, prompt)
            if NcReaderOptions:
                opts = NcReaderOptions()
                self.planes.reader_widget = NcReader.create(self.planes.reader_plane, opts)
            else:
                self.planes.reader_widget = NcReader.create(self.planes.reader_plane)
            self._nc_reader_active = True
            return True
        except Exception:
            return False

    def _close_nc_reader(self) -> str:
        text = ""
        if self.planes.reader_widget:
            try:
                text = self.planes.reader_widget.contents() or ""
            except Exception:
                pass
            try:
                self.planes.reader_widget.destroy()
            except Exception:
                pass
            self.planes.reader_widget = None
        if self.planes.reader_plane:
            try:
                self.planes.reader_plane.destroy()
            except Exception:
                pass
            self.planes.reader_plane = None
        self._nc_reader_active = False
        return text.strip()

    def _resize_planes(self):
        rows, cols = self.dims
        try:
            if self.planes.header:
                self.planes.header.resize(1, cols)
                self.planes.header.move_yx(0, 0)
        except Exception:
            pass
        sb_h = max(1, rows - 3)
        main_left = self.sidebar_width + 1 if self.sidebar_visible else 0
        main_w = max(2, cols - main_left)
        main_h = max(1, rows - 3)
        try:
            if self.planes.sidebar:
                if self.sidebar_visible:
                    self.planes.sidebar.resize(sb_h, self.sidebar_width)
                    self.planes.sidebar.move_yx(1, 0)
                else:
                    self.planes.sidebar.move_yx(-9999, -9999)
        except Exception:
            pass
        try:
            if self.planes.main:
                self.planes.main.resize(main_h, main_w)
                self.planes.main.move_yx(1, main_left)
        except Exception:
            pass
        try:
            if self.planes.modeline:
                self.planes.modeline.resize(1, cols)
                self.planes.modeline.move_yx(max(0, rows - 2), 0)
        except Exception:
            pass
        try:
            if self.planes.minibuffer:
                self.planes.minibuffer.resize(1, cols)
                self.planes.minibuffer.move_yx(max(0, rows - 1), 0)
        except Exception:
            pass

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
        if self.planes.sparkline_widget:
            try:
                val = event.get("data", {}).get("metric")
                if val and isinstance(val, (int, float)):
                    self.sparkline_data.append(val)
                    self.planes.sparkline_widget.add_sample(val)
            except Exception:
                pass

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
        }
        for key, fn in fetches.items():
            try:
                value = fn()
                with self.data_lock:
                    old = self.data_cache.get(key)
                    self.data_cache[key] = value
                    if isinstance(value, list) and isinstance(old, list):
                        old_ids = {item.get("id") for item in old if isinstance(item, dict) and item.get("id")}
                        for item in value:
                            if isinstance(item, dict):
                                iid = item.get("id")
                                if iid and iid not in old_ids:
                                    self.new_item_ids.add(iid)
                                    self.new_item_time[iid] = time.time()
            except Exception:
                pass
        now = time.time()
        expired = [k for k, t in self.new_item_time.items() if now - t > 5]
        for k in expired:
            self.new_item_ids.discard(k)
            del self.new_item_time[k]
        if self.planes.progbar_widget:
            budget = self.data_cache.get("budget", {})
            spent = budget.get("spent", 0)
            cap = budget.get("dailyCap", 0)
            if cap > 0:
                try:
                    self.planes.progbar_widget.set_progress(min(1.0, spent / cap))
                except Exception:
                    pass
        with self.data_lock:
            self.last_refresh = time.time()

    def _msg(self, text: str):
        self.message = text
        self.message_time = time.time()

    def _is_item_new(self, item) -> bool:
        if isinstance(item, dict):
            return item.get("id") in self.new_item_ids
        return False

    def _pulse_fg(self, plane, item):
        if self._is_item_new(item):
            elapsed = time.time() - self.new_item_time.get(item.get("id"), 0)
            pulse = abs(math.sin(elapsed * 3.0))
            r0, g0, b0 = self.theme.rgb("accent")
            r1, g1, b1 = self.theme.rgb("fg")
            r = int(r0 * pulse + r1 * (1 - pulse))
            g = int(g0 * pulse + g1 * (1 - pulse))
            b = int(b0 * pulse + b1 * (1 - pulse))
            plane.set_fg_rgb8(r, g, b)
            return True
        return False

    def _check_capabilities(self):
        widget_names = [
            ("NcMenu", NcMenu),
            ("NcProgbar", NcProgbar),
            ("NcReader", NcReader),
            ("NcSelector", NcSelector),
            ("NcMultiSelector", NcMultiSelector),
            ("NcReel", NcReel),
            ("NcPlot", NcPlot),
            ("NcDPlot", NcDPlot),
            ("NCALPHA_BLEND", NCALPHA_BLEND),
            ("NCBLIT_BRAILLE", NCBLIT_BRAILLE),
            ("NCBLIT_4x2", NCBLIT_4x2),
        ]
        self._degraded_widgets = []
        for name, val in widget_names:
            if val is None:
                self._degraded_widgets.append(name)
        return self._degraded_widgets

    def _splash_nc(self):
        rows, cols = self.dims
        degraded = self._check_capabilities()
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
        scanline_y = rows // 2 + 5
        scan_text = "\u2591" * min(40, cols - 4)
        if 0 <= scanline_y < rows:
            self._set_fg(self.stdp, "border")
            self.stdp.putstr_yx(scanline_y, max(0, (cols - len(scan_text)) // 2), scan_text)
        if degraded and scanline_y + 2 < rows:
            self._set_fg(self.stdp, "warn")
            deg_text = "Degraded: " + ", ".join(degraded[:4])
            if len(degraded) > 4:
                deg_text += " +" + str(len(degraded) - 4)
            self.stdp.putstr_yx(scanline_y + 2, max(0, (cols - len(deg_text)) // 2), deg_text[:cols - 2])
            scanline_y += 1
        sub = "Press any key..."
        if scanline_y + 2 < rows:
            self._set_fg(self.stdp, "dim")
            self.stdp.putstr_yx(scanline_y + 2, max(0, (cols - len(sub)) // 2), sub)
        self.nc.render()
        try:
            self.stdp.fadein(600)
        except Exception:
            pass
        self.nc.render()
        ni = NcInput()
        self.nc.get(ni)
        try:
            self.stdp.fadeout(300)
        except Exception:
            pass

    def _main_loop(self):
        ni = NcInput()
        while self.running:
            new_dims = self.stdp.dim_yx()
            if new_dims != self.dims:
                self.dims = new_dims
                self._resize_planes()
            self._render_nc()
            self.nc.render()
            key = self.nc.get_nblock(ni)
            if key is None or key == 0:
                time.sleep(0.016)
                continue
            self._handle_input_nc(key, ni)

    def _set_fg(self, plane, color_key: str):
        r, g, b = self.theme.rgb(color_key)
        plane.set_fg_rgb8(r, g, b)

    def _set_bg(self, plane, color_key: str):
        r, g, b = self.theme.rgb(color_key)
        plane.set_bg_rgb8(r, g, b)

    def _handle_input_nc(self, key, ni):
        if self._nc_reader_active and self.planes.reader_widget:
            if key == 7:
                self._close_nc_reader()
                self._msg("Quit")
                return
            if key == 27:
                self._close_nc_reader()
                return
            if key == 10 or key == 13:
                text = self._close_nc_reader()
                cb = self.minibuffer_callback
                if cb and text:
                    self.minibuffer_history.append(text)
                    cb(text)
                return
            try:
                self.planes.reader_widget.offer_input(ni)
            except Exception:
                pass
            return

        if self.planes.selector_widget:
            if key == 7 or key == 27:
                self._destroy_nc_selector()
                self.command_palette_active = False
                return
            if key == 10 or key == 13:
                try:
                    selected = self.planes.selector_widget.selected()
                    self._destroy_nc_selector()
                    self.command_palette_active = False
                    if selected:
                        self._do_command(selected)
                except Exception:
                    self._destroy_nc_selector()
                    self.command_palette_active = False
                return
            try:
                self.planes.selector_widget.offer_input(ni)
            except Exception:
                pass
            return

        if self.ctrl_x_pending:
            self.ctrl_x_pending = False
            char = chr(key) if 0 < key < 0x110000 else ""
            if key == 3 or char == "c":
                self.running = False
                return
            if char == "b" or key == 2:
                self._open_command_palette()
                return
            return

        if self.minibuffer_active:
            self._handle_minibuffer_nc(key, ni)
            return

        if self.command_palette_active:
            self._handle_palette_nc(key, ni)
            return

        char = chr(key) if 0 < key < 0x110000 else ""

        if key == 24:
            self.ctrl_x_pending = True
            self._msg("C-x-")
            return
        if key == 7:
            self._msg("Quit")
            return
        if key == 19:
            self._open_minibuffer("I-search: ", self._do_search)
            return
        if key == 12:
            threading.Thread(target=self._refresh_data, daemon=True).start()
            self._msg("Refreshing...")
            return
        if key == 14:
            self._navigate_down()
            return
        if key == 16:
            self._navigate_up()
            return
        if ni.alt and char == "x":
            self._open_command_palette()
            return
        if char == "\t":
            self.sidebar_visible = not self.sidebar_visible
            self._resize_planes()
            return
        if char == "q":
            self.running = False
            return
        if char in VIEW_KEYS:
            self._switch_view(VIEW_KEYS[char])
            return
        if char == "T":
            self.theme.next_theme()
            self._msg("Theme: " + self.theme.current["name"])
            return
        if char == "/":
            self._open_minibuffer("Search: ", self._do_search)
            return
        if char == ":":
            self._open_minibuffer("M-x ", self._do_command)
            return
        self._handle_view_keys(char, key)

    def _navigate_down(self):
        with self.data_lock:
            items = self._current_items()
        count = len(items) if items else 0
        self.selected_idx = min(self.selected_idx + 1, max(0, count - 1))

    def _navigate_up(self):
        self.selected_idx = max(self.selected_idx - 1, 0)

    def _switch_view(self, new_view: str):
        if new_view == self.view:
            return
        self.prev_view = self.view
        if self.planes.main:
            try:
                self.planes.main.fadeout(150)
            except Exception:
                pass
        self.view = new_view
        self.selected_idx = 0
        self.scroll_offset = 0
        self.expanded_id = None
        self.reader_reading_id = None
        self.evo_tab = "overview"
        if self.view == "cockpit" and NcReel:
            self._create_nc_reel()
        elif self.planes.reel_widget:
            try:
                if self.planes.reel_plane:
                    self.planes.reel_plane.destroy()
            except Exception:
                pass
            self.planes.reel_widget = None
            self.planes.reel_plane = None
        if self.planes.main:
            try:
                self.planes.main.fadein(150)
            except Exception:
                pass

    def _handle_view_keys(self, char: str, key: int = 0):
        with self.data_lock:
            items = self._current_items()
        count = len(items) if items else 0

        if char == "j":
            self.selected_idx = min(self.selected_idx + 1, max(0, count - 1))
        elif char == "k":
            self.selected_idx = max(self.selected_idx - 1, 0)
        elif char == "g":
            self.selected_idx = 0
            self.scroll_offset = 0
        elif char == "G":
            self.selected_idx = max(0, count - 1)
        elif char == " ":
            if items and 0 <= self.selected_idx < len(items):
                item = items[self.selected_idx]
                item_id = item.get("id") if isinstance(item, dict) else None
                if item_id is not None:
                    self.expanded_id = None if self.expanded_id == item_id else item_id
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
            self._msg("C-x C-c:quit C-g:cancel C-n/C-p:nav Tab:sidebar M-x:cmd /:srch c:cap T:theme SPC:expand")
        elif char == "d" and self.view == "reader":
            self._action_delete_reader(items)
        elif char == "a" and self.view == "snow":
            self._action_accept_proposal(items)
        elif char == "x" and self.view == "snow":
            self._action_reject_proposal(items)
        elif char == "n":
            self.selected_idx = min(self.selected_idx + 1, max(0, count - 1))
        elif char == "p":
            self.selected_idx = max(self.selected_idx - 1, 0)
        elif char == "l" and self.view == "evolution":
            tabs = ["overview", "versions", "golden", "observations", "costs"]
            idx = tabs.index(self.evo_tab) if self.evo_tab in tabs else 0
            self.evo_tab = tabs[(idx + 1) % len(tabs)]
            self.selected_idx = 0

    def _current_items(self) -> list:
        if self.view == "programs":
            return self.data_cache.get("programs", [])
        elif self.view == "results":
            return self.data_cache.get("results", [])
        elif self.view == "reader":
            if self.reader_reading_id:
                return []
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
            return [{"_tree": "info", "_label": "Voice commands available via CLI"},
                    {"_tree": "info", "_label": "Use X to open CLI prompt"},
                    {"_tree": "info", "_label": "Commands: briefing, status, capture <text>"}]
        return []

    def _build_agenda_items(self) -> list:
        agenda = self.data_cache.get("agenda", {})
        items = []
        overdue = agenda.get("overdue", [])
        today = agenda.get("today", [])
        upcoming = agenda.get("upcoming", [])
        briefings = agenda.get("briefings", [])
        if overdue:
            items.append({"_section": "OVERDUE (" + str(len(overdue)) + ")"})
            items.extend(overdue)
        items.append({"_section": "TODAY (" + str(len(today)) + ")"})
        items.extend(today)
        if upcoming:
            items.append({"_section": "UPCOMING (" + str(len(upcoming)) + ")"})
            items.extend(upcoming)
        if briefings:
            items.append({"_section": "BRIEFINGS (" + str(len(briefings)) + ")"})
            items.extend(briefings)
        return items

    def _build_tree_items(self) -> list:
        items = []
        runtime = self.data_cache.get("runtime", {})
        budget = self.data_cache.get("budget", {})
        programs = self.data_cache.get("programs", [])
        tasks_list = self.data_cache.get("agenda", {}).get("today", [])
        notes = self.data_cache.get("notes", [])
        skills_list = self.data_cache.get("skills", [])
        captures = self.data_cache.get("captures", [])
        reader = self.data_cache.get("reader", [])

        items.append({"_section": "RUNTIME"})
        items.append({"_tree": "status", "_label": "Active: " + str(runtime.get("active", False))})
        rp = runtime.get("programs", [])
        running_count = sum(1 for p in rp if p.get("status") == "running")
        items.append({"_tree": "status", "_label": "Running: " + str(running_count) + "/" + str(len(rp))})

        items.append({"_section": "BUDGET"})
        items.append({"_tree": "budget", "_label": "Spent: $" + str(round(budget.get("spent", 0), 4))})
        items.append({"_tree": "budget", "_label": "Cap: $" + str(round(budget.get("dailyCap", 0), 2))})
        remaining = budget.get("dailyCap", 0) - budget.get("spent", 0)
        items.append({"_tree": "budget", "_label": "Remaining: $" + str(round(max(0, remaining), 4))})

        items.append({"_section": "PROGRAMS (" + str(len(programs)) + ")"})
        for p in programs:
            items.append(p)
        items.append({"_section": "TASKS (" + str(len(tasks_list)) + ")"})
        for t in tasks_list:
            items.append(t)
        items.append({"_section": "NOTES (" + str(len(notes)) + ")"})
        for n_item in notes:
            items.append(n_item)
        items.append({"_section": "SKILLS (" + str(len(skills_list)) + ")"})
        for s in skills_list:
            items.append(s)
        items.append({"_section": "INBOX (" + str(len(captures)) + ")"})
        for c in captures:
            items.append(c)
        items.append({"_section": "READER (" + str(len(reader)) + ")"})
        for r in reader:
            items.append(r)
        return items

    def _build_evolution_items(self) -> list:
        items = []
        try:
            state = self.api.evolution_state()
        except Exception:
            items.append({"_tree": "error", "_label": "Failed to load evolution state"})
            return items

        if self.evo_tab == "overview":
            items.append({"_section": "EVOLUTION v" + str(state.get("currentVersion", 0))})
            m = state.get("metrics", {})
            sr = m.get("successRate", 0)
            items.append({"_tree": "metric", "_label": "Success Rate: " + str(round(sr * 100, 1)) + "%"})
            items.append({"_tree": "metric", "_label": "Total Runs (7d): " + str(m.get("totalRuns", 0))})
            items.append({"_tree": "metric", "_label": "Successful: " + str(m.get("successfulRuns", 0))})
            items.append({"_tree": "metric", "_label": "Corrections: " + str(m.get("corrections", 0))})
            items.append({"_tree": "metric", "_label": "Correction Rate: " + str(round(m.get("correctionRate", 0) * 100, 1)) + "%"})
            items.append({"_tree": "metric", "_label": "Golden Suite: " + str(state.get("goldenSuiteSize", 0)) + " cases"})
            items.append({"_tree": "metric", "_label": "Pending Observations: " + str(state.get("unconsolidatedObservations", 0))})
        elif self.evo_tab == "versions":
            versions = state.get("recentVersions", [])
            items.append({"_section": "VERSIONS (" + str(len(versions)) + ")"})
            for v in versions:
                items.append(v)
        elif self.evo_tab == "golden":
            try:
                suite = self.api.evolution_golden_suite()
                items.append({"_section": "GOLDEN SUITE (" + str(len(suite)) + ")"})
                for entry in suite:
                    items.append(entry)
            except Exception:
                items.append({"_tree": "error", "_label": "Failed to load golden suite"})
        elif self.evo_tab == "observations":
            try:
                obs = self.api.evolution_observations()
                items.append({"_section": "OBSERVATIONS (" + str(len(obs)) + ")"})
                for o in obs:
                    items.append(o)
            except Exception:
                items.append({"_tree": "error", "_label": "Failed to load observations"})
        elif self.evo_tab == "costs":
            try:
                costs = self.api.evolution_judge_costs()
                items.append({"_section": "JUDGE COSTS"})
                items.append({"_tree": "cost", "_label": "Today: $" + str(round(costs.get("today", 0), 4))})
                items.append({"_tree": "cost", "_label": "Cap: $" + str(round(costs.get("cap", 0), 2))})
                items.append({"_tree": "cost", "_label": "Remaining: $" + str(round(costs.get("remaining", 0), 4))})
                breakdown = costs.get("breakdown", {})
                for judge, cost in breakdown.items():
                    items.append({"_tree": "cost", "_label": "  " + judge + ": $" + str(round(cost, 4))})
            except Exception:
                items.append({"_tree": "error", "_label": "Failed to load judge costs"})
        return items

    def _action_enter(self, items):
        if not items or self.selected_idx >= len(items):
            return
        item = items[self.selected_idx]
        if not isinstance(item, dict) or "_section" in item:
            return
        if self.view == "programs":
            pid = item.get("id")
            if pid:
                try:
                    self.api.toggle_program(pid)
                    self._msg("Toggled: " + item.get("name", ""))
                except Exception as e:
                    self._msg("Error: " + str(e))
        elif self.view == "agenda":
            if item.get("status"):
                try:
                    self.api.toggle_task(item["id"])
                    self._msg("Toggled: " + item.get("title", ""))
                except Exception as e:
                    self._msg("Error: " + str(e))
            elif item.get("summary"):
                self.expanded_id = None if self.expanded_id == item.get("id") else item.get("id")
        elif self.view == "results":
            self.expanded_id = None if self.expanded_id == item.get("id") else item.get("id")
        elif self.view == "reader":
            self.reader_reading_id = item.get("id")
        elif self.view == "cockpit":
            self.expanded_id = None if self.expanded_id == id(item) else id(item)
        elif self.view == "transcripts":
            self.expanded_id = None if self.expanded_id == item.get("id") else item.get("id")
        elif self.view == "snow":
            self.expanded_id = None if self.expanded_id == item.get("id") else item.get("id")

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

    def _action_delete_reader(self, items):
        if not items or self.selected_idx >= len(items):
            return
        item = items[self.selected_idx]
        pid = item.get("id") if isinstance(item, dict) else None
        if pid:
            try:
                self.api.delete_reader_page(pid)
                self._msg("Deleted reader page")
            except Exception as e:
                self._msg("Error: " + str(e))

    def _action_accept_proposal(self, items):
        if not items or self.selected_idx >= len(items):
            return
        item = items[self.selected_idx]
        pid = item.get("id") if isinstance(item, dict) else None
        if pid:
            try:
                self.api.accept_proposal(pid)
                self._msg("Accepted proposal #" + str(pid))
            except Exception as e:
                self._msg("Error: " + str(e))

    def _action_reject_proposal(self, items):
        if not items or self.selected_idx >= len(items):
            return
        item = items[self.selected_idx]
        pid = item.get("id") if isinstance(item, dict) else None
        if pid:
            try:
                self.api.reject_proposal(pid)
                self._msg("Rejected proposal #" + str(pid))
            except Exception as e:
                self._msg("Error: " + str(e))

    def _open_minibuffer(self, prompt: str, callback):
        if self._open_nc_reader(prompt):
            self.minibuffer_callback = callback
            return
        self.minibuffer_active = True
        self.minibuffer_text = ""
        self.minibuffer_prompt = prompt
        self.minibuffer_callback = callback
        self.minibuffer_hist_idx = -1

    def _close_minibuffer(self):
        if self._nc_reader_active:
            self._close_nc_reader()
        self.minibuffer_active = False
        self.minibuffer_text = ""
        self.minibuffer_prompt = ""
        self.minibuffer_callback = None

    def _handle_minibuffer_nc(self, key, ni):
        if key == 7:
            self._close_minibuffer()
            self._msg("Quit")
            return
        if key == 27:
            self._close_minibuffer()
            return
        if key == 10 or key == 13:
            cb = self.minibuffer_callback
            text = self.minibuffer_text
            if text:
                self.minibuffer_history.append(text)
            self._close_minibuffer()
            if cb and text:
                cb(text)
            return
        if key == 127 or key == 263:
            self.minibuffer_text = self.minibuffer_text[:-1]
            return
        if key == 1:
            return
        if key == 5:
            return
        if key == 11:
            self.minibuffer_text = ""
            return
        if key == 16:
            if self.minibuffer_history:
                if self.minibuffer_hist_idx < 0:
                    self.minibuffer_hist_idx = len(self.minibuffer_history) - 1
                else:
                    self.minibuffer_hist_idx = max(0, self.minibuffer_hist_idx - 1)
                self.minibuffer_text = self.minibuffer_history[self.minibuffer_hist_idx]
            return
        if key == 14:
            if self.minibuffer_hist_idx >= 0:
                self.minibuffer_hist_idx = min(len(self.minibuffer_history) - 1,
                                                self.minibuffer_hist_idx + 1)
                self.minibuffer_text = self.minibuffer_history[self.minibuffer_hist_idx]
            return
        char = chr(key) if 0 < key < 0x110000 else ""
        if char and char.isprintable():
            self.minibuffer_text += char

    def _open_command_palette(self):
        items_list = [(cmd, desc) for cmd, desc in PALETTE_ALL_CMDS]
        selector = self._create_nc_selector(items_list, title="M-x")
        if selector:
            self.command_palette_active = True
            return
        self.command_palette_active = True
        self.palette_idx = 0
        self.palette_filter = ""

    def _handle_palette_nc(self, key, ni):
        if key == 7 or key == 27:
            self.command_palette_active = False
            return
        commands = self._palette_commands()
        char = chr(key) if 0 < key < 0x110000 else ""
        if key == 14 or char == "j":
            self.palette_idx = min(self.palette_idx + 1, max(0, len(commands) - 1))
            return
        if key == 16 or char == "k":
            self.palette_idx = max(self.palette_idx - 1, 0)
            return
        if key == 10 or key == 13:
            if 0 <= self.palette_idx < len(commands):
                cmd = commands[self.palette_idx]
                self.command_palette_active = False
                self.palette_filter = ""
                self._do_command(cmd[0])
            return
        if key == 127 or key == 263:
            self.palette_filter = self.palette_filter[:-1]
            self.palette_idx = 0
            return
        if char and char.isprintable():
            self.palette_filter += char
            self.palette_idx = 0

    def _palette_commands(self) -> list:
        if self.palette_filter:
            filt = self.palette_filter.lower()
            return [(c, d) for c, d in PALETTE_ALL_CMDS if filt in c.lower() or filt in d.lower()]
        return PALETTE_ALL_CMDS

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
                self._switch_view(arg)
            else:
                self._msg("Views: " + ", ".join(VIEWS))
        elif verb == "runtime-toggle" or verb == "rt":
            self._action_toggle_runtime()
        elif verb == "refresh":
            threading.Thread(target=self._refresh_data, daemon=True).start()
            self._msg("Refreshing...")
        elif verb == "consolidate":
            try:
                self.api.evolution_consolidate()
                self._msg("Consolidation triggered")
            except Exception as e:
                self._msg("Error: " + str(e))
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
            self._msg("C-x C-c:quit C-g:cancel C-n/C-p:nav Tab:sidebar M-x:cmd /:search c:cap T:theme")
        else:
            self._do_cli(cmd)

    def _render_nc(self):
        self._render_header_plane()
        if self.sidebar_visible and self.planes.sidebar:
            self._render_sidebar_plane()
        if self.planes.main:
            if self.view == "cockpit" and self.planes.reel_widget:
                self._render_cockpit_reel()
            else:
                self._render_main_plane()
        self._render_modeline_plane()
        if not self._nc_reader_active:
            self._render_minibuffer_plane()
        if self.command_palette_active and not self.planes.selector_widget and self.planes.palette_overlay:
            self._render_palette_plane()
            try:
                self.planes.palette_overlay.move_above(self.planes.main)
            except Exception:
                pass
        elif self.planes.palette_overlay and not self.planes.selector_widget:
            try:
                self.planes.palette_overlay.move_below(self.stdp)
            except Exception:
                pass

    def _render_header_plane(self):
        p = self.planes.header
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

    def _render_sidebar_plane(self):
        p = self.planes.sidebar
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
            if is_active:
                self._set_fg(p, "accent")
            else:
                self._set_fg(p, "fg")
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

            if cap > 0:
                pct = min(1.0, spent / cap)
                if not self.planes.progbar_widget:
                    bar_w = cols - 4
                    filled = int(bar_w * pct)
                    bar = "\u2588" * filled + "\u2591" * (bar_w - filled)
                    color = "success" if pct < 0.7 else "warn" if pct < 0.9 else "error"
                    self._set_fg(p, color)
                    p.putstr_yx(info_y + 3, 2, bar[:cols - 4])

            ctrl = self.data_cache.get("control", {})
            mode = ctrl.get("mode", "human")
            mode_y = info_y + 4
            if mode_y < rows:
                mc = "info" if mode == "agent" else "warn"
                self._set_fg(p, mc)
                p.putstr_yx(mode_y, 1, ("Mode: " + mode.upper())[:cols - 2])

            if self.sparkline_data and info_y + 5 < rows - 1:
                self._render_braille_sparkline(p, info_y + 5, 1, cols - 3, list(self.sparkline_data)[-20:])

        for y in range(rows):
            self._set_fg(p, "border")
            p.putstr_yx(y, cols - 1, "\u2502")

    def _render_braille_sparkline(self, plane, y: int, x: int, width: int, data: list):
        if not data or width <= 0:
            return
        mn = min(data) if data else 0
        mx = max(data) if data else 1
        rng = mx - mn if mx != mn else 1
        self._set_fg(plane, "accent")
        for i in range(min(width, len(data))):
            val = data[i]
            normalized = (val - mn) / rng
            idx = int(normalized * (len(BRAILLE_BLOCKS) - 1))
            idx = max(0, min(len(BRAILLE_BLOCKS) - 1, idx))
            plane.putstr_yx(y, x + i, BRAILLE_BLOCKS[idx])

    def _render_cockpit_reel(self):
        p = self.planes.main
        if not p:
            return
        rows, cols = p.dim_yx()
        p.erase()
        self._set_bg(p, "bg")
        self._set_fg(p, "accent")
        title = "COCKPIT (" + str(len(self.cockpit_events)) + " events)"
        p.putstr_yx(0, 1, title[:cols - 2])
        conn_str = "\u25CF CONNECTED" if self.cockpit_connected else "\u25CB DISCONNECTED"
        ry = max(0, cols - len(conn_str) - 2)
        self._set_fg(p, "success" if self.cockpit_connected else "error")
        p.putstr_yx(0, ry, conn_str[:cols - ry])
        events = list(self.cockpit_events)
        events.reverse()
        y = 2
        for i, evt in enumerate(events):
            if y >= rows:
                break
            is_sel = i == self.selected_idx
            is_new = self._is_item_new(evt)
            self._set_bg(p, "bg")
            self._set_fg(p, "dim")
            ts = evt.get("timestamp", 0)
            tstr = ""
            if ts:
                try:
                    tstr = datetime.datetime.fromtimestamp(ts / 1000).strftime("%H:%M:%S")
                except Exception:
                    pass
            p.putstr_yx(y, 1, "\u2500" * (cols - 2))
            y += 1
            if y >= rows:
                break
            etype = evt.get("eventType", "")
            icon = "\u25CF"
            if etype == "error":
                icon = "\u2717"
            elif etype == "take-over-point":
                icon = "\u26A1"
            elif etype == "decision":
                icon = "\u25B6"
            elif etype == "result":
                icon = "\u2713"
            if is_sel:
                self._set_bg(p, "sel_bg")
                self._set_fg(p, "sel_fg")
            elif is_new:
                self._pulse_fg(p, evt)
            else:
                color = "error" if etype == "error" else "fg"
                self._set_fg(p, color)
            src = evt.get("source", "")[:12]
            desc = evt.get("description", "")
            header_line = icon + " " + tstr + " [" + src + "] " + etype
            p.putstr_yx(y, 1, header_line[:cols - 2])
            y += 1
            if y >= rows:
                break
            self._set_fg(p, "fg" if not is_sel else "sel_fg")
            self._set_bg(p, "bg" if not is_sel else "sel_bg")
            p.putstr_yx(y, 3, desc[:cols - 4])
            y += 1
            if is_sel and self.expanded_id == id(evt):
                data = evt.get("data", {})
                if data and isinstance(data, dict):
                    for k, v in data.items():
                        if y >= rows:
                            break
                        self._set_fg(p, "dim")
                        self._set_bg(p, "bg")
                        p.putstr_yx(y, 5, (str(k) + ": " + str(v))[:cols - 6])
                        y += 1
        self._set_bg(p, "bg")

    def _render_main_plane(self):
        p = self.planes.main
        if not p:
            return
        rows, cols = p.dim_yx()
        p.erase()
        self._set_bg(p, "bg")
        if self.view == "reader" and self.reader_reading_id:
            self._render_reader_content(p, rows, cols)
            return
        with self.data_lock:
            items = self._current_items()

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
        p.putstr_yx(0, 1, title[:cols - 2])

        y = 1
        for i in range(self.scroll_offset, len(items)):
            if y >= rows:
                break
            item = items[i]
            is_sel = i == self.selected_idx
            is_exp = isinstance(item, dict) and item.get("id") == self.expanded_id
            is_new = self._is_item_new(item)
            line = self._format_item(item, cols - 2)

            if is_sel:
                self._set_bg(p, "sel_bg")
                self._set_fg(p, "sel_fg")
            elif isinstance(item, dict) and "_section" in item:
                self._set_fg(p, "accent")
                self._set_bg(p, "bg")
            elif isinstance(item, dict) and item.get("status") == "error":
                self._set_fg(p, "error")
                self._set_bg(p, "bg")
            elif is_new:
                self._pulse_fg(p, item)
                self._set_bg(p, "bg")
            else:
                self._set_fg(p, "fg")
                self._set_bg(p, "bg")

            padded = line.ljust(cols - 2)[:cols - 2]
            p.putstr_yx(y, 1, padded)
            self._set_bg(p, "bg")
            y += 1
            if is_exp and isinstance(item, dict):
                detail_lines = self._format_detail(item, cols - 4)
                for dl in detail_lines:
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
            except Exception:
                pass
        if not page:
            self._set_fg(p, "error")
            p.putstr_yx(1, 1, "Page not found")
            return
        self._set_fg(p, "accent")
        p.putstr_yx(0, 1, (page.get("title", "?"))[:cols - 12])
        self._set_fg(p, "dim")
        p.putstr_yx(0, max(1, cols - 11), "[Esc:back]")
        p.putstr_yx(1, 1, (page.get("domain", "") + " \u2014 " + page.get("url", ""))[:cols - 2])
        text = page.get("extractedText", "")
        text_lines = text.split("\n")
        y = 3
        for tl in text_lines:
            if y >= rows:
                break
            while len(tl) > cols - 2 and y < rows:
                self._set_fg(p, "fg")
                p.putstr_yx(y, 1, tl[:cols - 2])
                tl = tl[cols - 2:]
                y += 1
            if y < rows:
                self._set_fg(p, "fg")
                p.putstr_yx(y, 1, tl[:cols - 2])
                y += 1

    def _render_modeline_plane(self):
        p = self.planes.modeline
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
        age = ""
        if self.last_refresh > 0:
            secs = int(time.time() - self.last_refresh)
            age = str(secs) + "s ago"
        sb = "SB" if self.sidebar_visible else "  "
        right = t_name + " | RT:" + rt + " | " + sb + " | " + age + " "
        pad = cols - len(left) - len(right)
        if pad < 0:
            pad = 0
        p.putstr_yx(0, 0, left + " " * pad + right)

    def _render_minibuffer_plane(self):
        p = self.planes.minibuffer
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

    def _render_palette_plane(self):
        p = self.planes.palette_overlay
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
        filter_line = "Filter: " + self.palette_filter + "\u2588"
        self._set_fg(p, "fg")
        p.putstr_yx(1, 2, filter_line[:cols - 4])
        commands = self._palette_commands()
        for i, (cmd, desc) in enumerate(commands):
            yy = 2 + i
            if yy >= rows - 1:
                break
            is_sel = i == self.palette_idx
            if is_sel:
                self._set_bg(p, "sel_bg")
                self._set_fg(p, "sel_fg")
            else:
                self._set_fg(p, "fg")
                self._set_bg(p, "bg")
            entry = (" " + cmd).ljust(cols - 2)[:cols - 2]
            p.putstr_yx(yy, 1, entry)
        self._set_bg(p, "bg")

    def _format_item(self, item, max_width: int) -> str:
        if not isinstance(item, dict):
            return str(item)[:max_width]
        if "_section" in item:
            label = item["_section"]
            dashes = max(0, max_width - len(label) - 4)
            return "\u2500\u2500 " + label + " " + "\u2500" * dashes
        if "_tree" in item:
            return "  " + item.get("_label", "")
        if self.view == "programs" or (self.view == "tree" and item.get("name") and item.get("instructions")):
            enabled = item.get("enabled", False)
            name = item.get("name", "?")
            cost = item.get("costTier", "")
            sched = item.get("schedule", "")
            runtime = self.data_cache.get("runtime", {})
            rp_list = runtime.get("programs", [])
            rp = None
            for rp_item in rp_list:
                if rp_item.get("name") == name:
                    rp = rp_item
                    break
            if not enabled:
                sc = STATUS_CHARS["disabled"]
            elif rp:
                sc = STATUS_CHARS.get(rp.get("status", ""), STATUS_CHARS["enabled"])
            else:
                sc = STATUS_CHARS["enabled"]
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
            if metric and isinstance(metric, (int, float)):
                bar = _braille_bar(metric, max_val=1.0, width=5)
                line += " " + bar + " " + str(round(metric, 2))
            elif metric:
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
                    tstr = datetime.datetime.fromtimestamp(ts / 1000).strftime("%H:%M:%S")
                except Exception:
                    pass
            etype = item.get("eventType", "")
            icon = "\u25CF"
            if etype == "error":
                icon = "\u2717"
            elif etype == "take-over-point":
                icon = "\u26A1"
            elif etype == "decision":
                icon = "\u25B6"
            return (icon + " " + tstr + " " + src[:10] + ": " + desc)[:max_width]
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
                applied = str(item.get("appliedAt", ""))[:10]
                return (v + " [" + st + "] " + applied)[:max_width]
            if item.get("input"):
                return ("\u25CF " + str(item.get("input", ""))[:max_width - 2])[:max_width]
            if item.get("observationType"):
                ot = item.get("observationType", "")
                content = item.get("content", "")
                consolidated = "\u2713" if item.get("consolidated") else "\u25CB"
                return (consolidated + " [" + ot + "] " + content)[:max_width]
        elif self.view == "snow":
            title = item.get("title", item.get("description", "?"))
            status = item.get("status", "")
            return (status[:8].ljust(9) + str(title))[:max_width]
        elif self.view == "transcripts":
            platform = item.get("platform", "?")
            status = item.get("status", "")
            dur = item.get("durationSeconds", 0)
            dur_str = str(dur // 60) + "m" if dur else ""
            rec_type = item.get("recordingType", "")
            created = str(item.get("createdAt", ""))[:10]
            return ("[" + platform + "] " + rec_type + " " + dur_str + " " + status + " " + created)[:max_width]
        if item.get("title"):
            return str(item["title"])[:max_width]
        if item.get("name"):
            return str(item["name"])[:max_width]
        if item.get("rawText"):
            return str(item["rawText"])[:max_width]
        return str(item.get("id", "?"))[:max_width]

    def _format_detail(self, item: dict, max_width: int) -> list:
        lines = []
        if self.view == "programs":
            instr = item.get("instructions", "")
            if instr:
                for chunk in _wrap(instr[:300], max_width):
                    lines.append(chunk)
            lines.append("type: " + str(item.get("type", "?")) + "  lang: " + str(item.get("codeLang", "?")))
            if item.get("computeTarget") and item["computeTarget"] != "local":
                lines.append("target: " + item["computeTarget"])
            runtime = self.data_cache.get("runtime", {})
            rp_list = runtime.get("programs", [])
            rp = None
            for rp_item in rp_list:
                if rp_item.get("name") == item.get("name"):
                    rp = rp_item
                    break
            if rp:
                lines.append("iter: " + str(rp.get("iteration", 0)) + "  status: " + str(rp.get("status", "?")))
                lr = rp.get("lastRun")
                if lr:
                    lines.append("last: " + str(lr))
                last_out = rp.get("lastOutput", "")
                if last_out:
                    for chunk in _wrap(str(last_out)[:300], max_width):
                        lines.append("  " + chunk)
                err = rp.get("error")
                if err:
                    lines.append("ERROR: " + str(err)[:max_width])
            lines.append("[Enter:toggle  r:trigger  R:runtime]")
        elif self.view == "results":
            lines.append("model: " + str(item.get("model", "?")) +
                          "  tokens: " + str(item.get("tokensUsed", 0)) +
                          "  iter: " + str(item.get("iteration", 0)))
            created = item.get("createdAt", "")
            if created:
                lines.append("time: " + str(created))
            raw = item.get("rawOutput") or item.get("summary") or ""
            for chunk in _wrap(str(raw)[:800], max_width):
                lines.append(chunk)
        elif self.view == "reader":
            lines.append("URL: " + str(item.get("url", "")))
            text = item.get("extractedText", "")
            for chunk in _wrap(str(text)[:400], max_width):
                lines.append(chunk)
        elif self.view == "cockpit":
            data = item.get("data", {})
            if data and isinstance(data, dict):
                for k, v in data.items():
                    lines.append(str(k) + ": " + str(v)[:max_width - len(str(k)) - 2])
            sid = item.get("sessionId")
            if sid:
                lines.append("session: " + str(sid))
        elif self.view == "agenda":
            body = item.get("body") or item.get("rawOutput") or ""
            tags = item.get("tags")
            if tags:
                lines.append("tags: " + str(tags))
            if body:
                for chunk in _wrap(str(body)[:400], max_width):
                    lines.append(chunk)
        elif self.view == "evolution":
            ms = item.get("metricsSnapshot", {})
            if ms:
                lines.append("Success: " + str(round(ms.get("successRate", 0) * 100, 1)) + "%")
                lines.append("Corrections: " + str(round(ms.get("correctionRate", 0) * 100, 1)) + "%")
                lines.append("Runs: " + str(ms.get("totalRuns", 0)))
            gr = item.get("gateResults", {})
            if gr and isinstance(gr, dict):
                for gate, result in gr.items():
                    if isinstance(result, dict):
                        passed = result.get("passed", False)
                        reason = result.get("reason", "")
                        mark = "\u2713" if passed else "\u2717"
                        lines.append(mark + " " + gate + ": " + reason[:max_width - 10])
            changes = item.get("changes", {})
            if changes and isinstance(changes, dict):
                for field, diff in changes.items():
                    if isinstance(diff, dict):
                        lines.append(field + ": " + str(diff.get("before", ""))[:30] + " -> " + str(diff.get("after", ""))[:30])
            applied = item.get("appliedAt", "")
            if applied:
                lines.append("Applied: " + str(applied))
            rb = item.get("rolledBackAt")
            if rb:
                lines.append("Rolled back: " + str(rb))
        elif self.view == "snow":
            desc = item.get("description", "")
            if desc:
                for chunk in _wrap(str(desc)[:400], max_width):
                    lines.append(chunk)
            lines.append("[a:accept  x:reject]")
        elif self.view == "transcripts":
            raw = item.get("rawText", "")
            if raw:
                for chunk in _wrap(str(raw)[:500], max_width):
                    lines.append(chunk)
            src = item.get("sourceUrl", "")
            if src:
                lines.append("source: " + str(src))
            segments = item.get("segments")
            if segments and isinstance(segments, list):
                lines.append("segments: " + str(len(segments)))
        return lines[:30]

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
        self.api.stop()

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
        tag = "v" + VERSION + " | " + self.theme.current["name"] + " | curses"
        ty = rows // 2 + 3
        if 0 <= ty < rows - 1:
            try:
                stdscr.addnstr(ty, max(0, (cols - len(tag)) // 2), tag, cols, curses.color_pair(2))
            except curses.error:
                pass
        sub = "Press any key..."
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

    def _handle_input_curses(self, ch, curses):
        if isinstance(ch, int):
            if ch == 24:
                self.ctrl_x_pending = True
                self._msg("C-x-")
                return
            if self.ctrl_x_pending:
                self.ctrl_x_pending = False
                char = chr(ch) if 0 < ch < 128 else ""
                if ch == 3 or char == "c":
                    self.running = False
                    return
                if char == "b" or ch == 2:
                    self._open_command_palette()
                    return
                return
            if ch == 7:
                if self.minibuffer_active:
                    self._close_minibuffer()
                elif self.command_palette_active:
                    self.command_palette_active = False
                else:
                    self._msg("Quit")
                return
            if ch == 14:
                if self.command_palette_active:
                    self.palette_idx = min(self.palette_idx + 1, max(0, len(self._palette_commands()) - 1))
                else:
                    self._navigate_down()
                return
            if ch == 16:
                if self.command_palette_active:
                    self.palette_idx = max(self.palette_idx - 1, 0)
                else:
                    self._navigate_up()
                return
            if ch == 19:
                self._open_minibuffer("I-search: ", self._do_search)
                return
            if ch == 12:
                threading.Thread(target=self._refresh_data, daemon=True).start()
                self._msg("Refreshing...")
                return
            if ch == 9:
                self.sidebar_visible = not self.sidebar_visible
                return
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
                        self._close_minibuffer()
                    elif self.command_palette_active:
                        self.command_palette_active = False
                    elif self.expanded_id is not None:
                        self.expanded_id = None
                    elif self.reader_reading_id is not None:
                        self.reader_reading_id = None
                    else:
                        self._switch_view("agenda")
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
            self._switch_view(VIEW_KEYS[char])
            return
        if char == "T":
            self.theme.next_theme()
            self._init_curses_colors(curses)
            self._msg("Theme: " + self.theme.current["name"])
            return
        if char == "/":
            self._open_minibuffer("Search: ", self._do_search)
            return
        if char == ":":
            self._open_minibuffer("M-x ", self._do_command)
            return
        key_int = ch if isinstance(ch, int) else 0
        self._handle_view_keys(char, key_int)

    def _handle_minibuffer_curses(self, ch, char):
        if isinstance(ch, int):
            if ch == 7:
                self._close_minibuffer()
                self._msg("Quit")
                return
            if ch == 27:
                self._close_minibuffer()
                return
            if ch == 10 or ch == 13:
                cb = self.minibuffer_callback
                text = self.minibuffer_text
                if text:
                    self.minibuffer_history.append(text)
                self._close_minibuffer()
                if cb and text:
                    cb(text)
                return
            if ch == 127 or ch == 263 or ch == 8:
                self.minibuffer_text = self.minibuffer_text[:-1]
                return
            if ch == 11:
                self.minibuffer_text = ""
                return
            if ch == 16:
                if self.minibuffer_history:
                    if self.minibuffer_hist_idx < 0:
                        self.minibuffer_hist_idx = len(self.minibuffer_history) - 1
                    else:
                        self.minibuffer_hist_idx = max(0, self.minibuffer_hist_idx - 1)
                    self.minibuffer_text = self.minibuffer_history[self.minibuffer_hist_idx]
                return
            if ch == 14:
                if self.minibuffer_hist_idx >= 0:
                    self.minibuffer_hist_idx = min(len(self.minibuffer_history) - 1,
                                                    self.minibuffer_hist_idx + 1)
                    self.minibuffer_text = self.minibuffer_history[self.minibuffer_hist_idx]
                return
            char = chr(ch) if 0 < ch < 128 else ""
        if char and len(char) == 1 and char.isprintable():
            self.minibuffer_text += char

    def _handle_palette_curses(self, ch, char, curses):
        commands = self._palette_commands()
        if isinstance(ch, int):
            if ch == 7 or ch == 27:
                self.command_palette_active = False
                self.palette_filter = ""
                return
            if ch == 10 or ch == 13:
                if 0 <= self.palette_idx < len(commands):
                    cmd = commands[self.palette_idx][0]
                    self.command_palette_active = False
                    self.palette_filter = ""
                    self._do_command(cmd)
                return
            if ch == 127 or ch == 263 or ch == 8:
                self.palette_filter = self.palette_filter[:-1]
                self.palette_idx = 0
                return
            char = chr(ch) if 0 < ch < 128 else ""
        if char == "j":
            self.palette_idx = min(self.palette_idx + 1, max(0, len(commands) - 1))
            return
        if char == "k":
            self.palette_idx = max(self.palette_idx - 1, 0)
            return
        if char and len(char) == 1 and char.isprintable():
            self.palette_filter += char
            self.palette_idx = 0

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
        self._render_minibuffer_curses_bar(stdscr, curses, rows - 1, cols)
        if self.command_palette_active:
            self._render_palette_curses_overlay(stdscr, curses, rows, cols)
        stdscr.noutrefresh()
        curses.doupdate()

    def _render_header_curses(self, stdscr, curses, cols):
        header = " RACHAEL"
        right = self.view.upper() + " "
        pad = cols - len(header) - len(right)
        if pad < 0:
            pad = 0
        line = (header + " " * pad + right)[:cols]
        try:
            stdscr.addnstr(0, 0, line, cols, curses.color_pair(7))
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
            num = str(i + 1) if i < 9 else "0"
            prefix = "> " if is_active else "  "
            label = num + " " + v
            cp = curses.color_pair(3) if is_active else curses.color_pair(1)
            try:
                stdscr.addnstr(y, 1, (prefix + label)[:sw - 1], sw - 1, cp)
            except curses.error:
                pass
        info_y = top + len(VIEWS) + 2
        if info_y < bottom:
            try:
                stdscr.addnstr(info_y, 1, "\u2500" * (sw - 2), sw - 2, curses.color_pair(12))
            except curses.error:
                pass
        if info_y + 1 < bottom:
            runtime = self.data_cache.get("runtime", {})
            rt_on = runtime.get("active", False)
            cp = curses.color_pair(6) if rt_on else curses.color_pair(4)
            try:
                stdscr.addnstr(info_y + 1, 1, ("RT: " + ("ON" if rt_on else "OFF"))[:sw - 1], sw - 1, cp)
            except curses.error:
                pass
        if info_y + 2 < bottom:
            budget = self.data_cache.get("budget", {})
            spent = budget.get("spent", 0)
            cap = budget.get("dailyCap", 0)
            bstr = "$" + str(round(spent, 2)) + "/" + str(round(cap, 2))
            try:
                stdscr.addnstr(info_y + 2, 1, bstr[:sw - 1], sw - 1, curses.color_pair(2))
            except curses.error:
                pass
        if info_y + 3 < bottom and self.data_cache.get("budget", {}).get("dailyCap", 0) > 0:
            budget = self.data_cache.get("budget", {})
            pct = min(1.0, budget.get("spent", 0) / max(0.01, budget.get("dailyCap", 1)))
            bar_w = sw - 4
            filled = int(bar_w * pct)
            bar = "\u2588" * filled + "\u2591" * (bar_w - filled)
            color = 6 if pct < 0.7 else 5 if pct < 0.9 else 4
            try:
                stdscr.addnstr(info_y + 3, 2, bar[:sw - 4], sw - 4, curses.color_pair(color))
            except curses.error:
                pass
        if info_y + 4 < bottom and self.sparkline_data:
            data_slice = list(self.sparkline_data)[-min(sw - 4, 20):]
            spark_str = self._braille_sparkline_str(data_slice)
            try:
                stdscr.addnstr(info_y + 4, 2, spark_str[:sw - 4], sw - 4, curses.color_pair(3))
            except curses.error:
                pass

    def _braille_sparkline_str(self, data: list) -> str:
        if not data:
            return ""
        mn = min(data)
        mx = max(data) if max(data) != mn else mn + 1
        rng = mx - mn
        result = ""
        for val in data:
            normalized = (val - mn) / rng
            idx = int(normalized * (len(BRAILLE_BLOCKS) - 1))
            idx = max(0, min(len(BRAILLE_BLOCKS) - 1, idx))
            result += BRAILLE_BLOCKS[idx]
        return result

    def _render_main_curses(self, stdscr, curses, top, bottom, left, width):
        if self.view == "reader" and self.reader_reading_id:
            self._render_reader_curses(stdscr, curses, top, bottom, left, width)
            return
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
        if self.view == "evolution":
            title += " [" + self.evo_tab + "]"
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

    def _render_reader_curses(self, stdscr, curses, top, bottom, left, width):
        pages = self.data_cache.get("reader", [])
        page = None
        for pg in pages:
            if pg.get("id") == self.reader_reading_id:
                page = pg
                break
        if not page:
            try:
                page = self.api.reader_page(self.reader_reading_id)
            except Exception:
                pass
        if not page:
            try:
                stdscr.addnstr(top + 1, left + 1, "Page not found", width - 2, curses.color_pair(4))
            except curses.error:
                pass
            return
        try:
            stdscr.addnstr(top, left + 1, page.get("title", "?")[:width - 12], width - 12, curses.color_pair(3))
            stdscr.addnstr(top, left + width - 11, "[Esc:back]", 10, curses.color_pair(2))
            stdscr.addnstr(top + 1, left + 1, (page.get("domain", "") + " - " + page.get("url", ""))[:width - 2], width - 2, curses.color_pair(2))
        except curses.error:
            pass
        text = page.get("extractedText", "")
        text_lines = text.split("\n")
        y = top + 3
        for tl in text_lines:
            if y >= bottom:
                break
            while len(tl) > width - 2 and y < bottom:
                try:
                    stdscr.addnstr(y, left + 1, tl[:width - 2], width - 2, curses.color_pair(1))
                except curses.error:
                    pass
                tl = tl[width - 2:]
                y += 1
            if y < bottom:
                try:
                    stdscr.addnstr(y, left + 1, tl[:width - 2], width - 2, curses.color_pair(1))
                except curses.error:
                    pass
                y += 1

    def _render_modeline_curses(self, stdscr, curses, y, cols):
        left = " " + self.view.upper()
        runtime = self.data_cache.get("runtime", {})
        rt = "ON" if runtime.get("active") else "OFF"
        t_name = self.theme.current["name"]
        age = ""
        if self.last_refresh > 0:
            secs = int(time.time() - self.last_refresh)
            age = str(secs) + "s"
        sb = "SB" if self.sidebar_visible else "  "
        right = t_name + " | RT:" + rt + " | " + sb + " | " + age + " "
        pad = cols - len(left) - len(right)
        if pad < 0:
            pad = 0
        ml = (left + " " * pad + right)[:cols]
        try:
            stdscr.addnstr(y, 0, ml, cols, curses.color_pair(9))
        except curses.error:
            pass

    def _render_minibuffer_curses_bar(self, stdscr, curses, y, cols):
        if self.minibuffer_active:
            text = self.minibuffer_prompt + self.minibuffer_text + "_"
        elif self.ctrl_x_pending:
            text = "C-x-"
        elif self.message and time.time() - self.message_time < 5:
            text = self.message
        else:
            text = ""
        try:
            stdscr.addnstr(y, 0, text.ljust(cols)[:cols - 1], cols - 1, curses.color_pair(10))
        except curses.error:
            pass

    def _render_palette_curses_overlay(self, stdscr, curses, rows, cols):
        commands = self._palette_commands()
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
            filt = "Filter: " + self.palette_filter + "_"
            stdscr.addnstr(py + 1, px + 2, filt[:pw - 4], pw - 4, curses.color_pair(1))
            for i, (cmd, desc) in enumerate(commands):
                cy = py + 2 + i
                if cy >= py + ph - 1:
                    break
                is_sel = i == self.palette_idx
                cp = curses.color_pair(8) if is_sel else curses.color_pair(1)
                stdscr.addnstr(cy, px + 2, cmd[:pw - 4], pw - 4, cp)
        except curses.error:
            pass


def _braille_bar(value: float, max_val: float = 1.0, width: int = 5) -> str:
    if max_val <= 0:
        max_val = 1.0
    ratio = max(0.0, min(1.0, value / max_val))
    total_dots = width * 8
    filled = int(ratio * total_dots)
    result = ""
    for i in range(width):
        dots_in_char = min(8, max(0, filled - i * 8))
        if dots_in_char <= 0:
            result += BRAILLE_BLOCKS[0]
        else:
            idx = min(len(BRAILLE_BLOCKS) - 1, dots_in_char)
            result += BRAILLE_BLOCKS[idx]
    return result


def _wrap(text: str, width: int) -> list:
    if width <= 0:
        return []
    lines = []
    for raw_line in text.split("\n"):
        while len(raw_line) > width:
            lines.append(raw_line[:width])
            raw_line = raw_line[width:]
        lines.append(raw_line)
    return lines


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
