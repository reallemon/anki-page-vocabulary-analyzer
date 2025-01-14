let isEnabled = false;
let selectedDeck = "";

document.addEventListener("DOMContentLoaded", async () => {
  // Load saved settings
  const settings = await chrome.storage.local.get([
    "isEnabled",
    "selectedDeck",
  ]);
  isEnabled = settings.isEnabled || false;
  selectedDeck = settings.selectedDeck || "";

  const toggle = document.getElementById("enableToggle");
  const deckSelector = document.getElementById("deckSelector");
  const connectionStatus = document.getElementById("connectionStatus");

  toggle.checked = isEnabled;

  // Check Anki connection and get decks
  try {
    const response = await fetch("http://localhost:8765", {
      method: "POST",
      body: JSON.stringify({
        action: "deckNames",
        version: 6,
      }),
    });

    const data = await response.json();
    if (data.error) {
      connectionStatus.textContent = "Error: Cannot connect to Anki";
      connectionStatus.style.color = "red";
      return;
    }

    connectionStatus.textContent = "Connected to Anki";
    connectionStatus.style.color = "green";
    deckSelector.disabled = false;

    // Populate deck selector
    data.result.forEach((deck) => {
      const option = document.createElement("option");
      option.value = deck;
      option.textContent = deck;
      deckSelector.appendChild(option);
    });

    if (selectedDeck) {
      deckSelector.value = selectedDeck;
    }

    // Show stats immediately if enabled
    if (isEnabled) {
      document.getElementById("stats").style.display = "block";
    }
  } catch (error) {
    connectionStatus.textContent = "Error: Anki not running";
    connectionStatus.style.color = "red";
  }

  // Event listeners
  toggle.addEventListener("change", async (e) => {
    isEnabled = e.target.checked;
    await chrome.storage.local.set({ isEnabled });

    // Update stats display
    document.getElementById("stats").style.display = isEnabled
      ? "block"
      : "none";

    // Notify content script
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    chrome.tabs.sendMessage(tab.id, {
      type: "toggleAnalysis",
      isEnabled,
      selectedDeck,
    });
  });

  deckSelector.addEventListener("change", async (e) => {
    selectedDeck = e.target.value;
    await chrome.storage.local.set({ selectedDeck });

    if (isEnabled) {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      chrome.tabs.sendMessage(tab.id, {
        type: "toggleAnalysis",
        isEnabled,
        selectedDeck,
      });
    }
  });

  // Request current stats if enabled
  if (isEnabled) {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    chrome.tabs.sendMessage(tab.id, { type: "getStats" });
  }
});

// Listen for stats updates from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "statsUpdate") {
    document.getElementById("stats").style.display = "block";
    document.getElementById("knownWords").textContent = message.stats.known;
    document.getElementById("unknownWords").textContent = message.stats.unknown;
    document.getElementById("newWords").textContent = message.stats.new;
  }
});
