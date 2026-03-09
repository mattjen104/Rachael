const urlInput = document.getElementById("url-input");
const saveBtn = document.getElementById("save-btn");
const status = document.getElementById("status");

chrome.storage.sync.get(["orgcloudUrl"], (result) => {
  if (result.orgcloudUrl) {
    urlInput.value = result.orgcloudUrl;
  }
});

saveBtn.addEventListener("click", async () => {
  let url = urlInput.value.trim();
  if (!url) {
    chrome.storage.sync.remove("orgcloudUrl");
    status.textContent = "URL cleared.";
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
    const res = await fetch(`${url}/api/org-files`, { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    chrome.storage.sync.set({ orgcloudUrl: url });
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
