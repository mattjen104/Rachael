import datetime
import math
import time
from typing import Any, Optional

from nc_widgets import BRAILLE_BLOCKS, braille_bar, braille_sparkline_str, MEDIA_CAPS

STATUS_CHARS = {
    "running": "\u27F3", "queued": "\u2026", "error": "\u2717",
    "completed": "\u2713", "enabled": "\u25CF", "disabled": "\u25CB",
}
VIEWS = ["agenda", "tree", "programs", "results", "reader",
         "cockpit", "snow", "evolution", "transcripts", "voice"]


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


def build_tree_items(data_cache: dict) -> list:
    items = []
    runtime = data_cache.get("runtime", {})
    budget = data_cache.get("budget", {})
    programs = data_cache.get("programs", [])
    tasks_list = data_cache.get("agenda", {}).get("today", [])
    notes = data_cache.get("notes", [])
    skills_list = data_cache.get("skills", [])
    captures = data_cache.get("captures", [])
    reader = data_cache.get("reader", [])

    items.append({"_section": "RUNTIME"})
    items.append({"_tree": "status", "_label": "Active: " + str(runtime.get("active", False))})
    rp = runtime.get("programs", [])
    running_count = sum(1 for p in rp if p.get("status") == "running")
    items.append({"_tree": "status", "_label": "Running: " + str(running_count) + "/" + str(len(rp))})

    items.append({"_section": "BUDGET"})
    spent = budget.get("spent", 0)
    cap = budget.get("dailyCap", 0)
    remaining = max(0, cap - spent)
    pct = min(1.0, spent / cap) if cap > 0 else 0
    bar = braille_bar(pct, 1.0, 8)
    items.append({"_tree": "budget", "_label": bar + " $" + str(round(spent, 4)) + "/$" + str(round(cap, 2))})
    items.append({"_tree": "budget", "_label": "Remaining: $" + str(round(remaining, 4))})

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


def build_evolution_items(api, evo_tab: str) -> list:
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
        items.append({"_tree": "metric", "_label": "Success: " + sr_bar + " " + str(round(sr * 100, 1)) + "%"})
        items.append({"_tree": "metric", "_label": "Total Runs (7d): " + str(m.get("totalRuns", 0))})
        items.append({"_tree": "metric", "_label": "Successful: " + str(m.get("successfulRuns", 0))})
        cr = m.get("correctionRate", 0)
        cr_bar = braille_bar(cr, 1.0, 6)
        items.append({"_tree": "metric", "_label": "Corrections: " + cr_bar + " " + str(round(cr * 100, 1)) + "%"})
        items.append({"_tree": "metric", "_label": "Golden Suite: " + str(state.get("goldenSuiteSize", 0)) + " cases"})
        items.append({"_tree": "metric", "_label": "Pending Obs: " + str(state.get("unconsolidatedObservations", 0))})
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
            items.append({"_tree": "cost", "_label": "Today: $" + str(round(costs.get("today", 0), 4))})
            items.append({"_tree": "cost", "_label": "Cap: $" + str(round(costs.get("cap", 0), 2))})
            items.append({"_tree": "cost", "_label": "Remaining: $" + str(round(costs.get("remaining", 0), 4))})
            breakdown = costs.get("breakdown", {})
            for judge, cost in breakdown.items():
                items.append({"_tree": "cost", "_label": "  " + judge + ": $" + str(round(cost, 4))})
        except Exception:
            items.append({"_tree": "error", "_label": "Failed to load judge costs"})
    return items


def current_items(view: str, data_cache: dict, api, evo_tab: str,
                  reader_reading_id, cockpit_events) -> list:
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
        return build_tree_items(data_cache)
    elif view == "evolution":
        return build_evolution_items(api, evo_tab)
    elif view == "snow":
        return data_cache.get("proposals", [])
    elif view == "transcripts":
        return data_cache.get("transcripts", [])
    elif view == "voice":
        media = []
        for cap_name, available in MEDIA_CAPS.items():
            media.append({"_tree": "info", "_label": cap_name + ": " + ("YES" if available else "NO")})
        return [
            {"_tree": "info", "_label": "Voice commands available via CLI"},
            {"_tree": "info", "_label": "Use X to open CLI prompt"},
            {"_tree": "info", "_label": "Commands: briefing, status, capture <text>"},
            {"_section": "TERMINAL MEDIA SUPPORT"},
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
        return "  " + item.get("_label", "")

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
        line = sc + " " + prog.ljust(13) + summary
        if metric and isinstance(metric, (int, float)):
            bar = braille_bar(metric, max_val=1.0, width=5)
            line += " " + bar + " " + str(round(metric, 2))
        elif metric:
            line += " =" + str(metric)
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
            return (v + " [" + st + "] " + applied)[:max_width]
        if item.get("input"):
            return ("\u25CF " + str(item.get("input", ""))[:max_width - 2])[:max_width]
        if item.get("observationType"):
            ot = item.get("observationType", "")
            content = item.get("content", "")
            consolidated = "\u2713" if item.get("consolidated") else "\u25CB"
            return (consolidated + " [" + ot + "] " + content)[:max_width]

    elif view == "snow":
        title = item.get("title", item.get("description", "?"))
        status = item.get("status", "")
        return (status[:8].ljust(9) + str(title))[:max_width]

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
        created = item.get("createdAt", "")
        if created:
            lines.append("time: " + str(created))
        raw = item.get("rawOutput") or item.get("summary") or ""
        lines.extend(wrap_text(str(raw)[:800], max_width))

    elif view == "reader":
        lines.append("URL: " + str(item.get("url", "")))
        has_media = any(MEDIA_CAPS.values())
        if has_media:
            lines.append("[Media rendering: " + ", ".join(k for k, v in MEDIA_CAPS.items() if v) + "]")
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
            lines.append("Success: " + braille_bar(sr, 1.0, 6) + " " + str(round(sr * 100, 1)) + "%")
            lines.append("Correction: " + braille_bar(cr, 1.0, 6) + " " + str(round(cr * 100, 1)) + "%")
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
                    lines.append(field + ": " + str(diff.get("before", ""))[:30] +
                                 " -> " + str(diff.get("after", ""))[:30])

    elif view == "snow":
        desc = item.get("description", "")
        if desc:
            lines.extend(wrap_text(str(desc)[:400], max_width))
        lines.append("[a:accept  x:reject]")

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
