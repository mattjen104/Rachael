#!/usr/bin/env tsx
/**
 * CI guard: enforce that the receipts ledger has exactly one writer
 * (`server/receipt-ledger.ts`) and that autonomous-action sinks (ntfy push,
 * etc.) cannot bypass it. Failures here mean a new code path has been added
 * that performs an autonomous action without surfacing through the helper.
 *
 * Run: `tsx scripts/check-receipt-bypass.ts`
 */
import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const ROOT = process.cwd();
const SERVER_DIR = join(ROOT, "server");

const ALLOW_DIRECT_RECEIPT_INSERT = new Set([
  "server/receipt-ledger.ts",
  "server/storage.ts",
]);

const ALLOW_DIRECT_NTFY_FETCH = new Set([
  "server/briefing-utils.ts",
  // cli-engine wraps the call with an awaited recordReceipt() right next to
  // the fetch, including retry-on-429 specifics that the helper doesn't model.
  "server/cli-engine.ts",
  // seed-data.ts contains program code as template literal strings that run
  // inside the inline-code sandbox; the helper is not in scope there. Those
  // sandboxed runs surface through the program-runner receipts upstream.
  "server/seed-data.ts",
]);

const violations: string[] = [];

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (p.endsWith(".ts")) yield p;
  }
}

for (const file of walk(SERVER_DIR)) {
  const rel = relative(ROOT, file);
  const src = readFileSync(file, "utf8");

  // 1. Direct INSERT into receipts table outside the helper/storage layer.
  if (/db\.insert\(\s*receipts\s*\)/.test(src) && !ALLOW_DIRECT_RECEIPT_INSERT.has(rel)) {
    violations.push(
      `${rel}: bypasses receipt-ledger by calling db.insert(receipts) directly. ` +
      `Use recordReceipt() from server/receipt-ledger.ts instead.`,
    );
  }

  // 2. Direct ntfy fetch outside briefing-utils (push notifications must
  //    pass through pushViaNtfy so they generate a receipt).
  if (/fetch\(\s*['"`]https:\/\/ntfy\.sh/.test(src) && !ALLOW_DIRECT_NTFY_FETCH.has(rel)) {
    violations.push(
      `${rel}: posts to ntfy.sh directly. Route through pushViaNtfy() so the ` +
      `notification generates a ledger receipt.`,
    );
  }
}

if (violations.length > 0) {
  console.error("\n[receipt-bypass-guard] FAIL — autonomous-action sinks must route through receipt-ledger:\n");
  for (const v of violations) console.error("  - " + v);
  console.error("");
  process.exit(1);
}

console.log("[receipt-bypass-guard] OK — no bypassing call sites found.");
