export interface OrgHeading {
  level: number;
  status: "TODO" | "DONE" | null;
  title: string;
  tags: string[];
  scheduledDate: string | null;
  deadlineDate: string | null;
  closedDate: string | null;
  properties: Record<string, string>;
  body: string;
  sourceFile: string;
  lineNumber: number;
}

export interface AgendaDay {
  date: string;
  label: string;
  items: OrgHeading[];
}

export function parseOrgFile(content: string, fileName: string): OrgHeading[] {
  const lines = content.split("\n");
  const headings: OrgHeading[] = [];
  let current: OrgHeading | null = null;
  let inProperties = false;
  let bodyLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headingMatch = line.match(/^(\*+)\s+(TODO|DONE)?\s*(.*?)(?:\s+(:[a-zA-Z0-9_:]+:))?\s*$/);

    if (headingMatch) {
      if (current) {
        current.body = bodyLines.join("\n").trim();
        headings.push(current);
      }

      const level = headingMatch[1].length;
      const status = (headingMatch[2] as "TODO" | "DONE") || null;
      const title = headingMatch[3].trim();
      const rawTags = headingMatch[4] || "";
      const tags = rawTags
        .split(":")
        .filter((t) => t.length > 0);

      current = {
        level,
        status,
        title,
        tags,
        scheduledDate: null,
        deadlineDate: null,
        closedDate: null,
        properties: {},
        body: "",
        sourceFile: fileName,
        lineNumber: i + 1,
      };
      bodyLines = [];
      inProperties = false;
      continue;
    }

    if (!current) continue;

    if (line.trim() === ":PROPERTIES:") {
      inProperties = true;
      continue;
    }
    if (line.trim() === ":END:") {
      inProperties = false;
      continue;
    }
    if (inProperties) {
      const propMatch = line.match(/^\s+:([A-Z_]+):\s+(.+)$/);
      if (propMatch) {
        current.properties[propMatch[1]] = propMatch[2];
      }
      continue;
    }

    const scheduledMatch = line.match(/SCHEDULED:\s+<(\d{4}-\d{2}-\d{2})/);
    if (scheduledMatch) {
      current.scheduledDate = scheduledMatch[1];
    }

    const deadlineMatch = line.match(/DEADLINE:\s+<(\d{4}-\d{2}-\d{2})/);
    if (deadlineMatch) {
      current.deadlineDate = deadlineMatch[1];
    }

    const closedMatch = line.match(/CLOSED:\s+\[(\d{4}-\d{2}-\d{2})/);
    if (closedMatch) {
      current.closedDate = closedMatch[1];
    }

    bodyLines.push(line);
  }

  if (current) {
    current.body = bodyLines.join("\n").trim();
    headings.push(current);
  }

  return headings;
}

export function buildAgenda(
  allHeadings: OrgHeading[],
  today: string
): { overdue: AgendaDay[]; today: AgendaDay; upcoming: AgendaDay[] } {
  const todayItems: OrgHeading[] = [];
  const overdueMap = new Map<string, OrgHeading[]>();
  const upcomingMap = new Map<string, OrgHeading[]>();

  for (const h of allHeadings) {
    if (!h.status) continue;

    const date = h.scheduledDate || h.deadlineDate;

    if (!date) {
      if (h.status === "TODO") {
        todayItems.push(h);
      }
      continue;
    }

    if (date === today) {
      todayItems.push(h);
    } else if (date < today && h.status === "TODO") {
      if (!overdueMap.has(date)) overdueMap.set(date, []);
      overdueMap.get(date)!.push(h);
    } else if (date > today) {
      if (!upcomingMap.has(date)) upcomingMap.set(date, []);
      upcomingMap.get(date)!.push(h);
    }
  }

  const overdueDays = Array.from(overdueMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, items]) => ({
      date,
      label: formatDateLabel(date),
      items,
    }));

  const upcomingDays = Array.from(upcomingMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 14)
    .map(([date, items]) => ({
      date,
      label: formatDateLabel(date),
      items,
    }));

  return {
    overdue: overdueDays,
    today: { date: today, label: "Today", items: todayItems },
    upcoming: upcomingDays,
  };
}

function formatDateLabel(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()}`;
}

export function toggleHeadingStatus(
  content: string,
  lineNumber: number
): { newContent: string; newStatus: string; title: string } {
  const lines = content.split("\n");
  const idx = lineNumber - 1;
  const line = lines[idx];

  if (!line) return { newContent: content, newStatus: "", title: "" };

  const headingMatch = line.match(/^(\*+\s+)(TODO|DONE)(\s.*)$/);
  if (!headingMatch) return { newContent: content, newStatus: "", title: "" };

  const prefix = headingMatch[1];
  const currentStatus = headingMatch[2];
  const rest = headingMatch[3];
  const title = rest.replace(/\s+:[a-zA-Z0-9_:]+:\s*$/, "").trim();

  const newStatus = currentStatus === "TODO" ? "DONE" : "TODO";
  lines[idx] = `${prefix}${newStatus}${rest}`;

  if (newStatus === "DONE") {
    const now = new Date();
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const pad = (n: number) => String(n).padStart(2, "0");
    const closedStr = `   CLOSED: [${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${days[now.getDay()]} ${pad(now.getHours())}:${pad(now.getMinutes())}]`;
    let insertAt = idx + 1;
    while (insertAt < lines.length) {
      const l = lines[insertAt].trim();
      if (/^(SCHEDULED|DEADLINE|CLOSED):/.test(l)) {
        if (/^CLOSED:/.test(l)) {
          lines.splice(insertAt, 1);
          continue;
        }
        insertAt++;
      } else break;
    }
    lines.splice(insertAt, 0, closedStr);
  } else {
    let checkAt = idx + 1;
    while (checkAt < lines.length) {
      const l = lines[checkAt].trim();
      if (/^CLOSED:/.test(l)) {
        lines.splice(checkAt, 1);
        continue;
      }
      if (/^(SCHEDULED|DEADLINE):/.test(l)) { checkAt++; continue; }
      break;
    }
  }

  return { newContent: lines.join("\n"), newStatus, title };
}

export function ensureDailyHeading(content: string, date: Date): { content: string; insertionPoint: number } {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateStr = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const dayName = days[date.getDay()];
  const heading = `* ${dateStr} ${dayName}`;

  const lines = content.split("\n");
  const headingRegex = new RegExp(`^\\*\\s+${dateStr.replace(/-/g, "\\-")}\\s`);

  for (let i = 0; i < lines.length; i++) {
    if (headingRegex.test(lines[i])) {
      let insertAt = i + 1;
      while (insertAt < lines.length && !lines[insertAt].match(/^\*\s/)) {
        insertAt++;
      }
      const byteOffset = lines.slice(0, insertAt).join("\n").length + 1;
      return { content, insertionPoint: byteOffset };
    }
  }

  let insertIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^\*\s+(\d{4}-\d{2}-\d{2})\s/);
    if (m && m[1] < dateStr) {
      insertIdx = i;
      break;
    }
  }

  if (insertIdx === -1) {
    let lastHeader = 0;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].match(/^#\+/)) lastHeader = i + 1;
    }
    if (lastHeader === 0) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].match(/^\*\s/)) { lastHeader = i; break; }
      }
    }
    lines.splice(lastHeader, 0, "", heading);
    insertIdx = lastHeader + 2;
  } else {
    lines.splice(insertIdx, 0, "", heading);
    insertIdx = insertIdx + 2;
  }

  const newContent = lines.join("\n");
  const byteOffset = lines.slice(0, insertIdx).join("\n").length + 1;
  return { content: newContent, insertionPoint: byteOffset };
}

export function appendToDaily(content: string, date: Date, entry: string): string {
  const result = ensureDailyHeading(content, date);
  const before = result.content.slice(0, result.insertionPoint);
  const after = result.content.slice(result.insertionPoint);
  return before + entry + "\n" + after;
}

export function rescheduleHeading(
  content: string,
  lineNumber: number,
  newDate: string
): { newContent: string } {
  const lines = content.split("\n");
  const idx = lineNumber - 1;
  const line = lines[idx];

  if (!line || !line.match(/^\*+\s/)) return { newContent: content };

  const headingLevel = line.match(/^(\*+)/)?.[1].length || 1;

  for (let i = idx + 1; i < lines.length; i++) {
    const nextHeading = lines[i].match(/^(\*+)\s/);
    if (nextHeading && nextHeading[1].length <= headingLevel) break;

    if (lines[i].match(/^\s+SCHEDULED:\s*<[^>]*>/)) {
      lines[i] = lines[i].replace(/SCHEDULED:\s*<[^>]*>/, `SCHEDULED: <${newDate}>`);
      return { newContent: lines.join("\n") };
    }
  }

  lines.splice(idx + 1, 0, `   SCHEDULED: <${newDate}>`);
  return { newContent: lines.join("\n") };
}

export function editHeadingTitle(
  content: string,
  lineNumber: number,
  newTitle: string
): { newContent: string } {
  const lines = content.split("\n");
  const idx = lineNumber - 1;
  const line = lines[idx];

  if (!line) return { newContent: content };

  const match = line.match(/^(\*+\s+)(TODO\s+|DONE\s+)?(.*?)(\s+:[a-zA-Z0-9_:]+:)?\s*$/);
  if (!match) return { newContent: content };

  const stars = match[1];
  const status = match[2] || "";
  const tags = match[4] || "";

  lines[idx] = `${stars}${status}${newTitle.trim()}${tags}`;
  return { newContent: lines.join("\n") };
}

export function deleteHeading(
  content: string,
  lineNumber: number
): { newContent: string } {
  const lines = content.split("\n");
  const idx = lineNumber - 1;
  const line = lines[idx];

  if (!line || !line.match(/^\*+\s/)) return { newContent: content };

  const headingLevel = line.match(/^(\*+)/)?.[1].length || 1;

  let endIdx = idx + 1;
  while (endIdx < lines.length) {
    const nextHeading = lines[endIdx].match(/^(\*+)\s/);
    if (nextHeading && nextHeading[1].length <= headingLevel) break;
    endIdx++;
  }

  lines.splice(idx, endIdx - idx);
  return { newContent: lines.join("\n") };
}

export function extractHeadingBlock(
  content: string,
  lineNumber: number
): { block: string[]; startIdx: number; endIdx: number } | null {
  const lines = content.split("\n");
  const idx = lineNumber - 1;
  const line = lines[idx];

  if (!line || !line.match(/^\*+\s/)) return null;

  const headingLevel = line.match(/^(\*+)/)?.[1].length || 1;

  let endIdx = idx + 1;
  while (endIdx < lines.length) {
    const nextHeading = lines[endIdx].match(/^(\*+)\s/);
    if (nextHeading && nextHeading[1].length <= headingLevel) break;
    endIdx++;
  }

  return { block: lines.slice(idx, endIdx), startIdx: idx, endIdx };
}

export function changeHeadingLevel(
  block: string[],
  fromLevel: number,
  toLevel: number
): string[] {
  const diff = toLevel - fromLevel;
  if (diff === 0) return block;

  return block.map((line) => {
    const match = line.match(/^(\*+)(\s.*)$/);
    if (!match) return line;
    const currentLevel = match[1].length;
    const newLevel = Math.max(1, currentLevel + diff);
    return "*".repeat(newLevel) + match[2];
  });
}

export function editTags(
  content: string,
  lineNumber: number,
  tags: string[]
): { newContent: string } {
  const lines = content.split("\n");
  const idx = lineNumber - 1;
  const line = lines[idx];

  if (!line) return { newContent: content };

  const match = line.match(/^(\*+\s+)(TODO\s+|DONE\s+)?(.*?)(\s+:[a-zA-Z0-9_:]+:)?\s*$/);
  if (!match) return { newContent: content };

  const stars = match[1];
  const status = match[2] || "";
  const title = match[3].trim();
  const cleanTags = tags.filter(t => t.length > 0);
  const tagStr = cleanTags.length > 0 ? ` :${cleanTags.join(":")}:` : "";

  lines[idx] = `${stars}${status}${title}${tagStr}`;
  return { newContent: lines.join("\n") };
}

export function insertHeading(
  content: string,
  afterLine: number,
  level: number,
  title: string = "",
  tags?: string[],
  properties?: Record<string, string>,
  status?: string
): { newContent: string; newLineNumber: number } {
  const lines = content.split("\n");
  const idx = afterLine - 1;

  let insertIdx = idx + 1;
  if (idx >= 0 && idx < lines.length) {
    const line = lines[idx];
    const headingMatch = line.match(/^(\*+)\s/);
    if (headingMatch) {
      const headingLevel = headingMatch[1].length;
      while (insertIdx < lines.length) {
        const nextMatch = lines[insertIdx].match(/^(\*+)\s/);
        if (nextMatch && nextMatch[1].length <= headingLevel) break;
        insertIdx++;
      }
    }
  }

  const stars = "*".repeat(level);
  const statusStr = status ? `${status} ` : "";
  const tagStr = tags && tags.length > 0 ? ` :${tags.join(":")}:` : "";
  let headingLine = `${stars} ${statusStr}${title}${tagStr}`;

  const newLines: string[] = [headingLine];

  if (properties && Object.keys(properties).length > 0) {
    newLines.push("   :PROPERTIES:");
    for (const [key, value] of Object.entries(properties)) {
      newLines.push(`   :${key}: ${value}`);
    }
    newLines.push("   :END:");
  }

  lines.splice(insertIdx, 0, ...newLines);

  const newLineNumber = insertIdx + 1;
  return { newContent: lines.join("\n"), newLineNumber };
}

export function editProperty(
  content: string,
  lineNumber: number,
  key: string,
  value: string
): { newContent: string } {
  const lines = content.split("\n");
  const idx = lineNumber - 1;
  if (idx < 0 || idx >= lines.length) return { newContent: content };

  const headMatch = lines[idx].match(/^(\*+)\s/);
  if (!headMatch) return { newContent: content };
  const headLevel = headMatch[1].length;

  let propsStart = -1;
  let propsEnd = -1;
  let existingPropIdx = -1;

  for (let i = idx + 1; i < lines.length; i++) {
    const nextHead = lines[i].match(/^(\*+)\s/);
    if (nextHead && nextHead[1].length <= headLevel) break;

    if (lines[i].trim() === ":PROPERTIES:") {
      propsStart = i;
      continue;
    }
    if (lines[i].trim() === ":END:" && propsStart !== -1) {
      propsEnd = i;
      break;
    }
    if (propsStart !== -1 && propsEnd === -1) {
      const propMatch = lines[i].match(/^\s+:([A-Za-z0-9_]+):/);
      if (propMatch && propMatch[1].toUpperCase() === key.toUpperCase()) {
        existingPropIdx = i;
      }
    }
  }

  const propLine = `   :${key.toUpperCase()}: ${value}`;

  if (existingPropIdx !== -1) {
    lines[existingPropIdx] = propLine;
  } else if (propsStart !== -1 && propsEnd !== -1) {
    lines.splice(propsEnd, 0, propLine);
  } else {
    lines.splice(idx + 1, 0, "   :PROPERTIES:", propLine, "   :END:");
  }

  return { newContent: lines.join("\n") };
}

export function deleteProperty(
  content: string,
  lineNumber: number,
  key: string
): { newContent: string } {
  const lines = content.split("\n");
  const idx = lineNumber - 1;
  if (idx < 0 || idx >= lines.length) return { newContent: content };

  const headMatch = lines[idx].match(/^(\*+)\s/);
  if (!headMatch) return { newContent: content };
  const headLevel = headMatch[1].length;

  let propsStart = -1;
  let propsEnd = -1;
  let propIdx = -1;
  let propCount = 0;

  for (let i = idx + 1; i < lines.length; i++) {
    const nextHead = lines[i].match(/^(\*+)\s/);
    if (nextHead && nextHead[1].length <= headLevel) break;

    if (lines[i].trim() === ":PROPERTIES:") {
      propsStart = i;
      continue;
    }
    if (lines[i].trim() === ":END:" && propsStart !== -1) {
      propsEnd = i;
      break;
    }
    if (propsStart !== -1 && propsEnd === -1) {
      const propMatch = lines[i].match(/^\s+:([A-Za-z0-9_]+):/);
      if (propMatch) {
        propCount++;
        if (propMatch[1].toUpperCase() === key.toUpperCase()) {
          propIdx = i;
        }
      }
    }
  }

  if (propIdx === -1) return { newContent: content };

  if (propCount === 1 && propsStart !== -1 && propsEnd !== -1) {
    lines.splice(propsStart, propsEnd - propsStart + 1);
  } else {
    lines.splice(propIdx, 1);
  }

  return { newContent: lines.join("\n") };
}

export function findParentSection(
  content: string,
  lineNumber: number
): string | null {
  const lines = content.split("\n");
  const idx = lineNumber - 1;
  if (idx < 0 || idx >= lines.length) return null;

  const currentMatch = lines[idx].match(/^(\*+)\s/);
  if (!currentMatch) return null;
  const currentLevel = currentMatch[1].length;

  for (let i = idx - 1; i >= 0; i--) {
    const match = lines[i].match(/^(\*+)\s+(TODO\s+|DONE\s+)?(.*?)(?:\s+:[a-zA-Z0-9_:]+:)?\s*$/);
    if (match && match[1].length < currentLevel) {
      return match[3].trim();
    }
  }
  return null;
}

export function moveHeadingWithinFile(
  content: string,
  fromLine: number,
  toLine: number,
  newLevel?: number
): { newContent: string } {
  const extracted = extractHeadingBlock(content, fromLine);
  if (!extracted) return { newContent: content };

  let block = extracted.block;
  const fromLevel = block[0].match(/^(\*+)/)?.[1].length || 1;

  if (newLevel && newLevel !== fromLevel) {
    block = changeHeadingLevel(block, fromLevel, newLevel);
  }

  const lines = content.split("\n");
  lines.splice(extracted.startIdx, extracted.endIdx - extracted.startIdx);

  let insertIdx = toLine - 1;
  if (insertIdx > extracted.startIdx) {
    insertIdx -= block.length;
  }
  insertIdx = Math.max(0, Math.min(insertIdx, lines.length));

  lines.splice(insertIdx, 0, ...block);
  return { newContent: lines.join("\n") };
}
