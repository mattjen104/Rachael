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
});
