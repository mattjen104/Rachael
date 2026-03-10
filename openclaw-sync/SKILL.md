---
description: Sync OpenClaw configuration with OrgCloud — upload, download, propose changes, and run autonomous programs
version: 1.0.0
emoji: 🔄
metadata:
  openclaw:
    requires:
      env:
        - ORGCLOUD_URL
      bins:
        - curl
    primaryEnv: ORGCLOUD_URL
---

# OpenClaw Sync

Synchronize your local OpenClaw instance with OrgCloud. This skill handles uploading your local configuration, pulling updates, proposing self-modifications (with user approval), and executing autonomous programs.

## Setup

1. Set the `ORGCLOUD_URL` environment variable to your OrgCloud instance URL (e.g. `https://your-orgcloud.replit.app`)
2. Copy this skill folder to `~/.openclaw/skills/openclaw-sync/`

## Triggers

### Upload Config (Initial Bootstrap)

**Trigger phrases:** "upload config", "export to orgcloud", "push config"

Steps:

1. Read `SOUL.md` from the local OpenClaw config directory (`~/.openclaw/SOUL.md` or the project root)
2. Read all skill files: scan `~/.openclaw/skills/*/SKILL.md` and collect each as `{ name: <folder-name>, content: <file-contents> }`
3. Read `openclaw.json` from the local config directory and parse it as JSON
4. POST to `$ORGCLOUD_URL/api/openclaw/import` with body:
   ```json
   {
     "soul": "<contents of SOUL.md>",
     "skills": [
       { "name": "skill-name", "content": "<contents of SKILL.md>" }
     ],
     "config": { ... }
   }
   ```
5. Report success or failure to the user. The response contains the generated org-mode representation of their configuration.

### Sync Config (Ongoing Updates)

**Trigger phrases:** "sync config", "update yourself", "pull latest"

Steps:

1. Fetch compiled config from `GET $ORGCLOUD_URL/api/openclaw/compiled`
2. The response contains `{ soul, skills, config, programs, errors }`
3. Write `soul` to `~/.openclaw/SOUL.md`
4. For each skill in `skills`, write `content` to `~/.openclaw/skills/<name>/SKILL.md` (create directory if needed)
5. Write `config` as JSON to `~/.openclaw/openclaw.json`
6. Report sync status via `POST $ORGCLOUD_URL/api/openclaw/sync-report` with body:
   ```json
   {
     "status": "success",
     "timestamp": "<ISO 8601 timestamp>",
     "skillCount": <number>,
     "programCount": <number>
   }
   ```
7. If `errors` array is non-empty, warn the user about compilation issues

### Run Program (Autoresearch)

**Trigger phrases:** "run program <name>", "start research", "execute program <name>"

Steps:

1. Fetch the program descriptor from `GET $ORGCLOUD_URL/api/openclaw/program/<name>`
2. The response contains `{ name, status, active, schedule, instructions, results, properties }`
3. If `active` is false (status is DONE), inform the user the program is paused
4. Read the `instructions` field — this is your task description
5. Execute the instructions in a loop. For each iteration:
   a. Perform the work described in the instructions
   b. Record the result (iteration number, what changed, metric value, status)
   c. POST the result to `POST $ORGCLOUD_URL/api/openclaw/program/<name>/result` with body:
      ```json
      {
        "row": "| <iteration> | <change-description> | <metric-value> | <status> |"
      }
      ```
   d. Check the metric specified in `properties.METRIC` against `properties.DIRECTION` (lower = minimize, higher = maximize)
   e. If improved, commit changes; if not, revert
   f. Continue to next iteration unless the program schedule is "once"
6. For "once" programs, mark complete after a single iteration
7. For "continuous" programs, keep iterating until explicitly stopped
8. NEVER STOP on continuous programs. Think harder if stuck.

### Propose Changes (Self-Modification with Approval)

**Trigger phrases:** "propose <change>", "suggest improvement", "self-improve"

**IMPORTANT:** NEVER directly modify your own configuration files. Always go through the proposal system.

Steps:

1. Determine which section the change affects: "soul", "skills", "config", or "programs"
2. If targeting a specific skill or program, note its name as `targetName`
3. Write a clear `reason` explaining why this change would be beneficial
4. Write the `proposedContent` — the new content for that section or target
5. POST to `$ORGCLOUD_URL/api/openclaw/propose` with body:
   ```json
   {
     "section": "soul|skills|config|programs",
     "targetName": "optional-name",
     "reason": "Why this change improves the configuration",
     "proposedContent": "The new content for this section"
   }
   ```
6. Inform the user: "I've submitted a proposal to update [section]. You can review and approve it in the [claw] tab of OrgCloud."
7. Do NOT assume the change will be accepted. Do NOT apply changes locally until the user syncs after approval.

### Check Programs

**Trigger phrases:** "check programs", "what should I work on", "list programs", "show active programs"

Steps:

1. Fetch active programs from `GET $ORGCLOUD_URL/api/openclaw/programs`
2. List each program with its status, schedule, and metric:
   ```
   [●] program-name (TODO) — scheduled: <cron/once/continuous>
       metric: <METRIC> (direction: <DIRECTION>)
       last result: <most recent result row if available>

   [○] paused-program (DONE) — not running
   ```
3. If there are active programs with pending work, suggest which one to run next based on schedule

### Check Status

**Trigger phrases:** "orgcloud status", "sync status", "check orgcloud"

Steps:

1. Fetch status from `GET $ORGCLOUD_URL/api/openclaw/status`
2. Display:
   ```
   OrgCloud Status:
     Compile: <ok/errors>
     Skills: <count>
     Programs: <count> (<active> active)
     Pending proposals: <count>
     Last sync: <timestamp or "never">
   ```

## Error Handling

- If `ORGCLOUD_URL` is not set, ask the user to configure it: "Please set the ORGCLOUD_URL environment variable to your OrgCloud instance URL"
- If any API call returns a non-200 status, report the error and suggest checking the OrgCloud instance
- If compilation errors are present in any response, warn the user and list the errors
- Network failures should be retried once before reporting failure

## Security Notes

- All proposals require user approval before taking effect — this is by design
- The sync skill should never bypass the proposal system for structural changes
- Appending results to program result tables is the only auto-allowed write operation
- Never expose API keys or sensitive configuration in proposals or result logs
