# JSON Envelope

The bridge accepts and emits a small, stable envelope so the server and the
phone can evolve independently.

## Server → Phone (queued action)

```json
{
  "id": 123,
  "action": "send-imessage",
  "args": { "recipient": "Mom", "body": "Running 10 min late" },
  "createdAt": "2026-05-03T10:30:00Z",
  "ttlSeconds": 300
}
```

The bridge looks at `action`, dispatches to the matching helper Shortcut,
collects the helper's "Result" output, and posts it back.

## Phone → Server (result)

```json
{
  "id": 123,
  "status": "completed",
  "result": { "messageId": "iMessage-...", "deliveredAt": "..." },
  "error": null
}
```

`status` is one of `completed`, `failed`, `skipped`. On `failed`, populate
`error` with a one-line user-friendly string (the bridge passes through the
Shortcut's failure message).

## Auth

Every request from the phone uses an `X-Device-Token` header containing the
long-lived token issued at pairing time. The server hashes the token at rest
(see `pairedDevices.tokenHash`).
