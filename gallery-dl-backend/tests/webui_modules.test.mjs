import test from "node:test";
import assert from "node:assert/strict";

import {
  ApiError,
  buildRequestOptions,
  createApiClient,
  createIdempotencyKey,
  injectIdempotencyKey,
  normalizeApiError,
  parseResponseText,
} from "../gdl_backend/webui/js/core/api.js";
import { createShellActions } from "../gdl_backend/webui/js/core/actions.js";
import { getApplicationById } from "../gdl_backend/webui/js/core/app-registry.js";
import { createPollingManager } from "../gdl_backend/webui/js/core/polling.js";
import {
  buildCrawlPayload,
  buildSearchPayload,
  candidateMatchesEhFilter,
  parseEhTag,
  projectCrawlSearchResponse,
  sanitizeAutocompleteResponse,
} from "../gdl_backend/webui/js/core/crawl-model.js";
import {
  buildDiagnosticsSnapshot,
  diagnosticsCopyText,
  sanitizeDiagnosticsConfig,
  sanitizeDiagnosticsScheduler,
} from "../gdl_backend/webui/js/core/diagnostics-model.js";
import {
  buildPolicyPayload,
  createPolicyRequestGate,
  derivePolicyControls,
  formatPolicySource,
  isPolicyDirty,
  normalizePolicyLines,
  policyConfigToDraft,
  policyConfigsEqual,
  policyErrorGuidance,
  safePolicyErrorDetail,
  sanitizePolicyResponse,
  validatePolicyDraft,
} from "../gdl_backend/webui/js/core/policy-model.js";
import {
  buildReviewDecisionPayload,
  reviewImageUrl,
  sanitizeReviewPage,
  setReviewPageMode,
} from "../gdl_backend/webui/js/core/review-model.js";
import {
  batchProgress,
  sanitizeBatchDetail,
  sanitizeRecentBatches,
  sanitizeTaskPage,
  shouldPollBatch,
  taskRecoveryTargets,
} from "../gdl_backend/webui/js/core/tasks-model.js";
import {
  deriveProxyControls,
  formatInlineNodeSource,
  formatRevisionPair,
  formatRuntimeNode,
  formatSubscriptionSource,
  proxyErrorGuidance,
  safeProxyErrorDetail,
  sanitizeProxySources,
  sanitizeProxyStatus,
  splitInlineNodeInput,
} from "../gdl_backend/webui/js/core/proxy-model.js";
import {
  buildAuthorizationProxyPayload,
  createVaultRequestGate,
  deriveVaultControls,
  extractVaultSessionFromSnapshot,
  formatAuthorizationProxy,
  formatVaultSite,
  sanitizeVaultSiteStatus,
  sanitizeVaultStatus,
  validateAuthorizationProxyInput,
  vaultErrorGuidance,
} from "../gdl_backend/webui/js/core/vault-model.js";
import {
  actionCreators,
  createInitialState,
  createStore,
  selectors,
  UnknownActionError,
} from "../gdl_backend/webui/js/core/store.js";
import {
  createStorageService,
  isValidBatchId,
  STORAGE_KEYS,
} from "../gdl_backend/webui/js/core/storage.js";
import {
  normalizeStatus,
  resolveStatusPresentation,
} from "../gdl_backend/webui/js/components/status.js";
import {
  buildShellSnapshot,
  sanitizeHealthPayload,
  sanitizeReadinessPayload,
} from "../gdl_backend/webui/js/components/taskbar-summary.js";
import { toSafeErrorViewModel } from "../gdl_backend/webui/js/components/error-view.js";
import crawlApplication, {
  CRAWL_ENDPOINTS,
} from "../gdl_backend/webui/js/apps/crawl.js";
import diagnosticsApplication, {
  DIAGNOSTICS_ENDPOINTS,
} from "../gdl_backend/webui/js/apps/diagnostics.js";
import policyApplication, {
  POLICY_ENDPOINTS,
} from "../gdl_backend/webui/js/apps/policy.js";
import reviewApplication, {
  REVIEW_ENDPOINTS,
} from "../gdl_backend/webui/js/apps/review.js";
import tasksApplication, {
  TASKS_ENDPOINTS,
} from "../gdl_backend/webui/js/apps/tasks.js";
import proxyApplication, {
  PROXY_ENDPOINTS,
} from "../gdl_backend/webui/js/apps/proxy.js";
import vaultApplication, {
  VAULT_ENDPOINTS,
} from "../gdl_backend/webui/js/apps/vault.js";

function shellSnapshot(overrides = {}) {
  return {
    health: { ok: true, process: "ok", database: "ok" },
    readiness: {
      ready: true,
      proxy: { status: "disabled", running: false, healthy: 0, sourceCount: 0 },
      dedup: { status: "disabled" },
    },
    apiConnected: true,
    summary: {
      api: { status: "ready", label: "API 已就绪" },
      proxy: { status: "disabled", label: "代理已禁用" },
      dedup: { status: "disabled", label: "去重已禁用" },
    },
    errors: { health: null, readiness: null },
    lastCheckedAt: 123,
    ...overrides,
  };
}

class MemoryStorage {
  constructor({ throws = false } = {}) {
    this.values = new Map();
    this.throws = throws;
  }

  getItem(key) {
    if (this.throws) throw new Error("storage unavailable");
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    if (this.throws) throw new Error("storage unavailable");
    this.values.set(key, String(value));
  }

  removeItem(key) {
    if (this.throws) throw new Error("storage unavailable");
    this.values.delete(key);
  }
}

class FakeVisibility {
  constructor(state = "visible") {
    this.state = state;
    this.listeners = new Set();
  }

  getState = () => this.state;

  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  set(state) {
    this.state = state;
    for (const listener of [...this.listeners]) listener();
  }
}

class FakeTimers {
  constructor() {
    this.now = 0;
    this.sequence = 0;
    this.jobs = new Map();
  }

  setTimeout = (callback, delay) => {
    this.sequence += 1;
    this.jobs.set(this.sequence, { callback, due: this.now + delay });
    return this.sequence;
  };

  clearTimeout = (id) => {
    this.jobs.delete(id);
  };

  runNext() {
    const next = [...this.jobs.entries()].sort((left, right) =>
      left[1].due - right[1].due || left[0] - right[0])[0];
    if (!next) return false;
    const [id, job] = next;
    this.jobs.delete(id);
    this.now = job.due;
    job.callback();
    return true;
  }

  delays() {
    return [...this.jobs.values()].map((job) => job.due - this.now).sort((a, b) => a - b);
  }
}

async function flushPromises() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

function createFakePolling(options = {}) {
  const timers = new FakeTimers();
  const visibility = options.visibility || new FakeVisibility();
  const errors = [];
  const manager = createPollingManager({
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    visibilitySource: visibility,
    now: () => timers.now,
    onError: (error) => errors.push(error),
  });
  return { manager, timers, visibility, errors };
}

test("API 请求构造只在存在请求体时发送 JSON Content-Type", () => {
  const post = buildRequestOptions("post", {
    body: { name: "fixture" },
    headers: { "X-Test": "yes" },
  });
  assert.equal(post.method, "POST");
  assert.equal(post.cache, "no-store");
  assert.equal(post.headers.get("Accept"), "application/json");
  assert.equal(post.headers.get("Content-Type"), "application/json");
  assert.equal(post.body, '{"name":"fixture"}');

  const get = buildRequestOptions("GET", {
    headers: { "Content-Type": "text/plain" },
  });
  assert.equal(get.headers.get("Content-Type"), null);
  assert.equal("body" in get, false);
  assert.throws(() => buildRequestOptions("PATCH"), TypeError);
  assert.throws(() => buildRequestOptions("GET", { body: {} }), TypeError);
});

test("API 响应解析覆盖空响应、损坏 JSON 与后端错误模型", async () => {
  assert.deepEqual(parseResponseText(""), { kind: "empty", value: null });
  assert.deepEqual(parseResponseText('{"ok":true}'), { kind: "json", value: { ok: true } });
  assert.deepEqual(parseResponseText("<html>bad</html>"), { kind: "invalid", value: null });

  const responses = [
    new Response(null, { status: 204 }),
    new Response("", { status: 200, headers: { "Content-Type": "application/json" } }),
    new Response(JSON.stringify({
      error: {
        code: "fixture_conflict",
        message: "操作冲突",
        details: { field: "name" },
        request_id: "body-request-id",
      },
    }), { status: 409, headers: { "X-Request-ID": "header-request-id" } }),
    new Response("<html>gateway</html>", {
      status: 502,
      headers: { "Content-Type": "text/html", "X-Request-ID": "gateway-id" },
    }),
    new Response("{broken", { status: 200 }),
  ];
  const client = createApiClient({ fetchImpl: async () => responses.shift() });
  assert.equal(await client.get("/empty-204"), null);
  assert.equal(await client.get("/empty-200"), null);

  await assert.rejects(client.post("/conflict", {}), (error) => {
    assert(error instanceof ApiError);
    assert.equal(error.status, 409);
    assert.equal(error.code, "fixture_conflict");
    assert.equal(error.message, "操作冲突");
    assert.deepEqual(error.details, { field: "name" });
    assert.equal(error.requestId, "body-request-id");
    return true;
  });
  await assert.rejects(client.get("/gateway"), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.code, "http_error");
    assert.equal(error.details, null);
    assert.equal(error.requestId, "gateway-id");
    assert.equal(error.message.includes("gateway"), false);
    return true;
  });
  await assert.rejects(client.get("/broken"), (error) => {
    assert.equal(error.code, "invalid_response");
    assert.equal(error.details, null);
    return true;
  });
});

test("API 保留 AbortError，并把其他传输失败归一化", async () => {
  const aborted = new DOMException("aborted", "AbortError");
  const abortClient = createApiClient({ fetchImpl: async () => { throw aborted; } });
  await assert.rejects(abortClient.get("/abort"), (error) => error === aborted);

  const failedClient = createApiClient({ fetchImpl: async () => { throw new Error("private raw"); } });
  await assert.rejects(failedClient.delete("/offline"), (error) => {
    assert.equal(error.status, 0);
    assert.equal(error.code, "network_error");
    assert.equal(error.message.includes("private raw"), false);
    return true;
  });

  const normalized = normalizeApiError({
    status: 422,
    payload: { error: { code: "invalid", message: "无效", request_id: "req-1" } },
    requestId: "req-2",
  });
  assert.deepEqual(
    [normalized.status, normalized.code, normalized.message, normalized.requestId],
    [422, "invalid", "无效", "req-1"],
  );
});

test("幂等键优先使用 randomUUID，回退值不含业务数据", () => {
  const uuid = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(
    createIdempotencyKey({ cryptoObject: { randomUUID: () => uuid } }),
    `webui-${uuid}`,
  );
  const fallback = createIdempotencyKey({
    prefix: "crawl",
    cryptoObject: null,
    now: () => 1_000,
    random: () => 0.5,
  });
  assert.match(fallback, /^crawl-[a-z0-9]+-[a-z0-9]+$/);
  assert.equal(fallback.includes("secret"), false);
  const headers = injectIdempotencyKey({ Accept: "application/json" }, fallback);
  assert.equal(headers.get("Idempotency-Key"), fallback);
});

test("store 初始化完整状态并阻止外部修改数组、对象和 Map", () => {
  const initial = createInitialState();
  initial.crawl.sources.push({ site: "fixture" });
  initial.auth.bySite.set("fixture", { authorized: false });
  const store = createStore({ initialState: initial, reportError: () => {} });
  const state = store.getState();
  assert.deepEqual(
    Object.keys(state),
    ["system", "diagnostics", "proxy", "auth", "policy", "crawl", "batches", "review", "ui"],
  );
  assert(Object.isFrozen(state));
  assert(Object.isFrozen(state.crawl.sources));
  assert.throws(() => state.crawl.sources.push({}), TypeError);
  assert.throws(() => state.auth.bySite.set("other", {}), TypeError);

  initial.crawl.sources[0].site = "mutated";
  initial.auth.bySite.get("fixture").authorized = true;
  assert.equal(state.crawl.sources[0].site, "fixture");
  assert.equal(state.auth.bySite.get("fixture").authorized, false);
});

test("store 仅通过已知 action 更新，selector 避免无关通知", () => {
  const reports = [];
  const store = createStore({ reportError: (event) => reports.push(event) });
  let activeAppNotifications = 0;
  store.subscribe(selectors.activeApp, () => { activeAppNotifications += 1; });
  store.dispatch(actionCreators.startMenuChanged(true));
  assert.equal(activeAppNotifications, 0);
  store.dispatch(actionCreators.routeResolved("review", "maximized"));
  assert.equal(activeAppNotifications, 1);
  assert.equal(store.getState().ui.activeApp, "review");
  assert.equal(store.getState().ui.windowVisibility, "open");
  assert.equal(store.getState().ui.windowState, "maximized");
  assert.throws(() => store.dispatch({ type: "unknown/action" }), UnknownActionError);
  assert.throws(
    () => store.dispatch(actionCreators.windowVisibilityChanged("invisible")),
    TypeError,
  );
  assert.deepEqual(reports, []);
});

test("store 克隆 action payload，订阅者异常与嵌套 dispatch 不阻断其他订阅者", () => {
  let reportCount = 0;
  const store = createStore({ reportError: () => { reportCount += 1; } });
  const payload = shellSnapshot();
  store.dispatch(actionCreators.shellSummaryUpdated(payload));
  payload.health.ok = false;
  payload.summary.api.label = "被外部修改";
  assert.equal(store.getState().system.health.ok, true);
  assert.equal(store.getState().system.summary.api.label, "API 已就绪");

  let secondSubscriberRan = false;
  store.subscribe(selectors.startMenuOpen, () => {
    store.dispatch(actionCreators.startMenuChanged(false));
  });
  store.subscribe(selectors.startMenuOpen, () => {
    secondSubscriberRan = true;
    assert.throws(() => { store.getState().ui.activeApp = "proxy"; }, TypeError);
  });
  store.dispatch(actionCreators.startMenuChanged(true));
  assert.equal(reportCount, 1);
  assert.equal(secondSubscriberRan, true);
  assert.equal(store.getState().ui.startMenuOpen, true);
});

test("store 初次订阅渲染期间同样禁止嵌套 dispatch", () => {
  let reportCount = 0;
  const store = createStore({ reportError: () => { reportCount += 1; } });
  store.subscribe(selectors.startMenuOpen, () => {
    store.dispatch(actionCreators.startMenuChanged(true));
  }, { fireImmediately: true });
  assert.equal(reportCount, 1);
  assert.equal(store.getState().ui.startMenuOpen, false);
});

test("跨应用 action 先调用 router，只有路由结果才能更新 activeApp", () => {
  const store = createStore({ reportError: () => {} });
  const navigations = [];
  const writes = [];
  const storage = {
    readWindowMaximized: (appId) => appId === "review" ? false : null,
    writeCurrentApp: (appId) => writes.push(["app", appId]),
    writeWindowMaximized: (appId, value) => writes.push(["window", appId, value]),
    writeActiveBatchId: (batchId) => writes.push(["batch", batchId]),
    clearActiveBatchId: () => writes.push(["batch-clear"]),
  };
  const actions = createShellActions({
    store,
    router: { navigate: (target) => navigations.push(target) },
    storage,
  });

  actions.navigateToApp("review");
  assert.deepEqual(navigations, ["review"]);
  assert.equal(store.getState().ui.activeApp, "crawl");
  actions.routeResolved(getApplicationById("review"));
  assert.equal(store.getState().ui.activeApp, "review");
  assert.equal(store.getState().ui.windowState, "normal");
  actions.toggleWindowMaximized();
  assert.equal(store.getState().ui.windowState, "maximized");
  assert.deepEqual(writes, [
    ["app", "review"],
    ["window", "review", true],
  ]);
});

test("轮询按资源键去重且活动请求不重叠，停止时中止", async () => {
  const { manager, timers } = createFakePolling();
  let calls = 0;
  let activeSignal;
  let release;
  const handle = manager.start({
    key: "resource.one",
    scope: "app:test",
    intervalMs: 1_000,
    immediate: true,
    critical: false,
    task(signal) {
      calls += 1;
      activeSignal = signal;
      return new Promise((resolve) => { release = resolve; });
    },
  });
  const duplicate = manager.start({
    key: "resource.one",
    scope: "other",
    intervalMs: 2_000,
    immediate: true,
    critical: false,
    task: async () => { calls += 100; },
  });
  assert.equal(duplicate, handle);
  assert.equal(timers.jobs.size, 1);
  timers.runNext();
  await flushPromises();
  assert.equal(calls, 1);
  const firstTrigger = manager.trigger("resource.one");
  const secondTrigger = manager.trigger("resource.one");
  assert.equal(firstTrigger, secondTrigger);
  assert.equal(calls, 1);
  handle.stop();
  assert.equal(activeSignal.aborted, true);
  release();
  await flushPromises();
  assert.equal(manager.getSummary().length, 0);
  manager.destroy();
});

test("轮询失败保持固定间隔，诊断摘要不包含原始异常", async () => {
  const { manager, timers, errors } = createFakePolling();
  manager.start({
    key: "resource.failure",
    scope: "shell",
    intervalMs: 2_000,
    immediate: true,
    critical: false,
    task: async () => {
      const error = new Error("secret response body");
      error.code = "fixture_error";
      error.status = 503;
      throw error;
    },
  });
  timers.runNext();
  await flushPromises();
  assert.deepEqual(timers.delays(), [2_000]);
  assert.deepEqual(errors, [{
    key: "resource.failure",
    scope: "shell",
    code: "fixture_error",
    status: 503,
  }]);
  const diagnostic = manager.getSummary()[0];
  assert.equal(diagnostic.errorCode, "fixture_error");
  assert.equal(JSON.stringify(diagnostic).includes("secret response body"), false);
  manager.destroy();
});

test("页面隐藏暂停并中止非关键轮询，恢复后只安排一次立即执行", async () => {
  const visibility = new FakeVisibility();
  const { manager, timers } = createFakePolling({ visibility });
  let calls = 0;
  let aborted = false;
  manager.start({
    key: "resource.visibility",
    scope: "shell",
    intervalMs: 1_000,
    immediate: true,
    critical: false,
    resume: "immediate",
    task(signal) {
      calls += 1;
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    },
  });
  timers.runNext();
  await flushPromises();
  visibility.set("hidden");
  assert.equal(aborted, true);
  assert.equal(timers.jobs.size, 0);
  await flushPromises();
  visibility.set("visible");
  assert.deepEqual(timers.delays(), [0]);
  timers.runNext();
  await flushPromises();
  assert.equal(calls, 2);
  manager.stopScope("shell");
  assert.equal(manager.getSummary().length, 0);
  manager.destroy();
});

test("关键轮询隐藏时继续，destroy 清理定时器和可见性监听", async () => {
  const visibility = new FakeVisibility("hidden");
  const { manager, timers } = createFakePolling({ visibility });
  let calls = 0;
  manager.start({
    key: "resource.critical",
    scope: "global",
    intervalMs: 500,
    immediate: true,
    critical: true,
    task: async () => { calls += 1; },
  });
  assert.deepEqual(timers.delays(), [0]);
  timers.runNext();
  await flushPromises();
  assert.equal(calls, 1);
  assert.deepEqual(timers.delays(), [500]);
  manager.destroy();
  assert.equal(timers.jobs.size, 0);
  assert.equal(visibility.listeners.size, 0);
});

test("Storage 只写固定命名空间白名单并区分 session/local", () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const storage = createStorageService({ localStorage: local, sessionStorage: session });
  assert.equal(storage.writeCurrentApp("review"), true);
  assert.equal(storage.writeActiveBatchId("batch-123"), true);
  assert.equal(storage.writeWindowMaximized("review", false), true);
  assert.equal(storage.writeUiPreferences({
    animations: "system",
    taskbarDensity: "compact",
  }), true);

  assert.deepEqual([...session.values.keys()].sort(), [
    STORAGE_KEYS.activeBatch,
    STORAGE_KEYS.currentApp,
  ].sort());
  assert.deepEqual([...local.values.keys()].sort(), [
    STORAGE_KEYS.uiPreferences,
    STORAGE_KEYS.windowMaximized,
  ].sort());
  assert.equal(storage.readCurrentApp(), "review");
  assert.equal(storage.readActiveBatchId(), "batch-123");
  assert.equal(storage.readWindowMaximized("review"), false);
  assert.deepEqual(storage.readUiPreferences(), {
    animations: "system",
    taskbarDensity: "compact",
  });
  assert.equal(storage.setItem, undefined);
  assert.equal(storage.getItem, undefined);
});

test("Storage 校验格式并兼容不可用或损坏的浏览器存储", () => {
  assert.equal(isValidBatchId("batch:abc-123"), true);
  assert.equal(isValidBatchId("../private"), false);
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const storage = createStorageService({ localStorage: local, sessionStorage: session });
  assert.throws(() => storage.writeCurrentApp("unknown"), TypeError);
  assert.throws(() => storage.writeActiveBatchId("bad/path"), TypeError);
  assert.throws(() => storage.writeWindowMaximized("review", "yes"), TypeError);
  assert.throws(() => storage.writeUiPreferences({ arbitrary: "value" }), TypeError);

  session.values.set(STORAGE_KEYS.currentApp, "invalid-app");
  session.values.set(STORAGE_KEYS.activeBatch, "bad/path");
  local.values.set(STORAGE_KEYS.windowMaximized, "not-json");
  assert.equal(storage.readCurrentApp(), null);
  assert.equal(storage.readActiveBatchId(), null);
  assert.equal(storage.readWindowMaximized("review"), null);

  const unavailable = createStorageService({
    localStorage: new MemoryStorage({ throws: true }),
    sessionStorage: new MemoryStorage({ throws: true }),
  });
  assert.equal(unavailable.readCurrentApp(), null);
  assert.equal(unavailable.writeCurrentApp("crawl"), false);
  assert.equal(unavailable.readWindowMaximized("review"), null);
  assert.equal(unavailable.writeWindowMaximized("review", true), false);
});

test("状态映射始终返回图标、文本和非颜色状态类别", () => {
  assert.equal(normalizeStatus("ok"), "ready");
  assert.equal(normalizeStatus("optional_warning"), "warning");
  assert.equal(normalizeStatus("placeholder"), "disabled");
  assert.equal(normalizeStatus("unexpected"), null);
  assert.deepEqual(resolveStatusPresentation("error", "连接失败"), {
    status: "error",
    icon: "!",
    label: "连接失败",
  });
  assert.throws(() => resolveStatusPresentation("unknown"), Error);
});

test("任务栏摘要只保留健康、代理和去重的脱敏投影", () => {
  const health = sanitizeHealthPayload({
    ok: true,
    components: {
      process: { status: "ok", raw: "ignored" },
      database: { status: "ok", path: "/private/database" },
    },
    raw: { ignored: true },
  });
  assert.deepEqual(health, { ok: true, process: "ok", database: "ok" });
  const readiness = sanitizeReadinessPayload({
    ready: true,
    components: {
      project_proxy: {
        status: "ok",
        running: true,
        healthy: 4,
        source_count: 8,
        details: { raw: "ignored" },
      },
      dedup: { status: "error", reason: "ignored" },
    },
  });
  assert.deepEqual(readiness, {
    ready: true,
    proxy: { status: "ok", running: true, healthy: 4, sourceCount: 8 },
    dedup: { status: "error" },
  });

  const snapshot = buildShellSnapshot({
    healthOutcome: { connected: true, data: { ok: true, components: {
      process: { status: "ok" }, database: { status: "ok" },
    } } },
    readinessOutcome: { connected: true, data: { ready: false, components: {
      project_proxy: { status: "ok", running: true, healthy: 4, source_count: 8 },
      dedup: { status: "error" },
    } } },
    checkedAt: 456,
  });
  assert.deepEqual(snapshot.summary, {
    api: { status: "warning", label: "API 未完全就绪" },
    proxy: { status: "running", label: "代理运行中 · 4" },
    dedup: { status: "error", label: "去重异常" },
  });
  assert.equal(JSON.stringify(snapshot).includes("/private"), false);

  const offline = buildShellSnapshot({
    healthOutcome: { connected: false, data: null, error: {
      status: 0, code: "network_error", requestId: "",
    } },
    readinessOutcome: { connected: false, data: null, error: {
      status: 0, code: "network_error", requestId: "",
    } },
    checkedAt: 789,
  });
  assert.equal(offline.apiConnected, false);
  assert.deepEqual(
    Object.values(offline.summary).map((item) => item.status),
    ["error", "error", "error"],
  );
});

test("通用错误视图模型隐藏地址、敏感片段和原始 details", () => {
  const model = toSafeErrorViewModel({
    code: "backend_fixture",
    message: "访问 https://example.invalid/private?token=abc 失败 token=abc，日志 /home/private/raw.log",
    requestId: "request-123",
    details: { raw: "never-render" },
  });
  assert.equal(model.message.includes("example.invalid"), false);
  assert.equal(model.message.includes("token=abc"), false);
  assert.equal(model.message.includes("/home/private"), false);
  assert.equal(model.requestId, "request-123");
  assert.equal(JSON.stringify(model).includes("never-render"), false);
});

const CONFIGURED_REVISION = "a".repeat(64);
const ACTIVE_REVISION = "b".repeat(64);
const SUBSCRIPTION_ID = `sub_${"c".repeat(64)}`;
const INLINE_NODE_ID = `node_${"d".repeat(64)}`;
const PROXY_FIXTURE_SECRET = "fixture-super-secret-value";

function rawProxyStatus(overrides = {}) {
  return {
    enabled: true,
    engine: "native",
    managed_by_backend: true,
    auto_start: false,
    running: true,
    total: 1,
    healthy: 1,
    retry_eligible: 1,
    leases: 0,
    last_error: "",
    configured_revision: CONFIGURED_REVISION,
    active_revision: ACTIVE_REVISION,
    reload_required: true,
    transport_core: {
      enabled: true,
      running: true,
      listeners: 1,
      last_error: "",
      binary: `/private/${PROXY_FIXTURE_SECRET}`,
    },
    sources: {
      subscriptions: 1,
      source_nodes: 1,
      pool_nodes: 1,
      core_candidates: 0,
      core_nodes: 0,
      skipped_nodes: 0,
      scheme_counts: { http: 1 },
      warnings: [],
      subscription_url: `https://provider.invalid/${PROXY_FIXTURE_SECRET}`,
    },
    nodes: [{
      id: "0123456789abcdefabcd",
      name: "JP\u0000 NODE",
      protocol: "http",
      endpoint: "http://***@proxy.fixture.invalid:8080",
      tags: ["jp", "http", "bad tag", "jp"],
      healthy: true,
      retry_eligible: true,
      ref_count: 0,
      success_count: 8,
      fail_count: 2,
      last_latency_ms: 42.25,
      cooldown_until: 0,
      last_error: `访问 https://private.invalid/${PROXY_FIXTURE_SECRET} token=${PROXY_FIXTURE_SECRET}`,
      raw_endpoint: `http://user:${PROXY_FIXTURE_SECRET}@private.invalid:8080`,
    }],
    request_body: { secret: PROXY_FIXTURE_SECRET },
    ...overrides,
  };
}

function rawProxySources(overrides = {}) {
  return {
    source: "runtime",
    has_runtime_override: true,
    runtime_override_valid: true,
    configured_revision: CONFIGURED_REVISION,
    active_revision: ACTIVE_REVISION,
    reload_required: true,
    subscriptions: [{
      id: SUBSCRIPTION_ID,
      source: "runtime",
      scheme: "https",
      host: "provider.fixture.invalid",
      port: 8443,
      display_url: `https://provider.fixture.invalid/private/${PROXY_FIXTURE_SECRET}`,
      credentials_redacted: true,
      sensitive_parts_redacted: true,
      url: `https://user:${PROXY_FIXTURE_SECRET}@provider.fixture.invalid/private`,
    }],
    node_file: {
      configured: true,
      source: "runtime",
      display_path: `/home/private/${PROXY_FIXTURE_SECRET}/nodes.yaml`,
      path: `/home/private/${PROXY_FIXTURE_SECRET}/nodes.yaml`,
    },
    inline_nodes: [{
      id: INLINE_NODE_ID,
      source: "runtime",
      scheme: "vless",
      name: "JP-01",
      host: "proxy.fixture.invalid",
      port: 443,
      requires_transport_core: true,
      display_endpoint: `vless://${PROXY_FIXTURE_SECRET}@proxy.fixture.invalid:443?token=bad`,
      node: `vless://${PROXY_FIXTURE_SECRET}@proxy.fixture.invalid:443`,
    }],
    counts: { subscriptions: 1, node_file: 1, inline_nodes: 1, total: 3 },
    unknown_secret: PROXY_FIXTURE_SECRET,
    ...overrides,
  };
}

function controlStatus(overrides = {}) {
  return {
    enabled: true,
    running: false,
    leases: 0,
    reload_required: true,
    ...overrides,
  };
}

test("代理运行状态 sanitizer 只保留脱敏白名单并防御控制字符和危险字段", () => {
  const sanitized = sanitizeProxyStatus(rawProxyStatus());
  assert.deepEqual(Object.keys(sanitized).sort(), [
    "active_revision",
    "auto_start",
    "configured_revision",
    "enabled",
    "engine",
    "healthy",
    "last_error",
    "leases",
    "managed_by_backend",
    "node_rows_received",
    "nodes",
    "nodes_truncated",
    "reload_required",
    "retry_eligible",
    "running",
    "sources",
    "total",
    "transport_core",
  ].sort());
  assert.equal(sanitized.nodes.length, 1);
  assert.equal(sanitized.nodes[0].name, "JP NODE");
  assert.deepEqual(sanitized.nodes[0].tags, ["jp", "http"]);
  assert.equal(sanitized.nodes[0].endpoint, "http://***@proxy.fixture.invalid:8080");
  assert.equal(sanitized.nodes[0].last_error.includes("private.invalid"), false);
  assert.equal("binary" in sanitized.transport_core, false);
  assert.equal("subscription_url" in sanitized.sources, false);
  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes(PROXY_FIXTURE_SECRET), false);
  assert.equal(serialized.includes("raw_endpoint"), false);

  const overlong = sanitizeProxyStatus(rawProxyStatus({
    last_error: `日志位于 /home/private/${PROXY_FIXTURE_SECRET}/core.log`,
    nodes: [{ ...rawProxyStatus().nodes[0], name: `LONG\u0007${"x".repeat(500)}` }],
  }));
  assert(overlong.nodes[0].name.length <= 80);
  assert.equal(overlong.nodes[0].name.includes("\u0007"), false);
  assert.equal(overlong.last_error.includes("/home/private"), false);
  assert.equal(overlong.last_error.includes(PROXY_FIXTURE_SECRET), false);
  assert.throws(() => sanitizeProxyStatus(null), TypeError);
});

test("代理源 sanitizer 丢弃原文、绝对路径、危险 display 和无效条目", () => {
  const raw = rawProxySources({
    subscriptions: [
      ...rawProxySources().subscriptions,
      { id: "bad-id", display_url: `https://bad/${PROXY_FIXTURE_SECRET}` },
    ],
    inline_nodes: [
      ...rawProxySources().inline_nodes,
      { id: "node_bad", node: PROXY_FIXTURE_SECRET },
    ],
  });
  const sanitized = sanitizeProxySources(raw);
  assert.equal(sanitized.subscriptions.length, 1);
  assert.equal(sanitized.inline_nodes.length, 1);
  assert.equal(sanitized.subscriptions[0].display_url, "https://provider.fixture.invalid:8443/…");
  assert.equal(sanitized.inline_nodes[0].display_endpoint, "vless://***@proxy.fixture.invalid:443#JP-01");
  assert.equal(sanitized.node_file.display_path, "路径已隐藏");
  assert.deepEqual(Object.keys(sanitized.subscriptions[0]).sort(), [
    "credentials_redacted", "display_url", "host", "id", "port", "scheme",
    "sensitive_parts_redacted", "source",
  ].sort());
  const serialized = JSON.stringify(sanitized);
  assert.equal(serialized.includes(PROXY_FIXTURE_SECRET), false);
  assert.equal(serialized.includes("unknown_secret"), false);
  assert.equal(serialized.includes("/home/private"), false);
  assert.throws(() => sanitizeProxySources([]), TypeError);
});

test("代理 Store action 二次投影、克隆并保持 status/source selector 隔离", () => {
  const store = createStore({ reportError: () => {} });
  let statusNotifications = 0;
  let sourceNotifications = 0;
  store.subscribe(selectors.proxyStatus, () => { statusNotifications += 1; });
  store.subscribe(selectors.proxySources, () => { sourceNotifications += 1; });

  const statusPayload = rawProxyStatus();
  store.dispatch(actionCreators.proxyStatusReceived(statusPayload));
  assert.equal(statusNotifications, 1);
  assert.equal(sourceNotifications, 0);
  statusPayload.nodes[0].name = PROXY_FIXTURE_SECRET;
  assert.equal(store.getState().proxy.status.nodes[0].name, "JP NODE");
  assert(Object.isFrozen(store.getState().proxy.status.nodes[0]));

  const sourcePayload = rawProxySources();
  store.dispatch(actionCreators.proxySourcesReceived(sourcePayload));
  assert.equal(statusNotifications, 1);
  assert.equal(sourceNotifications, 1);
  sourcePayload.subscriptions[0].host = PROXY_FIXTURE_SECRET;
  const stored = JSON.stringify(store.getState().proxy);
  assert.equal(stored.includes(PROXY_FIXTURE_SECRET), false);

  const directDispatch = createStore({ reportError: () => {} });
  directDispatch.dispatch({ type: "proxy/statusReceived", payload: rawProxyStatus() });
  directDispatch.dispatch({ type: "proxy/sourcesReceived", payload: rawProxySources() });
  assert.equal(directDispatch.getState().proxy.status.engine, "native");
  assert.equal(directDispatch.getState().proxy.sources.source, "runtime");
  assert.throws(() => store.dispatch(actionCreators.proxyStatusReceived(null)), TypeError);
  assert.throws(() => store.dispatch(actionCreators.proxySourcesReceived(null)), TypeError);
});

test("代理运行按钮矩阵覆盖停用、运行、租约、等待重载和 busy", () => {
  const unloaded = deriveProxyControls(null);
  assert.equal(unloaded.start.disabled, true);
  assert.equal(unloaded.refresh.disabled, false);

  const disabled = deriveProxyControls(controlStatus({ enabled: false }));
  assert.equal(disabled.start.disabled, true);
  assert.equal(disabled.reload.disabled, true);

  const stopped = deriveProxyControls(controlStatus());
  assert.equal(stopped.start.disabled, false);
  assert.equal(stopped.stop.disabled, true);
  assert.equal(stopped.reload.disabled, false);
  assert.equal(stopped.probe.disabled, true);

  const running = deriveProxyControls(controlStatus({ running: true, reload_required: false }));
  assert.equal(running.start.disabled, true);
  assert.equal(running.stop.disabled, false);
  assert.equal(running.reload.disabled, true);
  assert.match(running.reload.reason, /无需重载/);
  assert.equal(running.probe.disabled, false);

  const leased = deriveProxyControls(controlStatus({ running: true, leases: 3 }));
  assert.equal(leased.stop.disabled, true);
  assert.equal(leased.reload.disabled, true);
  assert.match(leased.stop.reason, /3 个活动租约/);
  assert.equal(leased.probe.disabled, false);

  const busy = deriveProxyControls(controlStatus({ running: true }), { busy: "probe" });
  assert.equal(Object.values(busy).every((item) => item.disabled), true);
  assert.equal(busy.probe.label, "正在探活…");
});

test("批量节点逐行构造 payload，formatter 不读取原始秘密字段", () => {
  assert.deepEqual(
    splitInlineNodeInput("  http://127.0.0.1:1#a  \r\n\n socks5://127.0.0.1:2#b \n"),
    ["http://127.0.0.1:1#a", "socks5://127.0.0.1:2#b"],
  );
  assert.throws(() => splitInlineNodeInput(null), TypeError);

  const sources = sanitizeProxySources(rawProxySources());
  const subscription = formatSubscriptionSource({
    ...sources.subscriptions[0],
    raw_url: PROXY_FIXTURE_SECRET,
  });
  const inline = formatInlineNodeSource({
    ...sources.inline_nodes[0],
    raw_node: PROXY_FIXTURE_SECRET,
  });
  const node = formatRuntimeNode({
    ...sanitizeProxyStatus(rawProxyStatus()).nodes[0],
    raw_endpoint: PROXY_FIXTURE_SECRET,
  }, 0);
  assert.equal(JSON.stringify({ subscription, inline, node }).includes(PROXY_FIXTURE_SECRET), false);
  assert.deepEqual(formatRevisionPair(CONFIGURED_REVISION, CONFIGURED_REVISION).relation, "相同");
  assert.deepEqual(formatRevisionPair(CONFIGURED_REVISION, ACTIVE_REVISION).relation, "不同");
});

test("409、422、413 与安全 index/reason 映射不回显 details 原文", () => {
  const conflict = proxyErrorGuidance({ code: "proxy_conflict", status: 409 });
  assert.match(conflict.nextStep, /释放活动租约/);
  const invalid = proxyErrorGuidance({
    code: "invalid_proxy_inline_node",
    status: 422,
    details: { index: 2, reason: "unsupported_or_empty", raw: PROXY_FIXTURE_SECRET },
  });
  assert.match(invalid.detail, /第 3 行/);
  assert.match(invalid.detail, /unsupported_or_empty/);
  assert.equal(invalid.detail.includes(PROXY_FIXTURE_SECRET), false);
  assert.match(proxyErrorGuidance({ status: 413 }).nextStep, /减少/);
  assert.equal(
    safeProxyErrorDetail({ details: { index: 9999, reason: `bad ${PROXY_FIXTURE_SECRET}` } }),
    "",
  );
});

test("PROXY 应用暴露完整生命周期且端点白名单固定", () => {
  for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
    assert.equal(typeof proxyApplication[hook], "function");
  }
  assert.deepEqual(Object.values(PROXY_ENDPOINTS).sort(), [
    "/api/v1/proxy/probe",
    "/api/v1/proxy/reload",
    "/api/v1/proxy/sources",
    "/api/v1/proxy/sources/inline-nodes",
    "/api/v1/proxy/sources/node-file",
    "/api/v1/proxy/sources/override",
    "/api/v1/proxy/sources/subscriptions",
    "/api/v1/proxy/start",
    "/api/v1/proxy/status",
    "/api/v1/proxy/stop",
  ].sort());
});

const VAULT_FIXTURE_SECRET = "vault-fixture-cookie-token-password-7f3c1a";
const VAULT_SESSION_ID = "e".repeat(32);

function rawVaultSite(site, overrides = {}) {
  const definitions = {
    danbooru: {
      label: "Danbooru",
      method: "anonymous",
      state: "ready",
      authorized: true,
      actions: [],
    },
    twitter: {
      label: "X / Twitter",
      method: "managed_browser",
      state: "authorized",
      authorized: true,
      actions: ["managed_browser_login", "clear", `token=${VAULT_FIXTURE_SECRET}`],
      browser: "project_chrome",
      profile: "shared",
      updated_at: 1_700_000_000,
      cookies: {
        present: true,
        valid: true,
        cookie_count: 2,
        required_present: ["auth_token", "ct0"],
        raw_cookie: VAULT_FIXTURE_SECRET,
        updated_at: 1_700_000_000,
      },
      invalid_reason: `Cookie ${VAULT_FIXTURE_SECRET} in /home/private/cookies.txt`,
      login: null,
    },
    pixiv: {
      label: "Pixiv",
      method: "oauth",
      state: "required",
      authorized: false,
      actions: ["oauth", "clear"],
      browser: "project_chrome",
      profile: "shared",
      updated_at: null,
      oauth: null,
    },
    exhentai: {
      label: "EH",
      method: "managed_browser",
      state: "required",
      authorized: false,
      actions: ["managed_browser_login", "clear"],
      cookies: {
        present: false,
        valid: false,
        cookie_count: 0,
        missing: ["ipb_member_id", "ipb_pass_hash"],
      },
      login: null,
    },
    pawchive: {
      label: "Pawchive",
      method: "anonymous",
      state: "ready",
      authorized: true,
      actions: [],
    },
  };
  return {
    site,
    summary: `https://user:${VAULT_FIXTURE_SECRET}@private.invalid/path?token=${VAULT_FIXTURE_SECRET}`,
    authorization: `Bearer ${VAULT_FIXTURE_SECRET}`,
    ...definitions[site],
    ...overrides,
  };
}

function rawVaultSnapshot(overrides = {}) {
  return {
    items: [
      rawVaultSite("danbooru"),
      rawVaultSite("twitter"),
      rawVaultSite("pixiv"),
      rawVaultSite("exhentai"),
      rawVaultSite("pawchive"),
      {
        site: "unknown",
        method: "token",
        password: VAULT_FIXTURE_SECRET,
      },
    ],
    browser_profile: {
      shared: true,
      present: true,
      running: false,
      resetting: false,
      path: `/home/private/${VAULT_FIXTURE_SECRET}`,
      sites: ["twitter", "pixiv", "exhentai"],
    },
    authorization_proxy: {
      proxy_url: "http://***@proxy.fixture.invalid:7890",
      source: "runtime",
      config_proxy_url: `http://user:${VAULT_FIXTURE_SECRET}@config.invalid:7890`,
      browser_proxy_url: `http://user:${VAULT_FIXTURE_SECRET}@browser.invalid:7890`,
      credentials_redacted: true,
      browser_running: false,
      restart_pending: false,
      updated_at: 1_700_000_100,
      password: VAULT_FIXTURE_SECRET,
    },
    managed: true,
    secrets_exposed: false,
    response_profile: "vault",
    raw_request: { token: VAULT_FIXTURE_SECRET },
    ...overrides,
  };
}

function vaultSnapshotWithActivePixiv() {
  const raw = rawVaultSnapshot();
  raw.items[2] = rawVaultSite("pixiv", {
    state: "authorizing",
    oauth: {
      session_id: VAULT_SESSION_ID,
      state: "awaiting_login",
      created_at: 1_700_000_000,
      expires_at: 1_700_000_600,
      authorization_url: `https://app-api.pixiv.net/web/v1/login?state=${VAULT_FIXTURE_SECRET}`,
      message: `token=${VAULT_FIXTURE_SECRET}`,
      error: `/home/private/${VAULT_FIXTURE_SECRET}`,
    },
  });
  return raw;
}

function mutableVaultSnapshot(sanitized) {
  return {
    bySite: new Map(sanitized.bySite),
    browserProfile: sanitized.browserProfile,
    authorizationProxy: sanitized.authorizationProxy,
  };
}

test("VAULT sanitizer 严格丢弃 Cookie、Token、路径、完整 URL 与未知目标", () => {
  const sanitized = sanitizeVaultStatus(vaultSnapshotWithActivePixiv());
  assert.deepEqual([...sanitized.bySite.keys()], [
    "danbooru", "twitter", "pixiv", "exhentai", "pawchive",
  ]);
  assert.equal(sanitized.bySite.get("twitter").cookieCount, 2);
  assert.equal(sanitized.bySite.get("pixiv").session.active, true);
  assert.equal(sanitized.authorizationProxy.displayEndpoint, "HTTP · proxy.fixture.invalid:7890");
  assert.deepEqual(Object.keys(sanitized.authorizationProxy).sort(), [
    "browserRunning", "configured", "credentialsRedacted", "direct", "displayEndpoint",
    "restartPending", "scheme", "source", "updatedAt", "valid",
  ].sort());
  const serialized = JSON.stringify({
    sites: [...sanitized.bySite.values()],
    profile: sanitized.browserProfile,
    proxy: sanitized.authorizationProxy,
  });
  for (const forbidden of [
    VAULT_FIXTURE_SECRET,
    "authorization_url",
    "raw_cookie",
    "invalid_reason",
    "/home/private",
    "Bearer ",
    "?token=",
    "config_proxy_url",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.throws(
    () => sanitizeVaultStatus(rawVaultSnapshot({ secrets_exposed: true })),
    TypeError,
  );
  assert.throws(() => sanitizeVaultStatus([]), TypeError);
});

test("VAULT sanitizer 防御控制字符、超长值、错误枚举和伪装代理凭据", () => {
  const raw = rawVaultSnapshot();
  raw.items[1] = rawVaultSite("twitter", {
    method: "password",
    state: `authorized\u0000${VAULT_FIXTURE_SECRET}`,
    label: VAULT_FIXTURE_SECRET.repeat(20),
  });
  raw.authorization_proxy.proxy_url = `https://user:${VAULT_FIXTURE_SECRET}@proxy.invalid:443`;
  const sanitized = sanitizeVaultStatus(raw);
  assert.equal(sanitized.bySite.has("twitter"), false);
  assert.equal(sanitized.authorizationProxy.valid, false);
  assert.equal(sanitized.authorizationProxy.configured, false);
  assert.equal(JSON.stringify(sanitized.authorizationProxy).includes(VAULT_FIXTURE_SECRET), false);

  const fallback = sanitizeVaultSiteStatus(rawVaultSite("exhentai", {
    state: "remote_verified",
    updated_at: Number.POSITIVE_INFINITY,
    cookies: { present: true, valid: false, cookie_count: 999_999_999 },
    login: { session_id: VAULT_FIXTURE_SECRET, state: "awaiting_login" },
  }));
  assert.equal(fallback.state, "required");
  assert.equal(fallback.cookieCount, 100_000);
  assert.equal(fallback.updatedAt, null);
  assert.equal(fallback.session.active, false);
});

test("VAULT Store action 只接收安全投影并保持 selector 与其他 slice 隔离", () => {
  const store = createStore({ reportError: () => {} });
  let sitesNotifications = 0;
  let profileNotifications = 0;
  let proxyNotifications = 0;
  store.subscribe(selectors.authSites, () => { sitesNotifications += 1; });
  store.subscribe(selectors.authBrowserProfile, () => { profileNotifications += 1; });
  store.subscribe(selectors.authAuthorizationProxy, () => { proxyNotifications += 1; });

  const raw = rawVaultSnapshot();
  store.dispatch(actionCreators.authStatusReceived(raw));
  assert.deepEqual(
    [sitesNotifications, profileNotifications, proxyNotifications],
    [1, 1, 1],
  );
  raw.items[1].cookies.raw_cookie = "mutated-secret";
  const stored = store.getState().auth;
  assert.equal(JSON.stringify([...stored.bySite.values()]).includes(VAULT_FIXTURE_SECRET), false);
  assert.throws(() => stored.bySite.set("other", {}), TypeError);

  store.dispatch(actionCreators.startMenuChanged(true));
  assert.deepEqual(
    [sitesNotifications, profileNotifications, proxyNotifications],
    [1, 1, 1],
  );
  store.dispatch(actionCreators.authSiteStatusReceived(rawVaultSite("twitter", {
    state: "required",
    authorized: false,
    cookies: { present: false, valid: false, cookie_count: 0 },
  })));
  assert.deepEqual(
    [sitesNotifications, profileNotifications, proxyNotifications],
    [2, 1, 1],
  );
  assert.throws(
    () => store.dispatch({ type: "auth/statusReceived", payload: rawVaultSnapshot() }),
    TypeError,
  );
});

test("授权代理 payload builder 只产生当前字段并严格拒绝路径、query、控制字符和超长输入", () => {
  assert.deepEqual(buildAuthorizationProxyPayload(""), { proxy_url: "" });
  const secretProxy = `https://user:${VAULT_FIXTURE_SECRET}@proxy.fixture.invalid:8443`;
  const payload = buildAuthorizationProxyPayload(secretProxy);
  assert.deepEqual(Object.keys(payload), ["proxy_url"]);
  assert.equal(payload.proxy_url, secretProxy);
  assert.equal("old_secret" in payload, false);

  for (const invalid of [
    "/home/private/proxy.txt",
    "file:///home/private/proxy.txt",
    `https://proxy.invalid:443/path?token=${VAULT_FIXTURE_SECRET}`,
    `https://proxy.invalid:443#${VAULT_FIXTURE_SECRET}`,
    "http://proxy.invalid",
    "socks5://user:pass@proxy.invalid:1080",
    `http://proxy.invalid:8080\n${VAULT_FIXTURE_SECRET}`,
    `http://${"a".repeat(301)}:8080`,
  ]) {
    assert.equal(validateAuthorizationProxyInput(invalid).valid, false, invalid.slice(0, 60));
    assert.throws(() => buildAuthorizationProxyPayload(invalid), TypeError);
  }
  const validation = validateAuthorizationProxyInput(secretProxy);
  assert.deepEqual(validation, { valid: true, mode: "proxy", error: "" });
  assert.equal(JSON.stringify(validation).includes(VAULT_FIXTURE_SECRET), false);
  assert.throws(() => buildAuthorizationProxyPayload({ proxy_url: secretProxy }), TypeError);
});

test("VAULT 按钮矩阵覆盖未加载、公开目标、活动会话、配置材料与 busy", () => {
  const loaded = mutableVaultSnapshot(sanitizeVaultStatus(rawVaultSnapshot()));
  let controls = deriveVaultControls(loaded, { proxyInputValid: true });
  assert.equal(controls.sites.danbooru.showAuthorize, false);
  assert.equal(controls.sites.twitter.authorize.disabled, false);
  assert.equal(controls.sites.twitter.clear.disabled, false);
  assert.equal(controls.sites.twitter.showClear, true);
  assert.equal(controls.sites.exhentai.showClear, false);
  assert.equal(controls.profileClear.disabled, false);
  assert.equal(controls.proxySave.disabled, false);
  assert.equal(controls.proxyReset.disabled, false);

  controls = deriveVaultControls(loaded, { proxyInputValid: false });
  assert.equal(controls.proxySave.disabled, true);
  assert.match(controls.proxySave.reason, /修正/);

  const active = mutableVaultSnapshot(sanitizeVaultStatus(vaultSnapshotWithActivePixiv()));
  controls = deriveVaultControls(active);
  assert.equal(controls.sites.pixiv.showCancel, true);
  assert.equal(controls.sites.pixiv.cancel.disabled, false);
  assert.equal(controls.sites.twitter.authorize.disabled, true);
  assert.match(controls.sites.twitter.authorize.reason, /Pixiv/);
  assert.equal(controls.profileClear.disabled, true);

  controls = deriveVaultControls(active, { busy: "cancel:pixiv" });
  assert.equal(controls.sites.pixiv.cancel.label, "正在关闭…");
  assert.equal(controls.refresh.disabled, true);
  assert.equal(controls.proxySave.disabled, true);
});

test("VAULT 请求世代门阻止旧读取覆盖新读取、写后状态与新生命周期", () => {
  const gate = createVaultRequestGate();
  let visible = "初始状态";
  const apply = (ticket, value) => {
    if (gate.isReadCurrent(ticket)) visible = value;
  };

  const firstStatus = gate.beginRead("status");
  const session = gate.beginRead("session");
  assert.equal(gate.isReadCurrent(firstStatus), true);
  assert.equal(gate.isReadCurrent(session), true);

  const newestStatus = gate.beginRead("status");
  apply(newestStatus, "较新读取");
  apply(firstStatus, "过期读取");
  assert.equal(visible, "较新读取");
  assert.equal(gate.isReadCurrent(session), true, "独立会话通道不应被状态读取误伤");

  const preWrite = gate.beginRead("status");
  gate.beginWrite();
  apply(preWrite, "写前旧读取");
  assert.equal(visible, "较新读取");
  const postWrite = gate.beginRead("status");
  apply(postWrite, "写后读取");
  assert.equal(visible, "写后读取");

  gate.advanceLifecycle();
  apply(postWrite, "旧生命周期读取");
  assert.equal(visible, "写后读取");
  assert.equal(Object.isFrozen(postWrite), true);
  assert.throws(() => gate.beginRead("credentials"), /未知 VAULT 请求通道/);
});

test("VAULT formatter 与错误模型不采用绝对路径、URL 凭据、原始 details 或秘密文本", () => {
  const sanitized = sanitizeVaultStatus(vaultSnapshotWithActivePixiv());
  const site = formatVaultSite({
    ...sanitized.bySite.get("twitter"),
    summary: VAULT_FIXTURE_SECRET,
    path: `/home/${VAULT_FIXTURE_SECRET}`,
  });
  const proxy = formatAuthorizationProxy({
    ...sanitized.authorizationProxy,
    raw_url: `https://user:${VAULT_FIXTURE_SECRET}@private.invalid:443/path`,
  });
  const error = vaultErrorGuidance({
    code: "pixiv_oauth_exchange_failed",
    status: 409,
    message: `token=${VAULT_FIXTURE_SECRET}`,
    requestId: "vault-request-123",
    details: { path: `/home/${VAULT_FIXTURE_SECRET}`, cookie: VAULT_FIXTURE_SECRET },
  });
  const serialized = JSON.stringify({ site, proxy, error });
  assert.equal(serialized.includes(VAULT_FIXTURE_SECRET), false);
  assert.equal(serialized.includes("/home/"), false);
  assert.equal(serialized.includes("user:"), false);
  assert.equal(error.requestId, "vault-request-123");
  assert.match(error.nextStep, /重新授权/);
  assert.equal(vaultErrorGuidance({ status: 413 }).code, "request_failed");
  assert.match(vaultErrorGuidance({ status: 413 }).title, /请求过大/);
  assert.match(vaultErrorGuidance({ code: "network_error" }).nextStep, /手动刷新/);
});

test("VAULT 会话引用仅保留受控目标与 opaque id，不携带完整授权 URL", () => {
  const raw = vaultSnapshotWithActivePixiv();
  const reference = extractVaultSessionFromSnapshot(raw);
  assert.deepEqual(reference, {
    site: "pixiv",
    kind: "oauth",
    sessionId: VAULT_SESSION_ID,
  });
  assert.equal(JSON.stringify(reference).includes(VAULT_FIXTURE_SECRET), false);
  raw.items[2].oauth.session_id = `../${VAULT_FIXTURE_SECRET}`;
  assert.equal(extractVaultSessionFromSnapshot(raw), null);
});

test("VAULT 应用暴露完整生命周期、固定 auth 端点与单一授权轮询资源", () => {
  for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
    assert.equal(typeof vaultApplication[hook], "function");
  }
  assert.deepEqual(Object.values(VAULT_ENDPOINTS).sort(), [
    "/api/v1/auth",
    "/api/v1/auth/browser-profile",
    "/api/v1/auth/pixiv/oauth/session",
    "/api/v1/auth/pixiv/oauth/start",
    "/api/v1/auth/proxy",
  ].sort());
});

const POLICY_FIXTURE_SECRET = "policy-fixture-cookie-token-password-83b1";

function rawPolicy(overrides = {}) {
  return {
    max_concurrency: 20,
    retry_limit: 2,
    backoff_base_seconds: 2,
    proxy_mode: "prefer",
    probe_url: null,
    probe_before_use: false,
    node_tags: ["jp"],
    http_timeout: 30,
    gallery_retries: 2,
    task_timeout_seconds: 0,
    download_stall_timeout_seconds: 180,
    eh_download: null,
    extra_args: ["--no-mtime"],
    ...overrides,
  };
}

const POLICY_SOURCE_DEFINITIONS = [
  ["danbooru", "Danbooru", "anonymous"],
  ["twitter", "X / Twitter", "managed_browser"],
  ["pixiv", "Pixiv", "oauth"],
  ["exhentai", "EH", "managed_browser_for_private_content"],
  ["pawchive", "Pawchive", "anonymous"],
];

function rawPolicySnapshot(overrides = {}) {
  const policy = rawPolicy();
  return {
    response_profile: "policy",
    secrets_exposed: false,
    effect_scope: "new_requests_and_tasks",
    concurrency_protection: "none",
    default_source: "startup_snapshot",
    persistence: "sqlite_atomic",
    default: { editable: true, reason: "", policy },
    items: POLICY_SOURCE_DEFINITIONS.map(([site, label, authorization]) => ({
      site,
      label,
      supported: true,
      authorization,
      selection_mode: "per_request",
      availability: "not_probed",
      inherited: true,
      has_override: false,
      editable: true,
      reason: "",
      updated_at: null,
      policy: { ...policy, node_tags: [...policy.node_tags], extra_args: [...policy.extra_args] },
    })),
    unknown_override_count: 0,
    ...overrides,
  };
}

function serializedPolicySnapshot(snapshot) {
  return JSON.stringify({
    defaultPolicy: snapshot.defaultPolicy,
    sites: [...snapshot.bySite.values()],
    effectScope: snapshot.effectScope,
    unknownOverrideCount: snapshot.unknownOverrideCount,
  });
}

test("POLICY sanitizer 丢弃未知字段、未知来源、秘密、路径、危险 URL 与控制字符", () => {
  const raw = rawPolicySnapshot();
  raw.unknown_secret = POLICY_FIXTURE_SECRET;
  raw.default.policy.request_body = { token: POLICY_FIXTURE_SECRET };
  raw.items.push({
    site: "unknown",
    label: POLICY_FIXTURE_SECRET,
    policy: { path: `/home/${POLICY_FIXTURE_SECRET}` },
  });
  raw.items[1].policy = rawPolicy({
    probe_url: `https://user:${POLICY_FIXTURE_SECRET}@private.invalid/path?token=bad`,
    extra_args: [`--filter=token=${POLICY_FIXTURE_SECRET}`],
    node_tags: [`JP\u0000${POLICY_FIXTURE_SECRET}`],
    path: `/home/${POLICY_FIXTURE_SECRET}`,
  });
  const sanitized = sanitizePolicyResponse(raw);
  assert.deepEqual([...sanitized.bySite.keys()], [
    "danbooru", "twitter", "pixiv", "exhentai", "pawchive",
  ]);
  assert.equal(sanitized.bySite.get("twitter").editable, false);
  assert.equal(sanitized.bySite.get("twitter").policy, null);
  assert.equal(sanitized.unknownOverrideCount, 1);
  const serialized = serializedPolicySnapshot(sanitized);
  for (const forbidden of [
    POLICY_FIXTURE_SECRET,
    "unknown_secret",
    "request_body",
    "/home/",
    "user:",
    "?token=",
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  const polluted = JSON.parse(JSON.stringify(rawPolicySnapshot()).replace(
    '"response_profile":"policy"',
    `"__proto__":{"polluted":"${POLICY_FIXTURE_SECRET}"},"response_profile":"policy"`,
  ));
  assert.throws(() => sanitizePolicyResponse(polluted), TypeError);
  assert.equal({}.polluted, undefined);
  assert.throws(
    () => sanitizePolicyResponse(rawPolicySnapshot({ secrets_exposed: true })),
    TypeError,
  );
});

test("POLICY source 枚举固定，缺失或能力不匹配来源变为只读且不猜测", () => {
  const raw = rawPolicySnapshot();
  raw.items = raw.items.filter((item) => item.site !== "pawchive");
  raw.items.find((item) => item.site === "pixiv").authorization = "password";
  const sanitized = sanitizePolicyResponse(raw);
  assert.equal(sanitized.bySite.size, 5);
  assert.equal(sanitized.bySite.get("pawchive").editable, false);
  assert.equal(sanitized.bySite.get("pawchive").reason, "missing_source");
  assert.equal(sanitized.bySite.get("pixiv").editable, false);
  assert.equal(sanitized.bySite.get("pixiv").reason, "missing_source");
  assert.equal(sanitized.unknownOverrideCount, 1);
  assert.match(formatPolicySource(sanitized.bySite.get("exhentai")).authorization, /ExHentai/);
  assert.match(formatPolicySource(sanitized.bySite.get("danbooru")).enablement, /没有启用开关/);
});

test("POLICY 节点标签按后端语义 trim/lower/稳定去重，额外 argv 保序且保留重复", () => {
  const tags = normalizePolicyLines(" JP \n高速\njp\n  \n高速", "node_tags");
  assert.deepEqual(tags.items, ["jp", "高速"]);
  assert.equal(tags.duplicatesRemoved, 2);

  const args = normalizePolicyLines("--no-mtime\n  \n--filter=width>100\n--filter=width>100", "extra_args");
  assert.deepEqual(args.items, [
    "--no-mtime",
    "--filter=width>100",
    "--filter=width>100",
  ]);
  assert.equal(args.duplicatesRemoved, 0);

  for (const [kind, value, expectedReason] of [
    ["node_tags", `ok\n${"🐈".repeat(65)}`, "too_long"],
    ["node_tags", `ok\n/home/${POLICY_FIXTURE_SECRET}`, "absolute_path"],
    ["extra_args", `--foo\nhttps://private.invalid/?token=${POLICY_FIXTURE_SECRET}`, "url_not_allowed"],
    ["extra_args", `--foo\nftp://user:${POLICY_FIXTURE_SECRET}@private.invalid/file`, "url_not_allowed"],
    ["extra_args", `--foo\ntoken=${POLICY_FIXTURE_SECRET}`, "sensitive_assignment"],
    ["extra_args", "--foo\nbar\u0000baz", "control_characters"],
  ]) {
    assert.throws(
      () => normalizePolicyLines(value, kind),
      (error) => error.reason === expectedReason && !error.message.includes(POLICY_FIXTURE_SECRET),
    );
  }
});

test("POLICY payload builder 只包含完整 SitePolicy 白名单并覆盖真实边界", () => {
  const current = rawPolicy({
    eh_download: { image_mode: "original", gp_policy: "stop" },
  });
  const draft = policyConfigToDraft(current);
  Object.assign(draft, {
    max_concurrency: "128",
    retry_limit: "0",
    backoff_base_seconds: "0",
    proxy_mode: "required",
    probe_url: "https://example.com/health",
    probe_before_use: true,
    node_tags: "JP\njp\n高速",
    http_timeout: "1",
    gallery_retries: "50",
    task_timeout_seconds: "604800",
    download_stall_timeout_seconds: "0",
    extra_args: "--no-mtime\n--no-mtime",
    arbitrary: POLICY_FIXTURE_SECRET,
  });
  const payload = buildPolicyPayload(draft);
  assert.deepEqual(Object.keys(payload), [
    "max_concurrency", "retry_limit", "backoff_base_seconds", "proxy_mode",
    "probe_url", "probe_before_use", "node_tags", "http_timeout",
    "gallery_retries", "task_timeout_seconds", "download_stall_timeout_seconds",
    "eh_download", "extra_args",
  ]);
  assert.deepEqual(payload.node_tags, ["jp", "高速"]);
  assert.deepEqual(payload.extra_args, ["--no-mtime", "--no-mtime"]);
  assert.deepEqual(payload.eh_download, { image_mode: "original", gp_policy: "stop" });
  assert.equal(JSON.stringify(payload).includes(POLICY_FIXTURE_SECRET), false);

  for (const [changes, field, reason] of [
    [{ max_concurrency: "129" }, "max_concurrency", "out_of_range"],
    [{ retry_limit: "1.5" }, "retry_limit", "not_integer"],
    [{ proxy_mode: "auto" }, "proxy_mode", "invalid_enum"],
    [{ probe_url: `https://user:${POLICY_FIXTURE_SECRET}@example.com/` }, "probe_url", "url_credentials"],
    [{ probe_url: "https://example.com/?health=1" }, "probe_url", "url_query_or_fragment"],
    [{ probe_url: "https://127.0.0.1/" }, "probe_url", "url_target_forbidden"],
    [{ extra_args: Array(15).fill("猫".repeat(512)).join("\n") }, "policy", "request_too_large"],
  ]) {
    const validation = validatePolicyDraft({ ...draft, ...changes });
    assert.equal(validation.valid, false);
    assert.equal(validation.field, field);
    assert.equal(validation.reason, reason);
    assert.equal(validation.payload, null);
  }
});

test("POLICY dirty 比较基于规范化固定字段，不受键顺序、标签大小写或重复影响", () => {
  const current = rawPolicy({ node_tags: ["jp", "高速"] });
  const reordered = Object.fromEntries(Object.entries(current).reverse());
  assert.equal(policyConfigsEqual(current, reordered), true);
  const draft = policyConfigToDraft(current);
  draft.node_tags = "JP\n高速\njp";
  assert.equal(isPolicyDirty(current, draft), false);
  draft.http_timeout = "31";
  assert.equal(isPolicyDirty(current, draft), true);
  draft.http_timeout = "not-a-number";
  assert.equal(isPolicyDirty(current, draft), true);
});

test("POLICY 保存/重置/刷新/busy/只读/冲突按钮矩阵准确", () => {
  const item = sanitizePolicyResponse(rawPolicySnapshot()).bySite.get("pixiv");
  let controls = derivePolicyControls(item, { dirty: false, valid: true });
  assert.equal(controls.save.disabled, true);
  assert.equal(controls.reset.disabled, true);
  assert.equal(controls.refresh.disabled, false);
  assert.equal(controls.vault.disabled, false);

  controls = derivePolicyControls({ ...item, hasOverride: true, inherited: false }, {
    dirty: true,
    valid: true,
  });
  assert.equal(controls.save.disabled, false);
  assert.equal(controls.reset.disabled, false);
  assert.equal(controls.discard.disabled, false);

  controls = derivePolicyControls(item, { dirty: true, valid: false });
  assert.equal(controls.save.disabled, true);
  assert.match(controls.save.reason, /校验/);
  controls = derivePolicyControls(item, { dirty: true, valid: true, busy: "save" });
  assert.equal(Object.values(controls).every((control) => control.disabled), true);
  assert.equal(controls.save.label, "正在保存…");
  controls = derivePolicyControls(item, { dirty: true, valid: true, conflict: true });
  assert.equal(controls.save.disabled, true);
  assert.equal(controls.refresh.disabled, false);
  assert.match(controls.save.reason, /刷新/);

  const readOnly = { ...item, editable: false, policy: null, reason: "unsafe_stored_policy", hasOverride: true, inherited: false };
  controls = derivePolicyControls(readOnly, { dirty: false, valid: false });
  assert.equal(controls.save.disabled, true);
  assert.equal(controls.reset.disabled, false);
});

test("POLICY 安全错误映射只采用 field/index/reason/request id 白名单", () => {
  const error = {
    code: "invalid_policy",
    status: 422,
    requestId: "policy-request-123",
    message: `token=${POLICY_FIXTURE_SECRET}`,
    details: {
      field: "extra_args",
      index: 2,
      reason: "forbidden_gallery_arg",
      raw: `/home/${POLICY_FIXTURE_SECRET}`,
    },
  };
  const guidance = policyErrorGuidance(error);
  assert.equal(guidance.requestId, "policy-request-123");
  assert.match(guidance.detail, /第 3 行/);
  assert.match(guidance.detail, /forbidden_gallery_arg/);
  assert.equal(JSON.stringify(guidance).includes(POLICY_FIXTURE_SECRET), false);
  assert.equal(safePolicyErrorDetail({ details: { field: "secret", raw: POLICY_FIXTURE_SECRET } }), "");
  assert.match(policyErrorGuidance({ status: 413 }).title, /请求过大/);
  assert.equal(policyErrorGuidance({ status: 409 }).conflict, true);
  assert.match(policyErrorGuidance({ code: "network_error" }).nextStep, /手动刷新/);
});

test("POLICY Store action 二次投影、不可变且与 auth/proxy selector 隔离", () => {
  const store = createStore({ reportError: () => {} });
  let policyNotifications = 0;
  let authNotifications = 0;
  let proxyNotifications = 0;
  store.subscribe(selectors.policyConfig, () => { policyNotifications += 1; });
  store.subscribe(selectors.authSites, () => { authNotifications += 1; });
  store.subscribe(selectors.proxyStatus, () => { proxyNotifications += 1; });

  const raw = rawPolicySnapshot();
  store.dispatch(actionCreators.policyConfigReceived(raw));
  assert.deepEqual([policyNotifications, authNotifications, proxyNotifications], [1, 0, 0]);
  raw.items[0].policy.node_tags[0] = POLICY_FIXTURE_SECRET;
  const stored = store.getState().policy.config;
  assert.equal(serializedPolicySnapshot(stored).includes(POLICY_FIXTURE_SECRET), false);
  assert.throws(() => stored.bySite.set("unknown", {}), TypeError);
  assert.throws(() => stored.bySite.get("pixiv").policy.node_tags.push("x"), TypeError);

  store.dispatch(actionCreators.startMenuChanged(true));
  assert.deepEqual([policyNotifications, authNotifications, proxyNotifications], [1, 0, 0]);
  assert.throws(
    () => store.dispatch({ type: "policy/configReceived", payload: rawPolicySnapshot() }),
    TypeError,
  );
  const dangerous = JSON.parse('{"__proto__":{"polluted":true}}');
  assert.throws(
    () => store.dispatch({ type: "policy/configReceived", payload: dangerous }),
    /危险对象键/,
  );
  assert.equal({}.polluted, undefined);
});

test("POLICY 请求世代门阻止旧 GET 覆盖保存后状态与新生命周期", () => {
  const gate = createPolicyRequestGate();
  let visible = "初始";
  const apply = (ticket, value) => {
    if (gate.isReadCurrent(ticket)) visible = value;
  };
  const first = gate.beginRead();
  const second = gate.beginRead();
  apply(second, "较新读取");
  apply(first, "过期读取");
  assert.equal(visible, "较新读取");
  const beforeWrite = gate.beginRead();
  gate.beginWrite();
  apply(beforeWrite, "写前读取");
  assert.equal(visible, "较新读取");
  const afterWrite = gate.beginRead();
  apply(afterWrite, "写后权威读取");
  gate.advanceLifecycle();
  apply(afterWrite, "旧生命周期读取");
  assert.equal(visible, "写后权威读取");
});

test("POLICY 应用暴露完整生命周期、单一策略端点且没有轮询资源", () => {
  for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
    assert.equal(typeof policyApplication[hook], "function");
  }
  assert.deepEqual(POLICY_ENDPOINTS, {
    policies: "/api/v1/sites/policies",
  });
});

const WORKFLOW_SECRET = "workflow-token-cookie-secret-991425f1c4";

function rawSearchWorkflow() {
  return {
    keyword: "不应进入 Store 的查询",
    sources: [{
      site: "exhentai",
      status: "succeeded",
      evidence_count: 1,
      attempts: 1,
      auth: { state: "required", authorized: false, cookie: WORKFLOW_SECRET },
      addresses: [{
        id: "3079340",
        label: "安全画廊标题",
        address_type: "gallery",
        url: `https://e-hentai.org/g/3079340/${WORKFLOW_SECRET}/`,
        confidence: "site_search",
        thumbnail_url: "https://ehgt.org/w/cover.webp",
        metadata: {
          gallery_token: WORKFLOW_SECRET,
          tags: ["artist:fixture", "language:chinese"],
        },
      }],
      weak_evidence: [],
      tag_facets: [{
        namespace: "artist",
        label: "画师",
        gallery_count: 1,
        tags: [{ tag: "artist:fixture", count: 1 }],
      }],
      request_payload: { token: WORKFLOW_SECRET },
    }],
    related_profiles: [],
    raw: WORKFLOW_SECRET,
  };
}

test("CRAWL happy path 保持真实顺序与幂等提交，同时秘密地址只留在局部映射", () => {
  const projected = projectCrawlSearchResponse(rawSearchWorkflow());
  assert.equal(projected.snapshot.sources.length, 1);
  assert.equal(projected.snapshot.addressCount, 1);
  assert.equal(JSON.stringify(projected.snapshot).includes(WORKFLOW_SECRET), false);
  const candidate = projected.snapshot.sources[0].addresses[0];
  assert.match(candidate.displayEndpoint, /访问令牌已隐藏/);
  assert.equal(projected.operations.get(candidate.key).url.includes(WORKFLOW_SECRET), true);

  const store = createStore({ reportError: () => {} });
  store.dispatch(actionCreators.crawlSearchReceived(rawSearchWorkflow()));
  store.dispatch(actionCreators.crawlCandidateSelectionChanged(candidate.key, true));
  assert.equal(JSON.stringify(store.getState().crawl).includes(WORKFLOW_SECRET), false);
  const payload = buildCrawlPayload({
    snapshot: store.getState().crawl,
    operations: projected.operations,
    concurrency: 20,
    maxTasks: 10000,
    proxyMode: "required",
    ehDownload: { image_mode: "original", gp_policy: "stop" },
  });
  assert.deepEqual(Object.keys(payload), ["sources", "concurrency", "max_tasks", "proxy_mode"]);
  assert.equal(payload.sources[0].site, "exhentai");
  assert.equal(payload.sources[0].addresses[0].url.includes(WORKFLOW_SECRET), true);
  assert.deepEqual(payload.sources[0].eh_download, { image_mode: "original", gp_policy: "stop" });

  assert.deepEqual(buildSearchPayload({
    keyword: "fixture",
    sites: ["pixiv", "danbooru"],
    limit: 20,
    proxyMode: "prefer",
    sourceOptions: { pixiv: { proxy_mode: "direct" } },
  }), {
    keyword: "fixture",
    sites: ["danbooru", "pixiv"],
    limit: 20,
    proxy_mode: "prefer",
    source_options: { pixiv: { proxy_mode: "direct" } },
  });
  assert.equal(parseEhTag("a:Fixture").key, "artist:fixture");
  assert.equal(candidateMatchesEhFilter(candidate, new Map([["artist:fixture", "include"]])), true);
  assert.equal(candidateMatchesEhFilter(candidate, new Map([["language:english", "include"]])), false);
  assert.deepEqual(sanitizeAutocompleteResponse({
    items: [{ value: "fixture", label: "Fixture", category: "artist", token: WORKFLOW_SECRET }],
  }), [{ value: "fixture", label: "Fixture", category: "artist", antecedent: "", postCount: 0 }]);
  assert.deepEqual(CRAWL_ENDPOINTS, {
    search: "/api/v1/search",
    autocomplete: "/api/v1/search/autocomplete",
    crawls: "/api/v1/crawls",
  });
  for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
    assert.equal(typeof crawlApplication[hook], "function");
  }
});

function rawBatchWorkflow() {
  return {
    id: "batch-123",
    status: "running",
    output_dir: `/home/private/${WORKFLOW_SECRET}`,
    concurrency: 20,
    max_tasks: 10000,
    task_count: 2,
    succeeded_task_count: 1,
    failed_task_count: 0,
    cancelled_task_count: 0,
    sources: [{
      order: 0,
      site: "pixiv",
      status: "running",
      addresses: [{
        id: "address-1",
        address_order: 0,
        label: "画师作品",
        url: `https://example.invalid/?token=${WORKFLOW_SECRET}`,
        status: "running",
        planned_task_count: 2,
        succeeded_task_count: 1,
      }],
    }],
    current: { address_id: "address-1", site: "pixiv", status: "running" },
    review: null,
  };
}

test("TASKMGR happy path 安全投影任务并识别恢复入口", () => {
  const batch = sanitizeBatchDetail(rawBatchWorkflow());
  const page = sanitizeTaskPage({ items: [{
    id: "task-1",
    site: "pixiv",
    status: "failed",
    source_order: 0,
    address_order: 0,
    sequence_no: 1,
    attempt_count: 1,
    max_attempts: 3,
    url: `https://private.invalid/?token=${WORKFLOW_SECRET}`,
    output_dir: `/home/private/${WORKFLOW_SECRET}`,
    cookies_file: `/home/private/${WORKFLOW_SECRET}.txt`,
    error_class: "authentication",
    error_message: WORKFLOW_SECRET,
  }] }, batch.id);
  assert.equal(JSON.stringify({ batch, page }).includes(WORKFLOW_SECRET), false);
  assert.equal(shouldPollBatch(batch), true);
  assert.deepEqual(batchProgress(batch), { terminal: 1, total: 2, percent: 50 });
  assert.deepEqual(taskRecoveryTargets(page.tasks), { authSites: ["pixiv"], proxyIssue: false });
  assert.deepEqual(sanitizeRecentBatches({ items: [rawBatchWorkflow()] })[0].id, "batch-123");
  assert.deepEqual(TASKS_ENDPOINTS, { crawls: "/api/v1/crawls" });
  for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
    assert.equal(typeof tasksApplication[hook], "function");
  }
});

function rawReviewWorkflow() {
  return {
    batch_id: "batch-123",
    status: "ready",
    total_image_count: 2,
    total_group_count: 1,
    duplicate_group_count: 1,
    selected_image_count: 2,
    decided_group_count: 0,
    groups: {
      total: 1,
      offset: 0,
      limit: 8,
      items: [{
        id: "group-1",
        ordinal: 1,
        kind: "duplicate",
        decided: false,
        match_levels: ["L2"],
        images: [
          {
            id: "image-1",
            ordinal: 1,
            relative_path: `private/${WORKFLOW_SECRET}.jpg`,
            url: `/api/private?token=${WORKFLOW_SECRET}`,
            readable: true,
            recommended: true,
            selected: true,
            metadata: { w: 100, h: 100, format: "JPEG", size: 1024 },
          },
          {
            id: "image-2",
            ordinal: 2,
            relative_path: `/home/private/${WORKFLOW_SECRET}.jpg`,
            readable: true,
            recommended: false,
            selected: true,
            metadata: { w: 80, h: 80, format: "PNG", size: 512 },
          },
        ],
      }],
    },
    analysis_log_path: `/home/private/${WORKFLOW_SECRET}.log`,
  };
}

test("REVIEW happy path 分页投影、推荐选择和决策 payload 不暴露路径", () => {
  const page = sanitizeReviewPage(rawReviewWorkflow(), {
    batchId: "batch-123", filter: "", requestedOffset: 0,
  });
  assert.equal(JSON.stringify(page).includes(WORKFLOW_SECRET), false);
  assert.equal(JSON.stringify(page).includes("relative_path"), false);
  const recommended = setReviewPageMode(page, "recommended");
  const payload = buildReviewDecisionPayload(recommended);
  assert.deepEqual(payload, {
    groups: [{ group_id: "group-1", selected_image_ids: ["image-1"] }],
  });
  assert.equal(reviewImageUrl("batch-123", "image-1"), "/api/v1/crawls/batch-123/review/images/image-1");
  assert.deepEqual(REVIEW_ENDPOINTS, { crawls: "/api/v1/crawls" });
  for (const hook of ["mount", "activate", "beforeLeave", "deactivate", "unmount"]) {
    assert.equal(typeof reviewApplication[hook], "function");
  }
});

test("DIAG happy path 只保留能力、组件和计数白名单", () => {
  const config = {
    response_profile: "diagnostics",
    secrets_exposed: false,
    server: { loopback_only: true, cors_enabled: false, private_targets_enabled: false },
    gallery: { managed_auth_cache: true },
    proxy: { enabled: true, auto_start: false, transport_core_enabled: true },
    scheduler: { max_concurrent_tasks: 20 },
    dedup: { enabled: true, configured_device: "cpu", sscd_enabled: true, dino_enabled: false },
    path: `/home/private/${WORKFLOW_SECRET}`,
  };
  const scheduler = {
    response_profile: "diagnostics",
    secrets_exposed: false,
    tasks: { running: true, active: 2, max_concurrent: 20, active_site_count: 1, sites: { secret: WORKFLOW_SECRET } },
    ordered_crawls: { running: true, active_batches: 1, execution_order: "source_then_address", address_parallelism: "media_tasks" },
  };
  assert.equal(sanitizeDiagnosticsConfig(config).configuredDevice, "cpu");
  assert.equal(sanitizeDiagnosticsScheduler(scheduler).activeTasks, 2);
  const snapshot = buildDiagnosticsSnapshot({
    health: { connected: true, data: { ok: true, components: { process: { status: "ok" }, database: { status: "ok" } } } },
    readiness: { connected: true, data: { ready: true, components: {
      process: { status: "ok", summary: WORKFLOW_SECRET },
      database: { status: "ok", path: `/home/private/${WORKFLOW_SECRET}` },
      torch: { status: "ok", version: "2.0+cpu", configured_device: "cpu", actual_device: "cpu", cuda_available: false },
      scheduler: { status: "ok", details: { active: 2, max_concurrent: 20, raw: WORKFLOW_SECRET } },
    } } },
    config: { connected: true, data: config },
    scheduler: { connected: true, data: scheduler },
    checkedAt: 123,
  });
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes(WORKFLOW_SECRET), false);
  assert.equal(serialized.includes("/home/private"), false);
  assert.equal(diagnosticsCopyText(snapshot).includes(WORKFLOW_SECRET), false);
  assert.deepEqual(DIAGNOSTICS_ENDPOINTS, {
    health: "/healthz",
    readiness: "/readyz",
    config: "/api/v1/config?view=diagnostics",
    scheduler: "/api/v1/scheduler/status?view=diagnostics",
  });
  for (const hook of ["mount", "activate", "deactivate", "unmount"]) {
    assert.equal(typeof diagnosticsApplication[hook], "function");
  }
});
