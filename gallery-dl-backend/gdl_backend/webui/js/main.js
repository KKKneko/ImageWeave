import { createApiClient } from "./core/api.js";
import { initializeDesktop } from "./core/desktop.js";
import { createPollingManager } from "./core/polling.js";
import { createStorageService } from "./core/storage.js";
import { createStore } from "./core/store.js";
import { initializeCloudBackground } from "./components/cloud-background.js";
import { createDialogController } from "./components/dialog.js";
import { createStatusBadge } from "./components/status.js";
import { initializeTaskbarSummary } from "./components/taskbar-summary.js";

let desktopController = null;
let summaryController = null;
let polling = null;
let dialogs = null;
let stopCloud = () => {};
let destroyed = false;

const destroy = () => {
  if (destroyed) return;
  destroyed = true;
  summaryController?.destroy();
  desktopController?.destroy();
  dialogs?.destroy();
  polling?.destroy();
  stopCloud();
  window.removeEventListener("pagehide", destroy);
};

try {
  stopCloud = initializeCloudBackground();
  const api = createApiClient();
  const store = createStore();
  const storage = createStorageService();
  polling = createPollingManager();
  dialogs = createDialogController();
  desktopController = initializeDesktop(document, {
    api,
    store,
    polling,
    storage,
    dialogs,
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
