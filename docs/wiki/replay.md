# Replay engine

Source: [`server/replay-engine.ts`](../../server/replay-engine.ts) (~461 lines)
+ [`server/navigation-session.ts`](../../server/navigation-session.ts) (~114 lines)

The replay engine learns navigation procedures from observed user/agent
sessions, synthesizes named **recipes** per fingerprint→fingerprint edge,
and can later replay them via the desktop agent.

> Note the term clash: a "recipe" *here* is an LLM-synthesized navigation
> procedure for a screen-pair. A "recipe" *in `cli-engine.ts`* is a saved
> CLI command chain (`recipes` table). They are different concepts.

## Storage

Recipes live in `agent_config` under keys of the form
`nav_recipe_{fromFp}_{toFp}` — one per unique edge.

Each recipe contains:

- A short name (LLM-generated).
- Parameterized steps (action keys, target text, wait times).
- Tags + safety level (`low`/`medium`/`high`).
- Confidence + observation count + alternative action keys.

## Synthesis

On every new edge observed in `POST /api/sessions/stream`, the engine
calls an LLM (cheap tier) to synthesize a recipe. If LLM synthesis fails it
falls back to a literal action-key recording.

## Strengthening

Repeated observations of the same edge:

- Increment `confidence`.
- Update timing.
- Add alternative action keys when variation is observed.

## Pathfinding

`findShortestPath(from, to, windowKey)` — BFS over the navigation tree
edges. Exposed at:

```
GET /api/sessions/pathfind?from=fp&to=fp&windowKey=wk
GET /api/sessions/pathfind?from=fp&target=name&windowKey=wk   (fuzzy)
```

## Replay execution

`POST /api/sessions/replay`:

1. Resolve the path via pathfinding.
2. Run each recipe step on the desktop agent (queued as a `nav_replay`
   command via the control bus).
3. After each step verify the destination by screenshot fingerprint.
4. Retry up to 2× on mismatch.

## Safety gate

Hard-block keyword patterns: `password`, `delete`, `submit order`, `logout`.
Plus an LLM risk classifier (low / medium / high). High-risk paths require
explicit approval (creates a takeover point — see [control bus](./control-bus.md)).

## Screen labeling

When a new fingerprint is seen for the first time, its screenshot is queued
for Gemini-Flash vision analysis to produce a short label like
"Patient List" or "Chart Review". Labels are cached globally and prepended
to the node's `titles[]` array; the heartbeat piggy-backs them so the tree
view shows readable names instead of raw window titles.

## Heartbeat piggyback

Because `POST /api/sessions/stream` is sometimes blocked by Citrix/Hyperspace
network policy, tree-stream data (fingerprints + transitions) is shipped
inside the working `POST /api/epic/agent/heartbeat` payload as
`streamData[]`. `_drain_all_stream_data()` (in the desktop agent) collects
pending data from all open captures.

## TreeView surface

Every destination node renders a `>> Go here` action that issues
`epic go SUP <title>`. Edges show `{new}` or `{confirmed}` (3+ observations).
