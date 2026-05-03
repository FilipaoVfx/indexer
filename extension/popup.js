const saveButton = document.getElementById("saveButton");
const flushButton = document.getElementById("flushButton");
const syncButton = document.getElementById("syncButton");
const bulkScrapeButton = document.getElementById("bulkScrapeButton");
const clearActivityButton = document.getElementById("clearActivityButton");
const scannerScanButton = document.getElementById("scannerScanButton");
const scannerImportButton = document.getElementById("scannerImportButton");
const scannerViewButton = document.getElementById("scannerViewButton");
const scannerClearButton = document.getElementById("scannerClearButton");
const scannerStatusElement = document.getElementById("scannerStatus");
const scannerScannedElement = document.getElementById("scannerScanned");
const scannerSavedElement = document.getElementById("scannerSaved");
const scannerPendingElement = document.getElementById("scannerPending");
const scannerErrorsElement = document.getElementById("scannerErrors");
const apiBaseUrlInput = document.getElementById("apiBaseUrl");
const userIdInput = document.getElementById("userId");
const logElement = document.getElementById("log");

function nowLabel() {
  return new Date().toLocaleTimeString();
}

function formatTs(ts) {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch (_error) {
    return "--:--:--";
  }
}

function formatActivityEntry(entry) {
  const ts = formatTs(entry.ts);
  const stage = entry.stage || "event";
  const parts = [`[${ts}] ${stage}`];
  if (entry.tweetId) parts.push(`tweet=${entry.tweetId}`);
  if (typeof entry.count === "number") parts.push(`count=${entry.count}`);
  if (typeof entry.pendingQueue === "number") parts.push(`pending=${entry.pendingQueue}`);
  if (entry.error) parts.push(`err=${String(entry.error).slice(0, 120)}`);
  return parts.join(" ");
}

function appendLog(message) {
  const line = `[${nowLabel()}] ${message}`;
  logElement.textContent = `${line}\n${logElement.textContent}`.slice(0, 8000);
}

function renderActivity(activity, counters, pendingQueue) {
  const header = `Capturados: ${counters.captured} | Entregados: ${counters.delivered} | Fallidos: ${counters.failed} | En cola: ${pendingQueue}`;
  const lines = (activity || []).map(formatActivityEntry);
  logElement.textContent = [header, "", ...lines].join("\n");
}

function setBusy(isBusy) {
  syncButton.disabled = isBusy;
  syncButton.textContent = isBusy ? "Checking..." : "Check auto sync";
}

function setBulkBusy(isBusy) {
  bulkScrapeButton.disabled = isBusy;
  bulkScrapeButton.textContent = isBusy ? "Scraping..." : "Scrape all bookmarks";
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
  await loadActivity(response.pendingQueue);
}

async function loadActivity(fallbackPending) {
  try {
    const response = await sendRuntimeMessage({ type: "GET_ACTIVITY" });
    if (response && response.ok) {
      renderActivity(
        response.activity || [],
        response.counters || { captured: 0, delivered: 0, failed: 0 },
        response.pendingQueue
      );
      return;
    }
  } catch (_error) {
    // fall through to fallback
  }
  appendLog(`Ready. Pending queue: ${fallbackPending ?? 0}`);
}

async function clearActivity() {
  await sendRuntimeMessage({ type: "CLEAR_ACTIVITY" });
  await loadActivity(0);
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

function renderScannerStatus(status = {}) {
  scannerScannedElement.textContent = String(status.scannedCount || 0);
  scannerSavedElement.textContent = String(status.savedCount || 0);
  scannerPendingElement.textContent = String(status.pendingCount || 0);
  scannerErrorsElement.textContent = String(status.errorCount || 0);
  scannerImportButton.disabled = !status.canImport;
  scannerScanButton.disabled = !!status.scrollScanInProgress;

  if (!status.active) {
    scannerStatusElement.textContent = "Open x.com/i/bookmarks to scan visible posts.";
    return;
  }

  if (status.scrollScanInProgress) {
    scannerStatusElement.textContent =
      `Scanning with scroll... round ${status.scrollScanRounds || 0}`;
    return;
  }

  if (!status.initialized) {
    scannerStatusElement.textContent = "Scanner ready to start.";
    return;
  }

  if (!status.idsLoaded) {
    scannerStatusElement.textContent = "Scanner offline: saved IDs are not loaded.";
    return;
  }

  if (!status.backendOnline) {
    scannerStatusElement.textContent =
      `Offline: using cached IDs (${status.savedIdsCount || 0}). Import disabled.`;
    return;
  }

  const source = status.cachedIds ? "cached IDs" : "backend IDs";
  scannerStatusElement.textContent =
    `Using ${source}. Saved IDs=${status.savedIdsCount || 0}`;
}

async function sendActiveTabMessage(message) {
  const activeTab = await getActiveTab();
  if (!activeTab || !activeTab.id) {
    throw new Error("No active tab found.");
  }

  return chrome.tabs.sendMessage(activeTab.id, message);
}

async function refreshScannerStatus() {
  try {
    const response = await sendActiveTabMessage({
      type: "GET_BOOKMARK_SCANNER_STATUS"
    });
    if (response && response.ok) {
      renderScannerStatus(response);
    }
  } catch (_error) {
    renderScannerStatus({ active: false });
  }
}

async function rescanBookmarkDomScanner() {
  appendLog("Scanning bookmarks with scroll...");
  const response = await sendActiveTabMessage({
    type: "BOOKMARK_SCANNER_RESCAN"
  });

  renderScannerStatus(response || {});
  if (!response || !response.ok) {
    throw new Error(response?.error || "scanner_rescan_failed");
  }

  appendLog(
    `Scroll scan: rounds=${response.rounds || response.scrollScanRounds || 0} scanned=${response.scannedCount || 0} saved=${response.savedCount || 0} pending=${response.pendingCount || 0}`
  );
}

async function importScannerPending() {
  appendLog("Importing scanner pending bookmarks...");
  const response = await sendActiveTabMessage({
    type: "BOOKMARK_SCANNER_IMPORT_PENDING"
  });

  renderScannerStatus(response || {});
  if (!response || !response.ok) {
    throw new Error(response?.error || "scanner_import_failed");
  }

  const result = response.backendResult || {};
  appendLog(
    `Import done. inserted=${result.inserted || 0} duplicates=${result.duplicates || 0} failed=${result.failed || 0}`
  );
}

async function clearScannerPending() {
  const response = await sendActiveTabMessage({
    type: "BOOKMARK_SCANNER_CLEAR_PENDING"
  });
  renderScannerStatus(response || {});
  appendLog(`Scanner queue cleared. Pending=${response?.pendingCount || 0}`);
}

async function viewScannerPending() {
  const response = await sendActiveTabMessage({
    type: "GET_BOOKMARK_SCANNER_PENDING"
  });
  renderScannerStatus(response || {});

  if (!response || !response.ok) {
    throw new Error(response?.error || "scanner_pending_failed");
  }

  const items = Array.isArray(response.items) ? response.items : [];
  if (items.length === 0) {
    appendLog("No scanner pending bookmarks.");
    return;
  }

  const preview = items
    .slice(0, 10)
    .map((item) => `${item.tweet_id} ${item.author_handle ? `@${item.author_handle}` : ""}`)
    .join("\n");
  appendLog(`Pending (${items.length}):\n${preview}`);
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

async function startBulkScrape() {
  setBulkBusy(true);
  appendLog("Starting bulk bookmarks scrape...");

  try {
    const activeTab = await getActiveTab();
    if (!activeTab || !activeTab.id) {
      throw new Error("No active tab found.");
    }

    if (!/\/i\/bookmarks/i.test(activeTab.url || "")) {
      appendLog("Open x.com/i/bookmarks first, then run scrape.");
      return;
    }

    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: "START_SYNC"
    });

    if (!response) {
      throw new Error("no_response_from_content_script");
    }

    if (!response.ok) {
      throw new Error(response.error || "bulk_scrape_failed");
    }

    appendLog(
      `Scrape done. Extracted=${response.totalExtracted} Enqueued=${response.totalEnqueued} Rounds=${response.rounds}`
    );

    const flushResponse = await sendRuntimeMessage({ type: "INGEST_FLUSH" });
    appendLog(`Flush triggered. Pending queue: ${flushResponse && flushResponse.pendingQueue}`);
    await loadActivity(flushResponse && flushResponse.pendingQueue);
  } catch (error) {
    const message = toErrorMessage(error);
    if (isMissingContentScriptError(message)) {
      appendLog("Open x.com/i/bookmarks first. Scrape only runs on the bookmarks page.");
    } else {
      appendLog(`Scrape error: ${message}`);
    }
  } finally {
    setBulkBusy(false);
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

  if (message.type === "BOOKMARK_SCANNER_STATUS") {
    renderScannerStatus(message.payload || {});
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

bulkScrapeButton.addEventListener("click", () => {
  void startBulkScrape();
});

clearActivityButton.addEventListener("click", () => {
  void clearActivity().catch((error) => {
    appendLog(`Clear error: ${toErrorMessage(error)}`);
  });
});

scannerScanButton.addEventListener("click", () => {
  void rescanBookmarkDomScanner().catch((error) => {
    const message = toErrorMessage(error);
    if (isMissingContentScriptError(message)) {
      appendLog("Open x.com/i/bookmarks first. Scanner runs on the bookmarks page.");
    } else {
      appendLog(`Scanner error: ${message}`);
    }
  });
});

scannerImportButton.addEventListener("click", () => {
  void importScannerPending().catch((error) => {
    appendLog(`Import error: ${toErrorMessage(error)}`);
  });
});

scannerViewButton.addEventListener("click", () => {
  void viewScannerPending().catch((error) => {
    appendLog(`Pending error: ${toErrorMessage(error)}`);
  });
});

scannerClearButton.addEventListener("click", () => {
  void clearScannerPending().catch((error) => {
    appendLog(`Clear scanner error: ${toErrorMessage(error)}`);
  });
});

void loadSettings().catch((error) => {
  appendLog(`Init error: ${toErrorMessage(error)}`);
});

void refreshScannerStatus().catch(() => {});
