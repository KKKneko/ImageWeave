import { getApplicationById } from "../core/app-registry.js";
import { createElement } from "../core/dom.js";

export const _TASKBAR_VISIBLE_LIMIT = 6;

const TASKBAR_OVERFLOW_LIST_ID = "task-window-overflow-list";

export function describeTaskbarWindows(windowStack, focusedAppId) {
  if (!Array.isArray(windowStack)) throw new TypeError("任务栏窗口栈必须是数组");
  return Object.freeze(windowStack.map((record) => {
    const app = getApplicationById(record?.appId);
    if (!app) throw new TypeError("任务栏窗口应用无效");
    const minimized = record.windowState === "minimized";
    const focused = !minimized && record.appId === focusedAppId;
    return Object.freeze({
      appId: app.id,
      label: app.label,
      title: app.windowTitle,
      ariaPressed: String(focused),
      minimized,
      activation: focused ? "minimize" : minimized ? "restore" : "focus",
    });
  }));
}

export function activateTaskbarWindow(descriptor, {
  canActivate = () => true,
  minimize,
  restore,
  focus,
} = {}) {
  const appId = descriptor?.appId;
  const activation = descriptor?.activation;
  if (
    typeof appId !== "string"
    || !getApplicationById(appId)
    || !["minimize", "restore", "focus"].includes(activation)
    || typeof canActivate !== "function"
    || canActivate(appId, descriptor) !== true
  ) return false;

  const callback = { minimize, restore, focus }[activation];
  if (typeof callback !== "function") {
    throw new TypeError("任务栏窗口激活处理器无效");
  }
  callback(appId);
  return true;
}

export function deriveTaskbarWindowModel(windowStack, focusedAppId) {
  const buttons = describeTaskbarWindows(windowStack, focusedAppId);
  return Object.freeze({
    buttons,
    visible: Object.freeze(buttons.slice(0, _TASKBAR_VISIBLE_LIMIT)),
    overflow: Object.freeze(buttons.slice(_TASKBAR_VISIBLE_LIMIT)),
  });
}

export function createTaskbarWindowList({
  container,
  onActivate,
  documentObject = globalThis.document,
}) {
  if (!(container instanceof HTMLElement)) throw new TypeError("任务栏窗口容器无效");
  if (typeof onActivate !== "function") throw new TypeError("任务栏窗口激活回调无效");
  if (!documentObject || typeof documentObject.addEventListener !== "function") {
    throw new TypeError("任务栏窗口列表需要可用的 document");
  }

  const primary = createElement("div", {
    className: "task-window-primary",
    dataset: { taskWindowPrimary: "" },
  });
  const overflowButton = createElement("button", {
    className: "task-window-overflow-button",
    text: "⋯",
    attributes: {
      type: "button",
      "aria-label": "更多打开的窗口",
      "aria-controls": TASKBAR_OVERFLOW_LIST_ID,
      "aria-expanded": "false",
      title: "更多打开的窗口",
      hidden: "",
    },
    dataset: { taskWindowOverflowButton: "" },
  });
  const overflowPanel = createElement("div", {
    className: "task-window-overflow",
    attributes: {
      id: TASKBAR_OVERFLOW_LIST_ID,
      hidden: "",
    },
    dataset: { taskWindowOverflow: "" },
  });
  const overflowList = createElement("ul", {
    className: "task-window-overflow__list",
    attributes: { "aria-label": "更多打开的窗口" },
  });
  overflowPanel.append(overflowList);
  container.replaceChildren(primary, overflowButton, overflowPanel);

  const buttons = new Map();
  let currentModel = deriveTaskbarWindowModel([], null);
  let destroyed = false;

  const buttonFor = (descriptor) => {
    let button = buttons.get(descriptor.appId);
    if (!button) {
      button = createElement("button", {
        className: "task-window-button",
        attributes: { type: "button" },
      });
      buttons.set(descriptor.appId, button);
    }
    button.dataset.taskWindow = descriptor.appId;
    button.textContent = descriptor.label;
    button.title = descriptor.title;
    button.setAttribute("aria-pressed", descriptor.ariaPressed);
    button.setAttribute(
      "aria-label",
      descriptor.minimized ? `${descriptor.label}（已最小化）` : descriptor.label,
    );
    button.toggleAttribute("data-minimized", descriptor.minimized);
    return button;
  };

  const closeOverflow = ({ returnFocus = false } = {}) => {
    const wasOpen = overflowButton.getAttribute("aria-expanded") === "true";
    overflowButton.setAttribute("aria-expanded", "false");
    overflowPanel.hidden = true;
    if (returnFocus && wasOpen && !overflowButton.hidden) {
      overflowButton.focus({ preventScroll: true });
    }
    return wasOpen;
  };

  const openOverflow = () => {
    if (destroyed || currentModel.overflow.length === 0) return false;
    overflowPanel.hidden = false;
    overflowButton.setAttribute("aria-expanded", "true");
    overflowList.querySelector("button")?.focus({ preventScroll: true });
    return true;
  };

  const render = (windowStack, focusedAppId) => {
    if (destroyed) return;
    closeOverflow();
    currentModel = deriveTaskbarWindowModel(windowStack, focusedAppId);
    const nextIds = new Set(currentModel.buttons.map((descriptor) => descriptor.appId));
    for (const [appId, button] of buttons) {
      if (nextIds.has(appId)) continue;
      button.remove();
      buttons.delete(appId);
    }

    primary.replaceChildren(...currentModel.visible.map(buttonFor));
    overflowList.replaceChildren(...currentModel.overflow.map((descriptor) => {
      const item = createElement("li");
      item.append(buttonFor(descriptor));
      return item;
    }));
    const hasOverflow = currentModel.overflow.length > 0;
    overflowButton.hidden = !hasOverflow;
    container.toggleAttribute("data-has-overflow", hasOverflow);
  };

  const onOverflowClick = () => {
    if (overflowButton.getAttribute("aria-expanded") === "true") {
      closeOverflow({ returnFocus: true });
    } else {
      openOverflow();
    }
  };
  const onContainerClick = (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-task-window]");
    if (!(button instanceof HTMLButtonElement) || !container.contains(button)) return;
    const appId = button.dataset.taskWindow;
    const descriptor = currentModel.buttons.find((item) => item.appId === appId);
    if (!descriptor || buttons.get(appId) !== button) return;
    onActivate(descriptor, button);
  };
  const onOutsidePointerDown = (event) => {
    if (
      overflowButton.getAttribute("aria-expanded") !== "true"
      || !(event.target instanceof Node)
      || container.contains(event.target)
    ) return;
    closeOverflow();
  };
  const onDocumentKeyDown = (event) => {
    if (
      event.key !== "Escape"
      || overflowButton.getAttribute("aria-expanded") !== "true"
    ) return;
    event.preventDefault();
    closeOverflow({ returnFocus: true });
  };

  overflowButton.addEventListener("click", onOverflowClick);
  container.addEventListener("click", onContainerClick);
  documentObject.addEventListener("pointerdown", onOutsidePointerDown);
  documentObject.addEventListener("keydown", onDocumentKeyDown);

  return Object.freeze({
    render,
    focusButton(appId) {
      const button = buttons.get(appId);
      if (!button) return false;
      if (currentModel.overflow.some((descriptor) => descriptor.appId === appId)) {
        if (overflowPanel.hidden) overflowButton.focus({ preventScroll: true });
        else button.focus({ preventScroll: true });
      } else {
        button.focus({ preventScroll: true });
      }
      return true;
    },
    closeOverflow,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      overflowButton.removeEventListener("click", onOverflowClick);
      container.removeEventListener("click", onContainerClick);
      documentObject.removeEventListener("pointerdown", onOutsidePointerDown);
      documentObject.removeEventListener("keydown", onDocumentKeyDown);
      buttons.clear();
      currentModel = deriveTaskbarWindowModel([], null);
      container.replaceChildren();
    },
  });
}
