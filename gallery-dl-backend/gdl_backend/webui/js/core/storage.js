import { getApplicationById } from "./app-registry.js";
import {
  normalizePersonalizationPreferences,
  PERSONALIZATION_PREFERENCE_KEYS,
  projectPersonalizationPreferences,
} from "./personalization-model.js";

export const STORAGE_KEYS = Object.freeze({
  currentApp: "imageweave.ui:current-app",
  activeBatch: "imageweave.ui:active-batch",
  windowLayout: "imageweave.window-layout.v1",
  uiPreferences: "imageweave.ui:ui-preferences",
});

const BATCH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WINDOW_STATES = new Set(["normal", "maximized", "minimized"]);
const WINDOW_RECT_KEYS = Object.freeze(["x", "y", "w", "h"]);
const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 720 });
const DEFAULT_WINDOW_RECT = Object.freeze({ x: 160, y: 64, w: 800, h: 560 });
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

function hasExactDataKeys(value, expectedKeys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== expectedKeys.length
      || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
    ) return false;
    return keys.every((key) => Object.prototype.hasOwnProperty.call(descriptors[key], "value"));
  } catch {
    return false;
  }
}

function normalizeViewport(viewport) {
  if (!hasExactDataKeys(viewport, ["width", "height"])) return DEFAULT_VIEWPORT;
  const width = ownDataValue(viewport, "width");
  const height = ownDataValue(viewport, "height");
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    return DEFAULT_VIEWPORT;
  }
  return { width, height };
}

function projectWindowRect(value) {
  if (!hasExactDataKeys(value, WINDOW_RECT_KEYS)) throw new TypeError("窗口位置无效");
  const rect = {};
  for (const key of WINDOW_RECT_KEYS) {
    const field = ownDataValue(value, key);
    if (!Number.isFinite(field)) throw new TypeError("窗口位置无效");
    rect[key] = field;
  }
  if (rect.w < 360 || rect.h < 240) throw new TypeError("窗口尺寸过小");
  return rect;
}

export function clampWindowRect(rect, viewport) {
  const projected = projectWindowRect(rect);
  const normalizedViewport = normalizeViewport(viewport);
  return {
    ...projected,
    x: Math.min(
      Math.max(projected.x, 32 - projected.w),
      normalizedViewport.width - 32,
    ),
    y: Math.min(
      Math.max(projected.y, 32 - projected.h),
      normalizedViewport.height - 32,
    ),
  };
}

function projectWindowRecord(value, { readyOnly = false, viewport = null } = {}) {
  if (!hasExactDataKeys(value, ["appId", "windowState", "rect"])) {
    throw new TypeError("窗口记录无效");
  }
  const appId = ownDataValue(value, "appId");
  const app = typeof appId === "string" ? getApplicationById(appId) : null;
  if (!app) throw new TypeError("应用 ID 无效");
  if (readyOnly && app.availability !== "ready") return null;
  const windowState = ownDataValue(value, "windowState");
  if (!WINDOW_STATES.has(windowState)) throw new TypeError("窗口状态无效");
  const rect = viewport
    ? clampWindowRect(ownDataValue(value, "rect"), viewport)
    : projectWindowRect(ownDataValue(value, "rect"));
  return { appId, windowState, rect };
}

function deduplicateWindowRecords(windows) {
  const result = [];
  for (const windowRecord of windows) {
    const existing = result.findIndex((item) => item.appId === windowRecord.appId);
    if (existing >= 0) result.splice(existing, 1);
    result.push(windowRecord);
  }
  return result;
}

export function createDefaultWindowLayout(viewport = DEFAULT_VIEWPORT) {
  return [{
    appId: "crawl",
    windowState: getApplicationById("crawl").defaultWindowState,
    rect: clampWindowRect(DEFAULT_WINDOW_RECT, viewport),
  }];
}

function deserializeWindowLayout(serialized, viewport) {
  const stored = parseObject(serialized);
  if (!stored || !hasExactDataKeys(stored, ["windows"])) return null;
  const rawWindows = ownDataValue(stored, "windows");
  if (!Array.isArray(rawWindows)) return null;
  const windows = [];
  try {
    for (const value of rawWindows) {
      if (!hasExactDataKeys(value, ["appId", "windowState", "rect"])) return null;
      const appId = ownDataValue(value, "appId");
      if (typeof appId !== "string") return null;
      const app = getApplicationById(appId);
      if (!app || app.availability !== "ready") continue;
      windows.push(projectWindowRecord(value, { readyOnly: true, viewport }));
    }
  } catch {
    return null;
  }
  return deduplicateWindowRecords(windows);
}

function projectWindowLayout(windows) {
  if (!Array.isArray(windows)) throw new TypeError("窗口布局必须是数组");
  const projected = [];
  for (const value of windows) {
    const windowRecord = projectWindowRecord(value, { readyOnly: true });
    if (windowRecord) projected.push(windowRecord);
  }
  return deduplicateWindowRecords(projected);
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
    readWindowLayout(viewport = DEFAULT_VIEWPORT) {
      const normalizedViewport = normalizeViewport(viewport);
      const serialized = safeRead(localStorage, STORAGE_KEYS.windowLayout);
      const restored = serialized === null
        ? null
        : deserializeWindowLayout(serialized, normalizedViewport);
      const windows = restored ?? createDefaultWindowLayout(normalizedViewport);
      if (serialized !== null) {
        const repaired = JSON.stringify({ windows });
        if (serialized !== repaired) safeWrite(localStorage, STORAGE_KEYS.windowLayout, repaired);
      }
      return windows;
    },
    writeWindowLayout(windows) {
      const projected = projectWindowLayout(windows);
      return safeWrite(
        localStorage,
        STORAGE_KEYS.windowLayout,
        JSON.stringify({ windows: projected }),
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
