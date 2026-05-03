# Non-goals — `@rachael/cu-router` v0.x

- **No bundled LLM router.** `ModelRouterAdapter` is an interface; bring
  your own (OpenRouter, LiteLLM, Bedrock, etc.). `NULL_MODEL_ROUTER` is
  the no-op default.
- **No recipe matching or skill execution.** Belongs to
  [`@rachael/cu-skills`](../cu-skills).
- **No trajectory storage.** Emit `RouterTraceEvent`s into a sink of
  your choice; the canonical sink for analyst tooling is
  [`@rachael/cu-inspector-data`](../cu-inspector-data).
- **No global retry budget.** Per-step budget only; cross-step budget
  enforcement is the caller's job.
- **No exploration / RL.** The router is a deterministic decision tree
  over capabilities. Learning loops (skill promotion, success-rate-based
  strategy mutation) live in `@rachael/cu-skills` and the consuming app.
- **No surface registry beyond the cu-core bus.** Surface lifecycle is
  the caller's responsibility.
