const saveButton = document.getElementById("saveButton");
const flushButton = document.getElementById("flushButton");
const syncButton = document.getElementById("syncButton");
const apiBaseUrlInput = document.getElementById("apiBaseUrl");
const userIdInput = document.getElementById("userId");
const logElement = document.getElementById("log");

function nowLabel() {
  return new Date().toLocaleTimeString();
}

function appendLog(message) {
  const line = `[${nowLabel()}] ${message}`;
  logElement.textContent = `${line}\n${logElement.textContent}`.slice(0, 8000);
}

function setBusy(isBusy) {
  syncButton.disabled = isBusy;
  syncButton.textContent = isBusy ? "Syncing..." : "Sync now";
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function loadSettings() {
  const response = await sendRuntimeMessage({
    type: "GET_SETTINGS"
  });

  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : "settings_load_failed");
  }

  apiBaseUrlInput.value = response.apiBaseUrl || "";
  userIdInput.value = response.userId || "";
  appendLog(`Ready. Pending queue: ${response.pendingQueue}`);
}

async function saveSettings() {
  const response = await sendRuntimeMessage({
    type: "SETTINGS_UPDATE",
    payload: {
      apiBaseUrl: apiBaseUrlInput.value,
      userId: userIdInput.value
    }
  });

  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : "settings_save_failed");
  }

  appendLog(`Settings saved. Backend: ${response.apiBaseUrl} | User: ${response.userId}`);
}

async function flushQueue() {
  const response = await sendRuntimeMessage({
    type: "INGEST_FLUSH"
  });
  appendLog(`Flush requested. Pending queue: ${response && response.pendingQueue}`);
}

async function startSync() {
  setBusy(true);
  appendLog("Starting sync...");

  try {
    const tabs = await chrome.tabs.query({
      active: true,
      currentWindow: true
    });
    const activeTab = tabs[0];

    if (!activeTab || !activeTab.id) {
      throw new Error("No active tab found");
    }

    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: "START_SYNC"
    });

    if (!response || !response.ok) {
      throw new Error(
        response && response.error
          ? response.error
          : "Failed to trigger sync. Open x.com/i/bookmarks first."
      );
    }

    appendLog(
      `Sync done. Extracted=${response.result.totalExtracted} Enqueued=${response.result.totalEnqueued} Batches=${response.result.totalBatches} Pending=${response.result.pendingQueue}`
    );
  } catch (error) {
    appendLog(`Sync error: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    setBusy(false);
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message.type !== "string") {
    return;
  }

  if (message.type === "SYNC_PROGRESS") {
    const payload = message.payload || {};
    const compact = JSON.stringify(payload);
    appendLog(`Progress: ${compact}`);
    return;
  }

  if (message.type === "SYNC_ERROR") {
    const payload = message.payload || {};
    appendLog(`Error: ${JSON.stringify(payload)}`);
    return;
  }

  if (message.type === "SYNC_DONE") {
    const payload = message.payload || {};
    appendLog(`Done event: ${JSON.stringify(payload)}`);
  }
});

saveButton.addEventListener("click", () => {
  void saveSettings().catch((error) => {
    appendLog(`Save error: ${error instanceof Error ? error.message : String(error)}`);
  });
});

flushButton.addEventListener("click", () => {
  void flushQueue().catch((error) => {
    appendLog(`Flush error: ${error instanceof Error ? error.message : String(error)}`);
  });
});

syncButton.addEventListener("click", () => {
  void startSync();
});

void loadSettings().catch((error) => {
  appendLog(`Init error: ${error instanceof Error ? error.message : String(error)}`);
});