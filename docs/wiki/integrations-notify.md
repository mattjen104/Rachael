# Integrations — Notifications

Implemented in [`server/cli-engine.ts`](../../server/cli-engine.ts) (`notify`
command).

## Channels

| Channel | Config key            | Notes                                              |
|---------|-----------------------|----------------------------------------------------|
| ntfy.sh | `notify_channel`      | Free, no account. Subscribe via the ntfy app.      |
| Webhook | `notify_webhook`      | Generic JSON POST.                                 |
| Email   | `NTFY_EMAIL` env var  | ntfy.sh's email forwarding hook.                   |

## Usage

```
notify "hello"                  # plain message
standup | notify                # pipe a command's output as the body
notify --title "alert" "boom"   # with title
```

## Env vars

- `NTFY_CHANNEL` — default channel (also a config key).
- `NTFY_EMAIL` — receives the message via ntfy email forwarding.

## Briefing emails

The morning `standup` and the `overnight-digest` programs both end with
`| notify`. The notification body includes a truncated TLDR + a `Click`
link to the full HTML brief at `/briefings/<file>.html`.
