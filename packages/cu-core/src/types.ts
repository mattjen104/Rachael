import { z } from "zod";

// ---------------------------------------------------------------------------
// Locator — how an Action names its target.
//
// We deliberately keep `Coords` last and discourage callers from constructing
// it directly: prefer a stable handle (selector, UIA path, hint key, element
// mark) so a recipe survives layout changes. `Coords` exists because vision
// surfaces (e.g. a Citrix RDP image) sometimes have nothing else.
// ---------------------------------------------------------------------------

export const SelectorLocatorSchema = z.object({
  kind: z.literal("selector"),
  css: z.string(),
  nth: z.number().int().nonnegative().optional(),
});
export type SelectorLocator = z.infer<typeof SelectorLocatorSchema>;

export const UiaPathLocatorSchema = z.object({
  kind: z.literal("uia"),
  automationId: z.string().optional(),
  controlType: z.string().optional(),
  name: z.string().optional(),
  path: z.array(z.string()).optional(),
});
export type UiaPathLocator = z.infer<typeof UiaPathLocatorSchema>;

export const HintKeyLocatorSchema = z.object({
  kind: z.literal("hint"),
  key: z.string(),
});
export type HintKeyLocator = z.infer<typeof HintKeyLocatorSchema>;

export const ElementMarkLocatorSchema = z.object({
  kind: z.literal("mark"),
  mark: z.string(),
});
export type ElementMarkLocator = z.infer<typeof ElementMarkLocatorSchema>;

export const CoordsLocatorSchema = z.object({
  kind: z.literal("coords"),
  x: z.number(),
  y: z.number(),
  rationale: z.string().optional(),
});
export type CoordsLocator = z.infer<typeof CoordsLocatorSchema>;

export const LocatorSchema = z.discriminatedUnion("kind", [
  SelectorLocatorSchema,
  UiaPathLocatorSchema,
  HintKeyLocatorSchema,
  ElementMarkLocatorSchema,
  CoordsLocatorSchema,
]);
export type Locator = z.infer<typeof LocatorSchema>;

// ---------------------------------------------------------------------------
// Capabilities — what a surface can observe and do. Adapters fill this in.
// ---------------------------------------------------------------------------

export const ObservationKindSchema = z.enum([
  "AxTree",
  "DomSnapshot",
  "UiaTree",
  "SomScreenshot",
  "RawScreenshot",
  "TextDump",
]);
export type ObservationKind = z.infer<typeof ObservationKindSchema>;

export const ActionVerbSchema = z.enum([
  "Click",
  "Type",
  "Key",
  "Hint",
  "Scroll",
  "Wait",
  "Goto",
  "Shell",
  "Composite",
]);
export type ActionVerb = z.infer<typeof ActionVerbSchema>;

export const LocatorKindSchema = z.enum(["selector", "uia", "hint", "mark", "coords"]);
export type LocatorKind = z.infer<typeof LocatorKindSchema>;

export const CapabilitiesSchema = z.object({
  observations: z.array(ObservationKindSchema),
  actions: z.array(ActionVerbSchema),
  locators: z.array(LocatorKindSchema),
  // Cost hint per operation, in arbitrary units the router can compare.
  // Lower is cheaper. Routers should treat absent fields as "unknown".
  cost: z
    .object({
      observe: z.number().nonnegative().optional(),
      act: z.number().nonnegative().optional(),
    })
    .optional(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;

// ---------------------------------------------------------------------------
// Surface — a thing you can observe and act on.
//
// Intent: a uniform handle for a browser tab, a desktop window, a Citrix
// session, a CLI shell, or a stub. Adapters create Surfaces and register
// them with the bus.
//
// Non-goal: a Surface is *not* a model loop. It exposes raw capabilities;
// strategy lives one layer up.
// ---------------------------------------------------------------------------

export const SurfaceKindSchema = z.enum([
  "browser-tab",
  "browser-extension",
  "desktop-window",
  "citrix-session",
  "shell",
  "fake",
]);
export type SurfaceKind = z.infer<typeof SurfaceKindSchema>;

export const SurfaceDescriptorSchema = z.object({
  id: z.string(),
  kind: SurfaceKindSchema,
  label: z.string().optional(),
  capabilities: CapabilitiesSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type SurfaceDescriptor = z.infer<typeof SurfaceDescriptorSchema>;

// ---------------------------------------------------------------------------
// Observation — a snapshot of a surface in one of several typed forms.
// Every observation carries a digest so verifiers can detect change.
// ---------------------------------------------------------------------------

const ObservationBaseSchema = z.object({
  surfaceId: z.string(),
  timestamp: z.number(),
  digest: z.string(),
});

export const AxTreeObservationSchema = ObservationBaseSchema.extend({
  kind: z.literal("AxTree"),
  root: z.unknown(),
});
export type AxTreeObservation = z.infer<typeof AxTreeObservationSchema>;

export const DomSnapshotObservationSchema = ObservationBaseSchema.extend({
  kind: z.literal("DomSnapshot"),
  url: z.string().optional(),
  title: z.string().optional(),
  html: z.string().optional(),
  text: z.string().optional(),
  elements: z
    .array(
      z.object({
        tag: z.string(),
        text: z.string().optional(),
        role: z.string().optional(),
        href: z.string().optional(),
        type: z.string().optional(),
      }),
    )
    .optional(),
});
export type DomSnapshotObservation = z.infer<typeof DomSnapshotObservationSchema>;

export const UiaTreeObservationSchema = ObservationBaseSchema.extend({
  kind: z.literal("UiaTree"),
  windowTitle: z.string().optional(),
  elements: z.array(
    z.object({
      automationId: z.string().optional(),
      controlType: z.string().optional(),
      name: z.string().optional(),
      hint: z.string().optional(),
      rect: z
        .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number(), cx: z.number(), cy: z.number() })
        .optional(),
    }),
  ),
});
export type UiaTreeObservation = z.infer<typeof UiaTreeObservationSchema>;

export const SomScreenshotObservationSchema = ObservationBaseSchema.extend({
  kind: z.literal("SomScreenshot"),
  imageRef: z.string(),
  marks: z.array(
    z.object({
      mark: z.string(),
      rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
      label: z.string().optional(),
    }),
  ),
});
export type SomScreenshotObservation = z.infer<typeof SomScreenshotObservationSchema>;

export const RawScreenshotObservationSchema = ObservationBaseSchema.extend({
  kind: z.literal("RawScreenshot"),
  imageRef: z.string(),
  width: z.number().optional(),
  height: z.number().optional(),
});
export type RawScreenshotObservation = z.infer<typeof RawScreenshotObservationSchema>;

export const TextDumpObservationSchema = ObservationBaseSchema.extend({
  kind: z.literal("TextDump"),
  text: z.string(),
});
export type TextDumpObservation = z.infer<typeof TextDumpObservationSchema>;

export const ObservationSchema = z.discriminatedUnion("kind", [
  AxTreeObservationSchema,
  DomSnapshotObservationSchema,
  UiaTreeObservationSchema,
  SomScreenshotObservationSchema,
  RawScreenshotObservationSchema,
  TextDumpObservationSchema,
]);
export type Observation = z.infer<typeof ObservationSchema>;

// ---------------------------------------------------------------------------
// Action — a typed verb. `target` is a Locator; never raw coords unless
// `kind: "coords"` is explicitly chosen.
// ---------------------------------------------------------------------------

export const ClickActionSchema = z.object({
  verb: z.literal("Click"),
  target: LocatorSchema,
  button: z.enum(["left", "right", "middle"]).optional(),
});
export type ClickAction = z.infer<typeof ClickActionSchema>;

export const TypeActionSchema = z.object({
  verb: z.literal("Type"),
  target: LocatorSchema.optional(),
  text: z.string(),
  clearFirst: z.boolean().optional(),
});
export type TypeAction = z.infer<typeof TypeActionSchema>;

export const KeyActionSchema = z.object({
  verb: z.literal("Key"),
  chord: z.string(),
});
export type KeyAction = z.infer<typeof KeyActionSchema>;

export const HintActionSchema = z.object({
  verb: z.literal("Hint"),
  hint: z.string(),
  value: z.string().optional(),
});
export type HintAction = z.infer<typeof HintActionSchema>;

export const ScrollActionSchema = z.object({
  verb: z.literal("Scroll"),
  target: LocatorSchema.optional(),
  dy: z.number().optional(),
  dx: z.number().optional(),
});
export type ScrollAction = z.infer<typeof ScrollActionSchema>;

// Wait must specify at least one of `ms` or `until`. The constraint is
// enforced via superRefine on AtomicActionSchema below (a plain `.refine`
// here would break discriminatedUnion membership).
export const WaitActionSchema = z.object({
  verb: z.literal("Wait"),
  ms: z.number().nonnegative().optional(),
  until: z.string().optional(),
});
export type WaitAction = z.infer<typeof WaitActionSchema>;

export const GotoActionSchema = z.object({
  verb: z.literal("Goto"),
  url: z.string(),
});
export type GotoAction = z.infer<typeof GotoActionSchema>;

export const ShellActionSchema = z.object({
  verb: z.literal("Shell"),
  cmd: z.string(),
  cwd: z.string().optional(),
});
export type ShellAction = z.infer<typeof ShellActionSchema>;

// Composite is recursive — declared with z.lazy + a separate type alias.
export type AtomicAction =
  | ClickAction
  | TypeAction
  | KeyAction
  | HintAction
  | ScrollAction
  | WaitAction
  | GotoAction
  | ShellAction;

export interface CompositeAction {
  verb: "Composite";
  label?: string;
  steps: Action[];
}

export type Action = AtomicAction | CompositeAction;

export const AtomicActionSchema = z
  .discriminatedUnion("verb", [
    ClickActionSchema,
    TypeActionSchema,
    KeyActionSchema,
    HintActionSchema,
    ScrollActionSchema,
    WaitActionSchema,
    GotoActionSchema,
    ShellActionSchema,
  ])
  .superRefine((val, ctx) => {
    if (val.verb === "Wait" && val.ms === undefined && val.until === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Wait requires either `ms` or `until`",
      });
    }
  });

export const CompositeActionSchema: z.ZodType<CompositeAction> = z.lazy(() =>
  z.object({
    verb: z.literal("Composite"),
    label: z.string().optional(),
    steps: z.array(ActionSchema),
  }),
);

export const ActionSchema: z.ZodType<Action> = z.lazy(() =>
  z.union([AtomicActionSchema, CompositeActionSchema]),
);

// ---------------------------------------------------------------------------
// Verifier — a pre/post check.
// ---------------------------------------------------------------------------

export const VerifierSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("expectElement"), target: LocatorSchema, present: z.boolean().optional() }),
  z.object({ kind: z.literal("expectText"), text: z.string(), within: LocatorSchema.optional(), match: z.enum(["equals", "contains", "regex"]).optional() }),
  z.object({ kind: z.literal("expectUrl"), url: z.string(), match: z.enum(["equals", "contains", "regex"]).optional() }),
  z.object({
    kind: z.literal("expectImageRegion"),
    rect: z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() }),
    expectedDigest: z.string().optional(),
  }),
  z.object({ kind: z.literal("expectNoChange"), sinceDigest: z.string() }),
  z.object({ kind: z.literal("expectHash"), digest: z.string() }),
]);
export type Verifier = z.infer<typeof VerifierSchema>;

export const VerifierResultSchema = z.object({
  status: z.enum(["pass", "fail", "unknown"]),
  evidence: z.string().optional(),
  observedDigest: z.string().optional(),
});
export type VerifierResult = z.infer<typeof VerifierResultSchema>;

// ---------------------------------------------------------------------------
// Recipe — a named, replayable sequence.
// ---------------------------------------------------------------------------

export const RecipeStepSchema = z.object({
  pre: VerifierSchema.optional(),
  action: ActionSchema,
  post: VerifierSchema.optional(),
});
export type RecipeStep = z.infer<typeof RecipeStepSchema>;

export const RecipeSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  parameters: z.record(z.string(), z.object({
    type: z.enum(["string", "number", "boolean"]),
    description: z.string().optional(),
    required: z.boolean().optional(),
  })).optional(),
  surfaceKind: SurfaceKindSchema.optional(),
  steps: z.array(RecipeStepSchema),
  successCriteria: z.array(VerifierSchema).optional(),
  provenance: z
    .object({
      learnedFromTrajectoryId: z.string().optional(),
      author: z.string().optional(),
      createdAt: z.number().optional(),
    })
    .optional(),
});
export type Recipe = z.infer<typeof RecipeSchema>;
