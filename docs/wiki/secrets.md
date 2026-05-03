# Secrets & magic links

Source: [`server/secrets.ts`](../../server/secrets.ts) (~286 lines)

Rachael needs to collect credentials (Epic username/password, Outlook
session cookies, etc.) without putting them in environment variables. The
secrets module provides:

## Encryption

- AES-256-GCM at rest, stored in `agent_config` rows with
  `category = "secrets"` and `key = "secret_<name>"`.
- The encryption key is **derived from `OPENCLAW_API_KEY`** ⚠ see
  [audit § Security #2](./audit.md#2-secret-encryption-key-is-derived-from-openclaw_api_key).
- IV per record, auth tag verified on read.

## Magic-link collection

To collect a credential without typing it on a TV remote or shipping it
through chat:

1. CLI: `collect-secrets <name> [--field name --field name…]`.
2. Server creates a request id, stores `{fields, expiresAt: +10min}` in
   memory.
3. CLI prints a one-time URL: `<host>/api/secrets/form/<id>`.
4. The owner opens that URL on a trusted device, fills the form, submits
   to `POST /api/secrets/submit`. The form is **public** (no auth) so it
   can be opened on a personal phone, but the id is unguessable and
   short-lived.
5. Submitted values are encrypted and stored.

## Retrieval

- `GET /api/secrets/:name` (auth required) returns the decrypted value.
- `getSecret(name)` is the in-process API used by `boot`/`epic login`/etc.
- `listSecretNames()` returns names without values.

## Audit notes

- Form submissions don't include CSRF protection — but the form id itself
  is the secret (single use, time-limited). Acceptable trade-off given the
  threat model (single-user personal app), but worth noting.
- Logging is suppressed for all `/api/secrets` routes (response bodies
  excluded from the request log middleware in `server/index.ts:101`).
