// Hello, router — picks the cheapest observation tier and verifies a step.
//
//   npx tsx packages/cu-router/examples/hello-router.ts

import { ComputerUseBus, FakeSurface } from "@rachael/cu-core";
import { Router, Budget, InMemoryTraceSink } from "@rachael/cu-router";

const bus = new ComputerUseBus();
const surface = new FakeSurface();
bus.registerSurface(surface);

const sink = new InMemoryTraceSink();
const budget = new Budget({ maxModelSpendUsd: 0.05 });
const router = new Router({ runId: "demo-run", budget, emitter: sink.emit });

const result = await router.step(surface, {
  action: { verb: "Goto", url: "fake://form" },
});

console.log(`tier=${result.observationKind} ok=${result.ok}`);
console.log(`spent=$${budget.usage.modelSpendUsd.toFixed(4)}`);
console.log(`trace events:`);
for (const ev of sink.events) {
  console.log(`  - ${ev.kind} (step ${ev.stepIndex})`);
}
