export const POLLING_SCOPE_STATES = Object.freeze({
  OPEN: "open",
  MINIMIZED: "minimized",
  CLOSED: "closed",
  UNMANAGED: "unmanaged",
});

const APP_SCOPE_PREFIX = "app:";

function requireStore(store) {
  if (
    !store
    || typeof store.getState !== "function"
    || typeof store.subscribe !== "function"
  ) {
    throw new TypeError("轮询聚焦适配器需要可订阅的状态仓库");
  }
  return store;
}

function readWindowState(store) {
  const ui = store.getState()?.ui;
  if (!ui || !Array.isArray(ui.windows)) {
    throw new TypeError("状态仓库缺少窗口栈");
  }
  return ui;
}

function scopeForAppId(appId) {
  return typeof appId === "string" && appId
    ? `${APP_SCOPE_PREFIX}${appId}`
    : null;
}

function projectSnapshot(store) {
  const ui = readWindowState(store);
  return Object.freeze({
    focusedScope: scopeForAppId(ui.focusedAppId),
    windows: Object.freeze(ui.windows.map((record) => Object.freeze({
      scope: scopeForAppId(record.appId),
      state: record.windowState === "minimized"
        ? POLLING_SCOPE_STATES.MINIMIZED
        : POLLING_SCOPE_STATES.OPEN,
    }))),
  });
}

/**
 * 将桌面 store 的 focusedAppId/windowStack 投影为轮询只读状态源。
 * 快照有意丢弃窗口矩形与业务状态，只保留调度所需的 scope 和生命周期。
 */
export function createStorePollingFocusSource(store) {
  requireStore(store);
  readWindowState(store);

  const getFocusedScope = () => (
    scopeForAppId(readWindowState(store).focusedAppId)
  );

  const getScopeState = (scope) => {
    if (typeof scope !== "string" || !scope.startsWith(APP_SCOPE_PREFIX)) {
      return POLLING_SCOPE_STATES.UNMANAGED;
    }
    const appId = scope.slice(APP_SCOPE_PREFIX.length);
    const record = readWindowState(store).windows.find((item) => item.appId === appId);
    if (!record) return POLLING_SCOPE_STATES.CLOSED;
    return record.windowState === "minimized"
      ? POLLING_SCOPE_STATES.MINIMIZED
      : POLLING_SCOPE_STATES.OPEN;
  };

  const subscribe = (listener) => {
    if (typeof listener !== "function") {
      throw new TypeError("轮询聚焦监听器必须是函数");
    }
    return store.subscribe(
      (state) => Object.freeze({
        focusedAppId: state.ui.focusedAppId,
        windows: state.ui.windows,
      }),
      () => listener(projectSnapshot(store)),
      {
        equality: (left, right) => (
          left.focusedAppId === right.focusedAppId
          && left.windows === right.windows
        ),
      },
    );
  };

  return Object.freeze({
    getFocusedScope,
    getScopeState,
    getSnapshot: () => projectSnapshot(store),
    subscribe,
  });
}
