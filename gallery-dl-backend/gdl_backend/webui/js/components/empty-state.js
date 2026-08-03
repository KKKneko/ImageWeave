import { createElement, setElementInert } from "../core/dom.js";
import { createStatusBadge } from "./status.js";

function createCapabilityList(capabilities) {
  const list = createElement("ul", { className: "deferred-capabilities" });
  for (const capability of capabilities) {
    list.append(createElement("li", { text: capability }));
  }
  return list;
}

function createNavigation(context, links, cleanup) {
  if (!links.length) return null;

  const navigation = createElement("nav", {
    className: "deferred-actions",
    attributes: { "aria-label": "相关应用" },
  });
  for (const link of links) {
    const button = createElement("button", {
      className: "route-button",
      text: link.label,
      attributes: { type: "button" },
    });
    const onClick = () => context.actions.navigateToApp(link.appId);
    button.addEventListener("click", onClick);
    cleanup.push(() => button.removeEventListener("click", onClick));
    navigation.append(button);
  }
  return navigation;
}

function createApplicationShell(options) {
  let cleanup = [];

  return Object.freeze({
    mount(context) {
      const { root, app } = context;
      const headingId = `${app.id}-heading`;
      root.classList.add("app-view", `${app.id}-app`);
      root.setAttribute("aria-labelledby", headingId);

      const eyebrow = createElement("p", {
        className: "app-executable",
        text: app.windowTitle,
      });
      const heading = createElement("h1", { text: app.label, attributes: { id: headingId } });
      const status = createStatusBadge(options.status, options.statusLabel);
      const summary = createElement("p", { className: "app-summary", text: options.summary });
      const panel = createElement("section", { className: "deferred-panel" }, [
        createElement("h2", { text: options.panelTitle }),
        createCapabilityList(options.capabilities),
      ]);
      const navigation = createNavigation(context, options.links || [], cleanup);

      root.replaceChildren(
        createElement("header", { className: "app-header" }, [eyebrow, heading, status, summary]),
        panel,
        ...(navigation ? [navigation] : []),
      );
    },

    activate({ root }) {
      root.hidden = false;
      setElementInert(root, false);
      root.dataset.lifecycle = "active";
    },

    deactivate({ root }) {
      root.hidden = true;
      setElementInert(root, true);
      root.dataset.lifecycle = "inactive";
    },

    unmount({ root }) {
      for (const dispose of cleanup) dispose();
      cleanup = [];
      root.replaceChildren();
      root.removeAttribute("data-lifecycle");
    },
  });
}

export function createEmptyState({
  status = "disabled",
  label = "暂无数据",
  title = "暂无可显示内容",
  message = "请刷新后重试。",
} = {}) {
  const element = createElement("section", {
    className: "empty-state",
    attributes: { role: status === "error" ? "alert" : "status" },
  });
  element.append(
    createStatusBadge(status, label),
    createElement("h3", { text: title }),
    createElement("p", { text: message }),
  );
  return element;
}

export function createDeferredApplication({ summary, capabilities, links = [] }) {
  return createApplicationShell({
    status: "warning",
    statusLabel: "页面已就绪，功能开发中",
    summary,
    panelTitle: "计划功能",
    capabilities,
    links,
  });
}

export function createPlaceholderShell({ responsibility }) {
  return createApplicationShell({
    status: "disabled",
    statusLabel: "功能开发中",
    summary: "功能正在开发，暂不可用。",
    panelTitle: "计划功能",
    capabilities: [responsibility],
    links: [],
  });
}
