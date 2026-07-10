const saveButton = document.getElementById("saveButton");
const scrapeButton = document.getElementById("scrapeButton");
const clearActivityButton = document.getElementById("clearActivityButton");
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

function appendLog(message) {
  const line = `[${nowLabel()}] ${message}`;
  logElement.textContent = `${line}\n${logElement.textContent}`.slice(0, 8000);
}

function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isMissingContentScriptError(message) {
  return (
    typeof message === "string" &&
    (message.includes("Could not establish connection") ||
      message.includes("Receiving end does not exist"))
  );
}

function isXPageUrl(url) {
  try {
    const parsed = new URL(url || "");
    return /(^|\.)x\.com$|(^|\.)twitter\.com$/i.test(parsed.hostname || "");
  } catch (_error) {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const response = await sendRuntimeMessage({ type: "GET_SETTINGS" });
  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : "settings_load_failed");
  }
  apiBaseUrlInput.value = response.apiBaseUrl || "";
  userIdInput.value = response.userId || "";
  appendLog(`Listo. En cola: ${response.pendingQueue ?? 0}`);
}

async function saveSettings() {
  const response = await sendRuntimeMessage({
    type: "SETTINGS_UPDATE",
    payload: { apiBaseUrl: apiBaseUrlInput.value, userId: userIdInput.value },
  });
  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : "settings_save_failed");
  }
  appendLog(`Ajustes guardados. Backend: ${response.apiBaseUrl} | User: ${response.userId}`);
}

function renderScannerStatus(status = {}) {
  scannerScannedElement.textContent = String(status.scannedCount || 0);
  scannerSavedElement.textContent = String(status.savedCount || 0);
  scannerPendingElement.textContent = String(status.pendingCount || 0);
  scannerErrorsElement.textContent = String(status.errorCount || 0);
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
}

async function injectContentScript(tabId) {
  if (!chrome.scripting || typeof chrome.scripting.executeScript !== "function") {
    throw new Error("scripting_permission_unavailable");
  }
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  await sleep(250);
}

async function sendActiveTabMessage(message, options = {}) {
  const activeTab = await getActiveTab();
  if (!activeTab || !activeTab.id) {
    throw new Error("No hay pestaña activa.");
  }
  try {
    return await chrome.tabs.sendMessage(activeTab.id, message);
  } catch (error) {
    const messageText = toErrorMessage(error);
    const canInject =
      options.retryInject !== false &&
      isMissingContentScriptError(messageText) &&
      isXPageUrl(activeTab.url);
    if (!canInject) throw error;
    appendLog("Inyectando el content script en la pestaña de X...");
    await injectContentScript(activeTab.id);
    return chrome.tabs.sendMessage(activeTab.id, message);
  }
}

// Flujo único: scroll-scan network-first, luego importa lo nuevo. Un botón.
async function scrapeAllBookmarks() {
  scrapeButton.disabled = true;
  scrapeButton.textContent = "Escaneando...";
  try {
    const activeTab = await getActiveTab();
    if (!activeTab || !/\/i\/bookmarks/i.test(activeTab.url || "")) {
      appendLog("Abre x.com/i/bookmarks primero.");
      return;
    }

    appendLog("Escaneando bookmarks (scroll + captura de red)...");
    const scan = await sendActiveTabMessage({ type: "BOOKMARK_SCANNER_RESCAN" });
    renderScannerStatus(scan || {});
    if (!scan || !scan.ok) throw new Error(scan?.error || "scan_failed");
    appendLog(
      `Escaneo: escaneados=${scan.scannedCount || 0} guardados=${scan.savedCount || 0} nuevos=${scan.pendingCount || 0}`
    );

    if (!scan.pendingCount) {
      appendLog("No hay bookmarks nuevos que importar.");
      return;
    }

    scrapeButton.textContent = "Importando...";
    appendLog(`Importando ${scan.pendingCount} nuevos...`);
    const imp = await sendActiveTabMessage({ type: "BOOKMARK_SCANNER_IMPORT_PENDING" });
    renderScannerStatus(imp || {});
    if (!imp || !imp.ok) throw new Error(imp?.error || "import_failed");

    const r = imp.backendResult || {};
    appendLog(`Importado. insertados=${r.inserted || 0} duplicados=${r.duplicates || 0} fallidos=${r.failed || 0}`);
    await sendRuntimeMessage({ type: "INGEST_FLUSH" });
  } catch (error) {
    const message = toErrorMessage(error);
    if (isMissingContentScriptError(message)) {
      appendLog("Abre x.com/i/bookmarks primero. El scraper corre en esa página.");
    } else {
      appendLog(`Error: ${message}`);
    }
  } finally {
    scrapeButton.disabled = false;
    scrapeButton.textContent = "⬇ Importar todos los bookmarks";
  }
}

async function clearScannerPending() {
  const response = await sendActiveTabMessage({ type: "BOOKMARK_SCANNER_CLEAR_PENDING" });
  renderScannerStatus(response || {});
  appendLog(`Cola reiniciada. Nuevos=${response?.pendingCount || 0}`);
}

async function refreshScannerStatus() {
  try {
    const response = await sendActiveTabMessage(
      { type: "GET_BOOKMARK_SCANNER_STATUS" },
      { retryInject: false }
    );
    if (response && response.ok) renderScannerStatus(response);
  } catch (_error) {
    /* pestaña no-X: sin scanner */
  }
}

chrome.runtime.onMessage.addListener((message) => {
  if (!message || typeof message.type !== "string") return;
  if (message.type === "BOOKMARK_SCANNER_STATUS") {
    renderScannerStatus(message.payload || {});
  }
});

saveButton.addEventListener("click", () => {
  void saveSettings().catch((error) => appendLog(`Error guardando: ${toErrorMessage(error)}`));
});

scrapeButton.addEventListener("click", () => {
  void scrapeAllBookmarks();
});

scannerClearButton.addEventListener("click", () => {
  void clearScannerPending().catch((error) => appendLog(`Error reiniciando: ${toErrorMessage(error)}`));
});

clearActivityButton.addEventListener("click", () => {
  logElement.textContent = "";
});

void loadSettings().catch((error) => appendLog(`Error init: ${toErrorMessage(error)}`));
void refreshScannerStatus().catch(() => {});
