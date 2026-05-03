# snow-shift-brief

[← Back to index](./README.md)

- **Type:** meta
- **Schedule:** weekdays (`30 13 * * 1-5`)
- **Enabled:** yes
- **Cost tier:** cheap
- **Tags:** program, meta, digest, snow
- **Last successful run:** 2026-04-01 16:16Z

## Description

ServiceNow shift brief. Pulls open incidents, changes, requests, and group queue items via the existing ServiceNow navigation paths (list-my-incidents, list-my-changes, list-my-requests, list-group-queue), then synthesizes an SLA-aware shift briefing. Runs at 6:30 AM PT weekdays.

## Health (last 35 days)

- ✅ Successful runs: **3**
- ❌ Errored runs: **17**
- Total runs in window: 20

Top error patterns:
- `Error: column "subject" does not exist` × 17

## Successful runs (newest first)

<a id="run-298"></a>
### 2026-04-01 16:16Z — run #298

model: `inline-code` · tokens: 0 · metric: 0

**Summary:**

```
=== SNOW SHIFT BRIEF ===
```

<details><summary>Raw output</summary>

```
=== SNOW SHIFT BRIEF ===
Generated: 2026-04-01T16:16:37.973Z
HTML: http://localhost:5000/briefings/snow-2026-04-01.html
Notify: ntfy error: 400
Live fetches: 0/4 nav paths

## SLA Risk  
No SLA breaches detected at this time.  

## Overnight Activity  
No overnight activity detected.  

## Today's Actions  
No data available.
```

</details>

<a id="run-284"></a>
### 2026-03-31 17:42Z — run #284

model: `inline-code` · tokens: 0 · metric: 0

**Summary:**

```
=== SNOW SHIFT BRIEF ===
```

<details><summary>Raw output</summary>

```
=== SNOW SHIFT BRIEF ===
Generated: 2026-03-31T17:42:54.788Z
HTML: http://localhost:5000/briefings/snow-2026-03-31.html
Notify: ntfy error: 400
Live fetches: 0/4 nav paths

## SLA Risk  
No SLA breaches or risks detected at this time.  

## Overnight Activity  
No overnight activity detected.  

## Today's Actions  
No data available.
```

</details>

<a id="run-267"></a>
### 2026-03-31 01:58Z — run #267

model: `inline-code` · tokens: 0 · metric: 0

**Summary:**

```
=== SNOW SHIFT BRIEF ===
```

<details><summary>Raw output</summary>

```
=== SNOW SHIFT BRIEF ===
Generated: 2026-03-31T01:58:23.383Z
HTML: http://localhost:5000/briefings/snow-2026-03-31.html
Notify: ntfy error: 400
Live fetches: 0/4 nav paths

``​`markdown
## SLA Risk  
No tickets currently at SLA risk.  

## Overnight Activity  
No overnight activity detected.  

## Today's Actions  
1. Review and prioritize group queue assignments (check `assignment_group!=NULL`).  
2. Validate pending change requests (filter: `assigned_to=me^active=true`).  
3. Address any high-priority incidents from `list-my-incidents`.  
4. Follow up on open request items (`sc_req_item_list.do?assigned_to=me`).  
5. Confirm no unresolved overnight errors (e.g., URL parsing issues in reports).  
``​`  

*Note: Replace `{baseUrl}` and `javascript:gs.getUserID()` with actual values in queries.*
```

</details>
