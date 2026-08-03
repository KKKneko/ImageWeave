import { createElement } from "../core/dom.js";
import { createStatusBadge } from "./status.js";

const SOURCE_LABELS = Object.freeze({
  config: "配置文件默认值",
  runtime: "界面自定义配置",
  none: "未配置",
});

function operationButton(action, label, pendingLabel, className = "proxy-button") {
  return createElement("button", {
    className,
    text: label,
    attributes: { type: "button" },
    dataset: {
      proxyAction: action,
      operationKind: action,
      defaultLabel: label,
      pendingLabel,
    },
  });
}

export function sourceActionButton(action, label, pendingLabel = label, { dangerous = false } = {}) {
  return operationButton(
    action,
    label,
    pendingLabel,
    `proxy-button proxy-button--small${dangerous ? " proxy-button--dangerous" : ""}`,
  );
}

function secretControl(tagName, attributes = {}) {
  return createElement(tagName, {
    className: "proxy-secret-input",
    attributes: {
      autocomplete: "off",
      spellcheck: "false",
      autocapitalize: "none",
      ...attributes,
    },
    dataset: { proxySecret: "" },
  });
}

function helpText(id, text) {
  return createElement("p", {
    className: "proxy-field-help",
    text,
    attributes: { id },
  });
}

export function definitionList(items, className = "proxy-definition-list") {
  const list = createElement("dl", { className });
  for (const [term, value] of items) {
    list.append(
      createElement("div", {}, [
        createElement("dt", { text: term }),
        createElement("dd", { text: value }),
      ]),
    );
  }
  return list;
}

export function metric(label, value, detail = "") {
  return createElement("article", { className: "proxy-metric" }, [
    createElement("span", { text: label }),
    createElement("strong", { text: String(value) }),
    ...(detail ? [createElement("small", { text: detail })] : []),
  ]);
}

export function sourceLabel(source) {
  return SOURCE_LABELS[source] || SOURCE_LABELS.none;
}

function createSourceForm({ kind, label, help, inputTag = "input", inputAttributes = {}, submitLabel }) {
  const inputId = `proxy-${kind}-input`;
  const helpId = `proxy-${kind}-help`;
  const input = secretControl(inputTag, {
    id: inputId,
    "aria-describedby": `${helpId} proxy-error-host`,
    ...inputAttributes,
  });
  const submit = sourceActionButton(kind, submitLabel, "正在保存…");
  submit.type = "submit";
  submit.removeAttribute("data-proxy-action");
  const form = createElement("form", {
    className: "proxy-source-form",
    attributes: { autocomplete: "off", novalidate: "" },
    dataset: { proxyForm: kind },
  }, [
    createElement("label", { text: label, attributes: { for: inputId } }),
    input,
    helpText(helpId, help),
    createElement("div", { className: "proxy-form-actions" }, [submit]),
  ]);
  return { form, input, submit };
}

export function buildProxyDom(context) {
  const { root, app } = context;
  const headingId = "proxy-heading";
  const headerBadge = createStatusBadge("disabled", "正在加载");
  const operationLive = createElement("p", {
    className: "proxy-operation-live",
    text: "等待操作。",
    attributes: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
  });
  const errorHost = createElement("div", {
    className: "proxy-error-host",
    attributes: { id: "proxy-error-host", "aria-live": "assertive" },
  });
  const waitingHost = createElement("div", { className: "proxy-waiting-host" });

  const runtimeButtons = {
    start: operationButton("start", "启动代理池", "正在启动…"),
    stop: operationButton("stop", "停止代理池", "正在停止…", "proxy-button proxy-button--dangerous"),
    reload: operationButton("reload", "应用并重新加载", "正在应用…", "proxy-button proxy-button--primary"),
    probe: operationButton("probe", "检测全部节点", "正在检测…"),
    refresh: operationButton("refresh", "刷新", "正在刷新…"),
  };
  const controlReasons = createElement("ul", {
    className: "proxy-control-reasons",
    attributes: { id: "proxy-control-reasons", "aria-live": "polite" },
  });
  for (const button of Object.values(runtimeButtons)) {
    button.setAttribute("aria-describedby", "proxy-control-reasons");
  }

  const metricsHost = createElement("div", { className: "proxy-metrics" });
  const runtimeMetaHost = createElement("div", { className: "proxy-runtime-meta" });
  const transportHost = createElement("div", { className: "proxy-transport" });
  const revisionHost = createElement("div", { className: "proxy-revisions" });
  const nodeCount = createElement("p", { className: "proxy-list-count", text: "节点待加载" });
  const nodeHost = createElement("div", { className: "proxy-node-grid" });

  const runtimeSection = createElement("section", {
    className: "proxy-panel proxy-runtime-panel",
    attributes: { "aria-labelledby": "proxy-runtime-heading" },
  }, [
    createElement("div", { className: "proxy-panel-heading" }, [
      createElement("h2", { text: "代理池运行状态", attributes: { id: "proxy-runtime-heading" } }),
      createElement("div", { className: "proxy-runtime-actions" }, Object.values(runtimeButtons)),
    ]),
    controlReasons,
    metricsHost,
    createElement("div", { className: "proxy-runtime-details" }, [runtimeMetaHost, transportHost, revisionHost]),
    createElement("section", {
      className: "proxy-node-section",
      attributes: { "aria-labelledby": "proxy-node-heading" },
    }, [
      createElement("div", { className: "proxy-subheading" }, [
        createElement("h3", { text: "代理节点", attributes: { id: "proxy-node-heading" } }),
        nodeCount,
      ]),
      nodeHost,
    ]),
  ]);

  const sourceOverview = createElement("div", { className: "proxy-source-overview" });
  const sourceGuard = createElement("div", { className: "proxy-source-guard" });
  const subscriptionCount = createElement("p", { className: "proxy-list-count" });
  const subscriptionHost = createElement("div", { className: "proxy-source-list" });
  const subscriptionAdd = createSourceForm({
    kind: "subscription-add",
    label: "添加完整订阅地址",
    help: "保存后仅显示隐藏敏感信息的订阅地址。",
    inputAttributes: {
      type: "url",
      inputmode: "url",
      placeholder: "https://provider.example/完整订阅地址",
      required: "",
    },
    submitLabel: "保存订阅",
  });

  const nodeFileHost = createElement("div", { className: "proxy-node-file" });
  const nodeFileSet = createSourceForm({
    kind: "node-file-set",
    label: "允许目录中的节点文件",
    help: "文件必须位于服务配置的允许目录中；保存后仅显示相对路径或文件名。",
    inputAttributes: {
      type: "text",
      placeholder: "../subscriptions/provider.yaml",
      required: "",
    },
    submitLabel: "保存节点文件",
  });

  const inlineCount = createElement("p", { className: "proxy-list-count" });
  const inlineHost = createElement("div", { className: "proxy-source-list" });
  const inlineAdd = createSourceForm({
    kind: "inline-add",
    label: "批量添加手动节点（每行一个）",
    help: "空行会被忽略；保存后不会再次显示完整节点信息。",
    inputTag: "textarea",
    inputAttributes: {
      rows: "6",
      placeholder: "每行粘贴一个完整代理节点",
      required: "",
    },
    submitLabel: "批量保存节点",
  });

  const resetButton = sourceActionButton(
    "override-reset",
    "恢复配置文件默认值",
    "正在恢复…",
    { dangerous: true },
  );
  const resetHelp = createElement("p", {
    className: "proxy-field-help",
    text: "删除界面保存的节点来源并恢复配置文件默认值；运行中的代理池不会自动更新。",
    attributes: { id: "proxy-reset-help" },
  });
  resetButton.setAttribute("aria-describedby", "proxy-reset-help");

  const sourcesSection = createElement("section", {
    className: "proxy-panel proxy-sources-panel",
    attributes: { "aria-labelledby": "proxy-sources-heading" },
  }, [
    createElement("div", { className: "proxy-panel-heading" }, [
      createElement("h2", { text: "节点来源", attributes: { id: "proxy-sources-heading" } }),
      resetButton,
    ]),
    sourceOverview,
    sourceGuard,
    createElement("section", {
      className: "proxy-source-group",
      attributes: { "aria-labelledby": "proxy-subscriptions-heading" },
    }, [
      createElement("div", { className: "proxy-subheading" }, [
        createElement("h3", { text: "订阅地址", attributes: { id: "proxy-subscriptions-heading" } }),
        subscriptionCount,
      ]),
      subscriptionHost,
      subscriptionAdd.form,
    ]),
    createElement("section", {
      className: "proxy-source-group",
      attributes: { "aria-labelledby": "proxy-node-file-heading" },
    }, [
      createElement("h3", { text: "节点文件", attributes: { id: "proxy-node-file-heading" } }),
      nodeFileHost,
      nodeFileSet.form,
    ]),
    createElement("section", {
      className: "proxy-source-group",
      attributes: { "aria-labelledby": "proxy-inline-heading" },
    }, [
      createElement("div", { className: "proxy-subheading" }, [
        createElement("h3", { text: "手动节点", attributes: { id: "proxy-inline-heading" } }),
        inlineCount,
      ]),
      inlineHost,
      inlineAdd.form,
    ]),
    createElement("div", { className: "proxy-reset-copy" }, [resetHelp]),
  ]);

  root.classList.add("app-view", "proxy-app");
  root.setAttribute("aria-labelledby", headingId);
  root.replaceChildren(
    createElement("header", { className: "app-header proxy-app-header" }, [
      createElement("p", { className: "app-executable", text: app.windowTitle }),
      createElement("h1", { text: app.label, attributes: { id: headingId } }),
      headerBadge,
      createElement("p", {
        className: "app-summary",
        text: "查看代理池状态并管理节点来源。保存后需手动应用，运行中的代理池不会立即改变。",
      }),
    ]),
    waitingHost,
    operationLive,
    errorHost,
    runtimeSection,
    sourcesSection,
  );

  return {
    headerBadge,
    operationLive,
    errorHost,
    waitingHost,
    runtimeButtons,
    controlReasons,
    metricsHost,
    runtimeMetaHost,
    transportHost,
    revisionHost,
    nodeCount,
    nodeHost,
    sourceOverview,
    sourceGuard,
    subscriptionCount,
    subscriptionHost,
    subscriptionAdd,
    nodeFileHost,
    nodeFileSet,
    inlineCount,
    inlineHost,
    inlineAdd,
    resetButton,
  };
}

export function createReplaceForm(kind, sourceId, index, {
  label,
  help,
  inputTag = "input",
  inputAttributes = {},
}) {
  const inputId = `proxy-${kind}-${index}`;
  const helpId = `${inputId}-help`;
  const input = secretControl(inputTag, {
    id: inputId,
    "aria-describedby": `${helpId} proxy-error-host`,
    required: "",
    ...inputAttributes,
  });
  const submit = sourceActionButton(kind, "保存替换", "正在保存…");
  submit.type = "submit";
  submit.removeAttribute("data-proxy-action");
  const cancel = sourceActionButton("replacement-cancel", "取消");
  const form = createElement("form", {
    className: "proxy-replace-form",
    attributes: { autocomplete: "off", hidden: "", novalidate: "" },
    dataset: { proxyForm: kind, sourceId },
  }, [
    createElement("label", { text: label, attributes: { for: inputId } }),
    input,
    helpText(helpId, help),
    createElement("div", { className: "proxy-form-actions" }, [submit, cancel]),
  ]);
  return { form, input };
}
