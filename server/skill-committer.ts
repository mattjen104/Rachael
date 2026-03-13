import { writeFile, mkdir, access } from "fs/promises";
import { join } from "path";
import { storage } from "./storage";

const SKILLS_DIR = join(process.cwd(), "skills");

export async function ensureSkillsDir(): Promise<void> {
  try {
    await access(SKILLS_DIR);
  } catch {
    await mkdir(SKILLS_DIR, { recursive: true });
  }
}

export async function saveHardenedSkill(
  skillName: string,
  scriptContent: string
): Promise<string> {
  await ensureSkillsDir();
  const safeName = skillName
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-");
  const filePath = join(SKILLS_DIR, `${safeName}.ts`);
  await writeFile(filePath, scriptContent, "utf-8");
  return `skills/${safeName}.ts`;
}

export async function hardenProgram(
  programName: string,
  candidateCode: string
): Promise<{ skillPath: string; programUpdated: boolean }> {
  const skillPath = await saveHardenedSkill(programName, candidateCode);

  const program = await storage.getProgramByName(programName);
  if (!program) {
    return { skillPath, programUpdated: false };
  }

  await storage.updateProgram(program.id, {
    code: candidateCode,
    codeLang: "typescript",
  });

  const existingSkills = await storage.getSkills();
  const existing = existingSkills.find(s => s.name === programName);
  if (existing) {
    await storage.updateSkill(existing.id, {
      content: `Hardened skill — runs as deterministic TypeScript.\nSource: ${skillPath}`,
      scriptPath: skillPath,
    });
  } else {
    await storage.createSkill({
      name: programName,
      description: `Hardened from program ${programName}`,
      type: "skill",
      content: `Hardened skill — runs as deterministic TypeScript.\nSource: ${skillPath}`,
      scriptPath: skillPath,
    });
  }

  return { skillPath, programUpdated: true };
}
