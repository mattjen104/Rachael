import { executeLLM, hasLLMKeys, type LLMConfig } from "./llm-client";
import { storage } from "./storage";

const DAILY_COST_CAP = parseFloat(process.env.JUDGE_DAILY_COST_CAP || "5.0");
const SONNET_MODEL = "anthropic/claude-3.5-sonnet";
const HAIKU_MODEL = "anthropic/claude-3-haiku-20240307";

interface JudgeResult {
  content: string;
  model: string;
  tokensUsed: number;
  cost: number;
}

async function getDailyCost(): Promise<number> {
  const today = new Date().toISOString().split("T")[0];
  const costs = await storage.getJudgeCostsForDate(today);
  return costs.reduce((sum, c) => sum + parseFloat(c.estimatedCost), 0);
}

async function trackCost(judgeType: string, model: string, tokensUsed: number): Promise<void> {
  const costPer1M = model.includes("sonnet") ? 15.0 : model.includes("haiku") ? 1.25 : 5.0;
  const estimatedCost = (tokensUsed / 1_000_000) * costPer1M;
  const today = new Date().toISOString().split("T")[0];
  await storage.createJudgeCost({
    judgeType,
    model,
    tokensUsed,
    estimatedCost: estimatedCost.toFixed(6),
    date: today,
  });
}

async function isCostCapped(): Promise<boolean> {
  const dailyCost = await getDailyCost();
  return dailyCost >= DAILY_COST_CAP;
}

function parseJudgeVerdict(content: string): "PASS" | "FAIL" {
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim().toUpperCase();
    if (/^VERDICT:\s*PASS\b/.test(trimmed) || /^RESULT:\s*PASS\b/.test(trimmed) || trimmed === "PASS") return "PASS";
    if (/^VERDICT:\s*FAIL\b/.test(trimmed) || /^RESULT:\s*FAIL\b/.test(trimmed) || trimmed === "FAIL") return "FAIL";
  }
  const upper = content.toUpperCase();
  const passIdx = upper.lastIndexOf("PASS");
  const failIdx = upper.lastIndexOf("FAIL");
  if (failIdx > passIdx) return "FAIL";
  if (passIdx >= 0) {
    const before = content.slice(Math.max(0, passIdx - 4), passIdx).toLowerCase();
    if (before.includes("not ") || before.includes("no ") || before.includes("don't")) return "FAIL";
    return "PASS";
  }
  return "FAIL";
}

async function callJudge(
  systemPrompt: string,
  userPrompt: string,
  model: string,
  judgeType: string,
  llmConfig: LLMConfig
): Promise<JudgeResult | null> {
  if (!hasLLMKeys()) return null;
  if (await isCostCapped()) return null;

  try {
    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userPrompt },
    ];
    const result = await executeLLM(messages, model, llmConfig, {});
    const tokensUsed = result.tokensUsed || 0;
    await trackCost(judgeType, model, tokensUsed);
    const costPer1M = model.includes("sonnet") ? 15.0 : model.includes("haiku") ? 1.25 : 5.0;
    return {
      content: result.content,
      model: result.model,
      tokensUsed,
      cost: (tokensUsed / 1_000_000) * costPer1M,
    };
  } catch (err) {
    console.error(`[llm-judges] ${judgeType} judge failed:`, err);
    return null;
  }
}

export async function tripleSonnetWithMinorityVeto(
  systemPrompt: string,
  userPrompt: string,
  judgeType: string,
  llmConfig: LLMConfig
): Promise<{ passed: boolean; reason: string; votes: string[] }> {
  if (await isCostCapped()) {
    return { passed: false, reason: "Cost cap reached, failing closed", votes: [] };
  }

  const results = await Promise.allSettled([
    callJudge(systemPrompt, userPrompt, SONNET_MODEL, judgeType, llmConfig),
    callJudge(systemPrompt, userPrompt, SONNET_MODEL, judgeType, llmConfig),
    callJudge(systemPrompt, userPrompt, SONNET_MODEL, judgeType, llmConfig),
  ]);

  const votes: string[] = [];
  let passCount = 0;
  let failCount = 0;

  for (const r of results) {
    if (r.status === "rejected" || !r.value) {
      failCount++;
      votes.push("ERROR");
      continue;
    }
    const verdict = parseJudgeVerdict(r.value.content);
    if (verdict === "PASS") {
      passCount++;
      votes.push("PASS");
    } else {
      failCount++;
      votes.push("FAIL");
    }
  }

  if (failCount > 0) {
    return {
      passed: false,
      reason: `Minority veto: ${failCount} of 3 judges rejected (fail-closed). Votes: ${votes.join(", ")}`,
      votes,
    };
  }

  return {
    passed: passCount === 3,
    reason: passCount === 3 ? "All 3 judges approved" : "Insufficient approvals (fail-closed)",
    votes,
  };
}

export async function cascadedHaikuSonnet(
  systemPrompt: string,
  userPrompt: string,
  judgeType: string,
  llmConfig: LLMConfig
): Promise<{ passed: boolean; reason: string }> {
  const haikuResult = await callJudge(systemPrompt, userPrompt, HAIKU_MODEL, judgeType, llmConfig);
  if (!haikuResult) {
    return { passed: true, reason: "Haiku judge unavailable, passing with heuristic fallback" };
  }

  const haikuVerdict = parseJudgeVerdict(haikuResult.content);

  if (haikuVerdict === "PASS") {
    return { passed: true, reason: `Haiku approved: ${haikuResult.content.slice(0, 200)}` };
  }

  const sonnetResult = await callJudge(systemPrompt, userPrompt, SONNET_MODEL, judgeType, llmConfig);
  if (!sonnetResult) {
    return { passed: false, reason: "Haiku rejected, Sonnet unavailable — judge error, heuristic fallback needed" };
  }

  const sonnetPass = parseJudgeVerdict(sonnetResult.content) === "PASS";

  return {
    passed: sonnetPass,
    reason: sonnetPass
      ? `Sonnet overrode Haiku rejection: ${sonnetResult.content.slice(0, 200)}`
      : `Both Haiku and Sonnet rejected: ${sonnetResult.content.slice(0, 200)}`,
  };
}

export async function extractObservations(
  output: string,
  programName: string,
  llmConfig: LLMConfig
): Promise<string[]> {
  const judgeResult = await callJudge(
    "You are an observation extraction judge. Extract actionable observations from agent program output. Return each observation on its own line, prefixed with '- '. Focus on: patterns noticed, errors encountered, successful strategies, user preferences detected, and domain knowledge gained. Be concise.",
    `Program: ${programName}\n\nOutput:\n${output.slice(0, 4000)}`,
    HAIKU_MODEL,
    "observation-extraction",
    llmConfig
  );

  if (judgeResult) {
    return judgeResult.content
      .split("\n")
      .filter(line => line.trim().startsWith("- ") || line.trim().startsWith("* "))
      .map(line => line.replace(/^[\s*-]+/, "").trim())
      .filter(Boolean);
  }

  return extractObservationsHeuristic(output);
}

function extractObservationsHeuristic(output: string): string[] {
  const observations: string[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    const lower = line.toLowerCase();
    if (lower.includes("error:") || lower.includes("failed:")) {
      observations.push(`Error detected: ${line.trim().slice(0, 200)}`);
    }
    if (lower.includes("found") || lower.includes("discovered") || lower.includes("detected")) {
      observations.push(`Finding: ${line.trim().slice(0, 200)}`);
    }
    if (lower.includes("prefer") || lower.includes("should") || lower.includes("recommend")) {
      observations.push(`Recommendation: ${line.trim().slice(0, 200)}`);
    }
    if (lower.includes("pattern") || lower.includes("trend") || lower.includes("correlation")) {
      observations.push(`Pattern: ${line.trim().slice(0, 200)}`);
    }
  }

  const correctionPatterns = output.match(/(?:correction|fix|adjust|update|change)[\s:]+(.{10,150})/gi);
  if (correctionPatterns) {
    for (const match of correctionPatterns.slice(0, 5)) {
      observations.push(`Correction: ${match.trim()}`);
    }
  }

  return observations.slice(0, 10);
}

export async function assessQuality(
  input: string,
  output: string,
  llmConfig: LLMConfig
): Promise<{ score: number; feedback: string } | null> {
  const judgeResult = await callJudge(
    "You are a quality assessment judge. Rate the quality of the agent's output on a scale of 1-10 and provide brief feedback. Format: SCORE: N\\nFEEDBACK: ...",
    `Input/Task:\n${input.slice(0, 1000)}\n\nOutput:\n${output.slice(0, 2000)}`,
    HAIKU_MODEL,
    "quality-assessment",
    llmConfig
  );

  if (!judgeResult) return null;

  const scoreMatch = judgeResult.content.match(/SCORE:\s*(\d+)/i);
  const feedbackMatch = judgeResult.content.match(/FEEDBACK:\s*([\s\S]*)/i);

  return {
    score: scoreMatch ? Math.min(10, Math.max(1, parseInt(scoreMatch[1], 10))) : 5,
    feedback: feedbackMatch ? feedbackMatch[1].trim().slice(0, 500) : judgeResult.content.slice(0, 500),
  };
}

export async function consolidationJudge(
  sessionData: string,
  llmConfig: LLMConfig
): Promise<{
  episodes: string[];
  facts: Array<{ subject: string; content: string }>;
  procedures: string[];
} | null> {
  const judgeResult = await callJudge(
    `You are a memory consolidation judge. Analyze the session data and extract:
1. EPISODES: Notable events that occurred (prefix each with "EPISODE: ")
2. FACTS: Durable facts learned, each with a subject (format: "FACT [subject]: content")
3. PROCEDURES: Reusable procedures or strategies identified (prefix each with "PROCEDURE: ")

Be selective — only extract genuinely useful information worth remembering across sessions.`,
    sessionData.slice(0, 6000),
    HAIKU_MODEL,
    "consolidation",
    llmConfig
  );

  if (!judgeResult) return null;

  const episodes: string[] = [];
  const facts: Array<{ subject: string; content: string }> = [];
  const procedures: string[] = [];

  for (const line of judgeResult.content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("EPISODE:")) {
      episodes.push(trimmed.replace("EPISODE:", "").trim());
    } else if (trimmed.startsWith("FACT")) {
      const factMatch = trimmed.match(/FACT\s*\[([^\]]+)\]:\s*(.*)/);
      if (factMatch) {
        facts.push({ subject: factMatch[1].trim(), content: factMatch[2].trim() });
      }
    } else if (trimmed.startsWith("PROCEDURE:")) {
      procedures.push(trimmed.replace("PROCEDURE:", "").trim());
    }
  }

  return { episodes, facts, procedures };
}

export async function getJudgeCostSummary(): Promise<{
  today: number;
  cap: number;
  remaining: number;
  breakdown: Record<string, number>;
}> {
  const today = new Date().toISOString().split("T")[0];
  const costs = await storage.getJudgeCostsForDate(today);
  const totalCost = costs.reduce((sum, c) => sum + parseFloat(c.estimatedCost), 0);
  const breakdown: Record<string, number> = {};
  for (const c of costs) {
    breakdown[c.judgeType] = (breakdown[c.judgeType] || 0) + parseFloat(c.estimatedCost);
  }
  return {
    today: totalCost,
    cap: DAILY_COST_CAP,
    remaining: Math.max(0, DAILY_COST_CAP - totalCost),
    breakdown,
  };
}
