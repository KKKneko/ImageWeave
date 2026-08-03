import { getApplicationById } from "./app-registry.js";

export const STORAGE_KEYS = Object.freeze({
  currentApp: "imageweave.ui:current-app",
  activeBatch: "imageweave.ui:active-batch",
  windowMaximized: "imageweave.ui:window-maximized",
  uiPreferences: "imageweave.ui:ui-preferences",
});

const BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PREFERENCE_RULES = Object.freeze({
  animations: new Set(["system", "reduced"]),
  taskbarDensity: new Set(["comfortable", "compact"]),
});

function browserStorage(name) {
  try {
    return globalThis[name] || null;
  } catch {
    return null;
  }
}

function safeRead(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function safeWrite(storage, key, value) {
  try {
    storage?.setItem(key, value);
    return Boolean(storage);
  } catch {
    return false;
  }
}

function safeRemove(storage, key) {
  try {
    storage?.removeItem(key);
    return Boolean(storage);
  } catch {
    return false;
  }
}

function parseObject(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function isValidBatchId(value) {
  return typeof value === "string" && BATCH_ID_PATTERN.test(value);
}

function requireApplicationId(appId) {
  if (typeof appId !== "string" || !getApplicationById(appId)) {
    throw new TypeError("应用 ID 无效");
  }
  return appId;
}

function requireBatchId(batchId) {
  if (!isValidBatchId(batchId)) throw new TypeError("批次 ID 格式无效");
  return batchId;
}

function sanitizeWindowPreferences(value) {
  const result = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [appId, maximized] of Object.entries(value)) {
    if (getApplicationById(appId) && typeof maximized === "boolean") {
      result[appId] = maximized;
    }
  }
  return result;
}

function sanitizeUiPreferences(value, { strict = false } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (strict) throw new TypeError("UI 偏好必须是对象");
    return {};
  }
  const result = {};
  for (const [key, preference] of Object.entries(value)) {
    const rule = PREFERENCE_RULES[key];
    if (!rule || !rule.has(preference)) {
      if (strict) throw new TypeError(`UI 偏好 ${key} 无效`);
      continue;
    }
    result[key] = preference;
  }
  return result;
}

export function createStorageService({
  localStorage = browserStorage("localStorage"),
  sessionStorage = browserStorage("sessionStorage"),
} = {}) {
  return Object.freeze({
    readCurrentApp() {
      const value = safeRead(sessionStorage, STORAGE_KEYS.currentApp);
      if (value === null) return null;
      if (value.length <= 32 && getApplicationById(value)) return value;
      safeRemove(sessionStorage, STORAGE_KEYS.currentApp);
      return null;
    },
    writeCurrentApp(appId) {
      return safeWrite(sessionStorage, STORAGE_KEYS.currentApp, requireApplicationId(appId));
    },
    readActiveBatchId() {
      const value = safeRead(sessionStorage, STORAGE_KEYS.activeBatch);
      if (value === null) return null;
      if (isValidBatchId(value)) return value;
      safeRemove(sessionStorage, STORAGE_KEYS.activeBatch);
      return null;
    },
    writeActiveBatchId(batchId) {
      return safeWrite(sessionStorage, STORAGE_KEYS.activeBatch, requireBatchId(batchId));
    },
    clearActiveBatchId() {
      return safeRemove(sessionStorage, STORAGE_KEYS.activeBatch);
    },
    readWindowMaximized(appId) {
      requireApplicationId(appId);
      const stored = parseObject(safeRead(localStorage, STORAGE_KEYS.windowMaximized));
      if (!stored) return null;
      const preferences = sanitizeWindowPreferences(stored);
      return Object.prototype.hasOwnProperty.call(preferences, appId)
        ? preferences[appId]
        : null;
    },
    writeWindowMaximized(appId, maximized) {
      requireApplicationId(appId);
      if (typeof maximized !== "boolean") throw new TypeError("最大化偏好必须是布尔值");
      const stored = parseObject(safeRead(localStorage, STORAGE_KEYS.windowMaximized));
      const preferences = sanitizeWindowPreferences(stored);
      preferences[appId] = maximized;
      return safeWrite(
        localStorage,
        STORAGE_KEYS.windowMaximized,
        JSON.stringify(preferences),
      );
    },
    readUiPreferences() {
      return Object.freeze(
        sanitizeUiPreferences(parseObject(safeRead(localStorage, STORAGE_KEYS.uiPreferences))),
      );
    },
    writeUiPreferences(preferences) {
      const sanitized = sanitizeUiPreferences(preferences, { strict: true });
      return safeWrite(localStorage, STORAGE_KEYS.uiPreferences, JSON.stringify(sanitized));
    },
  });
}
