import { createElement } from "../core/dom.js";
import {
  batchProgress,
  formatBatchTime,
  shortBatchId,
  taskRecoveryTargets,
  TERMINAL_BATCH_STATUSES,
} from "../core/tasks-model.js";
import { createEmptyState } from "./empty-state.js";
import { createErrorView } from "./error-view.js";
import { createStatusBadge, updateStatusBadge } from "./status.js";

const SITE_LABELS = Object.freeze({
  danbooru: "Danbooru", twitter: "X / Twitter", pixiv: "Pixiv", exhentai: "EH", pawchive: "Pawchive",
  unknown: "未知来源",
});

function button(action, label, { primary = false, dangerous = false, small = false } = {}) {
  return createElement("button", {
    className: [
      "tasks-button",
      primary ? "tasks-button--primary" : "",
      dangerous ? "tasks-button--dangerous" : "",
      small ? "tasks-button--small" : "",
    ].filter(Boolean).join(" "),
    text: label,
    attributes: { type: "button" },
    dataset: { tasksAction: action },
  });
}

function metric(label, value) {
  return createElement("div", { className: "tasks-metric" }, [
    createElement("span", { text: label }),
    createElement("strong", { text: String(value) }),
  ]);
}

function buildDom(context) {
  const { root, app } = context;
  const headingId = "tasks-heading";
  const recent = createElement("select", {
    attributes: { "aria-label": "最近批次" },
    dataset: { tasksRecent: "" },
  }, [createElement("option", { text: "暂无批次", attributes: { value: "" } })]);
  const headerBadge = createStatusBadge("disabled", "尚未选择批次");
  const operationLive = createElement("p", {
    className: "tasks-operation-live",
    text: "正在等待批次选择。",
    attributes: { "aria-live": "polite" },
    dataset: { tasksLive: "" },
  });
  const errorHost = createElement("div", { className: "tasks-error-host", dataset: { tasksError: "" } });
  const actionsRow = createElement("div", { className: "tasks-actions" }, [
    button("load", "载入批次", { primary: true }),
    button("refresh", "立即刷新"),
    button("retry", "补齐失败下载"),
    button("rerun", "重新爬取"),
    button("cancel", "取消批次", { dangerous: true }),
  ]);
  const emptyHost = createElement("div", { dataset: { tasksEmpty: "" } });
  const metricsHost = createElement("div", { className: "tasks-metrics", dataset: { tasksMetrics: "" } });
  const progress = createElement("progress", {
    className: "tasks-progress",
    attributes: { max: "100", value: "0", "aria-label": "批次任务进度" },
    dataset: { tasksProgress: "" },
  });
  const progressText = createElement("p", { className: "tasks-progress-text", dataset: { tasksProgressText: "" } });
  const sourceHost = createElement("div", { className: "tasks-sources", dataset: { tasksSources: "" } });
  const recoveryHost = createElement("div", { className: "tasks-recovery", dataset: { tasksRecovery: "" } });
  const taskHost = createElement("div", { className: "tasks-list", dataset: { tasksList: "" } });
  const taskSummary = createElement("p", { className: "tasks-list-summary", dataset: { tasksSummary: "" } });
  const reviewHost = createElement("div", { className: "tasks-review-entry", dataset: { tasksReview: "" } });
  const workspace = createElement("section", {
    className: "tasks-panel tasks-workspace",
    attributes: { hidden: "", "aria-labelledby": "tasks-workspace-title" },
    dataset: { tasksWorkspace: "" },
  }, [
    createElement("div", { className: "tasks-panel-heading" }, [
      createElement("h2", { text: "当前批次", attributes: { id: "tasks-workspace-title" } }),
      headerBadge,
    ]),
    metricsHost,
    progress,
    progressText,
    recoveryHost,
    createElement("section", { className: "tasks-source-section" }, [
      createElement("h3", { text: "来源与地址顺序" }),
      sourceHost,
    ]),
    reviewHost,
    createElement("section", { className: "tasks-task-section" }, [
      createElement("div", { className: "tasks-panel-heading" }, [
        createElement("h3", { text: "图片任务" }),
        taskSummary,
      ]),
      taskHost,
    ]),
  ]);

  root.classList.add("app-view", "tasks-app");
  root.setAttribute("aria-labelledby", headingId);
  root.replaceChildren(
    createElement("header", { className: "app-header tasks-app-header" }, [
      createElement("p", { className: "app-executable", text: app.windowTitle }),
      createElement("h1", { text: app.label, attributes: { id: headingId } }),
      createStatusBadge("running", "应用级自动刷新"),
      createElement("p", {
        className: "app-summary",
        text: "批次级取消、补齐失败和重新规划均使用后端真实状态机；没有单任务强制操作。",
      }),
    ]),
    errorHost,
    operationLive,
    createElement("section", { className: "tasks-panel tasks-picker", attributes: { "aria-labelledby": "tasks-picker-title" } }, [
      createElement("div", { className: "tasks-panel-heading" }, [
        createElement("div", {}, [
          createElement("h2", { text: "最近批次", attributes: { id: "tasks-picker-title" } }),
          createElement("p", { text: "只保存后端生成的 active batch ID 到受限会话键。" }),
        ]),
        createStatusBadge("running", "活动批次 1.5 秒刷新"),
      ]),
      createElement("div", { className: "tasks-picker-row" }, [recent, actionsRow]),
    ]),
    emptyHost,
    workspace,
  );

  return {
    recent, actionsRow, headerBadge, operationLive, errorHost, emptyHost, workspace,
    metricsHost, progress, progressText, sourceHost, recoveryHost, taskHost, taskSummary, reviewHost,
  };
}

function findButton(elements, action) {
  return elements.actionsRow.querySelector(`[data-tasks-action="${action}"]`);
}

function renderSources(elements, batch) {
  const cards = [];
  for (const source of batch.sources) {
    const card = createElement("section", { className: "tasks-source-card" }, [
      createElement("div", { className: "tasks-source-heading" }, [
        createElement("strong", { text: `${source.order + 1}. ${SITE_LABELS[source.site] || source.site}` }),
        createStatusBadge(source.statusKind, source.statusLabel, { compact: true }),
      ]),
    ]);
    if (!source.addresses.length) {
      card.append(createEmptyState({
        label: "暂无地址", title: "来源地址尚未建立", message: "批次规划后会显示安全摘要。",
      }));
    }
    for (const address of source.addresses) {
      const facts = [
        `任务 ${address.plannedTaskCount}`,
        `成功 ${address.succeededTaskCount}`,
        `失败 ${address.failedTaskCount}`,
      ];
      if (address.preDedupSkippedCount) facts.push(`预去重 ${address.preDedupSkippedCount}`);
      if (address.probedProxyCount) facts.push(`代理 ${address.healthyProxyCount}/${address.probedProxyCount}`);
      if (address.hasPlanningIssue) facts.push("存在受控规划错误");
      card.append(createElement("div", {
        className: `tasks-address${batch.current?.addressId === address.id ? " tasks-address--current" : ""}`,
      }, [
        createElement("span", { className: "tasks-order", text: String(address.order + 1) }),
        createStatusBadge(address.statusKind, address.statusLabel, { compact: true }),
        createElement("strong", { text: address.label }),
        createElement("span", { text: facts.join(" · ") }),
      ]));
    }
    cards.push(card);
  }
  elements.sourceHost.replaceChildren(...(cards.length ? cards : [createEmptyState({
    label: "等待规划", title: "来源顺序尚未可用", message: "批次开始规划后自动刷新。",
  })]));
}

function renderTasks(elements, batch, tasks) {
  const total = batch.taskCount;
  elements.taskSummary.textContent = total > tasks.length
    ? `显示前 ${tasks.length} / 共 ${total} 个；完整进度以批次聚合计数为准`
    : `显示 ${tasks.length} / 共 ${total} 个`;
  if (!tasks.length) {
    elements.taskHost.replaceChildren(createEmptyState({
      label: batch.current?.status === "planning" ? "正在规划" : "暂无任务",
      title: batch.current?.status === "planning" ? "正在枚举当前地址图片" : "当前还没有图片任务",
      message: "任务建立后会显示顺序、来源、状态与尝试次数；原始 URL 和任务载荷不会进入 DOM。",
    }));
    return;
  }
  const table = createElement("table", { className: "tasks-table" }, [
    createElement("thead", {}, [createElement("tr", {}, [
      createElement("th", { text: "顺序" }), createElement("th", { text: "来源" }),
      createElement("th", { text: "状态" }), createElement("th", { text: "尝试" }),
      createElement("th", { text: "结果" }),
    ])]),
  ]);
  const body = createElement("tbody");
  for (const task of tasks) {
    const result = task.errorClass
      ? task.errorClass === "authentication"
        ? "需要重新授权"
        : task.errorClass.includes("proxy")
          ? "需要检查代理"
          : `受控错误：${task.errorClass}`
      : task.artifactCount
        ? `已记录 ${task.artifactCount} 个文件`
        : "—";
    body.append(createElement("tr", {}, [
      createElement("td", { text: `${task.sourceOrder + 1}.${task.addressOrder + 1}.${task.sequence}` }),
      createElement("td", { text: SITE_LABELS[task.site] || task.site }),
      createElement("td", {}, [createStatusBadge(task.statusKind, task.statusLabel, { compact: true })]),
      createElement("td", { text: `${task.attemptCount}/${task.maxAttempts}` }),
      createElement("td", { text: result }),
    ]));
  }
  table.append(body);
  elements.taskHost.replaceChildren(createElement("div", { className: "tasks-table-wrap" }, [table]));
}

export function createTasksView(context) {
  const { root, store, actions } = context;
  const elements = buildDom(context);
  let busy = "";
  let renderedError = null;

  const clearError = () => {
    renderedError?.destroy();
    renderedError = null;
    elements.errorHost.replaceChildren();
  };

  const showError = (guidance) => {
    clearError();
    renderedError = createErrorView({
      code: guidance.code,
      message: guidance.message,
      requestId: guidance.requestId,
    }, {
      statusLabel: guidance.title,
      nextStep: guidance.nextStep,
      actionLabel: guidance.targetApp === "vault"
        ? "打开 VAULT.CPL"
        : guidance.targetApp === "proxy"
          ? "打开 PROXY.CPL"
          : "打开 DIAG.EXE",
      onAction: () => actions.navigateToApp(guidance.targetApp),
    });
    elements.errorHost.replaceChildren(renderedError.element);
  };

  const renderRecent = (batches) => {
    const selected = store.getState().batches.activeId || elements.recent.value;
    const options = [createElement("option", {
      text: batches.length ? "选择一个批次" : "暂无批次",
      attributes: { value: "" },
    })];
    for (const batch of batches) {
      const option = createElement("option", {
        text: `${batch.statusLabel} · ${shortBatchId(batch.id)} · ${formatBatchTime(batch.createdAt)}`,
        attributes: { value: batch.id },
      });
      option.selected = batch.id === selected;
      options.push(option);
    }
    elements.recent.replaceChildren(...options);
  };

  const renderRecovery = (batch, tasks) => {
    const targets = taskRecoveryTargets(tasks);
    const notices = [];
    if (targets.authSites.length) {
      notices.push(createElement("section", { className: "tasks-recovery-card" }, [
        createStatusBadge("warning", `${targets.authSites.length} 个来源需要授权`),
        createElement("p", { text: "任务只暴露 authentication 分类，不显示 Cookie、Token 或原始错误。" }),
        button("open-vault", "打开 VAULT.CPL", { small: true }),
      ]));
    }
    if (targets.proxyIssue) {
      notices.push(createElement("section", { className: "tasks-recovery-card" }, [
        createStatusBadge("warning", "检测到代理类失败"),
        createElement("p", { text: "先检查代理池，再使用批次级补齐；不会强制中断租约。" }),
        button("open-proxy", "打开 PROXY.CPL", { small: true }),
      ]));
    }
    if (batch.status === "completed_with_errors") {
      notices.push(createElement("section", { className: "tasks-recovery-card" }, [
        createStatusBadge("warning", "批次部分失败"),
        createElement("p", { text: batch.resumable
          ? "可使用“补齐失败下载”恢复；成功文件会跳过。"
          : "后端当前未标记可恢复，请刷新权威状态后决定下一步。" }),
      ]));
    }
    elements.recoveryHost.replaceChildren(...notices);
  };

  const renderReviewEntry = (batch) => {
    const review = batch.review;
    if (!TERMINAL_BATCH_STATUSES.has(batch.status) || !review) {
      elements.reviewHost.replaceChildren();
      return;
    }
    elements.reviewHost.replaceChildren(createElement("section", { className: "tasks-review-card" }, [
      createStatusBadge(review.kind, review.label),
      createElement("p", { text: review.status === "ready"
        ? `待审核 ${review.totalGroupCount} 组；已确认 ${review.decidedGroupCount} 组。`
        : "审核状态由 REVIEW.EXE 独立读取和轮询。" }),
      button("open-review", "在 REVIEW.EXE 中打开", { primary: true }),
    ]));
  };

  const render = (batches) => {
    renderRecent(batches.recent);
    const batch = batches.active;
    const tasks = batches.tasks;
    elements.workspace.hidden = !batch;
    elements.emptyHost.replaceChildren(...(!batch ? [createEmptyState({
      label: "尚未选择批次",
      title: "从最近批次载入，或先在 CRAWL.EXE 创建",
      message: "切换、最小化或隐藏页面时不会继续应用级轮询。",
    })] : []));
    if (!batch) return;
    updateStatusBadge(elements.headerBadge, batch.statusKind, batch.statusLabel);
    const progress = batchProgress(batch);
    elements.progress.value = progress.percent;
    elements.progressText.textContent = `${progress.terminal} / ${progress.total} 个任务终态 · ${progress.percent}%`;
    elements.metricsHost.replaceChildren(
      metric("批次 ID", shortBatchId(batch.id)),
      metric("当前地址", batch.current ? `${SITE_LABELS[batch.current.site] || batch.current.site} · ${batch.current.statusLabel}` : "—"),
      metric("成功 / 失败 / 取消", `${batch.succeededTaskCount} / ${batch.failedTaskCount} / ${batch.cancelledTaskCount}`),
      metric("图片并发", batch.concurrency || "—"),
      metric("预去重跳过", batch.preDedupSkippedCount),
    );
    renderSources(elements, batch);
    renderRecovery(batch, tasks);
    renderTasks(elements, batch, tasks);
    renderReviewEntry(batch);
    const terminal = TERMINAL_BATCH_STATUSES.has(batch.status);
    findButton(elements, "cancel").disabled = Boolean(busy || terminal);
    findButton(elements, "retry").disabled = Boolean(busy || !batch.resumable || !terminal);
    findButton(elements, "rerun").disabled = Boolean(busy || !terminal);
  };

  const unsubscribe = store.subscribe((state) => state.batches, render, { fireImmediately: true });

  return Object.freeze({
    elements,
    selectedRecentId: () => elements.recent.value,
    setOperationMessage(message) {
      elements.operationLive.textContent = message;
    },
    setBusy(kind) {
      busy = kind;
      root.toggleAttribute("aria-busy", Boolean(kind));
      for (const control of elements.actionsRow.querySelectorAll("button, select")) {
        control.disabled = Boolean(kind);
      }
      const labels = {
        load: "正在载入…", refresh: "正在刷新…", retry: "正在补齐…",
        rerun: "正在重新规划…", cancel: "正在取消…",
      };
      for (const [action, label] of Object.entries(labels)) {
        const control = findButton(elements, action);
        control.textContent = kind === action ? label : {
          load: "载入批次", refresh: "立即刷新", retry: "补齐失败下载",
          rerun: "重新爬取", cancel: "取消批次",
        }[action];
      }
      render(store.getState().batches);
    },
    clearError,
    showError,
    destroy() {
      unsubscribe();
      clearError();
      root.replaceChildren();
      root.removeAttribute("aria-busy");
    },
  });
}
