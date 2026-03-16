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

const BRIDGE_VERSION = "2.2.0";
const JOB_DELAY_MS = 1500;

function bridgeHeaders(token) {
  const h = {
    "Content-Type": "application/json",
    "X-Bridge-Client": "chrome-extension",
    "X-Bridge-Version": BRIDGE_VERSION,
    "X-Bridge-Jobs": String(bridgeJobsCompleted),
  };
  if (token) h["X-Bridge-Token"] = token;
  if (bridgeLastError) h["X-Bridge-Error"] = bridgeLastError.substring(0, 200);
  return h;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

let pollInProgress = false;

async function pollForJobs() {
  if (pollInProgress) return;
  pollInProgress = true;

  const { baseUrl, token } = await getConfig();
  if (!baseUrl) { pollInProgress = false; return; }

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

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      if (i > 0) await sleep(JOB_DELAY_MS);
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
  } finally {
    pollInProgress = false;
  }
}

async function pollForSelector(tabId, selector, maxWaitMs) {
  const interval = 1000;
  const maxAttempts = Math.ceil(maxWaitMs / interval);
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel) => document.querySelectorAll(sel).length,
        args: [selector],
      });
      const count = results?.[0]?.result || 0;
      if (count > 0) {
        await new Promise((r) => setTimeout(r, 1500));
        return;
      }
    } catch {
      return;
    }
    await new Promise((r) => setTimeout(r, interval));
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
    const selectors = options?.selectors || {};
    const hasSelectors = Object.keys(selectors).length > 0;
    const maxText = options?.maxText || 15000;
    const includeHtml = options?.includeHtml || false;
    const maxHtml = options?.maxHtml || 50000;
    const waitForSelector = hasSelectors ? Object.values(selectors)[0] : null;
    const spaWaitMs = options?.spaWaitMs || (waitForSelector ? 15000 : 2000);

    const tab = await chrome.tabs.create({ url, active: true });

    try {
      await new Promise((resolve, reject) => {
        function listener(tabId, info) {
          if (tabId === tab.id && info.status === "complete") {
            cleanup();
            if (waitForSelector) {
              pollForSelector(tab.id, waitForSelector, spaWaitMs).then(resolve).catch(resolve);
            } else {
              setTimeout(resolve, 2000);
            }
          }
        }
        function cleanup() {
          clearTimeout(timeout);
          chrome.tabs.onUpdated.removeListener(listener);
        }
        const timeout = setTimeout(() => {
          cleanup();
          resolve();
        }, 45000);
        chrome.tabs.onUpdated.addListener(listener);
      });

      const clickSelector = options?.clickSelector || null;
      const clickIndex = options?.clickIndex || 0;
      const postClickWaitMs = options?.postClickWaitMs || 3000;
      const postClickSelector = options?.postClickSelector || null;

      if (clickSelector) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: (sel, idx) => {
            const els = document.querySelectorAll(sel);
            if (els[idx]) {
              els[idx].scrollIntoView({ block: "center" });
              els[idx].click();
            }
          },
          args: [clickSelector, clickIndex],
        });
        if (postClickSelector) {
          await pollForSelector(tab.id, postClickSelector, postClickWaitMs);
        } else {
          await new Promise((r) => setTimeout(r, postClickWaitMs));
        }
      }

      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (sels, maxT, inclHtml, maxH) => {
          const extracted = {};
          for (const [key, selector] of Object.entries(sels)) {
            const els = document.querySelectorAll(selector);
            extracted[key] = Array.from(els).map((el) => ({
              text: (el.textContent || "").trim().substring(0, 1000),
              href: el.getAttribute("href") || undefined,
              ariaLabel: el.getAttribute("aria-label") || undefined,
              src: el.getAttribute("src") || undefined,
            }));
          }

          const text = document.body?.innerText?.substring(0, maxT) || "";
          const html = inclHtml ? document.documentElement.outerHTML.substring(0, maxH) : undefined;
          const iframeCount = document.querySelectorAll("iframe").length;
          const finalUrl = location.href;
          const title = document.title;
          const bodyChildCount = document.body?.children?.length || 0;

          return {
            text, html, extracted, url: finalUrl, title,
            debug: { iframeCount, bodyChildCount, textLen: text.length, extractedKeys: Object.keys(extracted) }
          };
        },
        args: [selectors, maxText, includeHtml, maxHtml],
      });

      const data = results?.[0]?.result || {};
      return {
        status: 200,
        url: data.url || url,
        text: data.text || "",
        html: data.html,
        extracted: data.extracted || {},
        debug: data.debug || {},
        title: data.title || "",
      };
    } catch (execErr) {
      return {
        status: 500,
        url,
        text: "",
        extracted: {},
        error: "Script execution failed: " + (execErr.message || String(execErr)),
      };
    } finally {
      try { await chrome.tabs.remove(tab.id); } catch {}
    }
  }

  throw new Error(`Unknown job type: ${type}`);
}

const POLL_ALARM_MINUTES = 0.5;

function startBridge() {
  if (bridgeRunning) return;
  bridgeRunning = true;
  chrome.alarms.create("bridge-poll", { periodInMinutes: POLL_ALARM_MINUTES });
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
