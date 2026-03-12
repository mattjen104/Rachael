export function levenshtein(a: string, b: string): number {
  const la = a.length, lb = b.length;
  if (la === 0) return lb;
  if (lb === 0) return la;
  const dp: number[][] = Array.from({ length: la + 1 }, (_, i) =>
    Array.from({ length: lb + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[la][lb];
}

function buildTrigrams(s: string): Set<string> {
  const t = new Set<string>();
  for (let i = 0; i <= s.length - 3; i++) t.add(s.slice(i, i + 3));
  return t;
}

export function fuzzyMatch(text: string, target: string, maxDist = 2): FuzzyHit[] {
  const lower = text.toLowerCase();
  const tLower = target.toLowerCase();
  const tLen = tLower.length;

  const targetTrigrams = buildTrigrams(tLower);
  const minTrigramOverlap = Math.max(1, targetTrigrams.size - maxDist * 2);

  const hits: FuzzyHit[] = [];
  const minWin = Math.max(1, tLen - maxDist);
  const maxWin = tLen + maxDist;

  for (let i = 0; i <= lower.length - minWin; i++) {
    const peek = lower.slice(i, Math.min(lower.length, i + maxWin));
    const peekTrigrams = buildTrigrams(peek);
    let overlap = 0;
    for (const t of targetTrigrams) { if (peekTrigrams.has(t)) overlap++; }
    if (overlap < minTrigramOverlap) continue;

    for (let windowLen = minWin; windowLen <= maxWin && i + windowLen <= lower.length; windowLen++) {
      const candidate = lower.slice(i, i + windowLen);
      const dist = levenshtein(candidate, tLower);
      if (dist <= maxDist) {
        const original = text.slice(i, i + windowLen);
        if (!hits.some(h => h.start === i && h.end === i + windowLen)) {
          hits.push({ matched: original, start: i, end: i + windowLen, distance: dist, exact: dist === 0 });
        }
      }
    }
  }

  return dedupeOverlaps(hits);
}

export interface FuzzyHit {
  matched: string;
  start: number;
  end: number;
  distance: number;
  exact: boolean;
}

function dedupeOverlaps(hits: FuzzyHit[]): FuzzyHit[] {
  hits.sort((a, b) => a.distance - b.distance || a.start - b.start);
  const kept: FuzzyHit[] = [];
  for (const h of hits) {
    if (!kept.some(k => h.start < k.end && h.end > k.start)) {
      kept.push(h);
    }
  }
  return kept.sort((a, b) => a.start - b.start);
}

export function fuzzyMatchLines(
  lines: string[],
  target: string,
  opts: { maxDist?: number; contextLines?: number } = {}
): LineFuzzyHit[] {
  const { maxDist = 2, contextLines = 2 } = opts;
  const results: LineFuzzyHit[] = [];

  const tLower = target.toLowerCase();
  const prefixes = new Set<string>();
  for (let len = 3; len <= Math.min(5, tLower.length); len++) {
    prefixes.add(tLower.slice(0, len));
  }
  for (let i = 0; i <= tLower.length - 3; i++) {
    prefixes.add(tLower.slice(i, i + 3));
  }

  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    let hasCandidate = false;
    for (const p of prefixes) {
      if (lower.includes(p)) { hasCandidate = true; break; }
    }
    if (!hasCandidate) continue;

    const hits = fuzzyMatch(lines[i], target, maxDist);
    if (hits.length > 0) {
      const ctxStart = Math.max(0, i - contextLines);
      const ctxEnd = Math.min(lines.length, i + contextLines + 1);
      const context = lines.slice(ctxStart, ctxEnd).join(" | ").slice(0, 400);
      for (const h of hits) {
        results.push({ ...h, lineNum: i, context });
      }
    }
  }

  return results;
}

export interface LineFuzzyHit extends FuzzyHit {
  lineNum: number;
  context: string;
}

export function soundex(s: string): string {
  const a = s.toUpperCase().split("");
  const codes: Record<string, string> = {
    B:"1",F:"1",P:"1",V:"1",
    C:"2",G:"2",J:"2",K:"2",Q:"2",S:"2",X:"2",Z:"2",
    D:"3",T:"3",
    L:"4",
    M:"5",N:"5",
    R:"6",
  };
  let result = a[0];
  let prev = codes[a[0]] || "";
  for (let i = 1; i < a.length && result.length < 4; i++) {
    const c = codes[a[i]];
    if (c && c !== prev) { result += c; prev = c; }
    else if (!c) prev = "";
  }
  return result.padEnd(4, "0");
}

export function phoneticMatch(a: string, b: string): boolean {
  return soundex(a) === soundex(b);
}
