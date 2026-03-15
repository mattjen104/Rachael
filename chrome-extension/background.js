chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

let pendingContext = null;

async function getPageContext(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const context = { url: tab.url || "", title: tab.title || "", selection: "" };

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => window.getSelection()?.toString() || "",
      });
      if (results && results[0]) {
        context.selection = results[0].result || "";
      }
    } catch (e) {}

    return context;
  } catch (e) {
    return null;
  }
}

chrome.action.onClicked.addListener(async (tab) => {
  const context = await getPageContext(tab.id);
  pendingContext = context || { url: "", title: "", selection: "" };
  await chrome.sidePanel.open({ tabId: tab.id });
  try {
    await chrome.runtime.sendMessage({
      action: "trigger-capture",
      context: pendingContext,
    });
    pendingContext = null;
  } catch (e) {}
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "sidepanel-ready") {
    if (pendingContext) {
      sendResponse({ action: "trigger-capture", context: pendingContext });
      pendingContext = null;
    } else {
      sendResponse(null);
    }
  }
  if (message.action === "get-bridge-status") {
    sendResponse({ running: bridgeRunning, lastPoll: bridgeLastPoll, jobsCompleted: bridgeJobsCompleted, error: bridgeLastError });
  }
});

let bridgeRunning = false;
let bridgeLastPoll = null;
let bridgeJobsCompleted = 0;
let bridgeLastError = null;
const POLL_INTERVAL_MS = 5000;

async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["orgcloudUrl", "bridgeToken"], (result) => {
      resolve({ baseUrl: result.orgcloudUrl || null, token: result.bridgeToken || null });
    });
  });
}

async function getOrgCloudUrl() {
  const { baseUrl } = await getConfig();
  return baseUrl;
}

function bridgeHeaders(token) {
  const h = { "Content-Type": "application/json", "X-Bridge-Client": "chrome-extension" };
  if (token) h["X-Bridge-Token"] = token;
  return h;
}

async function pollForJobs() {
  const { baseUrl, token } = await getConfig();
  if (!baseUrl) return;

  try {
    const res = await fetch(`${baseUrl}/api/bridge/ext/jobs`, {
      method: "GET",
      headers: bridgeHeaders(token),
    });
    if (!res.ok) {
      if (res.status === 403) bridgeLastError = "Invalid bridge token — update in extension options";
      else if (res.status !== 404) bridgeLastError = `Poll failed: ${res.status}`;
      return;
    }
    const jobs = await res.json();
    bridgeLastPoll = new Date().toISOString();
    bridgeLastError = null;

    for (const job of jobs) {
      try {
        const result = await executeJob(job);
        await fetch(`${baseUrl}/api/bridge/ext/results`, {
          method: "POST",
          headers: bridgeHeaders(token),
          body: JSON.stringify({ jobId: job.id, ...result }),
        });
        bridgeJobsCompleted++;
      } catch (err) {
        await fetch(`${baseUrl}/api/bridge/ext/results`, {
          method: "POST",
          headers: bridgeHeaders(token),
          body: JSON.stringify({ jobId: job.id, error: err.message || String(err) }),
        }).catch(() => {});
      }
    }
  } catch (err) {
    bridgeLastError = err.message || String(err);
  }
}

async function executeJob(job) {
  const { type, url, options } = job;

  if (type === "fetch") {
    const fetchOpts = { method: "GET", credentials: "include" };
    if (options?.headers) fetchOpts.headers = options.headers;
    if (options?.method) fetchOpts.method = options.method;

    const res = await fetch(url, fetchOpts);
    const contentType = res.headers.get("content-type") || "";
    let body;
    if (contentType.includes("json")) {
      body = await res.json();
    } else {
      body = await res.text();
    }
    return {
      status: res.status,
      contentType,
      body,
      url: res.url,
    };
  }

  if (type === "dom") {
    const res = await fetch(url, { credentials: "include" });
    const html = await res.text();

    const selectors = options?.selectors || {};
    const extracted = {};

    if (Object.keys(selectors).length > 0) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");

      for (const [key, selector] of Object.entries(selectors)) {
        const els = doc.querySelectorAll(selector);
        extracted[key] = Array.from(els).map((el) => ({
          text: el.textContent?.trim().substring(0, 1000) || "",
          href: el.getAttribute("href") || undefined,
          src: el.getAttribute("src") || undefined,
        }));
      }
    }

    return {
      status: res.status,
      url: res.url,
      html: options?.includeHtml ? html.substring(0, options?.maxHtml || 50000) : undefined,
      text: html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
               .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
               .replace(/<[^>]+>/g, " ")
               .replace(/\s+/g, " ")
               .trim()
               .substring(0, options?.maxText || 15000),
      extracted,
    };
  }

  throw new Error(`Unknown job type: ${type}`);
}

function startBridge() {
  if (bridgeRunning) return;
  bridgeRunning = true;
  chrome.alarms.create("bridge-poll", { periodInMinutes: POLL_INTERVAL_MS / 60000 });
  pollForJobs();
}

function stopBridge() {
  bridgeRunning = false;
  chrome.alarms.clear("bridge-poll");
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "bridge-poll" && bridgeRunning) {
    pollForJobs();
  }
});

chrome.storage.sync.get(["orgcloudUrl"], (result) => {
  if (result.orgcloudUrl) {
    startBridge();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.orgcloudUrl) {
    if (changes.orgcloudUrl.newValue) {
      startBridge();
    } else {
      stopBridge();
    }
  }
});
