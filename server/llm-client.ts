import { compileOpenClaw } from "./openclaw-compiler";

export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  tokensUsed?: number;
}

interface ModelConfig {
  provider: "anthropic" | "openai";
  modelId: string;
}

function resolveModel(
  modelRef: string | undefined,
  config: ReturnType<typeof compileOpenClaw>["config"],
  routing: Record<string, string | undefined>
): ModelConfig {
  const aliases: Record<string, string> = (config as any)?.model_aliases || {};
  const defaultModel = (config as any)?.agents?.DEFAULT_MODEL || routing?.default || "anthropic/claude-sonnet-4-6";

  let fullId = modelRef || defaultModel;

  if (aliases[fullId.toUpperCase()]) {
    fullId = aliases[fullId.toUpperCase()];
  }

  const parts = fullId.split("/");
  let provider: "anthropic" | "openai" = "anthropic";
  let modelId = fullId;

  if (parts.length >= 2) {
    const providerName = parts[0].toLowerCase();
    if (providerName === "openai") provider = "openai";
    else if (providerName === "anthropic") provider = "anthropic";
    else if (providerName === "google") provider = "openai";
    modelId = parts.slice(1).join("/");
  }

  return { provider, modelId };
}

async function callAnthropic(messages: LLMMessage[], modelId: string, signal?: AbortSignal): Promise<LLMResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const systemMsg = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
  const chatMessages = messages.filter(m => m.role !== "system").map(m => ({
    role: m.role as "user" | "assistant",
    content: m.content,
  }));

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 4096,
      system: systemMsg || undefined,
      messages: chatMessages.length > 0 ? chatMessages : [{ role: "user", content: "Execute the program as instructed." }],
    }),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${errText}`);
  }

  const data = await res.json() as any;
  const content = data.content?.map((b: any) => b.text || "").join("") || "";
  return {
    content,
    model: modelId,
    tokensUsed: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
  };
}

async function callOpenAI(messages: LLMMessage[], modelId: string, signal?: AbortSignal): Promise<LLMResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 4096,
      messages: messages.map(m => ({ role: m.role, content: m.content })),
    }),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenAI API error ${res.status}: ${errText}`);
  }

  const data = await res.json() as any;
  const content = data.choices?.[0]?.message?.content || "";
  return {
    content,
    model: modelId,
    tokensUsed: data.usage?.total_tokens,
  };
}

export async function executeLLM(
  messages: LLMMessage[],
  modelRef: string | undefined,
  compiledConfig: ReturnType<typeof compileOpenClaw>["config"],
  routing: Record<string, string | undefined>
): Promise<LLMResponse> {
  const { provider, modelId } = resolveModel(modelRef, compiledConfig, routing);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  try {
    if (provider === "anthropic") {
      return await callAnthropic(messages, modelId, controller.signal);
    } else {
      return await callOpenAI(messages, modelId, controller.signal);
    }
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw new Error("LLM request timed out after 120 seconds");
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export function buildProgramPrompt(
  soul: string,
  skillBodies: string[],
  programInstructions: string,
  iteration: number,
  lastResults: string
): LLMMessage[] {
  const messages: LLMMessage[] = [];

  let systemContent = soul;
  if (skillBodies.length > 0) {
    systemContent += "\n\n---\n\n## Relevant Skills\n\n" + skillBodies.join("\n\n---\n\n");
  }

  systemContent += `\n\n---\n\nYou are executing an autonomous program. Follow the instructions precisely. If your work produces reusable code that could run without AI, include it in a \`\`\`typescript code block with a \`// HARDENABLE\` comment on the first line. If you want to propose a change to your own configuration, prefix the suggestion with \`PROPOSE:\` on its own line.`;

  messages.push({ role: "system", content: systemContent });

  let userContent = programInstructions;
  userContent += `\n\nThis is iteration ${iteration}.`;
  if (lastResults && lastResults.trim()) {
    userContent += `\n\nPrevious results:\n${lastResults}`;
  }
  userContent += `\n\nProvide a concise summary of what you did and any metrics. Format your summary as a single line suitable for a table row.`;

  messages.push({ role: "user", content: userContent });

  return messages;
}

export function hasLLMKeys(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY);
}
