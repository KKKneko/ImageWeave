import { getApplicationById } from "./app-registry.js";
import {
  normalizePersonalizationPreferences,
  PERSONALIZATION_PREFERENCE_KEYS,
  projectPersonalizationPreferences,
} from "./personalization-model.js";

export const STORAGE_KEYS = Object.freeze({
  currentApp: "imageweave.ui:current-app",
  activeBatch: "imageweave.ui:active-batch",
  windowMaximized: "imageweave.ui:window-maximized",
  uiPreferences: "imageweave.ui:ui-preferences",
});

const BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const LEGACY_ANIMATION_MODES = new Map([
  ["system", "on"],
  ["reduced", "off"],
]);
const TASKBAR_DENSITIES = new Set(["comfortable", "compact"]);
const UI_PREFERENCE_KEYS = new Set([
  ...PERSONALIZATION_PREFERENCE_KEYS,
  "taskbarDensity",
]);

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

function ownDataValue(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeUiPreferences(value) {
  const personalization = normalizePersonalizationPreferences(value);
  const legacyAnimation = LEGACY_ANIMATION_MODES.get(ownDataValue(value, "animations"));
  const result = {
    ...personalization,
    ...(legacyAnimation ? { animations: legacyAnimation } : {}),
  };
  const taskbarDensity = ownDataValue(value, "taskbarDensity");
  if (TASKBAR_DENSITIES.has(taskbarDensity)) result.taskbarDensity = taskbarDensity;
  return Object.freeze(result);
}

function strictUiPreferenceDescriptors(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("UI 偏好必须是普通对象");
  }
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch {
    throw new TypeError("UI 偏好必须是普通对象");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("UI 偏好必须是普通对象");
  }
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError("UI 偏好必须是普通对象");
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !UI_PREFERENCE_KEYS.has(key)) {
      throw new TypeError("UI 偏好包含未知字段");
    }
    const descriptor = Object.getOwnPropertyDescriptor(descriptors, key)?.value;
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new TypeError("UI 偏好字段必须是数据值");
    }
  }
  return descriptors;
}

function projectUiPreferences(value) {
  const descriptors = strictUiPreferenceDescriptors(value);
  const personalizationInput = {};
  for (const key of PERSONALIZATION_PREFERENCE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(descriptors, key)?.value;
    if (descriptor) personalizationInput[key] = descriptor.value;
  }
  const result = { ...projectPersonalizationPreferences(personalizationInput) };
  const taskbarDescriptor = Object.getOwnPropertyDescriptor(
    descriptors,
    "taskbarDensity",
  )?.value;
  if (taskbarDescriptor) {
    if (!TASKBAR_DENSITIES.has(taskbarDescriptor.value)) {
      throw new TypeError("UI 偏好 taskbarDensity 无效");
    }
    result.taskbarDensity = taskbarDescriptor.value;
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
      const serialized = safeRead(localStorage, STORAGE_KEYS.uiPreferences);
      const stored = parseObject(serialized);
      const preferences = sanitizeUiPreferences(stored);
      if (serialized !== null) {
        const migrated = JSON.stringify(preferences);
        if (serialized !== migrated) {
          safeWrite(localStorage, STORAGE_KEYS.uiPreferences, migrated);
        }
      }
      return preferences;
    },
    writeUiPreferences(preferences) {
      const projected = projectUiPreferences(preferences);
      return safeWrite(localStorage, STORAGE_KEYS.uiPreferences, JSON.stringify(projected));
    },
    writePersonalizationPreferences(preferences) {
      const projected = { ...projectPersonalizationPreferences(preferences) };
      const stored = sanitizeUiPreferences(
        parseObject(safeRead(localStorage, STORAGE_KEYS.uiPreferences)),
      );
      if (TASKBAR_DENSITIES.has(stored.taskbarDensity)) {
        projected.taskbarDensity = stored.taskbarDensity;
      }
      return safeWrite(
        localStorage,
        STORAGE_KEYS.uiPreferences,
        JSON.stringify(projected),
      );
    },
  });
}
