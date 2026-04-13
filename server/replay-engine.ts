import { storage } from "./storage";
import { executeLLM, type LLMMessage } from "./llm-client";

export interface NavRecipe {
  edgeKey: string;
  fromFp: string;
  toFp: string;
  fromTitle: string;
  toTitle: string;
  name: string;
  description: string;
  steps: RecipeStep[];
  tags: string[];
  safetyLevel: "low" | "medium" | "high";
  confidence: number;
  observationCount: number;
  avgTransitionMs: number;
  createdAt: number;
  updatedAt: number;
}

export interface RecipeStep {
  action: string;
  target?: string;
  key?: string;
  description: string;
  waitMs: number;
}

export interface PathSegment {
  fromFp: string;
  toFp: string;
  fromTitle: string;
  toTitle: string;
  recipe: NavRecipe | null;
  edge: any;
}

export interface ReplayPlan {
  fromFp: string;
  toFp: string;
  toTitle: string;
  segments: PathSegment[];
  totalEstimatedMs: number;
  maxSafetyLevel: "low" | "medium" | "high";
  requiresApproval: boolean;
}

const SAFETY_HARD_BLOCK_PATTERNS = [
  /password/i, /passwd/i, /credential/i,
  /delete.*all/i, /drop.*table/i, /truncate/i,
  /submit.*order/i, /place.*order/i, /confirm.*purchase/i,
  /sign.*out/i, /log.*out/i,
];

function recipeConfigKey(fromFp: string, toFp: string): string {
  return `nav_recipe_${fromFp}_${toFp}`;
}

export async function getRecipe(fromFp: string, toFp: string): Promise<NavRecipe | null> {
  const cfg = await storage.getAgentConfig(recipeConfigKey(fromFp, toFp));
  if (!cfg?.value) return null;
  try { return JSON.parse(cfg.value); } catch { return null; }
}

export async function saveRecipe(recipe: NavRecipe): Promise<void> {
  await storage.setAgentConfig(recipeConfigKey(recipe.fromFp, recipe.toFp), JSON.stringify(recipe));
}

export async function synthesizeRecipe(edge: {
  from: string; to: string;
  fromTitle: string; toTitle: string;
  triggerKeys: string[]; labelCrops: string[];
  avgTransitionMs: number; count: number;
}): Promise<NavRecipe | null> {
  const existing = await getRecipe(edge.from, edge.to);
  if (existing) {
    return strengthenRecipe(existing, edge);
  }

  const actionDesc = edge.triggerKeys.length > 0
    ? `Actions: ${edge.triggerKeys.join(", ")}`
    : "Actions: mouse click (no specific keys recorded)";

  const cropDesc = edge.labelCrops.length > 0
    ? `UI labels near click: ${edge.labelCrops.join(", ")}`
    : "";

  const prompt = `You are analyzing a screen navigation transition in a desktop application (Epic Hyperspace / healthcare IT).

Source screen: "${edge.fromTitle || edge.from}"
Destination screen: "${edge.toTitle || edge.to}"
${actionDesc}
${cropDesc}
Average transition time: ${edge.avgTransitionMs}ms
Times observed: ${edge.count}

Generate a navigation recipe for replaying this transition. Reply as JSON only:
{
  "name": "short-kebab-case-name",
  "description": "One sentence describing what this navigation does",
  "steps": [
    {"action": "click|key|hotkey|wait", "target": "element description", "key": "key name if applicable", "description": "what this step does", "waitMs": 500}
  ],
  "tags": ["category tags"],
  "safetyLevel": "low|medium|high"
}

Rules:
- safetyLevel "high" if it involves patient data changes, orders, or destructive actions
- safetyLevel "medium" if it opens forms or editable areas  
- safetyLevel "low" for pure navigation between screens
- Steps should be based on the recorded action_keys and label_crops
- Keep it concise`;

  const messages: LLMMessage[] = [{ role: "user", content: prompt }];

  try {
    const resp = await executeLLM(messages, "deepseek/deepseek-chat", undefined, {}, { maxTokens: 800 });
    const text = resp.content || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return createFallbackRecipe(edge);

    const parsed = JSON.parse(jsonMatch[0]);
    const validSafety = ["low", "medium", "high"];
    const parsedSafety = validSafety.includes(parsed.safetyLevel) ? parsed.safetyLevel : "low";

    const recipe: NavRecipe = {
      edgeKey: `${edge.from}_${edge.to}`,
      fromFp: edge.from,
      toFp: edge.to,
      fromTitle: edge.fromTitle || "",
      toTitle: edge.toTitle || "",
      name: parsed.name || `nav-${edge.from.slice(0, 8)}-to-${edge.to.slice(0, 8)}`,
      description: parsed.description || `Navigate from ${edge.fromTitle} to ${edge.toTitle}`,
      steps: (parsed.steps || []).map((s: any) => ({
        action: ["click", "key", "hotkey", "wait"].includes(s.action) ? s.action : "wait",
        target: s.target || "",
        key: s.key || "",
        description: s.description || "",
        waitMs: Math.min(Math.max(s.waitMs || 500, 100), 10000),
      })),
      tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t: any) => typeof t === "string") : [],
      safetyLevel: parsedSafety as "low" | "medium" | "high",
      confidence: 0.5,
      observationCount: edge.count,
      avgTransitionMs: edge.avgTransitionMs,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await saveRecipe(recipe);
    console.log(`[replay] Synthesized recipe: ${recipe.name} (${edge.fromTitle} -> ${edge.toTitle})`);
    return recipe;
  } catch (e: any) {
    console.error(`[replay] LLM synthesis failed: ${e.message}`);
    return createFallbackRecipe(edge);
  }
}

function createFallbackRecipe(edge: {
  from: string; to: string;
  fromTitle: string; toTitle: string;
  triggerKeys: string[]; avgTransitionMs: number; count: number;
}): NavRecipe {
  const steps: RecipeStep[] = edge.triggerKeys.map(k => ({
    action: k.includes("+") ? "hotkey" : "key",
    key: k,
    description: `Press ${k}`,
    waitMs: 500,
  }));

  if (steps.length === 0) {
    steps.push({ action: "click", target: edge.toTitle, description: `Click to navigate to ${edge.toTitle}`, waitMs: 500 });
  }

  const recipe: NavRecipe = {
    edgeKey: `${edge.from}_${edge.to}`,
    fromFp: edge.from,
    toFp: edge.to,
    fromTitle: edge.fromTitle || "",
    toTitle: edge.toTitle || "",
    name: `nav-${(edge.fromTitle || edge.from).slice(0, 12).replace(/\s+/g, "-").toLowerCase()}-to-${(edge.toTitle || edge.to).slice(0, 12).replace(/\s+/g, "-").toLowerCase()}`,
    description: `Navigate from ${edge.fromTitle || "unknown"} to ${edge.toTitle || "unknown"}`,
    steps,
    tags: ["auto-generated"],
    safetyLevel: "low",
    confidence: 0.3,
    observationCount: edge.count,
    avgTransitionMs: edge.avgTransitionMs,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  storage.setAgentConfig(recipeConfigKey(edge.from, edge.to), JSON.stringify(recipe)).catch(() => {});
  return recipe;
}

async function strengthenRecipe(existing: NavRecipe, edge: {
  from: string; to: string;
  fromTitle: string; toTitle: string;
  triggerKeys: string[]; avgTransitionMs: number; count: number;
}): Promise<NavRecipe> {
  existing.observationCount = edge.count;
  existing.confidence = Math.min(1.0, existing.confidence + 0.1);
  existing.avgTransitionMs = edge.avgTransitionMs;
  existing.updatedAt = Date.now();

  for (const k of edge.triggerKeys) {
    if (!existing.steps.some(s => s.key === k)) {
      existing.tags.push(`also-seen:${k}`);
    }
  }

  await saveRecipe(existing);
  return existing;
}

export function findShortestPath(
  nodes: Record<string, any>,
  edges: any[],
  fromFp: string,
  toFp: string
): { from: string; to: string; edge: any }[] | null {
  if (fromFp === toFp) return [];
  if (!nodes[fromFp] || !nodes[toFp]) return null;

  const adjacency: Record<string, { to: string; edge: any }[]> = {};
  for (const fp of Object.keys(nodes)) {
    adjacency[fp] = [];
  }
  for (const e of edges) {
    if (adjacency[e.from]) {
      adjacency[e.from].push({ to: e.to, edge: e });
    }
  }

  const visited = new Set<string>();
  const parent = new Map<string, { from: string; edge: any }>();
  const queue: string[] = [fromFp];
  visited.add(fromFp);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === toFp) {
      const path: { from: string; to: string; edge: any }[] = [];
      let node = toFp;
      while (parent.has(node)) {
        const p = parent.get(node)!;
        path.unshift({ from: p.from, to: node, edge: p.edge });
        node = p.from;
      }
      return path;
    }

    for (const neighbor of (adjacency[current] || [])) {
      if (!visited.has(neighbor.to)) {
        visited.add(neighbor.to);
        parent.set(neighbor.to, { from: current, edge: neighbor.edge });
        queue.push(neighbor.to);
      }
    }
  }

  return null;
}

export async function buildReplayPlan(
  windowKey: string,
  fromFp: string,
  toFp: string
): Promise<ReplayPlan | null> {
  const treeConfigKey = `session_tree_${windowKey}`;
  const treeCfg = await storage.getAgentConfig(treeConfigKey);
  if (!treeCfg?.value) return null;

  let tree: { nodes: Record<string, any>; edges: any[] };
  try { tree = JSON.parse(treeCfg.value); } catch { return null; }

  const path = findShortestPath(tree.nodes, tree.edges, fromFp, toFp);
  if (!path) return null;

  const segments: PathSegment[] = [];
  let totalMs = 0;
  let maxSafety: "low" | "medium" | "high" = "low";

  for (const hop of path) {
    const recipe = await getRecipe(hop.from, hop.to);
    const fromTitle = hop.edge.fromTitle || tree.nodes[hop.from]?.titles?.[0] || hop.from;
    const toTitle = hop.edge.toTitle || tree.nodes[hop.to]?.titles?.[0] || hop.to;

    segments.push({
      fromFp: hop.from,
      toFp: hop.to,
      fromTitle,
      toTitle,
      recipe,
      edge: hop.edge,
    });

    if (recipe) {
      totalMs += recipe.avgTransitionMs || 1000;
      if (recipe.safetyLevel === "high") maxSafety = "high";
      else if (recipe.safetyLevel === "medium" && maxSafety !== "high") maxSafety = "medium";
    } else {
      totalMs += hop.edge.avgTransitionMs || 2000;
    }
  }

  const toTitle = tree.nodes[toFp]?.titles?.[0] || toFp;

  return {
    fromFp,
    toFp,
    toTitle,
    segments,
    totalEstimatedMs: totalMs,
    maxSafetyLevel: maxSafety,
    requiresApproval: maxSafety === "high" || segments.some(s => checkSafetyBlock(s)),
  };
}

function checkSafetyBlock(segment: PathSegment): boolean {
  const textToCheck = [
    segment.toTitle,
    segment.fromTitle,
    ...(segment.recipe?.steps?.map(s => s.description) || []),
    ...(segment.recipe?.steps?.map(s => s.target || "") || []),
  ].join(" ");

  return SAFETY_HARD_BLOCK_PATTERNS.some(p => p.test(textToCheck));
}

export async function getAllRecipesForWindow(windowKey: string): Promise<Record<string, NavRecipe>> {
  const treeConfigKey = `session_tree_${windowKey}`;
  const treeCfg = await storage.getAgentConfig(treeConfigKey);
  if (!treeCfg?.value) return {};

  let tree: { edges: any[] };
  try { tree = JSON.parse(treeCfg.value); } catch { return {}; }

  const recipes: Record<string, NavRecipe> = {};
  for (const edge of tree.edges) {
    const recipe = await getRecipe(edge.from, edge.to);
    if (recipe) {
      recipes[`${edge.from}_${edge.to}`] = recipe;
    }
  }
  return recipes;
}

export function fuzzyMatchNode(
  nodes: Record<string, any>,
  query: string
): { fingerprint: string; title: string; score: number } | null {
  const q = query.toLowerCase().trim();
  if (!q) return null;

  let best: { fingerprint: string; title: string; score: number } | null = null;

  for (const [fp, node] of Object.entries(nodes)) {
    for (const title of (node.titles || [])) {
      const t = (title as string).toLowerCase();
      let score = 0;

      if (t === q) score = 100;
      else if (t.includes(q)) score = 80;
      else if (q.includes(t)) score = 60;
      else {
        const qWords = q.split(/\s+/);
        const tWords = t.split(/\s+/);
        const matched = qWords.filter(w => tWords.some(tw => tw.includes(w) || w.includes(tw)));
        if (matched.length > 0) {
          score = Math.round((matched.length / qWords.length) * 50);
        }
      }

      if (score > 0 && (!best || score > best.score)) {
        best = { fingerprint: fp, title: title as string, score };
      }
    }
  }

  return best;
}
