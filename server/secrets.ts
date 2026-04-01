import crypto from "crypto";
import { storage } from "./storage";
import { emitEvent } from "./event-bus";

const MAGIC_TOKEN_TTL_MS = 10 * 60 * 1000;
const ALGORITHM = "aes-256-gcm";

function getEncryptionKey(): Buffer {
  const raw = process.env.OPENCLAW_API_KEY || "";
  return crypto.createHash("sha256").update(raw).digest();
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function encrypt(plaintext: string): { encrypted: string; iv: string; authTag: string } {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(plaintext, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex");
  return { encrypted, iv: iv.toString("hex"), authTag };
}

function decrypt(encrypted: string, iv: string, authTag: string): string {
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(authTag, "hex"));
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

export interface SecretField {
  name: string;
  label: string;
  description?: string;
  type: "password" | "text";
  required: boolean;
  placeholder?: string;
}

export interface SecretRequest {
  requestId: string;
  fields: SecretField[];
  purpose: string;
  magicTokenHash: string;
  status: "pending" | "completed" | "expired";
  createdAt: string;
  expiresAt: string;
}

export async function createSecretRequest(
  fields: SecretField[],
  purpose: string
): Promise<{ requestId: string; magicToken: string }> {
  const requestId = `sec_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const magicToken = crypto.randomBytes(24).toString("base64url");
  const magicTokenHash = hashToken(magicToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + MAGIC_TOKEN_TTL_MS);

  await storage.setAgentConfig(
    `secret_request:${requestId}`,
    JSON.stringify({
      requestId,
      fields,
      purpose,
      magicTokenHash,
      status: "pending",
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    }),
    "secrets"
  );

  emitEvent("secrets", `Secret request created: ${requestId} (${purpose})`, "info");
  return { requestId, magicToken };
}

export async function getSecretRequest(requestId: string): Promise<SecretRequest | null> {
  const config = await storage.getAgentConfig(`secret_request:${requestId}`);
  if (!config) return null;
  try {
    return JSON.parse(config.value) as SecretRequest;
  } catch {
    return null;
  }
}

export async function validateAndSubmitSecrets(
  requestId: string,
  magicToken: string,
  secrets: Record<string, string>
): Promise<{ success: boolean; error?: string }> {
  const request = await getSecretRequest(requestId);
  if (!request) return { success: false, error: "Request not found" };
  if (request.status !== "pending") return { success: false, error: "Request already completed or expired" };

  const now = new Date();
  if (now > new Date(request.expiresAt)) {
    request.status = "expired";
    await storage.setAgentConfig(
      `secret_request:${requestId}`,
      JSON.stringify(request),
      "secrets"
    );
    return { success: false, error: "Request expired" };
  }

  const tokenHash = hashToken(magicToken);
  if (tokenHash !== request.magicTokenHash) {
    return { success: false, error: "Invalid token" };
  }

  for (const field of request.fields) {
    if (field.required && (!secrets[field.name] || secrets[field.name].trim() === "")) {
      return { success: false, error: `Required field missing: ${field.label}` };
    }
  }

  for (const [name, value] of Object.entries(secrets)) {
    if (!value || value.trim() === "") continue;
    const { encrypted, iv, authTag } = encrypt(value);
    await storage.setAgentConfig(
      `secret:${name}`,
      JSON.stringify({ encrypted, iv, authTag, updatedAt: now.toISOString() }),
      "secrets"
    );
  }

  request.status = "completed";
  await storage.setAgentConfig(
    `secret_request:${requestId}`,
    JSON.stringify(request),
    "secrets"
  );

  emitEvent("secrets", `Secrets submitted for request ${requestId} (${Object.keys(secrets).length} fields)`, "info");
  return { success: true };
}

export async function getSecret(name: string): Promise<string | null> {
  const config = await storage.getAgentConfig(`secret:${name}`);
  if (!config) return null;
  try {
    const { encrypted, iv, authTag } = JSON.parse(config.value);
    return decrypt(encrypted, iv, authTag);
  } catch {
    return null;
  }
}

export async function listSecretNames(): Promise<string[]> {
  const configs = await storage.getAgentConfigs();
  return configs
    .filter(c => c.key.startsWith("secret:") && c.category === "secrets")
    .map(c => c.key.replace("secret:", ""));
}

export function renderSecretForm(request: SecretRequest, requestId: string, token: string): string {
  const fieldHtml = request.fields.map(f => {
    const inputType = f.type === "password" ? "password" : "text";
    const required = f.required ? "required" : "";
    const desc = f.description ? `<div style="color:#666;font-size:11px;margin-top:2px">${escapeHtml(f.description)}</div>` : "";
    const ph = f.placeholder ? ` placeholder="${escapeHtml(f.placeholder)}"` : "";
    return `<div style="margin-bottom:16px">
      <label style="display:block;font-weight:bold;margin-bottom:4px;color:#33ff33">${escapeHtml(f.label)}</label>
      ${desc}
      <input type="${inputType}" name="${escapeHtml(f.name)}" ${required}${ph}
        style="width:100%;padding:8px;background:#111;border:1px solid #333;color:#33ff33;font-family:'IBM Plex Mono',monospace;border-radius:4px;margin-top:4px"
        autocomplete="off" />
    </div>`;
  }).join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Rachael -- Credential Collection</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;700&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'IBM Plex Mono', monospace;
      background: #0a0a0a;
      color: #33ff33;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }
    .container {
      max-width: 500px;
      width: 100%;
      background: #111;
      border: 1px solid #333;
      border-radius: 8px;
      padding: 32px;
      box-shadow: 0 0 30px rgba(51, 255, 51, 0.05);
    }
    h1 { font-size: 18px; margin-bottom: 8px; }
    .purpose { color: #999; font-size: 13px; margin-bottom: 24px; border-bottom: 1px solid #222; padding-bottom: 16px; }
    .expire { color: #ff6633; font-size: 11px; margin-bottom: 16px; }
    button {
      background: #33ff33;
      color: #000;
      border: none;
      padding: 10px 24px;
      font-family: 'IBM Plex Mono', monospace;
      font-weight: bold;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      width: 100%;
      margin-top: 8px;
    }
    button:hover { background: #22dd22; }
    .success { color: #33ff33; text-align: center; padding: 40px 0; }
    .error { color: #ff3333; font-size: 12px; margin-top: 8px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>:: RACHAEL ::</h1>
    <div class="purpose">Purpose: ${escapeHtml(request.purpose)}</div>
    <div class="expire">This form expires at ${new Date(request.expiresAt).toLocaleString()}</div>
    <form id="secretForm">
      ${fieldHtml}
      <button type="submit">SUBMIT CREDENTIALS</button>
      <div id="formError" class="error" style="display:none"></div>
    </form>
    <div id="successMsg" class="success" style="display:none">
      Credentials saved securely. You can close this page.
    </div>
  </div>
  <script>
    document.getElementById('secretForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const formData = new FormData(e.target);
      const secrets = {};
      for (const [key, value] of formData.entries()) {
        secrets[key] = value;
      }
      try {
        const res = await fetch('/api/secrets/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            requestId: ${JSON.stringify(requestId)},
            token: ${JSON.stringify(token)},
            secrets
          })
        });
        const data = await res.json();
        if (data.success) {
          document.getElementById('secretForm').style.display = 'none';
          document.getElementById('successMsg').style.display = 'block';
        } else {
          const errEl = document.getElementById('formError');
          errEl.textContent = data.error || 'Submission failed';
          errEl.style.display = 'block';
        }
      } catch (err) {
        const errEl = document.getElementById('formError');
        errEl.textContent = 'Network error: ' + err.message;
        errEl.style.display = 'block';
      }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
