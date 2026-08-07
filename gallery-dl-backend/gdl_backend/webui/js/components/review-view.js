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

const KIND_LABELS = Object.freeze({
  duplicate: "重复组",
  single: "独立图片",
  unreadable: "读取失败",
});

const KIND_STATUS = Object.freeze({
  duplicate: "warning",
  single: "ready",
  unreadable: "error",
});

function button(action, label, { primary = false, dangerous = false, small = false, title = "" } = {}) {
  return createElement("button", {
    className: [
      "review-button",
      primary ? "review-button--primary" : "",
      dangerous ? "review-button--dangerous" : "",
      small ? "review-button--small" : "",
    ].filter(Boolean).join(" "),
    text: label,
    attributes: { type: "button", title: title || null },
    dataset: { reviewAction: action },
  });
}

function commandButton(action, key, label, options = {}) {
  const control = button(action, "", { ...options, small: true });
  control.classList.add("review-deck-command");
  control.append(
    createElement("kbd", { text: key, attributes: { "aria-hidden": "true" } }),
    createElement("span", { text: label }),
  );
  control.setAttribute("aria-label", `${key}：${label}`);
  return control;
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
  const tasksButton = button("open-tasks", "打开批次管理");
  const batchControls = createElement("div", { className: "review-picker-row review-batch-controls" }, [
    batchSelect,
    loadButton,
    refreshButton,
    tasksButton,
  ]);
  const errorHost = createElement("div", { className: "review-error-host", dataset: { reviewError: "" } });
  const operationLive = createElement("p", {
    className: "review-operation-live",
    text: "选择一个已结束批次。",
    attributes: { "aria-live": "polite", role: "status" },
    dataset: { reviewLive: "", reviewDirty: "false" },
  });

  const appHeader = createElement("header", { className: "app-header review-app-header" }, [
    createElement("p", { className: "app-executable", text: app.windowTitle }),
    createElement("h1", { text: app.label, attributes: { id: headingId } }),
    createElement("p", {
      className: "app-summary",
      text: "启动分析后，可逐页确认保留项；应用结果前会再次确认。",
    }),
  ]);
  const pickerRowHost = createElement("div", { dataset: { reviewPickerControls: "" } }, [batchControls]);
  const nonDeckLiveHost = createElement("div", {
    className: "review-panel-live",
    dataset: { reviewPanelLive: "" },
  }, [operationLive]);
  const picker = createElement("section", {
    className: "review-panel review-picker",
    attributes: { "aria-labelledby": "review-picker-title" },
  }, [
    createElement("div", { className: "review-panel-heading" }, [
      createElement("div", {}, [
        createElement("h2", { text: "已结束批次", attributes: { id: "review-picker-title" } }),
        createElement("p", { text: "仅已结束的采集批次可以开始去重分析。" }),
      ]),
      createStatusBadge("running", "分析状态自动刷新"),
    ]),
    pickerRowHost,
    nonDeckLiveHost,
  ]);

  const statusBadge = createStatusBadge("disabled", "尚未载入审核");
  const actionHost = createElement("div", {
    className: "review-status-actions",
    dataset: { reviewStatusActions: "" },
  });
  const stats = createElement("div", { className: "review-metrics", dataset: { reviewMetrics: "" } });
  const stateHost = createElement("div", { className: "review-state-host", dataset: { reviewStateHost: "" } });
  const workspace = createElement("section", {
    className: "review-panel review-workspace",
    attributes: { hidden: "", "aria-labelledby": "review-workspace-title" },
    dataset: { reviewWorkspace: "" },
  }, [
    createElement("div", { className: "review-panel-heading" }, [
      createElement("div", {}, [
        createElement("h2", { text: "去重与质量审核", attributes: { id: "review-workspace-title" } }),
        createElement("p", { text: "分析、应用与错误恢复继续沿用现有审核流程。" }),
      ]),
      statusBadge,
    ]),
    actionHost,
    stats,
    stateHost,
  ]);
  const emptyHost = createElement("div", { dataset: { reviewEmpty: "" } });

  const deckStatusBadge = createStatusBadge("disabled", "尚未载入审核");
  const deckBatchId = createElement("strong", { text: "批次 —", dataset: { reviewDeckBatch: "" } });
  const progressText = createElement("strong", { text: "已决 0/0 组", dataset: { reviewProgressText: "" } });
  const progressFill = createElement("span", { className: "review-deck-progress-fill", dataset: { reviewProgressFill: "" } });
  const progressTrack = createElement("span", {
    className: "review-deck-progress-track",
    attributes: {
      role: "progressbar",
      "aria-label": "审核总进度",
      "aria-valuemin": "0",
      "aria-valuemax": "0",
      "aria-valuenow": "0",
    },
  }, [progressFill]);
  const tabs = createElement("div", {
    className: "review-tabs review-deck-tabs",
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
  const deckBatchControlsHost = createElement("div", {
    className: "review-deck-batch-controls",
    dataset: { reviewDeckBatchControls: "" },
  });
  const deckActionHost = createElement("div", {
    className: "review-deck-actions",
    dataset: { reviewDeckActions: "" },
  });
  const deckHeader = createElement("header", { className: "review-deck-header" }, [
    createElement("div", { className: "review-deck-identity" }, [deckBatchId, deckStatusBadge]),
    createElement("div", { className: "review-deck-progress" }, [progressText, progressTrack]),
    tabs,
    createElement("div", { className: "review-deck-utilities" }, [deckBatchControlsHost, deckActionHost]),
  ]);

  const stage = createElement("section", {
    className: "review-deck-stage",
    attributes: { tabindex: "-1", role: "group", "aria-label": "当前审核组" },
    dataset: { reviewStage: "" },
  });
  const inspector = createElement("aside", {
    className: "review-deck-inspector",
    attributes: {
      id: "review-deck-inspector",
      "aria-label": "图片属性与质量指标",
    },
    dataset: { reviewInspector: "" },
  });
  const deckBody = createElement("div", {
    className: "review-deck-body",
    dataset: { reviewDeckBody: "", inspector: "on" },
  }, [stage, inspector]);
  const filmstrip = createElement("nav", {
    className: "review-deck-filmstrip",
    attributes: { "aria-label": "本页审核组" },
    dataset: { reviewFilmstrip: "" },
  });
  const commandHost = createElement("div", { className: "review-deck-command-list", dataset: { reviewCommands: "" } }, [
    commandButton("prev-group", "←", "上一组"),
    commandButton("next-group", "→", "下一组"),
    commandButton("first-group", "Home", "本页首组"),
    commandButton("last-group", "End", "本页末组"),
    commandButton("accept", "⏎", "采纳并前进", { primary: true }),
    commandButton("group-all", "A", "全部保留"),
    commandButton("group-none", "D", "全部移除", { dangerous: true }),
    commandButton("group-recommended", "R", "恢复推荐"),
    commandButton("toggle-inspector", "I", "指标"),
    commandButton("save", "S", "保存本页"),
  ]);
  const deckLiveHost = createElement("div", {
    className: "review-deck-live-host",
    dataset: { reviewDeckLive: "" },
  });
  const statusBar = createElement("footer", { className: "review-deck-statusbar" }, [commandHost, deckLiveHost]);
  const deck = createElement("section", {
    className: "review-deck",
    attributes: { hidden: "", "aria-label": "专注分拣台" },
    dataset: { reviewDeck: "" },
  }, [deckHeader, deckBody, filmstrip, statusBar]);

  root.classList.add("app-view", "review-app");
  root.dataset.mode = "panel";
  root.setAttribute("aria-labelledby", headingId);
  root.replaceChildren(appHeader, errorHost, picker, emptyHost, workspace, deck);

  return {
    appHeader,
    batchSelect,
    loadButton,
    refreshButton,
    tasksButton,
    batchControls,
    pickerRowHost,
    picker,
    errorHost,
    operationLive,
    statusBadge,
    actionHost,
    stats,
    stateHost,
    nonDeckLiveHost,
    workspace,
    emptyHost,
    deck,
    deckHeader,
    deckStatusBadge,
    deckBatchId,
    progressText,
    progressTrack,
    progressFill,
    tabs,
    deckBatchControlsHost,
    deckActionHost,
    deckBody,
    stage,
    inspector,
    filmstrip,
    commandHost,
    deckLiveHost,
    statusBar,
  };
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

function metricValue(value, digits) {
  return value === null ? "—" : Number(value).toFixed(digits);
}

function currentGroup(review, focusedIndex) {
  return review.groups[focusedIndex] || null;
}

function findByDataset(container, selector, key, value) {
  return [...container.querySelectorAll(selector)].find((element) => element.dataset[key] === value) || null;
}

function nonDeckState(summary) {
  const presentations = {
    not_started: ["等待开始", "尚未开始去重分析", "开始后会先分析相似图片，再进入人工审核。"],
    waiting_for_crawl: ["等待采集结束", "批次尚未准备好", "采集结束后即可开始去重分析。"],
    pending: ["分析已排队", "正在等待分析资源", "状态会自动刷新，无需重复提交。"],
    analyzing: ["正在分析", "正在计算近似图片与质量指标", "分析完成后会自动进入专注分拣台。"],
    auto_applying: ["自动处理中", "正在应用无需人工确认的结果", "完成后会继续刷新审核状态。"],
    failed: ["分析失败", "去重分析未能完成", "可重试分析；若持续失败，请打开系统诊断。"],
    disabled: ["审核未启用", "当前服务未启用去重审核", "请先在服务配置中启用相应能力。"],
  };
  return presentations[summary.status] || [summary.statusLabel, "审核状态已更新", "请刷新或稍后重试。"];
}

export function createReviewView(context) {
  const { root, store, actions } = context;
  const elements = buildDom(context);
  let busy = "";
  let renderedError = null;
  let focusedIndex = 0;
  let activeImageId = "";
  let confirmedIds = new Set();
  const compactInspectorQuery = typeof globalThis.matchMedia === "function"
    ? globalThis.matchMedia("(max-width: 1007px)")
    : null;
  let inspectorCollapsed = compactInspectorQuery?.matches === true;
  let inspectorUserToggled = false;
  let completionVisible = false;
  let renderedPageKey = "";
  let adjacentPreviews = [];
  let imagesReleased = false;

  const reviewState = () => store.getState().review;
  const deckPageKey = (review) => `${review.batchId}\u0000${review.filter}\u0000${review.offset}`;
  const editable = (review = reviewState()) => review.summary?.status === "ready" && !busy;

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

  const releasePreloads = () => {
    for (const image of adjacentPreviews) image.removeAttribute("src");
    adjacentPreviews = [];
  };

  const releaseStageImages = () => {
    for (const image of elements.stage.querySelectorAll("img")) image.removeAttribute("src");
  };

  const releaseImages = () => {
    releaseStageImages();
    releasePreloads();
    imagesReleased = true;
  };

  const loadImageWindow = (review) => {
    releasePreloads();
    const group = currentGroup(review, focusedIndex);
    if (!group) {
      imagesReleased = false;
      return;
    }
    for (const preview of elements.stage.querySelectorAll("[data-review-preview-image]")) {
      if (preview.dataset.previewFailed === "true" || preview.hasAttribute("src")) continue;
      const imageId = preview.dataset.reviewPreviewImage;
      if (group.images.some((image) => image.id === imageId && image.readable)) {
        preview.setAttribute("src", reviewImageUrl(review.batchId, imageId));
      }
    }
    const neighborIndexes = focusedIndex + 1 < review.groups.length
      ? [focusedIndex + 1]
      : focusedIndex > 0
        ? [focusedIndex - 1]
        : [];
    for (const index of neighborIndexes) {
      for (const image of review.groups[index].images) {
        if (!image.readable) continue;
        const preview = createElement("img", {
          attributes: { alt: "", "aria-hidden": "true", decoding: "async" },
        });
        preview.setAttribute("src", reviewImageUrl(review.batchId, image.id));
        adjacentPreviews.push(preview);
      }
    }
    imagesReleased = false;
  };

  const syncInspectorVisibility = () => {
    elements.inspector.hidden = inspectorCollapsed;
    elements.deckBody.dataset.inspector = inspectorCollapsed ? "off" : "on";
    for (const control of root.querySelectorAll('[data-review-action="toggle-inspector"]')) {
      control.setAttribute("aria-controls", elements.inspector.id);
      control.setAttribute("aria-expanded", String(!inspectorCollapsed));
    }
    const commandLabel = elements.commandHost.querySelector('[data-review-action="toggle-inspector"] span');
    if (commandLabel) commandLabel.textContent = inspectorCollapsed ? "展开指标" : "收起指标";
  };

  const onInspectorViewportChange = (event) => {
    if (inspectorUserToggled) return;
    inspectorCollapsed = event.matches;
    syncInspectorVisibility();
  };

  const placeSharedElements = (deckMode, hasReview = false) => {
    if (deckMode) {
      elements.deckBatchControlsHost.append(elements.batchControls);
      elements.deckActionHost.append(elements.actionHost);
      elements.deckLiveHost.append(elements.operationLive);
    } else {
      elements.pickerRowHost.append(elements.batchControls);
      elements.workspace.insertBefore(elements.actionHost, elements.stats);
      elements[hasReview ? "workspace" : "picker"].append(elements.nonDeckLiveHost);
      elements.nonDeckLiveHost.append(elements.operationLive);
    }
  };

  const renderBatches = (recent) => {
    const selected = reviewState().batchId || store.getState().batches.activeId || elements.batchSelect.value;
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
    elements.batchSelect.disabled = Boolean(busy);
  };

  const renderActions = (review) => {
    const status = review.summary.status;
    const controls = [];
    if (["not_started", "waiting_for_crawl"].includes(status)) {
      controls.push(button("start", "开始去重分析", { primary: true }));
    }
    if (status === "failed") controls.push(button("retry", "重试分析", { primary: true }));
    if (review.dirty && status !== "ready") {
      controls.push(button("discard-reload", "放弃更改并重新加载", { dangerous: true }));
    }
    if (["ready", "apply_failed"].includes(status)) {
      controls.push(button("apply", status === "apply_failed" ? "重试整理文件" : "应用并整理文件", {
        dangerous: true,
      }));
    }
    elements.actionHost.replaceChildren(...controls);
  };

  const renderStats = (summary) => {
    elements.stats.replaceChildren(
      metric("全部图片", summary.totalImageCount),
      metric("自动去重组", summary.automaticGroupCount),
      metric("自动移除", summary.automaticRejectedImageCount),
      metric("重复组", summary.duplicateGroupCount),
      metric("当前保留", summary.selectedImageCount),
      metric("已确认组", `${summary.decidedGroupCount}/${summary.totalGroupCount}`),
      metric("读取失败", summary.unreadableImageCount),
      ...(["applied", "apply_failed"].includes(summary.status)
        ? [metric("已移出 / 失败", `${summary.rejectedImageCount}/${summary.failedImageCount}`)]
        : []),
    );
  };

  const renderNonDeckState = (review) => {
    const [label, title, message] = nonDeckState(review.summary);
    elements.stateHost.replaceChildren(createEmptyState({ label, title, message }));
  };

  const renderDeckHeader = (review) => {
    const summary = review.summary;
    elements.deckBatchId.textContent = `批次 ${shortBatchId(review.batchId)}`;
    updateStatusBadge(elements.deckStatusBadge, summary.statusKind, summary.statusLabel);
    const total = summary.totalGroupCount;
    const decided = Math.min(summary.decidedGroupCount, total);
    const percentage = total ? (decided / total) * 100 : 0;
    elements.progressText.textContent = `已决 ${decided}/${total} 组`;
    elements.progressTrack.setAttribute("aria-valuemax", String(total));
    elements.progressTrack.setAttribute("aria-valuenow", String(decided));
    elements.progressTrack.setAttribute("aria-valuetext", `已确认 ${decided}，共 ${total} 组`);
    elements.progressFill.style.width = `${percentage.toFixed(2)}%`;
    for (const tab of elements.tabs.querySelectorAll("[data-review-filter]")) {
      const selected = tab.dataset.reviewFilter === review.filter;
      tab.setAttribute("aria-selected", String(selected));
      tab.classList.toggle("review-tab--active", selected);
    }
  };

  const buildImageCard = (review, group, image, index) => {
    const fallback = createElement("span", {
      className: "review-image-fallback",
      text: image.readable ? "预览加载失败" : "图片不可读",
      attributes: image.readable ? { hidden: "" } : {},
      dataset: { reviewImageFallback: image.id },
    });
    const mediaChildren = [];
    if (image.readable) {
      const preview = createElement("img", {
        attributes: {
          alt: `组 ${group.ordinal} 图片 ${index + 1}`,
          loading: "lazy",
          decoding: "async",
        },
        dataset: { reviewPreviewImage: image.id },
      });
      preview.addEventListener("error", () => {
        preview.dataset.previewFailed = "true";
        preview.hidden = true;
        preview.removeAttribute("src");
        fallback.hidden = false;
      }, { once: true });
      mediaChildren.push(preview);
    }
    mediaChildren.push(
      fallback,
      createElement("span", { className: "review-image-index", text: String(index + 1), attributes: { "aria-hidden": "true" } }),
    );
    if (image.recommended) {
      mediaChildren.push(createElement("span", { className: "review-recommended", text: "★ 推荐" }));
    }
    mediaChildren.push(createElement("span", {
      className: "review-image-stamp",
      text: image.selected ? "✓ 保留" : "✗ 移除",
      dataset: { reviewStamp: image.id, state: image.selected ? "keep" : "drop" },
    }));
    const media = createElement("div", { className: "review-image-media" }, mediaChildren);
    const details = [createElement("span", { text: imageFacts(image) })];
    if (image.sharpness !== null || image.noiseSigma !== null) {
      details.push(createElement("span", {
        text: `清晰度 ${metricValue(image.sharpness, 1)} · 噪声 ${metricValue(image.noiseSigma, 2)}`,
      }));
    }
    if (image.metrics) {
      const metrics = [image.metrics.candidateLevel];
      if (image.metrics.sscdSimilarity !== null) metrics.push(`SSCD ${image.metrics.sscdSimilarity.toFixed(3)}`);
      if (image.metrics.dinoSimilarity !== null) metrics.push(`DINO ${image.metrics.dinoSimilarity.toFixed(3)}`);
      details.push(createElement("span", { className: "review-image-metrics", text: metrics.join(" · ") }));
    }
    const selectedLabel = image.selected ? "保留" : "移除";
    const recommendation = image.recommended ? "，推荐项" : "";
    return createElement("article", {
      className: "review-image-card",
      attributes: {
        role: "checkbox",
        tabindex: "0",
        "aria-checked": String(image.selected),
        "aria-disabled": String(!editable(review)),
        "aria-label": `图 ${index + 1}${recommendation}，当前${selectedLabel}，${imageFacts(image)}`,
      },
      dataset: {
        reviewImage: image.id,
        reviewImageGroup: group.id,
        reviewImageIndex: index,
        selected: String(image.selected),
        active: String(image.id === activeImageId),
      },
    }, [media, createElement("div", { className: "review-image-copy" }, details)]);
  };

  const renderCompletion = () => {
    elements.stage.querySelector("[data-review-complete]")?.remove();
    if (!completionVisible) return;
    const counts = reviewApplyCounts(reviewState().summary);
    const overlay = createElement("div", {
      className: "review-deck-complete",
      attributes: { role: "dialog", "aria-modal": "true", "aria-labelledby": "review-complete-title" },
      dataset: { reviewComplete: "" },
    }, [createElement("div", { className: "review-deck-complete-box" }, [
      createElement("h2", { text: "本批次已全部过一遍", attributes: { id: "review-complete-title" } }),
      createElement("p", {
        text: `自动移除 ${counts.automatic} 张；最终保留 ${counts.selected} 张，预计移出 ${counts.rejected} 张。`,
      }),
      createElement("div", { className: "review-deck-complete-actions" }, [
        button("apply", "应用并整理文件", { primary: true, dangerous: true }),
        button("return-review", "返回复查"),
      ]),
    ])]);
    elements.stage.append(overlay);
    if (!busy) {
      queueMicrotask(() => {
        if (!completionVisible || busy || !root.contains(overlay)) return;
        overlay.querySelector('[data-review-action="apply"]')?.focus({ preventScroll: true });
      });
    }
  };

  const renderStage = (review) => {
    releaseStageImages();
    releasePreloads();
    const group = currentGroup(review, focusedIndex);
    elements.stage.replaceChildren();
    elements.stage.dataset.reviewGroup = group?.id || "";
    if (!group) {
      elements.stage.setAttribute("aria-label", "当前筛选没有审核组");
      elements.stage.append(createEmptyState({
        label: "暂无匹配结果",
        title: "没有可显示的审核组",
        message: "可切换筛选或选择其他批次。",
      }));
      imagesReleased = false;
      return;
    }
    if (!group.images.some((image) => image.id === activeImageId)) {
      activeImageId = group.images[0]?.id || "";
    }
    const readonlyLabel = review.summary.status === "ready" ? "" : "，只读";
    elements.stage.setAttribute(
      "aria-label",
      `组 ${group.ordinal}，${KIND_LABELS[group.kind]}，共 ${group.imageCount} 张${readonlyLabel}`,
    );
    const heading = createElement("div", { className: "review-deck-stage-heading" }, [
      createElement("strong", { text: `组 ${group.ordinal}` }),
      createStatusBadge(KIND_STATUS[group.kind], KIND_LABELS[group.kind], { compact: true }),
      ...group.matchLevels.map((level) => createElement("span", { className: "review-match-level", text: level })),
      createElement("span", {
        className: "review-deck-selection-count",
        text: `${group.selectedImageCount}/${group.imageCount} 保留`,
        dataset: { reviewGroupCount: "" },
      }),
      ...(review.summary.status === "ready" ? [] : [createElement("span", {
        className: "review-deck-readonly",
        text: "只读浏览",
      })]),
    ]);
    const layout = group.imageCount === 1
      ? "single"
      : group.imageCount === 2
        ? "pair"
        : group.imageCount <= 4
          ? "grid"
          : "strip";
    const cards = createElement("div", {
      className: "review-deck-cards",
      dataset: { reviewCards: "", layout, count: group.imageCount },
    });
    for (const [index, image] of group.images.entries()) {
      cards.append(buildImageCard(review, group, image, index));
    }
    elements.stage.append(heading, cards);
    loadImageWindow(review);
    renderCompletion();
  };

  const renderInspector = (review) => {
    const group = currentGroup(review, focusedIndex);
    if (!group) {
      elements.inspector.replaceChildren(createEmptyState({
        label: "无组可检查",
        title: "指标栏暂无内容",
        message: "切换筛选后可继续查看图片指标。",
      }));
      syncInspectorVisibility();
      return;
    }
    const header = createElement("div", { className: "review-deck-inspector-heading" }, [
      createElement("h2", { text: "属性 / 指标" }),
      button("toggle-inspector", "收起指标", { small: true }),
    ]);
    const info = createElement("div", { className: "review-deck-group-info" }, [
      createElement("span", {}, [createElement("strong", { text: "类型：" }), KIND_LABELS[group.kind]]),
      createElement("span", {}, [
        createElement("strong", { text: "匹配：" }),
        group.matchLevels.length ? group.matchLevels.join(" · ") : "无匹配级别",
      ]),
      createElement("span", { dataset: { reviewInspectorCount: "" } }, [
        createElement("strong", { text: "保留：" }),
        `${group.selectedImageCount}/${group.imageCount}`,
      ]),
    ]);
    const head = createElement("thead", {}, [createElement("tr", {}, [
      createElement("th", { text: "#", attributes: { scope: "col" } }),
      createElement("th", { text: "尺寸", attributes: { scope: "col" } }),
      createElement("th", { text: "格式·Q", attributes: { scope: "col" } }),
      createElement("th", { text: "清晰·噪声", attributes: { scope: "col" } }),
      createElement("th", { text: "SSCD·DINO", attributes: { scope: "col" } }),
      createElement("th", { text: "体积", attributes: { scope: "col" } }),
    ])]);
    const body = createElement("tbody");
    for (const [index, image] of group.images.entries()) {
      const quality = `${metricValue(image.sharpness, 1)} · ${metricValue(image.noiseSigma, 2)}`;
      const similarities = image.metrics
        ? `${metricValue(image.metrics.sscdSimilarity, 3)} · ${metricValue(image.metrics.dinoSimilarity, 3)}`
        : "— · —";
      body.append(createElement("tr", {
        dataset: {
          reviewInspectorImage: image.id,
          selected: String(image.selected),
          active: String(image.id === activeImageId),
        },
      }, [
        createElement("th", { text: `${index + 1}${image.recommended ? " ★" : ""}`, attributes: { scope: "row" } }),
        createElement("td", { text: image.width && image.height ? `${image.width}×${image.height}` : "—" }),
        createElement("td", { text: `${image.format}${image.jpegQuality === null ? "" : ` · Q${image.jpegQuality}`}` }),
        createElement("td", { text: quality }),
        createElement("td", { text: similarities }),
        createElement("td", { text: formatReviewBytes(image.bytes) }),
      ]));
    }
    const table = createElement("table", { className: "review-deck-inspector-table" }, [
      createElement("caption", { className: "visually-hidden", text: `组 ${group.ordinal} 图片质量指标` }),
      head,
      body,
    ]);
    const bulkActions = createElement("div", { className: "review-bulk-actions review-deck-bulk-actions" }, [
      button("page-all", "本页全部保留", { small: true }),
      button("page-none", "本页全部移除", { dangerous: true, small: true }),
      button("page-recommended", "本页恢复推荐", { small: true }),
    ]);
    elements.inspector.replaceChildren(header, info, table, bulkActions);
    syncInspectorVisibility();
  };

  const filmstripStatus = (group) => ({
    confirmed: group.decided || confirmedIds.has(group.id),
    unreadable: group.kind === "unreadable",
  });

  const syncFilmstripCell = (cell, group, index) => {
    const { confirmed, unreadable } = filmstripStatus(group);
    const current = index === focusedIndex;
    cell.dataset.state = unreadable ? "unreadable" : confirmed ? "confirmed" : "pending";
    cell.dataset.confirmed = String(confirmed);
    cell.dataset.current = String(current);
    if (current) cell.setAttribute("aria-current", "true");
    else cell.removeAttribute("aria-current");
    const symbol = current ? "▣" : unreadable ? (confirmed ? "✗■" : "✗□") : confirmed ? "■" : "□";
    cell.textContent = `${symbol} ${group.ordinal}`;
    cell.setAttribute(
      "aria-label",
      `组 ${group.ordinal}，${unreadable ? "读取失败，" : ""}${confirmed ? "已确认" : "待确认"}`,
    );
  };

  const renderFilmstrip = (review) => {
    elements.filmstrip.replaceChildren();
    elements.filmstrip.hidden = !review.groups.length;
    if (!review.groups.length) return;
    const previous = button("previous", "◀ 上一页", { small: true, title: "上一页（PageUp）" });
    previous.classList.add("review-deck-page-button");
    elements.filmstrip.append(previous);
    const cells = createElement("div", { className: "review-deck-film-cells" });
    for (const [index, group] of review.groups.entries()) {
      const cell = button("focus-group", "", { small: true });
      cell.classList.add("review-deck-film-cell");
      cell.dataset.reviewGroup = group.id;
      cell.dataset.reviewIndex = String(index);
      syncFilmstripCell(cell, group, index);
      cells.append(cell);
    }
    elements.filmstrip.append(cells);
    const next = button("next", "下一页 ▶", { small: true, title: "下一页（PageDown）" });
    next.classList.add("review-deck-page-button");
    elements.filmstrip.append(next);
    const pageCount = Math.max(1, Math.ceil(review.total / review.limit));
    const pageNumber = Math.min(pageCount, Math.floor(review.offset / review.limit) + 1);
    const absoluteGroup = review.total ? Math.min(review.total, review.offset + focusedIndex + 1) : 0;
    elements.filmstrip.append(createElement("span", {
      className: "review-deck-page-indicator",
      text: `第 ${pageNumber}/共 ${pageCount} 页 · 组 ${absoluteGroup}/${review.total}`,
      dataset: { reviewPageSummary: "" },
    }));
  };

  const updateFilmstripCell = (groupId) => {
    const review = reviewState();
    const index = review.groups.findIndex((group) => group.id === groupId);
    if (index < 0) return;
    const cell = findByDataset(elements.filmstrip, "[data-review-group]", "reviewGroup", groupId);
    if (cell) syncFilmstripCell(cell, review.groups[index], index);
  };

  const syncActiveImage = () => {
    for (const card of elements.stage.querySelectorAll("[data-review-image]")) {
      card.dataset.active = String(card.dataset.reviewImage === activeImageId);
    }
    for (const row of elements.inspector.querySelectorAll("[data-review-inspector-image]")) {
      row.dataset.active = String(row.dataset.reviewInspectorImage === activeImageId);
    }
  };

  const applySelectionToCard = (image) => {
    const card = findByDataset(elements.stage, "[data-review-image]", "reviewImage", image.id);
    if (card) {
      card.dataset.selected = String(image.selected);
      card.setAttribute("aria-checked", String(image.selected));
      card.setAttribute("aria-disabled", String(!editable()));
      const imageNumber = Number(card.dataset.reviewImageIndex) + 1;
      const recommendation = image.recommended ? "，推荐项" : "";
      card.setAttribute(
        "aria-label",
        `图 ${imageNumber}${recommendation}，当前${image.selected ? "保留" : "移除"}，${imageFacts(image)}`,
      );
      const stamp = findByDataset(card, "[data-review-stamp]", "reviewStamp", image.id);
      if (stamp) {
        stamp.dataset.state = image.selected ? "keep" : "drop";
        stamp.textContent = image.selected ? "✓ 保留" : "✗ 移除";
      }
    }
    const row = findByDataset(elements.inspector, "[data-review-inspector-image]", "reviewInspectorImage", image.id);
    if (row) row.dataset.selected = String(image.selected);
  };

  const syncSelections = (review) => {
    const group = currentGroup(review, focusedIndex);
    if (group && elements.stage.dataset.reviewGroup !== group.id) {
      renderStage(review);
      renderInspector(review);
      renderFilmstrip(review);
      return;
    }
    if (group) {
      const count = elements.stage.querySelector("[data-review-group-count]");
      if (count) count.textContent = `${group.selectedImageCount}/${group.imageCount} 保留`;
      const inspectorCount = elements.inspector.querySelector("[data-review-inspector-count]");
      if (inspectorCount) inspectorCount.replaceChildren(
        createElement("strong", { text: "保留：" }),
        `${group.selectedImageCount}/${group.imageCount}`,
      );
      for (const image of group.images) applySelectionToCard(image);
    }
    for (const item of review.groups) updateFilmstripCell(item.id);
    elements.operationLive.dataset.reviewDirty = String(review.dirty);
    syncActiveImage();
    if (imagesReleased) loadImageWindow(review);
    if (completionVisible) renderCompletion();
  };

  const resetLocalDeckState = (review, index = 0, { resetInspector = true } = {}) => {
    confirmedIds = new Set();
    completionVisible = false;
    focusedIndex = review.groups.length ? Math.max(0, Math.min(index, review.groups.length - 1)) : 0;
    activeImageId = currentGroup(review, focusedIndex)?.images[0]?.id || "";
    if (resetInspector && !inspectorUserToggled) {
      inspectorCollapsed = compactInspectorQuery?.matches === true;
    }
  };

  const controlDisabled = (action, review) => {
    if (busy) return true;
    const hasGroups = Boolean(review.groups.length);
    const ready = review.summary?.status === "ready";
    if (["load-batch", "refresh", "open-tasks", "start", "retry", "discard-reload"].includes(action)) return false;
    if (action === "filter") return false;
    if (action === "previous") return review.offset <= 0;
    if (action === "next") return review.offset + review.limit >= review.total;
    if (action === "focus-group" || action === "toggle-inspector") return !hasGroups;
    if (action === "prev-group") return !hasGroups || (focusedIndex === 0 && review.offset <= 0);
    if (action === "next-group") {
      return !hasGroups || (focusedIndex + 1 >= review.groups.length && review.offset + review.limit >= review.total);
    }
    if (action === "first-group" || action === "last-group" || action === "return-review") return !hasGroups;
    if (["accept", "group-all", "group-none", "group-recommended", "page-all", "page-none", "page-recommended"].includes(action)) {
      return !ready || !hasGroups;
    }
    if (action === "save") return !ready || !hasGroups || !review.dirty;
    if (action === "apply") {
      if (!["ready", "apply_failed"].includes(review.summary?.status)) return true;
      return ready && review.summary.decidedGroupCount < review.summary.totalGroupCount && !review.dirty;
    }
    return false;
  };

  const syncControlAvailability = (review) => {
    for (const control of root.querySelectorAll("button, select, input")) control.disabled = false;
    elements.batchSelect.disabled = Boolean(busy);
    for (const control of root.querySelectorAll("[data-review-action]")) {
      control.disabled = controlDisabled(control.dataset.reviewAction, review);
    }
    elements.commandHost.hidden = !review.groups.length;
    for (const card of elements.stage.querySelectorAll("[data-review-image]")) {
      card.setAttribute("aria-disabled", String(!editable(review)));
    }
    if (busy) {
      for (const control of root.querySelectorAll("button, select, input")) control.disabled = true;
    }
  };

  const renderReview = (review, previous, metadata) => {
    const hasReview = Boolean(review.batchId && review.summary);
    const deckMode = hasReview && reviewCanList(review.summary);
    root.dataset.mode = deckMode ? "deck" : "panel";
    elements.appHeader.hidden = deckMode;
    elements.picker.hidden = deckMode;
    elements.deck.hidden = !deckMode;
    elements.workspace.hidden = !hasReview || deckMode;
    elements.emptyHost.replaceChildren(...(!hasReview ? [createEmptyState({
      label: "尚未选择审核批次",
      title: "选择已结束批次后打开审核",
      message: "打开批次不会自动开始分析。",
    })] : []));
    elements.emptyHost.hidden = deckMode || hasReview;
    placeSharedElements(deckMode, hasReview);

    if (!hasReview) {
      renderedPageKey = "";
      releaseImages();
      syncControlAvailability(review);
      return;
    }

    renderActions(review);
    if (!deckMode) {
      renderedPageKey = "";
      releaseImages();
      updateStatusBadge(elements.statusBadge, review.summary.statusKind, review.summary.statusLabel);
      renderStats(review.summary);
      renderNonDeckState(review);
      elements.operationLive.dataset.reviewDirty = String(review.dirty);
      syncControlAvailability(review);
      return;
    }

    const nextPageKey = deckPageKey(review);
    const pageChanged = renderedPageKey !== nextPageKey;
    if (pageChanged) {
      resetLocalDeckState(review, 0, { resetInspector: true });
      renderedPageKey = nextPageKey;
    } else if (focusedIndex >= review.groups.length) {
      focusedIndex = Math.max(0, review.groups.length - 1);
    }
    renderDeckHeader(review);
    const group = currentGroup(review, focusedIndex);
    const stageShapeMatches = !pageChanged && elements.stage.dataset.reviewGroup === (group?.id || "") &&
      [...elements.stage.querySelectorAll("[data-review-image]")].map((card) => card.dataset.reviewImage).join("\u0000") ===
      (group?.images || []).map((image) => image.id).join("\u0000");
    const statusChanged = previous?.summary?.status !== review.summary.status;
    const selectionOnly = [
      "review/imageSelectionChanged",
      "review/groupModeChanged",
      "review/groupConfirmed",
      "review/pageModeChanged",
      "review/pageSaved",
      "review/summaryReceived",
      "busy",
    ].includes(metadata?.type);
    if (!stageShapeMatches || statusChanged || (!selectionOnly && metadata?.type !== "review/workspaceReceived")) {
      renderStage(review);
      renderInspector(review);
      renderFilmstrip(review);
    } else {
      syncSelections(review);
    }
    elements.operationLive.dataset.reviewDirty = String(review.dirty);
    syncControlAvailability(review);
  };

  const focusStage = () => {
    if (elements.deck.hidden || !reviewState().groups.length) return false;
    try {
      elements.stage.focus({ preventScroll: true });
    } catch {
      elements.stage.focus();
    }
    return true;
  };

  const setFocusedIndex = (index) => {
    const review = reviewState();
    if (!reviewCanList(review.summary) || !review.groups.length || !Number.isInteger(index)) return false;
    const next = Math.max(0, Math.min(index, review.groups.length - 1));
    completionVisible = false;
    if (next !== focusedIndex || elements.stage.dataset.reviewGroup !== review.groups[next].id) {
      focusedIndex = next;
      activeImageId = review.groups[next].images[0]?.id || "";
      renderStage(review);
      renderInspector(review);
      renderFilmstrip(review);
      syncControlAvailability(review);
    } else {
      renderCompletion();
      for (const group of review.groups) updateFilmstripCell(group.id);
      if (imagesReleased) loadImageWindow(review);
    }
    focusStage();
    return true;
  };

  const setActiveImage = (imageId, { focus = false } = {}) => {
    const group = currentGroup(reviewState(), focusedIndex);
    if (!group?.images.some((image) => image.id === imageId)) return false;
    activeImageId = imageId;
    syncActiveImage();
    if (focus) {
      const card = findByDataset(elements.stage, "[data-review-image]", "reviewImage", imageId);
      try {
        card?.focus({ preventScroll: true });
      } catch {
        card?.focus();
      }
    }
    return true;
  };

  const markConfirmed = (groupId) => {
    if (!reviewState().groups.some((group) => group.id === groupId)) return false;
    confirmedIds.add(groupId);
    updateFilmstripCell(groupId);
    return true;
  };

  const toggleInspector = () => {
    inspectorCollapsed = !inspectorCollapsed;
    inspectorUserToggled = true;
    syncInspectorVisibility();
    return !inspectorCollapsed;
  };

  const resetPageState = (index = 0, { focus = true, resetInspector = true } = {}) => {
    const review = reviewState();
    resetLocalDeckState(review, index, { resetInspector });
    if (reviewCanList(review.summary)) {
      renderDeckHeader(review);
      renderStage(review);
      renderInspector(review);
      renderFilmstrip(review);
      syncControlAvailability(review);
      if (focus) focusStage();
    }
  };

  const showCompletion = () => {
    if (!reviewState().groups.length) return false;
    completionVisible = true;
    renderCompletion();
    syncControlAvailability(reviewState());
    return true;
  };

  const hideCompletion = () => {
    if (!completionVisible) return false;
    completionVisible = false;
    renderCompletion();
    return true;
  };

  const onFocusIn = (event) => {
    if (!(event.target instanceof Element)) return;
    const card = event.target.closest("[data-review-image]");
    if (card && root.contains(card)) setActiveImage(card.dataset.reviewImage || "");
  };

  syncInspectorVisibility();
  compactInspectorQuery?.addEventListener("change", onInspectorViewportChange);
  root.addEventListener("focusin", onFocusIn);
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
      renderReview(reviewState(), reviewState(), { type: "busy" });
    },
    releaseImages,
    applyConfirmationText() {
      const counts = reviewApplyCounts(reviewState().summary);
      return `自动移除 ${counts.automatic} 张；最终保留 ${counts.selected} 张，预计移出 ${counts.rejected} 张。`;
    },
    getFocusedIndex: () => focusedIndex,
    getFocusedGroup: () => currentGroup(reviewState(), focusedIndex),
    setFocusedIndex,
    setActiveImage,
    focusStage,
    markConfirmed,
    toggleInspector,
    resetPageState,
    showCompletion,
    hideCompletion,
    isCompletionVisible: () => completionVisible,
    destroy() {
      unsubscribeRecent();
      unsubscribeReview();
      compactInspectorQuery?.removeEventListener("change", onInspectorViewportChange);
      root.removeEventListener("focusin", onFocusIn);
      releaseImages();
      clearError();
      root.replaceChildren();
      root.removeAttribute("aria-busy");
      root.removeAttribute("data-mode");
    },
  });
}
