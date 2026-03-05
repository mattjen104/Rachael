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
): { newContent: string; newStatus: string } {
  const lines = content.split("\n");
  const idx = lineNumber - 1;
  const line = lines[idx];

  if (!line) return { newContent: content, newStatus: "" };

  const headingMatch = line.match(/^(\*+\s+)(TODO|DONE)(\s.*)$/);
  if (!headingMatch) return { newContent: content, newStatus: "" };

  const prefix = headingMatch[1];
  const currentStatus = headingMatch[2];
  const rest = headingMatch[3];

  const newStatus = currentStatus === "TODO" ? "DONE" : "TODO";
  lines[idx] = `${prefix}${newStatus}${rest}`;

  return { newContent: lines.join("\n"), newStatus };
}
