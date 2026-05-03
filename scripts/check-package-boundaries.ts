/**
 * scripts/check-package-boundaries.ts — fail-loud lint that enforces the
 * "no internal Rachael imports leak across the public package boundary"
 * rule from task #98.
 *
 * For every TS file under `packages/<pkg>/src/` and `packages/<pkg>/examples/`
 * we forbid any import path that targets:
 *   - `@/...`           (client tsconfig alias)
 *   - `@shared/...`     (shared tsconfig alias)
 *   - relative paths that escape the package directory (../../server/, etc)
 *   - any literal string starting with `server/`, `client/`, `shared/`,
 *     `tools/`, `scripts/`, `tests/`, or `db/`
 *
 * cu-bench is allowed to reach into ../cu-core/bench/ because the bench
 * harness is intentionally co-located there during the in-monorepo
 * extraction phase. That allowance is encoded in CU_BENCH_ALLOW.
 *
 * Exit 0 on clean, exit 1 on any forbidden import.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const PACKAGES_DIR = path.join(ROOT, "packages");

const FORBIDDEN_LITERAL_PREFIXES = ["server/", "client/", "shared/", "tools/", "scripts/", "tests/", "db/"];
const FORBIDDEN_ALIASES = ["@/", "@shared/"];

// No cross-package allowlist any more — cu-bench is fully self-contained
// and pulls types from `@rachael/cu-core` via the package name.
const CU_BENCH_ALLOW = new Set<string>([]);

interface Violation {
  file: string;
  importPath: string;
  reason: string;
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (st.isFile() && /\.(ts|tsx)$/.test(entry)) {
      yield full;
    }
  }
}

function extractImports(source: string): string[] {
  const out: string[] = [];
  const re = /(?:import\s+(?:[^"';]+?from\s+)?|require\(\s*|export\s+(?:type\s+)?\*\s+from\s+|export\s+\{[^}]*\}\s+from\s+)["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) out.push(m[1]);
  return out;
}

function checkPackage(pkgDir: string): Violation[] {
  const violations: Violation[] = [];
  const pkgName = path.basename(pkgDir);
  const subdirs = ["src", "examples"]
    .map((s) => path.join(pkgDir, s))
    .filter((p) => {
      try { return statSync(p).isDirectory(); } catch { return false; }
    });
  for (const sub of subdirs) {
    for (const file of walk(sub)) {
      const source = readFileSync(file, "utf8");
      for (const imp of extractImports(source)) {
        const v = classify(imp, pkgName, pkgDir, file);
        if (v) violations.push({ file: path.relative(ROOT, file), importPath: imp, reason: v });
      }
    }
  }
  return violations;
}

function classify(imp: string, pkgName: string, pkgDir: string, fromFile: string): string | null {
  for (const a of FORBIDDEN_ALIASES) if (imp.startsWith(a)) return `forbidden alias ${a}`;
  for (const p of FORBIDDEN_LITERAL_PREFIXES) if (imp.startsWith(p)) return `forbidden literal prefix ${p}`;
  if (imp.startsWith(".")) {
    if (pkgName === "cu-bench" && CU_BENCH_ALLOW.has(imp)) return null;
    const resolved = path.resolve(path.dirname(fromFile), imp);
    const pkgAbs = path.resolve(pkgDir);
    const rel = path.relative(pkgAbs, resolved);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return `relative import escapes package (${imp} → ${path.relative(ROOT, resolved)})`;
    }
  }
  return null;
}

function main() {
  let pkgs: string[];
  try {
    pkgs = readdirSync(PACKAGES_DIR).map((n) => path.join(PACKAGES_DIR, n)).filter((p) => statSync(p).isDirectory());
  } catch {
    console.error(`No packages/ directory at ${PACKAGES_DIR}`);
    process.exit(1);
  }
  // cu-bench is allowed to reach into cu-core; everyone else is strict.
  const allViolations: Violation[] = [];
  for (const pkg of pkgs) allViolations.push(...checkPackage(pkg));
  if (allViolations.length === 0) {
    console.log("[boundary] OK — no forbidden imports across the public package boundary.");
    process.exit(0);
  }
  console.error(`[boundary] ${allViolations.length} forbidden import(s):`);
  for (const v of allViolations) console.error(`  - ${v.file}\n      ${v.importPath}\n      reason: ${v.reason}`);
  process.exit(1);
}

main();
