import { getApplicationById } from "./app-registry.js";
import {
  clampRect,
  maximizedRect,
  nextRectForDrag,
  nextRectForResize,
  WINDOW_MIN_HEIGHT,
  WINDOW_MIN_WIDTH,
} from "./window-geometry.js";
import { selectors } from "./store.js";
import { createIcon } from "../components/icons.js";

const KEYBOARD_RESIZE_STEP = 16;
const MOBILE_QUERY = "(max-width: 767px)";

function sameRect(left, right) {
  return Boolean(left && right)
    && left.x === right.x
    && left.y === right.y
    && left.w === right.w
    && left.h === right.h;
}

function requireCloneElement(root, selector, Constructor = HTMLElement) {
  const element = root.querySelector(selector);
  if (!(element instanceof Constructor)) {
    throw new Error(`窗口模板缺少元素：${selector}`);
  }
  return element;
}

export function createWindowManager({
  windowLayer,
  windowTemplate,
  taskButton,
  store,
  actions,
  onMount,
  onUnmount,
  onVisibilityChange,
  onCloseFocus,
  onBeforeHide,
}) {
  const mobileViewport = window.matchMedia(MOBILE_QUERY);
  const windows = new Map();
  const hideRequests = new Map();
  const pendingRectRepairs = new Map();
  let currentStack = selectors.windowStack(store.getState());
  let currentView = selectors.windowView(store.getState());
  let destroying = false;
  let destroyed = false;

  const viewportSnapshot = () => ({
    width: Math.max(32, window.innerWidth || document.documentElement.clientWidth || 1280),
    height: Math.max(32, window.innerHeight || document.documentElement.clientHeight || 720),
  });

  const geometryOptions = (viewport = viewportSnapshot()) => {
    let taskbarHeight = 0;
    try {
      const raw = getComputedStyle(document.documentElement)
        .getPropertyValue("--imageweave-taskbar-height");
      const parsed = Number.parseFloat(raw);
      if (Number.isFinite(parsed) && parsed >= 0) taskbarHeight = parsed;
    } catch {
      // CSS Token 不可读时使用零高度，窗口仍由纯几何函数保持至少 32px 可见。
    }
    return {
      minW: WINDOW_MIN_WIDTH,
      minH: WINDOW_MIN_HEIGHT,
      taskbarHeight: Math.min(taskbarHeight, Math.max(0, viewport.height - 32)),
    };
  };

  const recordFor = (appId) => (
    selectors.windowStack(store.getState()).find((record) => record.appId === appId) || null
  );

  const isForcedMobileMaximized = (record) => (
    record?.appId === "review" && mobileViewport.matches
  );

  const isEffectivelyMaximized = (record) => Boolean(
    record && (record.windowState === "maximized" || isForcedMobileMaximized(record))
  );

  const normalRect = (record) => {
    const viewport = viewportSnapshot();
    return clampRect(record.rect, viewport, geometryOptions(viewport));
  };

  const queueNormalRectRepair = (record, rect) => {
    if (sameRect(record.rect, rect)) return;
    const repair = { rect };
    pendingRectRepairs.set(record.appId, repair);
    queueMicrotask(() => {
      if (
        destroying
        || destroyed
        || pendingRectRepairs.get(record.appId) !== repair
      ) return;
      pendingRectRepairs.delete(record.appId);
      const current = recordFor(record.appId);
      const instance = windows.get(record.appId);
      if (
        !current
        || instance?.interaction
        || current.windowState !== "normal"
        || isEffectivelyMaximized(current)
      ) return;
      const normalized = normalRect(current);
      if (!sameRect(current.rect, normalized)) actions.moveWindow(current.appId, normalized);
    });
  };

  const displayedRect = (record) => {
    const viewport = viewportSnapshot();
    return isEffectivelyMaximized(record)
      ? maximizedRect(viewport, geometryOptions(viewport))
      : clampRect(record.rect, viewport, geometryOptions(viewport));
  };

  const applyRect = (element, rect) => {
    element.style.transform = "none";
    element.style.left = `${rect.x}px`;
    element.style.top = `${rect.y}px`;
    element.style.width = `${rect.w}px`;
    element.style.height = `${rect.h}px`;
  };

  const notifyVisibility = (visible, app) => {
    if (!app || typeof onVisibilityChange !== "function") return;
    try {
      onVisibilityChange(visible, app);
    } catch {
      console.error("ImageWeave 应用生命周期执行失败");
    }
  };

  const focusBody = (appId = selectors.focusedAppId(store.getState())) => {
    if (appId === null) return false;
    const instance = windows.get(appId);
    if (!instance || instance.element.hidden) return false;
    instance.bodyEl.focus({ preventScroll: true });
    return true;
  };

  const finishPointerInteraction = (instance, event = null, { commit = true } = {}) => {
    const interaction = instance.interaction;
    if (!interaction) return false;
    if (event && event.pointerId !== interaction.pointerId) return false;
    instance.interaction = null;
    instance.element.removeAttribute("data-window-interacting");
    try {
      if (interaction.control.hasPointerCapture?.(interaction.pointerId)) {
        interaction.control.releasePointerCapture(interaction.pointerId);
      }
    } catch {
      // 指针可能已由浏览器释放；最终矩形仍按同一收尾路径处理。
    }

    const record = recordFor(instance.appId);
    if (
      commit
      && record
      && record.windowState !== "minimized"
      && !isEffectivelyMaximized(record)
      && !sameRect(interaction.rect, record.rect)
    ) {
      actions.moveWindow(instance.appId, interaction.rect);
    } else if (record && !destroying) {
      applyRect(instance.element, displayedRect(record));
    }
    actions.endWindowInteraction?.();
    return true;
  };

  const startPointerInteraction = (instance, event, type, resizeDirection = "") => {
    const record = recordFor(instance.appId);
    if (
      destroying
      || destroyed
      || instance.interaction
      || event.button !== 0
      || event.isPrimary === false
      || !record
      || record.windowState === "minimized"
      || isEffectivelyMaximized(record)
    ) return;

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      return;
    }
    actions.beginWindowInteraction?.();
    const rect = normalRect(record);
    instance.interaction = {
      type,
      resizeDirection,
      pointerId: event.pointerId,
      control: event.currentTarget,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startRect: rect,
      rect,
    };
    instance.element.setAttribute("data-window-interacting", type);
  };

  const movePointerInteraction = (instance, event) => {
    const interaction = instance.interaction;
    if (!interaction || event.pointerId !== interaction.pointerId) return;
    const viewport = viewportSnapshot();
    const options = geometryOptions(viewport);
    const pointerDelta = {
      x: event.clientX - interaction.startClientX,
      y: event.clientY - interaction.startClientY,
    };
    if (interaction.type === "drag") {
      interaction.rect = nextRectForDrag(
        interaction.startRect,
        pointerDelta,
        viewport,
        options,
      );
    } else {
      interaction.rect = nextRectForResize(
        interaction.startRect,
        {
          x: interaction.resizeDirection === "bottom" ? 0 : pointerDelta.x,
          y: interaction.resizeDirection === "right" ? 0 : pointerDelta.y,
        },
        viewport,
        options,
      );
    }
    // 高频路径只触碰当前实例的样式；store 与 storage 留到统一收尾。
    applyRect(instance.element, interaction.rect);
  };

  const resizeFromKeyboard = (instance, direction, event) => {
    const deltas = {
      ArrowLeft: { x: -KEYBOARD_RESIZE_STEP, y: 0 },
      ArrowRight: { x: KEYBOARD_RESIZE_STEP, y: 0 },
      ArrowUp: { x: 0, y: -KEYBOARD_RESIZE_STEP },
      ArrowDown: { x: 0, y: KEYBOARD_RESIZE_STEP },
    };
    const delta = deltas[event.key];
    if (!delta) return;
    if (
      (direction === "right" && delta.y !== 0)
      || (direction === "bottom" && delta.x !== 0)
    ) return;
    const record = recordFor(instance.appId);
    if (!record || record.windowState === "minimized" || isEffectivelyMaximized(record)) return;
    event.preventDefault();
    const viewport = viewportSnapshot();
    const rect = nextRectForResize(record.rect, delta, viewport, geometryOptions(viewport));
    if (!sameRect(rect, record.rect)) actions.moveWindow(instance.appId, rect);
  };

  const hideStateFor = (appId) => {
    if (!hideRequests.has(appId)) {
      hideRequests.set(appId, { sequence: 0, pending: false });
    }
    return hideRequests.get(appId);
  };

  const requestHide = (instance, visibility, commit) => {
    const record = recordFor(instance.appId);
    const requestState = hideStateFor(instance.appId);
    if (
      destroying
      || destroyed
      || requestState.pending
      || !record
      || record.windowState === "minimized"
    ) return;
    const app = getApplicationById(instance.appId);
    let decision = true;
    try {
      decision = typeof onBeforeHide === "function"
        ? onBeforeHide(app, visibility)
        : true;
    } catch {
      decision = false;
    }

    if (typeof decision?.then !== "function") {
      if (decision === true && !destroyed) commit(app);
      return;
    }

    requestState.pending = true;
    const request = ++requestState.sequence;
    void Promise.resolve(decision)
      .then((allowed) => {
        const current = recordFor(instance.appId);
        if (
          allowed !== true
          || destroying
          || destroyed
          || request !== requestState.sequence
          || windows.get(instance.appId) !== instance
          || !current
          || current.windowState === "minimized"
        ) return;
        commit(app);
      })
      .catch(() => {})
      .finally(() => {
        if (request === requestState.sequence) requestState.pending = false;
      });
  };

  const bindInstanceEvents = (instance) => {
    const {
      element,
      titlebarEl,
      buttons: { minimize, maximize, close, resize },
    } = instance;

    const onWindowPointerDown = () => {
      if (!destroying && !destroyed) actions.focusWindow(instance.appId);
    };
    const onTitlebarPointerDown = (event) => {
      if (!(event.target instanceof Element) || event.target.closest("button")) return;
      startPointerInteraction(instance, event, "drag");
    };
    const onPointerMove = (event) => movePointerInteraction(instance, event);
    const onPointerEnd = (event) => finishPointerInteraction(instance, event);
    const onLostPointerCapture = (event) => finishPointerInteraction(instance, event);
    const onMinimize = () => requestHide(instance, "minimized", () => {
      actions.minimizeWindow(instance.appId);
      taskButton.focus({ preventScroll: true });
    });
    const onMaximize = (event) => {
      const record = recordFor(instance.appId);
      if (!record || isForcedMobileMaximized(record)) return;
      actions.toggleWindowMaximized(instance.appId);
      if (event.detail === 0) focusBody(instance.appId);
    };
    const onClose = () => requestHide(instance, "closed", (app) => {
      actions.closeWindow(instance.appId);
      if (app && typeof onCloseFocus === "function") onCloseFocus(app);
    });

    element.addEventListener("pointerdown", onWindowPointerDown, { capture: true });
    titlebarEl.addEventListener("pointerdown", onTitlebarPointerDown);
    titlebarEl.addEventListener("pointermove", onPointerMove);
    titlebarEl.addEventListener("pointerup", onPointerEnd);
    titlebarEl.addEventListener("pointercancel", onPointerEnd);
    titlebarEl.addEventListener("lostpointercapture", onLostPointerCapture);
    minimize.addEventListener("click", onMinimize);
    maximize.addEventListener("click", onMaximize);
    close.addEventListener("click", onClose);

    const cleanups = [
      () => element.removeEventListener("pointerdown", onWindowPointerDown, { capture: true }),
      () => titlebarEl.removeEventListener("pointerdown", onTitlebarPointerDown),
      () => titlebarEl.removeEventListener("pointermove", onPointerMove),
      () => titlebarEl.removeEventListener("pointerup", onPointerEnd),
      () => titlebarEl.removeEventListener("pointercancel", onPointerEnd),
      () => titlebarEl.removeEventListener("lostpointercapture", onLostPointerCapture),
      () => minimize.removeEventListener("click", onMinimize),
      () => maximize.removeEventListener("click", onMaximize),
      () => close.removeEventListener("click", onClose),
    ];

    for (const [direction, handle] of resize) {
      const onResizePointerDown = (event) => {
        startPointerInteraction(instance, event, "resize", direction);
      };
      const onResizeKeyDown = (event) => resizeFromKeyboard(instance, direction, event);
      handle.addEventListener("pointerdown", onResizePointerDown);
      handle.addEventListener("pointermove", onPointerMove);
      handle.addEventListener("pointerup", onPointerEnd);
      handle.addEventListener("pointercancel", onPointerEnd);
      handle.addEventListener("lostpointercapture", onLostPointerCapture);
      handle.addEventListener("keydown", onResizeKeyDown);
      cleanups.push(
        () => handle.removeEventListener("pointerdown", onResizePointerDown),
        () => handle.removeEventListener("pointermove", onPointerMove),
        () => handle.removeEventListener("pointerup", onPointerEnd),
        () => handle.removeEventListener("pointercancel", onPointerEnd),
        () => handle.removeEventListener("lostpointercapture", onLostPointerCapture),
        () => handle.removeEventListener("keydown", onResizeKeyDown),
      );
    }
    instance.cleanupEvents = () => {
      for (const cleanup of cleanups) cleanup();
    };
  };

  const createInstance = (appId) => {
    const app = getApplicationById(appId);
    if (!app) throw new TypeError("窗口应用 ID 无效");
    const fragment = windowTemplate.content.cloneNode(true);
    const element = requireCloneElement(fragment, "[data-application-window]");
    const titlebarEl = requireCloneElement(element, "[data-window-titlebar]");
    const titleEl = requireCloneElement(element, "[data-window-title]");
    const bodyEl = requireCloneElement(element, "[data-window-body]");
    const minimize = requireCloneElement(element, "[data-window-minimize]", HTMLButtonElement);
    const maximize = requireCloneElement(element, "[data-window-maximize]", HTMLButtonElement);
    const close = requireCloneElement(element, "[data-window-close]", HTMLButtonElement);
    const resize = new Map();
    for (const direction of ["right", "bottom", "corner"]) {
      resize.set(direction, requireCloneElement(
        element,
        `[data-window-resize="${direction}"]`,
        HTMLButtonElement,
      ));
    }

    const titleId = `window-title-${app.id}`;
    const bodyId = `app-content-${app.id}`;
    element.dataset.appId = app.id;
    element.setAttribute("aria-labelledby", titleId);
    titleEl.id = titleId;
    titleEl.textContent = app.windowTitle;
    titleEl.title = app.windowTitle;
    bodyEl.id = bodyId;
    minimize.replaceChildren(createIcon("minus", { size: 17, strokeWidth: 2 }));
    close.replaceChildren(createIcon("close", { size: 17, strokeWidth: 2 }));

    const instance = {
      appId: app.id,
      element,
      titlebarEl,
      titleEl,
      bodyEl,
      buttons: { minimize, maximize, close, resize },
      visible: false,
      interaction: null,
      cleanupEvents: () => {},
    };
    bindInstanceEvents(instance);
    windowLayer.append(fragment);
    try {
      onMount?.(app, bodyEl);
    } catch (error) {
      instance.cleanupEvents();
      element.remove();
      throw error;
    }
    windows.set(app.id, instance);
    return instance;
  };

  const removeInstance = (appId) => {
    const instance = windows.get(appId);
    if (!instance) return;
    const hideState = hideRequests.get(appId);
    if (hideState) {
      hideState.sequence += 1;
      hideState.pending = false;
    }
    finishPointerInteraction(instance, null, { commit: false });
    const app = getApplicationById(appId);
    if (instance.visible) {
      instance.visible = false;
      notifyVisibility(false, app);
    }
    try {
      onUnmount?.(app, instance.bodyEl);
    } catch {
      console.error("ImageWeave 应用卸载失败");
    }
    instance.cleanupEvents();
    instance.element.remove();
    windows.delete(appId);
    hideRequests.delete(appId);
    pendingRectRepairs.delete(appId);
  };

  const syncInstance = (instance, record, index, focusedAppId) => {
    const app = getApplicationById(record.appId);
    const visible = record.windowState !== "minimized";
    const maximized = isEffectivelyMaximized(record);
    const forced = isForcedMobileMaximized(record);
    instance.element.hidden = !visible;
    instance.element.dataset.windowVisibility = visible ? "open" : "minimized";
    instance.element.dataset.windowState = record.windowState;
    instance.element.toggleAttribute("data-maximized", maximized);
    instance.element.toggleAttribute("data-window-focused", record.appId === focusedAppId);
    // 数组就是 z 序的唯一事实源；zIndex 只投影到 DOM。
    instance.element.style.zIndex = String(index);
    if (!instance.interaction) {
      const rect = displayedRect(record);
      applyRect(instance.element, rect);
      if (visible && !maximized) queueNormalRectRepair(record, rect);
    }

    instance.buttons.maximize.disabled = !app || forced;
    instance.buttons.maximize.setAttribute(
      "aria-disabled",
      String(instance.buttons.maximize.disabled),
    );
    instance.buttons.maximize.setAttribute("aria-pressed", String(maximized));
    instance.buttons.maximize.setAttribute(
      "aria-label",
      maximized ? "还原窗口" : "最大化窗口",
    );
    instance.buttons.maximize.title = forced
      ? "审核应用在手机端始终最大化"
      : maximized
        ? "还原"
        : "最大化";
    instance.buttons.maximize.replaceChildren(
      createIcon(maximized ? "restore" : "square", { size: 15, strokeWidth: 2 }),
    );
    for (const handle of instance.buttons.resize.values()) handle.disabled = maximized;

    if (instance.visible !== visible) {
      instance.visible = visible;
      notifyVisibility(visible, app);
    }
  };

  const syncTaskButton = () => {
    currentView = selectors.windowView(store.getState());
    const app = getApplicationById(currentView.appId);
    const isOpen = currentView.visibility === "open";
    taskButton.hidden = currentView.visibility === "closed" || !app;
    taskButton.setAttribute("aria-pressed", String(isOpen));
    if (!app) {
      taskButton.textContent = "";
      taskButton.removeAttribute("title");
      return;
    }
    taskButton.textContent = app.windowTitle;
    taskButton.title = `${app.label} — ${isOpen ? "最小化" : "恢复"}`;
  };

  const renderStack = (stack) => {
    if (destroying || destroyed) return;
    currentStack = stack;
    const nextIds = new Set(stack.map((record) => record.appId));
    for (const appId of [...windows.keys()]) {
      if (!nextIds.has(appId)) removeInstance(appId);
    }
    for (const record of stack) {
      if (!windows.has(record.appId)) createInstance(record.appId);
    }
    const focusedAppId = selectors.focusedAppId(store.getState());
    stack.forEach((record, index) => {
      syncInstance(windows.get(record.appId), record, index, focusedAppId);
    });
    syncTaskButton();
  };

  const onTaskButtonClick = () => {
    const view = selectors.windowView(store.getState());
    if (view.appId === null || view.visibility === "closed") return;
    const instance = windows.get(view.appId);
    if (!instance) return;
    if (view.visibility === "open") {
      requestHide(instance, "minimized", () => {
        actions.minimizeWindow(view.appId);
        taskButton.focus({ preventScroll: true });
      });
      return;
    }
    actions.restoreWindow(view.appId);
    focusBody(view.appId);
  };

  const onViewportChange = () => {
    if (!destroying && !destroyed) renderStack(selectors.windowStack(store.getState()));
  };

  taskButton.addEventListener("click", onTaskButtonClick);
  mobileViewport.addEventListener("change", onViewportChange);
  window.addEventListener("resize", onViewportChange);

  let unsubscribe = () => {};
  try {
    renderStack(currentStack);
    unsubscribe = store.subscribe(selectors.windowStack, renderStack);
  } catch (error) {
    destroying = true;
    for (const appId of [...windows.keys()]) removeInstance(appId);
    taskButton.removeEventListener("click", onTaskButtonClick);
    mobileViewport.removeEventListener("change", onViewportChange);
    window.removeEventListener("resize", onViewportChange);
    throw error;
  }

  return Object.freeze({
    getSnapshot() {
      return Object.freeze({
        appId: currentView.appId,
        visibility: currentView.visibility,
        maximized: currentView.appId === null
          ? false
          : isEffectivelyMaximized(recordFor(currentView.appId)),
        preferredWindowState: currentView.windowState,
      });
    },
    getFocusedBody() {
      const appId = selectors.focusedAppId(store.getState());
      return appId === null ? null : windows.get(appId)?.bodyEl || null;
    },
    focusBody,
    destroy() {
      if (destroyed) return;
      destroying = true;
      for (const instance of windows.values()) finishPointerInteraction(instance);
      unsubscribe();
      taskButton.removeEventListener("click", onTaskButtonClick);
      mobileViewport.removeEventListener("change", onViewportChange);
      window.removeEventListener("resize", onViewportChange);
      for (const appId of [...windows.keys()]) removeInstance(appId);
      pendingRectRepairs.clear();
      currentStack = [];
      destroying = false;
      destroyed = true;
    },
  });
}
