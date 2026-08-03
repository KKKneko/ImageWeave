import { isAbortError } from "../core/api.js";
import { setElementInert } from "../core/dom.js";
import { actionCreators } from "../core/store.js";
import {
  createBatchRequestGate,
  shouldPollBatch,
  TASK_DISPLAY_LIMIT,
  TASK_POLL_INTERVAL_MS,
  taskErrorGuidance,
  TERMINAL_BATCH_STATUSES,
} from "../core/tasks-model.js";
import { createTasksView } from "../components/tasks-view.js";

export const TASKS_ENDPOINTS = Object.freeze({
  crawls: "/api/v1/crawls",
});

const BATCH_POLL_KEY = "batches.active";

function batchPath(batchId, suffix = "") {
  if (typeof batchId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(batchId)) {
    throw new TypeError("批次 ID 无效");
  }
  return `${TASKS_ENDPOINTS.crawls}/${encodeURIComponent(batchId)}${suffix}`;
}

function createTasksController(context) {
  const { root, api, store, polling, storage, actions, dialogs } = context;
  const view = createTasksView(context);
  const requestGate = createBatchRequestGate();
  let active = false;
  let destroyed = false;
  let busy = "";
  let activeRead = null;
  let recentRead = null;
  let operationController = null;
  let operationSequence = 0;

  const activeBatchId = () => store.getState().batches.activeId;
  const activeBatch = () => store.getState().batches.active;

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
    const promise = api.get(`${TASKS_ENDPOINTS.crawls}?limit=30`, { signal: controller.signal })
      .then((response) => {
        if (!active || destroyed || controller.signal.aborted) return false;
        store.dispatch(actionCreators.recentBatchesReceived(response));
        return true;
      })
      .catch((error) => {
        if (isAbortError(error) || controller.signal.aborted) return false;
        if (active && report) view.showError(taskErrorGuidance(error));
        throw error;
      })
      .finally(() => {
        if (recentRead?.promise === promise) recentRead = null;
      });
    recentRead = { controller, promise };
    return promise;
  };

  const syncPolling = () => {
    polling.stop(BATCH_POLL_KEY);
    const batch = activeBatch();
    if (!active || destroyed || busy || !activeBatchId() || !shouldPollBatch(batch)) return;
    polling.start({
      key: BATCH_POLL_KEY,
      scope: context.pollingScope,
      intervalMs: TASK_POLL_INTERVAL_MS,
      immediate: false,
      critical: false,
      resume: "immediate",
      task(signal) {
        return readActive(signal, { replace: false, report: false });
      },
    });
  };

  const handleMissingBatch = () => {
    actions.setActiveBatchId("");
    store.dispatch(actionCreators.batchSnapshotCleared());
    view.setOperationMessage("该批次已不存在，已停止自动刷新。请选择其他批次。");
    syncPolling();
  };

  const readActive = async (externalSignal = null, { replace = false, report = true } = {}) => {
    if (!active || destroyed) return false;
    const batchId = activeBatchId();
    if (!batchId) {
      syncPolling();
      return false;
    }
    if (activeRead) {
      if (!replace && activeRead.batchId === batchId) return activeRead.promise;
      abortRead(activeRead);
      try { await activeRead.promise; } catch { /* 原调用方负责错误。 */ }
      if (!active || destroyed) return false;
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (externalSignal?.aborted) abort();
    else externalSignal?.addEventListener("abort", abort, { once: true });
    const ticket = requestGate.beginRead(batchId);
    const promise = Promise.all([
      api.get(batchPath(batchId), { signal: controller.signal }),
      api.get(batchPath(batchId, `/tasks?limit=${TASK_DISPLAY_LIMIT}`), { signal: controller.signal }),
    ])
      .then(([batch, tasks]) => {
        if (!active || destroyed || controller.signal.aborted ||
            !requestGate.isReadCurrent(ticket, activeBatchId())) return false;
        store.dispatch(actionCreators.batchSnapshotReceived(batch, tasks));
        view.clearError();
        syncPolling();
        return true;
      })
      .catch((error) => {
        if (isAbortError(error) || controller.signal.aborted) return false;
        const guidance = taskErrorGuidance(error);
        if (guidance.missing && batchId === activeBatchId()) handleMissingBatch();
        else if (active && (report || !activeBatch())) view.showError(guidance);
        throw error;
      })
      .finally(() => {
        externalSignal?.removeEventListener("abort", abort);
        if (activeRead?.promise === promise) activeRead = null;
      });
    activeRead = { batchId, controller, promise };
    return promise;
  };

  const refreshAuthority = async ({ report = false } = {}) => {
    const results = await Promise.allSettled([
      readActive(null, { replace: true, report }),
      readRecent({ replace: true, report }),
    ]);
    const rejected = results.find((result) => result.status === "rejected");
    if (rejected) throw rejected.reason;
    return true;
  };

  const setBusy = (kind) => {
    busy = kind;
    view.setBusy(kind);
    if (kind) polling.stop(BATCH_POLL_KEY);
    else syncPolling();
  };

  const runOperation = async ({ kind, request, successMessage }) => {
    if (!active || destroyed || busy || !activeBatchId()) return false;
    requestGate.beginWrite();
    abortRead(activeRead);
    abortRead(recentRead);
    const operation = ++operationSequence;
    const batchId = activeBatchId();
    const controller = new AbortController();
    operationController = controller;
    view.clearError();
    setBusy(kind);
    view.setOperationMessage("正在执行批次操作，完成后将读取最新状态……");
    let operationError = null;
    try {
      await request(batchId, controller.signal);
      if (!active || destroyed || controller.signal.aborted || operation !== operationSequence) return false;
      await refreshAuthority({ report: false });
      if (!active || destroyed || controller.signal.aborted) return false;
      view.clearError();
      view.setOperationMessage(successMessage);
      return true;
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || !active) return false;
      operationError = error;
      try {
        await refreshAuthority({ report: false });
      } catch {
        // 原操作错误更能解释当前状态，权威刷新失败不覆盖它。
      }
      if (active) view.showError(taskErrorGuidance(operationError));
      view.setOperationMessage("操作失败，已重新读取最新状态；不会强制更改任务状态。");
      return false;
    } finally {
      operationError = null;
      if (operationController === controller) operationController = null;
      if (operation === operationSequence) setBusy("");
    }
  };

  const confirm = async (options) => {
    const choice = await dialogs.open(options);
    return choice === "confirm" && active && !destroyed;
  };

  const cancelBatch = async () => {
    const batch = activeBatch();
    if (!batch || TERMINAL_BATCH_STATUSES.has(batch.status)) return;
    if (!await confirm({
      title: "取消当前批次？",
      message: "系统将请求取消该批次及其活动图片任务，不会删除已完成文件。",
      confirmLabel: "取消批次",
      dangerous: true,
      confirmationText: "取消请求可能需要片刻生效，请以刷新后的状态为准。",
    })) return;
    await runOperation({
      kind: "cancel",
      request: (batchId, signal) => api.post(batchPath(batchId, "/cancel"), {}, { signal }),
      successMessage: "取消请求已接受，批次列表已刷新。",
    });
  };

  const retryBatch = async () => {
    const batch = activeBatch();
    if (!batch?.resumable || !TERMINAL_BATCH_STATUSES.has(batch.status)) return;
    if (!await confirm({
      title: "重试未完成项？",
      message: "系统将重新排队失败图片并重新规划未完成地址，已完成文件会自动跳过。",
      confirmLabel: "重试未完成项",
      dangerous: true,
      confirmationText: "失败任务将获得 2 次额外重试；已完成文件不会重复下载。",
    })) return;
    await runOperation({
      kind: "retry",
      request: (batchId, signal) => api.post(
        batchPath(batchId, "/retry"),
        { additional_attempts: 2 },
        { signal },
      ),
      successMessage: "未完成项已重新排队，批次状态已刷新。",
    });
  };

  const rerunBatch = async () => {
    const batch = activeBatch();
    if (!batch || !TERMINAL_BATCH_STATUSES.has(batch.status)) return;
    if (!await confirm({
      title: "重新规划当前批次？",
      message: "系统将按原批次和原目录重新规划全部地址，默认只处理新增、失败或取消的内容。",
      confirmLabel: "重新规划批次",
      dangerous: true,
      confirmationText: "去重审核进行中时不能重新规划。",
    })) return;
    await runOperation({
      kind: "rerun",
      request: (batchId, signal) => api.post(batchPath(batchId, "/rerun"), {}, { signal }),
      successMessage: "批次已重新规划，最新状态已刷新。",
    });
  };

  const loadSelected = async () => {
    const batchId = view.selectedRecentId();
    if (!batchId) {
      view.setOperationMessage("请选择一个最近批次。 ");
      return;
    }
    actions.setActiveBatchId(batchId);
    store.dispatch(actionCreators.batchSnapshotCleared());
    requestGate.beginWrite();
    setBusy("load");
    view.clearError();
    try {
      await readActive(null, { replace: true, report: true });
      if (active) view.setOperationMessage("批次已加载，自动刷新状态已更新。");
    } catch {
      // readActive 已提供安全错误和陈旧 ID 恢复。
    } finally {
      setBusy("");
    }
  };

  const manualRefresh = async () => {
    if (busy) return;
    setBusy("refresh");
    view.clearError();
    try {
      await refreshAuthority({ report: true });
      if (active) view.setOperationMessage("当前批次和最近列表已刷新。");
    } catch {
      // 各读取路径已呈现安全错误。
    } finally {
      setBusy("");
    }
  };

  const onClick = async (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-tasks-action]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    const action = button.dataset.tasksAction;
    if (action === "load") await loadSelected();
    else if (action === "refresh") await manualRefresh();
    else if (action === "cancel") await cancelBatch();
    else if (action === "retry") await retryBatch();
    else if (action === "rerun") await rerunBatch();
    else if (action === "open-vault") actions.navigateToApp("vault");
    else if (action === "open-proxy") actions.navigateToApp("proxy");
    else if (action === "open-review") actions.navigateToApp("review");
  };

  root.addEventListener("click", onClick);

  return Object.freeze({
    activate() {
      if (destroyed || active) return;
      active = true;
      requestGate.advanceLifecycle();
      root.hidden = false;
      setElementInert(root, false);
      root.dataset.lifecycle = "active";
      const restored = !activeBatchId() ? storage.readActiveBatchId() : null;
      view.setOperationMessage("正在加载最近批次和活动批次……");
      queueMicrotask(() => {
        if (!active || destroyed) return;
        if (restored && !activeBatchId()) actions.setActiveBatchId(restored);
        void readRecent({ replace: true, report: false }).catch(() => {});
        if (activeBatchId()) {
          void readActive(null, { replace: true, report: true })
            .then(() => {
              if (active) view.setOperationMessage("批次已加载；活动批次每 1.5 秒自动刷新，结束后停止。");
            })
            .catch(() => {});
        }
      });
    },
    deactivate() {
      if (destroyed) return;
      active = false;
      requestGate.advanceLifecycle();
      operationSequence += 1;
      dialogs.destroy();
      operationController?.abort();
      operationController = null;
      abortRead(activeRead);
      abortRead(recentRead);
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
      abortRead(activeRead);
      abortRead(recentRead);
      root.removeEventListener("click", onClick);
      view.destroy();
      root.removeAttribute("data-lifecycle");
    },
  });
}

let controller = null;

export default Object.freeze({
  mount(context) {
    if (controller) throw new Error("TASKMGR.EXE 已挂载");
    controller = createTasksController(context);
  },
  activate() {
    controller?.activate();
  },
  deactivate() {
    controller?.deactivate();
  },
  unmount() {
    controller?.destroy();
    controller = null;
  },
});
