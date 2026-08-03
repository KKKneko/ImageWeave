import { createElement } from "../core/dom.js";
import {
  deriveProxyControls,
  formatInlineNodeSource,
  formatProxyStatus,
  formatRevisionPair,
  formatRuntimeNode,
  formatSubscriptionSource,
  PROXY_NODE_RENDER_LIMIT,
  proxyErrorGuidance,
} from "../core/proxy-model.js";
import { selectors } from "../core/store.js";
import { createEmptyState } from "./empty-state.js";
import { createErrorView } from "./error-view.js";
import {
  buildProxyDom,
  createReplaceForm,
  definitionList,
  metric,
  sourceActionButton,
  sourceLabel,
} from "./proxy-dom.js";
import { createStatusBadge, updateStatusBadge } from "./status.js";

export function createProxyView(context) {
  const { root, store } = context;
  const elements = buildProxyDom(context);
  let busy = "";
  let renderedError = null;

  const currentStatus = () => store.getState().proxy.status;
  const currentSources = () => store.getState().proxy.sources;

  const clearSecretInputs = (scope = root) => {
    for (const input of scope.querySelectorAll("[data-proxy-secret]")) {
      if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) input.value = "";
    }
  };

  const clearError = () => {
    renderedError?.destroy();
    renderedError = null;
    elements.errorHost.replaceChildren();
  };

  const showError = (error) => {
    clearError();
    const guidance = proxyErrorGuidance(error);
    renderedError = createErrorView(error, { nextStep: guidance.nextStep });
    if (guidance.detail) {
      renderedError.element.append(
        createElement("p", { className: "proxy-error-detail", text: guidance.detail }),
      );
    }
    elements.errorHost.replaceChildren(renderedError.element);
  };

  const setOperationMessage = (message) => {
    elements.operationLive.textContent = message;
  };

  const renderBusyAttributes = () => {
    root.toggleAttribute("aria-busy", Boolean(busy));
    for (const button of root.querySelectorAll("[data-operation-kind]")) {
      if (!(button instanceof HTMLButtonElement)) continue;
      const isCurrent = Boolean(busy && button.dataset.operationKind === busy);
      button.setAttribute("aria-busy", String(isCurrent));
      const label = isCurrent ? button.dataset.pendingLabel : button.dataset.defaultLabel;
      if (label) button.textContent = label;
    }
  };

  const renderWaiting = () => {
    const status = currentStatus();
    const sources = currentSources();
    const waiting = Boolean(status?.reload_required || sources?.reload_required);
    elements.waitingHost.replaceChildren(
      createStatusBadge(
        waiting ? "warning" : sources ? "ready" : "disabled",
        waiting ? "有配置待应用" : sources ? "配置已生效" : "正在加载节点来源",
      ),
      createElement("p", {
        text: waiting
          ? "节点来源已保存；点击“应用并重新加载”后生效。"
          : sources
            ? "保存节点来源不会自动启停或检测代理池。"
            : "正在读取已保存和当前运行的配置版本。",
      }),
    );
    elements.waitingHost.dataset.waiting = String(waiting);
  };

  const renderRevisions = () => {
    const status = currentStatus();
    const sources = currentSources();
    const configured = sources?.configured_revision || status?.configured_revision || null;
    const activeRevision = sources?.active_revision ?? status?.active_revision ?? null;
    const revisions = formatRevisionPair(configured, activeRevision);
    elements.revisionHost.replaceChildren(
      createElement("h3", { text: "配置版本" }),
      definitionList([
        ["已保存", revisions.configured],
        ["当前运行", revisions.active],
        ["关系", revisions.relation],
      ]),
    );
  };

  const renderControls = () => {
    const controls = deriveProxyControls(currentStatus(), { busy });
    const reasons = [];
    for (const [name, model] of Object.entries(controls)) {
      const button = elements.runtimeButtons[name];
      button.disabled = model.disabled;
      button.textContent = model.label;
      button.setAttribute("aria-disabled", String(model.disabled));
      if (model.reason && !reasons.includes(model.reason)) reasons.push(model.reason);
    }
    elements.controlReasons.replaceChildren(
      ...(reasons.length
        ? reasons.map((reason) => createElement("li", { text: reason }))
        : [createElement("li", { text: "停止操作不会中断正在使用代理的任务。" })]),
    );
    renderBusyAttributes();
  };

  const renderNodes = (status) => {
    if (!status) {
      elements.nodeCount.textContent = "节点待加载";
      elements.nodeHost.replaceChildren(createEmptyState({
        label: "等待状态",
        title: "尚未收到代理节点",
        message: "页面激活后会立即刷新运行状态。",
      }));
      return;
    }
    const displayed = status.nodes.slice(0, PROXY_NODE_RENDER_LIMIT);
    const reported = Math.max(status.total, status.node_rows_received);
    elements.nodeCount.textContent = reported > displayed.length
      ? `显示 ${displayed.length} / 服务报告 ${reported}`
      : `共 ${reported} 个节点`;
    if (!displayed.length) {
      elements.nodeHost.replaceChildren(createEmptyState({
        status: status.running ? "warning" : "disabled",
        label: status.running ? "空代理池" : "代理池未启动",
        title: status.running ? "当前运行池没有节点" : "启动后显示节点状态",
        message: status.reload_required
          ? "节点来源已变更，请在没有任务使用代理时点击“应用并重新加载”。"
          : "请检查是否已配置节点来源，再启动代理池或刷新。",
      }));
      return;
    }

    const fragment = document.createDocumentFragment();
    for (const node of displayed) {
      const model = formatRuntimeNode(node);
      const tags = createElement("div", { className: "proxy-tags", attributes: { "aria-label": "节点标签" } });
      if (model.tags.length) {
        for (const tag of model.tags) tags.append(createElement("span", { text: tag }));
      } else {
        tags.append(createElement("span", { text: "无标签" }));
      }
      const card = createElement("article", {
        className: "proxy-node-card",
        attributes: { "aria-label": `代理节点 ${model.name}` },
      }, [
        createElement("div", { className: "proxy-card-heading" }, [
          createElement("div", {}, [
            createElement("h4", { text: model.name }),
            createElement("code", { text: `${model.protocol} · ${model.endpoint}` }),
          ]),
          createStatusBadge(model.state.status, model.state.label),
        ]),
        tags,
        definitionList([
          ["占用状态", model.lease],
          ["最近延迟", model.latency],
          ["累计成功/失败", model.attempts],
          ["等待重试", model.cooldown],
          ["最近错误", model.lastError],
        ], "proxy-node-details"),
      ]);
      if (node.ref_count > 0) card.dataset.leased = "true";
      fragment.append(card);
    }
    if (reported > displayed.length || status.nodes_truncated) {
      fragment.append(createElement("p", {
        className: "proxy-render-limit",
        text: `为保证页面流畅，最多显示前 ${PROXY_NODE_RENDER_LIMIT} 个代理节点；完整数量以上方统计为准。`,
      }));
    }
    elements.nodeHost.replaceChildren(fragment);
  };

  const renderStatus = (status) => {
    const presentation = formatProxyStatus(status);
    updateStatusBadge(elements.headerBadge, presentation.status, presentation.label);
    if (!status) {
      elements.metricsHost.replaceChildren(
        metric("节点", "—"), metric("健康", "—"), metric("可重试", "—"), metric("正在使用", "—"),
      );
      elements.runtimeMetaHost.replaceChildren(createEmptyState({
        label: "等待状态",
        title: "运行摘要待加载",
        message: "可使用手动刷新重试。",
      }));
      elements.transportHost.replaceChildren();
      renderNodes(null);
      renderControls();
      renderWaiting();
      renderRevisions();
      return;
    }

    elements.metricsHost.replaceChildren(
      metric("节点总数", status.total),
      metric("健康", status.healthy, status.running ? "当前运行池" : "池未运行"),
      metric("可重试", status.retry_eligible),
      metric("正在使用", status.leases, status.leases ? "暂时不能停止或重新加载" : "可以更改运行配置"),
    );
    elements.runtimeMetaHost.replaceChildren(
      createElement("h3", { text: "运行设置" }),
      definitionList([
        ["启用", status.enabled ? "是" : "否"],
        ["运行", status.running ? "运行中" : "已停止"],
        ["engine", status.engine],
        ["管理方式", status.managed_by_backend ? "由服务管理" : "未知"],
        ["自动启动", status.auto_start ? "已启用" : "未启用"],
        ["最近错误", status.last_error || "无"],
      ]),
    );
    const core = status.transport_core;
    const coreState = !core.enabled
      ? { status: "disabled", label: "Mihomo 未启用" }
      : core.running
        ? { status: "running", label: "Mihomo 运行中" }
        : core.last_error
          ? { status: "error", label: "Mihomo 启动失败" }
          : { status: "warning", label: "Mihomo 未运行" };
    elements.transportHost.replaceChildren(
      createElement("h3", { text: "Mihomo / 传输核心" }),
      createStatusBadge(coreState.status, coreState.label),
      definitionList([
        ["启用", core.enabled ? "是" : "否"],
        ["运行", core.running ? "是" : "否"],
        ["监听端口数", String(core.listeners)],
        ["最近错误", core.last_error || "无"],
      ]),
    );
    if (status.sources.warnings.length) {
      const warningList = createElement("ul", { className: "proxy-source-warnings" });
      for (const warning of status.sources.warnings) warningList.append(createElement("li", { text: warning }));
      elements.runtimeMetaHost.append(createElement("h4", { text: "节点源警告" }), warningList);
    }
    renderNodes(status);
    renderControls();
    renderWaiting();
    renderRevisions();
  };

  const replacementActions = (type) => createElement("div", { className: "proxy-row-actions" }, [
    sourceActionButton(`${type}-replace-open`, "替换"),
    sourceActionButton(`${type}-delete`, "删除", "正在删除…", { dangerous: true }),
  ]);

  const renderSubscriptions = (sources) => {
    const items = sources?.subscriptions || [];
    elements.subscriptionCount.textContent = sources ? `${sources.counts.subscriptions} 项` : "待加载";
    if (!sources || !items.length) {
      elements.subscriptionHost.replaceChildren(createEmptyState({
        label: sources ? "无订阅" : "等待代理源",
        title: sources ? "尚未配置订阅地址" : "订阅列表正在加载",
        message: "添加时请输入完整地址；保存后仅显示隐藏敏感信息的地址。",
      }));
      return;
    }
    const fragment = document.createDocumentFragment();
    items.forEach((subscription, index) => {
      const model = formatSubscriptionSource(subscription);
      const replacement = createReplaceForm("subscription-replace", subscription.id, index, {
        label: "请输入完整新订阅地址",
        help: "出于安全考虑，原地址不会重新显示。取消、失败或离开页面都会清空输入。",
        inputAttributes: {
          type: "url",
          inputmode: "url",
          placeholder: "https://provider.example/完整新地址",
        },
      });
      fragment.append(createElement("article", {
        className: "proxy-source-card",
        dataset: { sourceId: subscription.id, sourceType: "subscription" },
      }, [
        createElement("div", { className: "proxy-card-heading" }, [
          createElement("div", {}, [
            createElement("h4", { text: model.display }),
            createElement("p", { text: model.authority }),
          ]),
          createStatusBadge(subscription.source === "runtime" ? "running" : "ready", sourceLabel(model.source)),
        ]),
        createElement("p", { className: "proxy-redaction-note", text: model.redaction }),
        replacementActions("subscription"),
        replacement.form,
      ]));
    });
    elements.subscriptionHost.replaceChildren(fragment);
  };

  const renderNodeFile = (sources) => {
    const nodeFile = sources?.node_file;
    if (!sources || !nodeFile?.configured) {
      elements.nodeFileHost.replaceChildren(createEmptyState({
        label: sources ? "未配置文件" : "等待代理源",
        title: sources ? "没有节点文件" : "节点文件状态待加载",
        message: "仅可设置服务允许目录中的普通文件。",
      }));
      return;
    }
    elements.nodeFileHost.replaceChildren(createElement("article", { className: "proxy-source-card" }, [
      createElement("div", { className: "proxy-card-heading" }, [
        createElement("div", {}, [
          createElement("h4", { text: nodeFile.display_path || "路径已隐藏" }),
          createElement("p", { text: "仅显示隐藏敏感信息后的路径" }),
        ]),
        createStatusBadge(nodeFile.source === "runtime" ? "running" : "ready", sourceLabel(nodeFile.source)),
      ]),
      createElement("div", { className: "proxy-row-actions" }, [
        sourceActionButton("node-file-clear", "清除节点文件", "正在清除…", { dangerous: true }),
      ]),
    ]));
  };

  const renderInlineNodes = (sources) => {
    const items = sources?.inline_nodes || [];
    elements.inlineCount.textContent = sources ? `${sources.counts.inline_nodes} 项` : "待加载";
    if (!sources || !items.length) {
      elements.inlineHost.replaceChildren(createEmptyState({
        label: sources ? "无手动节点" : "正在加载节点来源",
        title: sources ? "尚未配置手动节点" : "手动节点列表正在加载",
        message: "可一次粘贴多行；保存后仅显示协议、主机和隐藏敏感信息后的地址。",
      }));
      return;
    }
    const fragment = document.createDocumentFragment();
    items.forEach((node, index) => {
      const model = formatInlineNodeSource(node);
      const replacement = createReplaceForm("inline-replace", node.id, index, {
        label: "请输入完整新节点",
        help: "出于安全考虑，原节点不会重新显示。",
        inputTag: "textarea",
        inputAttributes: { rows: "3", placeholder: "粘贴一个完整新节点" },
      });
      fragment.append(createElement("article", {
        className: "proxy-source-card",
        dataset: { sourceId: node.id, sourceType: "inline-node" },
      }, [
        createElement("div", { className: "proxy-card-heading" }, [
          createElement("div", {}, [
            createElement("h4", { text: model.display }),
            createElement("p", { text: model.identity }),
          ]),
          createStatusBadge(node.source === "runtime" ? "running" : "ready", sourceLabel(model.source)),
        ]),
        definitionList([
          ["主机", model.authority],
          ["传输", model.transport],
        ]),
        replacementActions("inline"),
        replacement.form,
      ]));
    });
    elements.inlineHost.replaceChildren(fragment);
  };

  const renderSourceControls = () => {
    const sources = currentSources();
    const blocked = Boolean(busy || !sources || !sources.runtime_override_valid);
    for (const form of root.querySelectorAll("[data-proxy-form]")) {
      for (const control of form.querySelectorAll("input, textarea, button")) {
        if (
          control instanceof HTMLInputElement ||
          control instanceof HTMLTextAreaElement ||
          control instanceof HTMLButtonElement
        ) {
          control.disabled = blocked;
          control.setAttribute("aria-disabled", String(blocked));
        }
      }
    }
    for (const button of root.querySelectorAll(
      '[data-proxy-action$="-replace-open"], [data-proxy-action$="-delete"], [data-proxy-action="node-file-clear"]',
    )) {
      if (button instanceof HTMLButtonElement) {
        button.disabled = blocked;
        button.setAttribute("aria-disabled", String(blocked));
      }
    }
    elements.resetButton.disabled = Boolean(busy || !sources?.has_runtime_override);
    elements.resetButton.setAttribute("aria-disabled", String(elements.resetButton.disabled));
    renderBusyAttributes();
  };

  const renderSources = (sources) => {
    if (!sources) {
      elements.sourceOverview.replaceChildren(createEmptyState({
        label: "正在加载节点来源",
        title: "节点来源正在加载",
        message: "页面打开后会自动加载，修改或运行操作后也会刷新。",
      }));
      elements.sourceGuard.replaceChildren();
    } else {
      elements.sourceOverview.replaceChildren(
        createStatusBadge(
          sources.reload_required ? "warning" : "ready",
          sources.reload_required ? "有配置待应用" : "配置已生效",
        ),
        definitionList([
          ["当前来源", sourceLabel(sources.source)],
          ["界面自定义设置", sources.has_runtime_override ? "存在" : "不存在"],
          ["设置有效", sources.runtime_override_valid ? "是" : "否"],
          ["订阅", String(sources.counts.subscriptions)],
          ["节点文件", String(sources.counts.node_file)],
          ["手动节点", String(sources.counts.inline_nodes)],
          ["来源总计", String(sources.counts.total)],
        ], "proxy-source-summary"),
      );
      elements.sourceGuard.replaceChildren(
        ...(sources.runtime_override_valid
          ? []
          : [createElement("section", {
              className: "proxy-corrupt-warning",
              attributes: { role: "alert" },
            }, [
              createStatusBadge("error", "自定义配置已损坏"),
              createElement("p", {
                text: "当前正在使用配置文件默认值。请恢复默认设置后再编辑。",
              }),
            ])]),
      );
    }
    renderSubscriptions(sources);
    renderNodeFile(sources);
    renderInlineNodes(sources);
    renderSourceControls();
    renderWaiting();
    renderRevisions();
  };

  const renderAllControls = () => {
    renderControls();
    renderSourceControls();
  };

  const unsubscribeStatus = store.subscribe(selectors.proxyStatus, renderStatus, { fireImmediately: true });
  const unsubscribeSources = store.subscribe(selectors.proxySources, renderSources, { fireImmediately: true });

  return Object.freeze({
    clearSecretInputs,
    clearError,
    showError,
    setOperationMessage,
    setBusy(kind) {
      busy = kind;
      renderAllControls();
    },
    destroy() {
      clearSecretInputs();
      unsubscribeStatus();
      unsubscribeSources();
      clearError();
      root.replaceChildren();
      root.removeAttribute("aria-busy");
    },
  });
}
