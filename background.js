// Listen for messages from content script and popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Forward messages as needed
  if (message.type === "statsUpdate" && sender.tab) {
    // Forward stats from content script to popup
    chrome.runtime.sendMessage(message);
  }
});
