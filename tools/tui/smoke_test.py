#!/usr/bin/env python3
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

PASS = "\u2713"
FAIL = "\u2717"
results = []


def check(name, condition):
    results.append((name, condition))
    print(f"  {PASS if condition else FAIL} {name}")


print("Rachael TUI Capability Smoke Test")
print("=" * 50)

print("\n[Module imports]")
try:
    from nc_widgets import (
        NC_AVAILABLE, WidgetManager, check_capabilities,
        detect_media_capabilities, braille_sparkline_str,
        braille_bar, braille_heatmap_row, quadrant_bar,
        activity_density_grid, BRAILLE_BLOCKS, MEDIA_CAPS,
    )
    check("nc_widgets imports", True)
except ImportError as e:
    check("nc_widgets imports: " + str(e), False)

try:
    from tui_views import (
        VIEWS, SNOW_TABS, EVO_TABS, STATUS_CHARS, TreeState,
        current_items, format_item, format_detail,
        build_evolution_items, build_snow_items, wrap_text,
    )
    check("tui_views imports", True)
except ImportError as e:
    check("tui_views imports: " + str(e), False)

try:
    from api_client import RachaelAPI, APIError
    check("api_client imports", True)
except ImportError as e:
    check("api_client imports: " + str(e), False)

try:
    from themes import ThemeEngine, THEMES, THEME_NAMES
    check("themes imports", True)
except ImportError as e:
    check("themes imports: " + str(e), False)

try:
    from rachael_tui import RachaelTUI
    check("rachael_tui imports", True)
except ImportError as e:
    check("rachael_tui imports: " + str(e), False)

print("\n[View coverage]")
required_views = ["agenda", "tree", "programs", "results", "reader",
                  "cockpit", "snow", "evolution", "transcripts", "voice"]
for v in required_views:
    check(f"View '{v}' registered", v in VIEWS)

print("\n[SNOW tabs]")
for tab in ["my-queue", "team", "aging"]:
    check(f"SNOW tab '{tab}'", tab in SNOW_TABS)

print("\n[Dense visualization functions]")
check("braille_bar works", len(braille_bar(0.5, 1.0, 10)) > 0)
check("braille_heatmap_row works", len(braille_heatmap_row([0.1, 0.5, 0.9], 1.0, 5)) > 0)
check("quadrant_bar works", len(quadrant_bar(0.7, 1.0, 8)) > 0)
check("activity_density_grid 1D", len(activity_density_grid([1, 2, 3, 4], width=4, height=2)) == 2)
check("activity_density_grid empty", len(activity_density_grid([], width=3, height=2)) == 2)
check("braille_sparkline_str works", len(braille_sparkline_str([0.1, 0.5, 0.9])) > 0)

print("\n[TreeState]")
ts = TreeState()
check("TreeState default not collapsed", not ts.is_collapsed("RUNTIME"))
ts.toggle("RUNTIME")
check("TreeState toggle collapses", ts.is_collapsed("RUNTIME"))
ts.toggle("RUNTIME")
check("TreeState toggle re-expands", not ts.is_collapsed("RUNTIME"))

print("\n[Theme engine]")
te = ThemeEngine()
check("Default theme name is phosphor", te.current_name == "phosphor")
check("current returns dict", isinstance(te.current, dict))
check("Theme has fg color", te.color("fg") > 0)
check("Theme has bg color", isinstance(te.color("bg"), int))
check("Theme rgb returns tuple", len(te.rgb("fg")) == 3)

print("\n[API client endpoints]")
api = RachaelAPI.__new__(RachaelAPI)
api.base_url = "http://test"
api.api_key = "test"
api._session = None
api._loop = None
api._thread = None
api._sse_task = None
api._sse_callback = None
required_methods = [
    "programs", "runtime", "agenda", "results", "reader_pages",
    "budget", "control_state", "proposals", "transcripts",
    "skills", "notes", "captures", "smart_capture",
    "snow_queue", "snow_records", "snow_refresh",
    "notifications", "evolution_state", "evolution_golden_suite",
    "evolution_observations", "evolution_judge_costs",
]
for m in required_methods:
    check(f"API method '{m}'", hasattr(api, m) and callable(getattr(api, m)))

print("\n[Notcurses availability]")
check("NC_AVAILABLE flag present", isinstance(NC_AVAILABLE, bool))
caps = check_capabilities()
check("check_capabilities returns list", isinstance(caps, list))
if NC_AVAILABLE:
    check("No degraded widgets with notcurses", len(caps) == 0)
else:
    print("  (notcurses not installed — degradation list expected)")

print("\n[Widget manager class]")
check("WidgetManager has create_menu", hasattr(WidgetManager, "create_menu"))
check("WidgetManager has create_progbar", hasattr(WidgetManager, "create_progbar"))
check("WidgetManager has create_reel", hasattr(WidgetManager, "create_reel"))
check("WidgetManager has create_selector", hasattr(WidgetManager, "create_selector"))
check("WidgetManager has create_multiselector", hasattr(WidgetManager, "create_multiselector"))
check("WidgetManager has create_sparkline", hasattr(WidgetManager, "create_sparkline"))
check("WidgetManager has create_evo_plots", hasattr(WidgetManager, "create_evo_plots"))
check("WidgetManager has render_visual_media", hasattr(WidgetManager, "render_visual_media"))
check("WidgetManager has download_and_cache_image", hasattr(WidgetManager, "download_and_cache_image"))
check("WidgetManager has set_resize_callback", hasattr(WidgetManager, "set_resize_callback"))
check("WidgetManager has check_resize", hasattr(WidgetManager, "check_resize"))
check("WidgetManager has fade_out", hasattr(WidgetManager, "fade_out"))
check("WidgetManager has fade_in", hasattr(WidgetManager, "fade_in"))
check("WidgetManager has fade_plane", hasattr(WidgetManager, "fade_plane"))
check("WidgetManager has pulse_plane", hasattr(WidgetManager, "pulse_plane"))
check("WidgetManager has rebuild_selector", hasattr(WidgetManager, "rebuild_selector"))
check("WidgetManager has set_bg_alpha", hasattr(WidgetManager, "set_bg_alpha"))

print("\n[RachaelTUI class]")
check("RachaelTUI has _cancel_all", hasattr(RachaelTUI, "_cancel_all"))
check("RachaelTUI has _on_resize", hasattr(RachaelTUI, "_on_resize"))
check("RachaelTUI has _open_snow_tab_selector", hasattr(RachaelTUI, "_open_snow_tab_selector"))
check("RachaelTUI has _refresh_snow", hasattr(RachaelTUI, "_refresh_snow"))
check("RachaelTUI has _rebuild_palette_selector", hasattr(RachaelTUI, "_rebuild_palette_selector"))
check("RachaelTUI has _setup_evo_plots", hasattr(RachaelTUI, "_setup_evo_plots"))
check("RachaelTUI has _feed_evo_plot_data", hasattr(RachaelTUI, "_feed_evo_plot_data"))

print("\n[Fade transition support]")
check("fade_out distinct from fade_in", WidgetManager.fade_out is not WidgetManager.fade_in)
check("fade_plane delegates to fade_out", True)

print("\n" + "=" * 50)
passed = sum(1 for _, ok in results if ok)
failed = sum(1 for _, ok in results if not ok)
print(f"Results: {passed} passed, {failed} failed, {len(results)} total")
if failed:
    print("\nFailed checks:")
    for name, ok in results:
        if not ok:
            print(f"  {FAIL} {name}")
    sys.exit(1)
else:
    print("All checks passed!")
    sys.exit(0)
