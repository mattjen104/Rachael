export interface LLMMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  tokensUsed?: number;
  provider?: string;
  cost?: number;
}

export type ProviderType = "anthropic" | "openai" | "openrouter";

interface ModelConfig {
  provider: ProviderType;
  modelId: string;
}

export interface LLMConfig {
  defaultModel?: string;
  aliases?: Record<string, string>;
  routing?: Record<string, string | undefined>;
}

function resolveModel(
  modelRef: string | undefined,
  config: LLMConfig | undefined,
  routing: Record<string, string | undefined>
): ModelConfig {
  const aliases: Record<string, string> = config?.aliases || {};
  const defaultModel = config?.defaultModel || routing?.default || "openrouter/meta-llama/llama-3.1-8b-instruct:free";

  let fullId = modelRef || defaultModel;

  if (aliases[fullId.toUpperCase()]) {
    fullId = aliases[fullId.toUpperCase()];
  }

  const parts = fullId.split("/");
  let provider: ProviderType = "openrouter";
  let modelId = fullId;

  if (parts.length >= 2) {
    const providerName = parts[0].toLowerCase();
    if (providerName === "openai") {
      provider = "openai";
      modelId = parts.slice(1).join("/");
    } else if (providerName === "anthropic") {
      provider = "anthropic";
      modelId = parts.slice(1).join("/");
    } else if (providerName === "openrouter") {
      provider = "openrouter";
      modelId = parts.slice(1).join("/");
    } else {
      provider = "openrouter";
      modelId = fullId;
    }
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
    provider: "anthropic",
    tokensUsed: (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0),
  };
}

async function callOpenAICompat(
  messages: LLMMessage[],
  modelId: string,
  baseUrl: string,
  apiKey: string,
  providerName: ProviderType,
  extraHeaders: Record<string, string> = {},
  signal?: AbortSignal
): Promise<LLMResponse> {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      ...extraHeaders,
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: 4096,
      messages: (() => {
        const mapped = messages.map(m => ({ role: m.role, content: m.content }));
        if (providerName === "openrouter" && modelId.startsWith("google/")) {
          const systemMsgs = mapped.filter(m => m.role === "system");
          const otherMsgs = mapped.filter(m => m.role !== "system");
          if (systemMsgs.length > 0 && otherMsgs.length > 0) {
            const systemText = systemMsgs.map(m => m.content).join("\n\n");
            otherMsgs[0].content = systemText + "\n\n---\n\n" + otherMsgs[0].content;
          }
          return otherMsgs;
        }
        return mapped;
      })(),
    }),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`${providerName} API error ${res.status}: ${errText}`);
  }

  const data = await res.json() as any;
  const content = data.choices?.[0]?.message?.content || "";
  return {
    content,
    model: data.model || modelId,
    provider: providerName,
    tokensUsed: data.usage?.total_tokens,
    cost: data.usage?.cost,
  };
}

export async function executeLLM(
  messages: LLMMessage[],
  modelRef: string | undefined,
  compiledConfig: LLMConfig | undefined,
  routing: Record<string, string | undefined>
): Promise<LLMResponse> {
  const { provider, modelId } = resolveModel(modelRef, compiledConfig, routing);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);

  try {
    if (provider === "anthropic") {
      return await callAnthropic(messages, modelId, controller.signal);
    } else if (provider === "openrouter") {
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");
      return await callOpenAICompat(
        messages,
        modelId,
        "https://openrouter.ai/api/v1",
        apiKey,
        "openrouter",
        {
          "HTTP-Referer": process.env.REPLIT_DOMAINS
            ? `https://${process.env.REPLIT_DOMAINS.split(",")[0]}`
            : "https://orgcloud.replit.app",
          "X-Title": "OrgCloud Space",
        },
        controller.signal
      );
    } else {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) throw new Error("OPENAI_API_KEY not set");
      return await callOpenAICompat(
        messages,
        modelId,
        "https://api.openai.com/v1",
        apiKey,
        "openai",
        {},
        controller.signal
      );
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

export interface MemoryContext {
  userProfile: string;
  persistentContext: string;
  sessionLog: string;
}

export function buildProgramPrompt(
  soul: string,
  skillBodies: string[],
  programInstructions: string,
  iteration: number,
  lastResults: string,
  memory?: MemoryContext
): LLMMessage[] {
  const messages: LLMMessage[] = [];

  let systemContent = soul;

  if (memory) {
    if (memory.userProfile) {
      systemContent += "\n\n---\n\n## User Profile\n\n" + memory.userProfile;
    }
    if (memory.persistentContext) {
      systemContent += "\n\n---\n\n## Persistent Context\n\nFacts you've learned:\n" + memory.persistentContext;
    }
  }

  if (skillBodies.length > 0) {
    systemContent += "\n\n---\n\n## Relevant Skills\n\n" + skillBodies.join("\n\n---\n\n");
  }

  systemContent += `\n\n---\n\nYou are executing an autonomous program. Follow the instructions precisely. If your work produces reusable code that could run without AI, include it in a \`\`\`typescript code block with a \`// HARDENABLE\` comment on the first line. If you want to propose a change to your own configuration, prefix the suggestion with \`PROPOSE:\` on its own line. If you learn a durable fact worth remembering across sessions, prefix it with \`REMEMBER:\` on its own line.`;

  messages.push({ role: "system", content: systemContent });

  let userContent = programInstructions;
  userContent += `\n\nThis is iteration ${iteration}.`;

  if (memory?.sessionLog) {
    const logEntries = memory.sessionLog.split("\n").filter(l => l.trim());
    const recentEntries = logEntries.slice(0, 5);
    if (recentEntries.length > 0) {
      userContent += `\n\nRecent session history:\n${recentEntries.join("\n")}`;
    }
  }

  if (lastResults && lastResults.trim()) {
    userContent += `\n\nPrevious results:\n${lastResults}`;
  }
  userContent += `\n\nProvide a concise summary of what you did and any metrics. Format your summary as a single line suitable for a table row.`;

  messages.push({ role: "user", content: userContent });

  return messages;
}

export function hasLLMKeys(): boolean {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY);
}
