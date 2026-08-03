import { createElement } from "../core/dom.js";
import { selectors } from "../core/store.js";
import { createEmptyState } from "./empty-state.js";
import { createStatusBadge, updateStatusBadge } from "./status.js";

function button(action, label, { primary = false, small = false } = {}) {
  return createElement("button", {
    className: `diagnostics-button${primary ? " diagnostics-button--primary" : ""}${small ? " diagnostics-button--small" : ""}`,
    text: label,
    attributes: { type: "button" },
    dataset: { diagnosticsAction: action },
  });
}

function metric(label, value) {
  return createElement("div", { className: "diagnostics-metric" }, [
    createElement("span", { text: label }),
    createElement("strong", { text: String(value) }),
  ]);
}

function definitionList(items) {
  const list = createElement("dl", { className: "diagnostics-definitions" });
  for (const [label, value] of items) {
    list.append(createElement("div", {}, [
      createElement("dt", { text: label }),
      createElement("dd", { text: String(value) }),
    ]));
  }
  return list;
}

function buildDom(context) {
  const { root, app } = context;
  const headingId = "diagnostics-heading";
  const headerBadge = createStatusBadge("disabled", "正在加载诊断");
  const refreshButton = button("refresh", "刷新", { primary: true });
  const copyButton = button("copy", "复制诊断摘要");
  const swagger = createElement("a", {
    className: "diagnostics-button",
    text: "打开 API 文档",
    attributes: { href: "/docs", target: "_blank", rel: "noreferrer noopener" },
  });
  const operationLive = createElement("p", {
    className: "diagnostics-operation-live",
    text: "正在等待首次检查。",
    attributes: { "aria-live": "polite" },
    dataset: { diagnosticsLive: "" },
  });
  const warningHost = createElement("div", { className: "diagnostics-warning-host", dataset: { diagnosticsWarnings: "" } });
  const metrics = createElement("div", { className: "diagnostics-metrics", dataset: { diagnosticsMetrics: "" } });
  const configHost = createElement("div", { dataset: { diagnosticsConfig: "" } });
  const schedulerHost = createElement("div", { dataset: { diagnosticsScheduler: "" } });
  const componentHost = createElement("div", { className: "diagnostics-components", dataset: { diagnosticsComponents: "" } });
  const content = createElement("div", { attributes: { hidden: "" }, dataset: { diagnosticsContent: "" } }, [
    metrics,
    createElement("section", { className: "diagnostics-panel", attributes: { "aria-labelledby": "diagnostics-security-title" } }, [
      createElement("h2", { text: "安全配置", attributes: { id: "diagnostics-security-title" } }),
      configHost,
    ]),
    createElement("section", { className: "diagnostics-panel", attributes: { "aria-labelledby": "diagnostics-scheduler-title" } }, [
      createElement("h2", { text: "任务调度", attributes: { id: "diagnostics-scheduler-title" } }),
      schedulerHost,
    ]),
    createElement("section", { className: "diagnostics-panel", attributes: { "aria-labelledby": "diagnostics-components-title" } }, [
      createElement("div", { className: "diagnostics-panel-heading" }, [
        createElement("div", {}, [
          createElement("h2", { text: "组件状态", attributes: { id: "diagnostics-components-title" } }),
          createElement("p", { text: "已隐藏日志、路径、完整配置和原始错误信息。" }),
        ]),
      ]),
      componentHost,
    ]),
  ]);
  const emptyHost = createElement("div", { dataset: { diagnosticsEmpty: "" } });

  root.classList.add("app-view", "diagnostics-app");
  root.setAttribute("aria-labelledby", headingId);
  root.replaceChildren(
    createElement("header", { className: "app-header diagnostics-app-header" }, [
      createElement("p", { className: "app-executable", text: app.windowTitle }),
      createElement("h1", { text: app.label, attributes: { id: headingId } }),
      headerBadge,
      createElement("p", {
        className: "app-summary",
        text: "查看服务、代理、任务调度和去重环境的运行状态。此页面不会修改系统配置。",
      }),
      createElement("div", { className: "diagnostics-actions" }, [refreshButton, copyButton, swagger]),
    ]),
    operationLive,
    warningHost,
    emptyHost,
    content,
  );

  return {
    headerBadge, refreshButton, copyButton, operationLive, warningHost, metrics,
    configHost, schedulerHost, componentHost, content, emptyHost,
  };
}

function checkedTime(value) {
  if (!Number.isFinite(value)) return "—";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).format(new Date(value));
  } catch {
    return "—";
  }
}

export function createDiagnosticsView(context) {
  const { root } = context;
  const elements = buildDom(context);
  let busy = false;

  const render = (snapshot) => {
    elements.content.hidden = !snapshot;
    elements.emptyHost.replaceChildren(...(!snapshot ? [createEmptyState({
      label: "正在加载诊断", title: "尚无诊断结果", message: "页面打开后会自动刷新诊断信息。",
    })] : []));
    elements.copyButton.disabled = Boolean(busy || !snapshot);
    if (!snapshot) {
      updateStatusBadge(elements.headerBadge, "disabled", "正在加载诊断");
      return;
    }
    if (snapshot.offline) updateStatusBadge(elements.headerBadge, "error", "服务离线 · 显示上次结果");
    else if (snapshot.stale) updateStatusBadge(elements.headerBadge, "warning", "部分状态未更新");
    else if (snapshot.readiness?.ready) updateStatusBadge(elements.headerBadge, "ready", "系统已就绪");
    else updateStatusBadge(elements.headerBadge, "warning", "系统未完全就绪");

    const warnings = [];
    if (snapshot.offline) {
      warnings.push(createElement("section", { className: "diagnostics-warning" }, [
        createStatusBadge("error", "服务离线"),
        createElement("p", { text: "请确认本地服务正在运行，然后刷新。" }),
      ]));
    } else if (snapshot.stale) {
      warnings.push(createElement("section", { className: "diagnostics-warning" }, [
        createStatusBadge("warning", "部分状态未更新"),
        createElement("p", { text: "部分检查失败，当前显示上次成功读取的状态。" }),
      ]));
    }
    const failedEndpoints = Object.entries(snapshot.errors).filter(([, error]) => error);
    if (failedEndpoints.length) {
      warnings.push(createElement("section", { className: "diagnostics-warning" }, [
        createStatusBadge("warning", `${failedEndpoints.length} 项检查异常`),
        createElement("p", {
          text: `错误码：${failedEndpoints.map(([name, error]) => `${name}:${error.code}`).join(" · ")}。详细错误信息已隐藏。`,
        }),
      ]));
    }
    elements.warningHost.replaceChildren(...warnings);

    elements.metrics.replaceChildren(
      metric("连接", snapshot.offline ? "离线" : "在线"),
      metric("服务状态", snapshot.health?.ok ? "正常" : "异常/未知"),
      metric("功能状态", snapshot.readiness?.ready ? "已就绪" : "未完全就绪"),
      metric("检查时间", checkedTime(snapshot.lastCheckedAt)),
    );

    const config = snapshot.config;
    elements.configHost.replaceChildren(config ? definitionList([
      ["回环监听", config.loopbackOnly ? "是" : "否（异常）"],
      ["CORS", config.corsEnabled ? "已配置" : "未启用"],
      ["私网目标", config.privateTargetsEnabled ? "允许（需留意）" : "禁止"],
      ["授权缓存", config.managedAuthCache ? "启用" : "未知"],
      ["代理池", config.proxyEnabled ? `启用${config.proxyAutoStart ? " / 自动启动" : ""}` : "禁用"],
      ["Mihomo 传输核心", config.transportCoreEnabled ? "启用" : "禁用"],
      ["去重配置", config.dedupEnabled
        ? `${config.configuredDevice} · SSCD ${config.sscdEnabled ? "开" : "关"} · DINO ${config.dinoEnabled ? "开" : "关"}`
        : "禁用"],
    ]) : createEmptyState({
      label: "无法读取安全配置", title: "安全配置不可用", message: "请刷新后重试。",
    }));

    const scheduler = snapshot.scheduler;
    elements.schedulerHost.replaceChildren(scheduler ? definitionList([
      ["任务调度器", scheduler.tasksRunning ? "运行中" : "未运行"],
      ["活动任务", `${scheduler.activeTasks} / ${scheduler.maxConcurrent}`],
      ["活动来源数", scheduler.activeSiteCount],
      ["批次调度", scheduler.crawlsRunning ? "运行中" : "未运行"],
      ["活动批次", scheduler.activeBatches],
      ["执行方式", `${scheduler.executionOrder} / ${scheduler.addressParallelism}`],
    ]) : createEmptyState({
      label: "无法读取任务调度状态", title: "任务调度状态不可用", message: "请刷新后重试。",
    }));

    const cards = [];
    for (const component of snapshot.readiness?.components || []) {
      const children = [
        createElement("div", { className: "diagnostics-component-heading" }, [
          createElement("h3", { text: component.label }),
          createStatusBadge(component.uiStatus, component.statusLabel, { compact: true }),
        ]),
        ...(component.detail ? [createElement("p", { text: component.detail })] : []),
        createElement("p", { className: "diagnostics-next-step", text: component.nextStep }),
      ];
      if (component.targetApp) {
        children.push(button("navigate", `打开 ${component.targetApp === "proxy" ? "代理管理" : "批次管理"}`, { small: true }));
      }
      cards.push(createElement("article", {
        className: "diagnostics-component",
        dataset: { componentId: component.id, targetApp: component.targetApp },
      }, children));
    }
    elements.componentHost.replaceChildren(...(cards.length ? cards : [createEmptyState({
      label: "组件状态不可用", title: "尚未读取组件状态", message: "请刷新后重试。",
    })]));
  };

  const unsubscribe = context.store.subscribe(selectors.diagnostics, render, { fireImmediately: true });

  return Object.freeze({
    elements,
    setBusy(value) {
      busy = Boolean(value);
      root.toggleAttribute("aria-busy", busy);
      elements.refreshButton.disabled = busy;
      elements.refreshButton.textContent = busy ? "正在刷新…" : "刷新";
      elements.copyButton.disabled = busy || !context.store.getState().diagnostics.snapshot;
    },
    setOperationMessage(message) {
      elements.operationLive.textContent = message;
    },
    render,
    destroy() {
      unsubscribe();
      root.replaceChildren();
      root.removeAttribute("aria-busy");
    },
  });
}
