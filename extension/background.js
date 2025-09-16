// Background service worker for MV3

chrome.runtime.onInstalled.addListener(async () => {
  try {
    if (chrome.sidePanel?.setPanelBehavior) {
      await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    }
  } catch (err) {
    console.warn('sidePanel behavior setup failed', err);
  }
});

// Optional: open side panel automatically when navigating to a YouTube watch page
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.status || changeInfo.status !== 'complete') return;
  try {
    const url = tab.url || '';
    if (/^https?:\/\/(www\.)?youtube\.com\/watch/.test(url)) {
      // Do not auto-open; rely on action click. Uncomment to auto-open.
      // if (chrome.sidePanel?.open) await chrome.sidePanel.open({ tabId });
    }
  } catch (err) {
    console.warn('onUpdated handling error', err);
  }
});

// Provide active tab ID to side panel when requested
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'getActiveTabId') {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        const active = tabs && tabs[0] ? tabs[0].id : undefined;
        sendResponse({ tabId: active });
      });
      return true; // async
    } catch (err) {
      sendResponse({ tabId: undefined, error: String(err) });
    }
  }
});


