# Control bus & permissions

Source: [`server/control-bus.ts`](../../server/control-bus.ts) (~439 lines)

Rachael runs as a **shared-control system** — both the human and the agent
can drive. The control bus is the single source of truth for "who has the
wheel right now" and what each side is allowed to do.

## Concepts

- **Control mode** — `human` or `agent`. Toggled from the Cockpit view, or
  via `POST /api/control/toggle`. The agent runtime checks this before
  executing potentially user-visible actions.
- **Permission level** per action: `autonomous` | `approval` | `blocked`.
  Stored on `navigation_paths.permissionLevel` and overridable per action
  in `action_permissions`.
- **Takeover point** — A pause emitted when an `approval` action is hit, or
  when a high-risk replay is requested. Includes context for the human to
  decide.
- **Activity stream** — In-memory event log surfaced over SSE
  (`GET /api/cockpit/events`).
- **Audit log** — Persisted to the `audit_log` Postgres table.
- **Paused executions** — When a takeover happens mid-flow the program's
  resume callback is parked here and the human's approval triggers `onResume`.

## Public API (used by routes & runtime)

| Function | Use |
|----------|-----|
| `getControlState()` / `getControlMode()` | Read mode + flags |
| `toggleControlMode()` / `setControlMode(mode)` | Set the wheel |
| `getActivityStream()` | Recent events for the cockpit |
| `getPendingTakeoverPoints()` / `resolveTakeoverPoint(id, decision)` | Approve/reject UI |
| `recordAction(actor, action, target, …)` | Append to audit log |
| `checkPermission(navPathId, actionName)` | Returns the effective level |
| `createTakeoverPoint(reason, context)` | Pause and surface a decision |
| `enqueueCommand(cmd)` / `dequeueCommand()` / `completeCommand(id, result)` | Internal command queue between agent and runtime |
| `setActionPermission(navPathId, actionName, level)` / `getActionPermissions(navPathId)` | Per-action overrides |
| `getPausedExecutions()` / `removePausedExecution(id)` / `clearPausedExecutions()` / `onResume(id, cb)` | Pause/resume lifecycle |

## Cockpit view

`client/src/components/views/CockpitView.tsx` (623 lines) shows the
activity stream, the audit log, and the permission editor. `Tab` toggles
control mode. The view subscribes to `/api/cockpit/events` over SSE — that
endpoint is in the auth-bypass list (read-only stream); the writes still
require the API key.

## Auto-start defaults

On boot the runtime sets:

- `runtime_active = true`
- `control_mode = "agent"`

So the agent is "driving" out of the gate. The human can take over from the
cockpit or by issuing any CLI command (which records as actor `human`).

## Takeover flow

1. Agent program calls a navigation path that has `permissionLevel = approval`.
2. `checkPermission()` returns `approval` → runtime calls
   `createTakeoverPoint(reason, context)` and parks the resume callback in
   `pausedExecutions`.
3. Cockpit shows the new takeover point; the human resolves it.
4. `resolveTakeoverPoint` triggers the parked `onResume(id, cb)` and the
   program continues.

If the level is `blocked`, the action is refused and audit-logged.

## Transport boundary (planned)

The control bus is **in-process today** — it lives entirely inside the
Express server and the agent runtime polls it. The
[CU work](./computer-use.md) generalizes this:

- The same `enqueueCommand` / `dequeueCommand` shape becomes one
  *transport* for the cu-core bus.
- A WSS transport is added by the
  [LilyGo keyboard](./integrations-lilygo-keyboard.md) work
  (`/ws/keyboard`) so paired devices can ack takeover prompts.
- Another WSS transport is added by the
  [iOS adapter](./integrations-ios.md) (`/ws/wda`) for the
  WebDriverAgent bridge running on the Mac host.
- A queue+APNs transport is added for the iOS Shortcuts adapter.

All transports speak the same cu-core message shape, so the existing
takeover / pause / resume machinery applies uniformly.

## Takeover-from-any-step (planned)

The [analyst trajectory inspector](./cu-inspector.md) exposes a "take
over from this step" action that pauses the trajectory mid-flight.
Implementation reuses the parked-resume-callback pattern documented
above — the inspector calls `createTakeoverPoint(reason, context)` with
a `stepId` in `context`, and `resolveTakeoverPoint` triggers the
parked `onResume` to either branch (edit-and-resume) or hand the
remainder to the human.
