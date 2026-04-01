import { emitEvent } from "./event-bus";

export interface LocalComputeRequest {
  prompt: string;
  programName: string;
  iteration: number;
  capabilities?: string[];
  timeout?: number;
}

export interface LocalComputeResponse {
  content: string;
  status: "success" | "error" | "timeout";
  executionTime?: number;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 300_000;

function isSelfHosted(): boolean {
  return process.env.RACHAEL_SELF_HOSTED === "true" || process.env.RACHAEL_SELF_HOSTED === "1";
}

export function isLocalComputeAvailable(): boolean {
  return isSelfHosted();
}

export async function executeLocalShell(command: string, opts?: { timeout?: number; cwd?: string }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { execFile } = await import("child_process");
  const { promisify } = await import("util");
  const execFileAsync = promisify(execFile);

  const timeoutMs = opts?.timeout || DEFAULT_TIMEOUT_MS;
  const cwd = opts?.cwd || process.cwd();

  const start = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(
      "/bin/bash", ["-c", command],
      {
        timeout: timeoutMs,
        maxBuffer: 5 * 1024 * 1024,
        cwd,
        env: { ...process.env },
      }
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (err: any) {
    if (err.killed) {
      return { stdout: err.stdout || "", stderr: `Command timed out after ${timeoutMs}ms`, exitCode: 124 };
    }
    return {
      stdout: err.stdout || "",
      stderr: err.stderr || err.message || String(err),
      exitCode: err.code ?? 1,
    };
  }
}

export async function executeLocalComputeTask(request: LocalComputeRequest): Promise<LocalComputeResponse> {
  const timeoutMs = request.timeout || DEFAULT_TIMEOUT_MS;
  const start = Date.now();

  emitEvent("local-compute", `Executing local compute for "${request.programName}" (iteration ${request.iteration})`, "action", { program: request.programName });

  const shellMatch = request.prompt.match(/```(?:bash|sh|shell)\n([\s\S]*?)```/);
  if (!shellMatch) {
    return {
      content: "",
      status: "error",
      executionTime: Date.now() - start,
      error: "No shell code block found in prompt — local compute requires ```bash blocks",
    };
  }

  const script = shellMatch[1].trim();
  try {
    const result = await executeLocalShell(script, { timeout: timeoutMs });
    const executionTime = Date.now() - start;

    const output = [
      result.stdout ? `STDOUT:\n${result.stdout}` : "",
      result.stderr ? `STDERR:\n${result.stderr}` : "",
      `Exit code: ${result.exitCode}`,
    ].filter(Boolean).join("\n\n");

    emitEvent("local-compute", `Local compute completed for "${request.programName}" in ${executionTime}ms (exit ${result.exitCode})`, "info", { program: request.programName });

    return {
      content: output,
      status: result.exitCode === 0 ? "success" : "error",
      executionTime,
      error: result.exitCode !== 0 ? `Command exited with code ${result.exitCode}` : undefined,
    };
  } catch (err: any) {
    const executionTime = Date.now() - start;
    emitEvent("local-compute", `Local compute failed for "${request.programName}": ${err.message}`, "error", { program: request.programName });
    return {
      content: "",
      status: "error",
      executionTime,
      error: err.message || String(err),
    };
  }
}
