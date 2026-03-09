const appFrame = document.getElementById("app-frame");
const statusIndicator = document.getElementById("status-indicator");
const statusText = document.getElementById("status-text");
const settingsBtn = document.getElementById("settings-btn");
const openSettingsBtn = document.getElementById("open-settings-btn");
const notConfigured = document.getElementById("not-configured");

let apiUrl = "";
let pendingCapture = false;
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

async function getPageContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return null;

    const context = { url: tab.url || "", title: tab.title || "", selection: "" };

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.getSelection()?.toString() || "",
      });
      if (results && results[0]) {
        context.selection = results[0].result || "";
      }
    } catch (e) {
    }

    return context;
  } catch (e) {
    return null;
  }
}

async function triggerCapture() {
  const context = await getPageContext();
  if (!context) return;

  if (appReady && appFrame.contentWindow) {
    appFrame.contentWindow.postMessage(
      { action: "capture", ...context },
      apiUrl
    );
  } else {
    pendingCapture = true;
    window._pendingCaptureContext = context;
  }
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
    if (pendingCapture && window._pendingCaptureContext && appFrame.contentWindow) {
      appFrame.contentWindow.postMessage(
        { action: "capture", ...window._pendingCaptureContext },
        apiUrl
      );
      pendingCapture = false;
      window._pendingCaptureContext = null;
    }
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "trigger-capture") {
    triggerCapture();
  }
});
