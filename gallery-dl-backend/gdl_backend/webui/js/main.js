import { createApiClient } from "./core/api.js";
import { initializeDesktop } from "./core/desktop.js";
import { createMotionController } from "./core/motion.js";
import { createPersonalizationRuntime } from "./core/personalization.js";
import { createWallpaperStorage } from "./core/wallpaper-storage.js";
import { createPollingManager } from "./core/polling.js";
import { createStorageService } from "./core/storage.js";
import { createInitialState, createStore } from "./core/store.js";
import { createDialogController } from "./components/dialog.js";
import { createStatusBadge } from "./components/status.js";
import { initializeTaskbarSummary } from "./components/taskbar-summary.js";

let desktopController = null;
let motionController = null;
let personalizationController = null;
let wallpaperStorage = null;
let summaryController = null;
let polling = null;
let dialogs = null;
let destroyed = false;

const destroy = () => {
  if (destroyed) return;
  destroyed = true;
  summaryController?.destroy();
  desktopController?.destroy();
  dialogs?.destroy();
  polling?.destroy();
  personalizationController?.destroy();
  wallpaperStorage?.destroy();
  motionController?.destroy();
  window.removeEventListener("pagehide", destroy);
};

try {
  const storage = createStorageService();
  try {
    motionController = createMotionController({
      root: document.documentElement,
      storage,
    });
  } catch {
    console.warn("动效偏好初始化失败；桌面将使用安全的静态回退");
  }
  try {
    wallpaperStorage = createWallpaperStorage();
  } catch {
    wallpaperStorage = null;
    console.warn("本地壁纸存储初始化失败；桌面与纯色设置仍可正常使用");
  }
  personalizationController = createPersonalizationRuntime({
    wallpaper: document.querySelector("[data-desktop-wallpaper]"),
    wallpaperImage: document.querySelector("[data-desktop-wallpaper-image]"),
    wallpaperMask: document.querySelector("[data-desktop-wallpaper-mask]"),
    windowLayer: document.querySelector("[data-window-layer]"),
    themeRoot: document.documentElement,
    storage,
    wallpaperStorage,
    motion: motionController,
  });
  const api = createApiClient();
  const taskbarHeight = Number.parseFloat(
    getComputedStyle(document.documentElement)
      .getPropertyValue("--imageweave-taskbar-height"),
  );
  const windows = storage.readWindowLayout({
    width: window.innerWidth,
    height: window.innerHeight,
  }, {
    taskbarHeight: Number.isFinite(taskbarHeight) && taskbarHeight >= 0
      ? taskbarHeight
      : 0,
  });
  const store = createStore({ initialState: createInitialState({ windows }) });
  polling = createPollingManager();
  dialogs = createDialogController();
  desktopController = initializeDesktop(document, {
    api,
    store,
    polling,
    storage,
    dialogs,
    motion: motionController,
    personalization: personalizationController,
  });
  summaryController = initializeTaskbarSummary(document, {
    api,
    store,
    actions: desktopController.actions,
    polling,
  });
  window.addEventListener("pagehide", destroy);
} catch {
  destroy();
  console.error("ImageWeave 桌面壳层初始化失败");
  const notice = document.createElement("section");
  notice.className = "shell-error";
  notice.setAttribute("role", "alert");
  notice.append(
    createStatusBadge("error", "桌面初始化失败"),
    Object.assign(document.createElement("p"), {
      textContent: "请刷新页面；若问题持续存在，请检查静态资源是否完整。",
    }),
  );
  document.body.append(notice);
}
