import { readFile, writeFile, mkdir, access } from "fs/promises";
import { join, basename } from "path";
import { storage } from "./storage";
import { compileOpenClaw } from "./openclaw-compiler";

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
): Promise<{ skillPath: string; updatedContent: string }> {
  const skillPath = await saveHardenedSkill(programName, candidateCode);

  const file = await storage.getOrgFileByName("openclaw.org");
  if (!file) throw new Error("openclaw.org not found");

  const lines = file.content.split("\n");
  let updatedContent = file.content;
  let programLineIdx = -1;
  let programLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(
      /^(\*+)\s+(?:TODO|DONE)\s+(.*?)\s+:.*program.*:/i
    );
    if (match && match[2].trim() === programName) {
      programLineIdx = i;
      programLevel = match[1].length;
      break;
    }
  }

  if (programLineIdx === -1) {
    return { skillPath, updatedContent };
  }

  const oldHeading = lines[programLineIdx];
  const newHeading = oldHeading
    .replace(/:program:/, ":program:hardened:");
  lines[programLineIdx] = newHeading;

  let propsEnd = programLineIdx;
  let hasProps = false;
  for (let i = programLineIdx + 1; i < lines.length; i++) {
    if (lines[i].match(/^\s*:PROPERTIES:/)) {
      hasProps = true;
    }
    if (hasProps && lines[i].match(/^\s*:END:/)) {
      propsEnd = i;
      break;
    }
    const headMatch = lines[i].match(/^(\*+)\s/);
    if (headMatch && headMatch[1].length <= programLevel) break;
  }

  if (hasProps) {
    lines.splice(propsEnd, 0, `   :SCRIPT: ${skillPath}`);
  } else {
    lines.splice(programLineIdx + 1, 0,
      "   :PROPERTIES:",
      `   :SCRIPT: ${skillPath}`,
      "   :END:"
    );
  }

  updatedContent = lines.join("\n");

  const skillsSection = updatedContent.match(
    /^(\*+)\s+SKILLS\s*$/m
  );
  if (skillsSection) {
    const skillLevel = skillsSection[1].length;
    const subLevel = "*".repeat(skillLevel + 1);
    const skillEntry = [
      `${subLevel} ${programName}                                                               :skill:hardened:`,
      "   :PROPERTIES:",
      `   :DESCRIPTION: Hardened from program ${programName}`,
      `   :SCRIPT: ${skillPath}`,
      "   :END:",
      "",
      `   Hardened skill — runs as deterministic TypeScript.`,
      `   Source: [[file:${skillPath}]]`,
      "",
    ].join("\n");

    const skillsSectionIdx = updatedContent.indexOf(skillsSection[0]);
    const afterSkills = updatedContent.indexOf("\n", skillsSectionIdx) + 1;

    let insertPoint = afterSkills;
    const restLines = updatedContent.slice(afterSkills).split("\n");
    for (let i = 0; i < restLines.length; i++) {
      const hm = restLines[i].match(/^(\*+)\s/);
      if (hm && hm[1].length <= skillLevel) {
        insertPoint = afterSkills + restLines.slice(0, i).join("\n").length;
        if (i > 0) insertPoint += 1;
        break;
      }
    }

    updatedContent =
      updatedContent.slice(0, insertPoint) +
      skillEntry +
      updatedContent.slice(insertPoint);
  }

  return { skillPath, updatedContent };
}
