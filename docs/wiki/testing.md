# Testing

## What exists

- One Vitest file: [`tests/bridge-gating.test.ts`](../../tests/bridge-gating.test.ts) (345 lines).
- It mocks `server/storage`, `server/secrets`, `server/agent-runtime`,
  `server/model-router`, `server/ask-engine`, then drives `cli-engine`'s
  `boot` command to verify bridge-token gating.

That's the complete test suite.

## Running

```bash
npx vitest run                # one-shot
npx vitest                    # watch
```

## What's missing

See [audit § Testing](./audit.md#testing) for prioritized gaps. High-level:

- **No tests** for: agent-runtime tick loop, evolution gates, model router
  fallback, replay engine, scrapers, capture parser, sanitizer,
  rate-limit, secrets crypto roundtrip, route handlers (Zod validation).
- No frontend tests at all (no React Testing Library, no Playwright e2e).
- No fixtures for LLM mocks beyond the Vitest mock factory in the single
  test file.

## CI

There is no CI configuration in the repo (`.github/workflows/` is absent).
`scripts/post-merge.sh` is the only post-VCS hook.
