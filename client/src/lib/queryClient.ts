import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE_STORAGE = "rachael_api_base";
const AUTH_KEY_STORAGE = "orgcloud_api_key";

export function getApiBase(): string {
  const envBase = import.meta.env.VITE_API_BASE;
  if (envBase) return envBase.replace(/\/$/, "");
  try {
    const stored = localStorage.getItem(API_BASE_STORAGE);
    if (stored) return stored.replace(/\/$/, "");
  } catch {}
  return "";
}

export function setApiBase(url: string) {
  localStorage.setItem(API_BASE_STORAGE, url.replace(/\/$/, ""));
}

export function apiUrl(path: string): string {
  const base = getApiBase();
  return base ? base + path : path;
}

export function getStoredApiKey(): string | null {
  return localStorage.getItem(AUTH_KEY_STORAGE);
}

export function setStoredApiKey(key: string) {
  localStorage.setItem(AUTH_KEY_STORAGE, key);
}

export function clearStoredApiKey() {
  localStorage.removeItem(AUTH_KEY_STORAGE);
}

function getAuthHeaders(): Record<string, string> {
  const key = getStoredApiKey();
  if (key) {
    return { Authorization: `Bearer ${key}` };
  }
  return {};
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const headers: Record<string, string> = {
    ...getAuthHeaders(),
    ...(data ? { "Content-Type": "application/json" } : {}),
  };

  const res = await fetch(apiUrl(url), {
    method,
    headers,
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(apiUrl(queryKey.join("/") as string), {
      credentials: "include",
      headers: getAuthHeaders(),
    });

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
