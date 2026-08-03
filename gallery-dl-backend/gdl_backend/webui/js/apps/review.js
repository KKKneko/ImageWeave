import { isAbortError } from "../core/api.js";
import { setElementInert } from "../core/dom.js";
import {
  buildReviewDecisionPayload,
  createReviewRequestGate,
  reviewCanList,
  reviewErrorGuidance,
  sanitizeReviewPage,
  sanitizeReviewSummary,
  shouldPollReview,
  REVIEW_PAGE_LIMIT,
  REVIEW_POLL_INTERVAL_MS,
} from "../core/review-model.js";
import { actionCreators } from "../core/store.js";
import { TERMINAL_BATCH_STATUSES } from "../core/tasks-model.js";
import { createReviewView } from "../components/review-view.js";

export const REVIEW_ENDPOINTS = Object.freeze({
  crawls: "/api/v1/crawls",
});

const REVIEW_POLL_KEY = "review.active";

function requireBatchId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new TypeError("审核批次 ID 无效");
  }
  return value;
}

function reviewPath(batchId, suffix = "") {
  return `${REVIEW_ENDPOINTS.crawls}/${encodeURIComponent(requireBatchId(batchId))}/review${suffix}`;
}

function reviewPagePath(batchId, filter, offset) {
  const kind = filter ? `&kind=${encodeURIComponent(filter)}` : "";
  return `${reviewPath(batchId)}?limit=${REVIEW_PAGE_LIMIT}&offset=${offset}${kind}`;
}

function createReviewController(context) {
  const { root, api, store, polling, actions, dialogs } = context;
  const view = createReviewView(context);
  const requestGate = createReviewRequestGate();
  let active = false;
  let destroyed = false;
  let busy = "";
  let pageRead = null;
  let recentRead = null;
  let operationController = null;
  let operationSequence = 0;
  let leaveSave = null;

  const reviewState = () => store.getState().review;
  const abortRead = (entry) => entry?.controller.abort();

  const readRecent = async ({ replace = false, report = true } = {}) => {
    if (!active || destroyed) return false;
    if (recentRead) {
      if (!replace) return recentRead.promise;
      abortRead(recentRead);
      try { await recentRead.promise; } catch { /* 原调用方负责错误。 */ }
      if (!active || destroyed) return false;
    }
    const controller = new AbortController();
    const promise = api.get(`${REVIEW_ENDPOINTS.crawls}?limit=30`, { signal: controller.signal })
      .then((response) => {
        if (!active || destroyed || controller.signal.aborted) return false;
        store.dispatch(actionCreators.recentBatchesReceived(response));
        return true;
      })
      .catch((error) => {
        if (isAbortError(error) || controller.signal.aborted) return false;
        if (active && report) view.showError(reviewErrorGuidance(error));
        throw error;
      })
      .finally(() => {
        if (recentRead?.promise === promise) recentRead = null;
      });
    recentRead = { controller, promise };
    return promise;
  };

  const syncPolling = () => {
    polling.stop(REVIEW_POLL_KEY);
    const review = reviewState();
    if (!active || destroyed || busy || review.dirty || !review.batchId || !shouldPollReview(review.summary)) return;
    polling.start({
      key: REVIEW_POLL_KEY,
      scope: context.pollingScope,
      intervalMs: REVIEW_POLL_INTERVAL_MS,
      immediate: false,
      critical: false,
      resume: "immediate",
      task(signal) {
        return readPage({
          batchId: reviewState().batchId,
          filter: reviewState().filter,
          offset: reviewState().offset,
          externalSignal: signal,
          replace: false,
          report: false,
        });
      },
    });
  };

  const readPage = async ({
    batchId,
    filter = "",
    offset = 0,
    externalSignal = null,
    replace = false,
    report = true,
  }) => {
    if (!active || destroyed) return false;
    requireBatchId(batchId);
    if (pageRead) {
      if (!replace && pageRead.batchId === batchId && pageRead.filter === filter && pageRead.offset === offset) {
        return pageRead.promise;
      }
      abortRead(pageRead);
      try { await pageRead.promise; } catch { /* 原调用方负责错误。 */ }
      if (!active || destroyed) return false;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener("abort", abort, { once: true });
    const ticket = requestGate.beginRead(batchId, filter, offset);
    const promise = api.get(reviewPagePath(batchId, filter, offset), { signal: controller.signal })
      .then((response) => {
        if (!active || destroyed || controller.signal.aborted || !requestGate.isReadCurrent(ticket, {
          batchId: reviewState().batchId || batchId,
          filter,
          offset,
        })) return false;
        const projected = sanitizeReviewPage(response, { batchId, filter, requestedOffset: offset });
        store.dispatch(actionCreators.reviewWorkspaceReceived(projected));
        view.clearError();
        syncPolling();
        return true;
      })
      .catch((error) => {
        if (isAbortError(error) || controller.signal.aborted) return false;
        if (active && report) view.showError(reviewErrorGuidance(error));
        throw error;
      })
      .finally(() => {
        externalSignal?.removeEventListener("abort", abort);
        if (pageRead?.promise === promise) pageRead = null;
      });
    pageRead = { batchId, filter, offset, controller, promise };
    return promise;
  };

  const refreshSummaryOnly = async (batchId, signal) => {
    try {
      const response = await api.get(reviewPagePath(batchId, reviewState().filter, reviewState().offset), { signal });
      if (!signal.aborted && active && reviewState().batchId === batchId) {
        store.dispatch(actionCreators.reviewSummaryReceived(
          batchId,
          sanitizeReviewSummary(response, batchId),
        ));
      }
    } catch (error) {
      if (isAbortError(error) || signal.aborted) return false;
      throw error;
    }
    return true;
  };

  const setBusy = (kind) => {
    busy = kind;
    view.setBusy(kind);
    if (kind) polling.stop(REVIEW_POLL_KEY);
    else syncPolling();
  };

  const persistPage = async ({ announce = true } = {}) => {
    const review = reviewState();
    if (!review.dirty) return true;
    if (review.summary?.status !== "ready" || !review.groups.length) return false;
    if (leaveSave) return leaveSave;
    let payload;
    try {
      payload = buildReviewDecisionPayload(review);
    } catch (error) {
      view.showError(reviewErrorGuidance({ code: "invalid_review_decisions", status: 422 }));
      return false;
    }
    requestGate.beginWrite();
    abortRead(pageRead);
    const controller = new AbortController();
    operationController = controller;
    const batchId = review.batchId;
    let captured = payload;
    payload = null;
    const savePromise = (async () => {
      try {
        const promise = api.put(reviewPath(batchId, "/decisions"), captured, { signal: controller.signal });
        captured = null;
        const summary = await promise;
        if (destroyed || controller.signal.aborted || reviewState().batchId !== batchId) return false;
        store.dispatch(actionCreators.reviewPageSaved(summary));
        if (active) {
          await readPage({
            batchId,
            filter: reviewState().filter,
            offset: reviewState().offset,
            replace: true,
            report: false,
          });
        }
        if (announce && active) view.setOperationMessage("✓ 本页选择已保存并由权威分页重新确认。 ");
        return true;
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted || destroyed) return false;
        if (active) {
          try { await refreshSummaryOnly(batchId, controller.signal); } catch { /* 保留原保存错误。 */ }
          view.showError(reviewErrorGuidance(error));
          view.setOperationMessage("保存未完成；本页选择仍保留，筛选、翻页和离开应用已被阻止。 ");
        }
        return false;
      } finally {
        captured = null;
        if (operationController === controller) operationController = null;
        leaveSave = null;
      }
    })();
    leaveSave = savePromise;
    return savePromise;
  };

  const switchPage = async ({ filter = reviewState().filter, offset = reviewState().offset }) => {
    if (busy || !reviewState().batchId) return false;
    if (reviewState().dirty && !await persistPage({ announce: false })) return false;
    view.releaseImages();
    setBusy("page");
    try {
      const loaded = await readPage({
        batchId: reviewState().batchId,
        filter,
        offset,
        replace: true,
        report: true,
      });
      if (loaded && active) view.setOperationMessage("✓ 审核分页已从服务器加载。 ");
      return loaded;
    } catch {
      return false;
    } finally {
      setBusy("");
    }
  };

  const loadBatch = async (batchId) => {
    requireBatchId(batchId);
    if (reviewState().batchId !== batchId && reviewState().dirty && !await persistPage({ announce: false })) {
      return false;
    }
    requestGate.beginWrite();
    actions.setActiveBatchId(batchId);
    store.dispatch(actionCreators.reviewCleared(batchId));
    view.releaseImages();
    setBusy("load");
    view.clearError();
    try {
      const loaded = await readPage({ batchId, filter: "", offset: 0, replace: true, report: true });
      if (loaded && active) view.setOperationMessage("✓ 已载入终态批次；读取不会隐式启动分析。 ");
      return loaded;
    } catch {
      return false;
    } finally {
      setBusy("");
    }
  };

  const runStatusOperation = async ({ kind, suffix, successMessage }) => {
    const review = reviewState();
    if (!review.batchId || busy) return false;
    requestGate.beginWrite();
    abortRead(pageRead);
    const controller = new AbortController();
    operationController = controller;
    const operation = ++operationSequence;
    setBusy(kind);
    view.clearError();
    try {
      const summary = await api.post(reviewPath(review.batchId, suffix), {}, { signal: controller.signal });
      if (!active || destroyed || controller.signal.aborted || operation !== operationSequence) return false;
      store.dispatch(actionCreators.reviewSummaryReceived(review.batchId, summary));
      await readPage({
        batchId: review.batchId,
        filter: reviewState().filter,
        offset: reviewState().offset,
        replace: true,
        report: false,
      });
      view.setOperationMessage(successMessage);
      return true;
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || !active) return false;
      try { await refreshSummaryOnly(review.batchId, controller.signal); } catch { /* 保留原错误。 */ }
      view.showError(reviewErrorGuidance(error));
      return false;
    } finally {
      if (operationController === controller) operationController = null;
      if (operation === operationSequence) setBusy("");
    }
  };

  const applyReview = async () => {
    if (busy || !reviewState().batchId) return;
    if (reviewState().dirty && !await persistPage({ announce: false })) return;
    const review = reviewState();
    if (review.summary.status === "ready" && review.summary.decidedGroupCount < review.summary.totalGroupCount) {
      view.setOperationMessage("仍有未确认分组；请逐页保存后再应用，界面不会绕过后端约束。 ");
      return;
    }
    const choice = await dialogs.open({
      title: review.summary.status === "apply_failed" ? "重试应用审核结果？" : "应用审核结果？",
      message: view.applyConfirmationText(),
      confirmLabel: review.summary.status === "apply_failed" ? "重试应用" : "应用并移动淘汰图片",
      dangerous: true,
      confirmationText: "此操作会按后端审核清单移动文件；不会提供任意文件路径或强制覆盖选项。",
    });
    if (choice !== "confirm" || !active || destroyed) return;
    await runStatusOperation({
      kind: "apply",
      suffix: "/apply",
      successMessage: "✓ 应用请求已完成，审核页已从后端重新读取。",
    });
    await readRecent({ replace: true, report: false }).catch(() => {});
  };

  const discardStaleAndReload = async () => {
    const review = reviewState();
    if (!review.dirty || !review.batchId) return false;
    const choice = await dialogs.open({
      title: "放弃陈旧审核选择？",
      message: "后端审核状态已变化，当前本页选择不能再安全保存。可放弃本地草稿并重新读取权威分页。",
      confirmLabel: "放弃选择并重载",
      dangerous: true,
      confirmationText: "只清除中央 Store 中这一页的未保存选择，不修改后端文件或已确认决策。",
    });
    if (choice !== "confirm" || !active || destroyed) return false;
    const batchId = review.batchId;
    requestGate.beginWrite();
    store.dispatch(actionCreators.reviewCleared(batchId));
    return switchPage({ filter: review.filter, offset: review.offset });
  };

  const manualRefresh = async () => {
    if (busy) return;
    if (reviewState().dirty && !await persistPage({ announce: false })) return;
    setBusy("refresh");
    try {
      await Promise.all([
        readRecent({ replace: true, report: false }),
        reviewState().batchId
          ? readPage({
              batchId: reviewState().batchId,
              filter: reviewState().filter,
              offset: reviewState().offset,
              replace: true,
              report: true,
            })
          : Promise.resolve(false),
      ]);
      if (active) view.setOperationMessage("✓ 终态批次与当前审核状态已刷新。 ");
    } catch {
      // 读取函数已显示安全错误。
    } finally {
      setBusy("");
    }
  };

  const onClick = async (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-review-action]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    const action = button.dataset.reviewAction;
    if (action === "load-batch") {
      const id = view.selectedBatchId();
      if (id) await loadBatch(id);
      else view.setOperationMessage("请选择一个已结束批次。 ");
    } else if (action === "refresh") await manualRefresh();
    else if (action === "open-tasks") actions.navigateToApp("tasks");
    else if (action === "start") await runStatusOperation({
      kind: "start", suffix: "/start", successMessage: "✓ 去重分析已显式启动并进入按需轮询。",
    });
    else if (action === "retry") await runStatusOperation({
      kind: "retry", suffix: "/retry", successMessage: "✓ 去重分析已重新排队。",
    });
    else if (action === "filter") await switchPage({ filter: button.dataset.reviewFilter || "", offset: 0 });
    else if (action === "previous") await switchPage({ offset: Math.max(0, reviewState().offset - REVIEW_PAGE_LIMIT) });
    else if (action === "next") await switchPage({ offset: reviewState().offset + REVIEW_PAGE_LIMIT });
    else if (action === "save") {
      setBusy("save");
      await persistPage({ announce: true });
      setBusy("");
    } else if (action === "apply") await applyReview();
    else if (action === "discard-reload") await discardStaleAndReload();
    else if (action.startsWith("page-")) {
      store.dispatch(actionCreators.reviewPageModeChanged(action.slice(5)));
    } else if (action.startsWith("group-")) {
      const groupId = button.closest("[data-review-group]")?.dataset.reviewGroup || "";
      store.dispatch(actionCreators.reviewGroupModeChanged(groupId, action.slice(6)));
    }
  };

  const onChange = (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || !input.dataset.reviewImageToggle) return;
    const groupId = input.closest("[data-review-group]")?.dataset.reviewGroup || "";
    store.dispatch(actionCreators.reviewImageSelectionChanged(
      groupId,
      input.dataset.reviewImageToggle,
      input.checked,
    ));
  };

  const onBeforeUnload = (event) => {
    if (!reviewState().dirty) return;
    event.preventDefault();
    event.returnValue = "";
  };

  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  globalThis.addEventListener?.("beforeunload", onBeforeUnload);

  return Object.freeze({
    async beforeLeave() {
      if (!reviewState().dirty) return true;
      if (busy && leaveSave) return Boolean(await leaveSave);
      view.setOperationMessage("正在保存未提交的审核选择；完成前不会切换应用…");
      return Boolean(await persistPage({ announce: false }));
    },
    activate() {
      if (destroyed || active) return;
      active = true;
      requestGate.advanceLifecycle();
      root.hidden = false;
      setElementInert(root, false);
      root.dataset.lifecycle = "active";
      void readRecent({ replace: true, report: false }).catch(() => {});
      const current = reviewState();
      if (current.dirty) {
        view.setOperationMessage("本页有未保存选择；已恢复本地安全投影，不会用 GET 覆盖。 ");
        return;
      }
      if (current.batchId) {
        void readPage({
          batchId: current.batchId,
          filter: current.filter,
          offset: current.offset,
          replace: true,
          report: true,
        }).catch(() => {});
        return;
      }
      const activeBatch = store.getState().batches.active;
      if (activeBatch && TERMINAL_BATCH_STATUSES.has(activeBatch.status)) {
        queueMicrotask(() => {
          if (active && !destroyed && !reviewState().batchId) void loadBatch(activeBatch.id);
        });
      } else {
        view.setOperationMessage("选择一个终态批次；审核读取不会隐式启动分析。 ");
      }
    },
    deactivate() {
      if (destroyed) return;
      active = false;
      requestGate.advanceLifecycle();
      operationSequence += 1;
      dialogs.destroy();
      operationController?.abort();
      operationController = null;
      abortRead(pageRead);
      abortRead(recentRead);
      view.releaseImages();
      busy = "";
      view.setBusy("");
      root.hidden = true;
      setElementInert(root, true);
      root.dataset.lifecycle = "inactive";
    },
    destroy() {
      if (destroyed) return;
      active = false;
      destroyed = true;
      requestGate.advanceLifecycle();
      operationSequence += 1;
      dialogs.destroy();
      operationController?.abort();
      abortRead(pageRead);
      abortRead(recentRead);
      view.releaseImages();
      root.removeEventListener("click", onClick);
      root.removeEventListener("change", onChange);
      globalThis.removeEventListener?.("beforeunload", onBeforeUnload);
      view.destroy();
      root.removeAttribute("data-lifecycle");
    },
  });
}

let controller = null;

export default Object.freeze({
  mount(context) {
    if (controller) throw new Error("REVIEW.EXE 已挂载");
    controller = createReviewController(context);
  },
  activate() {
    controller?.activate();
  },
  beforeLeave() {
    return controller?.beforeLeave() ?? true;
  },
  deactivate() {
    controller?.deactivate();
  },
  unmount() {
    controller?.destroy();
    controller = null;
  },
});
