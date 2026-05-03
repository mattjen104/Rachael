import { db } from "../server/db";
import { programs, agentResults, recipes, agentConfig } from "../shared/schema";
import { desc, gte, eq } from "drizzle-orm";
import { mkdir, rm, writeFile } from "fs/promises";
import { join } from "path";

const OUT_DIR = "docs/nightly-digest";
const WINDOW_DAYS = 35;

function fmtDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return d.toISOString().replace("T", " ").slice(0, 16) + "Z";
}

function fmtDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function fence(s: string, lang = ""): string {
  const safe = (s || "").replace(/```/g, "``\u200b`");
  return "```" + lang + "\n" + safe + "\n```";
}

function escapePipes(s: string): string {
  return (s || "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function parseMealSummary(text: string): { recipe: string; kiddo: string } | null {
  const m = text.match(/Recipe:\s*(.+?)\s*[|¦]\s*Kiddo:\s*(.+?)\s*$/m);
  if (!m) return null;
  return { recipe: m[1].trim(), kiddo: m[2].trim() };
}

async function main() {
  const generatedAt = new Date();
  const windowStart = new Date(generatedAt.getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  console.log(`[digest] Building nightly digest (window: last ${WINDOW_DAYS} days)`);

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });

  const allPrograms = await db.select().from(programs).orderBy(programs.name);
  const allResults = await db
    .select()
    .from(agentResults)
    .where(gte(agentResults.createdAt, windowStart))
    .orderBy(desc(agentResults.createdAt));

  const byProgram = new Map<string, typeof allResults>();
  for (const r of allResults) {
    const arr = byProgram.get(r.programName) ?? [];
    arr.push(r);
    byProgram.set(r.programName, arr);
  }

  const programStats = allPrograms.map((p) => {
    const runs = byProgram.get(p.name) ?? [];
    const ok = runs.filter((r) => r.status === "ok");
    const err = runs.filter((r) => r.status !== "ok");
    const lastOk = ok[0]?.createdAt ?? null;
    return { program: p, runs, ok, err, lastOk };
  });

  // ---------- per-program pages ----------
  for (const { program: p, runs, ok, err, lastOk } of programStats) {
    const file = join(OUT_DIR, `${slug(p.name)}.md`);
    const lines: string[] = [];
    lines.push(`# ${p.name}`);
    lines.push("");
    lines.push(`[← Back to index](./README.md)`);
    lines.push("");
    lines.push(`- **Type:** ${p.type}`);
    lines.push(`- **Schedule:** ${p.schedule ?? "—"}${p.cronExpression ? ` (\`${p.cronExpression}\`)` : ""}`);
    lines.push(`- **Enabled:** ${p.enabled ? "yes" : "no"}`);
    lines.push(`- **Cost tier:** ${p.costTier}`);
    lines.push(`- **Tags:** ${(p.tags ?? []).join(", ") || "—"}`);
    lines.push(`- **Last successful run:** ${fmtDate(lastOk)}`);
    lines.push("");
    lines.push("## Description");
    lines.push("");
    lines.push(p.instructions?.trim() ? p.instructions : "_No description available._");
    lines.push("");
    lines.push("## Health (last 35 days)");
    lines.push("");
    lines.push(`- ✅ Successful runs: **${ok.length}**`);
    lines.push(`- ❌ Errored runs: **${err.length}**`);
    lines.push(`- Total runs in window: ${runs.length}`);
    if (err.length > 0) {
      const errCounts = new Map<string, number>();
      for (const e of err) {
        const key = (e.summary || "").split("\n")[0].slice(0, 160);
        errCounts.set(key, (errCounts.get(key) ?? 0) + 1);
      }
      const top = [...errCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
      lines.push("");
      lines.push("Top error patterns:");
      for (const [msg, n] of top) {
        lines.push(`- \`${msg.replace(/`/g, "'")}\` × ${n}`);
      }
    }
    lines.push("");
    lines.push("## Successful runs (newest first)");
    lines.push("");
    if (ok.length === 0) {
      lines.push("_No successful runs in the last 35 days._");
    } else {
      for (const r of ok) {
        lines.push(`<a id="run-${r.id}"></a>`);
        lines.push(`### ${fmtDate(r.createdAt)} — run #${r.id}`);
        lines.push("");
        const meta: string[] = [];
        if (r.model) meta.push(`model: \`${r.model}\``);
        if (r.tokensUsed != null) meta.push(`tokens: ${r.tokensUsed}`);
        if (r.metric) meta.push(`metric: ${r.metric}`);
        if (meta.length) lines.push(meta.join(" · "));
        lines.push("");
        lines.push("**Summary:**");
        lines.push("");
        lines.push(fence(r.summary || ""));
        if (r.rawOutput && r.rawOutput.trim() && r.rawOutput.trim() !== (r.summary || "").trim()) {
          lines.push("");
          lines.push("<details><summary>Raw output</summary>");
          lines.push("");
          lines.push(fence(r.rawOutput));
          lines.push("");
          lines.push("</details>");
        }
        lines.push("");
      }
    }
    await writeFile(file, lines.join("\n"));
  }

  // ---------- recipes.md ----------
  {
    const mealRuns = (byProgram.get("nightly-meal-recommender") ?? []).filter((r) => r.status === "ok");
    const lines: string[] = [];
    lines.push(`# Recipes & Meal Suggestions`);
    lines.push("");
    lines.push(`[← Back to index](./README.md)`);
    lines.push("");
    lines.push(`Successful nightly meal recommender runs over the last ${WINDOW_DAYS} days.`);
    lines.push("");

    // Dietary / pantry context the meal recommender uses
    interface MealPrefs {
      householdSize?: number;
      appliances?: string[];
      kiddoName?: string;
      kiddoCurrentFavorites?: string[];
      cuisinePreferences?: string[];
    }
    function asStringArray(v: unknown): string[] {
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    }
    function coerceMealPrefs(raw: unknown): MealPrefs {
      if (!raw || typeof raw !== "object") return {};
      const r = raw as Record<string, unknown>;
      return {
        householdSize: typeof r.householdSize === "number" ? r.householdSize : undefined,
        kiddoName: typeof r.kiddoName === "string" ? r.kiddoName : undefined,
        appliances: asStringArray(r.appliances),
        cuisinePreferences: asStringArray(r.cuisinePreferences),
        kiddoCurrentFavorites: asStringArray(r.kiddoCurrentFavorites),
      };
    }
    const DEFAULT_PREFS: MealPrefs = {
      householdSize: 3,
      appliances: ["Instant Pot", "sous vide", "rice cooker", "stove", "toaster oven", "crockpot"],
      kiddoName: "Willa",
      kiddoCurrentFavorites: ["Go-Gurt", "chicken nuggets", "Goldfish crackers"],
      cuisinePreferences: ["American", "Italian", "Mexican", "Asian"],
    };
    const dietaryCfgRow = await db
      .select()
      .from(agentConfig)
      .where(eq(agentConfig.key, "meals_dietary_prefs"));
    let prefs: MealPrefs = DEFAULT_PREFS;
    let prefsSource = "defaults from `nightly-meal-recommender` code (no `meals_dietary_prefs` config row found)";
    if (dietaryCfgRow[0]?.value) {
      try {
        prefs = coerceMealPrefs(JSON.parse(dietaryCfgRow[0].value));
        prefsSource = "agent_config: `meals_dietary_prefs`";
      } catch {
        prefsSource = "agent_config: `meals_dietary_prefs` (failed to parse, showing defaults)";
      }
    }
    lines.push("## Dietary & pantry context");
    lines.push("");
    lines.push(`_Source: ${prefsSource}._`);
    lines.push("");
    lines.push(`- **Household size:** ${prefs.householdSize ?? "—"}`);
    lines.push(`- **Kiddo:** ${prefs.kiddoName ?? "—"}`);
    lines.push(`- **Appliances:** ${(prefs.appliances ?? []).join(", ") || "—"}`);
    lines.push(`- **Cuisine preferences:** ${(prefs.cuisinePreferences ?? []).join(", ") || "—"}`);
    lines.push(`- **Kiddo current favorites:** ${(prefs.kiddoCurrentFavorites ?? []).join(", ") || "—"}`);
    lines.push("");
    lines.push(`Live pantry stock, expiring items, and ${prefs.kiddoName ?? "the kiddo"}'s accept/reject food log are pulled at run-time from the bridge endpoints \`/api/pantry\`, \`/api/kiddo-food-log\`, and \`/api/nightly-recommendations\`. Those tables are not present in this database, so they are not included in this static digest.`);
    lines.push("");

    const dinnerCounts = new Map<string, number>();
    interface MealRow { id: number; date: Date; recipe: string; kiddo: string; raw: string; parsed: boolean }
    const mealRows: MealRow[] = [];
    for (const r of mealRuns) {
      const p = parseMealSummary(r.summary || "");
      if (p) {
        dinnerCounts.set(p.recipe, (dinnerCounts.get(p.recipe) ?? 0) + 1);
        mealRows.push({ id: r.id, date: r.createdAt, recipe: p.recipe, kiddo: p.kiddo, raw: r.rawOutput || r.summary || "", parsed: true });
      } else {
        mealRows.push({ id: r.id, date: r.createdAt, recipe: "_(unparsed — see raw output)_", kiddo: "_(unparsed)_", raw: r.rawOutput || r.summary || "", parsed: false });
      }
    }

    lines.push("## Most-suggested dinners");
    lines.push("");
    if (dinnerCounts.size === 0) {
      lines.push("_No parsed meal recommendations in window._");
    } else {
      lines.push("| Dinner | Times suggested |");
      lines.push("| --- | ---: |");
      const sorted = [...dinnerCounts.entries()].sort((a, b) => b[1] - a[1]);
      for (const [name, n] of sorted) lines.push(`| ${escapePipes(name)} | ${n} |`);
    }
    lines.push("");

    lines.push("## Nightly suggestions (newest first)");
    lines.push("");
    if (mealRows.length === 0) {
      lines.push("_No successful meal recommender runs in window._");
    } else {
      lines.push(`| Date | Dinner | ${prefs.kiddoName ?? "Kiddo"}'s lunch | Run ID |`);
      lines.push("| --- | --- | --- | ---: |");
      for (const p of mealRows) {
        lines.push(`| ${fmtDay(p.date)} | ${escapePipes(p.recipe)} | ${escapePipes(p.kiddo)} | [#${p.id}](./nightly-meal-recommender.md#run-${p.id}) |`);
      }
      lines.push("");
      lines.push("## Full raw outputs");
      lines.push("");
      for (const p of mealRows) {
        lines.push(`### ${fmtDay(p.date)} — run #${p.id}${p.parsed ? "" : " (unparsed)"}`);
        lines.push("");
        lines.push(fence(p.raw));
        lines.push("");
      }
    }

    // Recipes table (currently command shortcuts) — clearly labelled
    const allRecipes = await db.select().from(recipes);
    lines.push("## `recipes` table (command shortcuts, not food)");
    lines.push("");
    lines.push("> The `recipes` DB table currently stores command shortcuts rather than food recipes. Listed verbatim for traceability.");
    lines.push("");
    if (allRecipes.length === 0) {
      lines.push("_No rows in `recipes` table._");
    } else {
      lines.push("| Name | Description | Command | Schedule |");
      lines.push("| --- | --- | --- | --- |");
      for (const r of allRecipes) {
        lines.push(`| ${escapePipes(r.name)} | ${escapePipes(r.description || "")} | \`${escapePipes(r.command)}\` | ${escapePipes(r.schedule || "—")} |`);
      }
    }
    lines.push("");

    await writeFile(join(OUT_DIR, "recipes.md"), lines.join("\n"));
  }

  // ---------- errors.md ----------
  {
    const lines: string[] = [];
    lines.push(`# Recurring Errors`);
    lines.push("");
    lines.push(`[← Back to index](./README.md)`);
    lines.push("");
    lines.push(`Errored runs grouped by message across the last ${WINDOW_DAYS} days.`);
    lines.push("");

    type ErrAgg = { count: number; programs: Map<string, number>; first: Date; last: Date };
    const agg = new Map<string, ErrAgg>();
    for (const r of allResults) {
      if (r.status === "ok") continue;
      const key = (r.summary || "").split("\n")[0].trim().slice(0, 200) || "(empty)";
      const cur = agg.get(key);
      if (!cur) {
        agg.set(key, { count: 1, programs: new Map([[r.programName, 1]]), first: r.createdAt, last: r.createdAt });
      } else {
        cur.count++;
        cur.programs.set(r.programName, (cur.programs.get(r.programName) ?? 0) + 1);
        if (r.createdAt < cur.first) cur.first = r.createdAt;
        if (r.createdAt > cur.last) cur.last = r.createdAt;
      }
    }
    const sorted = [...agg.entries()].sort((a, b) => b[1].count - a[1].count);
    if (sorted.length === 0) {
      lines.push("_No errors in window. 🎉_");
    } else {
      lines.push(`**${sorted.length}** distinct error messages, **${sorted.reduce((s, [, v]) => s + v.count, 0)}** total errored runs.`);
      lines.push("");
      for (const [msg, info] of sorted) {
        lines.push(`## \`${msg.replace(/`/g, "'")}\``);
        lines.push("");
        lines.push(`- **Count:** ${info.count}`);
        lines.push(`- **First seen:** ${fmtDate(info.first)}`);
        lines.push(`- **Last seen:** ${fmtDate(info.last)}`);
        lines.push(`- **Programs hit:**`);
        const progs = [...info.programs.entries()].sort((a, b) => b[1] - a[1]);
        for (const [pn, c] of progs) lines.push(`  - [${pn}](./${slug(pn)}.md) × ${c}`);
        lines.push("");
      }
    }
    await writeFile(join(OUT_DIR, "errors.md"), lines.join("\n"));
  }

  // ---------- README.md (index) ----------
  {
    const lines: string[] = [];
    lines.push(`# Nightly Jobs Wiki Digest`);
    lines.push("");
    lines.push(`_Generated: ${fmtDate(generatedAt)}_  `);
    lines.push(`_Data window: ${fmtDay(windowStart)} → ${fmtDay(generatedAt)} (${WINDOW_DAYS} days)_`);
    lines.push("");
    lines.push(`A browsable journal of what every nightly program has been producing. Regenerate with \`npm run digest:nightly\`.`);
    lines.push("");
    lines.push("## Special pages");
    lines.push("");
    lines.push("- 🍳 [Recipes & meal suggestions](./recipes.md) — dinners + kiddo lunches, with a most-suggested roll-up");
    lines.push("- 🚨 [Recurring errors](./errors.md) — error patterns grouped by message");
    lines.push("");
    lines.push("## Programs");
    lines.push("");
    lines.push("| Program | Schedule | Last success | ✅ ok | ❌ err |");
    lines.push("| --- | --- | --- | ---: | ---: |");
    for (const { program: p, ok, err, lastOk } of programStats) {
      const sched = p.schedule ?? "—";
      const cron = p.cronExpression ? ` \`${p.cronExpression}\`` : "";
      lines.push(
        `| [${p.name}](./${slug(p.name)}.md) | ${escapePipes(sched)}${cron} | ${fmtDate(lastOk)} | ${ok.length} | ${err.length} |`
      );
    }
    lines.push("");
    lines.push("## How this is built");
    lines.push("");
    lines.push("Generator: `scripts/build-nightly-digest.ts`. Reads from `programs`, `agent_results`, and `recipes` via the existing Drizzle setup in `server/db.ts`. Wipes and rewrites this directory on each run.");
    lines.push("");
    await writeFile(join(OUT_DIR, "README.md"), lines.join("\n"));
  }

  console.log(`[digest] Wrote ${OUT_DIR}/`);
  await db.$client.end();
}

main().catch((err) => {
  console.error("[digest] failed:", err);
  process.exit(1);
});
