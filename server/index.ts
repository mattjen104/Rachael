import express, { type Request, Response, NextFunction } from "express";
import cors from "cors";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { rateLimitMiddleware } from "./rate-limit";
const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(cors({
  origin: true,
  credentials: true,
}));

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

app.use(rateLimitMiddleware);

app.get("/launch", (req: Request, res: Response) => {
  const host = req.headers.host || "localhost:5000";
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "http";
  const baseUrl = `${proto}://${host}`;
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html><head><title>Rachael</title></head>
<body style="background:#1a1a2e;color:#aaa;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<script>
var w=420,h=720;
var left=(screen.width-w)/2,top_=(screen.height-h)/2;
var win=window.open("${baseUrl}","rachael","width="+w+",height="+h+",left="+left+",top="+top_+",menubar=no,toolbar=no,location=no,status=no,resizable=yes,scrollbars=no");
if(win){document.body.innerHTML="<p>Rachael launched. You can close this tab.</p>";}
else{document.body.innerHTML="<p>Popup blocked. <a href='${baseUrl}' target='_blank' style='color:#bd93f9'>Click here</a> to open Rachael.</p>";}
</script>
<noscript><a href="${baseUrl}">Open Rachael</a></noscript>
</body></html>`);
});

const API_KEY = process.env.OPENCLAW_API_KEY;
app.get("/api/auth/check", (_req: Request, res: Response) => {
  res.json({ requiresAuth: !!API_KEY });
});

app.use((req: Request, res: Response, next: NextFunction) => {
  if (!req.path.startsWith("/api") || req.path === "/api/auth/check" || req.path === "/api/cockpit/events" || req.path.startsWith("/api/bridge/") || req.path.startsWith("/api/epic/agent/") || req.path.startsWith("/api/epic/record/") || req.path.startsWith("/api/epic/activities") || req.path.startsWith("/api/epic/tree") || req.path.startsWith("/api/epic/grammar") || req.path.startsWith("/api/secrets/form/") || req.path === "/api/secrets/submit") return next();

  if (!API_KEY) {
    const writeMethods = ["POST", "PUT", "PATCH", "DELETE"];
    if (writeMethods.includes(req.method)) {
      return res.status(401).json({ message: "OPENCLAW_API_KEY not configured — write operations disabled" });
    }
    return next();
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.slice(7) !== API_KEY) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  next();
});

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      const sensitiveRoutes = ["/api/mail/", "/api/chat/", "/api/secrets", "/api/outlook-emails", "/api/snow-tickets", "/api/boot/", "/api/bridge/"];
      const isSensitive = sensitiveRoutes.some(r => path.startsWith(r));
      if (capturedJsonResponse && !isSensitive) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  const { initRuntime } = await import("./agent-runtime");
  await registerRoutes(httpServer, app);
  initRuntime();

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
    },
  );
})();
