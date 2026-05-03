# MIGRATION.md — Adopting the extracted `@rachael/cu` SDK

This document covers two consumer paths for the v0.x SDK:

1. **Internal — Rachael itself**, which keeps consuming the packages
   via TypeScript path aliases and `peerDependencies`.
2. **External — a third-party tool** (analyst dashboard, evals
   pipeline, custom agent runtime) that consumes the packages via
   `npm` and `pip` once we publish.

Both paths share the same package boundaries; the only difference is
the resolver.

## Package graph

```
              ┌────────────────────┐
              │ @rachael/cu-core   │  (types, bus, FakeSurface)
              └──┬───┬───┬───┬─────┘
                 │   │   │   │
   ┌─────────────┘   │   │   └────────────────┐
   ▼                 ▼   ▼                    ▼
┌───────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐
│ cu-browser│  │cu-windows│  │ cu-router│  │ cu-inspector-data    │
└───────────┘  └────┬─────┘  └──────────┘  └──────────────────────┘
                    │
                    ▼ HTTP
            ┌──────────────────┐
            │ rachael-cu-windows│  (Python sidecar: SoM + UIA bridge)
            └──────────────────┘

                ┌───────────┐
                │ cu-skills │  (depends on cu-core)
                └───────────┘

                ┌───────────┐
                │ cu-bench  │  (dev-time; depends on cu-core)
                └───────────┘
```

`cu-router`, `cu-skills`, `cu-browser`, and `cu-windows` declare
`@rachael/cu-core` as a `peerDependency`. They re-export the relevant
symbols today (in-monorepo extraction phase). The full code split
lands when the repository moves to its own GitHub org.

## Path 1 — Internal (Rachael)

### tsconfig path aliases

```jsonc
// tsconfig.json
{
  "compilerOptions": {
    "paths": {
      "@rachael/cu-core":           ["./packages/cu-core/src/index.ts"],
      "@rachael/cu-core/*":         ["./packages/cu-core/src/*"],
      "@rachael/cu-browser":        ["./packages/cu-browser/src/index.ts"],
      "@rachael/cu-windows":        ["./packages/cu-windows/src/index.ts"],
      "@rachael/cu-router":         ["./packages/cu-router/src/index.ts"],
      "@rachael/cu-skills":         ["./packages/cu-skills/src/index.ts"],
      "@rachael/cu-inspector-data": ["./packages/cu-inspector-data/src/index.ts"]
    }
  }
}
```

The aliases for the new packages are already in place. Existing
imports of `@rachael/cu-core` continue to work unchanged.

### Where to import from now

| Symbol | Old import (still works) | New, narrower import |
|---|---|---|
| `BrowserPlaywrightAdapter` | `@rachael/cu-core` | `@rachael/cu-browser` |
| `BrowserExtensionAdapter` | `@rachael/cu-core` | `@rachael/cu-browser` |
| `WindowsUiaAdapter`, `CitrixVisionAdapter`, `SomDetectorHttpClient` | `@rachael/cu-core` | `@rachael/cu-windows` |
| `Router`, `Budget`, `InMemoryTraceSink`, recovery, strategies | `@rachael/cu-core` | `@rachael/cu-router` |
| `InMemorySkillLibrary`, `runRecipe`, `matchRecipe`, `SEED_RECIPES` | `@rachael/cu-core` | `@rachael/cu-skills` |
| `TrajectoryEvent`, `RedactionPolicy`, `redactFrame`, `redactedScreenshotSvg` | `@shared/trajectory-types` + `server/redaction.ts` | `@rachael/cu-inspector-data` |

Internal Rachael code is **not required to migrate**; the umbrella
re-export from `@rachael/cu-core` continues to work for v0.x. New code
should prefer the narrow imports — that's what the public docs
recommend, and switching now means no churn when we drop the umbrella
re-export in v1.x.

### Workspaces

Adding `"workspaces": ["packages/*"]` to the root `package.json` is
deferred (the root file is locked by the platform). The packages are
still publish-ready: `npm pack` works from each package directory and
produces a clean tarball. See `RELEASING.md`.

## Path 2 — External (third-party consumer)

### npm

```bash
npm install @rachael/cu-core @rachael/cu-browser @rachael/cu-router zod
```

```ts
import { ComputerUseBus } from "@rachael/cu-core";
import { BrowserPlaywrightAdapter } from "@rachael/cu-browser";
import { Router, Budget, InMemoryTraceSink } from "@rachael/cu-router";

// 1. Bring your own bridge.
const bridge = await myPlaywrightBridge();

// 2. Wire up.
const bus = new ComputerUseBus();
bus.registerSurface(new BrowserPlaywrightAdapter({ bridge, surfaceId: "main" }));

// 3. Drive it.
const sink = new InMemoryTraceSink();
const router = new Router({
  runId: crypto.randomUUID(),
  budget: new Budget({ maxModelSpendUsd: 0.10 }),
  emitter: sink.emit,
});

await router.step(bus.requireSurface("main"), {
  action: { verb: "Goto", url: "https://example.com" },
});
```

### pip (for the Windows / Citrix sidecar)

```bash
pip install "rachael-cu-windows[all]"
rachael-cu-som &
rachael-cu-uia &
```

Then in your TS app:

```ts
import { SomDetectorHttpClient, CitrixVisionAdapter } from "@rachael/cu-windows";

const detector = new SomDetectorHttpClient({ baseUrl: "http://127.0.0.1:8765" });
const adapter = new CitrixVisionAdapter({ io: myCitrixIo, detector, surfaceId: "epic" });
```

### Inspector data contract

```bash
npm install @rachael/cu-inspector-data zod
```

```ts
import {
  redactFrame,
  redactedScreenshotSvg,
  TrajectoryEventSchema,
} from "@rachael/cu-inspector-data";

const event = TrajectoryEventSchema.parse(rawEvent);
const { event: safe, hits } = redactFrame(event);
const placeholder = redactedScreenshotSvg({ width: 1920, height: 1080 });
```

You build your own UI on top. The React inspector inside Rachael is
intentionally not in the public package — see `MOTIVATION.md`.

## Compatibility commitments for v0.x

- All exported types, schemas, and class signatures are stable across
  the v0.x line.
- Default behavior of the redactor, the strategy table, and the
  cheapest-reliable router is stable; the *exact* numerical
  thresholds may shift across patch releases.
- `peerDependencies` ranges (`@rachael/cu-core: ^0.1.0`) hold across
  the v0.x line; v1.x is a new compat band.

## Migration checklist for an internal team

- [ ] Replace `@rachael/cu-core` imports of router / skill / adapter
      symbols with the narrow package per the table above.
- [ ] Move trajectory-event consumers to `@rachael/cu-inspector-data`
      (replace `@shared/trajectory-types` imports).
- [ ] If you wrote a custom redactor, swap to
      `redactFrame(event, policy)` — the default policy supersets the
      patterns we shipped in `server/redaction.ts`.
- [ ] If you maintain a custom surface adapter, ensure it does **not**
      import from `server/`, `client/`, or `@shared/`. The boundary
      lint at `scripts/check-package-boundaries.ts` enforces this.
