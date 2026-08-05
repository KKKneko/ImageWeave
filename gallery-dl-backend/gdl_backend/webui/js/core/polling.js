import { isAbortError } from "./api.js";
import { POLLING_SCOPE_STATES } from "./polling-focus-source.js";

const RESOURCE_PATTERN = /^[a-z][a-z0-9._:-]{0,63}$/;
const RESUME_POLICIES = new Set(["immediate", "interval"]);
const APP_SCOPE_PREFIX = "app:";
const KNOWN_SCOPE_STATES = new Set(Object.values(POLLING_SCOPE_STATES));

export const UNFOCUSED_POLL_MULTIPLIER = 4;

function requireResourceName(value, label) {
  if (typeof value !== "string" || !RESOURCE_PATTERN.test(value)) {
    throw new TypeError(`${label}格式无效`);
  }
  return value;
}

function defaultVisibilitySource() {
  return Object.freeze({
    getState: () => document.visibilityState,
    subscribe(listener) {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  });
}

function safeErrorCode(error) {
  if (!error || typeof error !== "object") return "poll_failed";
  const code = typeof error.code === "string" ? error.code : "poll_failed";
  return /^[A-Za-z0-9._:-]{1,128}$/.test(code) ? code : "poll_failed";
}

export function createPollingManager({
  setTimeoutFn = globalThis.setTimeout,
  clearTimeoutFn = globalThis.clearTimeout,
  visibilitySource = defaultVisibilitySource(),
  focusSource = null,
  now = Date.now,
  onError = () => {},
} = {}) {
  if (typeof setTimeoutFn !== "function" || typeof clearTimeoutFn !== "function") {
    throw new TypeError("轮询定时器实现无效");
  }
  if (!visibilitySource || typeof visibilitySource.getState !== "function" ||
      typeof visibilitySource.subscribe !== "function") {
    throw new TypeError("页面可见性来源无效");
  }
  if (
    focusSource !== null
    && (
      typeof focusSource !== "object"
      || typeof focusSource.getFocusedScope !== "function"
      || typeof focusSource.subscribe !== "function"
      || (focusSource.getScopeState !== undefined &&
        typeof focusSource.getScopeState !== "function")
    )
  ) {
    throw new TypeError("窗口聚焦来源无效");
  }
  if (typeof now !== "function" || typeof onError !== "function") {
    throw new TypeError("轮询依赖无效");
  }

  const entries = new Map();
  let destroyed = false;

  const isHidden = () => visibilitySource.getState() === "hidden";

  const readFocusedScope = () => {
    if (!focusSource) return null;
    try {
      const scope = focusSource.getFocusedScope();
      return scope === null || scope === undefined
        ? null
        : typeof scope === "string" && RESOURCE_PATTERN.test(scope)
          ? scope
          : null;
    } catch {
      return null;
    }
  };

  const readScopeState = (scope) => {
    if (!focusSource) return null;
    if (!scope.startsWith(APP_SCOPE_PREFIX)) {
      return POLLING_SCOPE_STATES.UNMANAGED;
    }
    if (typeof focusSource.getScopeState !== "function") {
      return POLLING_SCOPE_STATES.OPEN;
    }
    try {
      const state = focusSource.getScopeState(scope);
      return KNOWN_SCOPE_STATES.has(state)
        ? state
        : POLLING_SCOPE_STATES.UNMANAGED;
    } catch {
      return POLLING_SCOPE_STATES.UNMANAGED;
    }
  };

  const effectivePolicy = (entry) => {
    // critical 只保留既有的页面隐藏例外；窗口最小化或关闭仍会挂起。
    if (!entry.critical && isHidden()) {
      return { suspended: true, intervalMs: null };
    }
    if (!focusSource) {
      return { suspended: false, intervalMs: entry.intervalMs };
    }

    const scopeState = readScopeState(entry.scope);
    if (
      scopeState === POLLING_SCOPE_STATES.MINIMIZED
      || scopeState === POLLING_SCOPE_STATES.CLOSED
    ) {
      return { suspended: true, intervalMs: null };
    }
    if (
      scopeState === POLLING_SCOPE_STATES.UNMANAGED
      || entry.alwaysFocusRate
      || entry.scope === readFocusedScope()
    ) {
      return { suspended: false, intervalMs: entry.intervalMs };
    }
    return {
      suspended: false,
      intervalMs: entry.intervalMs * UNFOCUSED_POLL_MULTIPLIER,
    };
  };

  const clearTimer = (entry) => {
    if (entry.timerId === null) return;
    clearTimeoutFn(entry.timerId);
    entry.timerId = null;
    entry.nextRunAt = null;
  };

  const schedule = (entry, delay) => {
    if (destroyed || entry.stopped || entry.suspended) return;
    clearTimer(entry);
    const boundedDelay = Math.max(0, Number(delay) || 0);
    entry.nextRunAt = Math.max(0, Number(now()) || 0) + boundedDelay;
    entry.timerId = setTimeoutFn(() => {
      entry.timerId = null;
      entry.nextRunAt = null;
      void run(entry);
    }, boundedDelay);
  };

  const setEffectivePolicy = (entry, policy) => {
    entry.suspended = policy.suspended;
    entry.effectiveIntervalMs = policy.intervalMs;
  };

  const reportFailure = (entry, error) => {
    const status = Number.isInteger(error?.status) && error.status >= 0 ? error.status : 0;
    const diagnostic = Object.freeze({
      key: entry.key,
      scope: entry.scope,
      code: safeErrorCode(error),
      status,
    });
    entry.lastError = { code: diagnostic.code, status };
    try {
      onError(diagnostic);
    } catch {
      // 诊断回调不得改变轮询调度。
    }
  };

  const reconcileEntry = (entry) => {
    if (destroyed || entry.stopped) return false;
    const previousSuspended = entry.suspended;
    const previousIntervalMs = entry.effectiveIntervalMs;
    const nextPolicy = effectivePolicy(entry);
    if (
      previousSuspended === nextPolicy.suspended
      && previousIntervalMs === nextPolicy.intervalMs
    ) return false;

    setEffectivePolicy(entry, nextPolicy);
    if (nextPolicy.suspended) {
      entry.resumePending = false;
      clearTimer(entry);
      entry.controller?.abort();
      return true;
    }

    const recovering = previousSuspended || (
      previousIntervalMs !== null
      && nextPolicy.intervalMs < previousIntervalMs
    );
    if (entry.activePromise) {
      // 活动请求保持单飞；结束后再按恢复策略安排唯一后续任务。
      entry.resumePending = recovering;
      return true;
    }

    entry.resumePending = false;
    schedule(
      entry,
      recovering && entry.resumePolicy === "immediate"
        ? 0
        : nextPolicy.intervalMs,
    );
    return true;
  };

  const finishRun = (entry, promise) => {
    if (entry.activePromise !== promise) return;
    entry.activePromise = null;
    entry.controller = null;
    entry.lastFinishedAt = Math.max(0, Number(now()) || 0);
    if (destroyed || entry.stopped || entries.get(entry.key) !== entry) return;

    setEffectivePolicy(entry, effectivePolicy(entry));
    if (entry.suspended) {
      entry.resumePending = false;
      return;
    }
    const resumePending = entry.resumePending;
    entry.resumePending = false;
    schedule(
      entry,
      resumePending && entry.resumePolicy === "immediate"
        ? 0
        : entry.effectiveIntervalMs,
    );
  };

  const run = (entry) => {
    if (destroyed || entry.stopped) return Promise.resolve(false);
    const policy = effectivePolicy(entry);
    setEffectivePolicy(entry, policy);
    if (policy.suspended) {
      entry.resumePending = false;
      clearTimer(entry);
      entry.controller?.abort();
      return Promise.resolve(false);
    }
    if (entry.activePromise) return entry.activePromise;

    clearTimer(entry);
    entry.runCount += 1;
    entry.lastStartedAt = Math.max(0, Number(now()) || 0);
    entry.lastError = null;
    const controller = new AbortController();
    entry.controller = controller;
    const promise = Promise.resolve()
      .then(() => entry.task(controller.signal))
      .then(() => true)
      .catch((error) => {
        if (!isAbortError(error) && !controller.signal.aborted) reportFailure(entry, error);
        return false;
      })
      .finally(() => finishRun(entry, promise));
    entry.activePromise = promise;
    return promise;
  };

  const stopEntry = (entry) => {
    if (!entry || entry.stopped) return false;
    entry.stopped = true;
    entry.resumePending = false;
    clearTimer(entry);
    entry.controller?.abort();
    entries.delete(entry.key);
    return true;
  };

  const start = ({
    key,
    scope = "global",
    task,
    intervalMs,
    immediate = true,
    critical,
    resume = "immediate",
    alwaysFocusRate = false,
  } = {}) => {
    if (destroyed) throw new Error("轮询管理器已销毁");
    requireResourceName(key, "轮询资源键");
    requireResourceName(scope, "轮询 scope");
    if (entries.has(key)) return entries.get(key).handle;
    if (typeof task !== "function") throw new TypeError("轮询任务必须是函数");
    if (!Number.isFinite(intervalMs) || intervalMs < 100) {
      throw new TypeError("轮询间隔不得小于 100ms");
    }
    if (typeof critical !== "boolean") {
      throw new TypeError("轮询必须显式声明 critical");
    }
    if (typeof alwaysFocusRate !== "boolean") {
      throw new TypeError("轮询 alwaysFocusRate 必须是布尔值");
    }
    if (!RESUME_POLICIES.has(resume)) throw new TypeError("轮询恢复策略无效");

    const entry = {
      key,
      scope,
      task,
      intervalMs,
      effectiveIntervalMs: intervalMs,
      critical,
      alwaysFocusRate,
      resumePolicy: resume,
      timerId: null,
      controller: null,
      activePromise: null,
      nextRunAt: null,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastError: null,
      runCount: 0,
      suspended: false,
      resumePending: false,
      stopped: false,
      handle: null,
    };
    setEffectivePolicy(entry, effectivePolicy(entry));
    entry.handle = Object.freeze({
      key,
      scope,
      trigger: () => run(entry),
      stop: () => stopEntry(entry),
    });
    entries.set(key, entry);
    if (!entry.suspended) {
      schedule(entry, immediate ? 0 : entry.effectiveIntervalMs);
    }
    return entry.handle;
  };

  const onSchedulingSourceChange = () => {
    if (destroyed) return;
    for (const entry of entries.values()) reconcileEntry(entry);
  };

  const visibilitySubscription = visibilitySource.subscribe(onSchedulingSourceChange);
  const unsubscribeVisibility = typeof visibilitySubscription === "function"
    ? visibilitySubscription
    : () => {};
  const focusSubscription = focusSource?.subscribe(onSchedulingSourceChange);
  const unsubscribeFocus = typeof focusSubscription === "function"
    ? focusSubscription
    : () => {};

  return Object.freeze({
    start,
    trigger(key) {
      const entry = entries.get(key);
      return entry ? run(entry) : Promise.resolve(false);
    },
    stop(key) {
      return stopEntry(entries.get(key));
    },
    stopScope(scope) {
      requireResourceName(scope, "轮询 scope");
      let stopped = 0;
      for (const entry of [...entries.values()]) {
        if (entry.scope === scope && stopEntry(entry)) stopped += 1;
      }
      return stopped;
    },
    getSummary() {
      return Object.freeze(
        [...entries.values()].map((entry) => Object.freeze({
          key: entry.key,
          scope: entry.scope,
          critical: entry.critical,
          alwaysFocusRate: entry.alwaysFocusRate,
          intervalMs: entry.intervalMs,
          effectiveIntervalMs: entry.suspended ? null : entry.effectiveIntervalMs,
          state: entry.suspended
            ? "paused"
            : entry.activePromise
              ? "running"
              : "scheduled",
          runCount: entry.runCount,
          nextRunAt: entry.nextRunAt,
          lastStartedAt: entry.lastStartedAt,
          lastFinishedAt: entry.lastFinishedAt,
          errorCode: entry.lastError?.code || null,
          errorStatus: entry.lastError?.status || 0,
        })),
      );
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      for (const entry of [...entries.values()]) stopEntry(entry);
      for (const unsubscribe of [unsubscribeVisibility, unsubscribeFocus]) {
        try {
          unsubscribe();
        } catch {
          // 销毁必须保持幂等，单个状态源清理失败不能阻断其余清理。
        }
      }
    },
  });
}
