chrome.action.onClicked.addListener(async () => {
  // Opening a second dashboard is safe: an origin-scoped Web Lock allows just one controller.
  await chrome.tabs.create({ url: chrome.runtime.getURL('catalog.html') });
});
