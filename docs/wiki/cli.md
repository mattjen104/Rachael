# CLI engine

Source: [`server/cli-engine.ts`](../../server/cli-engine.ts) (~8893 lines — the
single largest file in the repo)

The CLI engine implements a Unix-style command interface. Both humans (via
the minibuffer's `:` mode and the `POST /api/cli/run` endpoint) and the
agent runtime invoke it.

## Chain operators

Implemented in the same engine:

| Op   | Meaning                                                      |
|------|--------------------------------------------------------------|
| `\|` | Pipe stdout of the previous command into the next.           |
| `&&` | Run the next command only if the previous succeeded.         |
| `\|\|` | Run the next command only if the previous failed.          |
| `;`  | Always run the next command.                                 |

When `&&` or `\|\|` skips a segment, downstream `\|` pipes in the same
branch are also skipped (branch suppression).

## Two output layers

- `executeChainRaw(cmd)` — returns `{stdout, stderr, exitCode}`. Used by
  pipes, recipes, and internal calls.
- `executeChain(cmd)` — wraps with presentation: truncation, footer with
  exit code + duration. Used by the UI / API.

## Cockpit events

Many CLI commands emit events to the cockpit activity stream (recipe save/
run/approve, memory store/forget, scrape). See
[control bus](./control-bus.md).

## Built-in commands (grouped)

### Data — tasks, notes, knowledge
`tasks`, `notes`, `captures`, `capture` (mail/calendar/text),
`search`, `cat`, `memory` (show/store/search/recent/forget),
`goals` (list/add/remove).

### Agent — programs, runtime, automation
`programs` (list/run/info/status), `results`, `runtime` (status/start/stop),
`recipe` (list/save/run/info/delete/toggle), `propose-recipe`,
`proposals` (list/approve/reject), `standup`, `boot`, `ask`.

### Scraping
`scrape`, `bridge`, `bridge-token`, `bridge-status`, `profiles`.

### Mail & communication
`outlook` (inbox/calendar/read/sync/search), `teams` (chats/channels), `notify`.

### Enterprise integrations
`snow` (incidents/changes/requests/detail/queue/persisted/search),
`citrix` (workspace/keepalive/launch), `cwp` (UCSD CWP browser),
`epic` (activities/launch/go/navigate/screenshot/click/scan/setup),
`pulse`, `galaxy` (search/read/context/auto/queue/kb).

### System
`help`, `config` (get/set), `budget` (status/models/set), `skills`,
`nav` (UIA navigation), `record` (WASAPI loopback recording).

### Unix-style text utilities
`grep`, `head`, `tail`, `wc`, `sort`, `uniq`, `echo`.

### Self-hosted only
`sh` — shell exec, only enabled when `RACHAEL_SELF_HOSTED=true`. Wraps
`server/local-compute.ts` (`/bin/bash -c`). ⚠ See
[audit § Security #4](./audit.md#4-rachael_self_hosted-shell-exec).

## Recipes (CLI command chains)

- `recipe save <name> "<command>"`
- `recipe run <name>`
- `recipe list | info | delete | toggle`
- `recipe save … --schedule <…>` registers a cron — handled by `tickRecipes`
  in `agent-runtime.ts`.
- Stored in the `recipes` table.

## Agent-authored recipes

Programs can emit:

```
RECIPE: <name> "<command>" [--schedule <sched>] [--desc <desc>]
```

The runtime parses these and creates an `openclaw_proposals` row in section
`RECIPES`. Approving the proposal creates the recipe.

`propose-recipe <name> "<command>"` is the manual equivalent.

## API

- `POST /api/cli/run` — `{command}` → executes via `executeChain`.
- `GET /api/cli/help`, `GET /api/cli/commands`.
- `GET /api/budget`, `GET /api/models`.

## Smart capture variants used from CLI

The capture commands (`capture mail …`, `capture calendar`, `capture text`)
write into the `notes` table tagged by source (`email`, `outlook`,
`calendar`). Press `c` in TreeView selects-and-captures.

## Notification

`notify <message>` (or `<command> | notify`) pushes via:

- `notify_channel` agent_config → ntfy.sh
- `notify_webhook` → POSTs JSON to a generic URL
- See [integrations-notify](./integrations-notify.md).
