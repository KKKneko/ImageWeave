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
        if (announce && active) view.setOperationMessage("本页已保存，并已重新读取最新内容。");
        return true;
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted || destroyed) return false;
        if (active) {
          try { await refreshSummaryOnly(batchId, controller.signal); } catch { /* 保留原保存错误。 */ }
          view.showError(reviewErrorGuidance(error));
          view.setOperationMessage("保存失败，本页更改已保留。请重试后再翻页、筛选或离开。");
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
      if (loaded && active) view.setOperationMessage("审核内容已加载。");
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
      if (loaded && active) view.setOperationMessage("已加载结束批次；打开批次不会自动开始分析。");
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
      view.setOperationMessage("仍有未确认分组，请逐页保存后再应用结果。");
      return;
    }
    const choice = await dialogs.open({
      title: review.summary.status === "apply_failed" ? "重试整理文件？" : "应用并整理文件？",
      message: view.applyConfirmationText(),
      confirmLabel: review.summary.status === "apply_failed" ? "重试整理" : "应用并整理文件",
      dangerous: true,
      confirmationText: "将按当前审核结果移动待移除的图片。开始前请确认每组的保留项。",
    });
    if (choice !== "confirm" || !active || destroyed) return;
    await runStatusOperation({
      kind: "apply",
      suffix: "/apply",
      successMessage: "审核结果已应用，页面已重新读取最新状态。",
    });
    await readRecent({ replace: true, report: false }).catch(() => {});
  };

  const discardStaleAndReload = async () => {
    const review = reviewState();
    if (!review.dirty || !review.batchId) return false;
    const choice = await dialogs.open({
      title: "放弃未保存的更改？",
      message: "审核状态已经变化，本页更改无法继续保存。可以放弃更改并重新加载最新内容。",
      confirmLabel: "放弃更改并重新加载",
      dangerous: true,
      confirmationText: "只会清除本页未保存的更改，不会修改文件或已确认结果。",
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
      if (active) view.setOperationMessage("已结束批次和当前审核状态已刷新。");
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
      kind: "start", suffix: "/start", successMessage: "去重分析已开始，状态将自动刷新。",
    });
    else if (action === "retry") await runStatusOperation({
      kind: "retry", suffix: "/retry", successMessage: "去重分析已重新排队。",
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
      view.setOperationMessage("正在保存未提交的审核更改，完成前不会切换页面……");
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
        view.setOperationMessage("本页有未保存的更改，已恢复本地草稿。");
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
        view.setOperationMessage("选择一个已结束批次；打开批次不会自动开始分析。");
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
      polling.stop(REVIEW_POLL_KEY);
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
      polling.stop(REVIEW_POLL_KEY);
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
