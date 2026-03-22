import { db } from "../server/db";
import { programs } from "@shared/schema";
import { eq } from "drizzle-orm";

async function main() {
  const rows = await db.select().from(programs);
  const nameToId = new Map<string, number>();
  for (const r of rows) nameToId.set(r.name, r.id);

  const targets = ["estate-car-finder", "free-stuff-radar", "price-watch", "foreclosure-monitor", "mandela-berenstain", "overnight-digest", "budget-strategist", "openrouter-model-scout", "hn-pulse", "hn-deep-digest", "github-trending"];

  const fs = await import("fs");
  const seedSource = fs.readFileSync("server/seed-data.ts", "utf-8");

  for (const name of targets) {
    const id = nameToId.get(name);
    if (!id) {
      console.log("[skip] " + name + " not found in DB");
      continue;
    }

    const nameIdx = seedSource.indexOf('name: "' + name + '"');
    if (nameIdx === -1) {
      console.log("[skip] " + name + " not found in seed source");
      continue;
    }

    const codeMarker = "code: `";
    const codeStart = seedSource.indexOf(codeMarker, nameIdx);
    if (codeStart === -1 || codeStart - nameIdx > 3000) {
      console.log("[skip] " + name + " no code block found near entry");
      continue;
    }

    const contentStart = codeStart + codeMarker.length;
    let depth = 0;
    let pos = contentStart;
    while (pos < seedSource.length) {
      const ch = seedSource[pos];
      if (ch === '`' && seedSource[pos - 1] !== '\\') {
        if (depth === 0) break;
        depth--;
      }
      if (ch === '`' && seedSource[pos + 1] !== '`' && depth === 0 && pos > contentStart) {
        break;
      }
      pos++;
    }
    const code = seedSource.slice(contentStart, pos);

    if (code.length < 50) {
      console.log("[skip] " + name + " code too short (" + code.length + " chars)");
      continue;
    }

    const configStart = seedSource.indexOf("config: {", nameIdx);
    let config: Record<string, string> | undefined;
    if (configStart !== -1 && configStart - nameIdx < 500) {
      const configEnd = seedSource.indexOf("}", configStart);
      const configStr = seedSource.slice(configStart + 8, configEnd + 1);
      try {
        const pairs = configStr.match(/"?(\w+)"?\s*:\s*"([^"]*)"/g) || [];
        config = {};
        for (const pair of pairs) {
          const m = pair.match(/"?(\w+)"?\s*:\s*"([^"]*)"/);
          if (m) config[m[1]] = m[2];
        }
      } catch {}
    }

    const instrMatch = seedSource.slice(nameIdx, nameIdx + 500).match(/instructions: "([^"]+)"/);
    const instructions = instrMatch ? instrMatch[1] : undefined;

    const schedMatch = seedSource.slice(nameIdx, nameIdx + 300).match(/schedule: "([^"]+)"/);
    const schedule = schedMatch ? schedMatch[1] : undefined;

    const cronMatch = seedSource.slice(nameIdx, nameIdx + 300).match(/cronExpression: "([^"]+)"/);
    const cronExpression = cronMatch ? cronMatch[1] : undefined;

    const enabledMatch = seedSource.slice(nameIdx, nameIdx + 300).match(/enabled: (true|false)/);

    const updateData: Record<string, unknown> = { code, codeLang: "typescript" };
    if (config) updateData.config = config;
    if (instructions) updateData.instructions = instructions;
    if (schedule) updateData.schedule = schedule;
    if (cronExpression) updateData.cronExpression = cronExpression;
    if (enabledMatch) updateData.enabled = enabledMatch[1] === "true";

    const firstChar = code.charCodeAt(0);
    if (firstChar === 96) {
      console.log("[ERROR] " + name + " still has leading backtick!");
      continue;
    }

    await db.update(programs).set(updateData).where(eq(programs.id, id));
    console.log("[updated] " + name + " (id=" + id + ") - code: " + code.length + " chars" + (config ? ", config updated" : "") + (schedule ? ", schedule: " + schedule : ""));
  }

  console.log("Done!");
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
