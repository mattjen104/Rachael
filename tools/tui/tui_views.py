import datetime
import math
import time
from typing import Any, Optional

from nc_widgets import (
    BRAILLE_BLOCKS, braille_bar, braille_sparkline_str,
    braille_heatmap_row, quadrant_bar, activity_density_grid,
    MEDIA_CAPS,
)

STATUS_CHARS = {
    "running": "\u27F3", "queued": "\u2026", "error": "\u2717",
    "completed": "\u2713", "enabled": "\u25CF", "disabled": "\u25CB",
}
VIEWS = ["agenda", "tree", "programs", "results", "reader",
         "cockpit", "snow", "evolution", "transcripts", "voice"]
SNOW_TABS = ["my-queue", "team", "aging"]
EVO_TABS = ["overview", "versions", "golden", "observations", "costs"]
TREE_SECTIONS = ["RUNTIME", "BUDGET", "PROGRAMS", "TASKS", "NOTES",
                 "SKILLS", "INBOX", "READER", "JOURNAL"]


def wrap_text(text: str, width: int) -> list:
    if width <= 0:
        return []
    lines = []
    for raw_line in text.split("\n"):
        while len(raw_line) > width:
            lines.append(raw_line[:width])
            raw_line = raw_line[width:]
        lines.append(raw_line)
    return lines


class TreeState:
    def __init__(self):
        self.collapsed: set = set()

    def toggle(self, section: str):
        if section in self.collapsed:
            self.collapsed.discard(section)
        else:
            self.collapsed.add(section)

    def is_collapsed(self, section: str) -> bool:
        return section in self.collapsed


def build_agenda_items(data_cache: dict) -> list:
    agenda = data_cache.get("agenda", {})
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


def build_tree_items(data_cache: dict, tree_state: TreeState) -> list:
    items = []
    runtime = data_cache.get("runtime", {})
    budget = data_cache.get("budget", {})
    programs = data_cache.get("programs", [])
    tasks_list = data_cache.get("agenda", {}).get("today", [])
    notes = data_cache.get("notes", [])
    skills_list = data_cache.get("skills", [])
    captures = data_cache.get("captures", [])
    reader = data_cache.get("reader", [])
    snow_records = data_cache.get("snow_records", [])

    sections = [
        ("RUNTIME", _tree_runtime_children, [runtime]),
        ("BUDGET", _tree_budget_children, [budget]),
        ("PROGRAMS (" + str(len(programs)) + ")", _tree_list_children, [programs]),
        ("TASKS (" + str(len(tasks_list)) + ")", _tree_list_children, [tasks_list]),
        ("NOTES (" + str(len(notes)) + ")", _tree_list_children, [notes]),
        ("SKILLS (" + str(len(skills_list)) + ")", _tree_list_children, [skills_list]),
        ("INBOX (" + str(len(captures)) + ")", _tree_list_children, [captures]),
        ("READER (" + str(len(reader)) + ")", _tree_list_children, [reader]),
        ("SNOW (" + str(len(snow_records)) + ")", _tree_list_children, [snow_records]),
    ]

    for sec_label, child_fn, args in sections:
        sec_key = sec_label.split(" ")[0]
        collapsed = tree_state.is_collapsed(sec_key)
        caret = "\u25B8" if collapsed else "\u25BE"
        items.append({"_section": caret + " " + sec_label, "_sec_key": sec_key, "_collapsible": True})
        if not collapsed:
            children = child_fn(*args)
            items.extend(children)

    return items


def _tree_runtime_children(runtime: dict) -> list:
    children = []
    children.append({"_tree": "status", "_label": "Active: " + str(runtime.get("active", False)),
                     "_depth": 1})
    rp = runtime.get("programs", [])
    running_count = sum(1 for p in rp if p.get("status") == "running")
    children.append({"_tree": "status", "_label": "Running: " + str(running_count) + "/" + str(len(rp)),
                     "_depth": 1})
    for p in rp:
        status = p.get("status", "?")
        sc = STATUS_CHARS.get(status, "\u25CB")
        children.append({"_tree": "program", "_label": "  " + sc + " " + p.get("name", "?") +
                         " [" + status + "]", "_depth": 2})
    return children


def _tree_budget_children(budget: dict) -> list:
    children = []
    spent = budget.get("spent", 0)
    cap = budget.get("dailyCap", 0)
    remaining = max(0, cap - spent)
    pct = min(1.0, spent / cap) if cap > 0 else 0
    bar = braille_bar(pct, 1.0, 8)
    children.append({"_tree": "budget", "_label": bar + " $" + str(round(spent, 4)) + "/$" + str(round(cap, 2)),
                     "_depth": 1, "_progbar_val": pct})
    children.append({"_tree": "budget", "_label": "Remaining: $" + str(round(remaining, 4)),
                     "_depth": 1})
    qbar = quadrant_bar(pct, 1.0, 10)
    children.append({"_tree": "budget", "_label": "Burn: " + qbar, "_depth": 1})
    return children


def _tree_list_children(item_list: list) -> list:
    children = []
    for item in item_list:
        if isinstance(item, dict):
            item["_depth"] = 1
        children.append(item)
    return children


def build_snow_items(data_cache: dict, snow_tab: str, api) -> list:
    items = []
    tab_labels = {"my-queue": "MY QUEUE", "team": "TEAM WORKLOAD", "aging": "AGING / SLA RISK"}
    tab_line = ""
    for t in SNOW_TABS:
        if t == snow_tab:
            tab_line += " [" + tab_labels[t] + "]"
        else:
            tab_line += "  " + tab_labels[t]
    items.append({"_section": tab_line})

    snow_data = data_cache.get("snow_queue", {})
    if not snow_data:
        try:
            snow_data = api.snow_queue()
            data_cache["snow_queue"] = snow_data
        except Exception:
            snow_data = {}
    records = snow_data.get("records", [])
    if not records:
        records = data_cache.get("snow_records", [])
        if not records:
            try:
                records = api.snow_records()
                data_cache["snow_records"] = records
            except Exception:
                records = []

    if snow_tab == "my-queue":
        pending = [r for r in records if r.get("state", "").lower() in
                   ("new", "pending", "open", "1")]
        items.append({"_section": "PENDING (" + str(len(pending)) + ")"})
        for r in pending:
            items.append(_snow_record_to_item(r))
        in_progress = [r for r in records if r.get("state", "").lower() in
                       ("in_progress", "active", "2", "work in progress")]
        if in_progress:
            items.append({"_section": "IN PROGRESS (" + str(len(in_progress)) + ")"})
            for r in in_progress:
                items.append(_snow_record_to_item(r))
    elif snow_tab == "team":
        by_assignee: dict = {}
        for r in records:
            assignee = (r.get("assigned_to", "") or
                        r.get("assignedTo", "") or
                        r.get("assignment_group", "") or "unassigned")
            by_assignee.setdefault(assignee, []).append(r)
        for assignee, group in sorted(by_assignee.items()):
            load_bar = braille_bar(len(group), max(10, len(records)), 5)
            items.append({"_section": assignee.upper() + " " + load_bar + " (" + str(len(group)) + ")"})
            for r in group:
                items.append(_snow_record_to_item(r))
    elif snow_tab == "aging":
        now = time.time() * 1000
        aged = []
        for r in records:
            created = r.get("sys_created_on", "") or r.get("createdAt", "") or r.get("opened_at", "")
            ts = 0
            if isinstance(created, (int, float)):
                ts = created
            elif isinstance(created, str) and created:
                try:
                    ts = datetime.datetime.fromisoformat(
                        created.replace("Z", "+00:00")).timestamp() * 1000
                except ValueError:
                    ts = 0
            age_hours = (now - ts) / 3600000 if ts else 0
            r_copy = _snow_record_to_item(r)
            r_copy["_age_hours"] = age_hours
            aged.append(r_copy)
        aged.sort(key=lambda x: x.get("_age_hours", 0), reverse=True)
        sla_risk = [a for a in aged if a.get("_age_hours", 0) > 24]
        normal = [a for a in aged if a.get("_age_hours", 0) <= 24]
        if sla_risk:
            items.append({"_section": "SLA RISK >24h (" + str(len(sla_risk)) + ")"})
            items.extend(sla_risk)
        items.append({"_section": "NORMAL (" + str(len(normal)) + ")"})
        items.extend(normal)

    return items


def _snow_record_to_item(r: dict) -> dict:
    return {
        "id": r.get("sys_id", "") or r.get("number", "") or r.get("id", ""),
        "number": r.get("number", ""),
        "title": r.get("short_description", "") or r.get("title", "") or r.get("description", ""),
        "status": r.get("state", "") or r.get("status", ""),
        "priority": r.get("priority", "") or r.get("urgency", ""),
        "assignee": (r.get("assigned_to", "") or r.get("assignedTo", "") or
                     r.get("assignment_group", "")),
        "category": r.get("category", "") or r.get("type", ""),
        "createdAt": r.get("sys_created_on", "") or r.get("createdAt", "") or r.get("opened_at", ""),
        "_raw": r,
    }


def build_evolution_items(api, evo_tab: str, data_cache: dict) -> list:
    items = []
    try:
        state = api.evolution_state()
    except Exception:
        items.append({"_tree": "error", "_label": "Failed to load evolution state"})
        return items

    if evo_tab == "overview":
        items.append({"_section": "EVOLUTION v" + str(state.get("currentVersion", 0))})
        m = state.get("metrics", {})
        sr = m.get("successRate", 0)
        sr_bar = braille_bar(sr, 1.0, 6)
        cr = m.get("correctionRate", 0)
        cr_bar = braille_bar(cr, 1.0, 6)
        total_runs = m.get("totalRuns", 0)
        successful = m.get("successfulRuns", 0)
        tokens_used = m.get("tokensUsed", 0)

        items.append({"_tree": "metric", "_label": "Success: " + sr_bar + " " + str(round(sr * 100, 1)) + "%",
                      "_metric_key": "success", "_metric_val": sr})
        items.append({"_tree": "metric", "_label": "Total Runs (7d): " + str(total_runs)})
        items.append({"_tree": "metric", "_label": "Successful: " + str(successful)})
        items.append({"_tree": "metric", "_label": "Corrections: " + cr_bar + " " + str(round(cr * 100, 1)) + "%",
                      "_metric_key": "corrections", "_metric_val": cr})
        items.append({"_tree": "metric", "_label": "Golden Suite: " + str(state.get("goldenSuiteSize", 0)) + " cases"})
        items.append({"_tree": "metric", "_label": "Pending Obs: " + str(state.get("unconsolidatedObservations", 0))})
        if tokens_used:
            tok_bar = braille_bar(tokens_used, max(tokens_used, 100000), 8)
            items.append({"_tree": "metric", "_label": "Tokens: " + tok_bar + " " + str(tokens_used),
                          "_metric_key": "tokens", "_metric_val": tokens_used})

        versions = state.get("recentVersions", [])
        if versions:
            sr_history = [v.get("metricsSnapshot", {}).get("successRate", 0) for v in versions]
            items.append({"_tree": "metric", "_label": "Success Trend: " + braille_sparkline_str(sr_history)})
            cr_history = [v.get("metricsSnapshot", {}).get("correctionRate", 0) for v in versions]
            items.append({"_tree": "metric", "_label": "Correction Trend: " + braille_sparkline_str(cr_history)})
            burn_history = [v.get("metricsSnapshot", {}).get("totalRuns", 0) for v in versions]
            items.append({"_tree": "density", "_label": "Activity: " + braille_heatmap_row(
                [float(x) for x in burn_history], max(1, max(burn_history) if burn_history else 1), 15)})
            grid_data = [v.get("metricsSnapshot", {}).get("totalRuns", 0) for v in versions]
            grid_lines = activity_density_grid(grid_data, width=min(20, len(grid_data)), height=2)
            for gl in grid_lines:
                items.append({"_tree": "density", "_label": "  " + gl})

    elif evo_tab == "versions":
        versions = state.get("recentVersions", [])
        items.append({"_section": "VERSIONS (" + str(len(versions)) + ")"})
        for v in versions:
            items.append(v)
    elif evo_tab == "golden":
        try:
            suite = api.evolution_golden_suite()
            items.append({"_section": "GOLDEN SUITE (" + str(len(suite)) + ")"})
            items.extend(suite)
        except Exception:
            items.append({"_tree": "error", "_label": "Failed to load golden suite"})
    elif evo_tab == "observations":
        try:
            obs = api.evolution_observations()
            items.append({"_section": "OBSERVATIONS (" + str(len(obs)) + ")"})
            items.extend(obs)
        except Exception:
            items.append({"_tree": "error", "_label": "Failed to load observations"})
    elif evo_tab == "costs":
        try:
            costs = api.evolution_judge_costs()
            items.append({"_section": "JUDGE COSTS"})
            today_cost = costs.get("today", 0)
            cap_cost = costs.get("cap", 0)
            remaining = costs.get("remaining", 0)
            items.append({"_tree": "cost", "_label": "Today: $" + str(round(today_cost, 4)) +
                          "  " + braille_bar(today_cost, max(cap_cost, 0.01), 6)})
            items.append({"_tree": "cost", "_label": "Cap: $" + str(round(cap_cost, 2))})
            items.append({"_tree": "cost", "_label": "Remaining: $" + str(round(remaining, 4))})
            breakdown = costs.get("breakdown", {})
            if breakdown:
                max_cost = max(breakdown.values()) if breakdown.values() else 1
                for judge, cost in breakdown.items():
                    bar = braille_bar(cost, max(max_cost, 0.001), 5)
                    items.append({"_tree": "cost", "_label": "  " + judge + ": " + bar + " $" + str(round(cost, 4))})
        except Exception:
            items.append({"_tree": "error", "_label": "Failed to load judge costs"})
    return items


def current_items(view: str, data_cache: dict, api, evo_tab: str,
                  reader_reading_id, cockpit_events,
                  tree_state: Optional[TreeState] = None,
                  snow_tab: str = "my-queue") -> list:
    if view == "programs":
        return data_cache.get("programs", [])
    elif view == "results":
        return data_cache.get("results", [])
    elif view == "reader":
        if reader_reading_id:
            return []
        return data_cache.get("reader", [])
    elif view == "agenda":
        return build_agenda_items(data_cache)
    elif view == "cockpit":
        return list(cockpit_events)
    elif view == "tree":
        ts = tree_state or TreeState()
        return build_tree_items(data_cache, ts)
    elif view == "evolution":
        return build_evolution_items(api, evo_tab, data_cache)
    elif view == "snow":
        return build_snow_items(data_cache, snow_tab, api)
    elif view == "transcripts":
        return data_cache.get("transcripts", [])
    elif view == "voice":
        media = []
        for cap_name, available in MEDIA_CAPS.items():
            status_icon = "\u2713" if available else "\u2717"
            media.append({"_tree": "info", "_label": status_icon + " " + cap_name +
                          ": " + ("supported" if available else "not detected")})
        return [
            {"_section": "VOICE COMMANDS"},
            {"_tree": "info", "_label": "Use X to open CLI prompt"},
            {"_tree": "info", "_label": "Commands: briefing, status, capture <text>"},
            {"_section": "TERMINAL MEDIA CAPABILITIES"},
        ] + media
    return []


def format_item(item, max_width: int, view: str, data_cache: dict) -> str:
    if not isinstance(item, dict):
        return str(item)[:max_width]
    if "_section" in item:
        label = item["_section"]
        dashes = max(0, max_width - len(label) - 4)
        return "\u2500\u2500 " + label + " " + "\u2500" * dashes
    if "_tree" in item:
        depth = item.get("_depth", 0)
        indent = "  " * (depth + 1)
        return indent + item.get("_label", "")

    if view == "programs" or (view == "tree" and item.get("name") and item.get("instructions")):
        enabled = item.get("enabled", False)
        name = item.get("name", "?")
        cost = item.get("costTier", "")
        sched = item.get("schedule", "")
        runtime = data_cache.get("runtime", {})
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

    elif view == "results":
        status = item.get("status", "")
        sc = "\u2713" if status == "ok" else "\u2717"
        prog = (item.get("programName", "") or "")[:12]
        summary = item.get("summary", "") or ""
        metric = item.get("metric")
        tokens = item.get("tokensUsed", 0)
        line = sc + " " + prog.ljust(13) + summary
        if metric and isinstance(metric, (int, float)):
            bar = braille_bar(metric, max_val=1.0, width=5)
            line += " " + bar + " " + str(round(metric, 2))
        elif metric:
            line += " =" + str(metric)
        if tokens and isinstance(tokens, (int, float)):
            tok_bar = quadrant_bar(tokens, 4000, 3)
            line += " " + tok_bar
        return line[:max_width]

    elif view == "reader":
        title = item.get("title", "?")
        domain = item.get("domain", "")
        return ("\u25A0 " + title + "  [" + domain + "]")[:max_width]

    elif view == "cockpit":
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

    elif view == "agenda":
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

    elif view == "evolution":
        if item.get("version") is not None:
            v = "v" + str(item.get("version", 0))
            st = item.get("status", "")
            applied = str(item.get("appliedAt", ""))[:10]
            ms = item.get("metricsSnapshot", {})
            sr = ms.get("successRate", 0) if ms else 0
            sr_mini = braille_bar(sr, 1.0, 3) if sr else ""
            return (v + " [" + st + "] " + sr_mini + " " + applied)[:max_width]
        if item.get("input"):
            return ("\u25CF " + str(item.get("input", ""))[:max_width - 2])[:max_width]
        if item.get("observationType"):
            ot = item.get("observationType", "")
            content = item.get("content", "")
            consolidated = "\u2713" if item.get("consolidated") else "\u25CB"
            return (consolidated + " [" + ot + "] " + content)[:max_width]

    elif view == "snow":
        number = item.get("number", "")
        title = item.get("title", item.get("short_description", item.get("description", "?")))
        status = item.get("status", item.get("state", ""))
        priority = item.get("priority", "")
        age_h = item.get("_age_hours")
        age_str = ""
        if age_h is not None:
            if age_h > 48:
                age_str = " \u26A0" + str(int(age_h)) + "h"
            elif age_h > 24:
                age_str = " " + str(int(age_h)) + "h"
        prefix = ""
        if number:
            prefix = number + " "
        if priority:
            prefix += "P" + str(priority) + " "
        return (prefix + status[:8].ljust(9) + str(title) + age_str)[:max_width]

    elif view == "transcripts":
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


def format_detail(item: dict, max_width: int, view: str, data_cache: dict) -> list:
    lines = []
    if view == "programs":
        instr = item.get("instructions", "")
        if instr:
            lines.extend(wrap_text(instr[:300], max_width))
        lines.append("type: " + str(item.get("type", "?")) + "  lang: " + str(item.get("codeLang", "?")))
        if item.get("computeTarget") and item["computeTarget"] != "local":
            lines.append("target: " + item["computeTarget"])
        runtime = data_cache.get("runtime", {})
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
                lines.extend("  " + c for c in wrap_text(str(last_out)[:300], max_width))
            err = rp.get("error")
            if err:
                lines.append("ERROR: " + str(err)[:max_width])
        lines.append("[Enter:toggle  r:trigger  R:runtime  M:multi-select]")

    elif view == "results":
        lines.append("model: " + str(item.get("model", "?")) +
                      "  tokens: " + str(item.get("tokensUsed", 0)) +
                      "  iter: " + str(item.get("iteration", 0)))
        tokens = item.get("tokensUsed", 0)
        if tokens and isinstance(tokens, (int, float)):
            tok_bar = braille_bar(tokens, max_val=4000, width=8)
            lines.append("tokens: " + tok_bar + " " + str(tokens))
        cost = item.get("cost", 0)
        if cost and isinstance(cost, (int, float)):
            cost_bar = quadrant_bar(cost, 0.1, 6)
            lines.append("cost:   " + cost_bar + " $" + str(round(cost, 6)))
        created = item.get("createdAt", "")
        if created:
            lines.append("time: " + str(created))
        raw = item.get("rawOutput") or item.get("summary") or ""
        lines.extend(wrap_text(str(raw)[:800], max_width))

    elif view == "reader":
        lines.append("URL: " + str(item.get("url", "")))
        has_media = any(MEDIA_CAPS.values())
        if has_media:
            supported = [k for k, v in MEDIA_CAPS.items() if v]
            lines.append("[Media: " + ", ".join(supported) + "]")
        else:
            lines.append("[No media rendering available]")
        text = item.get("extractedText", "")
        lines.extend(wrap_text(str(text)[:400], max_width))

    elif view == "cockpit":
        data = item.get("data", {})
        if data and isinstance(data, dict):
            for k, v in data.items():
                lines.append(str(k) + ": " + str(v)[:max_width - len(str(k)) - 2])
        sid = item.get("sessionId")
        if sid:
            lines.append("session: " + str(sid))

    elif view == "agenda":
        body = item.get("body") or item.get("rawOutput") or ""
        tags = item.get("tags")
        if tags:
            lines.append("tags: " + str(tags))
        if body:
            lines.extend(wrap_text(str(body)[:400], max_width))

    elif view == "evolution":
        ms = item.get("metricsSnapshot", {})
        if ms:
            sr = ms.get("successRate", 0)
            cr = ms.get("correctionRate", 0)
            lines.append("Success:    " + braille_bar(sr, 1.0, 8) + " " + str(round(sr * 100, 1)) + "%")
            lines.append("Correction: " + braille_bar(cr, 1.0, 8) + " " + str(round(cr * 100, 1)) + "%")
            lines.append("Runs: " + str(ms.get("totalRuns", 0)))
            tokens = ms.get("tokensUsed", 0)
            if tokens:
                lines.append("Tokens:     " + braille_bar(tokens, 100000, 8) + " " + str(tokens))
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
                    lines.append(field + ": " + str(diff.get("before", ""))[:30] +
                                 " \u2192 " + str(diff.get("after", ""))[:30])

    elif view == "snow":
        number = item.get("number", "")
        if number:
            lines.append("Number: " + number)
        assignee = item.get("assignee", "")
        if assignee:
            lines.append("Assigned: " + str(assignee))
        category = item.get("category", "")
        if category:
            lines.append("Category: " + str(category))
        priority = item.get("priority", "")
        if priority:
            lines.append("Priority: " + str(priority))
        created = item.get("createdAt", "")
        if created:
            lines.append("Created: " + str(created)[:19])
        desc = item.get("title", item.get("description", ""))
        if desc:
            lines.extend(wrap_text(str(desc)[:400], max_width))
        age_h = item.get("_age_hours")
        if age_h is not None:
            lines.append("Age: " + str(int(age_h)) + "h")
        lines.append("[Tab:switch-tab]")

    elif view == "transcripts":
        raw = item.get("rawText", "")
        if raw:
            lines.extend(wrap_text(str(raw)[:500], max_width))
        src = item.get("sourceUrl", "")
        if src:
            lines.append("source: " + str(src))
        segments = item.get("segments")
        if segments and isinstance(segments, list):
            lines.append("segments: " + str(len(segments)))

    return lines[:30]
