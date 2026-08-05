import {
  copyPersonalizationPreferences,
  deriveInterfaceThemeTone,
  isValidInterfaceTheme,
  normalizePersonalizationPreferences,
  normalizeThemeHex,
  PERSONALIZATION_OPTIONS,
  personalizationPreferencesEqual,
  projectPersonalizationPreferences,
} from "./personalization-model.js";
import { probeWallpaperImageBlob } from "./wallpaper-image-import.js";
import {
  projectWallpaperImportResult,
  projectWallpaperRecord,
} from "./wallpaper-storage.js";

export const WALLPAPER_COLOR_CLASSES = Object.freeze({
  graphite: "desktop-wallpaper--graphite",
  slate: "desktop-wallpaper--slate",
  "deep-ocean": "desktop-wallpaper--deep-ocean",
  forest: "desktop-wallpaper--forest",
  "plum-gray": "desktop-wallpaper--plum-gray",
  "warm-paper": "desktop-wallpaper--warm-paper",
});

export const WALLPAPER_CUSTOM_CLASS = "desktop-wallpaper--custom";

export const WALLPAPER_FIT_CLASSES = Object.freeze({
  cover: "desktop-wallpaper--fit-cover",
  contain: "desktop-wallpaper--fit-contain",
  stretch: "desktop-wallpaper--fit-stretch",
  tile: "desktop-wallpaper--fit-tile",
});

export const WALLPAPER_POSITION_CLASSES = Object.freeze({
  "top-left": "desktop-wallpaper--position-top-left",
  top: "desktop-wallpaper--position-top",
  "top-right": "desktop-wallpaper--position-top-right",
  left: "desktop-wallpaper--position-left",
  center: "desktop-wallpaper--position-center",
  right: "desktop-wallpaper--position-right",
  "bottom-left": "desktop-wallpaper--position-bottom-left",
  bottom: "desktop-wallpaper--position-bottom",
  "bottom-right": "desktop-wallpaper--position-bottom-right",
});

export const WALLPAPER_MASK_TONE_CLASSES = Object.freeze({
  dark: "desktop-wallpaper--mask-tone-dark",
  light: "desktop-wallpaper--mask-tone-light",
});

export const WALLPAPER_MASK_STRENGTH_CLASSES = Object.freeze(Object.fromEntries(
  PERSONALIZATION_OPTIONS.wallpaperMaskStrength.map((strength) => [
    strength,
    `desktop-wallpaper--mask-strength-${strength}`,
  ]),
));

export const WALLPAPER_BLUR_CLASSES = Object.freeze({
  off: "desktop-wallpaper--blur-off",
  soft: "desktop-wallpaper--blur-soft",
  medium: "desktop-wallpaper--blur-medium",
});

export const WINDOW_OPACITY_CLASSES = Object.freeze({
  solid: "window-layer--opacity-solid",
  subtle: "window-layer--opacity-subtle",
  soft: "window-layer--opacity-soft",
});

export const PERSONALIZATION_RUNTIME_CLASS_MAPS = Object.freeze({
  wallpaperFit: WALLPAPER_FIT_CLASSES,
  wallpaperPosition: WALLPAPER_POSITION_CLASSES,
  wallpaperMaskTone: WALLPAPER_MASK_TONE_CLASSES,
  wallpaperMaskStrength: WALLPAPER_MASK_STRENGTH_CLASSES,
  wallpaperBlur: WALLPAPER_BLUR_CLASSES,
  windowOpacity: WINDOW_OPACITY_CLASSES,
});

const WALLPAPER_PRESENTATION_FIELDS = Object.freeze([
  "wallpaperFit",
  "wallpaperPosition",
  "wallpaperMaskTone",
  "wallpaperMaskStrength",
  "wallpaperBlur",
]);

const NON_THEME_PREFERENCE_KEYS = Object.freeze(
  Object.keys(PERSONALIZATION_OPTIONS),
);

function onlyInterfaceThemeChanged(previous, next) {
  return (
    previous.themeAccent !== next.themeAccent
    || previous.themeSurface !== next.themeSurface
  ) && NON_THEME_PREFERENCE_KEYS.every((key) => previous[key] === next[key]);
}

function browserValue(name) {
  try {
    return globalThis[name];
  } catch {
    return undefined;
  }
}

function readPreferences(storage) {
  try {
    return normalizePersonalizationPreferences(storage?.readUiPreferences?.());
  } catch {
    return normalizePersonalizationPreferences(null);
  }
}

function readInlineThemeState(themeRoot) {
  try {
    const style = themeRoot?.style;
    if (
      typeof style?.getPropertyValue !== "function"
      || typeof style?.setProperty !== "function"
      || typeof style?.removeProperty !== "function"
      || typeof themeRoot?.getAttribute !== "function"
      || typeof themeRoot?.setAttribute !== "function"
      || typeof themeRoot?.removeAttribute !== "function"
    ) {
      return null;
    }
    const accent = style.getPropertyValue("--imageweave-accent");
    const surface = style.getPropertyValue("--imageweave-surface");
    const tone = themeRoot.getAttribute("data-theme-tone");
    const safeAccent = accent === "" || normalizeThemeHex(accent) === accent;
    const safeSurface = surface === "" || normalizeThemeHex(surface) === surface;
    const safeTone = tone === null || tone === "light" || tone === "dark";
    const hasInlineAccent = accent !== "";
    const hasInlineSurface = surface !== "";
    const completeInlinePair = hasInlineAccent === hasInlineSurface;
    const validInlinePair = !hasInlineAccent || isValidInterfaceTheme(accent, surface);
    const coherentTone = !hasInlineSurface
      || tone === deriveInterfaceThemeTone(surface);
    if (
      !safeAccent
      || !safeSurface
      || !safeTone
      || !completeInlinePair
      || !validInlinePair
      || !coherentTone
    ) {
      return null;
    }
    return Object.freeze({ style, accent, surface, tone });
  } catch {
    return null;
  }
}

function restoreInlineTheme(themeRoot, previous) {
  try {
    if (previous.tone === null) {
      themeRoot.removeAttribute("data-theme-tone");
    } else {
      themeRoot.setAttribute("data-theme-tone", previous.tone);
    }
  } catch {
    // 根色调恢复失败时仍继续恢复两个固定颜色 Token。
  }
  try {
    if (previous.surface === "") {
      previous.style.removeProperty("--imageweave-surface");
    } else {
      previous.style.setProperty("--imageweave-surface", previous.surface);
    }
  } catch {
    // 单个 Token 恢复失败不得阻断另一 Token 的尽力恢复。
  }
  try {
    if (previous.accent === "") {
      previous.style.removeProperty("--imageweave-accent");
    } else {
      previous.style.setProperty("--imageweave-accent", previous.accent);
    }
  } catch {
    // CSS 默认 Token 仍是最终安全回退。
  }
}

function applyInterfaceTheme(themeRoot, preferences) {
  let themeAccent;
  let themeSurface;
  let tone;
  try {
    const projected = projectPersonalizationPreferences(preferences);
    themeAccent = normalizeThemeHex(projected.themeAccent);
    themeSurface = normalizeThemeHex(projected.themeSurface);
    if (
      themeAccent !== projected.themeAccent
      || themeSurface !== projected.themeSurface
    ) {
      return false;
    }
    tone = deriveInterfaceThemeTone(themeSurface);
  } catch {
    return false;
  }

  // 无根节点时保留 tokens.css 的准确默认值；正式入口始终显式注入根元素。
  if (!themeRoot) return true;
  const previous = readInlineThemeState(themeRoot);
  if (!previous) return false;
  try {
    previous.style.setProperty("--imageweave-accent", themeAccent);
    previous.style.setProperty("--imageweave-surface", themeSurface);
    themeRoot.setAttribute("data-theme-tone", tone);
    return true;
  } catch {
    // setter 可能先写后抛；三个固定槽位均按写入前快照尽力恢复。
    restoreInlineTheme(themeRoot, previous);
    return false;
  }
}

function applyMappedClass(element, classMap, value, invalidMessage) {
  const selectedClass = classMap[value];
  if (!selectedClass) throw new TypeError(invalidMessage);
  try {
    for (const className of Object.values(classMap)) {
      element?.classList?.toggle?.(className, className === selectedClass);
    }
  } catch {
    // 壳层节点失效时保留基础 CSS 的实色安全回退。
  }
}

function applyWallpaperColor(wallpaper, colorId) {
  applyMappedClass(
    wallpaper,
    WALLPAPER_COLOR_CLASSES,
    colorId,
    "桌面纯色 ID 无效",
  );
}

function applyPresentationClasses(wallpaper, windowLayer, preferences) {
  const projected = projectPersonalizationPreferences(preferences);
  for (const field of WALLPAPER_PRESENTATION_FIELDS) {
    applyMappedClass(
      wallpaper,
      PERSONALIZATION_RUNTIME_CLASS_MAPS[field],
      projected[field],
      `桌面显示设置 ${field} 无效`,
    );
  }
  applyMappedClass(
    windowLayer,
    WINDOW_OPACITY_CLASSES,
    projected.windowOpacity,
    "窗口透明度设置无效",
  );
  return projected;
}

function applyCustomClass(wallpaper, enabled) {
  try {
    if (typeof wallpaper?.classList?.toggle !== "function") return false;
    wallpaper.classList.toggle(WALLPAPER_CUSTOM_CLASS, enabled === true);
    return true;
  } catch {
    // 固定图片类失败时由纯色层继续提供安全背景。
    return false;
  }
}

function fallbackMotionState(userMode) {
  return Object.freeze({
    userMode,
    systemReduced: false,
    effective: userMode === "on",
    limitedBySystem: false,
  });
}

function readMotionState(motion, userMode) {
  try {
    const state = motion?.getState?.();
    if (state && typeof state === "object") {
      return Object.freeze({
        userMode: state.userMode === "off" ? "off" : "on",
        systemReduced: state.systemReduced === true,
        effective: state.effective === true,
        limitedBySystem: state.limitedBySystem === true,
      });
    }
  } catch {
    // 动效控制器不可读时使用由安全草稿推导的静态状态。
  }
  return fallbackMotionState(userMode);
}

function fallbackToGraphite(preferences) {
  return {
    ...copyPersonalizationPreferences(preferences),
    wallpaperKind: "color",
    wallpaperColor: "graphite",
  };
}

function importResultImage(importResult) {
  if (!importResult || typeof importResult !== "object") {
    throw new TypeError("壁纸导入结果无效");
  }
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(importResult, "image");
  } catch {
    throw new TypeError("壁纸导入结果无效");
  }
  if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
    throw new TypeError("壁纸导入结果无效");
  }
  return projectWallpaperImportResult(descriptor.value);
}

function storageErrorCode(error, fallback) {
  try {
    return typeof error?.code === "string" ? error.code : fallback;
  } catch {
    return fallback;
  }
}

function storageFailure(error, operation) {
  const code = storageErrorCode(error, operation === "delete"
    ? "storage_delete_failed"
    : "storage_write_failed");
  if (code === "storage_quota_exceeded") {
    return Object.freeze({
      code,
      message: "浏览器存储空间不足；新图片未保存，旧壁纸仍被保留。",
    });
  }
  if (
    code === "indexeddb_unavailable"
    || code === "storage_open_failed"
    || code === "storage_blocked"
    || code === "storage_closed"
  ) {
    return Object.freeze({
      code: "indexeddb_unavailable",
      message: "当前浏览器无法使用本地壁纸存储；预览仍可取消，旧壁纸未改变。",
    });
  }
  return Object.freeze({
    code,
    message: operation === "delete"
      ? "无法删除已保存的本地壁纸；旧壁纸与设置仍被保留。"
      : "无法保存本地壁纸；旧壁纸与设置仍被保留。",
  });
}

function operationResult(ok, code, message, state) {
  return Object.freeze({ ok, code, message, state });
}

export function createPersonalizationRuntime({
  wallpaper = globalThis.document?.querySelector?.("[data-desktop-wallpaper]") ?? null,
  wallpaperImage = wallpaper?.querySelector?.("[data-desktop-wallpaper-image]") ?? null,
  wallpaperMask = wallpaper?.querySelector?.("[data-desktop-wallpaper-mask]") ?? null,
  windowLayer = globalThis.document?.querySelector?.("[data-window-layer]") ?? null,
  themeRoot = globalThis.document?.documentElement ?? null,
  storage = null,
  wallpaperStorage = null,
  motion = null,
  decodeWallpaperBlob = probeWallpaperImageBlob,
  urlApi = browserValue("URL"),
} = {}) {
  if (typeof decodeWallpaperBlob !== "function") {
    throw new TypeError("壁纸 Blob 解码探测器无效");
  }

  const wallpaperImageContent = wallpaperImage?.querySelector?.("img") ?? wallpaperImage;
  let committed = copyPersonalizationPreferences(readPreferences(storage));
  let draft = copyPersonalizationPreferences(committed);
  let storedImage = null;
  let pendingImage = null;
  let draftCustomSource = committed.wallpaperKind === "custom" ? "stored" : null;
  let wallpaperStorageStatus = wallpaperStorage ? "loading" : "unavailable";
  let activeObjectUrl = null;
  let activeImage = null;
  let activeImageSource = null;
  let activeImageFit = null;
  let destroyed = false;
  let applying = false;
  let operationInProgress = false;
  let currentOperation = null;
  let lifecycleVersion = 0;
  const ownedObjectUrls = new Set();
  const listeners = new Set();

  const selectedCustomImage = () => {
    if (draft.wallpaperKind !== "custom") return null;
    if (draftCustomSource === "pending") return pendingImage;
    if (draftCustomSource === "stored") return storedImage;
    return null;
  };

  const getState = () => {
    const selectedImage = selectedCustomImage();
    const customWallpaper = Object.freeze({
      loading: wallpaperStorageStatus === "loading",
      saved: storedImage !== null,
      pending: pendingImage !== null,
      available: storedImage !== null || pendingImage !== null,
      selectedReady: selectedImage !== null,
      storageAvailable: wallpaperStorageStatus === "ready",
    });
    return Object.freeze({
      committed: Object.freeze({ ...committed }),
      draft: Object.freeze({ ...draft }),
      dirty: !personalizationPreferencesEqual(draft, committed)
        || draftCustomSource === "pending",
      busy: operationInProgress,
      customWallpaper,
      motion: readMotionState(motion, draft.animations),
    });
  };

  const publish = () => {
    const state = getState();
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        // 单个设置视图失败不得破坏全局壁纸与无障碍动效状态。
      }
    }
    return state;
  };

  const revokeObjectUrl = (objectUrl) => {
    if (!objectUrl || !ownedObjectUrls.delete(objectUrl)) return;
    try {
      urlApi?.revokeObjectURL?.(objectUrl);
    } catch {
      // URL 已失效或页面正在卸载时仍应继续清理私有引用。
    }
  };

  const clearImageReferences = () => {
    // 必须先断开 DOM 对 Object URL 的全部引用，再允许调用 revokeObjectURL。
    try {
      wallpaperImageContent?.removeAttribute?.("src");
    } catch {
      // 继续清理平铺背景引用。
    }
    try {
      const style = wallpaperImage?.style;
      if (typeof style?.removeProperty === "function") {
        style.removeProperty("background-image");
      } else if (style && typeof style === "object") {
        style.backgroundImage = "";
      }
    } catch {
      // 继续隐藏图片和遮罩层；基础 graphite 始终留在底层。
    }
  };

  const hideCustomLayers = () => {
    try {
      if (wallpaperImage) wallpaperImage.hidden = true;
    } catch {
      // 壁纸节点失效时仍继续撤销私有 URL。
    }
    try {
      if (wallpaperMask) wallpaperMask.hidden = true;
    } catch {
      // 独立遮罩不可用时由 custom 类移除提供第二重回退。
    }
    applyCustomClass(wallpaper, false);
  };

  const clearDisplayedImage = () => {
    clearImageReferences();
    hideCustomLayers();
    activeObjectUrl = null;
    activeImage = null;
    activeImageSource = null;
    activeImageFit = null;
    for (const objectUrl of [...ownedObjectUrls]) revokeObjectUrl(objectUrl);
  };

  const attachOwnedObjectUrl = (objectUrl, fit, isCurrent) => {
    if (
      destroyed
      || !isCurrent()
      || typeof objectUrl !== "string"
      || !objectUrl.startsWith("blob:")
      || !ownedObjectUrls.has(objectUrl)
      || !WALLPAPER_FIT_CLASSES[fit]
      || !wallpaperImage
      || !wallpaperImageContent
      || !wallpaperMask
    ) {
      throw new TypeError("壁纸显示引用无效");
    }

    clearImageReferences();
    if (destroyed || !isCurrent()) throw new Error("壁纸显示操作已取消");
    if (fit === "tile") {
      if (typeof wallpaperImage.style?.setProperty !== "function") {
        throw new TypeError("当前壁纸层不支持平铺");
      }
      // 这是唯一受控内联样式：值只来自本闭包仍持有的 createObjectURL 结果。
      wallpaperImage.style.setProperty(
        "background-image",
        `url(${JSON.stringify(objectUrl)})`,
      );
    } else {
      wallpaperImageContent.src = objectUrl;
    }
    if (destroyed || !isCurrent()) throw new Error("壁纸显示操作已取消");
    wallpaperImage.hidden = false;
    wallpaperMask.hidden = false;
    if (!applyCustomClass(wallpaper, true)) {
      throw new TypeError("壁纸显示样式无法应用");
    }
    if (destroyed || !isCurrent()) throw new Error("壁纸显示操作已取消");
  };

  const restorePreviousDisplay = (
    previousUrl,
    previousImage,
    previousSource,
    previousFit,
  ) => {
    if (destroyed) return;
    if (previousUrl && ownedObjectUrls.has(previousUrl)) {
      try {
        attachOwnedObjectUrl(previousUrl, previousFit, () => !destroyed);
        activeObjectUrl = previousUrl;
        activeImage = previousImage;
        activeImageSource = previousSource;
        activeImageFit = previousFit;
        return;
      } catch {
        clearImageReferences();
        revokeObjectUrl(previousUrl);
      }
    }
    activeObjectUrl = null;
    activeImage = null;
    activeImageSource = null;
    activeImageFit = null;
    hideCustomLayers();
  };

  const displayImage = (image, source, fit, isCurrent = () => !destroyed) => {
    if (destroyed || !isCurrent() || !WALLPAPER_FIT_CLASSES[fit]) return false;
    if (
      !wallpaperImage
      || !wallpaperImageContent
      || !wallpaperMask
      || typeof urlApi?.createObjectURL !== "function"
      || typeof urlApi?.revokeObjectURL !== "function"
    ) {
      return false;
    }

    if (activeImage?.blob === image?.blob && activeImageSource === source) {
      if (activeImageFit === fit) {
        try {
          wallpaperImage.hidden = false;
          wallpaperMask.hidden = false;
          if (!applyCustomClass(wallpaper, true)) {
            throw new TypeError("壁纸显示样式无法应用");
          }
        } catch {
          clearDisplayedImage();
          return false;
        }
        return !destroyed && isCurrent();
      }
      const previousFit = activeImageFit;
      try {
        attachOwnedObjectUrl(activeObjectUrl, fit, isCurrent);
        activeImageFit = fit;
        return true;
      } catch {
        clearImageReferences();
        if (!destroyed && isCurrent()) {
          try {
            attachOwnedObjectUrl(activeObjectUrl, previousFit, isCurrent);
            activeImageFit = previousFit;
          } catch {
            clearDisplayedImage();
          }
        }
        return false;
      }
    }

    const previousUrl = activeObjectUrl;
    const previousImage = activeImage;
    const previousSource = activeImageSource;
    const previousFit = activeImageFit;
    let nextUrl = null;
    try {
      nextUrl = urlApi.createObjectURL(image.blob);
      if (nextUrl) ownedObjectUrls.add(nextUrl);
      if (typeof nextUrl !== "string" || !nextUrl.startsWith("blob:")) {
        throw new TypeError("Object URL 无效");
      }
      if (destroyed || !isCurrent()) throw new Error("壁纸显示操作已取消");
      attachOwnedObjectUrl(nextUrl, fit, isCurrent);
    } catch {
      // attach 可能已经写入 src/background-image；必须先清引用再 revoke。
      clearImageReferences();
      revokeObjectUrl(nextUrl);
      restorePreviousDisplay(
        previousUrl,
        previousImage,
        previousSource,
        previousFit,
      );
      return false;
    }

    activeObjectUrl = nextUrl;
    activeImage = image;
    activeImageSource = source;
    activeImageFit = fit;
    // attach 已清除旧 src/background-image，此时才可撤销上一条 URL。
    revokeObjectUrl(previousUrl);
    return !destroyed && isCurrent();
  };

  const previewMotion = (mode) => {
    applying = true;
    try {
      motion?.previewUserMode?.(mode);
    } catch {
      // motion.js 已提供根属性安全回退；壁纸仍应继续应用。
    } finally {
      applying = false;
    }
  };

  const applyDraft = (isCurrent = () => !destroyed) => {
    const projected = applyPresentationClasses(wallpaper, windowLayer, draft);
    const themeApplied = applyInterfaceTheme(themeRoot, projected);
    const image = selectedCustomImage();
    applyWallpaperColor(
      wallpaper,
      projected.wallpaperKind === "custom" ? "graphite" : projected.wallpaperColor,
    );
    if (projected.wallpaperKind === "custom" && image) {
      if (!displayImage(image, draftCustomSource, projected.wallpaperFit, isCurrent)) {
        return Object.freeze({
          ok: false,
          themeApplied,
          imageApplied: false,
        });
      }
    } else {
      clearDisplayedImage();
    }
    previewMotion(projected.animations);
    return Object.freeze({
      ok: themeApplied,
      themeApplied,
      imageApplied: true,
    });
  };

  const requireActive = () => {
    if (destroyed) throw new Error("外观设置功能已关闭");
  };

  const persistPreferences = (preferences) => {
    try {
      return storage?.writePersonalizationPreferences?.(preferences) === true;
    } catch {
      return false;
    }
  };

  const finishOperation = (operation, ok, code, message) => {
    if (currentOperation === operation) {
      currentOperation = null;
      operationInProgress = false;
    }
    const state = destroyed ? getState() : publish();
    return operationResult(ok, code, message, state);
  };

  const beginOperation = () => {
    if (operationInProgress) return null;
    const operation = { cancelled: false };
    currentOperation = operation;
    operationInProgress = true;
    publish();
    return operation;
  };

  const operationIsCurrent = (operation) => (
    !destroyed
    && currentOperation === operation
    && operation?.cancelled !== true
  );

  const finishCancelledOperation = (operation) => finishOperation(
    operation,
    false,
    destroyed ? "destroyed" : "cancelled",
    destroyed
      ? "外观设置功能已关闭。"
      : "操作已取消；桌面保持最后提交状态。",
  );

  const cancelActiveOperation = () => {
    if (currentOperation) currentOperation.cancelled = true;
  };

  const confirmImageDecodes = async (image) => {
    const decoded = await decodeWallpaperBlob(image.blob, {
      mediaType: image.mediaType,
    });
    if (
      decoded?.width !== image.width
      || decoded?.height !== image.height
    ) {
      throw new TypeError("壁纸解码尺寸不匹配");
    }
    return true;
  };

  const recoverMissingCommittedCustom = () => {
    if (committed.wallpaperKind !== "custom") return false;
    committed = fallbackToGraphite(committed);
    if (draftCustomSource !== "pending") {
      if (draft.wallpaperKind === "custom") draft = fallbackToGraphite(draft);
      draftCustomSource = null;
      applyDraft();
    }
    // 启动恢复只做尽力持久化；失败不得阻断桌面或覆盖内存安全回退。
    persistPreferences(committed);
    return true;
  };

  const initializeStoredWallpaper = async () => {
    const version = lifecycleVersion;
    if (!wallpaperStorage || typeof wallpaperStorage.read !== "function") {
      wallpaperStorageStatus = "unavailable";
      recoverMissingCommittedCustom();
      if (!destroyed && version === lifecycleVersion) publish();
      return;
    }

    let rawRecord;
    try {
      rawRecord = await wallpaperStorage.read();
    } catch {
      if (destroyed || version !== lifecycleVersion) return;
      wallpaperStorageStatus = "unavailable";
      recoverMissingCommittedCustom();
      if (!destroyed && version === lifecycleVersion) publish();
      return;
    }
    if (destroyed || version !== lifecycleVersion) return;
    wallpaperStorageStatus = "ready";

    if (rawRecord === null) {
      storedImage = null;
      recoverMissingCommittedCustom();
      if (!destroyed && version === lifecycleVersion) publish();
      return;
    }

    let record;
    try {
      record = projectWallpaperRecord(rawRecord);
      await confirmImageDecodes(record);
    } catch {
      if (destroyed || version !== lifecycleVersion) return;
      try {
        await wallpaperStorage.remove?.();
      } catch {
        // 损坏记录按缺失处理；清理失败不阻断桌面壳层。
      }
      if (destroyed || version !== lifecycleVersion) return;
      storedImage = null;
      recoverMissingCommittedCustom();
      if (!destroyed && version === lifecycleVersion) publish();
      return;
    }
    if (destroyed || version !== lifecycleVersion) return;

    storedImage = record;
    if (draft.wallpaperKind === "custom" && draftCustomSource !== "pending") {
      draftCustomSource = "stored";
      const application = applyDraft();
      if (!application.imageApplied) {
        if (destroyed || version !== lifecycleVersion) return;
        draftCustomSource = null;
        recoverMissingCommittedCustom();
      }
    }
    if (!destroyed && version === lifecycleVersion) publish();
  };

  const unsubscribeMotion = typeof motion?.subscribe === "function"
    ? motion.subscribe(() => {
      if (!destroyed && !applying) publish();
    })
    : () => {};

  // 首帧只应用同步安全偏好；IndexedDB 打开、读取和解码始终留在独立异步边界。
  applyDraft();
  const initialization = Promise.resolve()
    .then(initializeStoredWallpaper)
    .catch(() => {
      if (destroyed) return;
      wallpaperStorageStatus = "unavailable";
      recoverMissingCommittedCustom();
      if (!destroyed) publish();
    });

  return Object.freeze({
    getState,
    ready() {
      return initialization.then(() => getState());
    },
    preview(preferences) {
      requireActive();
      if (operationInProgress) throw new Error("另一项外观设置操作正在进行");
      const next = copyPersonalizationPreferences(
        projectPersonalizationPreferences(preferences),
      );
      if (personalizationPreferencesEqual(next, draft)) return getState();

      let nextSource = draftCustomSource;
      if (next.wallpaperKind === "custom" && !selectedCustomImage()) {
        nextSource = pendingImage ? "pending" : storedImage ? "stored" : null;
      }

      const previousDraft = draft;
      const previousSource = draftCustomSource;
      const themeOnly = onlyInterfaceThemeChanged(previousDraft, next);
      draft = next;
      draftCustomSource = next.wallpaperKind === "custom" ? nextSource : null;
      if (themeOnly) {
        if (!applyInterfaceTheme(themeRoot, draft)) {
          draft = previousDraft;
          draftCustomSource = previousSource;
          throw new Error("外观预览暂时无法应用");
        }
        return publish();
      }
      if (!applyDraft().ok) {
        draft = previousDraft;
        draftCustomSource = previousSource;
        applyDraft();
        throw new Error("外观预览暂时无法应用");
      }
      if (next.wallpaperKind !== "custom") pendingImage = null;
      return publish();
    },
    selectCustomWallpaper() {
      requireActive();
      if (operationInProgress) {
        return operationResult(false, "busy", "另一项壁纸操作正在进行。", getState());
      }
      const image = pendingImage ?? storedImage;
      const source = pendingImage ? "pending" : storedImage ? "stored" : null;
      const previousDraft = draft;
      const previousSource = draftCustomSource;
      draft = {
        ...draft,
        wallpaperKind: "custom",
      };
      draftCustomSource = source;
      if (!applyDraft().ok) {
        draft = previousDraft;
        draftCustomSource = previousSource;
        applyDraft();
        return operationResult(
          false,
          "display_unavailable",
          "当前浏览器无法显示本地壁纸；桌面仍使用纯色背景。",
          getState(),
        );
      }
      const state = publish();
      if (image) {
        return operationResult(true, "custom_selected", "已预览本地图片。", state);
      }
      if (wallpaperStorageStatus === "loading") {
        return operationResult(
          false,
          "custom_loading",
          "正在检查已保存的本地图片；也可以选择一张新图片。",
          state,
        );
      }
      return operationResult(
        false,
        "custom_missing",
        "尚无可用的本地图片，请先选择 JPG、PNG 或 WebP 图片。",
        state,
      );
    },
    async previewCustomImage(importResult) {
      requireActive();
      const operation = beginOperation();
      if (!operation) {
        return operationResult(false, "busy", "另一项壁纸操作正在进行。", getState());
      }

      let image;
      try {
        image = importResultImage(importResult);
        await confirmImageDecodes(image);
        await initialization;
      } catch {
        if (!operationIsCurrent(operation)) return finishCancelledOperation(operation);
        return finishOperation(
          operation,
          false,
          "decode_failed",
          "处理后的图片无法解码；当前壁纸未改变。",
        );
      }
      if (!operationIsCurrent(operation)) return finishCancelledOperation(operation);

      const previousPending = pendingImage;
      const previousDraft = draft;
      const previousSource = draftCustomSource;
      // 先让新图片归属于受控内存草稿，再创建用于 DOM 显示的 Object URL。
      // 即使 DOM setter 可重入并触发取消/销毁，新 URL 也始终能被统一撤销。
      pendingImage = image;
      draft = {
        ...draft,
        wallpaperKind: "custom",
      };
      draftCustomSource = "pending";

      if (!applyDraft(() => operationIsCurrent(operation)).ok) {
        if (!operationIsCurrent(operation)) return finishCancelledOperation(operation);
        pendingImage = previousPending;
        draft = previousDraft;
        draftCustomSource = previousSource;
        applyDraft();
        return finishOperation(
          operation,
          false,
          "display_unavailable",
          "当前浏览器无法显示本地图片；当前壁纸未改变。",
        );
      }
      if (!operationIsCurrent(operation)) return finishCancelledOperation(operation);

      return finishOperation(
        operation,
        true,
        "preview_ready",
        "本地图片可以预览，点击“应用”后保存。",
      );
    },
    async commit() {
      requireActive();
      const initialState = getState();
      if (!initialState.dirty) {
        return operationResult(true, "unchanged", "当前没有待应用更改。", initialState);
      }
      const operation = beginOperation();
      if (!operation) {
        return operationResult(false, "busy", "另一项壁纸操作正在进行。", getState());
      }

      const preferencesToCommit = copyPersonalizationPreferences(draft);
      const previousPreferences = copyPersonalizationPreferences(committed);
      const imageToCommit = draft.wallpaperKind === "custom"
        && draftCustomSource === "pending"
        ? pendingImage
        : null;
      if (draft.wallpaperKind === "custom" && !selectedCustomImage()) {
        return finishOperation(
          operation,
          false,
          "custom_missing",
          "尚无可应用的本地图片，请先选择并完成处理。",
        );
      }

      if (imageToCommit) {
        await initialization;
        if (!operationIsCurrent(operation)) return finishCancelledOperation(operation);
        if (
          !wallpaperStorage
          || wallpaperStorageStatus !== "ready"
          || typeof wallpaperStorage.snapshot !== "function"
          || typeof wallpaperStorage.replace !== "function"
          || typeof wallpaperStorage.restore !== "function"
        ) {
          return finishOperation(
            operation,
            false,
            "indexeddb_unavailable",
            "当前浏览器无法保存本地图片；预览仍保留，原壁纸未改变。",
          );
        }

        let snapshot;
        try {
          snapshot = await wallpaperStorage.snapshot();
        } catch (error) {
          if (!operationIsCurrent(operation)) return finishCancelledOperation(operation);
          const failure = storageFailure(error, "write");
          return finishOperation(operation, false, failure.code, failure.message);
        }
        if (!operationIsCurrent(operation)) return finishCancelledOperation(operation);

        let replacement;
        try {
          replacement = await wallpaperStorage.replace(imageToCommit);
        } catch (error) {
          if (!operationIsCurrent(operation)) return finishCancelledOperation(operation);
          const failure = storageFailure(error, "write");
          return finishOperation(operation, false, failure.code, failure.message);
        }

        const rollbackImage = async () => {
          try {
            await wallpaperStorage.restore(snapshot);
            return true;
          } catch {
            return false;
          }
        };

        if (!operationIsCurrent(operation)) {
          const restored = await rollbackImage();
          if (restored) return finishCancelledOperation(operation);
          return finishOperation(
            operation,
            false,
            "rollback_failed",
            "操作已取消，但浏览器未能确认旧壁纸恢复；请勿关闭页面并释放浏览器存储空间。",
          );
        }

        if (!persistPreferences(preferencesToCommit)) {
          const restored = await rollbackImage();
          if (!operationIsCurrent(operation) && restored) {
            return finishCancelledOperation(operation);
          }
          return finishOperation(
            operation,
            false,
            restored ? "preference_storage_unavailable" : "rollback_failed",
            restored
              ? "浏览器无法保存外观设置；新图片未保存，旧壁纸已恢复。"
              : "保存外观设置失败，且浏览器未能确认旧壁纸恢复；请勿关闭页面并释放浏览器存储空间。",
          );
        }

        if (!operationIsCurrent(operation)) {
          const preferencesRestored = persistPreferences(previousPreferences);
          const imageRestored = await rollbackImage();
          if (preferencesRestored && imageRestored) {
            return finishCancelledOperation(operation);
          }
          return finishOperation(
            operation,
            false,
            "rollback_failed",
            "操作已取消，但浏览器未能确认完整旧设置恢复；请勿关闭页面。",
          );
        }

        storedImage = replacement;
        pendingImage = null;
        draft = copyPersonalizationPreferences(preferencesToCommit);
        draftCustomSource = "stored";
        if (activeImage?.blob === imageToCommit.blob) {
          activeImage = replacement;
          activeImageSource = "stored";
        }
        committed = copyPersonalizationPreferences(preferencesToCommit);
        applyDraft();
        return finishOperation(
          operation,
          true,
          "saved",
          "本地壁纸和外观设置已保存。",
        );
      }

      if (!persistPreferences(preferencesToCommit)) {
        return finishOperation(
          operation,
          false,
          "preference_storage_unavailable",
          "浏览器无法保存设置，原设置未改变。",
        );
      }
      if (!operationIsCurrent(operation)) {
        const restored = persistPreferences(previousPreferences);
        return restored
          ? finishCancelledOperation(operation)
          : finishOperation(
              operation,
              false,
              "rollback_failed",
              "操作已取消，但浏览器未能确认旧设置恢复；请勿关闭页面。",
            );
      }
      committed = copyPersonalizationPreferences(preferencesToCommit);
      draft = copyPersonalizationPreferences(preferencesToCommit);
      applyDraft();
      return finishOperation(
        operation,
        true,
        "saved",
        "外观设置已保存。",
      );
    },
    cancel() {
      requireActive();
      cancelActiveOperation();
      pendingImage = null;
      draft = copyPersonalizationPreferences(committed);
      draftCustomSource = committed.wallpaperKind === "custom" && storedImage
        ? "stored"
        : null;
      applyDraft();
      return publish();
    },
    async deleteCustomWallpaper() {
      requireActive();
      const operation = beginOperation();
      if (!operation) {
        return operationResult(false, "busy", "另一项壁纸操作正在进行。", getState());
      }
      await initialization;
      if (!operationIsCurrent(operation)) return finishCancelledOperation(operation);
      if (
        !wallpaperStorage
        || wallpaperStorageStatus !== "ready"
        || typeof wallpaperStorage.snapshot !== "function"
        || typeof wallpaperStorage.remove !== "function"
        || typeof wallpaperStorage.restore !== "function"
      ) {
        return finishOperation(
          operation,
          false,
          "indexeddb_unavailable",
          "当前浏览器无法访问本地壁纸存储；旧壁纸与设置未改变。",
        );
      }

      let snapshot;
      try {
        snapshot = await wallpaperStorage.snapshot();
      } catch (error) {
        if (!operationIsCurrent(operation)) return finishCancelledOperation(operation);
        const failure = storageFailure(error, "delete");
        return finishOperation(operation, false, failure.code, failure.message);
      }
      if (!operationIsCurrent(operation)) return finishCancelledOperation(operation);
      if (snapshot === null && storedImage === null) {
        return finishOperation(
          operation,
          false,
          "custom_missing",
          "没有可删除的已保存本地壁纸。",
        );
      }

      try {
        await wallpaperStorage.remove();
      } catch (error) {
        if (!operationIsCurrent(operation)) return finishCancelledOperation(operation);
        const failure = storageFailure(error, "delete");
        return finishOperation(operation, false, failure.code, failure.message);
      }

      const rollbackImage = async () => {
        try {
          await wallpaperStorage.restore(snapshot);
          return true;
        } catch {
          return false;
        }
      };
      if (!operationIsCurrent(operation)) {
        const restored = await rollbackImage();
        if (restored) return finishCancelledOperation(operation);
        return finishOperation(
          operation,
          false,
          "rollback_failed",
          "删除已取消，但浏览器未能确认旧壁纸恢复；请勿关闭页面。",
        );
      }

      const previousPreferences = copyPersonalizationPreferences(committed);
      const fallback = fallbackToGraphite(committed);
      if (!persistPreferences(fallback)) {
        const restored = await rollbackImage();
        if (!operationIsCurrent(operation) && restored) {
          return finishCancelledOperation(operation);
        }
        return finishOperation(
          operation,
          false,
          restored ? "preference_storage_unavailable" : "rollback_failed",
          restored
            ? "浏览器无法保存外观设置；删除已取消，旧壁纸已恢复。"
            : "删除后的外观设置保存失败，且浏览器未能确认旧壁纸恢复；请勿关闭页面。",
        );
      }

      if (!operationIsCurrent(operation)) {
        const preferencesRestored = persistPreferences(previousPreferences);
        const imageRestored = await rollbackImage();
        if (preferencesRestored && imageRestored) {
          return finishCancelledOperation(operation);
        }
        return finishOperation(
          operation,
          false,
          "rollback_failed",
          "删除已取消，但浏览器未能确认完整旧设置恢复；请勿关闭页面。",
        );
      }

      storedImage = null;
      pendingImage = null;
      committed = fallback;
      draft = copyPersonalizationPreferences(fallback);
      draftCustomSource = null;
      applyDraft();
      return finishOperation(
        operation,
        true,
        "deleted",
        "自定义壁纸已删除，桌面已恢复默认石墨纯色。",
      );
    },
    subscribe(listener) {
      requireActive();
      if (typeof listener !== "function") throw new TypeError("个性化监听器必须是函数");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      lifecycleVersion += 1;
      cancelActiveOperation();
      currentOperation = null;
      operationInProgress = false;
      pendingImage = null;
      storedImage = null;
      draftCustomSource = null;
      clearDisplayedImage();
      try {
        const projected = applyPresentationClasses(
          wallpaper,
          windowLayer,
          committed,
        );
        applyWallpaperColor(
          wallpaper,
          projected.wallpaperKind === "color" ? projected.wallpaperColor : "graphite",
        );
      } catch {
        applyWallpaperColor(wallpaper, "graphite");
      }
      applyInterfaceTheme(themeRoot, committed);
      previewMotion(committed.animations);
      try {
        unsubscribeMotion();
      } catch {
        // 页面卸载时监听器清理失败不应阻断其余服务销毁。
      }
      listeners.clear();
    },
  });
}
