import { createElement } from "../core/dom.js";
import {
  formatReviewBytes,
  reviewApplyCounts,
  reviewCanList,
  reviewImageUrl,
  REVIEW_FILTERS,
} from "../core/review-model.js";
import { formatBatchTime, shortBatchId, TERMINAL_BATCH_STATUSES } from "../core/tasks-model.js";
import { selectors } from "../core/store.js";
import { createEmptyState } from "./empty-state.js";
import { createErrorView } from "./error-view.js";
import { createStatusBadge, updateStatusBadge } from "./status.js";

const KIND_LABELS = Object.freeze({ duplicate: "重复组", single: "独立图片", unreadable: "读取失败" });

function button(action, label, { primary = false, dangerous = false, small = false } = {}) {
  return createElement("button", {
    className: [
      "review-button",
      primary ? "review-button--primary" : "",
      dangerous ? "review-button--dangerous" : "",
      small ? "review-button--small" : "",
    ].filter(Boolean).join(" "),
    text: label,
    attributes: { type: "button" },
    dataset: { reviewAction: action },
  });
}

function metric(label, value) {
  return createElement("div", { className: "review-metric" }, [
    createElement("span", { text: label }),
    createElement("strong", { text: String(value) }),
  ]);
}

function buildDom(context) {
  const { root, app } = context;
  const headingId = "review-heading";
  const batchSelect = createElement("select", {
    attributes: { "aria-label": "已结束批次" },
    dataset: { reviewBatchSelect: "" },
  }, [createElement("option", { text: "暂无已结束批次", attributes: { value: "" } })]);
  const loadButton = button("load-batch", "打开审核", { primary: true });
  const refreshButton = button("refresh", "刷新");
  const errorHost = createElement("div", { className: "review-error-host", dataset: { reviewError: "" } });
  const operationLive = createElement("p", {
    className: "review-operation-live",
    text: "选择一个已结束批次。",
    attributes: { "aria-live": "polite" },
    dataset: { reviewLive: "" },
  });
  const statusBadge = createStatusBadge("disabled", "尚未载入审核");
  const actionHost = createElement("div", { className: "review-status-actions", dataset: { reviewStatusActions: "" } });
  const stats = createElement("div", { className: "review-metrics", dataset: { reviewMetrics: "" } });
  const tabs = createElement("div", {
    className: "review-tabs",
    attributes: { role: "tablist", "aria-label": "审核分组筛选" },
    dataset: { reviewTabs: "" },
  });
  for (const filter of REVIEW_FILTERS) {
    tabs.append(createElement("button", {
      className: "review-tab",
      text: filter.label,
      attributes: { type: "button", role: "tab", "aria-selected": "false" },
      dataset: { reviewAction: "filter", reviewFilter: filter.id },
    }));
  }
  const bulkActions = createElement("div", { className: "review-bulk-actions" }, [
    button("page-all", "本页全留", { small: true }),
    button("page-none", "本页全不留", { dangerous: true, small: true }),
    button("page-recommended", "每组仅留推荐", { small: true }),
  ]);
  const groupHost = createElement("div", { className: "review-groups", dataset: { reviewGroups: "" } });
  const dirtyLive = createElement("p", {
    className: "review-dirty-live",
    text: "没有未保存选择。",
    attributes: { "aria-live": "polite" },
    dataset: { reviewDirty: "false" },
  });
  const pageSummary = createElement("span", { dataset: { reviewPageSummary: "" } });
  const footer = createElement("div", { className: "review-footer", dataset: { reviewFooter: "" } }, [
    createElement("div", { className: "review-pagination" }, [
      button("previous", "上一页", { small: true }),
      pageSummary,
      button("next", "下一页", { small: true }),
    ]),
    createElement("div", { className: "review-save-actions" }, [
      button("save", "保存本页选择", { primary: true }),
      button("apply", "应用审核结果", { dangerous: true }),
    ]),
  ]);
  const workspace = createElement("section", {
    className: "review-panel review-workspace",
    attributes: { hidden: "", "aria-labelledby": "review-workspace-title" },
    dataset: { reviewWorkspace: "" },
  }, [
    createElement("div", { className: "review-panel-heading" }, [
      createElement("div", {}, [
        createElement("h2", { text: "去重与质量审核", attributes: { id: "review-workspace-title" } }),
        createElement("p", { text: "服务端分页固定为 8 组；图片由受限审核端点懒加载。" }),
      ]),
      statusBadge,
    ]),
    actionHost,
    stats,
    createElement("div", { className: "review-controls" }, [tabs, bulkActions]),
    dirtyLive,
    groupHost,
    footer,
  ]);
  const emptyHost = createElement("div", { dataset: { reviewEmpty: "" } });

  root.classList.add("app-view", "review-app");
  root.setAttribute("aria-labelledby", headingId);
  root.replaceChildren(
    createElement("header", { className: "app-header review-app-header" }, [
      createElement("p", { className: "app-executable", text: app.windowTitle }),
      createElement("h1", { text: app.label, attributes: { id: headingId } }),
      createStatusBadge("ready", "默认最大化 · 服务端分页"),
      createElement("p", {
        className: "app-summary",
        text: "显式启动分析、分页审核、危险应用确认与写后权威刷新均保持后端真实语义。",
      }),
    ]),
    errorHost,
    operationLive,
    createElement("section", { className: "review-panel review-picker", attributes: { "aria-labelledby": "review-picker-title" } }, [
      createElement("div", { className: "review-panel-heading" }, [
        createElement("div", {}, [
          createElement("h2", { text: "终态批次", attributes: { id: "review-picker-title" } }),
          createElement("p", { text: "进行中的批次不能启动或应用审核。" }),
        ]),
        createStatusBadge("running", "分析状态按需轮询"),
      ]),
      createElement("div", { className: "review-picker-row" }, [batchSelect, loadButton, refreshButton, button("open-tasks", "打开 TASKMGR.EXE")]),
    ]),
    emptyHost,
    workspace,
  );

  return {
    batchSelect, loadButton, refreshButton, errorHost, operationLive, statusBadge, actionHost,
    stats, tabs, bulkActions, groupHost, dirtyLive, pageSummary, footer, workspace, emptyHost,
  };
}

function syncSelections(elements, review) {
  for (const group of review.groups) {
    const groupElement = [...elements.groupHost.querySelectorAll("[data-review-group]")]
      .find((item) => item.dataset.reviewGroup === group.id);
    if (!groupElement) continue;
    const count = groupElement.querySelector("[data-review-group-count]");
    if (count) count.textContent = `${group.selectedImageCount}/${group.imageCount} 保留`;
    groupElement.toggleAttribute("data-decided", group.decided);
    for (const image of group.images) {
      const card = [...groupElement.querySelectorAll("[data-review-image]")]
        .find((item) => item.dataset.reviewImage === image.id);
      if (!card) continue;
      const checkbox = card.querySelector("input[type=checkbox]");
      if (checkbox) checkbox.checked = image.selected;
      card.dataset.selected = String(image.selected);
    }
  }
  elements.dirtyLive.dataset.reviewDirty = String(review.dirty);
  elements.dirtyLive.textContent = review.dirty
    ? "△ 本页选择尚未保存；翻页、筛选或离开应用前会先保存，失败则阻止切换。"
    : "✓ 本页选择与最后一次服务器确认一致。";
}

function imageFacts(image) {
  const facts = [
    image.width && image.height ? `${image.width}×${image.height}` : "尺寸未知",
    image.format,
    formatReviewBytes(image.bytes),
  ];
  if (image.jpegQuality !== null) facts.push(`约 Q${image.jpegQuality}`);
  return facts.join(" · ");
}

function renderGroups(elements, review) {
  for (const image of elements.groupHost.querySelectorAll("img")) image.removeAttribute("src");
  if (!review.groups.length) {
    elements.groupHost.replaceChildren(createEmptyState({
      label: "当前筛选为空", title: "没有可显示的审核组", message: "可切换筛选或返回其他批次。",
    }));
    return;
  }
  const editable = review.summary.status === "ready";
  const groups = [];
  for (const group of review.groups) {
    const header = createElement("div", { className: "review-group-heading" }, [
      createElement("div", {}, [
        createElement("strong", { text: `组 ${group.ordinal}` }),
        createStatusBadge(group.kind === "unreadable" ? "error" : group.kind === "duplicate" ? "warning" : "ready", KIND_LABELS[group.kind], { compact: true }),
        createElement("span", { text: `${group.selectedImageCount}/${group.imageCount} 保留`, dataset: { reviewGroupCount: "" } }),
        ...(group.matchLevels.map((level) => createElement("span", { className: "review-match-level", text: level }))),
      ]),
    ]);
    if (editable) {
      header.append(createElement("div", { className: "review-group-actions" }, [
        button("group-all", "全留", { small: true }),
        button("group-none", "全不留", { dangerous: true, small: true }),
        button("group-recommended", "仅推荐", { small: true }),
      ]));
    }
    const grid = createElement("div", { className: "review-image-grid" });
    for (const image of group.images) {
      const preview = createElement("img", {
        attributes: {
          src: reviewImageUrl(review.batchId, image.id),
          alt: `组 ${group.ordinal} 图片 ${image.ordinal}`,
          loading: "lazy",
          decoding: "async",
        },
      });
      const fallback = createElement("span", {
        className: "review-image-fallback",
        text: image.readable ? "预览加载失败" : "图片不可读",
        attributes: { hidden: "" },
      });
      preview.addEventListener("error", () => {
        preview.hidden = true;
        fallback.hidden = false;
      }, { once: true });
      const media = createElement("div", { className: "review-image-media" }, [preview, fallback]);
      if (image.recommended) media.append(createElement("span", { className: "review-recommended", text: "质量推荐" }));
      const details = [createElement("span", { text: imageFacts(image) })];
      if (image.sharpness !== null || image.noiseSigma !== null) {
        details.push(createElement("span", {
          text: `细节 ${Number(image.sharpness || 0).toFixed(1)} · 噪声 ${Number(image.noiseSigma || 0).toFixed(2)}`,
        }));
      }
      if (image.metrics) {
        const metrics = [image.metrics.candidateLevel];
        if (image.metrics.sscdSimilarity !== null) metrics.push(`SSCD ${image.metrics.sscdSimilarity.toFixed(3)}`);
        if (image.metrics.dinoSimilarity !== null) metrics.push(`DINO ${image.metrics.dinoSimilarity.toFixed(3)}`);
        details.push(createElement("span", { className: "review-image-metrics", text: metrics.join(" · ") }));
      }
      const checkbox = createElement("input", {
        attributes: { type: "checkbox", disabled: editable ? null : "", checked: image.selected ? "" : null },
        dataset: { reviewImageToggle: image.id },
      });
      checkbox.checked = image.selected;
      checkbox.disabled = !editable;
      const card = createElement("article", {
        className: "review-image-card",
        dataset: { reviewImage: image.id, selected: String(image.selected) },
      }, [
        media,
        createElement("div", { className: "review-image-copy" }, [
          ...details,
          createElement("label", { className: "review-selection" }, [checkbox, createElement("span", { text: "保留" })]),
        ]),
      ]);
      grid.append(card);
    }
    groups.push(createElement("section", {
      className: "review-group",
      dataset: { reviewGroup: group.id, decided: String(group.decided) },
    }, [header, grid]));
  }
  elements.groupHost.replaceChildren(...groups);
}

export function createReviewView(context) {
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
      onAction: () => actions.navigateToApp("diagnostics"),
    });
    elements.errorHost.replaceChildren(renderedError.element);
  };

  const renderBatches = (recent) => {
    const selected = store.getState().review.batchId || store.getState().batches.activeId || elements.batchSelect.value;
    const terminal = recent.filter((batch) => TERMINAL_BATCH_STATUSES.has(batch.status));
    const options = [createElement("option", {
      text: terminal.length ? "选择已结束批次" : "暂无已结束批次",
      attributes: { value: "" },
    })];
    for (const batch of terminal) {
      const option = createElement("option", {
        text: `${batch.statusLabel} · ${shortBatchId(batch.id)} · ${formatBatchTime(batch.createdAt)}`,
        attributes: { value: batch.id },
      });
      option.selected = batch.id === selected;
      options.push(option);
    }
    elements.batchSelect.replaceChildren(...options);
  };

  const renderActions = (review) => {
    const status = review.summary.status;
    const actionsList = [];
    if (["not_started", "waiting_for_crawl"].includes(status)) {
      actionsList.push(button("start", "开始去重分析", { primary: true }));
    }
    if (status === "failed") actionsList.push(button("retry", "重试分析", { primary: true }));
    if (review.dirty && status !== "ready") {
      actionsList.push(button("discard-reload", "放弃陈旧选择并重载", { dangerous: true }));
    }
    elements.actionHost.replaceChildren(...actionsList);
  };

  const renderStats = (summary) => {
    elements.stats.replaceChildren(
      metric("全部图片", summary.totalImageCount),
      metric("严格自动组", summary.automaticGroupCount),
      metric("严格自动淘汰", summary.automaticRejectedImageCount),
      metric("重复组", summary.duplicateGroupCount),
      metric("当前保留", summary.selectedImageCount),
      metric("已确认组", `${summary.decidedGroupCount}/${summary.totalGroupCount}`),
      metric("读取失败", summary.unreadableImageCount),
      ...(["applied", "apply_failed"].includes(summary.status)
        ? [metric("已移出 / 失败", `${summary.rejectedImageCount}/${summary.failedImageCount}`)]
        : []),
    );
  };

  const renderControls = (review) => {
    const listable = reviewCanList(review.summary);
    elements.tabs.hidden = !listable;
    elements.bulkActions.hidden = review.summary.status !== "ready";
    elements.footer.hidden = !listable;
    for (const tab of elements.tabs.querySelectorAll("[data-review-filter]")) {
      const selected = tab.dataset.reviewFilter === review.filter;
      tab.setAttribute("aria-selected", String(selected));
      tab.classList.toggle("review-tab--active", selected);
      tab.disabled = Boolean(busy);
    }
    const start = review.total ? review.offset + 1 : 0;
    const end = Math.min(review.offset + review.groups.length, review.total);
    elements.pageSummary.textContent = `${start}–${end} / ${review.total}`;
    const previous = elements.footer.querySelector('[data-review-action="previous"]');
    const next = elements.footer.querySelector('[data-review-action="next"]');
    const save = elements.footer.querySelector('[data-review-action="save"]');
    const apply = elements.footer.querySelector('[data-review-action="apply"]');
    previous.disabled = Boolean(busy || review.offset <= 0);
    next.disabled = Boolean(busy || review.offset + review.limit >= review.total);
    save.hidden = review.summary.status !== "ready";
    save.disabled = Boolean(busy || !review.groups.length || !review.dirty);
    apply.hidden = !["ready", "apply_failed"].includes(review.summary.status);
    apply.textContent = review.summary.status === "apply_failed" ? "重试应用结果" : "应用审核结果";
    apply.disabled = Boolean(busy || (review.summary.status === "ready" &&
      review.summary.decidedGroupCount < review.summary.totalGroupCount && !review.dirty));
  };

  const renderReview = (review, previous, metadata) => {
    const hasReview = Boolean(review.batchId && review.summary);
    elements.workspace.hidden = !hasReview;
    elements.emptyHost.replaceChildren(...(!hasReview ? [createEmptyState({
      label: "尚未选择审核批次",
      title: "选择已结束批次后打开审核",
      message: "审核不会由读取操作隐式启动。",
    })] : []));
    if (!hasReview) return;
    updateStatusBadge(elements.statusBadge, review.summary.statusKind, review.summary.statusLabel);
    renderActions(review);
    renderStats(review.summary);
    renderControls(review);
    const selectionOnly = [
      "review/imageSelectionChanged", "review/groupModeChanged", "review/pageModeChanged",
    ].includes(metadata?.type) && previous?.batchId === review.batchId && previous?.groups.length === review.groups.length;
    if (selectionOnly) syncSelections(elements, review);
    else {
      renderGroups(elements, review);
      syncSelections(elements, review);
    }
  };

  const unsubscribeRecent = store.subscribe((state) => state.batches.recent, renderBatches, { fireImmediately: true });
  const unsubscribeReview = store.subscribe(selectors.review, renderReview, { fireImmediately: true });

  return Object.freeze({
    elements,
    selectedBatchId: () => elements.batchSelect.value,
    clearError,
    showError,
    setOperationMessage(message) {
      elements.operationLive.textContent = message;
    },
    setBusy(kind) {
      busy = kind;
      root.toggleAttribute("aria-busy", Boolean(kind));
      renderReview(store.getState().review, store.getState().review, { type: "busy" });
      if (kind) {
        for (const control of root.querySelectorAll("button, select, input")) {
          control.disabled = true;
        }
      }
    },
    releaseImages() {
      for (const image of elements.groupHost.querySelectorAll("img")) image.removeAttribute("src");
    },
    applyConfirmationText() {
      const counts = reviewApplyCounts(store.getState().review.summary);
      return `严格自动淘汰 ${counts.automatic} 张；最终保留 ${counts.selected} 张，预计移出 ${counts.rejected} 张。`;
    },
    destroy() {
      unsubscribeRecent();
      unsubscribeReview();
      for (const image of elements.groupHost.querySelectorAll("img")) image.removeAttribute("src");
      clearError();
      root.replaceChildren();
      root.removeAttribute("aria-busy");
    },
  });
}
