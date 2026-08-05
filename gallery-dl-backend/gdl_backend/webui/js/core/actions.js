import { getApplicationById } from "./app-registry.js";
import { actionCreators, selectors } from "./store.js";

export const WINDOW_LAYOUT_DEBOUNCE_MS = 300;

export function createShellActions({
  store,
  router,
  storage,
  setTimeoutFn = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeoutFn = (timerId) => globalThis.clearTimeout(timerId),
}) {
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
  if (typeof setTimeoutFn !== "function" || typeof clearTimeoutFn !== "function") {
    throw new TypeError("actions 需要有效的定时器服务");
  }

  let layoutTimer = null;
  let layoutTimerGeneration = 0;
  let layoutPending = false;
  let interactionDepth = 0;
  let destroyed = false;

  const requireRegisteredAppId = (appId) => {
    if (typeof appId !== "string" || !getApplicationById(appId)) {
      throw new TypeError("跨应用导航目标无效");
    }
    return appId;
  };

  const windowStack = () => selectors.windowStack(store.getState());

  const currentWindow = () => selectors.windowView(store.getState());

  const targetWindow = (appId) => {
    const target = appId === undefined || appId === null
      ? currentWindow().appId
      : requireRegisteredAppId(appId);
    if (target === null) return null;
    return windowStack().find((item) => item.appId === target) || null;
  };

  const flushWindowLayout = () => {
    if (!layoutPending) return false;
    layoutPending = false;
    storage.writeWindowLayout(windowStack());
    return true;
  };

  const cancelLayoutTimer = () => {
    const timer = layoutTimer;
    layoutTimer = null;
    layoutTimerGeneration += 1;
    if (timer === null) return;
    try {
      clearTimeoutFn(timer);
    } catch {
      // 即使宿主取消失败，代际检查也会阻止旧 callback 写入或干扰新 timer。
    }
  };

  const armWindowLayoutWrite = () => {
    if (destroyed || interactionDepth > 0 || !layoutPending) return;
    // 每次布局变化都替换旧任务，静默期必须从最后一次变化重新计时。
    cancelLayoutTimer();
    const generation = layoutTimerGeneration;
    try {
      const timer = setTimeoutFn(() => {
        if (generation !== layoutTimerGeneration) return;
        layoutTimer = null;
        layoutTimerGeneration += 1;
        if (destroyed || interactionDepth > 0) return;
        flushWindowLayout();
      }, WINDOW_LAYOUT_DEBOUNCE_MS);
      if (generation === layoutTimerGeneration) layoutTimer = timer;
    } catch {
      // 页面销毁时仍会同步落定最后一个已派发的矩形。
      if (generation === layoutTimerGeneration) {
        layoutTimer = null;
        layoutTimerGeneration += 1;
      }
    }
  };

  const persistWindowLayout = () => {
    if (destroyed) return;
    layoutPending = true;
    armWindowLayoutWrite();
  };

  const dispatchWindowAction = (windowAction) => {
    const previous = windowStack();
    store.dispatch(windowAction);
    const changed = windowStack() !== previous;
    if (changed) persistWindowLayout();
    return changed;
  };

  const syncFocusedRoute = () => {
    const appId = selectors.focusedAppId(store.getState());
    if (appId === null) return;
    storage.writeCurrentApp(appId);
    router.navigate(appId);
  };

  const navigateToApp = (appId) => {
    router.navigate(requireRegisteredAppId(appId));
  };

  const routeResolved = (app) => {
    const registered = app && getApplicationById(app.id);
    if (!registered || registered !== app) throw new TypeError("路由结果不是已注册应用");
    const existing = windowStack().find((record) => record.appId === app.id);
    const alreadyFocused = existing
      && existing.windowState !== "minimized"
      && selectors.focusedAppId(store.getState()) === app.id;
    if (!alreadyFocused) dispatchWindowAction(actionCreators.windowOpened(app.id));
    storage.writeCurrentApp(app.id);
  };

  return Object.freeze({
    navigateToApp,
    routeResolved,
    setStartMenuOpen(open) {
      store.dispatch(actionCreators.startMenuChanged(Boolean(open)));
    },
    minimizeWindow(appId) {
      const record = targetWindow(appId);
      if (!record || record.windowState === "minimized") return false;
      const changed = dispatchWindowAction(
        actionCreators.windowStateChanged(record.appId, "minimized"),
      );
      if (changed) syncFocusedRoute();
      return changed;
    },
    restoreWindow(appId) {
      const record = targetWindow(appId);
      if (!record) return false;
      const changed = dispatchWindowAction(actionCreators.windowOpened(record.appId));
      if (changed) syncFocusedRoute();
      return changed;
    },
    closeWindow(appId) {
      const record = targetWindow(appId);
      if (!record) return false;
      const changed = dispatchWindowAction(actionCreators.windowClosed(record.appId));
      if (changed) syncFocusedRoute();
      return changed;
    },
    focusWindow(appId) {
      const target = requireRegisteredAppId(appId);
      const record = targetWindow(target);
      if (!record || record.windowState === "minimized") return false;
      const changed = dispatchWindowAction(actionCreators.windowFocused(target));
      if (changed && selectors.focusedAppId(store.getState()) === target) syncFocusedRoute();
      return changed;
    },
    moveWindow(appId, rect) {
      const target = requireRegisteredAppId(appId);
      return dispatchWindowAction(actionCreators.windowMoved(target, rect));
    },
    toggleWindowMaximized(appId) {
      const record = targetWindow(appId);
      if (!record || record.windowState === "minimized") return false;
      const next = record.windowState === "maximized" ? "normal" : "maximized";
      return dispatchWindowAction(actionCreators.windowStateChanged(record.appId, next));
    },
    beginWindowInteraction() {
      if (destroyed) return false;
      interactionDepth += 1;
      // 聚焦 pointerdown 可能已排好布局写；交互期间必须完全禁止 storage 写入。
      cancelLayoutTimer();
      return true;
    },
    endWindowInteraction() {
      if (interactionDepth === 0) return false;
      interactionDepth -= 1;
      if (interactionDepth === 0) armWindowLayoutWrite();
      return true;
    },
    setActiveBatchId(batchId) {
      store.dispatch(actionCreators.activeBatchIdChanged(batchId));
      if (batchId) storage.writeActiveBatchId(batchId);
      else storage.clearActiveBatchId();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelLayoutTimer();
      interactionDepth = 0;
      // pagehide/destroy 是防抖的安全落定边界，不能丢失最后一次 pointerup 矩形。
      flushWindowLayout();
    },
  });
}
