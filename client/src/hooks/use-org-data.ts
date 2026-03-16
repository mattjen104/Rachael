import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { Program, Skill, Task, Note, Capture, AgentResult, ReaderPage, AgentConfig, OpenclawProposal, SiteProfile, NavigationPath, AuditLog } from "@shared/schema";

export function usePrograms() {
  return useQuery<Program[]>({ queryKey: ["/api/programs"] });
}

export function useProgram(id: number) {
  return useQuery<Program>({ queryKey: [`/api/programs/${id}`], enabled: id > 0 });
}

export function useToggleProgram() {
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/programs/${id}/toggle`);
      return res.json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/programs"] }); },
  });
}

export function useTriggerProgram() {
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/programs/${id}/trigger`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/programs"] });
      queryClient.invalidateQueries({ queryKey: ["/api/results"] });
      queryClient.invalidateQueries({ queryKey: ["/api/runtime"] });
    },
  });
}

export function useCreateProgram() {
  return useMutation({
    mutationFn: async (data: Partial<Program>) => {
      const res = await apiRequest("POST", "/api/programs", data);
      return res.json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/programs"] }); },
  });
}

export function useUpdateProgram() {
  return useMutation({
    mutationFn: async ({ id, ...data }: { id: number } & Partial<Program>) => {
      const res = await apiRequest("PATCH", `/api/programs/${id}`, data);
      return res.json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/programs"] }); },
  });
}

export function useDeleteProgram() {
  return useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/programs/${id}`);
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/programs"] }); },
  });
}

export function useSkills() {
  return useQuery<Skill[]>({ queryKey: ["/api/skills"] });
}

export function useTasks(status?: string) {
  const key = status ? `/api/tasks?status=${status}` : "/api/tasks";
  return useQuery<Task[]>({ queryKey: [key] });
}

export function useAgenda() {
  return useQuery<{
    overdue: Task[];
    today: Task[];
    upcoming: Task[];
    briefings: AgentResult[];
  }>({ queryKey: ["/api/tasks/agenda"] });
}

export function useCreateTask() {
  return useMutation({
    mutationFn: async (data: { title: string; status?: string; body?: string; scheduledDate?: string | null; deadlineDate?: string | null; priority?: string | null; tags?: string[]; parentId?: number | null }) => {
      const res = await apiRequest("POST", "/api/tasks", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks/agenda"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tree"] });
    },
  });
}

export function useUpdateTask() {
  return useMutation({
    mutationFn: async ({ id, ...data }: { id: number } & Partial<Task>) => {
      const res = await apiRequest("PATCH", `/api/tasks/${id}`, data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks/agenda"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tree"] });
    },
  });
}

export function useToggleTask() {
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/tasks/${id}/toggle`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks/agenda"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tree"] });
    },
  });
}

export function useDeleteTask() {
  return useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/tasks/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks/agenda"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tree"] });
    },
  });
}

export function useNotes() {
  return useQuery<Note[]>({ queryKey: ["/api/notes"] });
}

export function useCreateNote() {
  return useMutation({
    mutationFn: async (data: { title: string; body?: string; tags?: string[] }) => {
      const res = await apiRequest("POST", "/api/notes", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/notes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tree"] });
    },
  });
}

export function useCaptures() {
  return useQuery<Capture[]>({ queryKey: ["/api/captures?processed=false"] });
}

export function useCreateCapture() {
  return useMutation({
    mutationFn: async (data: { content: string; type?: string; source?: string }) => {
      const res = await apiRequest("POST", "/api/captures", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/captures"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tree"] });
    },
  });
}

export function useSmartCapture() {
  return useMutation({
    mutationFn: async (content: string) => {
      const res = await apiRequest("POST", "/api/captures/smart", { content });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
      queryClient.invalidateQueries({ queryKey: ["/api/notes"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tasks/agenda"] });
      queryClient.invalidateQueries({ queryKey: ["/api/tree"] });
    },
  });
}

export function useResults(programName?: string, limit?: number) {
  let key = "/api/results";
  const params: string[] = [];
  if (programName) params.push(`program=${programName}`);
  if (limit) params.push(`limit=${limit}`);
  if (params.length) key += "?" + params.join("&");
  return useQuery<AgentResult[]>({ queryKey: [key] });
}

export function useLatestResults(limit = 10) {
  return useQuery<AgentResult[]>({ queryKey: [`/api/results/latest?limit=${limit}`] });
}

export function useReaderPages() {
  return useQuery<ReaderPage[]>({ queryKey: ["/api/reader"] });
}

export function useCreateReaderPage() {
  return useMutation({
    mutationFn: async (url: string) => {
      const res = await apiRequest("POST", "/api/reader", { url });
      return res.json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/reader"] }); },
  });
}

export function useDeleteReaderPage() {
  return useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/reader/${id}`);
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/reader"] }); },
  });
}

export function useRuntime() {
  return useQuery<{ active: boolean; lastTick: string | null; programs: Array<{ name: string; status: string; lastRun: string | null; nextRun: string | null; lastOutput: string | null; error: string | null; iteration: number }> }>({
    queryKey: ["/api/runtime"],
    refetchInterval: 10000,
  });
}

export function useToggleRuntime() {
  return useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/runtime/toggle");
      return res.json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/runtime"] }); },
  });
}

export function useTreeData() {
  return useQuery<{
    tasks: Task[];
    programs: Program[];
    skills: Skill[];
    notes: Note[];
    captures: Capture[];
    reader: ReaderPage[];
  }>({ queryKey: ["/api/tree"] });
}

export function useAgentConfigs() {
  return useQuery<AgentConfig[]>({ queryKey: ["/api/config"] });
}

export function useProposals(status?: string) {
  const key = status ? `/api/proposals?status=${status}` : "/api/proposals";
  return useQuery<OpenclawProposal[]>({ queryKey: [key] });
}

export function useAcceptProposal() {
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/proposals/${id}/accept`);
      return res.json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/proposals"] }); },
  });
}

export function useRejectProposal() {
  return useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("POST", `/api/proposals/${id}/reject`);
      return res.json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/proposals"] }); },
  });
}

export function useSearch(query: string) {
  return useQuery<Array<{ type: string; id: number; title: string; snippet: string }>>({
    queryKey: [`/api/search?q=${encodeURIComponent(query)}`],
    enabled: query.length >= 1,
  });
}

export function useBridgeStatus() {
  return useQuery<{ running: boolean; pageCount: number; pages: string[]; authState: string; extension?: { connected: boolean; lastSeen?: number; version?: string; jobsCompleted?: number; lastError?: string } }>({
    queryKey: ["/api/bridge/status"],
    refetchInterval: 10000,
  });
}

export function useMailInbox() {
  return useQuery<Array<{ index: number; from: string; subject: string; preview: string; date: string; unread: boolean }>>({
    queryKey: ["/api/mail/inbox"],
    refetchInterval: 60000,
    retry: false,
  });
}

export function useTeamsChats() {
  return useQuery<Array<{ index: number; name: string; lastMessage: string; timestamp: string; unread: boolean }>>({
    queryKey: ["/api/chat/list"],
    refetchInterval: 60000,
    retry: false,
  });
}

export function useSiteProfiles() {
  return useQuery<SiteProfile[]>({ queryKey: ["/api/site-profiles"] });
}

export function useNavigationPaths(siteProfileId?: number) {
  const url = siteProfileId ? `/api/navigation-paths?siteProfileId=${siteProfileId}` : "/api/navigation-paths";
  return useQuery<NavigationPath[]>({ queryKey: [url] });
}

export function useExecuteScraper() {
  return useMutation({
    mutationFn: async (params: { navigationPathId?: number; url?: string }) => {
      const res = await apiRequest("POST", "/api/scraper/execute", params);
      return res.json();
    },
  });
}

export interface PausedExecutionState {
  id: string;
  type: "program" | "navigation";
  programName?: string;
  profileId?: number;
  navPathId?: number;
  stepIndex: number;
  pausedAt: string;
  context?: Record<string, unknown>;
}

export interface ControlState {
  mode: "human" | "agent";
  agentPaused: boolean;
  pendingTakeoverPoints: Array<{
    id: string;
    timestamp: string;
    action: string;
    target?: string;
    permissionLevel: string;
    status: string;
  }>;
  activityStream: Array<{
    id: string;
    timestamp: string;
    actor: string;
    type: string;
    action: string;
    target?: string;
    permissionLevel?: string;
    result?: string;
    details?: string;
  }>;
  pausedExecutions: PausedExecutionState[];
}

export function useControlState() {
  return useQuery<ControlState>({
    queryKey: ["/api/control"],
    refetchInterval: 3000,
  });
}

export function useToggleControlMode() {
  return useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/control/toggle");
      return res.json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/control"] }); },
  });
}

export function useResolveTakeoverPoint() {
  return useMutation({
    mutationFn: async ({ id, decision }: { id: string; decision: "confirm" | "reject" | "takeover" }) => {
      const res = await apiRequest("POST", `/api/control/takeover-points/${id}/resolve`, { decision });
      return res.json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/control"] }); },
  });
}

export function useAuditLog(limit = 100) {
  return useQuery<AuditLog[]>({
    queryKey: [`/api/audit-log?limit=${limit}`],
    refetchInterval: 10000,
  });
}

export function useUpdateSiteProfile() {
  return useMutation({
    mutationFn: async ({ id, ...data }: { id: number } & Partial<{ defaultPermission: string }>) => {
      const res = await apiRequest("PATCH", `/api/site-profiles/${id}`, data);
      return res.json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/site-profiles"] }); },
  });
}

export function useUpdateNavigationPath() {
  return useMutation({
    mutationFn: async ({ id, ...data }: { id: number } & Partial<{ permissionLevel: string }>) => {
      const res = await apiRequest("PATCH", `/api/navigation-paths/${id}`, data);
      return res.json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/navigation-paths"] }); },
  });
}

export function useActionPermissions() {
  return useQuery<Array<{ navPathId: number; actionName: string; level: string }>>({
    queryKey: ["/api/control/action-permissions"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/control/action-permissions");
      return res.json();
    },
    refetchInterval: 5000,
  });
}

export function useSetActionPermission() {
  return useMutation({
    mutationFn: async (data: { navPathId: number; actionName: string; level: string }) => {
      const res = await apiRequest("POST", "/api/control/action-permissions", data);
      return res.json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["/api/control/action-permissions"] }); },
  });
}
