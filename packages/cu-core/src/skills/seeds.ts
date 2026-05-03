import type { StoredRecipe } from "./types";

// ---------------------------------------------------------------------------
// Seed recipes — 8 hand-authored skills covering the surfaces Rachael
// already has adapters for. They land with status="approved" so they're
// available immediately; the human can demote any of them via the Evolution
// panel. Surface-specific verifiers stay light (the host's surface adapters
// will refuse to act when the screen state doesn't match anyway).
// ---------------------------------------------------------------------------

const HOUR_AGO = Date.now() - 1000;

function seed(
  id: string,
  recipe: StoredRecipe["recipe"],
  origin: StoredRecipe["origin"] = "seed",
): StoredRecipe {
  return {
    id,
    version: 1,
    status: "approved",
    origin,
    recipe,
    successCount: 0,
    runCount: 0,
    successRate: 0,
    createdAt: HOUR_AGO,
    updatedAt: HOUR_AGO,
  };
}

export const SEED_RECIPES: StoredRecipe[] = [
  seed("epic-patient-search", {
    name: "Epic: open patient by MRN",
    description: "Open a patient chart in Epic Hyperspace by MRN.",
    surfaceKind: "desktop-window",
    parameters: { mrn: { type: "string", required: true, description: "Medical record number" } },
    steps: [
      { action: { verb: "Key", chord: "Ctrl+Shift+P" } },
      { action: { verb: "Type", text: "{{mrn}}", clearFirst: true } },
      { action: { verb: "Key", chord: "Enter" }, post: { kind: "expectText", text: "Patient" } },
    ],
    successCriteria: [{ kind: "expectText", text: "Chart" }],
  }),

  seed("epic-flowsheet-nav", {
    name: "Epic: navigate to flowsheet",
    description: "Open the Flowsheets activity for the active patient.",
    surfaceKind: "desktop-window",
    parameters: {},
    steps: [
      { action: { verb: "Hint", hint: "Activities menu" } },
      { action: { verb: "Hint", hint: "Flowsheets", value: "select" }, post: { kind: "expectText", text: "Flowsheet" } },
    ],
  }),

  seed("epic-galaxy-fetch", {
    name: "Galaxy: fetch knowledge article",
    description: "Look up an Epic Galaxy article by title and capture the body text.",
    surfaceKind: "browser-tab",
    parameters: { query: { type: "string", required: true } },
    steps: [
      { action: { verb: "Goto", url: "https://galaxy.epic.com/?q={{query}}" } },
      { action: { verb: "Wait", until: "search results loaded" } },
      { action: { verb: "Click", target: { kind: "selector", css: "a.search-result:first-child" } }, post: { kind: "expectText", text: "Article" } },
    ],
  }),

  seed("outlook-send-quick-reply", {
    name: "Outlook: quick reply to selected email",
    description: "Reply to the currently selected Outlook email with a short body.",
    surfaceKind: "desktop-window",
    parameters: { body: { type: "string", required: true } },
    steps: [
      { action: { verb: "Key", chord: "Ctrl+R" } },
      { action: { verb: "Wait", ms: 500 } },
      { action: { verb: "Type", text: "{{body}}" } },
      { action: { verb: "Key", chord: "Ctrl+Enter" }, post: { kind: "expectText", text: "Sent" } },
    ],
  }),

  seed("teams-send-message", {
    name: "Teams: send chat message",
    description: "Send a message in the currently active Microsoft Teams chat.",
    surfaceKind: "desktop-window",
    parameters: { message: { type: "string", required: true } },
    steps: [
      { action: { verb: "Hint", hint: "Type a new message" } },
      { action: { verb: "Type", text: "{{message}}" } },
      { action: { verb: "Key", chord: "Enter" } },
    ],
  }),

  seed("snow-open-ticket", {
    name: "ServiceNow: open ticket by number",
    description: "Open a ServiceNow incident or request by its INC/REQ number.",
    surfaceKind: "browser-tab",
    parameters: { ticket: { type: "string", required: true } },
    steps: [
      { action: { verb: "Goto", url: "https://servicenow/nav_to.do?uri=task.do?sysparm_query=number={{ticket}}" } },
      { action: { verb: "Wait", until: "ticket form visible" }, post: { kind: "expectText", text: "{{ticket}}" } },
    ],
  }),

  seed("snow-create-incident", {
    name: "ServiceNow: create incident from short description",
    description: "Create a new ServiceNow incident with a short description and category.",
    surfaceKind: "browser-tab",
    parameters: {
      shortDescription: { type: "string", required: true },
      category: { type: "string", required: false },
    },
    steps: [
      { action: { verb: "Goto", url: "https://servicenow/incident.do?sys_id=-1" } },
      { action: { verb: "Hint", hint: "Short description field" } },
      { action: { verb: "Type", text: "{{shortDescription}}" } },
      { action: { verb: "Key", chord: "Ctrl+S" }, post: { kind: "expectText", text: "INC" } },
    ],
  }),

  seed("browser-open-url", {
    name: "Browser: open URL",
    description: "Navigate the active browser tab to the supplied URL.",
    surfaceKind: "browser-tab",
    parameters: { url: { type: "string", required: true } },
    steps: [
      { action: { verb: "Goto", url: "{{url}}" }, post: { kind: "expectUrl", url: "{{url}}", match: "contains" } },
    ],
  }),
];
