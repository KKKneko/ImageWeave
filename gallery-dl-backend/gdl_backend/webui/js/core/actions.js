import { getApplicationById } from "./app-registry.js";
import { actionCreators, selectors } from "./store.js";

export function createShellActions({ store, router, storage }) {
  if (!store || typeof store.dispatch !== "function" || typeof store.getState !== "function") {
    throw new TypeError("actions 需要中央状态仓库");
  }
  if (!router || typeof router.navigate !== "function") throw new TypeError("actions 需要路由器");
  if (
    !storage
    || typeof storage.writeCurrentApp !== "function"
    || typeof storage.writeWindowLayout !== "function"
  ) {
    throw new TypeError("actions 需要安全存储服务");
  }

  const requireRegisteredAppId = (appId) => {
    if (typeof appId !== "string" || !getApplicationById(appId)) {
      throw new TypeError("跨应用导航目标无效");
    }
    return appId;
  };

  const persistWindowLayout = () =>
    storage.writeWindowLayout(selectors.windowStack(store.getState()));

  const syncFocusedRoute = () => {
    const appId = selectors.focusedAppId(store.getState());
    if (appId === null) return;
    storage.writeCurrentApp(appId);
    router.navigate(appId);
  };

  const currentWindow = () => selectors.windowView(store.getState());

  const navigateToApp = (appId) => {
    router.navigate(requireRegisteredAppId(appId));
  };

  const routeResolved = (app) => {
    const registered = app && getApplicationById(app.id);
    if (!registered || registered !== app) throw new TypeError("路由结果不是已注册应用");
    store.dispatch(actionCreators.windowOpened(app.id));
    persistWindowLayout();
    storage.writeCurrentApp(app.id);
  };

  return Object.freeze({
    navigateToApp,
    routeResolved,
    setStartMenuOpen(open) {
      store.dispatch(actionCreators.startMenuChanged(Boolean(open)));
    },
    minimizeWindow() {
      const view = currentWindow();
      if (view.visibility !== "open" || view.appId === null) return;
      store.dispatch(actionCreators.windowStateChanged(view.appId, "minimized"));
      persistWindowLayout();
      syncFocusedRoute();
    },
    restoreWindow() {
      const view = currentWindow();
      if (view.visibility === "closed" || view.appId === null) return;
      store.dispatch(actionCreators.windowOpened(view.appId));
      persistWindowLayout();
      syncFocusedRoute();
    },
    closeWindow() {
      const view = currentWindow();
      if (view.visibility === "closed" || view.appId === null) return;
      store.dispatch(actionCreators.windowClosed(view.appId));
      persistWindowLayout();
      syncFocusedRoute();
    },
    focusWindow(appId) {
      const target = requireRegisteredAppId(appId);
      store.dispatch(actionCreators.windowFocused(target));
      if (selectors.focusedAppId(store.getState()) !== target) return;
      persistWindowLayout();
      syncFocusedRoute();
    },
    moveWindow(appId, rect) {
      store.dispatch(actionCreators.windowMoved(requireRegisteredAppId(appId), rect));
      persistWindowLayout();
    },
    toggleWindowMaximized() {
      const view = currentWindow();
      if (view.visibility !== "open" || view.appId === null) return;
      const next = view.windowState === "maximized" ? "normal" : "maximized";
      store.dispatch(actionCreators.windowStateChanged(view.appId, next));
      persistWindowLayout();
    },
    setActiveBatchId(batchId) {
      store.dispatch(actionCreators.activeBatchIdChanged(batchId));
      if (batchId) storage.writeActiveBatchId(batchId);
      else storage.clearActiveBatchId();
    },
  });
}
