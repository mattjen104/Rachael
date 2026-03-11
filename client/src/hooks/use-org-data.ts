import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest, getStoredApiKey } from "@/lib/queryClient";
import type { OrgFile, ClipboardItem, AgendaItem } from "@shared/schema";

function authFetch(url: string, init?: RequestInit): Promise<Response> {
  const key = getStoredApiKey();
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> || {}),
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  };
  return fetch(url, { ...init, headers });
}

export function useOrgFiles() {
  return useQuery<OrgFile[]>({
    queryKey: ["/api/org-files"],
  });
}

export function useOrgFileByName(name: string) {
  return useQuery<OrgFile>({
    queryKey: [`/api/org-files/by-name/${name}`],
    enabled: !!name,
  });
}

export function useUpdateOrgFile() {
  return useMutation({
    mutationFn: async ({ id, content }: { id: number; content: string }) => {
      const res = await apiRequest("PATCH", `/api/org-files/${id}`, { content });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org-files"] });
    },
  });
}

export function useClipboardItems() {
  return useQuery<ClipboardItem[]>({
    queryKey: ["/api/clipboard"],
  });
}

export function useAddClipboardItem() {
  return useMutation({
    mutationFn: async (data: { content: string; type: string }) => {
      const res = await apiRequest("POST", "/api/clipboard", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clipboard"] });
    },
  });
}

export function useDeleteClipboardItem() {
  return useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/clipboard/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clipboard"] });
    },
  });
}

export function useTogglePin() {
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("PATCH", `/api/clipboard/${id}/pin`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clipboard"] });
    },
  });
}

export function useClipboardHistory() {
  return useQuery<ClipboardItem[]>({
    queryKey: ["/api/clipboard/history"],
  });
}

export function useUnarchiveClipboardItem() {
  return useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("POST", `/api/clipboard/${id}/unarchive`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clipboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/clipboard/history"] });
    },
  });
}

export function useUpdateClipboardItem() {
  return useMutation({
    mutationFn: async ({ id, content }: { id: number; content: string }) => {
      const res = await apiRequest("PATCH", `/api/clipboard/${id}`, { content });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clipboard"] });
    },
  });
}

export function useSmartCapture() {
  return useMutation({
    mutationFn: async (data: { content: string; orgFileName: string; clipboardId?: number; originalContent?: string }) => {
      const res = await apiRequest("POST", "/api/clipboard/smart-capture", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clipboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-files"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/agenda"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/todos"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/done"] });
    },
  });
}

export function useEnrichClipboard() {
  return useMutation({
    mutationFn: async (content: string) => {
      const res = await apiRequest("POST", "/api/clipboard/enrich", { content });
      return res.json();
    },
  });
}

export function useAppendClipboardToOrg() {
  return useMutation({
    mutationFn: async ({ clipId, orgFileName }: { clipId: number; orgFileName: string }) => {
      const res = await apiRequest("POST", `/api/clipboard/${clipId}/append-to-org`, { orgFileName });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/clipboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-files"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/agenda"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/todos"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/done"] });
    },
  });
}

export function useHeadingsSearch(query: string) {
  return useQuery<{ title: string; sourceFile: string; lineNumber: number; level: number; status: string | null; tags: string[] }[]>({
    queryKey: ["/api/org-query/headings", query],
    queryFn: async () => {
      const res = await authFetch(`/api/org-query/headings?q=${encodeURIComponent(query)}`);
      if (!res.ok) throw new Error("Failed to fetch headings");
      return res.json();
    },
    enabled: query.length > 0,
  });
}

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

export interface AgendaData {
  overdue: AgendaDay[];
  today: AgendaDay;
  upcoming: AgendaDay[];
}

export function useOrgAgenda() {
  return useQuery<AgendaData>({
    queryKey: ["/api/org-query/agenda"],
  });
}

export function useOrgTodos() {
  return useQuery<OrgHeading[]>({
    queryKey: ["/api/org-query/todos"],
  });
}

export function useOrgDone() {
  return useQuery<OrgHeading[]>({
    queryKey: ["/api/org-query/done"],
  });
}

export function useToggleOrgStatus() {
  return useMutation({
    mutationFn: async ({ fileName, lineNumber }: { fileName: string; lineNumber: number }) => {
      const res = await apiRequest("POST", "/api/org-query/toggle", { fileName, lineNumber });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/agenda"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/todos"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/done"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-files"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/journal-daily"] });
    },
  });
}

export function useRescheduleHeading() {
  return useMutation({
    mutationFn: async ({ fileName, lineNumber, newDate }: { fileName: string; lineNumber: number; newDate: string }) => {
      const res = await apiRequest("POST", "/api/org-query/reschedule", { fileName, lineNumber, newDate });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/agenda"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/todos"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/done"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-files"] });
    },
  });
}

export function useEditHeadingTitle() {
  return useMutation({
    mutationFn: async ({ fileName, lineNumber, newTitle }: { fileName: string; lineNumber: number; newTitle: string }) => {
      const res = await apiRequest("POST", "/api/org-query/edit-title", { fileName, lineNumber, newTitle });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/agenda"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/todos"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/done"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-files"] });
    },
  });
}

export function useEditTags() {
  return useMutation({
    mutationFn: async ({ fileName, lineNumber, tags }: { fileName: string; lineNumber: number; tags: string[] }) => {
      const res = await apiRequest("POST", "/api/org-query/edit-tags", { fileName, lineNumber, tags });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/headings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-files"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/backlinks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/compiled"] });
    },
  });
}

export function useEditProperty() {
  return useMutation({
    mutationFn: async ({ fileName, lineNumber, key, value }: { fileName: string; lineNumber: number; key: string; value: string }) => {
      const res = await apiRequest("POST", "/api/org-query/edit-property", { fileName, lineNumber, key, value });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/headings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-files"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/compiled"] });
    },
  });
}

export function useDeleteProperty() {
  return useMutation({
    mutationFn: async ({ fileName, lineNumber, key }: { fileName: string; lineNumber: number; key: string }) => {
      const res = await apiRequest("POST", "/api/org-query/delete-property", { fileName, lineNumber, key });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/headings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-files"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/compiled"] });
    },
  });
}

export function useDeleteHeading() {
  return useMutation({
    mutationFn: async ({ fileName, lineNumber }: { fileName: string; lineNumber: number }) => {
      const res = await apiRequest("POST", "/api/org-query/delete-heading", { fileName, lineNumber });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/agenda"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/todos"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/done"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-files"] });
    },
  });
}

export function useOrgCapture() {
  return useMutation({
    mutationFn: async (data: { fileName: string; title: string; scheduledDate?: string; tags?: string[]; template?: string; body?: string; description?: string; metric?: string; channelType?: string }) => {
      const res = await apiRequest("POST", "/api/org-files/capture", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org-files"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/agenda"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/todos"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/done"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/journal-daily"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/headings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/compiled"] });
    },
  });
}

export function useJournalDaily(date: string) {
  return useQuery<OrgHeading[]>({
    queryKey: ["/api/org-query/journal-daily", date],
    queryFn: async () => {
      const res = await authFetch(`/api/org-query/journal-daily?date=${date}`);
      if (!res.ok) return [];
      return res.json();
    },
    enabled: !!date,
  });
}

export function useJournalAdd() {
  return useMutation({
    mutationFn: async (data: { text: string }) => {
      const res = await apiRequest("POST", "/api/org-query/journal-add", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/journal-daily"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-files"] });
    },
  });
}

export function useDailyCapture() {
  return useMutation({
    mutationFn: async (data: { content: string }) => {
      const res = await apiRequest("POST", "/api/org-query/daily-capture", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/journal-daily"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/agenda"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/todos"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-files"] });
    },
  });
}

export function useAgendaItems() {
  return useQuery<AgendaItem[]>({
    queryKey: ["/api/agenda"],
  });
}

export function useCreateAgendaItem() {
  return useMutation({
    mutationFn: async (data: { text: string; status: string; scheduledDate: string }) => {
      const res = await apiRequest("POST", "/api/agenda", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agenda"] });
    },
  });
}

export function useToggleAgendaStatus() {
  return useMutation({
    mutationFn: async ({ id, status }: { id: number; status: string }) => {
      const res = await apiRequest("PATCH", `/api/agenda/${id}/status`, { status });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agenda"] });
    },
  });
}

export interface OutlineHeading {
  title: string;
  sourceFile: string;
  lineNumber: number;
  level: number;
  status: string | null;
  tags: string[];
  scheduledDate: string | null;
  body?: string;
  properties?: Record<string, string>;
}

export function useAllHeadings() {
  return useQuery<OutlineHeading[]>({
    queryKey: ["/api/org-query/headings", "all"],
    queryFn: async () => {
      const res = await authFetch("/api/org-query/headings?all=true");
      if (!res.ok) throw new Error("Failed to fetch headings");
      return res.json();
    },
  });
}

export function useInsertHeading() {
  return useMutation({
    mutationFn: async (data: { fileName: string; afterLine: number; level: number; title?: string; tags?: string[]; properties?: Record<string, string> }) => {
      const res = await apiRequest("POST", "/api/org-query/insert-heading", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/headings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-files"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/backlinks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/agenda"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/todos"] });
    },
  });
}

export function useMoveHeading() {
  return useMutation({
    mutationFn: async (data: { fileName: string; fromLine: number; toLine: number; newLevel?: number }) => {
      const res = await apiRequest("POST", "/api/org-query/move-heading", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/headings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-files"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/backlinks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/agenda"] });
    },
  });
}

export function useReorderBodyLine() {
  return useMutation({
    mutationFn: async (data: { fileName: string; headingLine: number; fromIndex: number; toIndex: number }) => {
      const res = await apiRequest("POST", "/api/org-query/reorder-body", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/headings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-files"] });
    },
  });
}

export function useMoveHeadingCross() {
  return useMutation({
    mutationFn: async (data: { fromFileName: string; fromLine: number; toFileName: string; toLine?: number; newLevel?: number }) => {
      const res = await apiRequest("POST", "/api/org-query/move-heading-cross", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/headings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-files"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/backlinks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/agenda"] });
    },
  });
}

// ── Browser Bridge / Scraping Hooks ──────────────────────

export function useBridgeStatus() {
  return useQuery<{
    running: boolean;
    pageCount: number;
    pages: Array<{ id: string; title: string; url: string }>;
    loginInProgress: boolean;
    visible: boolean;
    authState: string;
    lastError: string | null;
  }>({
    queryKey: ["/api/browser/status"],
    refetchInterval: 10000,
  });
}

export function useScrapeEmails() {
  return useQuery<{
    emails: Array<{ index: number; from: string; subject: string; preview: string; date: string; unread: boolean }>;
    error?: string;
  }>({
    queryKey: ["/api/mail/scrape"],
    enabled: false,
  });
}

export function useScrapeTeams() {
  return useQuery<{
    chats: Array<{ index: number; name: string; lastMessage: string; unread: boolean }>;
    error?: string;
  }>({
    queryKey: ["/api/teams/scrape"],
    enabled: false,
  });
}

export function useEmailDetail(index: number | null) {
  return useQuery<{ from: string; to: string; subject: string; body: string; date: string }>({
    queryKey: ["/api/mail", index],
    queryFn: async () => {
      const res = await authFetch(`/api/mail/${index}`);
      if (!res.ok) throw new Error("Failed to fetch email");
      return res.json();
    },
    enabled: index !== null,
  });
}

export function useTeamsChatMessages(index: number | null) {
  return useQuery<{ messages: Array<{ sender: string; text: string; time: string }> }>({
    queryKey: ["/api/teams/chat", index],
    queryFn: async () => {
      const res = await authFetch(`/api/teams/chat/${index}`);
      if (!res.ok) throw new Error("Failed to fetch chat");
      return res.json();
    },
    enabled: index !== null,
  });
}

export function useOpenClawStatus() {
  return useQuery<{
    exists: boolean;
    errorCount?: number;
    errors?: string[];
    skillCount?: number;
    programCount?: number;
    activeProgramCount?: number;
    pendingProposalCount?: number;
    lastSync?: { timestamp: string; status: string; details?: string } | null;
  }>({
    queryKey: ["/api/openclaw/status"],
    queryFn: async () => {
      const res = await authFetch("/api/openclaw/status");
      if (!res.ok) throw new Error("Failed to fetch status");
      return res.json();
    },
    refetchInterval: 15000,
  });
}

export function useOpenClawCompiled(enabled: boolean = false) {
  return useQuery<{
    soul: string;
    skills: { name: string; content: string }[];
    config: any;
    routing: Record<string, string>;
    programs: Array<{
      name: string;
      status: string;
      active: boolean;
      schedule: string;
      scheduledRaw: string | null;
      properties: Record<string, string>;
      instructions: string;
      results: string;
      tags: string[];
    }>;
    memory: {
      userProfile: string;
      persistentContext: string;
      sessionLog: string;
    };
    errors: string[];
  }>({
    queryKey: ["/api/openclaw/compiled"],
    queryFn: async () => {
      const res = await authFetch("/api/openclaw/compiled");
      if (!res.ok) throw new Error("Failed to fetch compiled");
      return res.json();
    },
    enabled,
  });
}

export function useOpenClawProposals() {
  return useQuery<Array<{
    id: number;
    section: string;
    targetName: string | null;
    reason: string;
    currentContent: string;
    proposedContent: string;
    status: string;
    source: string;
    warnings: string | null;
    proposalType: string;
    createdAt: string;
    resolvedAt: string | null;
  }>>({
    queryKey: ["/api/openclaw/proposals", "actionable"],
    queryFn: async () => {
      const [pending, approved] = await Promise.all([
        authFetch("/api/openclaw/proposals?status=pending").then(r => r.json()),
        authFetch("/api/openclaw/proposals?status=approved").then(r => r.json()),
      ]);
      return [...pending, ...approved];
    },
    refetchInterval: 15000,
  });
}

export function useOpenClawVersions() {
  return useQuery<Array<{ id: number; label: string; createdAt: string }>>({
    queryKey: ["/api/openclaw/versions"],
    queryFn: async () => {
      const res = await authFetch("/api/openclaw/versions");
      if (!res.ok) throw new Error("Failed to fetch versions");
      return res.json();
    },
  });
}

export function useAcceptProposal() {
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/openclaw/proposals/${id}/accept`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/proposals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/versions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/compiled"] });
    },
  });
}

export function useRejectProposal() {
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/openclaw/proposals/${id}/reject`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/proposals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/status"] });
    },
  });
}

export function useRestoreVersion() {
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/openclaw/versions/${id}/restore`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/versions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/compiled"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/status"] });
    },
  });
}

export function useRecompileOpenClaw() {
  return useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/openclaw/compile");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/compiled"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/status"] });
    },
  });
}

export function useRuntimeState() {
  return useQuery({
    queryKey: ["/api/openclaw/runtime"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/openclaw/runtime");
      return res.json();
    },
    refetchInterval: 10_000,
  });
}

export function useToggleRuntime() {
  return useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/openclaw/runtime/toggle");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/runtime"] });
    },
  });
}

export function useTriggerProgram() {
  return useMutation({
    mutationFn: async (programName: string) => {
      const res = await apiRequest("POST", `/api/openclaw/runtime/run/${encodeURIComponent(programName)}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/runtime"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/compiled"] });
    },
  });
}

export function useResearchProgram() {
  return useMutation({
    mutationFn: async (programName: string) => {
      const res = await apiRequest("POST", `/api/openclaw/runtime/research/${encodeURIComponent(programName)}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/runtime"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/compiled"] });
    },
  });
}

export function useHardenCandidates() {
  return useQuery({
    queryKey: ["/api/openclaw/runtime/harden-candidates"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/openclaw/runtime/harden-candidates");
      return res.json();
    },
    refetchInterval: 30_000,
  });
}

export function useHardenProgram() {
  return useMutation({
    mutationFn: async (programName: string) => {
      const res = await apiRequest("POST", `/api/openclaw/runtime/harden/${encodeURIComponent(programName)}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/runtime"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/compiled"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/runtime/harden-candidates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/proposals"] });
    },
  });
}

export function useCommitProposal() {
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/openclaw/proposals/${id}/commit`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/proposals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/versions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/compiled"] });
    },
  });
}

export function useCommitHarden() {
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/openclaw/proposals/${id}/commit-harden`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/proposals"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/versions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/compiled"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/runtime"] });
      queryClient.invalidateQueries({ queryKey: ["/api/openclaw/runtime/harden-candidates"] });
    },
  });
}

export function useLLMStatus() {
  return useQuery({
    queryKey: ["/api/openclaw/llm-status"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/openclaw/llm-status");
      return res.json();
    },
  });
}

export function useSeedData() {
  return useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/seed");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org-files"] });
      queryClient.invalidateQueries({ queryKey: ["/api/clipboard"] });
      queryClient.invalidateQueries({ queryKey: ["/api/agenda"] });
    },
  });
}
