import os
import sys
import math
import time
from typing import Optional, Any, Callable

NC_AVAILABLE = False
NcPlane = None
Notcurses = None
NcInput = None
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
NcVisual = None
NCALPHA_BLEND = None
NCALPHA_TRANSPARENT = None
NCBLIT_BRAILLE = None
NCBLIT_2x2 = None
NCBLIT_4x2 = None
NCBLIT_PIXEL = None
NCSCALE_STRETCH = None

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
    from notcurses import Notcurses as _Nc, NcInput as _NcI, NcPlane as _NcP
    Notcurses = _Nc
    NcInput = _NcI
    NcPlane = _NcP
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
    NcVisual = _try_import("NcVisual")
    NCALPHA_BLEND = _try_import("NCALPHA_BLEND")
    NCALPHA_TRANSPARENT = _try_import("NCALPHA_TRANSPARENT")
    NCBLIT_BRAILLE = _try_import("NCBLIT_BRAILLE")
    NCBLIT_2x2 = _try_import("NCBLIT_2x2")
    NCBLIT_4x2 = _try_import("NCBLIT_4x2")
    NCBLIT_PIXEL = _try_import("NCBLIT_PIXEL")
    NCSCALE_STRETCH = _try_import("NCSCALE_STRETCH")
except ImportError:
    pass

BRAILLE_BLOCKS = ["\u2800", "\u2801", "\u2803", "\u2807", "\u280F",
                  "\u281F", "\u283F", "\u287F", "\u28FF"]
QUADRANT_BLOCKS = [" ", "\u2596", "\u2584", "\u2599", "\u2588"]
SEXTANT_MAP = [" ", "\U0001FB00", "\U0001FB01", "\U0001FB02", "\U0001FB03",
               "\U0001FB04", "\U0001FB05", "\U0001FB06", "\U0001FB07"]
MEDIA_CAPS = {"sixel": False, "kitty": False, "iterm2": False, "ncvisual": False}


def detect_media_capabilities():
    caps = {"sixel": False, "kitty": False, "iterm2": False, "ncvisual": NcVisual is not None}
    term = os.environ.get("TERM", "")
    term_program = os.environ.get("TERM_PROGRAM", "")

    if term_program == "iTerm.app" or "iterm2" in os.environ.get("LC_TERMINAL", "").lower():
        caps["iterm2"] = True
    if "kitty" in term or term_program == "kitty":
        caps["kitty"] = True

    try:
        import subprocess
        da1 = subprocess.run(
            ["bash", "-c", "echo -ne '\\e[c' && read -s -t 1 -d 'c' resp && echo $resp"],
            capture_output=True, timeout=2, text=True)
        if da1.returncode == 0 and "4" in da1.stdout:
            caps["sixel"] = True
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        pass

    if not caps["sixel"]:
        try:
            import subprocess
            result = subprocess.run(["infocmp", "-1"], capture_output=True, timeout=2, text=True)
            if result.returncode == 0 and "Smulx" in result.stdout:
                caps["sixel"] = True
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
            pass

    MEDIA_CAPS.update(caps)
    return caps


def preferred_blitter():
    if NCBLIT_PIXEL is not None:
        return NCBLIT_PIXEL
    if NCBLIT_BRAILLE is not None:
        return NCBLIT_BRAILLE
    if NCBLIT_4x2 is not None:
        return NCBLIT_4x2
    if NCBLIT_2x2 is not None:
        return NCBLIT_2x2
    return None


_PRIVATE_IP_PREFIXES = ("10.", "172.16.", "172.17.", "172.18.", "172.19.",
    "172.20.", "172.21.", "172.22.", "172.23.", "172.24.", "172.25.",
    "172.26.", "172.27.", "172.28.", "172.29.", "172.30.", "172.31.",
    "192.168.", "127.", "0.", "169.254.", "[::1]", "[fc", "[fd", "[fe80")


def _is_private_ip(ip_str: str) -> bool:
    import ipaddress
    try:
        addr = ipaddress.ip_address(ip_str)
        return addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved
    except ValueError:
        return False


def _validate_media_url(url: str) -> bool:
    from urllib.parse import urlparse
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        return False
    host = parsed.hostname or ""
    if not host:
        return False
    for prefix in _PRIVATE_IP_PREFIXES:
        if host.startswith(prefix):
            return False
    if host in ("localhost", "metadata.google.internal", "169.254.169.254"):
        return False
    if _is_private_ip(host):
        return False
    import socket
    try:
        resolved = socket.getaddrinfo(host, None, socket.AF_UNSPEC, socket.SOCK_STREAM)
        for family, stype, proto, canonname, sockaddr in resolved:
            ip = sockaddr[0]
            if _is_private_ip(ip):
                return False
    except (socket.gaierror, OSError):
        return False
    return True


def check_capabilities():
    degraded = []
    widget_map = [
        ("NcMenu", NcMenu), ("NcProgbar", NcProgbar), ("NcReader", NcReader),
        ("NcSelector", NcSelector), ("NcMultiSelector", NcMultiSelector),
        ("NcReel", NcReel), ("NcPlot", NcPlot), ("NcDPlot", NcDPlot),
        ("NcVisual", NcVisual), ("NCALPHA_BLEND", NCALPHA_BLEND),
        ("NCBLIT_BRAILLE", NCBLIT_BRAILLE), ("NCBLIT_4x2", NCBLIT_4x2),
    ]
    for name, val in widget_map:
        if val is None:
            degraded.append(name)
    return degraded


def braille_bar(value: float, max_val: float = 1.0, width: int = 5) -> str:
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


def braille_sparkline_str(data: list) -> str:
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


def braille_heatmap_row(values: list, max_val: float = 1.0, width: int = 20) -> str:
    if not values:
        return BRAILLE_BLOCKS[0] * width
    if max_val <= 0:
        max_val = 1.0
    step = max(1, len(values) / width) if width > 0 else 1
    result = ""
    for i in range(width):
        start = int(i * step)
        end = min(len(values), int((i + 1) * step))
        if start >= len(values):
            result += BRAILLE_BLOCKS[0]
            continue
        chunk = values[start:end] if end > start else [values[start]]
        avg = sum(chunk) / len(chunk)
        ratio = max(0.0, min(1.0, avg / max_val))
        idx = int(ratio * (len(BRAILLE_BLOCKS) - 1))
        result += BRAILLE_BLOCKS[idx]
    return result


def quadrant_bar(value: float, max_val: float = 1.0, width: int = 10) -> str:
    if max_val <= 0:
        max_val = 1.0
    ratio = max(0.0, min(1.0, value / max_val))
    total_steps = width * 4
    filled = int(ratio * total_steps)
    result = ""
    for i in range(width):
        steps_in_char = min(4, max(0, filled - i * 4))
        result += QUADRANT_BLOCKS[steps_in_char]
    return result


def activity_density_grid(data, width: int = 10, height: int = 3) -> list:
    flat = []
    if isinstance(data, list):
        for item in data:
            if isinstance(item, (list, tuple)):
                flat.extend(item)
            else:
                flat.append(item)
    if not flat:
        return [" " * width for _ in range(height)]
    max_val = max(abs(float(v)) for v in flat) if flat else 1.0
    if max_val == 0:
        max_val = 1.0
    total_cells = width * height
    normalized = []
    for v in flat:
        normalized.append(float(v) / max_val)
    while len(normalized) < total_cells:
        normalized.append(0.0)
    if len(normalized) > total_cells:
        step = len(normalized) / total_cells
        sampled = []
        for i in range(total_cells):
            idx = int(i * step)
            sampled.append(normalized[min(idx, len(normalized) - 1)])
        normalized = sampled
    lines = []
    for r in range(height):
        line = ""
        for c in range(width):
            cell_idx = r * width + c
            ratio = max(0.0, min(1.0, normalized[cell_idx] if cell_idx < len(normalized) else 0.0))
            bi = int(ratio * (len(BRAILLE_BLOCKS) - 1))
            line += BRAILLE_BLOCKS[bi]
        lines.append(line)
    return lines


class WidgetManager:
    def __init__(self, nc, stdp, dims, theme):
        self.nc = nc
        self.stdp = stdp
        self.dims = dims
        self.theme = theme
        self.degraded = []
        self.menu = None
        self.progbar = None
        self.progbar_plane = None
        self.reel = None
        self.reel_plane = None
        self.reel_tablets = []
        self.reader = None
        self.reader_plane = None
        self.selector = None
        self.selector_plane = None
        self.multiselector = None
        self.multiselector_plane = None
        self.sparkline = None
        self.sparkline_plane = None
        self.evo_plot = None
        self.evo_plot_plane = None
        self.budget_progbar = None
        self.budget_progbar_plane = None
        self.visual_plane = None
        self._plot_planes = {}
        self._resize_callback = None
        self._last_dims = dims

    def set_resize_callback(self, callback):
        self._resize_callback = callback

    def check_resize(self):
        try:
            rows, cols = self.stdp.dim_yx()
            new_dims = (rows, cols)
            if new_dims != self._last_dims:
                self._last_dims = new_dims
                self.dims = new_dims
                if self._resize_callback:
                    self._resize_callback(rows, cols)
                return True
        except (AttributeError, ValueError):
            pass
        return False

    def fade_out(self, plane, duration_ms: int = 300) -> bool:
        if hasattr(plane, 'fadeout'):
            plane.fadeout(duration_ms * 1000000)
            return True
        return False

    def fade_in(self, plane, duration_ms: int = 300) -> bool:
        if hasattr(plane, 'fadein'):
            plane.fadein(duration_ms * 1000000)
            return True
        return False

    def fade_plane(self, plane, duration_ms: int = 300) -> bool:
        return self.fade_out(plane, duration_ms)

    def pulse_plane(self, plane, duration_ms: int = 200) -> bool:
        if hasattr(plane, 'pulse'):
            plane.pulse(duration_ms * 1000000, None)
            return True
        return False

    def log_degradation(self, widget: str, error: str = ""):
        import sys
        msg = widget
        if error:
            msg += " (" + error[:60] + ")"
        if msg not in self.degraded:
            self.degraded.append(msg)
            print("NOTCURSES DEGRADED: " + msg, file=sys.stderr)

    def create_menu(self, sections):
        if NcMenu is None or NcMenuItem is None:
            self.log_degradation("NcMenu", "not available")
            return None
        try:
            nc_sections = []
            for sec_name, sec_items in sections:
                items = [NcMenuItem(label, shortcut) for label, shortcut in sec_items]
                nc_sections.append((sec_name, items))
            self.menu = NcMenu.create(self.nc, nc_sections)
            return self.menu
        except RuntimeError as e:
            self.log_degradation("NcMenu", str(e))
            return None

    def offer_menu_input(self, ni) -> Optional[str]:
        if self.menu is None:
            return None
        return self.menu.offer_input(ni)

    def create_progbar(self, parent_plane, y: int, x: int, width: int):
        if NcProgbar is None:
            self.log_degradation("NcProgbar", "not available")
            return None
        try:
            self.progbar_plane = NcPlane(parent_plane, 1, width, y, x)
            self.progbar = NcProgbar(self.progbar_plane)
            return self.progbar
        except RuntimeError as e:
            self.log_degradation("NcProgbar", str(e))
            return None

    def set_progress(self, value: float):
        if self.progbar is not None:
            self.progbar.set_progress(max(0.0, min(1.0, value)))
            return True
        return False

    def create_budget_progbar(self, parent_plane, y: int, x: int, width: int):
        if NcProgbar is None:
            self.log_degradation("NcProgbar", "not available for budget")
            return None
        try:
            self.budget_progbar_plane = NcPlane(parent_plane, 1, width, y, x)
            self.budget_progbar = NcProgbar(self.budget_progbar_plane)
            return self.budget_progbar
        except RuntimeError as e:
            self.log_degradation("NcProgbar budget", str(e))
            return None

    def set_budget_progress(self, value: float):
        if self.budget_progbar is not None:
            self.budget_progbar.set_progress(max(0.0, min(1.0, value)))
            return True
        return False

    def create_reel(self, parent_plane, rows: int, cols: int, y: int, x: int):
        if NcReel is None:
            self.log_degradation("NcReel", "not available")
            return None
        try:
            self.destroy_reel()
            self.reel_plane = NcPlane(parent_plane, rows, cols, y, x)
            if NcReelOptions:
                opts = NcReelOptions()
                self.reel = NcReel.create(self.reel_plane, opts)
            else:
                self.reel = NcReel.create(self.reel_plane)
            self.reel_tablets = []
            return self.reel
        except RuntimeError as e:
            self.log_degradation("NcReel", str(e))
            return None

    def add_reel_tablet(self, draw_callback, data=None):
        if self.reel is None:
            return None
        try:
            tablet = self.reel.add(None, None, draw_callback, data)
            self.reel_tablets.append(tablet)
            return tablet
        except RuntimeError as e:
            self.log_degradation("NcReel.add_tablet", str(e))
            return None

    def reel_next(self):
        if self.reel:
            self.reel.next()

    def reel_prev(self):
        if self.reel:
            self.reel.prev()

    def reel_offer_input(self, ni):
        if self.reel:
            return self.reel.offer_input(ni)
        return False

    def destroy_reel(self):
        if self.reel:
            try:
                self.reel.destroy()
            except RuntimeError:
                pass
            self.reel = None
        if self.reel_plane:
            try:
                self.reel_plane.destroy()
            except RuntimeError:
                pass
            self.reel_plane = None
        self.reel_tablets = []

    def open_reader(self, prompt: str, parent_plane=None):
        if NcReader is None:
            self.log_degradation("NcReader", "not available")
            return False
        try:
            rows, cols = self.dims
            self.destroy_reader()
            p = parent_plane or self.stdp
            self.reader_plane = NcPlane(p, 1, cols, rows - 1, 0)
            r, g, b = self.theme.rgb("mini_fg")
            self.reader_plane.set_fg_rgb8(r, g, b)
            r, g, b = self.theme.rgb("mini_bg")
            self.reader_plane.set_bg_rgb8(r, g, b)
            self.reader_plane.putstr_yx(0, 0, prompt)
            if NcReaderOptions:
                opts = NcReaderOptions()
                self.reader = NcReader.create(self.reader_plane, opts)
            else:
                self.reader = NcReader.create(self.reader_plane)
            return True
        except RuntimeError as e:
            self.log_degradation("NcReader", str(e))
            return False

    def reader_offer_input(self, ni):
        if self.reader:
            try:
                self.reader.offer_input(ni)
            except RuntimeError:
                pass

    def close_reader(self) -> str:
        text = ""
        if self.reader:
            try:
                text = self.reader.contents() or ""
            except RuntimeError:
                pass
        self.destroy_reader()
        return text.strip()

    def destroy_reader(self):
        if self.reader:
            try:
                self.reader.destroy()
            except RuntimeError:
                pass
            self.reader = None
        if self.reader_plane:
            try:
                self.reader_plane.destroy()
            except RuntimeError:
                pass
            self.reader_plane = None

    def create_selector(self, items: list, title: str = "Select"):
        if NcSelector is None or NcSelectorItem is None:
            self.log_degradation("NcSelector", "not available")
            return None
        try:
            rows, cols = self.dims
            sel_w = min(50, cols - 6)
            sel_h = min(len(items) + 4, rows - 6)
            sx = (cols - sel_w) // 2
            sy = (rows - sel_h) // 2
            self.destroy_selector()
            self.selector_plane = NcPlane(self.stdp, sel_h, sel_w, sy, sx)
            self.set_bg_alpha(self.selector_plane)
            nc_items = [NcSelectorItem(label, desc) for label, desc in items]
            self.selector = NcSelector.create(
                self.selector_plane, nc_items, title=title, maxdisplay=sel_h - 3)
            return self.selector
        except RuntimeError as e:
            self.log_degradation("NcSelector", str(e))
            return None

    def create_multiselector(self, items: list, title: str = "Select"):
        if NcMultiSelector is None or NcMultiSelectorItem is None:
            self.log_degradation("NcMultiSelector", "not available")
            return None
        try:
            rows, cols = self.dims
            sel_w = min(55, cols - 6)
            sel_h = min(len(items) + 4, rows - 6)
            sx = (cols - sel_w) // 2
            sy = (rows - sel_h) // 2
            self.destroy_multiselector()
            self.multiselector_plane = NcPlane(self.stdp, sel_h, sel_w, sy, sx)
            self.set_bg_alpha(self.multiselector_plane)
            nc_items = [NcMultiSelectorItem(label, desc, selected)
                        for label, desc, selected in items]
            self.multiselector = NcMultiSelector.create(
                self.multiselector_plane, nc_items, title=title, maxdisplay=sel_h - 3)
            return self.multiselector
        except RuntimeError as e:
            self.log_degradation("NcMultiSelector", str(e))
            return None

    def multiselector_offer_input(self, ni):
        if self.multiselector:
            self.multiselector.offer_input(ni)

    def multiselector_selected(self) -> list:
        if self.multiselector:
            return self.multiselector.selected() or []
        return []

    def destroy_multiselector(self):
        if self.multiselector:
            try:
                self.multiselector.destroy()
            except RuntimeError:
                pass
            self.multiselector = None
        if self.multiselector_plane:
            try:
                self.multiselector_plane.destroy()
            except RuntimeError:
                pass
            self.multiselector_plane = None

    def selector_offer_input(self, ni):
        if self.selector:
            self.selector.offer_input(ni)

    def selector_selected(self) -> Optional[str]:
        if self.selector:
            return self.selector.selected()
        return None

    def destroy_selector(self):
        if self.selector:
            try:
                self.selector.destroy()
            except RuntimeError:
                pass
            self.selector = None
        if self.selector_plane:
            try:
                self.selector_plane.destroy()
            except RuntimeError:
                pass
            self.selector_plane = None

    def create_sparkline(self, parent_plane, rows_h: int, cols_w: int, y: int, x: int,
                         name: str = "main"):
        plot_cls = NcDPlot or NcPlot
        if plot_cls is None:
            self.log_degradation("NcPlot/NcDPlot", "not available")
            return None
        try:
            plane = NcPlane(parent_plane, rows_h, cols_w, y, x)
            opts = {}
            blit = preferred_blitter()
            if blit is not None:
                opts["gridtype"] = blit
            plot = plot_cls.create(plane, **opts)
            if name == "main":
                self.sparkline = plot
                self.sparkline_plane = plane
            else:
                self._plot_planes[name] = (plot, plane)
            return plot
        except RuntimeError as e:
            self.log_degradation("NcPlot/NcDPlot " + name, str(e))
            return None

    def create_inline_plot(self, parent_plane, y: int, x: int, width: int,
                          data: list, name: str = "inline") -> bool:
        plot_cls = NcDPlot or NcPlot
        if plot_cls is None:
            return False
        try:
            plane = NcPlane(parent_plane, 1, width, y, x)
            opts = {}
            blit = preferred_blitter()
            if blit is not None:
                opts["gridtype"] = blit
            plot = plot_cls.create(plane, **opts)
            for val in data:
                plot.add_sample(float(val))
            self._plot_planes[name] = (plot, plane)
            return True
        except RuntimeError as e:
            self.log_degradation("inline_plot " + name, str(e))
            return False

    def add_sparkline_sample(self, value: float, name: str = "main"):
        plot = self.sparkline if name == "main" else self._plot_planes.get(name, (None, None))[0]
        if plot:
            plot.add_sample(value)

    def create_evo_plots(self, parent_plane, y: int, x: int, width: int):
        plots = {}
        plot_cls = NcDPlot or NcPlot
        if plot_cls is None:
            self.log_degradation("NcDPlot", "not available for evolution")
            return plots
        metric_names = ["success", "corrections", "tokens"]
        for i, name in enumerate(metric_names):
            py = y + i * 3
            try:
                plane = NcPlane(parent_plane, 2, width, py, x)
                opts = {}
                blit = preferred_blitter()
                if blit is not None:
                    opts["gridtype"] = blit
                plot = plot_cls.create(plane, **opts)
                self._plot_planes[name] = (plot, plane)
                plots[name] = plot
            except RuntimeError as e:
                self.log_degradation("NcDPlot " + name, str(e))
        return plots

    def destroy_evo_plots(self):
        for name in ["success", "corrections", "tokens"]:
            entry = self._plot_planes.pop(name, None)
            if entry:
                plot, plane = entry
                try:
                    plot.destroy()
                except RuntimeError:
                    pass
                try:
                    plane.destroy()
                except RuntimeError:
                    pass

    def render_visual_media(self, parent_plane, image_path: str, y: int, x: int,
                            height: int, width: int) -> bool:
        if NcVisual is None:
            return self._render_media_escape(image_path, y, x, height, width)
        try:
            if self.visual_plane:
                try:
                    self.visual_plane.destroy()
                except RuntimeError:
                    pass
            vis = NcVisual.from_file(image_path)
            self.visual_plane = NcPlane(parent_plane, height, width, y, x)
            vopts = {}
            blit = preferred_blitter()
            if blit is not None:
                vopts["blitter"] = blit
            if NCSCALE_STRETCH is not None:
                vopts["scaling"] = NCSCALE_STRETCH
            vis.blit(self.visual_plane, **vopts)
            return True
        except RuntimeError as e:
            self.log_degradation("NcVisual.render", str(e))
            return self._render_media_escape(image_path, y, x, height, width)

    def _render_media_escape(self, image_path: str, y: int, x: int,
                             height: int, width: int) -> bool:
        if MEDIA_CAPS.get("kitty"):
            return self._render_kitty(image_path, y, x, height, width)
        if MEDIA_CAPS.get("iterm2"):
            return self._render_iterm2(image_path, y, x, height, width)
        if MEDIA_CAPS.get("sixel"):
            return self._render_sixel(image_path, y, x, height, width)
        return False

    def _render_kitty(self, image_path: str, y: int, x: int,
                      height: int, width: int) -> bool:
        try:
            import base64
            with open(image_path, "rb") as f:
                data = base64.b64encode(f.read()).decode("ascii")
            sys.stdout.write("\033[" + str(y + 1) + ";" + str(x + 1) + "H")
            chunk_size = 4096
            chunks = [data[i:i + chunk_size] for i in range(0, len(data), chunk_size)]
            for i, chunk in enumerate(chunks):
                m = 1 if i < len(chunks) - 1 else 0
                if i == 0:
                    sys.stdout.write("\033_Ga=T,f=100,t=d,m=" + str(m) +
                                     ",r=" + str(height) + ",c=" + str(width) +
                                     ";" + chunk + "\033\\")
                else:
                    sys.stdout.write("\033_Gm=" + str(m) + ";" + chunk + "\033\\")
            sys.stdout.flush()
            return True
        except (IOError, OSError) as e:
            self.log_degradation("kitty render", str(e))
            return False

    def _render_iterm2(self, image_path: str, y: int, x: int,
                       height: int, width: int) -> bool:
        try:
            import base64
            with open(image_path, "rb") as f:
                data = base64.b64encode(f.read()).decode("ascii")
            sys.stdout.write("\033[" + str(y + 1) + ";" + str(x + 1) + "H")
            sys.stdout.write("\033]1337;File=inline=1;width=" + str(width) +
                             ";height=" + str(height) + ":" + data + "\007")
            sys.stdout.flush()
            return True
        except (IOError, OSError) as e:
            self.log_degradation("iterm2 render", str(e))
            return False

    def _render_sixel(self, image_path: str, y: int, x: int,
                      height: int, width: int) -> bool:
        try:
            import subprocess
            result = subprocess.run(
                ["img2sixel", "--width=" + str(width * 8), "--height=" + str(height * 16),
                 image_path],
                capture_output=True, timeout=5)
            if result.returncode == 0:
                sys.stdout.write("\033[" + str(y + 1) + ";" + str(x + 1) + "H")
                sys.stdout.write(result.stdout.decode("ascii", errors="replace"))
                sys.stdout.flush()
                return True
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as e:
            self.log_degradation("sixel render", str(e))
        return False

    def rebuild_selector(self, items: list, title: str = "Select"):
        self.destroy_selector()
        return self.create_selector(items, title)

    def download_and_cache_image(self, url: str) -> Optional[str]:
        if not _validate_media_url(url):
            self.log_degradation("image_download", "blocked URL (SSRF protection): " + url[:80])
            return None
        import hashlib
        import tempfile
        cache_dir = os.path.join(tempfile.gettempdir(), "rachael_media_cache")
        os.makedirs(cache_dir, exist_ok=True)
        url_hash = hashlib.md5(url.encode()).hexdigest()
        ext = ".png"
        for e in (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"):
            if url.lower().endswith(e):
                ext = e
                break
        cached = os.path.join(cache_dir, url_hash + ext)
        if os.path.exists(cached):
            return cached
        import urllib.request
        req = urllib.request.Request(url, method="GET")
        req.add_header("User-Agent", "RachaelTUI/1.0")
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = resp.read(10 * 1024 * 1024)
            with open(cached, "wb") as f:
                f.write(data)
        return cached

    def set_bg_alpha(self, plane, alpha=None):
        if alpha is None:
            alpha = NCALPHA_BLEND
        if alpha is not None:
            try:
                plane.set_bg_alpha(alpha)
                return True
            except RuntimeError:
                pass
        return False
