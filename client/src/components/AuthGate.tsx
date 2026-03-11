import { useState, useEffect, useCallback } from "react";
import { getStoredApiKey, setStoredApiKey } from "@/lib/queryClient";

interface AuthGateProps {
  children: React.ReactNode;
}

export default function AuthGate({ children }: AuthGateProps) {
  const [state, setState] = useState<"checking" | "needs-key" | "authenticated">("checking");
  const [keyInput, setKeyInput] = useState("");
  const [error, setError] = useState("");

  const checkAuth = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/check");
      const data = await res.json();
      if (!data.requiresAuth) {
        setState("authenticated");
        return;
      }
      const storedKey = getStoredApiKey();
      if (storedKey) {
        const testRes = await fetch("/api/org-files", {
          headers: { Authorization: `Bearer ${storedKey}` },
        });
        if (testRes.ok) {
          setState("authenticated");
          return;
        }
      }
      setState("needs-key");
    } catch {
      setState("authenticated");
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      const res = await fetch("/api/org-files", {
        headers: { Authorization: `Bearer ${keyInput.trim()}` },
      });
      if (res.ok) {
        setStoredApiKey(keyInput.trim());
        setState("authenticated");
      } else {
        setError("Invalid key");
      }
    } catch {
      setError("Connection failed");
    }
  };

  if (state === "checking") {
    return (
      <div data-testid="auth-loading" style={{
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--background)",
        color: "var(--foreground)",
        fontFamily: "var(--font-mono)",
      }}>
        ...
      </div>
    );
  }

  if (state === "needs-key") {
    return (
      <div data-testid="auth-gate" style={{
        height: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--background)",
        color: "var(--foreground)",
        fontFamily: "var(--font-mono)",
      }}>
        <form onSubmit={handleSubmit} style={{
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          width: "360px",
          padding: "24px",
          border: "1px solid var(--border)",
        }}>
          <div style={{ fontSize: "14px", opacity: 0.7 }}>orgcloud</div>
          <div style={{ fontSize: "12px", opacity: 0.5 }}>Enter API key to continue</div>
          <input
            data-testid="input-api-key"
            type="password"
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="OPENCLAW_API_KEY"
            autoFocus
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--foreground)",
              padding: "8px",
              fontFamily: "inherit",
              fontSize: "13px",
              outline: "none",
            }}
          />
          {error && <div data-testid="text-auth-error" style={{ color: "var(--destructive)", fontSize: "12px" }}>{error}</div>}
          <button
            data-testid="button-auth-submit"
            type="submit"
            style={{
              background: "var(--foreground)",
              color: "var(--background)",
              border: "none",
              padding: "8px",
              fontFamily: "inherit",
              fontSize: "13px",
              cursor: "pointer",
            }}
          >
            authenticate
          </button>
        </form>
      </div>
    );
  }

  return <>{children}</>;
}
