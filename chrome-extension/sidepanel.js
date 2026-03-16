const appFrame = document.getElementById("app-frame");
const statusIndicator = document.getElementById("status-indicator");
const statusText = document.getElementById("status-text");
const settingsBtn = document.getElementById("settings-btn");
const openSettingsBtn = document.getElementById("open-settings-btn");
const notConfigured = document.getElementById("not-configured");

let apiUrl = "";
let pendingCapture = null;
let appReady = false;

function setConnected(url) {
  statusIndicator.className = "connected";
  statusText.textContent = new URL(url).hostname;
  notConfigured.style.display = "none";
  appFrame.style.display = "block";
}

function setDisconnected() {
  statusIndicator.className = "disconnected";
  statusText.textContent = "not configured";
  notConfigured.style.display = "flex";
  appFrame.style.display = "none";
}

function openSettings() {
  chrome.runtime.openOptionsPage();
}

settingsBtn.addEventListener("click", openSettings);
openSettingsBtn.addEventListener("click", openSettings);

function loadApp(url) {
  apiUrl = url;
  appReady = false;
  appFrame.src = url;
  setConnected(url);
  loadCachedScrapeData();
}

chrome.storage.sync.get(["orgcloudUrl"], (result) => {
  if (result.orgcloudUrl) {
    loadApp(result.orgcloudUrl);
  } else {
    setDisconnected();
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.orgcloudUrl) {
    const newUrl = changes.orgcloudUrl.newValue;
    if (newUrl) {
      loadApp(newUrl);
    } else {
      setDisconnected();
    }
  }
});

function sendCaptureToApp(context) {
  if (appReady && appFrame.contentWindow) {
    appFrame.contentWindow.postMessage(
      { action: "capture", ...context },
      apiUrl
    );
  } else {
    pendingCapture = context;
  }
}

function cacheScrapeData(data) {
  try {
    chrome.storage.local.set({
      orgcloudScrapeCache: {
        ...data,
        cachedAt: Date.now(),
      },
    });
  } catch {}
}

function loadCachedScrapeData() {
  try {
    chrome.storage.local.get(["orgcloudScrapeCache"], (result) => {
      if (chrome.runtime.lastError) return;
      const cached = result.orgcloudScrapeCache;
      if (!cached) return;

      const age = Date.now() - (cached.cachedAt || 0);
      if (age > 24 * 60 * 60 * 1000) return;

      if (appReady && appFrame.contentWindow) {
        appFrame.contentWindow.postMessage(
          {
            action: "orgcloud-scrape-cache",
            emails: cached.emails || [],
            chats: cached.teamsChats || [],
          },
          apiUrl
        );
      } else {
        const waitForReady = setInterval(() => {
          if (appReady && appFrame.contentWindow) {
            clearInterval(waitForReady);
            appFrame.contentWindow.postMessage(
              {
                action: "orgcloud-scrape-cache",
                emails: cached.emails || [],
                chats: cached.teamsChats || [],
              },
              apiUrl
            );
          }
        }, 500);
        setTimeout(() => clearInterval(waitForReady), 10000);
      }
    });
  } catch {}
}

function fetchAndCacheScrapeBuffer() {
  if (!apiUrl) return;
  fetch(apiUrl.replace(/\/$/, "") + "/api/scrape/buffer", { credentials: "include" })
    .then((res) => res.json())
    .then((data) => {
      if (data && (data.emails?.length || data.teamsChats?.length)) {
        cacheScrapeData(data);
      }
    })
    .catch(() => {});
}

window.addEventListener("message", (event) => {
  if (!apiUrl) return;
  try {
    const appOrigin = new URL(apiUrl).origin;
    if (event.origin !== appOrigin) return;
  } catch {
    return;
  }

  if (event.data?.action === "orgcloud-ready") {
    appReady = true;
    loadCachedScrapeData();
    if (pendingCapture && appFrame.contentWindow) {
      appFrame.contentWindow.postMessage(
        { action: "capture", ...pendingCapture },
        apiUrl
      );
      pendingCapture = null;
    }
  }

  if (event.data?.action === "orgcloud-scrape-complete") {
    fetchAndCacheScrapeBuffer();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "trigger-capture" && message.context) {
    sendCaptureToApp(message.context);
  }
});

chrome.runtime.sendMessage({ action: "sidepanel-ready" }, (response) => {
  if (chrome.runtime.lastError) return;
  if (response && response.action === "trigger-capture" && response.context) {
    sendCaptureToApp(response.context);
  }
});

const recordingBar = document.getElementById("recording-bar");
const recControls = document.getElementById("rec-controls");
const recIndicator = document.getElementById("rec-indicator");
const recLabel = document.getElementById("rec-label");
const recTabInfo = document.getElementById("rec-tab-info");
const recDuration = document.getElementById("rec-duration");
const recStopBtn = document.getElementById("rec-stop-btn");
const recTabBtn = document.getElementById("rec-tab-btn");

let recTimer = null;
let recStartTime = null;

function formatRecDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function updateRecordingUI(state) {
  if (state.active) {
    recordingBar.style.display = "flex";
    recControls.style.display = "none";
    recStopBtn.style.display = "";
    recIndicator.style.animation = "pulse 1s infinite";
    recLabel.textContent = state.recordingType === "tab" ? "Recording tab" : "Recording";
    if (state.tabTitle) {
      recTabInfo.textContent = state.tabTitle.substring(0, 30);
      recTabInfo.title = state.tabUrl || state.tabTitle;
    } else {
      recTabInfo.textContent = "";
    }
    if (!recTimer) {
      recStartTime = Date.now();
      recTimer = setInterval(() => {
        recDuration.textContent = formatRecDuration(Date.now() - recStartTime);
      }, 1000);
    }
  } else if (state.uploading) {
    recordingBar.style.display = "flex";
    recControls.style.display = "none";
    recStopBtn.style.display = "none";
    recIndicator.style.animation = "none";
    recLabel.textContent = "Uploading...";
    if (recTimer) { clearInterval(recTimer); recTimer = null; }
  } else if (state.done) {
    recordingBar.style.display = "flex";
    recControls.style.display = "none";
    recStopBtn.style.display = "none";
    recIndicator.style.animation = "none";
    recIndicator.textContent = "✓";
    recLabel.textContent = "Transcription complete";
    if (recTimer) { clearInterval(recTimer); recTimer = null; }
    setTimeout(() => {
      recIndicator.textContent = "●";
      updateRecordingUI({ active: false });
    }, 3000);
  } else {
    recordingBar.style.display = "none";
    recControls.style.display = apiUrl ? "flex" : "none";
    if (recTimer) {
      clearInterval(recTimer);
      recTimer = null;
    }
    recDuration.textContent = "0:00";
  }
}

function pollRecordingState() {
  chrome.runtime.sendMessage({ action: "get-recording-state" }, (state) => {
    if (chrome.runtime.lastError) return;
    if (state) updateRecordingUI(state);
  });
}

recTabBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  chrome.runtime.sendMessage({ action: "start-tab-recording", tabId: tab.id }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response && response.error) {
      console.error("Failed to start recording:", response.error);
      return;
    }
    pollRecordingState();
  });
});

recStopBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ action: "stop-recording" }, (response) => {
    if (chrome.runtime.lastError) return;
    updateRecordingUI({ active: false });
  });
});

setInterval(pollRecordingState, 3000);

chrome.storage.sync.get(["orgcloudUrl"], (result) => {
  if (result.orgcloudUrl) {
    recControls.style.display = "flex";
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && changes.orgcloudUrl) {
    recControls.style.display = changes.orgcloudUrl.newValue ? "flex" : "none";
  }
});
