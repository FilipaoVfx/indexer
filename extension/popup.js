const saveButton = document.getElementById("saveButton");
const scrapeButton = document.getElementById("scrapeButton");
const clearActivityButton = document.getElementById("clearActivityButton");
const scannerClearButton = document.getElementById("scannerClearButton");
const retryFailedButton = document.getElementById("retryFailedButton");
const diagButton = document.getElementById("diagButton");
const scannerStatusElement = document.getElementById("scannerStatus");
const scannerScannedElement = document.getElementById("scannerScanned");
const scannerSavedElement = document.getElementById("scannerSaved");
const scannerPendingElement = document.getElementById("scannerPending");
const scannerErrorsElement = document.getElementById("scannerErrors");
const apiBaseUrlInput = document.getElementById("apiBaseUrl");
const userIdInput = document.getElementById("userId");
const apiKeyInput = document.getElementById("apiKey");
const rangeMinInput = document.getElementById("rangeMin");
const rangeMaxInput = document.getElementById("rangeMax");
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
  apiKeyInput.value = response.apiKey || "";
  appendLog(`Listo. En cola: ${response.pendingQueue ?? 0}`);
}

async function saveSettings() {
  const backend = new URL(apiBaseUrlInput.value);
  if (!["https:", "http:"].includes(backend.protocol) || backend.username || backend.password) throw new Error("URL de backend inválida.");
  const origins = [backend.origin + "/*"];
  if (!await chrome.permissions.contains({ origins }) && !await chrome.permissions.request({ origins })) throw new Error("Permiso de acceso al backend pendiente.");
  const response = await sendRuntimeMessage({
    type: "SETTINGS_UPDATE",
    payload: {
      apiBaseUrl: apiBaseUrlInput.value,
      userId: userIdInput.value,
      apiKey: apiKeyInput.value,
    },
  });
  if (!response || !response.ok) {
    throw new Error(response && response.error ? response.error : "settings_save_failed");
  }
  appendLog(
    `Ajustes guardados. Backend: ${response.apiBaseUrl} | User: ${response.userId} | API key: ${response.apiKey ? "configurada" : "sin configurar"}`
  );
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
  await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", files: ["page-bridge.js"] });
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

// Rango 1-based de pendientes; los recuperados también participan. La selección se fija por ID.
// min vacío = 1; max vacío = todos. max también corta el scroll temprano.
function readRange() {
  const min = Math.max(1, Math.floor(Number(rangeMinInput.value) || 1));
  const rawMax = Math.floor(Number(rangeMaxInput.value) || 0);
  const max = rawMax > 0 ? rawMax : 0; // 0 = sin tope
  if (max > 0 && max < min) {
    return { min: max, max: min }; // usuario los invirtió: tolerar
  }
  return { min, max };
}

// Flujo único: scroll-scan network-first, luego importa lo nuevo. Un botón.
async function scrapeAllBookmarks() {
  scrapeButton.disabled = true;
  try {
    const tab = await getActiveTab();
    if (!tab || !/\/i\/bookmarks/.test(tab.url || "")) throw new Error("Abre x.com/i/bookmarks primero.");
    await sendActiveTabMessage({ type: "GET_BOOKMARK_SCANNER_STATUS" });
    const response = await sendRuntimeMessage({ type: "START_BOOKMARK_IMPORT", payload: { tabId: tab.id, range: readRange() } });
    if (!response?.ok) throw new Error(response?.error || "scan_not_started");
    appendLog("Importación iniciada. Puedes cerrar este popup; mantén abierta la pestaña de X durante el escaneo.");
    await refreshDeliveryStatus();
  } catch (error) { appendLog(toErrorMessage(error)); }
  finally { scrapeButton.disabled = false; }
}
async function refreshDeliveryStatus() {
  const status = await sendRuntimeMessage({ type: "GET_DELIVERY_STATUS" });
  if (!status?.ok) return;
  const job = status.job;
  const phase = { scanning: "Escaneando", delivering: "Enviando", confirmed: "Guardado", needs_attention: "Requiere revisión", interrupted: "Interrumpido: vuelve a iniciar para continuar" }[job?.phase] || "Listo";
  const coverage = { complete: "recorrido completo", partial: "recorrido parcial", range_limit: "rango solicitado" }[job?.coverage];
  scannerStatusElement.textContent = `${phase}${coverage ? " · " + coverage : ""} · en cola: ${status.pendingCount} · confirmados: ${job?.confirmed || 0} · rechazados: ${status.failedCount}`;
}

async function clearScannerPending() {
  const response = await sendActiveTabMessage({ type: "BOOKMARK_SCANNER_CLEAR_PENDING" });
  if (!response?.ok) throw new Error(response?.error || "clear_drafts_failed");
  renderScannerStatus(response);
  appendLog(`Pendientes descartados. Restantes=${response.pendingCount || 0}`);
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
    return;
  }
  // Rastro de depuración del background (chunks de import, prepare, errores).
  // SYNC_ERROR pasa siempre: ocultar los fallos de envío (bg_flush_*,
  // bg_post_batch_*) dejaba la cola atascada sin pista visible.
  if (message.type === "SYNC_PROGRESS" || message.type === "SYNC_ERROR") {
    const p = message.payload || {};
    const isError = message.type === "SYNC_ERROR";
    if (!p.stage) return;
    if (!isError && !/^bg_(scanner_|flush_|post_batch_)/.test(p.stage)) return;
    const detail = Object.entries(p)
      .filter(([k]) => !["stage", "debug"].includes(k))
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")
      .slice(0, 220);
    appendLog(`${isError ? "⚠ " : ""}${p.stage}: ${detail}`);
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

retryFailedButton.addEventListener("click", () => {
  void (async () => {
    const res = await sendRuntimeMessage({ type: "RETRY_FAILED" });
    if (!res?.ok) throw new Error(res?.error || "retry_failed");
    appendLog(`Fallidos reencolados: ${res?.requeued ?? 0}. En cola: ${res?.pendingQueue ?? "?"}`);
  })().catch((error) => appendLog(`Retry error: ${toErrorMessage(error)}`));
});

diagButton.addEventListener("click", () => {
  void (async () => {
    const d = await sendRuntimeMessage({ type: "DIAGNOSTICS" });
    if (!d || !d.ok) {
      throw new Error(d && d.error ? d.error : "diagnostics_failed");
    }
    const mb = (bytes) => (bytes >= 0 ? `${(bytes / 1024 / 1024).toFixed(2)}MB` : "?");
    appendLog(
      [
        `── Diagnóstico ──`,
        `backend: ${d.apiBaseUrl}`,
        `user: ${d.userId} | apiKey: ${d.apiKeyConfigured ? "configurada" : "SIN CONFIGURAR"}`,
        `storage: ${mb(d.storageBytesInUse)} / ${mb(d.storageQuotaBytes ?? -1)}`,
        `cola: ${d.pendingQueue} (flushing: ${d.isFlushing}) | fallidos: ${d.failedQueue}`,
        `contadores: capturados=${d.counters?.captured ?? 0} enviados=${d.counters?.delivered ?? 0} fallidos=${d.counters?.failed ?? 0}`,
        d.queueHead
          ? `head: ${d.queueHead.bookmarkCount} bookmarks, intentos=${d.queueHead.attempts}, encolado=${d.queueHead.queuedAt}\n  lastError: ${d.queueHead.lastError || "(ninguno)"}`
          : `head: (cola vacía)`,
        d.failedLast
          ? `último fallido: ${d.failedLast.failedAt}\n  lastError: ${d.failedLast.lastError || "?"}`
          : null,
      ]
        .filter(Boolean)
        .join("\n")
    );
  })().catch((error) => appendLog(`Diagnóstico error: ${toErrorMessage(error)}`));
});

void loadSettings().catch((error) => appendLog(`Error init: ${toErrorMessage(error)}`));
void refreshScannerStatus().catch(() => {});

void refreshDeliveryStatus().catch(() => {});
setInterval(() => void refreshDeliveryStatus().catch(() => {}), 1500);
