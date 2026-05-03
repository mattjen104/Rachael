// Hello, skill — register the seed recipes and run one against FakeSurface.
//
//   npx tsx packages/cu-skills/examples/hello-skill.ts

import { ComputerUseBus, FakeSurface } from "@rachael/cu-core";
import {
  InMemorySkillLibrary,
  runRecipe,
  SEED_RECIPES,
  matchRecipe,
} from "@rachael/cu-skills";

const bus = new ComputerUseBus();
const surface = new FakeSurface();
bus.registerSurface(surface);

const library = new InMemorySkillLibrary();
for (const r of SEED_RECIPES) library.add(r);

console.log(`library size: ${library.list().length}`);

const match = matchRecipe(library.list(), {
  surfaceKind: surface.descriptor.kind,
  intent: "smoke test",
  parameters: {},
});
console.log(`best match: ${match?.recipe.name ?? "(none)"} score=${match?.score ?? 0}`);

if (match) {
  const result = await runRecipe(match.recipe, surface, { params: {} });
  console.log(`recipe ok=${result.ok} steps=${result.stepResults.length}`);
}
