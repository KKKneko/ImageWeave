import { isAbortError } from "../core/api.js";
import {
  buildDiagnosticsSnapshot,
  diagnosticsCopyText,
  DIAGNOSTICS_POLL_INTERVAL_MS,
} from "../core/diagnostics-model.js";
import { setElementInert } from "../core/dom.js";
import { actionCreators } from "../core/store.js";
import { createDiagnosticsView } from "../components/diagnostics-view.js";

export const DIAGNOSTICS_ENDPOINTS = Object.freeze({
  health: "/healthz",
  readiness: "/readyz",
  config: "/api/v1/config?view=diagnostics",
  scheduler: "/api/v1/scheduler/status?view=diagnostics",
});

const DIAGNOSTICS_POLL_KEY = "diagnostics.snapshot";

async function readOutcome(api, path, signal) {
  try {
    return { connected: true, data: await api.get(path, { signal }), error: null };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      connected: Number.isInteger(error?.status) && error.status > 0,
      data: null,
      error: {
        status: Number.isInteger(error?.status) ? error.status : 0,
        code: error?.code,
        requestId: error?.requestId,
        details: error?.details,
      },
    };
  }
}

function createDiagnosticsController(context) {
  const { root, api, store, polling, actions } = context;
  const view = createDiagnosticsView(context);
  let active = false;
  let destroyed = false;
  let manualBusy = false;

  const refresh = async (signal) => {
    const [health, readiness, config, scheduler] = await Promise.all([
      readOutcome(api, DIAGNOSTICS_ENDPOINTS.health, signal),
      readOutcome(api, DIAGNOSTICS_ENDPOINTS.readiness, signal),
      readOutcome(api, DIAGNOSTICS_ENDPOINTS.config, signal),
      readOutcome(api, DIAGNOSTICS_ENDPOINTS.scheduler, signal),
    ]);
    if (!active || destroyed || signal.aborted) return false;
    const snapshot = buildDiagnosticsSnapshot({
      health,
      readiness,
      config,
      scheduler,
      checkedAt: Date.now(),
      previous: store.getState().diagnostics.snapshot,
    });
    store.dispatch(actionCreators.diagnosticsReceived(snapshot));
    view.setOperationMessage(snapshot.offline
      ? "服务离线，当前保留上次诊断结果。"
      : snapshot.stale
        ? "部分检查失败，已保留上次成功读取的组件状态。"
        : "服务、功能、安全配置和任务调度状态已刷新。");
    return true;
  };

  const manualRefresh = async () => {
    if (manualBusy) return;
    manualBusy = true;
    view.setBusy(true);
    try {
      await polling.trigger(DIAGNOSTICS_POLL_KEY);
    } finally {
      manualBusy = false;
      if (active) view.setBusy(false);
    }
  };

  const copySummary = async () => {
    const snapshot = store.getState().diagnostics.snapshot;
    if (!snapshot || manualBusy) return;
    const text = diagnosticsCopyText(snapshot);
    try {
      if (!globalThis.navigator?.clipboard?.writeText) throw new Error("clipboard unavailable");
      await globalThis.navigator.clipboard.writeText(text);
      if (active) view.setOperationMessage("诊断摘要已复制，敏感信息已隐藏。");
    } catch {
      if (active) view.setOperationMessage("浏览器未允许写入剪贴板，请检查权限后重试。");
    }
  };

  const onClick = async (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-diagnostics-action]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    const action = button.dataset.diagnosticsAction;
    if (action === "refresh") await manualRefresh();
    else if (action === "copy") await copySummary();
    else if (action === "navigate") {
      const target = button.closest("[data-target-app]")?.dataset.targetApp;
      if (["proxy", "tasks"].includes(target)) actions.navigateToApp(target);
    }
  };

  root.addEventListener("click", onClick);

  return Object.freeze({
    activate() {
      if (destroyed || active) return;
      active = true;
      root.hidden = false;
      setElementInert(root, false);
      root.dataset.lifecycle = "active";
      view.setOperationMessage("正在刷新诊断信息……");
      polling.start({
        key: DIAGNOSTICS_POLL_KEY,
        scope: context.pollingScope,
        intervalMs: DIAGNOSTICS_POLL_INTERVAL_MS,
        immediate: true,
        critical: false,
        resume: "immediate",
        task: refresh,
      });
    },
    deactivate() {
      if (destroyed) return;
      active = false;
      manualBusy = false;
      polling.stop(DIAGNOSTICS_POLL_KEY);
      view.setBusy(false);
      root.hidden = true;
      setElementInert(root, true);
      root.dataset.lifecycle = "inactive";
    },
    destroy() {
      if (destroyed) return;
      active = false;
      destroyed = true;
      polling.stop(DIAGNOSTICS_POLL_KEY);
      root.removeEventListener("click", onClick);
      view.destroy();
      root.removeAttribute("data-lifecycle");
    },
  });
}

let controller = null;

export default Object.freeze({
  mount(context) {
    if (controller) throw new Error("DIAG.EXE 已挂载");
    controller = createDiagnosticsController(context);
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
