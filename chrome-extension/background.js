chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
  setTimeout(() => {
    chrome.runtime.sendMessage({ action: "trigger-capture", tabId: tab.id });
  }, 300);
});
