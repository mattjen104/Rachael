export function sanitizeResultRow(text: string): string {
  let result = text;

  result = result.replace(/^(\*+)\s/gm, "");

  result = result.replace(/^:[\w-]+:.*$/gm, "").replace(/\n{2,}/g, "\n").trim();

  result = result.replace(/```[\s\S]*?```/g, "[code block removed]");

  result = result.replace(/\|/g, "¦");

  if (result.length > 300) {
    result = result.slice(0, 297) + "...";
  }

  return result;
}

export function sanitizeProposalContent(text: string, allowedSection: string): string {
  const sectionPattern = /^\*{1,2}\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  const referencedSections: string[] = [];

  while ((match = sectionPattern.exec(text)) !== null) {
    referencedSections.push(match[1].trim());
  }

  for (const section of referencedSections) {
    if (section.toUpperCase() !== allowedSection.toUpperCase()) {
      throw new Error(
        `Proposal content references section "${section}" but only "${allowedSection}" is allowed`
      );
    }
  }

  return text;
}

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; warning: string }> = [
  { pattern: /fs\.writeFile/g, warning: "fs.writeFile — writes to filesystem" },
  { pattern: /fs\.unlink/g, warning: "fs.unlink — deletes files" },
  { pattern: /\bexec\s*\(/g, warning: "exec — executes shell commands" },
  { pattern: /\bspawn\s*\(/g, warning: "spawn — spawns child processes" },
  { pattern: /\beval\s*\(/g, warning: "eval — evaluates arbitrary code" },
  { pattern: /\bFunction\s*\(/g, warning: "Function( — dynamic function construction" },
  { pattern: /child_process/g, warning: "child_process — shell access module" },
  { pattern: /process\.env/g, warning: "process.env — environment variable access" },
  { pattern: /fetch\s*\(\s*['"`]https?:\/\//g, warning: "external fetch — network request to external URL" },
];

export function analyzeCodeSafety(code: string): string[] {
  const warnings: string[] = [];

  for (const { pattern, warning } of DANGEROUS_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(code)) {
      warnings.push(warning);
    }
  }

  return warnings;
}
