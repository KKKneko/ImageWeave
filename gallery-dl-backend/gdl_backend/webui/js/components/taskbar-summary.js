import { actionCreators, selectors } from "../core/store.js";
import { isAbortError } from "../core/api.js";
import { requireElement } from "../core/dom.js";
import { updateStatusBadge } from "./status.js";

export const SHELL_POLL_KEY = "shell.summary";
export const SHELL_POLL_SCOPE = "shell";
export const SHELL_POLL_INTERVAL_MS = 30_000;

const COMPONENT_STATUSES = new Set([
  "ok",
  "error",
  "disabled",
  "optional_missing",
  "optional_warning",
]);

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function componentStatus(value) {
  const status = isRecord(value) && typeof value.status === "string" ? value.status : "unknown";
  return COMPONENT_STATUSES.has(status) ? status : "unknown";
}

function boundedCount(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= 1_000_000_000 ? number : 0;
}

export function sanitizeHealthPayload(payload) {
  if (!isRecord(payload) || typeof payload.ok !== "boolean") return null;
  return Object.freeze({
    ok: payload.ok,
    process: componentStatus(payload.components?.process),
    database: componentStatus(payload.components?.database),
  });
}

export function sanitizeReadinessPayload(payload) {
  if (!isRecord(payload) || typeof payload.ready !== "boolean") return null;
  const proxy = isRecord(payload.components?.project_proxy)
    ? Object.freeze({
        status: componentStatus(payload.components.project_proxy),
        running: Boolean(payload.components.project_proxy.running),
        healthy: boundedCount(payload.components.project_proxy.healthy),
        sourceCount: boundedCount(payload.components.project_proxy.source_count),
      })
    : null;
  const dedup = isRecord(payload.components?.dedup)
    ? Object.freeze({ status: componentStatus(payload.components.dedup) })
    : null;
  return Object.freeze({ ready: payload.ready, proxy, dedup });
}

function safeError(error) {
  if (!error || typeof error !== "object") return null;
  const code = typeof error.code === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(error.code)
    ? error.code
    : "request_failed";
  const requestId = typeof error.requestId === "string" &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(error.requestId)
    ? error.requestId
    : "";
  return Object.freeze({
    status: Number.isInteger(error.status) && error.status >= 0 ? error.status : 0,
    code,
    requestId,
  });
}

function apiDescriptor(connected, health, readiness) {
  if (!connected) return { status: "error", label: "服务离线" };
  if (!health || health.ok === false) return { status: "error", label: "服务异常" };
  if (readiness?.ready === true) return { status: "ready", label: "服务正常" };
  if (readiness?.ready === false) return { status: "warning", label: "服务未就绪" };
  return { status: "warning", label: "服务已连接" };
}

function proxyDescriptor(connected, readiness) {
  if (!connected) return { status: "error", label: "代理状态未知" };
  const proxy = readiness?.proxy;
  if (!proxy) return { status: "warning", label: "代理状态未知" };
  if (proxy.status === "disabled") return { status: "disabled", label: "代理已禁用" };
  if (proxy.status === "error") return { status: "error", label: "代理异常" };
  if (proxy.status === "ok" && proxy.running) {
    return { status: "running", label: `可用代理 ${proxy.healthy}` };
  }
  if (proxy.status === "ok") return { status: "ready", label: "代理已配置" };
  return { status: "warning", label: "代理待检查" };
}

function dedupDescriptor(connected, readiness) {
  if (!connected) return { status: "error", label: "去重状态未知" };
  const status = readiness?.dedup?.status;
  if (status === "disabled") return { status: "disabled", label: "去重已禁用" };
  if (status === "ok") return { status: "ready", label: "去重正常" };
  if (status === "error") return { status: "error", label: "去重异常" };
  return { status: "warning", label: "去重待检查" };
}

export function buildShellSnapshot({ healthOutcome, readinessOutcome, checkedAt = Date.now() }) {
  const connected = Boolean(healthOutcome?.connected || readinessOutcome?.connected);
  const health = sanitizeHealthPayload(healthOutcome?.data);
  const readiness = sanitizeReadinessPayload(readinessOutcome?.data);
  return {
    health,
    readiness,
    apiConnected: connected,
    summary: {
      api: apiDescriptor(connected, health, readiness),
      proxy: proxyDescriptor(connected, readiness),
      dedup: dedupDescriptor(connected, readiness),
    },
    errors: {
      health: safeError(healthOutcome?.error),
      readiness: safeError(readinessOutcome?.error),
    },
    lastCheckedAt: checkedAt,
  };
}

async function readEndpoint(api, path, signal) {
  try {
    return { connected: true, data: await api.get(path, { signal }), error: null };
  } catch (error) {
    if (isAbortError(error)) throw error;
    return {
      connected: Number.isInteger(error?.status) && error.status > 0,
      data: isRecord(error?.details) ? error.details : null,
      error: safeError(error),
    };
  }
}

export function initializeTaskbarSummary(root, { api, store, actions, polling, now = Date.now }) {
  const slots = {
    api: requireElement('[data-taskbar-summary="api"]', root),
    proxy: requireElement('[data-taskbar-summary="proxy"]', root),
    dedup: requireElement('[data-taskbar-summary="dedup"]', root),
  };
  const refreshButton = requireElement("[data-taskbar-refresh]", root);
  const diagnosticsButton = requireElement("[data-taskbar-diagnostics]", root);

  const render = (summary) => {
    for (const [name, descriptor] of Object.entries(summary)) {
      updateStatusBadge(slots[name], descriptor.status, descriptor.label, {
        title: `${descriptor.label}；可打开系统诊断查看详细信息`,
      });
    }
  };
  const unsubscribe = store.subscribe(selectors.taskbarSummary, render, {
    fireImmediately: true,
  });

  const poll = async (signal) => {
    const [healthOutcome, readinessOutcome] = await Promise.all([
      readEndpoint(api, "/healthz", signal),
      readEndpoint(api, "/readyz", signal),
    ]);
    store.dispatch(actionCreators.shellSummaryUpdated(buildShellSnapshot({
      healthOutcome,
      readinessOutcome,
      checkedAt: Math.max(0, Number(now()) || 0),
    })));
  };

  polling.start({
    key: SHELL_POLL_KEY,
    scope: SHELL_POLL_SCOPE,
    task: poll,
    intervalMs: SHELL_POLL_INTERVAL_MS,
    immediate: true,
    critical: false,
    resume: "immediate",
  });

  const onRefresh = () => {
    refreshButton.disabled = true;
    refreshButton.setAttribute("aria-busy", "true");
    Promise.resolve(polling.trigger(SHELL_POLL_KEY)).finally(() => {
      refreshButton.disabled = false;
      refreshButton.removeAttribute("aria-busy");
    });
  };
  const onDiagnostics = () => actions.navigateToApp("diagnostics");
  refreshButton.addEventListener("click", onRefresh);
  diagnosticsButton.addEventListener("click", onDiagnostics);

  return Object.freeze({
    refresh: onRefresh,
    destroy() {
      polling.stop(SHELL_POLL_KEY);
      unsubscribe();
      refreshButton.removeEventListener("click", onRefresh);
      diagnosticsButton.removeEventListener("click", onDiagnostics);
    },
  });
}
