// Hello, cu-core — register the FakeSurface, observe, act, verify.
//
//   npx tsx packages/cu-core/examples/hello-core.ts

import { ComputerUseBus, FakeSurface } from "@rachael/cu-core";

const bus = new ComputerUseBus();
const surface = new FakeSurface();
bus.registerSurface(surface);

const [obs] = await bus.observe(surface.descriptor.id, ["AxTree"]);
console.log(`observed: kind=${obs.kind} digest=${obs.digest}`);

const act = await bus.act(surface.descriptor.id, { verb: "Goto", url: "fake://hello" });
console.log(`act ok=${act.ok}`);

const verdict = await bus.verify(surface.descriptor.id, { kind: "expectText", text: "submitted" });
console.log(`verify status=${verdict.status}`);
