import { applications } from "./app-registry.js";
import { createShellActions } from "./actions.js";
import { createHashRouter } from "./router.js";
import { createElement, requireElement, setElementInert } from "./dom.js";
import { selectors } from "./store.js";
import { createWindowManager } from "./window-manager.js";
import { createIcon } from "../components/icons.js";
import { createStatusBadge } from "../components/status.js";

function createApplicationLink(app, location) {
  const isDesktop = location === "desktop";
  const link = createElement("a", {
    className: isDesktop ? "desktop-icon" : "start-menu-item",
    attributes: {
      href: `#${app.route}`,
      title: `${app.label} — ${app.windowTitle}`,
    },
    dataset: { appLink: app.id, appLocation: location },
  });
  link.append(
    createIcon(app.icon, { size: isDesktop ? 30 : 22, strokeWidth: 1.6 }),
    createElement("span", { className: "application-label", text: app.label }),
  );
  if (app.availability !== "ready") {
    link.append(createStatusBadge("disabled", "开发中", { compact: true }));
  }
  return link;
}

function startClock(clockElement) {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  let timerId;

  const tick = () => {
    const now = new Date();
    clockElement.textContent = formatter.format(now);
    clockElement.dateTime = now.toISOString();
    timerId = window.setTimeout(tick, 60_000 - (Date.now() % 60_000) + 100);
  };
  tick();
  return () => window.clearTimeout(timerId);
}

function validateServices({ api, store, polling, storage, dialogs }) {
  if (!api || typeof api.get !== "function") throw new TypeError("桌面缺少 API 服务");
  if (!store || typeof store.dispatch !== "function") throw new TypeError("桌面缺少状态仓库");
  if (!polling || typeof polling.stopScope !== "function") throw new TypeError("桌面缺少轮询服务");
  if (
    !storage
    || typeof storage.writeCurrentApp !== "function"
    || typeof storage.writeWindowLayout !== "function"
  ) {
    throw new TypeError("桌面缺少安全存储服务");
  }
  if (!dialogs || typeof dialogs.open !== "function") throw new TypeError("桌面缺少对话框服务");
}

export function initializeDesktop(root = document, services = {}) {
  validateServices(services);
  const {
    api,
    store,
    polling,
    storage,
    dialogs,
    motion = null,
    personalization = null,
  } = services;
  const desktop = requireElement("[data-desktop]", root);
  const desktopIcons = requireElement("[data-desktop-icons]", desktop);
  const startMenu = requireElement("[data-start-menu]", desktop);
  const startMenuItems = requireElement("[data-start-menu-items]", startMenu);
  const startButton = requireElement("[data-start-button]", desktop);
  const windowElement = requireElement("[data-application-window]", desktop);
  const windowTitle = requireElement("[data-window-title]", windowElement);
  const windowBody = requireElement("[data-window-body]", windowElement);
  const minimizeButton = requireElement("[data-window-minimize]", windowElement);
  const maximizeButton = requireElement("[data-window-maximize]", windowElement);
  const closeButton = requireElement("[data-window-close]", windowElement);
  const taskButton = requireElement("[data-task-window]", desktop);
  const clock = requireElement("[data-clock]", desktop);
  const clockIcon = requireElement("[data-clock-icon]", desktop);
  const skipLink = requireElement("[data-skip-link]", root);
  const announcer = requireElement("[data-route-announcer]", root);

  for (const app of applications) {
    desktopIcons.append(createApplicationLink(app, "desktop"));
    startMenuItems.append(createApplicationLink(app, "menu"));
  }

  const mountedApplications = new Map();
  let currentApp = null;
  let router;
  let actions;
  let routeTransitionVersion = 0;

  const ensureMounted = (app) => {
    if (mountedApplications.has(app.id)) return mountedApplications.get(app.id);

    const appRoot = createElement("section", {
      className: "app-view",
      attributes: { hidden: "", inert: "" },
      dataset: { appId: app.id },
    });
    windowBody.append(appRoot);
    const context = Object.freeze({
      app,
      root: appRoot,
      api,
      store,
      actions,
      polling,
      pollingScope: `app:${app.id}`,
      storage,
      dialogs,
      motion,
      personalization,
      navigate: actions.navigateToApp,
    });
    try {
      app.mount(context);
    } catch (error) {
      appRoot.remove();
      throw error;
    }
    setElementInert(appRoot, true);
    const mounted = { context, active: false };
    mountedApplications.set(app.id, mounted);
    return mounted;
  };

  const setLifecycleActive = (app, active) => {
    const mounted = ensureMounted(app);
    if (mounted.active === active) return;
    if (active) {
      app.activate(mounted.context);
      mounted.active = true;
      return;
    }
    try {
      app.deactivate(mounted.context);
    } finally {
      mounted.active = false;
      polling.stopScope(mounted.context.pollingScope);
    }
  };

  const updateNavigationState = (app) => {
    for (const link of desktop.querySelectorAll("[data-app-link]")) {
      if (!(link instanceof HTMLElement)) continue;
      const current = link.dataset.appLink === app.id;
      if (current) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  };

  const focusDesktopApplication = (app) => {
    const link = desktopIcons.querySelector(`[data-app-link="${app.id}"]`);
    if (link instanceof HTMLElement) link.focus();
  };

  const activateRoute = (app, navigation = {}) => {
    if (!app) return;
    // 恢复为空栈或全最小化布局时，初始 hash 只保留地址，不得擅自重开窗口。
    if (navigation.reason === "initial" && store.getState().ui.focusedAppId === null) return;
    const transition = ++routeTransitionVersion;
    void (async () => {
      const previous = currentApp;
      if (previous && previous.id !== app.id && typeof previous.beforeLeave === "function") {
        const mounted = ensureMounted(previous);
        let allowed = false;
        try {
          allowed = await previous.beforeLeave(mounted.context, app);
        } catch {
          allowed = false;
        }
        if (transition !== routeTransitionVersion) return;
        if (!allowed) {
          announcer.textContent = `无法离开${previous.label}；请先处理未保存内容。`;
          router.navigate(previous.id);
          return;
        }
      }
      if (transition !== routeTransitionVersion) return;
      ensureMounted(app);
      currentApp = app;
      updateNavigationState(app);
      actions.routeResolved(app);
      document.title = `ImageWeave — ${app.label}`;
      announcer.textContent = `已打开${app.label}，${app.windowTitle}`;
    })().catch(() => {
      announcer.textContent = "应用切换失败；当前窗口保持不变。";
      if (currentApp) router.navigate(currentApp.id);
    });
  };

  router = createHashRouter(activateRoute);
  actions = createShellActions({ store, router, storage });

  const windowManager = createWindowManager({
    windowElement,
    titleElement: windowTitle,
    bodyElement: windowBody,
    minimizeButton,
    maximizeButton,
    closeButton,
    taskButton,
    store,
    actions,
    onVisibilityChange(visible, app) {
      setLifecycleActive(app, visible);
    },
    onCloseFocus(app) {
      focusDesktopApplication(app);
    },
    onBeforeHide(app, visibility) {
      if (typeof app?.beforeWindowHide !== "function") return true;
      const mounted = ensureMounted(app);
      return app.beforeWindowHide(mounted.context, visibility);
    },
  });

  const renderStartMenu = (open, previous) => {
    startMenu.hidden = !open;
    startButton.setAttribute("aria-expanded", String(open));
    if (open && !previous) startMenuItems.querySelector("a")?.focus();
  };
  const unsubscribeStartMenu = store.subscribe(selectors.startMenuOpen, renderStartMenu, {
    fireImmediately: true,
  });

  const setMenuOpen = (open, { returnFocus = false } = {}) => {
    actions.setStartMenuOpen(open);
    if (!open && returnFocus) startButton.focus();
  };

  const onNavigationClick = (event) => {
    if (!(event.target instanceof Element)) return;
    const link = event.target.closest("[data-app-link]");
    if (!(link instanceof HTMLAnchorElement)) return;
    event.preventDefault();
    actions.navigateToApp(link.dataset.appLink);
  };

  const onStartClick = () => setMenuOpen(!store.getState().ui.startMenuOpen);
  const onOutsidePointerDown = (event) => {
    if (!store.getState().ui.startMenuOpen || !(event.target instanceof Node)) return;
    if (startMenu.contains(event.target) || startButton.contains(event.target)) return;
    setMenuOpen(false);
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape" && store.getState().ui.startMenuOpen) {
      event.preventDefault();
      setMenuOpen(false, { returnFocus: true });
    }
  };
  const onSkip = () => {
    const snapshot = windowManager.getSnapshot();
    if (snapshot.visibility === "open") windowBody.focus({ preventScroll: true });
    else if (currentApp) focusDesktopApplication(currentApp);
  };

  desktopIcons.addEventListener("click", onNavigationClick);
  startMenuItems.addEventListener("click", onNavigationClick);
  startButton.addEventListener("click", onStartClick);
  document.addEventListener("pointerdown", onOutsidePointerDown);
  document.addEventListener("keydown", onKeyDown);
  skipLink.addEventListener("click", onSkip);
  clockIcon.replaceChildren(createIcon("clock", { size: 16, strokeWidth: 2 }));
  const stopClock = startClock(clock);

  router.start();
  document.documentElement.dataset.webuiReady = "true";

  return Object.freeze({
    actions,
    router,
    windowManager,
    destroy() {
      router.stop();
      stopClock();
      windowManager.destroy();
      unsubscribeStartMenu();
      desktopIcons.removeEventListener("click", onNavigationClick);
      startMenuItems.removeEventListener("click", onNavigationClick);
      startButton.removeEventListener("click", onStartClick);
      document.removeEventListener("pointerdown", onOutsidePointerDown);
      document.removeEventListener("keydown", onKeyDown);
      skipLink.removeEventListener("click", onSkip);
      for (const [appId, mounted] of mountedApplications) {
        const app = applications.find((candidate) => candidate.id === appId);
        if (!app) continue;
        if (mounted.active) {
          try {
            app.deactivate(mounted.context);
          } finally {
            polling.stopScope(mounted.context.pollingScope);
          }
        }
        app.unmount(mounted.context);
      }
      mountedApplications.clear();
      delete document.documentElement.dataset.webuiReady;
    },
  });
}
