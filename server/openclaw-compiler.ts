export interface Program {
  name: string;
  status: "TODO" | "DONE";
  active: boolean;
  schedule: string;
  scheduledRaw: string | null;
  deadlineRaw: string | null;
  properties: Record<string, string>;
  instructions: string;
  results: string;
  tags: string[];
}

export interface RoutingConfig {
  default?: string;
  planning?: string;
  synthesis?: string;
  evaluation?: string;
  escalate_on?: string;
  [key: string]: string | undefined;
}

export interface CompiledOpenClaw {
  soul: string;
  skills: { name: string; content: string }[];
  config: object;
  routing: RoutingConfig;
  programs: Program[];
  errors: string[];
}

export interface OrgSection {
  level: number;
  status: string | null;
  title: string;
  tags: string[];
  properties: Record<string, string>;
  body: string;
  children: OrgSection[];
}

export function parseOrgSections(content: string): OrgSection[] {
  const lines = content.split("\n");
  const root: OrgSection[] = [];
  const stack: { section: OrgSection; level: number }[] = [];

  let currentSection: OrgSection | null = null;
  let inProperties = false;
  let bodyLines: string[] = [];

  function finishSection() {
    if (currentSection) {
      currentSection.body = bodyLines.join("\n").trim();
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(
      /^(\*+)\s+(TODO|DONE)?\s*(.*?)(?:\s+(:[a-zA-Z0-9_@-]+(?::[a-zA-Z0-9_@-]+)*:))?\s*$/
    );

    if (headingMatch) {
      finishSection();

      const level = headingMatch[1].length;
      const status = headingMatch[2] || null;
      const title = headingMatch[3].trim();
      const rawTags = headingMatch[4] || "";
      const tags = rawTags.split(":").filter((t) => t.length > 0);

      const section: OrgSection = {
        level,
        status,
        title,
        tags,
        properties: {},
        body: "",
        children: [],
      };

      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }

      if (stack.length > 0) {
        stack[stack.length - 1].section.children.push(section);
      } else {
        root.push(section);
      }

      stack.push({ section, level });
      currentSection = section;
      bodyLines = [];
      inProperties = false;
      continue;
    }

    if (!currentSection) continue;

    if (line.trim() === ":PROPERTIES:") {
      inProperties = true;
      continue;
    }
    if (line.trim() === ":END:") {
      inProperties = false;
      continue;
    }
    if (inProperties) {
      const propMatch = line.match(/^\s+:([A-Za-z0-9_]+):\s+(.+)$/);
      if (propMatch) {
        currentSection.properties[propMatch[1]] = propMatch[2];
      }
      continue;
    }

    bodyLines.push(line);
  }

  finishSection();
  return root;
}

function compileSoul(soulSection: OrgSection): string {
  const parts: string[] = [];

  if (soulSection.body) {
    parts.push(soulSection.body);
  }

  for (const child of soulSection.children) {
    parts.push(compileSoulSection(child, 2));
  }

  return parts.join("\n\n").trim();
}

function compileSoulSection(section: OrgSection, mdLevel: number): string {
  const parts: string[] = [];
  const heading = "#".repeat(mdLevel) + " " + section.title;
  parts.push(heading);

  if (section.body) {
    parts.push(section.body);
  }

  for (const child of section.children) {
    parts.push(compileSoulSection(child, mdLevel + 1));
  }

  return parts.join("\n\n");
}

function compileSkills(
  skillsSection: OrgSection
): { name: string; content: string }[] {
  const skills: { name: string; content: string }[] = [];

  for (const child of skillsSection.children) {
    if (!child.tags.includes("skill")) continue;

    const frontmatter: Record<string, any> = {};
    const props = child.properties;

    if (props.DESCRIPTION) frontmatter.description = props.DESCRIPTION;
    if (props.VERSION) frontmatter.version = props.VERSION;
    if (props.EMOJI) frontmatter.emoji = props.EMOJI;

    const metadata: Record<string, any> = {};
    const openclaw: Record<string, any> = {};
    const requires: Record<string, any> = {};

    if (props.REQUIRES_ENV) {
      requires.env = props.REQUIRES_ENV.split(",").map((s: string) => s.trim());
    }
    if (props.REQUIRES_BINS) {
      requires.bins = props.REQUIRES_BINS.split(",").map((s: string) =>
        s.trim()
      );
    }
    if (Object.keys(requires).length > 0) {
      openclaw.requires = requires;
    }
    if (props.PRIMARY_ENV) {
      openclaw.primaryEnv = props.PRIMARY_ENV;
    }
    if (Object.keys(openclaw).length > 0) {
      metadata.openclaw = openclaw;
    }
    if (Object.keys(metadata).length > 0) {
      frontmatter.metadata = metadata;
    }

    let content = "---\n";
    content += serializeYaml(frontmatter, 0);
    content += "---\n\n";
    content += child.body;

    skills.push({ name: child.title, content: content.trim() });
  }

  return skills;
}

function serializeYaml(obj: any, indent: number): string {
  let result = "";
  const prefix = "  ".repeat(indent);

  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      result += `${prefix}${key}:\n`;
      for (const item of value) {
        result += `${prefix}  - ${item}\n`;
      }
    } else if (typeof value === "object" && value !== null) {
      result += `${prefix}${key}:\n`;
      result += serializeYaml(value, indent + 1);
    } else {
      result += `${prefix}${key}: ${value}\n`;
    }
  }

  return result;
}

function compileRouting(configSection: OrgSection): RoutingConfig {
  const routingChild = configSection.children.find(
    (c) => c.title.toLowerCase() === "routing"
  );
  if (!routingChild) return {};

  const routing: RoutingConfig = {};
  for (const [key, rawVal] of Object.entries(routingChild.properties)) {
    routing[key.toLowerCase()] = String(rawVal);
  }
  return routing;
}

function compileConfig(configSection: OrgSection): object {
  const result: Record<string, any> = {};

  for (const child of configSection.children) {
    result[child.title] = buildConfigObject(child);
  }

  return result;
}

function buildConfigObject(section: OrgSection): any {
  const obj: Record<string, any> = {};

  for (const [key, rawVal] of Object.entries(section.properties)) {
    obj[key.toLowerCase()] = coerceValue(rawVal);
  }

  for (const child of section.children) {
    obj[child.title] = buildConfigObject(child);
  }

  if (Object.keys(obj).length === 0 && section.body) {
    return section.body;
  }

  return obj;
}

function coerceValue(val: string): any {
  if (val === "true") return true;
  if (val === "false") return false;
  if (/^\d+$/.test(val)) return parseInt(val, 10);
  if (/^\d+\.\d+$/.test(val)) return parseFloat(val);
  return val;
}

function parseOrgTimestamp(line: string): {
  date: string;
  day: string;
  time: string | null;
  repeater: string | null;
} | null {
  const match = line.match(
    /<(\d{4}-\d{2}-\d{2})\s+([A-Za-z]+)(?:\s+(\d{2}:\d{2}))?(?:\s+(\+\d+[dwmy]))?>/
  );
  if (!match) return null;
  return {
    date: match[1],
    day: match[2],
    time: match[3] || null,
    repeater: match[4] || null,
  };
}

function repeaterToCron(
  repeater: string | null,
  time: string | null,
  day: string | null,
  loopContinuous: boolean
): string {
  if (loopContinuous) return "continuous";
  if (!repeater) return "once";

  const hour = time ? parseInt(time.split(":")[0], 10) : 0;
  const minute = time ? parseInt(time.split(":")[1], 10) : 0;

  const match = repeater.match(/\+(\d+)([dwmy])/);
  if (!match) return "once";

  const unit = match[2];

  switch (unit) {
    case "d":
      return `${minute} ${hour} * * *`;
    case "w": {
      const dayMap: Record<string, number> = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
      };
      const dayNum = day ? dayMap[day] ?? 0 : 0;
      return `${minute} ${hour} * * ${dayNum}`;
    }
    case "m":
      return `${minute} ${hour} 1 * *`;
    case "y":
      return `${minute} ${hour} 1 1 *`;
    default:
      return "once";
  }
}

function compilePrograms(programsSection: OrgSection): Program[] {
  const programs: Program[] = [];

  for (const child of programsSection.children) {
    if (!child.tags.includes("program")) continue;

    const status = (child.status as "TODO" | "DONE") || "TODO";
    const active = status === "TODO";

    let scheduledRaw: string | null = null;
    let deadlineRaw: string | null = null;
    let scheduledParsed: ReturnType<typeof parseOrgTimestamp> = null;
    let deadlineParsed: ReturnType<typeof parseOrgTimestamp> = null;

    const bodyLines = child.body.split("\n");
    const instructionLines: string[] = [];

    for (const line of bodyLines) {
      const schedMatch = line.match(/^\s*SCHEDULED:\s*(<[^>]+>)/);
      const deadMatch = line.match(/^\s*DEADLINE:\s*(<[^>]+>)/);

      if (schedMatch) {
        scheduledRaw = schedMatch[1];
        scheduledParsed = parseOrgTimestamp(schedMatch[1]);
      } else if (deadMatch) {
        deadlineRaw = deadMatch[1];
        deadlineParsed = parseOrgTimestamp(deadMatch[1]);
      } else {
        instructionLines.push(line);
      }
    }

    const loopContinuous = child.properties.LOOP === "continuous";
    const ts = scheduledParsed || deadlineParsed;
    const schedule = repeaterToCron(
      ts?.repeater || null,
      ts?.time || null,
      ts?.day || null,
      loopContinuous
    );

    let results = "";
    const resultsChild = child.children.find((c) =>
      c.tags.includes("results")
    );
    if (resultsChild) {
      results = resultsChild.body;
    }

    programs.push({
      name: child.title,
      status,
      active,
      schedule,
      scheduledRaw,
      deadlineRaw,
      properties: child.properties,
      instructions: instructionLines.join("\n").trim(),
      results,
      tags: child.tags.filter((t) => t !== "program"),
    });
  }

  return programs;
}

export function compileOpenClaw(orgContent: string): CompiledOpenClaw {
  const errors: string[] = [];
  const sections = parseOrgSections(orgContent);

  let soul = "";
  let skills: { name: string; content: string }[] = [];
  let config: object = {};
  let routing: RoutingConfig = {};
  let programs: Program[] = [];

  const soulSection = sections.find(
    (s) => s.title.toUpperCase() === "SOUL"
  );
  const skillsSection = sections.find(
    (s) => s.title.toUpperCase() === "SKILLS"
  );
  const configSection = sections.find(
    (s) => s.title.toUpperCase() === "CONFIG"
  );
  const programsSection = sections.find(
    (s) => s.title.toUpperCase() === "PROGRAMS"
  );

  if (soulSection) {
    try {
      soul = compileSoul(soulSection);
    } catch (e: any) {
      errors.push(`SOUL compilation error: ${e.message}`);
    }
  } else {
    errors.push("Missing * SOUL section");
  }

  if (skillsSection) {
    try {
      skills = compileSkills(skillsSection);
    } catch (e: any) {
      errors.push(`SKILLS compilation error: ${e.message}`);
    }
  }

  if (configSection) {
    try {
      config = compileConfig(configSection);
    } catch (e: any) {
      errors.push(`CONFIG compilation error: ${e.message}`);
    }
    try {
      routing = compileRouting(configSection);
    } catch (e: any) {
      errors.push(`ROUTING compilation error: ${e.message}`);
    }
  }

  if (programsSection) {
    try {
      programs = compilePrograms(programsSection);
    } catch (e: any) {
      errors.push(`PROGRAMS compilation error: ${e.message}`);
    }
  }

  return { soul, skills, config, routing, programs, errors };
}

export function importSoul(soulMd: string): string {
  const lines = soulMd.split("\n");
  const orgLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{2,6})\s+(.+)$/);
    if (headingMatch) {
      const mdLevel = headingMatch[1].length;
      const orgLevel = mdLevel;
      orgLines.push("*".repeat(orgLevel) + " " + headingMatch[2]);
    } else {
      orgLines.push("   " + line);
    }
  }

  return orgLines
    .join("\n")
    .replace(/^   $/gm, "")
    .trim();
}

function parseYamlFrontmatter(
  content: string
): { frontmatter: Record<string, any>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const yamlStr = match[1];
  const body = match[2].trim();
  const frontmatter = parseSimpleYaml(yamlStr);

  return { frontmatter, body };
}

function parseSimpleYaml(
  yamlStr: string,
  baseIndent: number = 0
): Record<string, any> {
  const result: Record<string, any> = {};
  const lines = yamlStr.split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const currentIndent = line.search(/\S/);

    if (currentIndent < baseIndent || line.trim() === "") {
      i++;
      continue;
    }

    if (currentIndent > baseIndent) {
      i++;
      continue;
    }

    const kvMatch = line.match(/^(\s*)([a-zA-Z0-9_]+):\s*(.*)$/);
    if (!kvMatch) {
      i++;
      continue;
    }

    const key = kvMatch[2];
    const value = kvMatch[3].trim();

    if (value === "") {
      const childLines: string[] = [];
      i++;
      while (i < lines.length) {
        const nextIndent = lines[i].search(/\S/);
        if (nextIndent <= currentIndent && lines[i].trim() !== "") break;
        childLines.push(lines[i]);
        i++;
      }

      const childStr = childLines.join("\n");
      if (childLines.some((l) => l.trim().startsWith("- "))) {
        result[key] = childLines
          .filter((l) => l.trim().startsWith("- "))
          .map((l) => l.trim().replace(/^- /, ""));
      } else {
        result[key] = parseSimpleYaml(childStr, currentIndent + 2);
      }
    } else {
      result[key] = coerceValue(value);
      i++;
    }
  }

  return result;
}

export function importSkill(skillMd: string, skillName?: string): string {
  const { frontmatter, body } = parseYamlFrontmatter(skillMd);
  const lines: string[] = [];

  const name =
    skillName || frontmatter.name || body.match(/^#\s+(.+)/m)?.[1] || "unnamed-skill";

  lines.push(`** ${name}                                             :skill:`);
  lines.push("   :PROPERTIES:");

  if (frontmatter.description)
    lines.push(`   :DESCRIPTION: ${frontmatter.description}`);
  if (frontmatter.version)
    lines.push(`   :VERSION: ${frontmatter.version}`);
  if (frontmatter.emoji) lines.push(`   :EMOJI: ${frontmatter.emoji}`);

  const meta = frontmatter.metadata?.openclaw || {};
  if (meta.requires?.env) {
    lines.push(`   :REQUIRES_ENV: ${Array.isArray(meta.requires.env) ? meta.requires.env.join(", ") : meta.requires.env}`);
  }
  if (meta.requires?.bins) {
    lines.push(`   :REQUIRES_BINS: ${Array.isArray(meta.requires.bins) ? meta.requires.bins.join(", ") : meta.requires.bins}`);
  }
  if (meta.primaryEnv) lines.push(`   :PRIMARY_ENV: ${meta.primaryEnv}`);

  lines.push("   :END:");
  lines.push("");

  const bodyLines = body.split("\n").map((l) => "   " + l);
  lines.push(...bodyLines);

  return lines.join("\n").trim();
}

export function importConfig(configJson: object): string {
  const lines: string[] = [];
  buildConfigOrg(configJson as Record<string, any>, 2, lines);
  return lines.join("\n").trim();
}

function buildConfigOrg(
  obj: Record<string, any>,
  level: number,
  lines: string[]
): void {
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const propEntries = Object.entries(value).filter(
        ([, v]) => typeof v !== "object" || v === null
      );
      const subEntries = Object.entries(value).filter(
        ([, v]) => typeof v === "object" && v !== null && !Array.isArray(v)
      );

      lines.push("*".repeat(level) + " " + key);

      if (propEntries.length > 0) {
        lines.push("   :PROPERTIES:");
        for (const [pk, pv] of propEntries) {
          lines.push(`   :${pk.toUpperCase()}: ${pv}`);
        }
        lines.push("   :END:");
      }

      if (subEntries.length > 0) {
        buildConfigOrg(
          Object.fromEntries(subEntries),
          level + 1,
          lines
        );
      }
    } else {
      lines.push("*".repeat(level) + " " + key);
      if (value !== null && value !== undefined) {
        lines.push("   :PROPERTIES:");
        lines.push(`   :VALUE: ${value}`);
        lines.push("   :END:");
      }
    }
  }
}

export function importAll(
  soul?: string,
  skills?: { name: string; content: string }[],
  configJson?: object
): string {
  const parts: string[] = [];

  parts.push("#+TITLE: OpenClaw Configuration");
  parts.push("");

  parts.push("* SOUL");
  if (soul) {
    parts.push(importSoul(soul));
  }
  parts.push("");

  parts.push("* SKILLS");
  if (skills && skills.length > 0) {
    for (const skill of skills) {
      parts.push(importSkill(skill.content, skill.name));
      parts.push("");
    }
  }
  parts.push("");

  parts.push("* CONFIG");
  if (configJson) {
    parts.push(importConfig(configJson));
  }
  parts.push("");

  parts.push("* PROGRAMS");
  parts.push("");

  return parts.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export function extractSection(
  orgContent: string,
  sectionName: string,
  targetName?: string
): string {
  const sections = parseOrgSections(orgContent);
  const section = sections.find(
    (s) => s.title.toUpperCase() === sectionName.toUpperCase()
  );
  if (!section) return "";

  if (targetName) {
    const child = section.children.find(
      (c) => c.title.toLowerCase() === targetName.toLowerCase()
    );
    if (!child) return "";
    return rebuildSection(child);
  }

  return rebuildSection(section);
}

export function rebuildSection(section: OrgSection): string {
  const lines: string[] = [];
  lines.push(
    "*".repeat(section.level) +
      " " +
      (section.status ? section.status + " " : "") +
      section.title +
      (section.tags.length > 0 ? " :" + section.tags.join(":") + ":" : "")
  );

  if (Object.keys(section.properties).length > 0) {
    lines.push("   :PROPERTIES:");
    for (const [k, v] of Object.entries(section.properties)) {
      lines.push(`   :${k}: ${v}`);
    }
    lines.push("   :END:");
  }

  if (section.body) {
    lines.push(section.body);
  }

  for (const child of section.children) {
    lines.push(rebuildSection(child));
  }

  return lines.join("\n");
}

export function replaceSection(
  orgContent: string,
  sectionName: string,
  newSectionContent: string,
  targetName?: string
): string {
  const lines = orgContent.split("\n");
  const sectionRegex = new RegExp(
    `^(\\*+)\\s+${escapeRegex(sectionName)}\\s*$`,
    "i"
  );

  let startIdx = -1;
  let sectionLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(
      new RegExp(
        `^(\\*+)\\s+(?:TODO\\s+|DONE\\s+)?${escapeRegex(sectionName)}(?:\\s+:[a-zA-Z0-9_@:-]+:)?\\s*$`,
        "i"
      )
    );
    if (match) {
      startIdx = i;
      sectionLevel = match[1].length;
      break;
    }
  }

  if (startIdx === -1) return orgContent;

  if (targetName) {
    let targetStart = -1;
    let targetLevel = 0;

    for (let i = startIdx + 1; i < lines.length; i++) {
      const headMatch = lines[i].match(/^(\*+)\s/);
      if (headMatch && headMatch[1].length <= sectionLevel) break;

      const targetMatch = lines[i].match(
        new RegExp(
          `^(\\*+)\\s+(?:TODO\\s+|DONE\\s+)?${escapeRegex(targetName)}(?:\\s+:[a-zA-Z0-9_@:-]+:)?\\s*$`,
          "i"
        )
      );
      if (targetMatch) {
        targetStart = i;
        targetLevel = targetMatch[1].length;
        break;
      }
    }

    if (targetStart === -1) return orgContent;

    let targetEnd = targetStart + 1;
    while (targetEnd < lines.length) {
      const nextHead = lines[targetEnd].match(/^(\*+)\s/);
      if (nextHead && nextHead[1].length <= targetLevel) break;
      targetEnd++;
    }

    const before = lines.slice(0, targetStart);
    const after = lines.slice(targetEnd);
    return [...before, newSectionContent, ...after].join("\n");
  }

  let endIdx = startIdx + 1;
  while (endIdx < lines.length) {
    const nextHead = lines[endIdx].match(/^(\*+)\s/);
    if (nextHead && nextHead[1].length <= sectionLevel) break;
    endIdx++;
  }

  const before = lines.slice(0, startIdx);
  const after = lines.slice(endIdx);
  return [...before, newSectionContent, ...after].join("\n");
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function appendResultToProgram(
  orgContent: string,
  programName: string,
  resultRow: string
): string {
  const lines = orgContent.split("\n");

  let programStart = -1;
  let programLevel = 0;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(
      new RegExp(
        `^(\\*+)\\s+(?:TODO|DONE)\\s+${escapeRegex(programName)}\\s+:.*program.*:`,
        "i"
      )
    );
    if (match) {
      programStart = i;
      programLevel = match[1].length;
      break;
    }
  }

  if (programStart === -1) return orgContent;

  let resultsStart = -1;
  for (let i = programStart + 1; i < lines.length; i++) {
    const headMatch = lines[i].match(/^(\*+)\s/);
    if (headMatch && headMatch[1].length <= programLevel) break;

    if (lines[i].match(/results/i) && lines[i].match(/:results:/)) {
      resultsStart = i;
      break;
    }
  }

  if (resultsStart === -1) return orgContent;

  let insertAt = resultsStart + 1;
  const resultsLevel =
    lines[resultsStart].match(/^(\*+)/)?.[1].length || programLevel + 1;

  while (insertAt < lines.length) {
    const nextHead = lines[insertAt].match(/^(\*+)\s/);
    if (nextHead && nextHead[1].length <= resultsLevel) break;
    insertAt++;
  }

  lines.splice(insertAt, 0, "    " + resultRow);
  return lines.join("\n");
}

export interface MergeLog {
  section: string;
  action: "updated" | "unchanged" | "added" | "preserved";
  name?: string;
}

export function mergeImport(
  existingContent: string,
  incomingSoul?: string,
  incomingSkills?: { name: string; content: string }[],
  incomingConfig?: object
): { mergedContent: string; log: MergeLog[] } {
  const log: MergeLog[] = [];
  const existingSections = parseOrgSections(existingContent);

  let result = existingContent;

  if (incomingSoul !== undefined) {
    const soulOrg = importSoul(incomingSoul);
    const soulSection = parseOrgSections(`* SOUL\n${soulOrg}`);
    const incomingSoul_ = soulSection.find(s => s.title.toUpperCase() === "SOUL");
    const existingSoul_ = existingSections.find(s => s.title.toUpperCase() === "SOUL");

    if (incomingSoul_ && existingSoul_) {
      const incomingSoulText = rebuildSection(incomingSoul_);
      const existingSoulText = rebuildSection(existingSoul_);
      if (incomingSoulText.trim() !== existingSoulText.trim()) {
        result = replaceSection(result, "SOUL", incomingSoulText);
        log.push({ section: "SOUL", action: "updated" });
      } else {
        log.push({ section: "SOUL", action: "unchanged" });
      }
    } else if (incomingSoul_ && !existingSoul_) {
      result = result.trimEnd() + "\n\n" + rebuildSection(incomingSoul_) + "\n";
      log.push({ section: "SOUL", action: "added" });
    }
  }

  if (incomingConfig !== undefined) {
    const configOrg = importConfig(incomingConfig);
    const configSection = parseOrgSections(`* CONFIG\n${configOrg}`);
    const incomingConfig_ = configSection.find(s => s.title.toUpperCase() === "CONFIG");
    const existingConfig_ = existingSections.find(s => s.title.toUpperCase() === "CONFIG");

    if (incomingConfig_ && existingConfig_) {
      const incomingConfigText = rebuildSection(incomingConfig_);
      const existingConfigText = rebuildSection(existingConfig_);
      if (incomingConfigText.trim() !== existingConfigText.trim()) {
        result = replaceSection(result, "CONFIG", incomingConfigText);
        log.push({ section: "CONFIG", action: "updated" });
      } else {
        log.push({ section: "CONFIG", action: "unchanged" });
      }
    } else if (incomingConfig_ && !existingConfig_) {
      result = result.trimEnd() + "\n\n" + rebuildSection(incomingConfig_) + "\n";
      log.push({ section: "CONFIG", action: "added" });
    }
  }

  const incomingSkills_ = (incomingSkills !== undefined && incomingSkills.length > 0)
    ? (() => {
        const skillsOrg = incomingSkills.map(s => importSkill(s.content, s.name)).join("\n\n");
        const parsed = parseOrgSections(`* SKILLS\n${skillsOrg}`);
        return parsed.find(s => s.title.toUpperCase() === "SKILLS");
      })()
    : undefined;
  const existingSkills_ = existingSections.find(s => s.title.toUpperCase() === "SKILLS");

  if (incomingSkills_ && existingSkills_) {
    const mergedChildren = [...existingSkills_.children];

    for (const inSkill of incomingSkills_.children) {
      const existingIdx = mergedChildren.findIndex(
        c => c.title.toLowerCase() === inSkill.title.toLowerCase()
      );
      if (existingIdx !== -1) {
        const existingText = rebuildSection(mergedChildren[existingIdx]);
        const incomingText = rebuildSection(inSkill);
        if (existingText.trim() !== incomingText.trim()) {
          mergedChildren[existingIdx] = inSkill;
          log.push({ section: "SKILLS", action: "updated", name: inSkill.title });
        } else {
          log.push({ section: "SKILLS", action: "unchanged", name: inSkill.title });
        }
      } else {
        mergedChildren.push(inSkill);
        log.push({ section: "SKILLS", action: "added", name: inSkill.title });
      }
    }

    for (const existSkill of existingSkills_.children) {
      const inImport = incomingSkills_.children.find(
        c => c.title.toLowerCase() === existSkill.title.toLowerCase()
      );
      if (!inImport) {
        log.push({ section: "SKILLS", action: "preserved", name: existSkill.title });
      }
    }

    const mergedSkillsSection: OrgSection = {
      ...existingSkills_,
      children: mergedChildren,
    };
    result = replaceSection(result, "SKILLS", rebuildSection(mergedSkillsSection));
  } else if (incomingSkills_ && !existingSkills_) {
    result = result.trimEnd() + "\n\n" + rebuildSection(incomingSkills_) + "\n";
    log.push({ section: "SKILLS", action: "added" });
  }

  return { mergedContent: result, log };
}
