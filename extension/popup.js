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
  syncButton.textContent = isBusy ? "Checking..." : "Check auto sync";
}

function toErrorMessage(error) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isMissingContentScriptError(message) {
  return (
    typeof message === "string" &&
    (message.includes("Could not establish connection") ||
      message.includes("Receiving end does not exist"))
  );
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

async function getActiveTab() {
  const tabs = await chrome.tabs.query({
    active: true,
    currentWindow: true
  });
  return tabs[0] || null;
}

async function checkAutoSync() {
  setBusy(true);
  appendLog("Checking auto-sync listener...");

  try {
    const activeTab = await getActiveTab();
    if (!activeTab || !activeTab.id) {
      throw new Error("No active tab found.");
    }

    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: "GET_CAPTURE_STATUS"
    });

    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "status_check_failed");
    }

    appendLog(
      `Auto listener ready. SyncId=${response.syncId} Captured cache=${response.trackedTweets}`
    );

    const flushResponse = await sendRuntimeMessage({
      type: "INGEST_FLUSH"
    });
    appendLog(`Auto-sync active. Pending queue: ${flushResponse && flushResponse.pendingQueue}`);
  } catch (error) {
    const message = toErrorMessage(error);
    if (isMissingContentScriptError(message)) {
      appendLog("Open any x.com tab first. Auto-listener only runs on x.com.");
    } else {
      appendLog(`Sync error: ${message}`);
    }
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
  }
});

saveButton.addEventListener("click", () => {
  void saveSettings().catch((error) => {
    appendLog(`Save error: ${toErrorMessage(error)}`);
  });
});

flushButton.addEventListener("click", () => {
  void flushQueue().catch((error) => {
    appendLog(`Flush error: ${toErrorMessage(error)}`);
  });
});

syncButton.addEventListener("click", () => {
  void checkAutoSync();
});

void loadSettings().catch((error) => {
  appendLog(`Init error: ${toErrorMessage(error)}`);
});
