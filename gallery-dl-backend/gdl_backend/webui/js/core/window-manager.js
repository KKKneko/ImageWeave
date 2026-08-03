import { getApplicationById } from "./app-registry.js";
import { selectors, shallowEqual } from "./store.js";
import { createIcon } from "../components/icons.js";

export function createWindowManager({
  windowElement,
  titleElement,
  bodyElement,
  minimizeButton,
  maximizeButton,
  closeButton,
  taskButton,
  store,
  actions,
  onVisibilityChange,
  onCloseFocus,
}) {
  const mobileViewport = window.matchMedia("(max-width: 767px)");
  let currentView = selectors.windowView(store.getState());

  const isForcedMobileMaximized = (view) =>
    Boolean(view?.appId === "review" && mobileViewport.matches);

  const isEffectivelyMaximized = (view) =>
    Boolean(view && (isForcedMobileMaximized(view) || view.windowState === "maximized"));

  const notifyVisibility = (visible, app) => {
    if (!app || typeof onVisibilityChange !== "function") return;
    try {
      onVisibilityChange(visible, app);
    } catch {
      console.error("ImageWeave 应用生命周期执行失败");
    }
  };

  const syncDom = (view) => {
    const app = getApplicationById(view.appId);
    const isOpen = view.visibility === "open";
    const isClosed = view.visibility === "closed";
    const maximized = isEffectivelyMaximized(view);

    windowElement.hidden = !isOpen;
    windowElement.dataset.windowVisibility = view.visibility;
    windowElement.toggleAttribute("data-maximized", maximized);
    taskButton.hidden = isClosed || !app;
    taskButton.setAttribute("aria-pressed", String(isOpen));

    if (app) {
      titleElement.textContent = app.windowTitle;
      titleElement.title = app.windowTitle;
      windowElement.dataset.appId = app.id;
      taskButton.textContent = app.windowTitle;
      taskButton.title = `${app.label} — ${isOpen ? "最小化" : "恢复"}`;
    }

    const forced = isForcedMobileMaximized(view);
    maximizeButton.disabled = !app || forced;
    maximizeButton.setAttribute("aria-disabled", String(maximizeButton.disabled));
    maximizeButton.setAttribute("aria-pressed", String(maximized));
    maximizeButton.setAttribute("aria-label", maximized ? "还原窗口" : "最大化窗口");
    maximizeButton.title = forced
      ? "审核应用在手机端始终最大化"
      : maximized
        ? "还原"
        : "最大化";
    maximizeButton.replaceChildren(
      createIcon(maximized ? "restore" : "square", { size: 15, strokeWidth: 2 }),
    );
  };

  const render = (view, previous) => {
    const previousApp = previous ? getApplicationById(previous.appId) : null;
    const nextApp = getApplicationById(view.appId);
    const appChanged = Boolean(previous && previous.appId !== view.appId);
    if (previous?.visibility === "open" &&
        (appChanged || view.visibility !== "open")) {
      notifyVisibility(false, previousApp);
    }

    currentView = view;
    syncDom(view);

    if (view.visibility === "open" &&
        (!previous || previous.visibility !== "open" || appChanged)) {
      notifyVisibility(true, nextApp);
    }
  };

  const unsubscribe = store.subscribe(selectors.windowView, render, {
    equality: shallowEqual,
    fireImmediately: true,
  });

  const minimize = () => {
    if (currentView.visibility !== "open") return;
    actions.minimizeWindow();
    taskButton.focus();
  };

  const restore = () => {
    if (currentView.visibility === "closed") return;
    if (currentView.visibility === "open") {
      minimize();
      return;
    }
    actions.restoreWindow();
    bodyElement.focus({ preventScroll: true });
  };

  const close = () => {
    if (currentView.visibility === "closed") return;
    const app = getApplicationById(currentView.appId);
    actions.closeWindow();
    if (app && typeof onCloseFocus === "function") onCloseFocus(app);
  };

  const toggleMaximized = () => {
    if (!getApplicationById(currentView.appId) || isForcedMobileMaximized(currentView)) return;
    actions.toggleWindowMaximized();
    bodyElement.focus({ preventScroll: true });
  };

  const onViewportChange = () => syncDom(currentView);
  minimizeButton.addEventListener("click", minimize);
  maximizeButton.addEventListener("click", toggleMaximized);
  closeButton.addEventListener("click", close);
  taskButton.addEventListener("click", restore);
  mobileViewport.addEventListener("change", onViewportChange);

  minimizeButton.replaceChildren(createIcon("minus", { size: 17, strokeWidth: 2 }));
  closeButton.replaceChildren(createIcon("close", { size: 17, strokeWidth: 2 }));

  return Object.freeze({
    getSnapshot() {
      return Object.freeze({
        appId: currentView.appId,
        visibility: currentView.visibility,
        maximized: isEffectivelyMaximized(currentView),
        preferredWindowState: currentView.windowState,
      });
    },
    destroy() {
      unsubscribe();
      minimizeButton.removeEventListener("click", minimize);
      maximizeButton.removeEventListener("click", toggleMaximized);
      closeButton.removeEventListener("click", close);
      taskButton.removeEventListener("click", restore);
      mobileViewport.removeEventListener("change", onViewportChange);
    },
  });
}
