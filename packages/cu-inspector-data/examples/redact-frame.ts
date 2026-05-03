// Hello, redaction — show the default PHI/PII pipeline on a sample frame.
//
//   npx tsx packages/cu-inspector-data/examples/redact-frame.ts

import {
  redactFrame,
  redactedScreenshotSvg,
  type TrajectoryEvent,
} from "@rachael/cu-inspector-data";

const event: TrajectoryEvent = {
  id: "ev-1",
  ts: Date.now(),
  runId: "demo-run",
  stepIndex: 0,
  kind: "act",
  surfaceId: "epic-1",
  surfaceKind: "citrix-session",
  reason: "patient lookup for MRN 123456789",
  metadata: {
    text: "Patient MRN 123456789, phone 555-867-5309, email jane.doe@example.com",
    tree: "[Button] Sign In; DOB 02/14/1985",
  },
};

const { event: safe, hits } = redactFrame(event);
console.log("REDACTED FRAME:");
console.log(JSON.stringify(safe, null, 2));
console.log("HITS:", hits);

const svg = redactedScreenshotSvg({
  width: 320,
  height: 80,
  surfaceKind: event.surfaceKind,
  regions: [{ x: 12, y: 16, w: 240, h: 20, reason: "name-band" }],
});
console.log("\nWIREFRAME SVG (truncated):");
console.log(svg.slice(0, 200) + "...");
