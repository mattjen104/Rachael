# Non-goals — `@rachael/cu-skills` v0.x

- **No reward-signal-based ranking.** Match scores are deterministic.
  RL-flavored ranking is a v1.x candidate.
- **No cross-org / network skill registry.** Storage is local. The
  consuming app may build a registry on top, but the package does not
  ship one.
- **No mandatory LLM dependency.** `heuristicSummarizer` is the
  built-in summarizer; pass any `RecipeSummarizer` to use an LLM.
- **No UI.** Recipe browsing, approval, and editing are the consuming
  app's job.
- **No automatic execution policy.** Whether to *run* a matched recipe
  is the caller's decision; the library only recommends.
- **No backwards execution.** Recipes are forward-only sequences;
  rollback semantics belong to the surface adapter.
