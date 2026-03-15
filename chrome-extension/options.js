const urlInput = document.getElementById("url-input");
const tokenInput = document.getElementById("token-input");
const saveBtn = document.getElementById("save-btn");
const status = document.getElementById("status");

chrome.storage.sync.get(["orgcloudUrl", "bridgeToken"], (result) => {
  if (result.orgcloudUrl) urlInput.value = result.orgcloudUrl;
  if (result.bridgeToken) tokenInput.value = result.bridgeToken;
});

saveBtn.addEventListener("click", async () => {
  let url = urlInput.value.trim();
  const token = tokenInput.value.trim();

  if (!url) {
    chrome.storage.sync.remove(["orgcloudUrl", "bridgeToken"]);
    status.textContent = "Settings cleared.";
    status.className = "info";
    return;
  }

  if (url.endsWith("/")) url = url.slice(0, -1);

  try {
    new URL(url);
  } catch {
    status.textContent = "Invalid URL format.";
    status.className = "error";
    return;
  }

  try {
    const headers = {};
    if (token) headers["X-Bridge-Token"] = token;
    const res = await fetch(`${url}/api/bridge/ext/queue`, { method: "GET", headers });
    if (res.status === 403) {
      status.textContent = "Invalid bridge token.";
      status.className = "error";
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const saveData = { orgcloudUrl: url };
    if (token) saveData.bridgeToken = token;
    chrome.storage.sync.set(saveData);
    status.textContent = "Connected and saved.";
    status.className = "success";
  } catch (e) {
    status.textContent = `Cannot reach server: ${e.message}`;
    status.className = "error";
  }
});

urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveBtn.click();
});
tokenInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") saveBtn.click();
});
