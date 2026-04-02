import os
import json
from typing import Optional

THEMES = {
    "phosphor": {
        "name": "Phosphor Green",
        "fg": 0x33FF33,
        "bg": 0x0A0A0A,
        "dim": 0x1A6B1A,
        "accent": 0x66FF66,
        "error": 0xFF3333,
        "warn": 0xFFB000,
        "info": 0x33FF33,
        "success": 0x33FF33,
        "border": 0x1A6B1A,
        "header_fg": 0x0A0A0A,
        "header_bg": 0x33FF33,
        "sel_fg": 0x0A0A0A,
        "sel_bg": 0x33FF33,
        "mode_line_fg": 0x0A0A0A,
        "mode_line_bg": 0x1A6B1A,
        "mini_fg": 0x33FF33,
        "mini_bg": 0x111111,
    },
    "amber": {
        "name": "Amber CRT",
        "fg": 0xFFB000,
        "bg": 0x0A0800,
        "dim": 0x7A5500,
        "accent": 0xFFCC33,
        "error": 0xFF3333,
        "warn": 0xFFB000,
        "info": 0xFFB000,
        "success": 0x33FF33,
        "border": 0x7A5500,
        "header_fg": 0x0A0800,
        "header_bg": 0xFFB000,
        "sel_fg": 0x0A0800,
        "sel_bg": 0xFFB000,
        "mode_line_fg": 0x0A0800,
        "mode_line_bg": 0x7A5500,
        "mini_fg": 0xFFB000,
        "mini_bg": 0x111100,
    },
    "cool-blue": {
        "name": "Cool Blue",
        "fg": 0x00AAFF,
        "bg": 0x0A0A1A,
        "dim": 0x005580,
        "accent": 0x33CCFF,
        "error": 0xFF4444,
        "warn": 0xFFCC00,
        "info": 0x00AAFF,
        "success": 0x33FF33,
        "border": 0x005580,
        "header_fg": 0x0A0A1A,
        "header_bg": 0x00AAFF,
        "sel_fg": 0x0A0A1A,
        "sel_bg": 0x00AAFF,
        "mode_line_fg": 0x0A0A1A,
        "mode_line_bg": 0x005580,
        "mini_fg": 0x00AAFF,
        "mini_bg": 0x0A0A1A,
    },
    "solarized": {
        "name": "Solarized Dark",
        "fg": 0x839496,
        "bg": 0x002B36,
        "dim": 0x586E75,
        "accent": 0x268BD2,
        "error": 0xDC322F,
        "warn": 0xB58900,
        "info": 0x2AA198,
        "success": 0x859900,
        "border": 0x073642,
        "header_fg": 0x002B36,
        "header_bg": 0x268BD2,
        "sel_fg": 0x002B36,
        "sel_bg": 0x268BD2,
        "mode_line_fg": 0xFDF6E3,
        "mode_line_bg": 0x073642,
        "mini_fg": 0x839496,
        "mini_bg": 0x073642,
    },
    "dracula": {
        "name": "Dracula",
        "fg": 0xF8F8F2,
        "bg": 0x282A36,
        "dim": 0x6272A4,
        "accent": 0xBD93F9,
        "error": 0xFF5555,
        "warn": 0xF1FA8C,
        "info": 0x8BE9FD,
        "success": 0x50FA7B,
        "border": 0x44475A,
        "header_fg": 0x282A36,
        "header_bg": 0xBD93F9,
        "sel_fg": 0x282A36,
        "sel_bg": 0xBD93F9,
        "mode_line_fg": 0xF8F8F2,
        "mode_line_bg": 0x44475A,
        "mini_fg": 0xF8F8F2,
        "mini_bg": 0x44475A,
    },
    "red-alert": {
        "name": "Red Alert",
        "fg": 0xFF3333,
        "bg": 0x0A0000,
        "dim": 0x801A1A,
        "accent": 0xFF6666,
        "error": 0xFF0000,
        "warn": 0xFF6600,
        "info": 0xFF3333,
        "success": 0x33FF33,
        "border": 0x801A1A,
        "header_fg": 0x0A0000,
        "header_bg": 0xFF3333,
        "sel_fg": 0x0A0000,
        "sel_bg": 0xFF3333,
        "mode_line_fg": 0x0A0000,
        "mode_line_bg": 0x801A1A,
        "mini_fg": 0xFF3333,
        "mini_bg": 0x110000,
    },
}

THEME_NAMES = list(THEMES.keys())
CONF_DIR = os.path.expanduser("~/.rachael")
CONF_FILE = os.path.join(CONF_DIR, "tui.conf")


class ThemeEngine:
    def __init__(self):
        self._current = "phosphor"
        self._load()

    def _load(self):
        if os.path.exists(CONF_FILE):
            try:
                with open(CONF_FILE) as f:
                    data = json.load(f)
                name = data.get("theme", "phosphor")
                if name in THEMES:
                    self._current = name
            except Exception:
                pass

    def _save(self):
        os.makedirs(CONF_DIR, exist_ok=True)
        data = {}
        if os.path.exists(CONF_FILE):
            try:
                with open(CONF_FILE) as f:
                    data = json.load(f)
            except Exception:
                pass
        data["theme"] = self._current
        with open(CONF_FILE, "w") as f:
            json.dump(data, f, indent=2)

    @property
    def current(self) -> dict:
        return THEMES[self._current]

    @property
    def current_name(self) -> str:
        return self._current

    def set_theme(self, name: str) -> bool:
        if name in THEMES:
            self._current = name
            self._save()
            return True
        return False

    def next_theme(self):
        idx = THEME_NAMES.index(self._current)
        self._current = THEME_NAMES[(idx + 1) % len(THEME_NAMES)]
        self._save()

    def color(self, key: str) -> int:
        return self.current.get(key, self.current["fg"])

    def rgb(self, key: str) -> tuple:
        c = self.color(key)
        return ((c >> 16) & 0xFF, (c >> 8) & 0xFF, c & 0xFF)
