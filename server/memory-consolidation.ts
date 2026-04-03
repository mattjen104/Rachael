import { storage } from "./storage";
import {
  checkQdrantHealth,
  generateEmbedding,
  generateBM25Sparse,
  upsertPoint,
  hybridSearch,
  searchBySubject,
  getCollectionName,
  type QdrantSearchResult,
} from "./qdrant-client";
import { consolidationJudge } from "./llm-judges";
import type { LLMConfig } from "./llm-client";
import type { AgentMemory } from "@shared/schema";
import crypto from "crypto";

function generateUUID(): string {
  return crypto.randomUUID();
}

const MEMORY_TYPE_MAP: Record<string, "episodic" | "semantic" | "procedural"> = {
  fact: "semantic",
  observation: "episodic",
  outcome: "episodic",
  episodic: "episodic",
  semantic: "semantic",
  procedural: "procedural",
};

function mapMemoryType(type: string): "episodic" | "semantic" | "procedural" {
  return MEMORY_TYPE_MAP[type] || "episodic";
}

type MemoryType = "fact" | "outcome" | "observation" | "episodic" | "semantic" | "procedural";

export async function storeMemoryWithQdrant(
  content: string,
  memoryType: MemoryType,
  programName: string | null,
  tags: string[],
  relevanceScore: number,
  subject?: string | null,
  sourceKbId?: number | null
): Promise<AgentMemory> {
  let qdrantId: string | null = null;

  if (subject && memoryType === "semantic") {
    await handleContradiction(subject, content, programName);
  }

  const pgMemory = await storage.createMemory({
    programName: programName || undefined,
    content,
    memoryType,
    tags,
    relevanceScore,
    subject: subject || undefined,
    qdrantId: undefined,
    sourceKbId: sourceKbId || undefined,
  });

  if (await checkQdrantHealth()) {
    try {
      const embedding = await generateEmbedding(content);
      if (embedding) {
        const candidateId = generateUUID();
        const sparse = generateBM25Sparse(content);
        const collectionType = mapMemoryType(memoryType);
        const collection = getCollectionName(collectionType);

        const success = await upsertPoint(collection, {
          id: candidateId,
          vector: { dense: embedding, sparse },
          payload: {
            pg_id: pgMemory.id,
            content,
            memory_type: memoryType,
            program_name: programName || "",
            tags,
            relevance_score: relevanceScore,
            subject: subject || "",
            created_at: new Date().toISOString(),
          },
        });

        if (success) {
          qdrantId = candidateId;
          await storage.updateMemoryQdrantId(pgMemory.id, qdrantId);
        }
      }
    } catch (err) {
      console.error("[memory-consolidation] Qdrant store failed, Postgres retained:", err);
    }
  }

  return pgMemory;
}

function computeTokenOverlap(a: string, b: string): number {
  const tokensA = new Set(a.toLowerCase().split(/\s+/).filter(t => t.length > 2));
  const tokensB = new Set(b.toLowerCase().split(/\s+/).filter(t => t.length > 2));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokensA) {
    if (tokensB.has(t)) intersection++;
  }
  const union = new Set([...tokensA, ...tokensB]).size;
  return union > 0 ? intersection / union : 0;
}

const NEGATION_WORDS = ["not", "no", "never", "don't", "doesn't", "isn't", "aren't", "won't", "can't", "shouldn't"];

function detectsContradiction(existingContent: string, newContent: string): boolean {
  const overlap = computeTokenOverlap(existingContent, newContent);
  if (overlap < 0.2) return false;

  const existingLower = existingContent.toLowerCase();
  const newLower = newContent.toLowerCase();

  const existingHasNeg = NEGATION_WORDS.some(w => existingLower.includes(w));
  const newHasNeg = NEGATION_WORDS.some(w => newLower.includes(w));
  if (existingHasNeg !== newHasNeg && overlap > 0.3) return true;

  if (overlap > 0.5 && existingContent.trim() !== newContent.trim()) return true;

  return false;
}

async function handleContradiction(
  subject: string,
  newContent: string,
  programName: string | null
): Promise<void> {
  try {
    const existing = await storage.searchMemoriesBySubject(subject, programName);
    if (existing.length > 0) {
      const now = new Date();
      for (const mem of existing) {
        if (!mem.validUntil && detectsContradiction(mem.content, newContent)) {
          await storage.expireMemory(mem.id, now);
        }
      }
    }
  } catch (err) {
    console.error("[memory-consolidation] Contradiction check failed:", err);
  }
}

export async function searchMemoriesHybrid(
  query: string,
  limit: number = 20,
  programName?: string,
  memoryTypes?: string[]
): Promise<AgentMemory[]> {
  if (await checkQdrantHealth()) {
    try {
      const embedding = await generateEmbedding(query);
      if (embedding) {
        const sparse = generateBM25Sparse(query);
        const filter: Record<string, unknown> = {};
        const must: Array<Record<string, unknown>> = [];

        if (programName) {
          must.push({ key: "program_name", match: { value: programName } });
        }
        if (memoryTypes && memoryTypes.length > 0) {
          must.push({ key: "memory_type", match: { any: memoryTypes } });
        }
        if (must.length > 0) filter.must = must;

        const collections = memoryTypes
          ? [...new Set(memoryTypes.map(t => getCollectionName(mapMemoryType(t))))]
          : [getCollectionName("episodic"), getCollectionName("semantic"), getCollectionName("procedural")];

        const allResults: QdrantSearchResult[] = [];
        for (const collection of collections) {
          const results = await hybridSearch(collection, embedding, sparse, must.length > 0 ? filter : undefined, limit);
          allResults.push(...results);
        }

        allResults.sort((a, b) => b.score - a.score);
        const topResults = allResults.slice(0, limit);

        const pgIds = topResults
          .map(r => r.payload.pg_id as number)
          .filter(id => typeof id === "number");

        if (pgIds.length > 0) {
          const memories = await storage.getMemoriesByIds(pgIds);
          const idOrder = new Map(pgIds.map((id, idx) => [id, idx]));
          memories.sort((a, b) => (idOrder.get(a.id) ?? 999) - (idOrder.get(b.id) ?? 999));
          return memories;
        }
      }
    } catch (err) {
      console.error("[memory-consolidation] Qdrant search failed, falling back to Postgres:", err);
    }
  }

  return storage.searchMemories(query, limit, programName);
}

export async function getMemoryContextHybrid(
  programName?: string,
  tokenBudget: number = 2000
): Promise<{ persistentContext: string; memories: Array<{ id: number; content: string }> }> {
  const APPROX_CHARS_PER_TOKEN = 4;
  const charBudget = tokenBudget * APPROX_CHARS_PER_TOKEN;

  try {
    let allMemories: AgentMemory[];

    if ((await checkQdrantHealth()) && programName) {
      const query = `context for program ${programName}`;
      allMemories = await searchMemoriesHybrid(query, 50, programName);
    } else {
      allMemories = await storage.getMemoriesForProgram(programName || null, {
        limit: 50,
        minRelevance: 5,
      });
    }

    const validMemories = allMemories.filter(m => !m.validUntil || m.validUntil > new Date());

    const prioritized = [
      ...validMemories.filter(m => m.memoryType === "semantic" || m.memoryType === "fact"),
      ...validMemories.filter(m => m.memoryType === "episodic" || m.memoryType === "observation" || m.memoryType === "outcome"),
      ...validMemories.filter(m => m.memoryType === "procedural"),
    ];

    const seen = new Set<number>();
    const deduped = prioritized.filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return true;
    });

    let totalChars = 0;
    const selected: Array<{ id: number; content: string }> = [];
    const lines: string[] = [];

    for (const m of deduped) {
      const line = `[${m.memoryType}] ${m.content}`;
      if (totalChars + line.length > charBudget) break;
      totalChars += line.length;
      lines.push(line);
      selected.push({ id: m.id, content: m.content });
      storage.updateMemoryAccess(m.id).catch(() => {});
    }

    return { persistentContext: lines.join("\n"), memories: selected };
  } catch (err) {
    console.error("[memory-consolidation] Context build failed, falling back:", err);
    const mem = await storage.getAgentConfig("persistent_context");
    return { persistentContext: mem?.value || "", memories: [] };
  }
}

export async function runConsolidation(
  sessionData: string,
  programName: string,
  llmConfig: LLMConfig
): Promise<{ episodes: number; facts: number; procedures: number }> {
  const result = await consolidationJudge(sessionData, llmConfig);

  if (result) {
    for (const episode of result.episodes) {
      await storeMemoryWithQdrant(
        episode,
        "episodic",
        programName,
        [programName, "episode"],
        80
      );
    }

    for (const fact of result.facts) {
      await storeMemoryWithQdrant(
        fact.content,
        "semantic",
        programName,
        [programName, "fact", fact.subject],
        90,
        fact.subject
      );
    }

    for (const procedure of result.procedures) {
      await storeMemoryWithQdrant(
        procedure,
        "procedural",
        programName,
        [programName, "procedure"],
        85
      );
    }

    return {
      episodes: result.episodes.length,
      facts: result.facts.length,
      procedures: result.procedures.length,
    };
  }

  return runHeuristicConsolidation(sessionData, programName);
}

async function runHeuristicConsolidation(
  sessionData: string,
  programName: string
): Promise<{ episodes: number; facts: number; procedures: number }> {
  let episodes = 0, facts = 0, procedures = 0;
  const lines = sessionData.split("\n");

  for (const line of lines) {
    const lower = line.toLowerCase().trim();
    if (!lower || lower.length < 10) continue;

    if (lower.match(/corrected?|fixed|adjusted|changed.*to/)) {
      const match = line.match(/(?:corrected?|fixed|adjusted|changed)\s+(.{10,200})/i);
      if (match) {
        await storeMemoryWithQdrant(
          `Correction: ${match[1].trim()}`,
          "episodic",
          programName,
          [programName, "correction"],
          85
        );
        episodes++;
      }
    }

    if (lower.match(/prefer|always use|never use|likes?|wants?/)) {
      const match = line.match(/(?:prefer|always use|never use|likes?|wants?)\s+(.{10,200})/i);
      if (match) {
        await storeMemoryWithQdrant(
          `Preference: ${match[1].trim()}`,
          "semantic",
          programName,
          [programName, "preference"],
          90,
          "user-preference"
        );
        facts++;
      }
    }

    if (lower.match(/step \d|first.*then|procedure|workflow|always do/)) {
      await storeMemoryWithQdrant(
        `Procedure: ${line.trim().slice(0, 300)}`,
        "procedural",
        programName,
        [programName, "procedure"],
        80
      );
      procedures++;
    }
  }

  return { episodes, facts, procedures };
}

export async function migratePostgresMemoriesToQdrant(): Promise<{
  total: number;
  migrated: number;
  errors: number;
}> {
  const healthy = await checkQdrantHealth();
  if (!healthy) {
    return { total: 0, migrated: 0, errors: 0 };
  }

  const allMemories = await storage.getAllMemories(10000);
  let migrated = 0;
  let errors = 0;

  for (const memory of allMemories) {
    if (memory.qdrantId) continue;

    try {
      const embedding = await generateEmbedding(memory.content);
      if (!embedding) {
        errors++;
        continue;
      }

      const qdrantId = generateUUID();
      const sparse = generateBM25Sparse(memory.content);
      const collectionType = mapMemoryType(memory.memoryType);
      const collection = getCollectionName(collectionType);

      const success = await upsertPoint(collection, {
        id: qdrantId,
        vector: { dense: embedding, sparse },
        payload: {
          pg_id: memory.id,
          content: memory.content,
          memory_type: memory.memoryType,
          program_name: memory.programName || "",
          tags: memory.tags,
          relevance_score: memory.relevanceScore,
          subject: memory.subject || "",
          created_at: memory.createdAt.toISOString(),
        },
      });

      if (success) {
        await storage.updateMemoryQdrantId(memory.id, qdrantId);
        migrated++;
      } else {
        errors++;
      }
    } catch (err) {
      errors++;
      console.error(`[migration] Failed to migrate memory ${memory.id}:`, err);
    }
  }

  return { total: allMemories.length, migrated, errors };
}
