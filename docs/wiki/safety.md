# Sanitization & rate limiting

## Rate limiter

Source: [`server/rate-limit.ts`](../../server/rate-limit.ts) (~102 lines)

- In-process token-bucket per IP.
- Mounted globally in `server/index.ts:31`.
- Configurable via env (defaults are conservative — sufficient for a
  personal app, not a public API).
- No backing store, so multi-instance deployments would drift.

## Output sanitizer

Source: [`server/output-sanitizer.ts`](../../server/output-sanitizer.ts) (~62 lines)

- Strips fenced code blocks (`[code block removed]`) before showing LLM
  output to the user — prevents accidental "render this HTML" attacks.
- Length-limits text passed back to the UI.

## TUI sanitizer

Source: [`server/sanitize.ts`](../../server/sanitize.ts) (~87 lines)

- Strips/replaces unsafe Unicode for terminal display (BiDi overrides,
  ANSI escapes, control chars).
- Used by the TUI client and the CLI output pipeline.

## What's NOT sanitized

- LLM output rendered into HTML briefings (`.briefings/digest-*.html`)
  goes through `safeUrl()` for URLs and HTML-escapes attributes — but the
  general body is trusted because it was produced by Claude.
- Galaxy KB `fullText` is stored raw and rendered in
  `GalaxyKbView.tsx`; React's auto-escaping is the only line of defense.

See [audit § Security #8](./audit.md#8-sanitization-coverage-gaps) for
specifics.
