# Integrations — GitHub

GitHub is consumed in two places, both as a **public source** (no API token,
no auth — just HTTPS scrapes / public JSON). There is no first-class GitHub
OAuth integration in Rachael today.

## 1. `github-trending` program

Source: [`server/seed-data.ts`](../../server/seed-data.ts) ~line 810.

A standalone seeded program that scrapes
`https://github.com/trending/<lang>?since=daily` for the configured language
list and emits a daily roll-up of new repos.

- **Bridge requirement:** none in seed default — uses direct fetch with a
  realistic `Accept: text/html` header. Falls back to bridge via
  `smartFetch` if blocked.
- **Config keys** (on the program row's `config` jsonb):
  - `GITHUB_LANGS` — JSON array, default `["typescript","python","rust"]`.
  - `SINCE` — `daily` | `weekly` | `monthly`, default `daily`.
- **Output:** structured items pushed into the `agent_results` row and (via
  the standard radar consolidation) into `agent_memories`.

Trigger from the CLI: `programs run github-trending`.

## 2. GitHub as a `research-radar` source

`research-radar` (program id 3, see [agent runtime](./agent-runtime.md#research-radar-specifics))
treats GitHub as one of six sources behind a feature flag. The relevant
seed defaults (`server/seed-data.ts` ~line 188):

```js
ENABLED_SOURCES: { hn: true, github: true, lobsters: true,
                   lemmy: true, arxiv: true, reddit: true }
GITHUB_LANGS:    ["typescript","python","rust"]
```

`fetchGitHub(langs)` (`server/seed-data.ts` ~line 401) hits the trending HTML
page per language, extracts repo links, dedups with `radar_seen_items`, and
trims to the top 10 (`server/seed-data.ts` ~line 715). The radar's
self-improvement loop (engagement scoring, source-quality decay) applies to
GitHub the same as every other source.

## 3. Replit GitHub integration (workspace, not Rachael)

The Replit workspace this repo lives in has the **GitHub Replit integration**
installed (see the project snapshot). That integration is for the *workspace*
to push/pull this repo against `mattjen104/Rachael` — it is not consumed by
Rachael's runtime. No Rachael code reads a `GITHUB_TOKEN` env var.

## Authenticated GitHub usage

Not currently implemented. If/when issues, PR review, or notification feeds
become a feature, the path of least resistance is:

1. Use the Replit GitHub integration's tokens (see the
   [`integrations` skill](../../.local/skills/integrations/SKILL.md)) so the
   user doesn't have to manage another secret, **or**
2. Add a `GITHUB_TOKEN` to [secrets](./secrets.md) (encrypted at rest) and
   read via `getSecret("GITHUB_TOKEN")` from a new `github` CLI command
   group.
