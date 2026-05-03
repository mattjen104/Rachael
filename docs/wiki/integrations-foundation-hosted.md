# Integrations — Foundation Hosted

> **Status:** No first-class "Foundation Hosted" integration code exists in
> this repo as of the audit pass. A repo-wide search for `foundation` returns
> zero hits in `server/`, `client/`, `tools/`, `chrome-extension/`, or
> `shared/` (the only matches are inside `package-lock.json` package
> descriptions and an unrelated word in an attached asset).
>
> This page documents that fact, plus how Foundation Hosted **would** map
> onto Rachael's existing primitives if/when the user wants to add it.

## What Foundation Hosted is (context)

Foundation Hosted is Epic's hosted environment offering for Community
Connect partners. From a Rachael standpoint, it is functionally an
**Epic Hyperspace environment** (alongside the user's existing SUP / POC /
TST environments) — same Hyperspace.exe, same activities, same Citrix
publishing model.

## Current coverage via existing primitives

Even without a dedicated module, anything Foundation Hosted exposes is
already reachable via:

- The **Epic Hyperspace** integration ([page](./integrations-epic.md)) —
  the desktop agent (`tools/epic_agent.py`) is environment-agnostic. Adding
  a Foundation Hosted environment is a matter of:
  1. Adding a new environment id (e.g. `FH`) to the activity-cache key list
     alongside `SUP`/`POC`/`TST` (`server/seed-data.ts` activity loaders).
  2. Calling `epic activities FH` to discover its activities via the vision
     scan.
  3. Then `epic launch FH <name>` / `epic go FH <screen>` work identically.
- The **Citrix workspace launcher** ([page](./integrations-citrix.md)) — if
  Foundation Hosted is published as an additional Citrix app (e.g.
  `FH Hyperdrive`), it shows up automatically in `cwp` discovery and can be
  added to the `citrix workspace` boot fan-out by listing it in the launcher
  set.
- The **Galaxy KB** scraper ([page](./integrations-galaxy.md)) — Galaxy
  documentation is keyed by article URL, not by environment, so any
  documentation lookups for Foundation Hosted workflows already flow into
  the same KB.

## What a future first-class Foundation Hosted module would add

If/when the user wants Foundation Hosted to be a peer of SUP/POC/TST in the
Tree view and CLI, the minimal change set is:

1. Extend the environment enum (presently three values) wherever it is
   referenced — most callers in `server/cli-engine.ts` (`epic activities
   <env>`) and `server/routes.ts` (`/api/epic/activities/:env`) accept an
   arbitrary string already, so the change is mostly UI labels.
2. Add `epic_activities_fh` to the seeded `agent_config` keys and surface
   it in the Tree view's EPIC > Activities grouping
   (`client/src/components/views/TreeView.tsx`).
3. Add Foundation Hosted to the `citrix workspace` launcher set so the
   morning `boot` chain opens it alongside the existing apps.
4. Optionally add a `pulse`-style intranet directory for FH-specific
   policies if those live on a separate intranet host.

Tracking issue: not filed. If the user wants this scoped as a project
task, the closest neighbor is the existing Epic integration work in
[integrations-epic.md](./integrations-epic.md) — re-using all of that
infrastructure makes the work small.
