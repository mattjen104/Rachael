const QDRANT_URL = process.env.QDRANT_URL || "http://localhost:6333";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "nomic-embed-text";
const QDRANT_TIMEOUT_MS = parseInt(process.env.QDRANT_TIMEOUT_MS || "5000", 10);
const EMBEDDING_DIMENSIONS = 768;

export type MemoryCollectionType = "episodic" | "semantic" | "procedural";

export interface QdrantPoint {
  id: string;
  vector: {
    dense: number[];
    sparse?: { indices: number[]; values: number[] };
  };
  payload: Record<string, unknown>;
}

export interface QdrantSearchResult {
  id: string;
  score: number;
  payload: Record<string, unknown>;
}

let qdrantHealthy = false;
let lastHealthCheck = 0;
const HEALTH_CHECK_INTERVAL_MS = 60_000;

function fnv1aHash(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash;
}

export function generateBM25Sparse(text: string, vocabSize = 30000): { indices: number[]; values: number[] } {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 1);
  const tf = new Map<number, number>();
  for (const word of words) {
    const idx = fnv1aHash(word) % vocabSize;
    tf.set(idx, (tf.get(idx) || 0) + 1);
  }
  const indices: number[] = [];
  const values: number[] = [];
  const docLen = words.length || 1;
  for (const [idx, count] of tf.entries()) {
    indices.push(idx);
    values.push(count / docLen);
  }
  return { indices, values };
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = QDRANT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } finally {
    clearTimeout(timer);
  }
}

export async function checkQdrantHealth(): Promise<boolean> {
  const now = Date.now();
  if (now - lastHealthCheck < HEALTH_CHECK_INTERVAL_MS) return qdrantHealthy;
  lastHealthCheck = now;
  try {
    const resp = await fetchWithTimeout(`${QDRANT_URL}/healthz`);
    qdrantHealthy = resp.ok;
  } catch {
    qdrantHealthy = false;
  }
  return qdrantHealthy;
}

export function isQdrantAvailable(): boolean {
  return qdrantHealthy;
}

export async function ensureCollection(name: string): Promise<boolean> {
  try {
    const checkResp = await fetchWithTimeout(`${QDRANT_URL}/collections/${name}`);
    if (checkResp.ok) return true;

    const createResp = await fetchWithTimeout(`${QDRANT_URL}/collections/${name}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vectors: {
          dense: { size: EMBEDDING_DIMENSIONS, distance: "Cosine" },
        },
        sparse_vectors: {
          sparse: {},
        },
      }),
    });
    if (!createResp.ok) {
      console.error(`[qdrant] Failed to create collection ${name}:`, await createResp.text());
      return false;
    }

    await fetchWithTimeout(`${QDRANT_URL}/collections/${name}/index`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field_name: "memory_type", field_schema: "keyword" }),
    });
    await fetchWithTimeout(`${QDRANT_URL}/collections/${name}/index`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field_name: "program_name", field_schema: "keyword" }),
    });
    await fetchWithTimeout(`${QDRANT_URL}/collections/${name}/index`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ field_name: "subject", field_schema: "keyword" }),
    });

    return true;
  } catch (err) {
    console.error(`[qdrant] Error ensuring collection ${name}:`, err);
    return false;
  }
}

export async function generateEmbedding(text: string): Promise<number[] | null> {
  try {
    const resp = await fetchWithTimeout(`${OLLAMA_URL}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBEDDING_MODEL, prompt: text }),
    }, 10000);
    if (!resp.ok) return null;
    const data = await resp.json() as { embedding?: number[] };
    return data.embedding || null;
  } catch {
    return null;
  }
}

export async function upsertPoint(collection: string, point: QdrantPoint): Promise<boolean> {
  try {
    interface PointBody {
      id: string;
      vector: { dense: number[]; sparse?: { indices: number[]; values: number[] } };
      payload: Record<string, unknown>;
    }
    const pointBody: PointBody = {
      id: point.id,
      vector: { dense: point.vector.dense },
      payload: point.payload,
    };

    if (point.vector.sparse) {
      pointBody.vector.sparse = point.vector.sparse;
    }

    const body = { points: [pointBody] };

    const resp = await fetchWithTimeout(`${QDRANT_URL}/collections/${collection}/points`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function hybridSearch(
  collection: string,
  denseVector: number[],
  sparseVector: { indices: number[]; values: number[] },
  filter?: Record<string, unknown>,
  limit = 20,
  rrfK = 60
): Promise<QdrantSearchResult[]> {
  try {
    const denseResp = await fetchWithTimeout(`${QDRANT_URL}/collections/${collection}/points/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vector: { name: "dense", vector: denseVector },
        filter: filter || undefined,
        limit: limit * 2,
        with_payload: true,
      }),
    });

    let denseResults: QdrantSearchResult[] = [];
    if (denseResp.ok) {
      const data = await denseResp.json() as { result?: Array<{ id: string; score: number; payload: Record<string, unknown> }> };
      denseResults = (data.result || []).map(r => ({ id: String(r.id), score: r.score, payload: r.payload }));
    }

    let sparseResults: QdrantSearchResult[] = [];
    try {
      const sparseResp = await fetchWithTimeout(`${QDRANT_URL}/collections/${collection}/points/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vector: { name: "sparse", vector: sparseVector },
          filter: filter || undefined,
          limit: limit * 2,
          with_payload: true,
        }),
      });
      if (sparseResp.ok) {
        const data = await sparseResp.json() as { result?: Array<{ id: string; score: number; payload: Record<string, unknown> }> };
        sparseResults = (data.result || []).map(r => ({ id: String(r.id), score: r.score, payload: r.payload }));
      }
    } catch {}

    if (sparseResults.length === 0) return denseResults.slice(0, limit);

    const rrfScores = new Map<string, { score: number; result: QdrantSearchResult }>();
    denseResults.forEach((r, idx) => {
      const rrfScore = 1 / (rrfK + idx + 1);
      rrfScores.set(r.id, { score: rrfScore, result: r });
    });
    sparseResults.forEach((r, idx) => {
      const rrfScore = 1 / (rrfK + idx + 1);
      const existing = rrfScores.get(r.id);
      if (existing) {
        existing.score += rrfScore;
      } else {
        rrfScores.set(r.id, { score: rrfScore, result: r });
      }
    });

    return Array.from(rrfScores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(entry => ({ ...entry.result, score: entry.score }));
  } catch (err) {
    console.error("[qdrant] Hybrid search error:", err);
    return [];
  }
}

export async function deletePoint(collection: string, pointId: string): Promise<boolean> {
  try {
    const resp = await fetchWithTimeout(`${QDRANT_URL}/collections/${collection}/points/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ points: [pointId] }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export async function searchBySubject(collection: string, subject: string): Promise<QdrantSearchResult[]> {
  try {
    const resp = await fetchWithTimeout(`${QDRANT_URL}/collections/${collection}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filter: {
          must: [{ key: "subject", match: { value: subject } }],
        },
        limit: 50,
        with_payload: true,
        with_vector: false,
      }),
    });
    if (!resp.ok) return [];
    const data = await resp.json() as { result?: { points?: Array<{ id: string; payload: Record<string, unknown> }> } };
    return (data.result?.points || []).map(p => ({ id: String(p.id), score: 1, payload: p.payload }));
  } catch {
    return [];
  }
}

export function getCollectionName(type: MemoryCollectionType): string {
  return `rachael_memory_${type}`;
}

export async function initQdrant(): Promise<boolean> {
  const healthy = await checkQdrantHealth();
  if (!healthy) {
    console.log("[qdrant] Qdrant not available, will use Postgres fallback");
    return false;
  }

  const collections: MemoryCollectionType[] = ["episodic", "semantic", "procedural"];
  let allOk = true;
  for (const type of collections) {
    const ok = await ensureCollection(getCollectionName(type));
    if (!ok) allOk = false;
  }

  console.log(`[qdrant] Initialized: ${allOk ? "all collections ready" : "some collections failed"}`);
  return allOk;
}
