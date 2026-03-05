import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { OrgFile, ClipboardItem, AgendaItem } from "@shared/schema";

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
    mutationFn: async (data: { content: string; orgFileName: string; clipboardId?: number }) => {
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
    },
  });
}

export function useOrgCapture() {
  return useMutation({
    mutationFn: async (data: { fileName: string; title: string; scheduledDate?: string; tags?: string[] }) => {
      const res = await apiRequest("POST", "/api/org-files/capture", data);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/org-files"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/agenda"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/todos"] });
      queryClient.invalidateQueries({ queryKey: ["/api/org-query/done"] });
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

export function useCarryOverTasks() {
  return useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/agenda/carry-over");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/agenda"] });
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
