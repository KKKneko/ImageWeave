import { getApplicationById } from "./app-registry.js";
import { actionCreators } from "./store.js";

export function createShellActions({ store, router, storage }) {
  if (!store || typeof store.dispatch !== "function" || typeof store.getState !== "function") {
    throw new TypeError("actions 需要中央状态仓库");
  }
  if (!router || typeof router.navigate !== "function") throw new TypeError("actions 需要路由器");
  if (!storage || typeof storage.writeCurrentApp !== "function") {
    throw new TypeError("actions 需要安全存储服务");
  }

  const navigateToApp = (appId) => {
    if (typeof appId !== "string" || !getApplicationById(appId)) {
      throw new TypeError("跨应用导航目标无效");
    }
    router.navigate(appId);
  };

  const routeResolved = (app) => {
    const registered = app && getApplicationById(app.id);
    if (!registered || registered !== app) throw new TypeError("路由结果不是已注册应用");
    const preference = storage.readWindowMaximized(app.id);
    const windowState = preference === null
      ? app.defaultWindowState
      : preference
        ? "maximized"
        : "normal";
    store.dispatch(actionCreators.routeResolved(app.id, windowState));
    storage.writeCurrentApp(app.id);
  };

  return Object.freeze({
    navigateToApp,
    routeResolved,
    setStartMenuOpen(open) {
      store.dispatch(actionCreators.startMenuChanged(Boolean(open)));
    },
    minimizeWindow() {
      store.dispatch(actionCreators.windowVisibilityChanged("minimized"));
    },
    restoreWindow() {
      store.dispatch(actionCreators.windowVisibilityChanged("open"));
    },
    closeWindow() {
      store.dispatch(actionCreators.windowVisibilityChanged("closed"));
    },
    toggleWindowMaximized() {
      const state = store.getState();
      const next = state.ui.windowState === "maximized" ? "normal" : "maximized";
      store.dispatch(actionCreators.windowStateChanged(next));
      storage.writeWindowMaximized(state.ui.activeApp, next === "maximized");
    },
    setActiveBatchId(batchId) {
      store.dispatch(actionCreators.activeBatchIdChanged(batchId));
      if (batchId) storage.writeActiveBatchId(batchId);
      else storage.clearActiveBatchId();
    },
  });
}
