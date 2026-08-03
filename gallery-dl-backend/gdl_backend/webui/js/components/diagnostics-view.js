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
  const headerBadge = createStatusBadge("disabled", "诊断待加载");
  const refreshButton = button("refresh", "立即刷新", { primary: true });
  const copyButton = button("copy", "复制脱敏摘要");
  const swagger = createElement("a", {
    className: "diagnostics-button",
    text: "打开 Swagger",
    attributes: { href: "/docs", target: "_blank", rel: "noreferrer noopener" },
  });
  const operationLive = createElement("p", {
    className: "diagnostics-operation-live",
    text: "正在等待首次只读检查。",
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
      createElement("h2", { text: "安全与部署边界", attributes: { id: "diagnostics-security-title" } }),
      configHost,
    ]),
    createElement("section", { className: "diagnostics-panel", attributes: { "aria-labelledby": "diagnostics-scheduler-title" } }, [
      createElement("h2", { text: "调度摘要", attributes: { id: "diagnostics-scheduler-title" } }),
      schedulerHost,
    ]),
    createElement("section", { className: "diagnostics-panel", attributes: { "aria-labelledby": "diagnostics-components-title" } }, [
      createElement("div", { className: "diagnostics-panel-heading" }, [
        createElement("div", {}, [
          createElement("h2", { text: "就绪组件", attributes: { id: "diagnostics-components-title" } }),
          createElement("p", { text: "只显示受控状态、计数和安全下一步，不显示日志、路径、完整配置或原始异常。" }),
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
        text: "DIAG.EXE 只读聚合健康、就绪、最小配置能力与调度摘要；所有写操作留在专属应用。",
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
      label: "诊断待加载", title: "尚无安全诊断快照", message: "应用激活后会启动唯一低频只读轮询。",
    })] : []));
    elements.copyButton.disabled = Boolean(busy || !snapshot);
    if (!snapshot) {
      updateStatusBadge(elements.headerBadge, "disabled", "诊断待加载");
      return;
    }
    if (snapshot.offline) updateStatusBadge(elements.headerBadge, "error", "后端离线 · 显示旧快照");
    else if (snapshot.stale) updateStatusBadge(elements.headerBadge, "warning", "部分状态陈旧");
    else if (snapshot.readiness?.ready) updateStatusBadge(elements.headerBadge, "ready", "系统已就绪");
    else updateStatusBadge(elements.headerBadge, "warning", "系统未完全就绪");

    const warnings = [];
    if (snapshot.offline) {
      warnings.push(createElement("section", { className: "diagnostics-warning" }, [
        createStatusBadge("error", "后端当前离线"),
        createElement("p", { text: "已停止采用新响应；可确认本地服务运行后手动刷新。" }),
      ]));
    } else if (snapshot.stale) {
      warnings.push(createElement("section", { className: "diagnostics-warning" }, [
        createStatusBadge("warning", "快照不完整"),
        createElement("p", { text: "部分端点失败，未用空值覆盖上一次安全组件状态。" }),
      ]));
    }
    const failedEndpoints = Object.entries(snapshot.errors).filter(([, error]) => error);
    if (failedEndpoints.length) {
      warnings.push(createElement("section", { className: "diagnostics-warning" }, [
        createStatusBadge("warning", `${failedEndpoints.length} 个只读请求异常`),
        createElement("p", {
          text: `错误码：${failedEndpoints.map(([name, error]) => `${name}:${error.code}`).join(" · ")}。原始 details 未进入 Store 或 DOM。`,
        }),
      ]));
    }
    elements.warningHost.replaceChildren(...warnings);

    elements.metrics.replaceChildren(
      metric("连接", snapshot.offline ? "离线" : "在线"),
      metric("健康", snapshot.health?.ok ? "通过" : "异常/未知"),
      metric("就绪", snapshot.readiness?.ready ? "通过" : "未完全就绪"),
      metric("检查时间", checkedTime(snapshot.lastCheckedAt)),
    );

    const config = snapshot.config;
    elements.configHost.replaceChildren(config ? definitionList([
      ["回环监听", config.loopbackOnly ? "是" : "否（异常）"],
      ["CORS", config.corsEnabled ? "已配置" : "未启用"],
      ["私网目标", config.privateTargetsEnabled ? "允许（需留意）" : "禁止"],
      ["托管授权缓存", config.managedAuthCache ? "启用" : "未知"],
      ["项目代理池", config.proxyEnabled ? `启用${config.proxyAutoStart ? " / 自动启动" : ""}` : "禁用"],
      ["Mihomo 传输核心", config.transportCoreEnabled ? "启用" : "禁用"],
      ["去重配置", config.dedupEnabled
        ? `${config.configuredDevice} · SSCD ${config.sscdEnabled ? "开" : "关"} · DINO ${config.dinoEnabled ? "开" : "关"}`
        : "禁用"],
    ]) : createEmptyState({
      label: "配置投影不可用", title: "未读取到最小配置能力", message: "不会回退显示 legacy 完整配置。",
    }));

    const scheduler = snapshot.scheduler;
    elements.schedulerHost.replaceChildren(scheduler ? definitionList([
      ["任务调度器", scheduler.tasksRunning ? "运行中" : "未运行"],
      ["活动任务", `${scheduler.activeTasks} / ${scheduler.maxConcurrent}`],
      ["活动来源数", scheduler.activeSiteCount],
      ["顺序批次管理器", scheduler.crawlsRunning ? "运行中" : "未运行"],
      ["活动批次", scheduler.activeBatches],
      ["执行模型", `${scheduler.executionOrder} / ${scheduler.addressParallelism}`],
    ]) : createEmptyState({
      label: "调度摘要不可用", title: "未读取到安全调度投影", message: "请手动刷新；不会展示任务载荷。",
    }));

    const cards = [];
    for (const component of snapshot.readiness?.components || []) {
      const children = [
        createElement("div", { className: "diagnostics-component-heading" }, [
          createElement("h3", { text: component.label }),
          createStatusBadge(component.uiStatus, component.status, { compact: true }),
        ]),
        ...(component.detail ? [createElement("p", { text: component.detail })] : []),
        createElement("p", { className: "diagnostics-next-step", text: component.nextStep }),
      ];
      if (component.targetApp) {
        children.push(button("navigate", `打开 ${component.targetApp === "proxy" ? "PROXY.CPL" : "TASKMGR.EXE"}`, { small: true }));
      }
      cards.push(createElement("article", {
        className: "diagnostics-component",
        dataset: { componentId: component.id, targetApp: component.targetApp },
      }, children));
    }
    elements.componentHost.replaceChildren(...(cards.length ? cards : [createEmptyState({
      label: "组件状态不可用", title: "就绪组件尚未读取", message: "保留旧快照或手动刷新。",
    })]));
  };

  const unsubscribe = context.store.subscribe(selectors.diagnostics, render, { fireImmediately: true });

  return Object.freeze({
    elements,
    setBusy(value) {
      busy = Boolean(value);
      root.toggleAttribute("aria-busy", busy);
      elements.refreshButton.disabled = busy;
      elements.refreshButton.textContent = busy ? "正在刷新…" : "立即刷新";
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
