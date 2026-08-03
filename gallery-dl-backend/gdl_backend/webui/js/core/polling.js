import { isAbortError } from "./api.js";

const RESOURCE_PATTERN = /^[a-z][a-z0-9._:-]{0,63}$/;
const RESUME_POLICIES = new Set(["immediate", "interval"]);

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
  if (typeof now !== "function" || typeof onError !== "function") {
    throw new TypeError("轮询依赖无效");
  }

  const entries = new Map();
  let destroyed = false;

  const isHidden = () => visibilitySource.getState() === "hidden";

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

  const finishRun = (entry, promise) => {
    if (entry.activePromise !== promise) return;
    entry.activePromise = null;
    entry.controller = null;
    entry.lastFinishedAt = Math.max(0, Number(now()) || 0);
    if (destroyed || entry.stopped || entries.get(entry.key) !== entry) return;
    if (!entry.critical && isHidden()) {
      entry.suspended = true;
      return;
    }
    if (entry.resumePending) {
      entry.resumePending = false;
      schedule(entry, entry.resumePolicy === "immediate" ? 0 : entry.intervalMs);
      return;
    }
    schedule(entry, entry.intervalMs);
  };

  const run = (entry) => {
    if (destroyed || entry.stopped) return Promise.resolve(false);
    if (!entry.critical && isHidden()) {
      entry.suspended = true;
      clearTimer(entry);
      return Promise.resolve(false);
    }
    if (entry.activePromise) return entry.activePromise;

    clearTimer(entry);
    entry.suspended = false;
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
    if (!RESUME_POLICIES.has(resume)) throw new TypeError("轮询恢复策略无效");

    const entry = {
      key,
      scope,
      task,
      intervalMs,
      critical,
      resumePolicy: resume,
      timerId: null,
      controller: null,
      activePromise: null,
      nextRunAt: null,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastError: null,
      runCount: 0,
      suspended: !critical && isHidden(),
      resumePending: false,
      stopped: false,
      handle: null,
    };
    entry.handle = Object.freeze({
      key,
      scope,
      trigger: () => run(entry),
      stop: () => stopEntry(entry),
    });
    entries.set(key, entry);
    if (!entry.suspended) schedule(entry, immediate ? 0 : intervalMs);
    return entry.handle;
  };

  const onVisibilityChange = () => {
    if (destroyed) return;
    if (isHidden()) {
      for (const entry of entries.values()) {
        if (entry.critical) continue;
        entry.suspended = true;
        entry.resumePending = false;
        clearTimer(entry);
        entry.controller?.abort();
      }
      return;
    }
    for (const entry of entries.values()) {
      if (entry.critical || !entry.suspended || entry.stopped) continue;
      entry.suspended = false;
      if (entry.activePromise) {
        entry.resumePending = true;
      } else {
        schedule(entry, entry.resumePolicy === "immediate" ? 0 : entry.intervalMs);
      }
    }
  };

  const unsubscribeVisibility = visibilitySource.subscribe(onVisibilityChange);

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
          intervalMs: entry.intervalMs,
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
      try {
        unsubscribeVisibility();
      } catch {
        // 销毁必须保持幂等。
      }
    },
  });
}
