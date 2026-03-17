chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

let pendingContext = null;
let lastClickDebug = null;

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
        console.log(`[bridge] executing job ${job.id}: ${job.type} ${job.url} opts=${JSON.stringify(job.options || {})}`);
        const result = await executeJob(job);
        console.log(`[bridge] job ${job.id} complete, status=${result.status}, error=${result.error || "none"}`);
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
      /* tab may be navigating or on cross-origin page — keep polling */
    }
    await new Promise((r) => setTimeout(r, interval));
  }
}

async function findExistingTab(urlPattern) {
  const tabs = await chrome.tabs.query({});
  return tabs.find(t => t.url && t.url.includes(urlPattern)) || null;
}

async function pollForTextMatch(tabId, selector, matchText, maxWaitMs) {
  const interval = 1500;
  const maxAttempts = Math.ceil(maxWaitMs / interval);
  const lower = matchText.toLowerCase();
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (sel, txt) => {
          const els = Array.from(document.querySelectorAll(sel));
          return els.some(el => {
            const t = (el.textContent || "").trim().toLowerCase();
            return t === txt || t.includes(txt);
          });
        },
        args: [selector, lower],
      });
      if (results?.[0]?.result) return true;
    } catch {
      /* tab may be on SSO redirect page — keep polling */
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return false;
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

    const clickSelector = options?.clickSelector || null;
    const clickIndex = options?.clickIndex || 0;
    const clickMatchText = options?.clickMatchText || null;
    const postClickWaitMs = options?.postClickWaitMs || 3000;
    const postClickSelector = options?.postClickSelector || null;
    const reuseTab = options?.reuseTab || false;

    let tab = null;
    let tabReused = false;

    if (reuseTab) {
      const hostname = new URL(url).hostname;
      tab = await findExistingTab(hostname);
    }

    if (tab) {
      tabReused = true;
      await chrome.tabs.update(tab.id, { active: true });
      console.log(`[bridge] reused existing tab ${tab.id} for ${url}`);
      await new Promise((r) => setTimeout(r, 2000));
    } else {
      tab = await chrome.tabs.create({ url, active: true });
    }

    try {
      if (!tabReused) {
        await new Promise((resolve, reject) => {
          function listener(tabId, info) {
            if (tabId === tab.id && info.status === "complete") {
              cleanup();
              if (waitForSelector) {
                pollForSelector(tab.id, waitForSelector, spaWaitMs).then(resolve).catch(resolve);
              } else {
                setTimeout(resolve, spaWaitMs);
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
      }

      if (clickSelector && clickMatchText) {
        const pollTimeout = options?.pollTimeoutMs || 15000;
        console.log(`[bridge] polling for text "${clickMatchText}" with selector "${clickSelector}" (timeout=${pollTimeout}ms)`);
        const found = await pollForTextMatch(tab.id, clickSelector, clickMatchText, pollTimeout);
        console.log(`[bridge] pollForTextMatch result: ${found}`);
      }

      if (clickSelector) {
        const autoOpenDownload = options?.autoOpenDownload || false;
        let downloadWatcher = null;

        if (autoOpenDownload) {
          downloadWatcher = new Promise((resolve) => {
            const timeout = setTimeout(() => {
              console.log("[bridge] download watcher timed out (30s)");
              chrome.downloads.onChanged.removeListener(onChanged);
              resolve(false);
            }, 30000);

            function onChanged(delta) {
              if (delta.state && delta.state.current === "complete") {
                chrome.downloads.search({ id: delta.id }, (items) => {
                  if (items && items.length > 0) {
                    const fn = items[0].filename || "";
                    console.log(`[bridge] download complete: ${fn}`);
                    if (fn.endsWith(".ica") || fn.endsWith(".ICA")) {
                      clearTimeout(timeout);
                      chrome.downloads.onChanged.removeListener(onChanged);
                      chrome.downloads.open(delta.id);
                      console.log("[bridge] opened ICA file");
                      resolve(true);
                    }
                  }
                });
              }
            }
            chrome.downloads.onChanged.addListener(onChanged);
          });
        }

        console.log(`[bridge] executing click script for selector="${clickSelector}" matchText="${clickMatchText}"`);
        const clickResults = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: async (sel, idx, matchText) => {
            const debugInfo = {
              pageUrl: location.href,
              pageTitle: document.title,
              strategy: "none",
              matched: false,
              matchedTag: "",
              matchedText: "",
              matchedClass: "",
              matchedId: "",
              ancestorChain: "",
              allAppTexts: [],
            };

            function robustClick(el) {
              el.scrollIntoView({ block: "center" });
              el.focus();
              el.click();
              const rect = el.getBoundingClientRect();
              const cx = rect.left + rect.width / 2;
              const cy = rect.top + rect.height / 2;
              ["pointerdown", "mousedown", "pointerup", "mouseup", "click", "dblclick"].forEach(evtType => {
                const Ctor = evtType.startsWith("pointer") ? PointerEvent : MouseEvent;
                el.dispatchEvent(new Ctor(evtType, {
                  bubbles: true, cancelable: true, view: window,
                  clientX: cx, clientY: cy, button: 0,
                }));
              });
              if (el.tagName === "A" && el.href) {
                debugInfo.linkHref = el.href;
              }
            }

            function findByWalkingDOM(searchText) {
              const lower = searchText.toLowerCase();
              const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
              let node;
              while ((node = walker.nextNode())) {
                const t = (node.textContent || "").trim().toLowerCase();
                if (t === lower || (t.length < lower.length * 3 && t.includes(lower))) {
                  let el = node.parentElement;
                  const chain = [];
                  while (el && el !== document.body) {
                    chain.push(el.tagName + (el.className ? "." + el.className.toString().split(" ")[0] : ""));
                    const tag = el.tagName;
                    if (tag === "A" || tag === "BUTTON" ||
                        el.getAttribute("role") === "button" ||
                        el.getAttribute("role") === "listitem" ||
                        el.onclick || el.hasAttribute("onclick") ||
                        el.getAttribute("tabindex") !== null ||
                        (el.className && /app|resource|tile|store|launch/i.test(el.className.toString()))) {
                      debugInfo.ancestorChain = chain.join(" > ");
                      return el;
                    }
                    el = el.parentElement;
                  }
                  if (node.parentElement) {
                    debugInfo.ancestorChain = chain.join(" > ");
                    return node.parentElement;
                  }
                }
              }
              return null;
            }

            const lower = (matchText || "").toLowerCase();
            const allEls = Array.from(document.querySelectorAll(sel));
            debugInfo.allAppTexts = allEls.slice(0, 15).map(el => ({
              tag: el.tagName,
              text: (el.textContent || "").trim().substring(0, 60),
              cls: (el.className?.toString?.() || "").substring(0, 40),
              id: el.id || "",
            }));

            let target = null;

            if (matchText) {
              target = findByWalkingDOM(matchText);
              if (target) {
                debugInfo.strategy = "dom-walk";
              }
            }

            if (!target && matchText) {
              target = allEls.find(el => {
                const t = (el.textContent || "").trim().toLowerCase();
                return t === lower || t.includes(lower);
              });
              if (target) debugInfo.strategy = "selector-exact";
            }

            if (!target && matchText) {
              target = allEls.find(el => {
                const t = (el.textContent || "").trim().toLowerCase();
                return t.split(/\s+/).some(w => lower.split(/\s+/).some(lw => w.includes(lw)));
              });
              if (target) debugInfo.strategy = "selector-fuzzy";
            }

            if (!target) target = allEls[idx] || null;
            if (target && !debugInfo.strategy) debugInfo.strategy = "selector-index";

            if (target) {
              debugInfo.matched = true;
              debugInfo.matchedTag = target.tagName;
              debugInfo.matchedText = (target.textContent || "").trim().substring(0, 100);
              debugInfo.matchedClass = target.className?.toString?.()?.substring(0, 80) || "";
              debugInfo.matchedId = target.id || "";

              const allDataAttrs = {};
              if (target.dataset) {
                for (const k of Object.keys(target.dataset)) {
                  allDataAttrs[k] = (target.dataset[k] || "").substring(0, 100);
                }
              }
              debugInfo.dataAttrs = allDataAttrs;

              let launchUrl = "";
              let el = target;
              while (el && el !== document.body) {
                if (el.tagName === "A" && el.href && el.href !== "#" && !el.href.endsWith("#")) {
                  launchUrl = el.href;
                  break;
                }
                if (el.dataset) {
                  for (const k of Object.keys(el.dataset)) {
                    const v = el.dataset[k] || "";
                    if (/launch|ica|resource|url/i.test(k) && v) {
                      debugInfo.dataLaunchAttr = `${k}=${v}`;
                    }
                  }
                }
                el = el.parentElement;
              }
              debugInfo.launchUrl = launchUrl;

              const appTile = target.closest(".storeapp, [class*='app-tile'], [class*='resource-tile'], li") || target;
              robustClick(appTile);
              debugInfo.clickedTile = appTile.tagName + "." + (appTile.className?.toString?.()?.split(" ")[0] || "");

              await new Promise(r => setTimeout(r, 1500));

              const openBtnSelectors = [
                "button.storeapp-open", "button.storeapp-launch",
                "[class*='open']", "[class*='launch']", "[class*='Open']", "[class*='Launch']",
                "button[id*='open']", "button[id*='launch']",
                "a.storeapp-open", "a.storeapp-launch",
              ];
              let openBtn = null;
              for (const s of openBtnSelectors) {
                const candidates = document.querySelectorAll(s);
                for (const c of candidates) {
                  const t = (c.textContent || "").trim().toLowerCase();
                  if (t === "open" || t === "launch" || t === "start" || t === "connect") {
                    openBtn = c;
                    break;
                  }
                }
                if (openBtn) break;
              }
              if (!openBtn) {
                const allBtns = document.querySelectorAll("button, a[role='button'], input[type='button'], [role='button']");
                for (const b of allBtns) {
                  const t = (b.textContent || "").trim().toLowerCase();
                  if (t === "open" || t === "launch" || t === "start" || t === "connect") {
                    openBtn = b;
                    break;
                  }
                }
              }
              if (!openBtn) {
                const allEls2 = document.querySelectorAll("a, button, span, div");
                for (const e of allEls2) {
                  const t = (e.textContent || "").trim().toLowerCase();
                  if (t === "open" && (e.tagName === "A" || e.tagName === "BUTTON" || e.onclick || e.hasAttribute("onclick") || e.getAttribute("tabindex") !== null)) {
                    openBtn = e;
                    break;
                  }
                }
              }

              if (openBtn) {
                debugInfo.openBtnFound = true;
                debugInfo.openBtnTag = openBtn.tagName;
                debugInfo.openBtnClass = openBtn.className?.toString?.()?.substring(0, 80) || "";
                debugInfo.openBtnText = (openBtn.textContent || "").trim().substring(0, 30);
                robustClick(openBtn);
              } else {
                debugInfo.openBtnFound = false;
                const visibleBtns = Array.from(document.querySelectorAll("button, a[role='button'], [role='button']")).slice(0, 10).map(b => ({
                  tag: b.tagName, text: (b.textContent || "").trim().substring(0, 40), cls: (b.className?.toString?.() || "").substring(0, 40)
                }));
                debugInfo.visibleButtons = visibleBtns;
              }

              if (launchUrl && launchUrl.startsWith("http") && !openBtn) {
                debugInfo.navigatedToLaunchUrl = true;
                window.open(launchUrl, "_self");
              }
            }
            return debugInfo;
          },
          args: [clickSelector, clickIndex, clickMatchText],
        });

        const clickDebug = clickResults?.[0]?.result || {};
        console.log("[bridge] click result:", JSON.stringify(clickDebug, null, 2));
        lastClickDebug = clickDebug;

        if (downloadWatcher) {
          await downloadWatcher;
        } else if (postClickSelector) {
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
        clickDebug: lastClickDebug || undefined,
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
      const keepOpen = options?.autoOpenDownload || options?.reuseTab;
      if (!keepOpen) {
        try { await chrome.tabs.remove(tab.id); } catch {}
      }
    }
  }

  if (type === "audio") {
    return {
      status: 200,
      url,
      message: "Audio jobs are handled via the /api/bridge/ext/audio endpoint directly by the offscreen document, not through the job queue.",
    };
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

let recordingState = { active: false, sessionId: null, tabId: null, recordingType: null, uploading: false, done: false, tabTitle: null, tabUrl: null };

async function ensureOffscreenDocument() {
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Recording tab audio for transcription",
    });
  }
}

async function startTabRecording(tabId) {
  if (recordingState.active) throw new Error("Already recording");

  const tab = await chrome.tabs.get(tabId);
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  await ensureOffscreenDocument();

  chrome.runtime.sendMessage({
    action: "start-offscreen-recording",
    streamId,
    tabUrl: tab.url || "",
    tabTitle: tab.title || "",
    recordingType: "tab",
  });

  recordingState.active = true;
  recordingState.tabId = tabId;
  recordingState.recordingType = "tab";
  recordingState.tabTitle = tab.title || null;
  recordingState.tabUrl = tab.url || null;
}

async function stopRecording() {
  if (!recordingState.active) throw new Error("Not recording");
  chrome.runtime.sendMessage({ action: "stop-offscreen-recording" });
  recordingState.active = false;
  recordingState.uploading = true;
  recordingState.recordingType = null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "sidepanel-ready") {
    if (pendingContext) {
      sendResponse({ action: "trigger-capture", context: pendingContext });
      pendingContext = null;
    } else {
      sendResponse(null);
    }
    return;
  }
  if (message.action === "get-bridge-status") {
    sendResponse({ running: bridgeRunning, lastPoll: bridgeLastPoll, jobsCompleted: bridgeJobsCompleted, error: bridgeLastError });
    return;
  }
  if (message.action === "get-recording-state") {
    sendResponse({ active: recordingState.active, sessionId: recordingState.sessionId, tabId: recordingState.tabId, recordingType: recordingState.recordingType, uploading: recordingState.uploading, done: recordingState.done, tabTitle: recordingState.tabTitle, tabUrl: recordingState.tabUrl });
    return;
  }
  if (message.action === "start-tab-recording") {
    startTabRecording(message.tabId).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (message.action === "stop-recording") {
    stopRecording().then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: e.message }));
    return true;
  }
  if (message.action === "recording-session-started") {
    recordingState.sessionId = message.sessionId;
    return;
  }
  if (message.action === "recording-stopped") {
    recordingState.active = false;
    recordingState.uploading = false;
    recordingState.done = true;
    recordingState.sessionId = null;
    recordingState.tabId = null;
    recordingState.recordingType = null;
    recordingState.tabTitle = null;
    recordingState.tabUrl = null;
    setTimeout(() => { recordingState.done = false; }, 5000);
    return;
  }
});
