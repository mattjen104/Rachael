# Integrations — LilyGo T-Keyboard remote

> **Status: Planned** (see task task #101 (LilyGo keyboard)).
>
> No firmware, server route, or device-pairing code for the LilyGo
> T-Keyboard exists in the repo as of this wiki pass. There is no
> `/ws/keyboard` route in [`server/routes.ts`](../../server/routes.ts),
> no `devices` or `pairing_codes` table in
> [`shared/schema.ts`](../../shared/schema.ts), and no keyboard
> firmware directory. This page documents the **planned** integration so
> the CU stack pages can refer to it as a first-class device surface.

## Intent (2-3 sentences)

The LilyGo T-Keyboard is a small ESP32-based hardware keyboard with a
built-in OLED. It pairs with Rachael over WSS and acts as a remote
input device that can either chat with the agent (CHAT mode) or take
over Rachael's currently-running trajectory (RACHAEL mode). It rounds
out the [computer-use](./computer-use.md) story by adding a third
client surface alongside the web UI and the
[iOS adapter](./integrations-ios.md), with strict armed-vs-echo-only
safety semantics so a lost keyboard can't drive the agent.

## Planned dual-mode firmware

| Mode      | Semantics                                                                  |
|-----------|----------------------------------------------------------------------------|
| `CHAT`    | Keypresses become text into a chat field; OLED shows assistant reply tail. |
| `RACHAEL` | Keypresses are interpreted as Rachael minibuffer commands (`M-x`-style). When the agent is mid-trajectory, the keyboard surfaces takeover Y/N prompts on the OLED. |

A physical mode toggle (long-press a designated key) switches between
them. Mode is reflected on the OLED status line and in the audit log.

## Planned pairing flow

1. New keyboard boots into pairing mode and shows a 6-digit code on the
   OLED.
2. User opens `M-x pair-device` in the web UI (or runs `device pair`
   in the CLI).
3. User enters the code; server inserts a row in `pairing_codes`,
   matched to the keyboard's hardware id.
4. On match, server inserts a `devices` row (`type: "lilygo-keyboard"`,
   armed flag default `false`), returns a long-lived token to the
   firmware.
5. Subsequent connections use the token as `Authorization: Bearer …`
   on the WSS upgrade.

The `devices` table is shared with paired iPhones (see
[integrations-ios](./integrations-ios.md)) — see
[data-model](./data-model.md) for the planned columns.

## Planned WSS transport

Route: `wss://<host>/ws/keyboard` (planned addition to
[backend-routes](./backend-routes.md)). Two-way:

- Keyboard → server: `{type: "key", chord, mode, ts}` /
  `{type: "text", chunk}` / `{type: "ack", takeoverId, decision}`.
- Server → keyboard: `{type: "envelope", lines: string[]}` for OLED
  display, `{type: "takeover", id, prompt}` for Y/N prompts,
  `{type: "echo", text}` for chat-mode replies.

The transport rides on the same in-process [computer-use bus](./computer-use.md)
as everything else; the keyboard is just one more `Surface` whose
capability is `Action.Key` and whose observation is the OLED
back-channel.

## Planned OLED envelope schema

```ts
{
  lines: string[],          // up to N lines, each clipped to display width
  status?: "armed"|"echo",  // shown on status line
  mode?: "chat"|"rachael",
  takeover?: { id, prompt }, // when present, OLED renders Y/N inverted
}
```

A single envelope replaces the whole screen — no partial updates — so
the firmware can stay state-light.

## Planned takeover Y/N prompts

When the agent hits a takeover point ([control-bus](./control-bus.md))
and a keyboard is paired in RACHAEL mode, the server pushes a
`takeover` envelope. The user presses Y or N; the firmware sends
`{type: "ack", takeoverId, decision}`; the server calls
`resolveTakeoverPoint(id, decision)` exactly as the Cockpit view does
today.

## Planned armed-vs-echo-only safety

Each `devices` row carries an `armed` flag (default `false`). When
unarmed:

- CHAT mode still works (text echoes to the chat).
- RACHAEL mode is **echo-only** — keypresses display on OLED for
  feedback but are *not* dispatched as actions. This is the safe
  default.

Arming a keyboard requires an explicit `device arm <id>` from the web
UI or CLI, audit-logged ([audit-log table](./data-model.md)). A lost
keyboard cannot drive the agent until re-armed from a trusted client.
See [safety](./safety.md) for the full policy.

## Planned audit tagging

Every action originating from a paired device is tagged with
`actor: "device:lilygo-<id>"` in the [audit log](./control-bus.md), so
"what did the keyboard do this morning" is one query.

## Related pages

- [computer-use](./computer-use.md) — the abstraction the keyboard
  joins as a `Surface`
- [integrations-ios](./integrations-ios.md) — sister device, same
  `devices` table, same pairing flow
- [control-bus](./control-bus.md) — the takeover machinery
- [safety](./safety.md) — armed-vs-echo-only policy
- [data-model](./data-model.md) — `devices` and `pairing_codes` columns
- [backend-routes](./backend-routes.md) — `/ws/keyboard`,
  `/api/devices`, `/api/devices/pair`
