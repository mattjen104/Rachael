# `@rachael/cu-core`

A tiny, transport-agnostic vocabulary for **computer use** — the act of an agent observing and acting on a real surface (a browser tab, a desktop window, a Citrix session, a CLI shell). It is the shared seam under Rachael's browser bridge, Chrome extension, and Windows/Citrix Epic agent, and it is designed to be extracted as a public SDK later.

This v1 is intentionally narrow: **types, interfaces, and an in-process bus.** No surface adapters, no smart routing, no recipe learning. The goal is "every existing primitive can be expressed in this vocabulary, and nothing leaks across boundaries."

## The five primitives

```
                 ┌──────────────┐
                 │   Recipe     │  named, replayable sequence
                 └──────┬───────┘
                        │ uses
                ┌───────▼────────┐
        ┌───────│   Verifier     │───────┐
        │       └────────────────┘       │
   pre  │                                │ post
        │       ┌────────────────┐       │
        └──────▶│    Action      │◀──────┘
                │  (verb+target) │
                └───────┬────────┘
                        │ acts on
                ┌───────▼────────┐
                │   Surface      │
                │ (capabilities) │
                └───────┬────────┘
                        │ produces
                ┌───────▼────────┐
                │  Observation   │
                │ (typed snapshot)
                └────────────────┘
```

1. **`Surface`** — a thing you can observe and act on. Declares its `capabilities` (what observation kinds and action verbs it supports) and a `cost` hint. Adapters implement this. v1 ships a `FakeSurface` for tests and examples.
2. **`Observation`** — a snapshot in one of six typed shapes: `AxTree`, `DomSnapshot`, `UiaTree`, `SomScreenshot` (image + element marks), `RawScreenshot`, `TextDump`. Every observation carries `timestamp`, `surfaceId`, and a `digest` so verifiers can detect change.
3. **`Action`** — a typed verb: `Click`, `Type`, `Key`, `Hint`, `Scroll`, `Wait`, `Goto`, `Shell`, plus `Composite` for atomic multi-step. The `target` is a `Locator` union: `selector | uia | hint | mark | coords` — never raw coords unless explicitly chosen.
4. **`Verifier`** — a pre/post check: `expectElement`, `expectText`, `expectUrl`, `expectImageRegion`, `expectNoChange`, `expectHash`. Returns `pass | fail | unknown` with evidence.
5. **`Recipe`** — a named, replayable sequence of `(pre?, action, post?)` triples with parameters, success criteria, and provenance (which trajectory it was learned from).

Plus one runtime:

- **`ComputerUseBus`** — the only thing callers should hold. Surfaces register; callers `observe`, `act`, `verify`. The bus is transport-agnostic: today it wraps `InProcessTransport`; later a queue or websocket transport slots in without changing callers.

## End-to-end example

```ts
import {
  ComputerUseBus,
  FakeSurface,
} from "@rachael/cu-core";

const bus = new ComputerUseBus();
const surface = new FakeSurface();
bus.registerSurface(surface);
const id = surface.descriptor.id;

// 1. Observe.
const [before] = await bus.observe(id, ["TextDump"]);

// 2. Decide → act.
await bus.act(id, { verb: "Goto", url: "fake://form" });
await bus.act(id, {
  verb: "Type",
  target: { kind: "selector", css: "input[type=text]" },
  text: "hello",
  clearFirst: true,
});
await bus.act(id, {
  verb: "Click",
  target: { kind: "selector", css: "button" },
});

// 3. Verify.
const result = await bus.verify(id, { kind: "expectText", text: "submitted=true" });
if (result.status !== "pass") throw new Error(`Verify failed: ${result.evidence}`);

// 4. Detect change vs. earlier digest.
const [after] = await bus.observe(id, ["TextDump"]);
const changed = before.digest !== after.digest;
```

## Design notes & non-goals

- **No adapter implementations here.** The browser bridge, Chrome extension, Windows UIA, and Citrix vision adapters live one layer up and arrive in the next task.
- **No smart routing.** Picking *which* observation kind to request, or *which* surface satisfies a recipe step, is a router's job — also a later task.
- **No trajectory memory.** `Recipe.provenance` makes room for "learned from trajectory X", but the learning loop is separate.
- **No transport beyond in-process.** The `Transport` interface exists so a control-bus-queue transport and a websocket transport can be added without changing callers.
- **Zod schemas are exported alongside every type** so transport boundaries can validate at runtime without re-deriving.

## Mapping today → tomorrow

| Today | Tomorrow's `Action` / `Observation` |
|---|---|
| `chrome-extension` `executeJob({ type: "dom", ... })` | `observe(id, ["DomSnapshot"])` |
| `browser-bridge.getPageContent` | `observe(id, ["DomSnapshot"])` returning `{ text, elements }` |
| `epic_agent execute_view` | `observe(id, ["UiaTree"])` |
| `epic_agent execute_do({ hint, value })` | `act(id, { verb: "Hint", hint, value })` |
| `epic_agent execute_click` (vision coords) | `act(id, { verb: "Click", target: { kind: "coords", ... } })` |
| `epic_agent execute_navigate` | `act(id, { verb: "Goto", url })` |
| `control-bus.QueuedCommand` | wraps an `Action` (typed via `cuAction?`) |
| `bridge-queue.BridgeJob` | wraps an `Action` (typed via `cuAction?`) |

This mapping is what the next task implements; v1 only provides the vocabulary.
