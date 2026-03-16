let mediaRecorder = null;
let recordingStream = null;
let sessionId = null;
let chunks = [];
let chunkInterval = null;

async function getConfig() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(["orgcloudUrl", "bridgeToken"], (result) => {
      resolve({ baseUrl: result.orgcloudUrl || null, token: result.bridgeToken || null });
    });
  });
}

async function startRecording(streamId, tabUrl, tabTitle, recordingType) {
  const { baseUrl, token } = await getConfig();
  if (!baseUrl) throw new Error("OrgCloud URL not configured");

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
  });

  const startRes = await fetch(`${baseUrl}/api/bridge/ext/audio`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Bridge-Token": token || "",
    },
    body: JSON.stringify({
      action: "start",
      sourceUrl: tabUrl,
      tabTitle: tabTitle,
    }),
  });

  if (!startRes.ok) throw new Error("Failed to start recording session");
  const startData = await startRes.json();
  sessionId = startData.sessionId;

  chrome.runtime.sendMessage({ action: "recording-session-started", sessionId });

  recordingStream = stream;
  chunks = [];

  mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  mediaRecorder.start(5000);

  chunkInterval = setInterval(async () => {
    if (chunks.length === 0) return;
    const blob = new Blob(chunks, { type: "audio/webm" });
    chunks = [];

    const formData = new FormData();
    formData.append("audio", blob, "chunk.webm");
    formData.append("sessionId", sessionId);
    formData.append("action", "chunk");

    try {
      await fetch(`${baseUrl}/api/bridge/ext/audio`, {
        method: "POST",
        headers: { "X-Bridge-Token": token || "" },
        body: formData,
      });
    } catch (err) {
      console.error("[offscreen] chunk upload failed:", err);
    }
  }, 10000);
}

async function stopRecording() {
  if (chunkInterval) {
    clearInterval(chunkInterval);
    chunkInterval = null;
  }

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }

  if (recordingStream) {
    recordingStream.getTracks().forEach(t => t.stop());
    recordingStream = null;
  }

  await new Promise(r => setTimeout(r, 500));

  if (chunks.length > 0 && sessionId) {
    const { baseUrl, token } = await getConfig();
    const blob = new Blob(chunks, { type: "audio/webm" });
    chunks = [];

    const formData = new FormData();
    formData.append("audio", blob, "chunk.webm");
    formData.append("sessionId", sessionId);
    formData.append("action", "chunk");

    try {
      await fetch(`${baseUrl}/api/bridge/ext/audio`, {
        method: "POST",
        headers: { "X-Bridge-Token": token || "" },
        body: formData,
      });
    } catch (err) {
      console.error("[offscreen] final chunk upload failed:", err);
    }
  }

  if (sessionId) {
    const { baseUrl, token } = await getConfig();
    try {
      await fetch(`${baseUrl}/api/bridge/ext/audio`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bridge-Token": token || "",
        },
        body: JSON.stringify({ action: "stop", sessionId }),
      });
    } catch (err) {
      console.error("[offscreen] stop session failed:", err);
    }
  }

  sessionId = null;
  mediaRecorder = null;
  chrome.runtime.sendMessage({ action: "recording-stopped" });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === "start-offscreen-recording") {
    startRecording(message.streamId, message.tabUrl, message.tabTitle, message.recordingType).catch(err => {
      console.error("[offscreen] Failed to start recording:", err);
      chrome.runtime.sendMessage({ action: "recording-stopped" });
    });
  }
  if (message.action === "stop-offscreen-recording") {
    stopRecording().catch(err => {
      console.error("[offscreen] Failed to stop recording:", err);
    });
  }
});
