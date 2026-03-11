import type { Request, Response, NextFunction } from "express";

interface SlidingWindow {
  timestamps: number[];
}

const readWindows = new Map<string, SlidingWindow>();
const writeWindows = new Map<string, SlidingWindow>();

const READ_LIMIT = 120;
const WRITE_LIMIT = 30;
const WINDOW_MS = 60 * 1000;

const CLEANUP_INTERVAL = 5 * 60 * 1000;

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.ip || req.socket.remoteAddress || "unknown";
}

function isWriteMethod(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}

function pruneWindow(window: SlidingWindow, now: number): void {
  const cutoff = now - WINDOW_MS;
  let i = 0;
  while (i < window.timestamps.length && window.timestamps[i] < cutoff) {
    i++;
  }
  if (i > 0) {
    window.timestamps.splice(0, i);
  }
}

function checkLimit(
  windows: Map<string, SlidingWindow>,
  key: string,
  limit: number,
  now: number
): { allowed: boolean; retryAfter: number; remaining: number } {
  let window = windows.get(key);
  if (!window) {
    window = { timestamps: [] };
    windows.set(key, window);
  }

  pruneWindow(window, now);

  if (window.timestamps.length >= limit) {
    const oldest = window.timestamps[0];
    const retryAfter = Math.ceil((oldest + WINDOW_MS - now) / 1000);
    return { allowed: false, retryAfter, remaining: 0 };
  }

  window.timestamps.push(now);
  return { allowed: true, retryAfter: 0, remaining: limit - window.timestamps.length };
}

setInterval(() => {
  const now = Date.now();
  const cutoff = now - WINDOW_MS;

  readWindows.forEach((window, key) => {
    pruneWindow(window, now);
    if (window.timestamps.length === 0) readWindows.delete(key);
  });
  writeWindows.forEach((window, key) => {
    pruneWindow(window, now);
    if (window.timestamps.length === 0) writeWindows.delete(key);
  });
}, CLEANUP_INTERVAL);

export function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith("/api")) {
    next();
    return;
  }

  const ip = getClientIp(req);
  const now = Date.now();
  const write = isWriteMethod(req.method);
  const windows = write ? writeWindows : readWindows;
  const limit = write ? WRITE_LIMIT : READ_LIMIT;

  const result = checkLimit(windows, ip, limit, now);

  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(result.remaining));

  if (!result.allowed) {
    res.setHeader("Retry-After", String(result.retryAfter));
    res.status(429).json({
      message: "Too many requests. Please try again later.",
      retryAfter: result.retryAfter,
    });
    return;
  }

  next();
}
