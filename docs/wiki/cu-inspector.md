# Analyst trajectory inspector & HITL

> **Status: Planned** (see task task #97 (analyst inspector)).
>
> The trajectory inspector view does not exist yet. The closest things
> in the repo today are the [Cockpit view](./control-bus.md) (live
> activity stream, takeover-point resolver) and the Evolution panel
> (version history with judge results). The inspector is a deeper,
> per-step view dedicated to understanding and editing computer-use
> trajectories.

## Intent (2-3 sentences)

The inspector is the analyst's microscope on a single CU run: every
step, every observation, every model decision, every verifier verdict,
laid out as a scrubable timeline. It supports the human-in-the-loop
workflows that keep the agent honest — take over from this step,
edit-and-resume from this step, "why did it click here?" explanations
— and it is the gateway into the [skill library](./cu-skills.md):
analyst-approved trajectories promote into recipes from here.

## Planned UI

A new view (likely `client/src/components/views/InspectorView.tsx`),
reachable via the existing minibuffer (`M-x inspector`) or a sidebar
entry alongside the Cockpit view.

```
┌─────────────────────────────────────────────────────────────┐
│  Trajectory: <id>     Surface: <surfaceKind>     Status     │
├──────────────┬─────────────────────────────────────────────┤
│              │  Step N of M   (← →)                         │
│   Step       ├─────────────────────────────────────────────┤
│   timeline   │  Observation     Decision                    │
│              │  ┌──────────┐   ┌──────────┐                │
│   1 ●        │  │   AxTree │   │ Click(   │                │
│   2 ●        │  │  / SoM   │   │  selector│                │
│   3 ● fail   │  │          │   │ )        │                │
│   4 ●        │  └──────────┘   └──────────┘                │
│   5 …        │  Action          Verifier                   │
│              │  ┌──────────┐   ┌──────────┐                │
│              │  │ executed │   │  pass    │                │
│              │  └──────────┘   └──────────┘                │
└──────────────┴─────────────────────────────────────────────┘
[Take over from here]  [Edit & resume]  [Promote to recipe]
```

## Planned panels

Per-step, the inspector renders four panels:

1. **Observation** — the actual `Observation` snapshot used. For
   `SomScreenshot` and `RawScreenshot` this is a real image (with marks
   overlaid for SoM); for `AxTree` / `UiaTree` / `DomSnapshot` it's a
   collapsible tree; for `TextDump` it's the raw text. All pass through
   the [redaction pipeline](./safety.md) before display.
2. **Decision** — the `TaskProfile` the smart router sent to the
   [model-router](./model-router.md), the model picked, and the model's
   raw response (collapsible).
3. **Action** — the `Action` that executed (with bound `Locator`).
4. **Verifier** — the post-action verifier(s) that ran, with `pass /
   fail / unknown` and the evidence each one collected.

## Planned features

- **Take over from here.** Pause the trajectory at the current step and
  hand control back to the human (creates a takeover point in the
  [control bus](./control-bus.md), reusing the existing pause/resume
  machinery).
- **Edit and resume.** Branch the trajectory: edit the `Action` or the
  `TaskProfile`, then resume execution from the edited step. Saved as
  a new trajectory with a `branchedFrom` pointer.
- **"Why did it click here?"** Explainer that walks back from the bound
  `Locator` to the `Observation` element, highlights it visually, and
  shows the model prompt that produced the selection. Provenance for
  recipe-driven steps points all the way back to the originating
  trajectory ([cu-skills](./cu-skills.md)).
- **Replay diff view.** Side-by-side: the original trajectory's
  observations vs. a re-run's observations, with diffs flagged
  per-step. Useful for verifying that a recipe still works after a
  surface UI change.
- **Keyboard map.** `j/k` step prev/next, `g/G` jump to start/end,
  `t` take over, `e` edit, `p` promote, `r` replay, `?` help. Mirrors
  the conventions of the [TUI](./desktop-tools.md).

## Planned redaction pipeline

Server-side, default-on. Screenshots and DOM dumps pass through a
redactor before they hit the inspector — patient names, MRNs, phone
numbers, anything matching configured patterns is masked. Viewing the
raw, unredacted version requires an explicit unlock that is
audit-logged ([safety](./safety.md)).

## Planned data source

Reads from the `trajectory_frames` table (one row per step) and joins
in the corresponding `RouterTrace` record. See
[data-model](./data-model.md) for the planned columns.

## Related pages

- [cu-core](./computer-use.md), [cu-router](./cu-router.md),
  [cu-skills](./cu-skills.md)
- [control-bus](./control-bus.md) — the takeover-point machinery the
  inspector reuses
- [safety](./safety.md) — redaction pipeline + unlock audit
- [evolution](./evolution.md) — sister "look at what the agent did and
  decide what to keep" loop
