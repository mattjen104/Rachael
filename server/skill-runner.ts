import { access } from "fs/promises";
import { join, basename } from "path";

const SKILLS_DIR = join(process.cwd(), "skills");

export interface SkillContext {
  orgContent: string;
  programName: string;
  lastResults: string;
  iteration: number;
}

export interface SkillResult {
  summary: string;
  metric?: string;
  proposal?: string;
}

export async function runHardenedSkill(
  scriptPath: string,
  context: SkillContext
): Promise<SkillResult> {
  const normalized = basename(scriptPath.replace(/^skills\//, ""));
  if (normalized.includes("..") || normalized.includes("/")) {
    throw new Error(`Invalid script path: ${scriptPath}`);
  }
  const fullPath = join(SKILLS_DIR, normalized);

  try {
    await access(fullPath);
  } catch {
    throw new Error(`Hardened script not found: ${scriptPath}`);
  }

  try {
    const cacheBuster = `?t=${Date.now()}`;
    const mod = await import(`${fullPath}${cacheBuster}`);

    const execute = mod.default || mod.execute || mod.run;
    if (typeof execute !== "function") {
      throw new Error(
        `Hardened script ${scriptPath} does not export a default/execute/run function`
      );
    }

    const result = await Promise.race([
      execute(context),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Hardened script timed out (30s)")), 30_000)
      ),
    ]);

    if (!result || typeof result.summary !== "string") {
      return { summary: String(result || "No output") };
    }

    return result as SkillResult;
  } catch (err: any) {
    throw new Error(`Hardened script error: ${err.message}`);
  }
}

export function getHardenCandidatesFromRuntime(
  runtimePrograms: Map<string, { lastOutput: string | null; name: string }>
): Array<{ programName: string; code: string }> {
  const candidates: Array<{ programName: string; code: string }> = [];

  for (const [name, state] of runtimePrograms) {
    if (!state.lastOutput) continue;
    const codeBlockMatch = state.lastOutput.match(
      /```typescript\s*\n\/\/ HARDENABLE\s*\n([\s\S]*?)```/
    );
    if (codeBlockMatch) {
      candidates.push({ programName: name, code: codeBlockMatch[1].trim() });
    }
  }

  return candidates;
}
