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
    if (pendingCapture && appFrame.contentWindow) {
      appFrame.contentWindow.postMessage(
        { action: "capture", ...pendingCapture },
        apiUrl
      );
      pendingCapture = null;
    }
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
