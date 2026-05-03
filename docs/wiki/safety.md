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

## Screenshot redaction pipeline (planned)

Once the [CU stack](./computer-use.md) and
[analyst inspector](./cu-inspector.md) land, every `Observation` of
kind `RawScreenshot`, `SomScreenshot`, or `DomSnapshot` flows through
a **server-side, default-on redactor** before display or storage:

- Pattern-based scrubbers strip patient names, MRNs, phone numbers,
  emails, dollar amounts in account contexts, and any custom regex
  configured in `agent_config.redaction_patterns`.
- DOM snapshots are walked and matching text nodes are replaced with
  `[REDACTED:<reason>]`.
- For images, an OCR pass identifies text regions; matches are pixel-
  blurred before the image is stored or shown.
- An **audited unlock** (`POST /api/inspector/unlock`, owner-only,
  reason required, expiry-bounded) flips a per-trajectory flag that
  exposes the raw originals in the inspector. Every unlock is written
  to the [audit log](./control-bus.md) with `actor`, `reason`, and
  `trajectoryId`.

The redactor is fail-closed: if the redaction pass errors, the raw
observation is dropped (not surfaced) and the run records a
`redaction-failed` event for analyst review.

## Armed-vs-echo-only device flag (planned)

Each row in the planned `devices` table
([data-model](./data-model.md)) carries an **`armed`** boolean,
default `false`. When unarmed:

- Chat / text input still works (the device can talk to the agent).
- Action dispatch is **echo-only**: keypresses or shortcut triggers
  display on the device for feedback but do **not** result in a real
  `Action` being dispatched through the
  [computer-use bus](./computer-use.md).

Arming requires an explicit `device arm <id>` from a trusted client
(web UI or CLI) and is audit-logged. A lost or stolen device cannot
drive the agent until re-armed. See
[integrations-lilygo-keyboard](./integrations-lilygo-keyboard.md) and
[integrations-ios](./integrations-ios.md) for device-specific UX.

## Per-app takeover-required policy for iOS (planned)

The [iOS adapter](./integrations-ios.md) consults
`agent_config.ios_app_policy` before dispatching any action. Per-
bundle-id values are `autonomous` / `approval` / `blocked`, mapping
onto the same three [permission levels](./control-bus.md) the rest of
Rachael uses. The default for unknown bundle ids is `approval` — a
takeover point is created and the human must confirm. Sensitive
defaults shipped at launch: MyChart-class apps `approval`; banking
apps `blocked`.
