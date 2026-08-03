import {
  PERSONALIZATION_DEFAULTS,
  PERSONALIZATION_OPTIONS,
} from "./personalization-model.js";

export const MOTION_MEDIA_QUERY = "(prefers-reduced-motion: reduce)";

const USER_MODES = new Set(PERSONALIZATION_OPTIONS.animations);

function readPreferences(storage) {
  try {
    const preferences = storage?.readUiPreferences?.();
    return preferences && typeof preferences === "object" && !Array.isArray(preferences)
      ? preferences
      : {};
  } catch {
    return {};
  }
}

function readSystemReduced(mediaQueryList) {
  try {
    return mediaQueryList?.matches === true;
  } catch {
    return false;
  }
}

function resolveMediaQueryList(matchMedia) {
  try {
    if (typeof matchMedia === "function") return matchMedia(MOTION_MEDIA_QUERY);
    if (typeof globalThis.matchMedia === "function") {
      return globalThis.matchMedia(MOTION_MEDIA_QUERY);
    }
  } catch {
    return null;
  }
  return null;
}

function setRootState(root, state) {
  const attributes = {
    "data-motion": state.userMode,
    "data-motion-effective": state.effective ? "on" : "off",
    "data-motion-limited": String(state.limitedBySystem),
  };
  for (const [name, value] of Object.entries(attributes)) {
    try {
      root?.setAttribute?.(name, value);
    } catch {
      // 根属性失败时仍允许桌面壳层继续启动。
    }
  }
}

export function createMotionController({
  root = globalThis.document?.documentElement ?? null,
  storage = null,
  matchMedia = null,
} = {}) {
  const storedMode = readPreferences(storage).animations;
  let userMode = USER_MODES.has(storedMode)
    ? storedMode
    : PERSONALIZATION_DEFAULTS.animations;
  const mediaQueryList = resolveMediaQueryList(matchMedia);
  let systemReduced = readSystemReduced(mediaQueryList);
  let destroyed = false;
  const listeners = new Set();

  const getState = () => {
    const effective = userMode === "on" && !systemReduced;
    return Object.freeze({
      userMode,
      systemReduced,
      effective,
      limitedBySystem: userMode === "on" && systemReduced,
    });
  };

  const publish = () => {
    const state = getState();
    setRootState(root, state);
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        // 单个设置视图监听失败不得影响动效安全状态。
      }
    }
  };

  const onSystemMotionChange = (event) => {
    if (destroyed) return;
    const next = typeof event?.matches === "boolean"
      ? event.matches
      : readSystemReduced(mediaQueryList);
    if (next === systemReduced) return;
    systemReduced = next;
    publish();
  };

  let removeSystemListener = () => {};
  try {
    if (
      typeof mediaQueryList?.addEventListener === "function"
      && typeof mediaQueryList?.removeEventListener === "function"
    ) {
      mediaQueryList.addEventListener("change", onSystemMotionChange);
      removeSystemListener = () => mediaQueryList.removeEventListener(
        "change",
        onSystemMotionChange,
      );
    } else if (
      typeof mediaQueryList?.addListener === "function"
      && typeof mediaQueryList?.removeListener === "function"
    ) {
      mediaQueryList.addListener(onSystemMotionChange);
      removeSystemListener = () => mediaQueryList.removeListener(onSystemMotionChange);
    }
  } catch {
    removeSystemListener = () => {};
  }

  const updateUserMode = (mode) => {
    if (!USER_MODES.has(mode)) throw new TypeError("动效模式必须是 on 或 off");
    if (mode !== userMode) {
      userMode = mode;
      publish();
    }
    return getState();
  };

  publish();

  return Object.freeze({
    getState,
    previewUserMode(mode) {
      return updateUserMode(mode);
    },
    setUserMode(mode) {
      updateUserMode(mode);
      try {
        if (typeof storage?.writeUiPreferences !== "function") return false;
        return storage.writeUiPreferences({
          ...readPreferences(storage),
          animations: mode,
        }) === true;
      } catch {
        return false;
      }
    },
    subscribe(listener) {
      if (typeof listener !== "function") throw new TypeError("动效监听器必须是函数");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      listeners.clear();
      try {
        removeSystemListener();
      } catch {
        // 旧浏览器监听器清理失败不阻断页面卸载。
      }
    },
  });
}
