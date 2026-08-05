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
import {
  createShellActions,
  WINDOW_LAYOUT_DEBOUNCE_MS,
} from "../gdl_backend/webui/js/core/actions.js";
import {
  applications,
  DEFAULT_ROUTE,
  getApplicationById,
} from "../gdl_backend/webui/js/core/app-registry.js";
import {
  createPollingManager,
  UNFOCUSED_POLL_MULTIPLIER,
} from "../gdl_backend/webui/js/core/polling.js";
import {
  createStorePollingFocusSource,
  POLLING_SCOPE_STATES,
} from "../gdl_backend/webui/js/core/polling-focus-source.js";
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
  DIAGNOSTICS_POLL_INTERVAL_MS,
  sanitizeDiagnosticsConfig,
  sanitizeDiagnosticsScheduler,
} from "../gdl_backend/webui/js/core/diagnostics-model.js";
import {
  buildPolicyPayload,
  createPolicyRequestGate,
  derivePolicyControls,
  formatPolicySource,
  isPolicyDirty,
  policyConfigToDraft,
  policyConfigsEqual,
  policyErrorGuidance,
  safePolicyErrorDetail,
  sanitizePolicyResponse,
  validatePolicyDraft,
} from "../gdl_backend/webui/js/core/policy-model.js";
import {
  buildReviewDecisionPayload,
  REVIEW_POLL_INTERVAL_MS,
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
  TASK_POLL_INTERVAL_MS,
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
  hashForRoute,
  parseHashRoute,
  resolveNavigationTarget,
} from "../gdl_backend/webui/js/core/router.js";
import {
  actionCreators,
  createInitialState,
  createStore,
  selectors,
  UnknownActionError,
} from "../gdl_backend/webui/js/core/store.js";
import {
  createMotionController,
  MOTION_MEDIA_QUERY,
} from "../gdl_backend/webui/js/core/motion.js";
import {
  createPersonalizationRuntime,
  PERSONALIZATION_RUNTIME_CLASS_MAPS,
  WALLPAPER_COLOR_CLASSES,
  WALLPAPER_CUSTOM_CLASS,
} from "../gdl_backend/webui/js/core/personalization.js";
import {
  BUILT_IN_WALLPAPER_COLORS,
  calculateSrgbRelativeLuminance,
  calculateThemeContrastRatio,
  copyPersonalizationPreferences,
  deriveInterfaceThemeTone,
  INTERFACE_THEME_DEFAULTS,
  INTERFACE_THEME_PREFERENCE_KEYS,
  INTERFACE_THEME_TONE_LUMINANCE_THRESHOLD,
  isValidInterfaceTheme,
  isValidPersonalizationPreferences,
  normalizePersonalizationPreferences,
  normalizeThemeHex,
  PERSONALIZATION_DEFAULTS,
  PERSONALIZATION_OPTIONS,
  personalizationPreferencesEqual,
  projectPersonalizationPreferences,
  restoreDefaultPersonalizationPreferences,
  WALLPAPER_IMAGE_LIMITS,
} from "../gdl_backend/webui/js/core/personalization-model.js";
import {
  calculateWallpaperOutputDimensions,
  hasSafeWallpaperOutputSignature,
  importWallpaperImage,
  validateWallpaperImageInput,
  WallpaperImageImportError,
} from "../gdl_backend/webui/js/core/wallpaper-image-import.js";
import {
  createWallpaperStorage,
  normalizeWallpaperStorageError,
  projectWallpaperImportResult,
  projectWallpaperRecord,
  WALLPAPER_STORAGE_SCHEMA,
  WallpaperStorageError,
} from "../gdl_backend/webui/js/core/wallpaper-storage.js";
import {
  clampRect,
  maximizedRect,
  nextRectForDrag,
  nextRectForResize,
} from "../gdl_backend/webui/js/core/window-geometry.js";
import { describeApplicationLaunchers } from "../gdl_backend/webui/js/core/desktop.js";
import { deriveWindowViews } from "../gdl_backend/webui/js/core/window-manager.js";
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
  SHELL_POLL_INTERVAL_MS,
  SHELL_POLL_SCOPE,
} from "../gdl_backend/webui/js/components/taskbar-summary.js";
import {
  _TASKBAR_VISIBLE_LIMIT,
  activateTaskbarWindow,
  deriveTaskbarWindowModel,
  describeTaskbarWindows,
} from "../gdl_backend/webui/js/components/taskbar-windows.js";
import { toSafeErrorViewModel } from "../gdl_backend/webui/js/components/error-view.js";
import { createSourceErrorWarning } from "../gdl_backend/webui/js/components/crawl-view.js";
import {
  createPersonalizationView,
  deriveMotionLimitationState,
  MOTION_LIMITATION_MESSAGE,
} from "../gdl_backend/webui/js/components/personalization-view.js";
import crawlApplication, {
  CRAWL_ENDPOINTS,
} from "../gdl_backend/webui/js/apps/crawl.js";
import diagnosticsApplication, {
  DIAGNOSTICS_ENDPOINTS,
} from "../gdl_backend/webui/js/apps/diagnostics.js";
import policyApplication, {
  POLICY_ENDPOINTS,
} from "../gdl_backend/webui/js/apps/policy.js";
import personalizationApplication from "../gdl_backend/webui/js/apps/personalization.js";
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

function windowRect(overrides = {}) {
  return { x: 48, y: 36, w: 720, h: 480, ...overrides };
}

function windowRecord(appId, windowState = "normal", rect = windowRect()) {
  return { appId, windowState, rect };
}

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
    this.setCalls = 0;
  }

  getItem(key) {
    if (this.throws) throw new Error("storage unavailable");
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.setCalls += 1;
    if (this.throws) throw new Error("storage unavailable");
    this.values.set(key, String(value));
  }

  removeItem(key) {
    if (this.throws) throw new Error("storage unavailable");
    this.values.delete(key);
  }
}

class FakeMediaQueryList {
  constructor(matches = false) {
    this.matches = matches;
    this.listeners = new Set();
  }

  addEventListener(type, listener) {
    if (type === "change") this.listeners.add(listener);
  }

  removeEventListener(type, listener) {
    if (type === "change") this.listeners.delete(listener);
  }

  setMatches(matches) {
    this.matches = matches;
    for (const listener of [...this.listeners]) listener({ matches });
  }
}

class FakeRootElement {
  constructor() {
    this.attributes = new Map();
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }
}

class FakeThemeRoot extends FakeRootElement {
  constructor() {
    super();
    this.attributes.set("data-theme-tone", "light");
    this.properties = new Map();
    this.operations = [];
    this.failure = null;
    this.style = Object.freeze({
      getPropertyValue: (name) => this.properties.get(name) ?? "",
      setProperty: (name, value) => {
        if (name !== "--imageweave-accent" && name !== "--imageweave-surface") {
          throw new Error("unexpected theme property");
        }
        const normalized = String(value);
        this.properties.set(name, normalized);
        this.operations.push(["setProperty", name, normalized]);
        this.maybeFail(`setProperty:${name}`);
      },
      removeProperty: (name) => {
        const previous = this.properties.get(name) ?? "";
        this.properties.delete(name);
        this.operations.push(["removeProperty", name]);
        this.maybeFail(`removeProperty:${name}`);
        return previous;
      },
    });
  }

  maybeFail(operation) {
    if (this.failure !== operation) return;
    this.failure = null;
    throw new Error("theme setter fixture failure");
  }

  failNext(operation) {
    this.failure = operation;
  }

  setAttribute(name, value) {
    if (name !== "data-theme-tone") throw new Error("unexpected theme attribute");
    const normalized = String(value);
    this.attributes.set(name, normalized);
    this.operations.push(["setAttribute", name, normalized]);
    this.maybeFail(`setAttribute:${name}`);
  }

  removeAttribute(name) {
    if (name !== "data-theme-tone") throw new Error("unexpected theme attribute");
    this.attributes.delete(name);
    this.operations.push(["removeAttribute", name]);
    this.maybeFail(`removeAttribute:${name}`);
  }

  snapshot() {
    return Object.freeze({
      themeAccent: this.properties.get("--imageweave-accent") ?? "",
      themeSurface: this.properties.get("--imageweave-surface") ?? "",
      tone: this.getAttribute("data-theme-tone"),
    });
  }
}

class FakeClassList {
  constructor(values = []) {
    this.values = new Set(values);
    this.operations = [];
  }

  toggle(name, force) {
    this.operations.push([name, force === true]);
    if (force) this.values.add(name);
    else this.values.delete(name);
    return this.values.has(name);
  }

  contains(name) {
    return this.values.has(name);
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

class FakeFocusSource {
  constructor({ focusedScope = null, scopeStates = {} } = {}) {
    this.focusedScope = focusedScope;
    this.scopeStates = new Map(Object.entries(scopeStates));
    this.listeners = new Set();
  }

  getFocusedScope = () => this.focusedScope;

  getScopeState = (scope) => {
    if (!scope.startsWith("app:")) return POLLING_SCOPE_STATES.UNMANAGED;
    return this.scopeStates.get(scope) ?? POLLING_SCOPE_STATES.CLOSED;
  };

  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  update({ focusedScope = this.focusedScope, scopeStates = {} } = {}) {
    this.focusedScope = focusedScope;
    for (const [scope, state] of Object.entries(scopeStates)) {
      this.scopeStates.set(scope, state);
    }
    for (const listener of [...this.listeners]) listener();
  }
}

class FakeTimers {
  constructor() {
    this.now = 0;
    this.sequence = 0;
    this.jobs = new Map();
    this.cleared = [];
  }

  setTimeout = (callback, delay) => {
    this.sequence += 1;
    this.jobs.set(this.sequence, { callback, due: this.now + delay });
    return this.sequence;
  };

  clearTimeout = (id) => {
    this.cleared.push(id);
    this.jobs.delete(id);
  };

  advanceBy(duration) {
    const target = this.now + duration;
    while (true) {
      const next = [...this.jobs.entries()].sort((left, right) =>
        left[1].due - right[1].due || left[0] - right[0])[0];
      if (!next || next[1].due > target) break;
      const [id, job] = next;
      this.jobs.delete(id);
      this.now = job.due;
      job.callback();
    }
    this.now = target;
  }

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

const PNG_SIGNATURE_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
]);
const JPEG_SIGNATURE_BYTES = Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE0]);
const GIF_SIGNATURE_BYTES = new TextEncoder().encode("GIF89a");

function webpSignatureBytes({ animated = false } = {}) {
  const bytes = new Uint8Array(32);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  const riffSize = bytes.length - 8;
  bytes.set([
    riffSize & 0xFF,
    (riffSize >>> 8) & 0xFF,
    (riffSize >>> 16) & 0xFF,
    (riffSize >>> 24) & 0xFF,
  ], 4);
  bytes.set(new TextEncoder().encode("WEBPVP8X"), 8);
  bytes[20] = animated ? 0x02 : 0;
  return bytes;
}

function localImageFile(bytes, { name, type, size = bytes.byteLength }) {
  const blob = new Blob([bytes], { type });
  return Object.freeze({
    name,
    type,
    size,
    slice(start, end) {
      return blob.slice(start, end);
    },
  });
}

function importedWallpaperFixture(seed, { width = 640, height = 360 } = {}) {
  const blob = new Blob([PNG_SIGNATURE_BYTES, Uint8Array.of(seed)], {
    type: "image/png",
  });
  return Object.freeze({
    image: Object.freeze({
      blob,
      mediaType: "image/png",
      width,
      height,
      version: 1,
    }),
    warning: null,
  });
}

function storedWallpaperFixture(imported, updatedAt = 1_700_000_000_000) {
  return Object.freeze({
    ...imported.image,
    updatedAt,
  });
}

function createWallpaperRepositoryFixture(initialRecord = null) {
  let record = initialRecord;
  let updatedAt = 1_700_000_000_100;
  const calls = {
    read: 0,
    snapshot: 0,
    replace: 0,
    restore: 0,
    remove: 0,
  };
  const repository = Object.freeze({
    async read() {
      calls.read += 1;
      return record;
    },
    async snapshot() {
      calls.snapshot += 1;
      return record;
    },
    async replace(image) {
      calls.replace += 1;
      record = Object.freeze({ ...image, updatedAt });
      updatedAt += 1;
      return record;
    },
    async restore(snapshot) {
      calls.restore += 1;
      record = snapshot;
      return record;
    },
    async remove() {
      calls.remove += 1;
      record = null;
      return true;
    },
  });
  return Object.freeze({
    repository,
    calls,
    current: () => record,
  });
}

function createPersonalizationStorageFixture(initialPreferences) {
  let preferences = { ...initialPreferences };
  let writesAllowed = true;
  const writes = [];
  const service = Object.freeze({
    readUiPreferences() {
      return { ...preferences };
    },
    writePersonalizationPreferences(next) {
      writes.push({ ...next });
      if (!writesAllowed) return false;
      preferences = { ...next };
      return true;
    },
  });
  return Object.freeze({
    service,
    writes,
    current: () => ({ ...preferences }),
    setWritesAllowed(value) {
      writesAllowed = value === true;
    },
  });
}

function createWallpaperSurfaceFixture({ onSourceChange = null } = {}) {
  let source = "";
  let backgroundImage = "";
  let sequence = 0;
  const created = [];
  const revoked = [];
  const events = [];
  const calls = {
    clearImageSource: 0,
    clearBackgroundImage: 0,
  };
  const style = {
    setProperty(name, value) {
      if (name !== "background-image") throw new Error("unexpected style property");
      backgroundImage = String(value);
      events.push(["set-background", backgroundImage]);
    },
    removeProperty(name) {
      if (name !== "background-image") throw new Error("unexpected style property");
      calls.clearBackgroundImage += 1;
      if (backgroundImage) events.push(["clear-background", backgroundImage]);
      backgroundImage = "";
    },
    get backgroundImage() {
      return backgroundImage;
    },
    set backgroundImage(value) {
      backgroundImage = String(value);
    },
  };
  const image = {
    hidden: true,
    style,
    get src() {
      return source;
    },
    set src(value) {
      source = String(value);
      events.push(["set-src", source]);
      onSourceChange?.(source);
    },
    removeAttribute(name) {
      if (name === "src") {
        calls.clearImageSource += 1;
        if (source) events.push(["clear-src", source]);
        source = "";
      }
    },
  };
  const mask = { hidden: true };
  const wallpaper = {
    classList: new FakeClassList(),
    querySelector(selector) {
      return selector === "[data-desktop-wallpaper-mask]" ? mask : null;
    },
  };
  const windowLayer = { classList: new FakeClassList() };
  const urlApi = Object.freeze({
    createObjectURL(blob) {
      sequence += 1;
      const url = `blob:wallpaper-fixture/${sequence}`;
      created.push({ url, blob });
      return url;
    },
    revokeObjectURL(url) {
      revoked.push(url);
      events.push(["revoke", url]);
    },
  });
  return Object.freeze({
    wallpaper,
    image,
    mask,
    windowLayer,
    urlApi,
    created,
    revoked,
    events,
    calls,
  });
}

function stateContainsPrivateImageValue(value, seen = new Set()) {
  if (typeof Blob === "function" && value instanceof Blob) return true;
  if (typeof value === "string" && value.startsWith("blob:")) return true;
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value).some((item) => stateContainsPrivateImageValue(item, seen));
}

function createFakePolling(options = {}) {
  const timers = new FakeTimers();
  const visibility = options.visibility || new FakeVisibility();
  const errors = [];
  const manager = createPollingManager({
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
    visibilitySource: visibility,
    focusSource: options.focusSource || null,
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
  let focusNotifications = 0;
  store.subscribe(selectors.focusedAppId, () => { focusNotifications += 1; });
  store.dispatch(actionCreators.startMenuChanged(true));
  assert.equal(focusNotifications, 0);
  store.dispatch(actionCreators.windowOpened("review"));
  assert.equal(focusNotifications, 1);
  assert.equal(store.getState().ui.focusedAppId, "review");
  assert.deepEqual(store.getState().ui.windows.map((item) => ({
    appId: item.appId,
    windowState: item.windowState,
  })), [{ appId: "review", windowState: "maximized" }]);
  assert.throws(
    () => store.dispatch(actionCreators.windowStateChanged("review", "invisible")),
    TypeError,
  );
  assert.throws(() => store.dispatch({ type: "unknown/action" }), UnknownActionError);
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
    assert.throws(() => { store.getState().ui.focusedAppId = "proxy"; }, TypeError);
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

test("跨应用 action 先调用 router，只有路由结果才能更新 focusedAppId", () => {
  const store = createStore({ reportError: () => {} });
  const navigations = [];
  const writes = [];
  const storage = {
    writeCurrentApp: (appId) => writes.push(["app", appId]),
    writeWindowLayout: (windows) => writes.push([
      "layout",
      windows.map((item) => ({
        appId: item.appId,
        windowState: item.windowState,
        rect: { ...item.rect },
      })),
    ]),
    writeActiveBatchId: (batchId) => writes.push(["batch", batchId]),
    clearActiveBatchId: () => writes.push(["batch-clear"]),
  };
  const timers = new FakeTimers();
  const actions = createShellActions({
    store,
    router: { navigate: (target) => navigations.push(target) },
    storage,
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
  });

  actions.navigateToApp("review");
  assert.deepEqual(navigations, ["review"]);
  assert.equal(store.getState().ui.focusedAppId, null);
  actions.routeResolved(getApplicationById("review"));
  assert.equal(store.getState().ui.focusedAppId, "review");
  assert.equal(store.getState().ui.windows[0].windowState, "maximized");
  actions.toggleWindowMaximized("review");
  assert.equal(store.getState().ui.windows[0].windowState, "normal");
  actions.minimizeWindow("review");
  assert.equal(store.getState().ui.focusedAppId, null);
  assert.deepEqual(navigations, ["review"], "无聚焦窗口时不得触发路由重开");
  actions.restoreWindow("review");
  assert.equal(store.getState().ui.focusedAppId, "review");
  assert.deepEqual(navigations, ["review", "review"]);
  assert.equal(WINDOW_LAYOUT_DEBOUNCE_MS >= 300, true);
  assert.deepEqual(timers.delays(), [WINDOW_LAYOUT_DEBOUNCE_MS]);
  assert.deepEqual(writes.map((entry) => entry[0]), ["app", "app"]);
  timers.runNext();
  assert.deepEqual(writes.map((entry) => entry[0]), ["app", "app", "layout"]);
  assert.deepEqual(writes.at(-1)[1].map((item) => item.windowState), ["normal"]);
  actions.destroy();
});

test("windowOpened 重复打开同一 appId 不会产生第二个窗口", () => {
  const store = createStore({ reportError: () => {} });
  store.dispatch(actionCreators.windowOpened("review"));
  const first = selectors.windowStack(store.getState())[0];
  store.dispatch(actionCreators.windowOpened("review"));
  const windows = selectors.windowStack(store.getState());
  assert.equal(windows.length, 1);
  assert.equal(windows[0].appId, "review");
  assert.deepEqual(windows[0].rect, first.rect);
  assert.equal("zIndex" in windows[0], false);
});

test("windowOpened 已存在时会提到栈顶且从 minimized 恢复", () => {
  const store = createStore({ reportError: () => {} });
  store.dispatch(actionCreators.windowOpened("crawl"));
  store.dispatch(actionCreators.windowOpened("review"));
  store.dispatch(actionCreators.windowStateChanged("crawl", "minimized"));
  store.dispatch(actionCreators.windowOpened("crawl"));
  assert.deepEqual(
    selectors.windowStack(store.getState()).map((item) => [item.appId, item.windowState]),
    [["review", "maximized"], ["crawl", "normal"]],
  );
  assert.equal(store.getState().ui.focusedAppId, "crawl");
});

test("focusedAppId 始终为栈顶非 minimized 窗口", () => {
  const tamperedInitial = createInitialState({
    windows: [windowRecord("crawl"), windowRecord("tasks", "minimized")],
  });
  tamperedInitial.ui.focusedAppId = "tasks";
  const normalizedStore = createStore({
    initialState: tamperedInitial,
    reportError: () => {},
  });
  assert.equal(normalizedStore.getState().ui.focusedAppId, "crawl");

  const store = createStore({ reportError: () => {} });
  const assertDerivedFocus = () => {
    const windows = selectors.windowStack(store.getState());
    const expected = [...windows].reverse()
      .find((item) => item.windowState !== "minimized")?.appId ?? null;
    assert.equal(store.getState().ui.focusedAppId, expected);
  };

  for (const appId of ["crawl", "tasks", "review"]) {
    store.dispatch(actionCreators.windowOpened(appId));
    assertDerivedFocus();
  }
  store.dispatch(actionCreators.windowStateChanged("review", "minimized"));
  assertDerivedFocus();
  store.dispatch(actionCreators.windowFocused("crawl"));
  assert.deepEqual(
    selectors.windowStack(store.getState()).map((item) => item.appId),
    ["tasks", "review", "crawl"],
  );
  assertDerivedFocus();
  store.dispatch(actionCreators.windowStateChanged("crawl", "minimized"));
  assertDerivedFocus();
  store.dispatch(actionCreators.startMenuChanged(true));
  assertDerivedFocus();
});

test("全部 minimized 时 focusedAppId 为 null 且兼容视图仍可恢复", () => {
  const store = createStore({ reportError: () => {} });
  store.dispatch(actionCreators.windowOpened("crawl"));
  store.dispatch(actionCreators.windowOpened("tasks"));
  store.dispatch(actionCreators.windowStateChanged("crawl", "minimized"));
  store.dispatch(actionCreators.windowStateChanged("tasks", "minimized"));
  assert.equal(store.getState().ui.focusedAppId, null);
  assert.deepEqual(selectors.windowView(store.getState()), {
    appId: "tasks",
    windowState: "normal",
    visibility: "minimized",
  });
});

test("windowClosed 后聚焦回落到新栈顶", () => {
  const store = createStore({ reportError: () => {} });
  store.dispatch(actionCreators.windowOpened("crawl"));
  store.dispatch(actionCreators.windowOpened("tasks"));
  store.dispatch(actionCreators.windowOpened("review"));
  store.dispatch(actionCreators.windowClosed("review"));
  assert.equal(store.getState().ui.focusedAppId, "tasks");
  store.dispatch(actionCreators.windowClosed("tasks"));
  assert.equal(store.getState().ui.focusedAppId, "crawl");
  store.dispatch(actionCreators.windowClosed("crawl"));
  assert.equal(store.getState().ui.focusedAppId, null);
  assert.deepEqual(selectors.windowStack(store.getState()), []);
});

test("窗口 actions 对非法 state、rect 与未知 appId 均抛 TypeError", () => {
  const store = createStore({ reportError: () => {} });
  store.dispatch(actionCreators.windowOpened("crawl"));
  const unknownActions = [
    actionCreators.windowOpened("unknown"),
    actionCreators.windowClosed("unknown"),
    actionCreators.windowFocused("unknown"),
    actionCreators.windowMoved("unknown", windowRect()),
    actionCreators.windowStateChanged("unknown", "normal"),
  ];
  for (const action of unknownActions) {
    assert.throws(() => store.dispatch(action), TypeError);
  }
  for (const windowState of ["open", "closed", "MINIMIZED", null]) {
    assert.throws(
      () => store.dispatch(actionCreators.windowStateChanged("crawl", windowState)),
      TypeError,
    );
  }
  for (const rect of [
    null,
    { x: 0, y: 0, w: 720 },
    { x: 0, y: 0, w: 720, h: 480, url: "https://example.invalid/layout" },
    windowRect({ x: Number.NaN }),
    windowRect({ y: Number.POSITIVE_INFINITY }),
    windowRect({ w: "720" }),
  ]) {
    assert.throws(
      () => store.dispatch(actionCreators.windowMoved("crawl", rect)),
      TypeError,
    );
  }
});

test("窗口 rect 小于最小尺寸时抛 TypeError", () => {
  const store = createStore({ reportError: () => {} });
  store.dispatch(actionCreators.windowOpened("crawl"));
  for (const rect of [windowRect({ w: 359 }), windowRect({ h: 239 })]) {
    assert.throws(
      () => store.dispatch(actionCreators.windowMoved("crawl", rect)),
      TypeError,
    );
  }
  store.dispatch(actionCreators.windowMoved("crawl", windowRect({ w: 360, h: 240 })));
  assert.deepEqual(store.getState().ui.windows[0].rect, windowRect({ w: 360, h: 240 }));
});

test("clampRect 在四个视口边缘都保留至少 32px 可见区域", () => {
  const viewport = { width: 1000, height: 700 };
  const options = { minW: 360, minH: 240, taskbarHeight: 40 };
  const topLeft = clampRect(
    { x: -5000, y: -5000, w: 720, h: 480 },
    viewport,
    options,
  );
  assert.deepEqual(topLeft, { x: -688, y: -448, w: 720, h: 480 });
  assert.equal(topLeft.x + topLeft.w, 32);
  assert.equal(topLeft.y + topLeft.h, 32);

  const bottomRight = clampRect(
    { x: 5000, y: 5000, w: 720, h: 480 },
    viewport,
    options,
  );
  assert.deepEqual(bottomRight, { x: 968, y: 180, w: 720, h: 480 });
  assert.equal(viewport.width - bottomRight.x, 32);
});

test("clampRect 与 maximizedRect 始终停在任务栏可用区上方", () => {
  const viewport = { width: 1024, height: 768 };
  const options = { minW: 360, minH: 240, taskbarHeight: 48 };
  const normal = clampRect(
    { x: 20, y: 700, w: 640, h: 400 },
    viewport,
    options,
  );
  assert.equal(normal.y + normal.h, 720);
  assert.deepEqual(maximizedRect(viewport, options), {
    x: 0,
    y: 0,
    w: 1024,
    h: 720,
  });
});

test("resize 遵守 360x240 最小尺寸且 drag 在边缘 clamp", () => {
  const viewport = { width: 1000, height: 700 };
  const options = { minW: 360, minH: 240, taskbarHeight: 40 };
  assert.deepEqual(nextRectForResize(
    { x: 100, y: 80, w: 500, h: 300 },
    { x: -1000, y: -1000 },
    viewport,
    options,
  ), { x: 100, y: 80, w: 360, h: 240 });
  assert.deepEqual(nextRectForDrag(
    { x: 100, y: 80, w: 500, h: 300 },
    { x: 5000, y: 5000 },
    viewport,
    options,
  ), { x: 968, y: 360, w: 500, h: 300 });
});

test("窗口几何严格拒绝未知字段、访问器与非有限数字", () => {
  assert.throws(() => clampRect(
    { x: 0, y: 0, w: 500, h: 300, zIndex: 1 },
    { width: 1000, height: 700 },
  ), TypeError);
  assert.throws(() => nextRectForDrag(
    { x: 0, y: 0, w: 500, h: 300 },
    { x: Number.NaN, y: 0 },
    { width: 1000, height: 700 },
  ), TypeError);
  const accessor = { x: 0, y: 0, w: 500 };
  Object.defineProperty(accessor, "h", { enumerable: true, get: () => 300 });
  assert.throws(() => clampRect(accessor, { width: 1000, height: 700 }), TypeError);
});

test("maximized 只改变窗口状态，恢复后保留最大化前 rect", () => {
  const rect = windowRect({ x: 91, y: 73, w: 640, h: 420 });
  const store = createStore({
    initialState: createInitialState({ windows: [windowRecord("crawl", "normal", rect)] }),
    reportError: () => {},
  });
  store.dispatch(actionCreators.windowStateChanged("crawl", "maximized"));
  assert.deepEqual(store.getState().ui.windows[0].rect, rect);
  store.dispatch(actionCreators.windowStateChanged("crawl", "normal"));
  assert.deepEqual(store.getState().ui.windows[0], windowRecord("crawl", "normal", rect));
});

test("布局防抖在交互期间不写 storage，destroy 会落定最终 rect", () => {
  const store = createStore({
    initialState: createInitialState({ windows: [windowRecord("crawl")] }),
    reportError: () => {},
  });
  const timers = new FakeTimers();
  const layouts = [];
  const actions = createShellActions({
    store,
    router: { navigate() {} },
    storage: {
      writeCurrentApp() {},
      writeWindowLayout(windows) {
        layouts.push(windows.map((record) => ({ ...record, rect: { ...record.rect } })));
      },
      writeActiveBatchId() {},
      clearActiveBatchId() {},
    },
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
  });
  actions.beginWindowInteraction();
  const finalRect = windowRect({ x: 144, y: 96, w: 800, h: 520 });
  actions.moveWindow("crawl", finalRect);
  assert.equal(layouts.length, 0);
  assert.equal(timers.jobs.size, 0);
  actions.endWindowInteraction();
  assert.deepEqual(timers.delays(), [WINDOW_LAYOUT_DEBOUNCE_MS]);
  actions.destroy();
  assert.equal(timers.jobs.size, 0);
  assert.equal(layouts.length, 1);
  assert.deepEqual(layouts[0][0].rect, finalRect);
});

test("布局防抖从最后一次变化重新计算完整 300ms 静默期", () => {
  const store = createStore({
    initialState: createInitialState({ windows: [windowRecord("crawl")] }),
    reportError: () => {},
  });
  const timers = new FakeTimers();
  const layouts = [];
  const actions = createShellActions({
    store,
    router: { navigate() {} },
    storage: {
      writeCurrentApp() {},
      writeWindowLayout(windows) {
        layouts.push(windows.map((record) => ({ ...record, rect: { ...record.rect } })));
      },
      writeActiveBatchId() {},
      clearActiveBatchId() {},
    },
    setTimeoutFn: timers.setTimeout,
    clearTimeoutFn: timers.clearTimeout,
  });

  const firstRect = windowRect({ x: 80, y: 64, w: 760, h: 500 });
  const latestRect = windowRect({ x: 112, y: 88, w: 784, h: 512 });
  assert.equal(actions.moveWindow("crawl", firstRect), true);
  const firstJobId = timers.sequence;
  assert.equal(timers.jobs.get(firstJobId).due, WINDOW_LAYOUT_DEBOUNCE_MS);

  timers.advanceBy(250);
  assert.equal(layouts.length, 0);
  assert.equal(actions.moveWindow("crawl", latestRect), true);
  const latestJobId = timers.sequence;
  assert.notEqual(latestJobId, firstJobId);
  assert.deepEqual(timers.cleared, [firstJobId], "第二次变化必须清除旧 job");
  assert.equal(timers.jobs.has(firstJobId), false);
  assert.deepEqual(timers.delays(), [WINDOW_LAYOUT_DEBOUNCE_MS]);

  timers.advanceBy(WINDOW_LAYOUT_DEBOUNCE_MS - 250);
  assert.equal(timers.now, WINDOW_LAYOUT_DEBOUNCE_MS);
  assert.equal(layouts.length, 0, "旧 deadline 不得写入 storage");
  assert.deepEqual(timers.delays(), [250]);
  timers.advanceBy(249);
  assert.equal(layouts.length, 0);
  timers.advanceBy(1);
  assert.equal(layouts.length, 1);
  assert.deepEqual(layouts[0][0].rect, latestRect);
  assert.equal(timers.jobs.size, 0);

  timers.advanceBy(WINDOW_LAYOUT_DEBOUNCE_MS);
  assert.equal(layouts.length, 1, "最终只允许写入一次最新布局");
  actions.destroy();
  assert.equal(layouts.length, 1);
});

test("selectors.windowView 保持旧形状且 hash 只包含单个聚焦应用", () => {
  const store = createStore({ reportError: () => {} });
  assert.deepEqual(selectors.windowView(store.getState()), {
    appId: null,
    windowState: "normal",
    visibility: "closed",
  });
  store.dispatch(actionCreators.windowOpened("review"));
  assert.deepEqual(selectors.windowView(store.getState()), {
    appId: "review",
    windowState: "maximized",
    visibility: "open",
  });
  assert.deepEqual(Object.keys(selectors.windowView(store.getState())), [
    "appId", "windowState", "visibility",
  ]);
  assert.equal(selectors.windowStack(store.getState()), store.getState().ui.windows);
  assert.equal(hashForRoute(resolveNavigationTarget("review")), "#/review");
  assert.equal(hashForRoute(resolveNavigationTarget("review")).includes("?"), false);
  assert.equal(parseHashRoute("#/review?windows=crawl"), "/crawl");
});

test("每个已开窗口产生一个使用中文 label 的任务栏按钮描述", () => {
  const stack = [
    windowRecord("crawl"),
    windowRecord("tasks"),
    windowRecord("review", "maximized"),
  ];
  const descriptions = describeTaskbarWindows(stack, "review");
  assert.equal(descriptions.length, stack.length);
  assert.deepEqual(
    descriptions.map((item) => [item.appId, item.label, item.title]),
    stack.map((record) => {
      const app = getApplicationById(record.appId);
      return [record.appId, app.label, app.windowTitle];
    }),
  );
  assert.equal(descriptions[0].label, "图片采集");
  assert.notEqual(descriptions[0].label, descriptions[0].title);
});

test("聚焦窗口任务栏按钮 aria-pressed 为 true 且其他为 false", () => {
  const descriptions = describeTaskbarWindows([
    windowRecord("crawl"),
    windowRecord("review", "maximized"),
    windowRecord("tasks"),
  ], "tasks");
  assert.deepEqual(
    descriptions.map((item) => [item.appId, item.ariaPressed]),
    [["crawl", "false"], ["review", "false"], ["tasks", "true"]],
  );
});

test("minimized 窗口任务栏按钮描述带最小化标记", () => {
  const descriptions = describeTaskbarWindows([
    windowRecord("crawl", "minimized"),
    windowRecord("tasks"),
  ], "tasks");
  assert.equal(descriptions[0].minimized, true);
  assert.equal(descriptions[0].ariaPressed, "false");
  assert.equal(descriptions[1].minimized, false);
});

test("超过六个窗口时严格前六个可见且其余进入任务栏溢出列表", () => {
  const readyIds = applications
    .filter((app) => app.availability === "ready")
    .map((app) => app.id);
  const model = deriveTaskbarWindowModel(
    readyIds.map((appId) => windowRecord(appId)),
    readyIds.at(-1),
  );
  assert.equal(_TASKBAR_VISIBLE_LIMIT, 6);
  assert.equal(model.buttons.length, readyIds.length);
  assert.deepEqual(model.visible.map((item) => item.appId), readyIds.slice(0, 6));
  assert.deepEqual(model.overflow.map((item) => item.appId), readyIds.slice(6));
});

test("任务栏按钮意图区分已聚焦最小化与非聚焦恢复后聚焦", () => {
  const descriptions = describeTaskbarWindows([
    windowRecord("crawl"),
    windowRecord("tasks", "minimized"),
    windowRecord("review", "maximized"),
  ], "review");
  assert.deepEqual(
    descriptions.map((item) => [item.appId, item.activation]),
    [["crawl", "focus"], ["tasks", "restore"], ["review", "minimize"]],
  );
});

test("任务栏按钮真实激活路径只执行 descriptor 对应的生产回调", () => {
  const store = createStore({
    initialState: createInitialState({
      windows: [
        windowRecord("crawl"),
        windowRecord("tasks", "minimized"),
        windowRecord("review", "maximized"),
      ],
    }),
    reportError: () => {},
  });
  const stack = selectors.windowStack(store.getState());
  const descriptions = describeTaskbarWindows(
    stack,
    selectors.focusedAppId(store.getState()),
  );
  const byId = new Map(descriptions.map((item) => [item.appId, item]));
  const available = new Set(stack.map((record) => record.appId));
  const calls = [];
  const callbacks = {
    canActivate: (appId) => available.has(appId),
    minimize: (appId) => calls.push(["minimize-request", appId]),
    focus: (appId) => calls.push(["focus", appId]),
    restore: (appId) => {
      calls.push(["restore", appId]);
      store.dispatch(actionCreators.windowOpened(appId));
    },
  };

  assert.equal(activateTaskbarWindow(byId.get("review"), callbacks), true);
  assert.deepEqual(calls, [["minimize-request", "review"]]);

  calls.length = 0;
  assert.equal(activateTaskbarWindow(byId.get("crawl"), callbacks), true);
  assert.deepEqual(calls, [["focus", "crawl"]]);

  calls.length = 0;
  assert.equal(activateTaskbarWindow(byId.get("tasks"), callbacks), true);
  assert.deepEqual(calls, [["restore", "tasks"]]);
  assert.deepEqual(
    selectors.windowStack(store.getState()).map((record) => [record.appId, record.windowState]),
    [["crawl", "normal"], ["review", "maximized"], ["tasks", "normal"]],
  );
  assert.equal(selectors.focusedAppId(store.getState()), "tasks");

  calls.length = 0;
  assert.equal(activateTaskbarWindow(null, callbacks), false);
  assert.equal(activateTaskbarWindow({ appId: "unknown", activation: "focus" }, callbacks), false);
  available.delete("crawl");
  assert.equal(activateTaskbarWindow(byId.get("crawl"), callbacks), false);
  assert.deepEqual(calls, []);
});

test("移动断点窗口视图全部最大化且仅聚焦窗口可见", () => {
  const views = deriveWindowViews([
    windowRecord("crawl"),
    windowRecord("tasks"),
    windowRecord("review", "minimized"),
  ], "tasks", true);
  assert.equal(views.every((view) => view.maximized), true);
  assert.deepEqual(
    views.map((view) => [view.appId, view.visible, view.open, view.minimized]),
    [
      ["crawl", false, true, false],
      ["tasks", true, true, false],
      ["review", false, false, true],
    ],
  );
});

test("退出移动断点后窗口 rect 原样恢复且源窗口栈不被改写", () => {
  const stack = [
    windowRecord("crawl", "normal", windowRect({ x: 91, y: 73, w: 641, h: 421 })),
    windowRecord("tasks", "normal", windowRect({ x: -220, y: 118, w: 812, h: 516 })),
  ];
  const original = structuredClone(stack);
  const mobileViews = deriveWindowViews(stack, "tasks", true);
  const restoredViews = deriveWindowViews(stack, "tasks", false);
  assert.equal(mobileViews.every((view) => view.maximized), true);
  assert.deepEqual(restoredViews.map((view) => view.rect), original.map((item) => item.rect));
  assert.deepEqual(stack, original);
});

test("桌面图标描述只包含 availability 为 ready 的应用", () => {
  const launchers = describeApplicationLaunchers();
  assert.equal(launchers.desktop.length, 8);
  assert.equal(launchers.desktop.every((item) => item.availability === "ready"), true);
  assert.deepEqual(
    launchers.desktop.map((item) => item.id),
    applications.filter((app) => app.availability === "ready").map((app) => app.id),
  );
  for (const appId of ["gallery", "schedule", "export"]) {
    assert.equal(launchers.desktop.some((item) => item.id === appId), false);
  }
});

test("START 菜单含即将推出分组且占位项全部 aria-disabled", () => {
  const launchers = describeApplicationLaunchers();
  assert.deepEqual(
    launchers.startMenuGroups.map((group) => group.title),
    ["可用应用", "即将推出"],
  );
  const upcoming = launchers.startMenuGroups[1];
  assert.deepEqual(upcoming.items.map((item) => item.id), ["gallery", "schedule", "export"]);
  assert.equal(upcoming.items.every((item) => item.ariaDisabled === "true"), true);
  assert.equal(launchers.startMenuGroups[0].items.every((item) => item.ariaDisabled === null), true);
});

test("占位应用 hash 与导航目标仍严格回退到 DEFAULT_ROUTE", () => {
  for (const target of ["gallery", "schedule", "export"]) {
    const app = getApplicationById(target);
    assert(app, target);
    assert.notEqual(app.availability, "ready");
    assert.equal(parseHashRoute(`#${app.route}`), DEFAULT_ROUTE);
    assert.equal(resolveNavigationTarget(target), DEFAULT_ROUTE);
    assert.equal(resolveNavigationTarget(app.route), DEFAULT_ROUTE);
    assert.equal(hashForRoute(app.route), `#${DEFAULT_ROUTE}`);
  }
  assert.equal(parseHashRoute("#/review"), "/review");
  assert.equal(parseHashRoute("#/review?windows=crawl"), DEFAULT_ROUTE);
});

test("布局反序列化会丢弃未知和非 ready 应用、去重并 clamp rect", () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  local.values.set(STORAGE_KEYS.windowLayout, JSON.stringify({
    windows: [
      windowRecord("crawl", "normal", windowRect({ x: 12, y: 18 })),
      windowRecord("unknown", "normal", windowRect()),
      windowRecord("gallery", "normal", windowRect()),
      windowRecord("review", "maximized", windowRect({ x: 5_000, y: -5_000, w: 800, h: 560 })),
      windowRecord("crawl", "minimized", windowRect({ x: -5_000, y: 5_000 })),
    ],
  }));
  const storage = createStorageService({ localStorage: local, sessionStorage: session });
  const windows = storage.readWindowLayout({ width: 1024, height: 600 });
  assert.deepEqual(windows, [
    windowRecord("review", "maximized", { x: 992, y: -528, w: 800, h: 560 }),
    windowRecord("crawl", "minimized", { x: -688, y: 120, w: 720, h: 480 }),
  ]);
  const repaired = JSON.parse(local.values.get(STORAGE_KEYS.windowLayout));
  assert.deepEqual(repaired, { windows });
  assert.equal(JSON.stringify(repaired).includes("unknown"), false);
  assert.equal(JSON.stringify(repaired).includes("gallery"), false);
  assert.equal(JSON.stringify(repaired).includes("zIndex"), false);
  assert.equal(STORAGE_KEYS.windowLayout, "imageweave.window-layout.v1");
});

test("损坏的 localStorage 窗口布局静默回退到安全默认布局", () => {
  const damagedValues = [
    "{broken-json",
    JSON.stringify([]),
    JSON.stringify({ windows: {} }),
    JSON.stringify({ windows: [windowRecord("crawl", "open")] }),
    JSON.stringify({ windows: [windowRecord("crawl", "normal", windowRect({ w: 359 }))] }),
    JSON.stringify({ windows: [{ ...windowRecord("crawl"), zIndex: 99 }] }),
    JSON.stringify({ windows: [], backendPath: "/private/output" }),
  ];
  for (const serialized of damagedValues) {
    const local = new MemoryStorage();
    local.values.set(STORAGE_KEYS.windowLayout, serialized);
    const storage = createStorageService({
      localStorage: local,
      sessionStorage: new MemoryStorage(),
    });
    let windows;
    assert.doesNotThrow(() => {
      windows = storage.readWindowLayout({ width: 800, height: 600 });
    });
    assert.deepEqual(windows, [
      windowRecord("crawl", "normal", { x: 160, y: 40, w: 800, h: 560 }),
    ]);
    assert.deepEqual(JSON.parse(local.values.get(STORAGE_KEYS.windowLayout)), { windows });
  }
});

test("DESKTOP.CPL 以 ready 应用注册且不改变既有应用相对顺序", () => {
  const personalization = getApplicationById("personalization");
  assert(personalization);
  assert.deepEqual({
    id: personalization.id,
    label: personalization.label,
    route: personalization.route,
    windowTitle: personalization.windowTitle,
    availability: personalization.availability,
    defaultWindowState: personalization.defaultWindowState,
  }, {
    id: "personalization",
    label: "外观设置",
    route: "/personalization",
    windowTitle: "C:\\IMAGEWEAVE\\DESKTOP.CPL",
    availability: "ready",
    defaultWindowState: "normal",
  });
  assert.deepEqual(
    applications.filter((app) => app.id !== "personalization").map((app) => app.id),
    [
      "crawl", "tasks", "proxy", "vault", "review", "policy", "diagnostics",
      "gallery", "schedule", "export",
    ],
  );
  assert.equal(
    applications.indexOf(personalization),
    applications.findIndex((app) => app.id === "diagnostics") + 1,
  );
  for (const hook of [
    "mount", "activate", "beforeLeave", "beforeWindowHide", "deactivate", "unmount",
  ]) {
    assert.equal(typeof personalizationApplication[hook], "function", hook);
  }
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

test("轮询倍率与既有基础 interval 常量保持固定", () => {
  assert.equal(UNFOCUSED_POLL_MULTIPLIER, 4);
  assert.equal(TASK_POLL_INTERVAL_MS, 1_500);
  assert.equal(REVIEW_POLL_INTERVAL_MS, 1_500);
  assert.equal(DIAGNOSTICS_POLL_INTERVAL_MS, 20_000);
  assert.equal(SHELL_POLL_INTERVAL_MS, 30_000);
  assert.equal(SHELL_POLL_SCOPE, "shell");
});

test("store 聚焦适配器只投影窗口 scope 与 open/minimized/closed 状态", () => {
  const store = createStore({
    initialState: createInitialState({
      windows: [
        windowRecord("crawl", "normal"),
        windowRecord("tasks", "minimized"),
      ],
    }),
    reportError: () => {},
  });
  const source = createStorePollingFocusSource(store);

  assert.equal(source.getFocusedScope(), "app:crawl");
  assert.equal(source.getScopeState("app:crawl"), POLLING_SCOPE_STATES.OPEN);
  assert.equal(source.getScopeState("app:tasks"), POLLING_SCOPE_STATES.MINIMIZED);
  assert.equal(source.getScopeState("app:review"), POLLING_SCOPE_STATES.CLOSED);
  assert.equal(source.getScopeState("shell"), POLLING_SCOPE_STATES.UNMANAGED);
  const initial = source.getSnapshot();
  assert.equal(Object.isFrozen(initial), true);
  assert.equal(Object.isFrozen(initial.windows), true);
  assert.equal(Object.isFrozen(initial.windows[0]), true);
  assert.deepEqual(initial, {
    focusedScope: "app:crawl",
    windows: [
      { scope: "app:crawl", state: "open" },
      { scope: "app:tasks", state: "minimized" },
    ],
  });
  assert.equal(JSON.stringify(initial).includes("rect"), false);

  const notifications = [];
  const unsubscribe = source.subscribe((snapshot) => notifications.push(snapshot));
  store.dispatch(actionCreators.startMenuChanged(true));
  assert.equal(notifications.length, 0, "无关 UI 状态不得触发聚焦重排");
  store.dispatch(actionCreators.windowOpened("review"));
  assert.equal(notifications.length, 1);
  assert.equal(notifications.at(-1).focusedScope, "app:review");
  store.dispatch(actionCreators.windowStateChanged("review", "minimized"));
  assert.equal(notifications.length, 2);
  assert.equal(notifications.at(-1).focusedScope, "app:crawl");
  store.dispatch(actionCreators.windowClosed("review"));
  assert.equal(notifications.length, 3);
  assert.equal(source.getScopeState("app:review"), POLLING_SCOPE_STATES.CLOSED);
  unsubscribe();
  store.dispatch(actionCreators.windowOpened("policy"));
  assert.equal(notifications.length, 3);
});

test("未提供 focusSource 时 app scope 保持原速向后兼容", () => {
  const { manager, timers } = createFakePolling();
  manager.start({
    key: "compat.application",
    scope: "app:tasks",
    intervalMs: 1_200,
    immediate: false,
    critical: false,
    task: async () => {},
  });
  assert.deepEqual(timers.delays(), [1_200]);
  assert.equal(manager.getSummary()[0].effectiveIntervalMs, 1_200);
  manager.destroy();
});

test("聚焦窗口原速、opened-unfocused 四倍且 shell 30 秒不被重排", async () => {
  const store = createStore({
    initialState: createInitialState({
      windows: [windowRecord("review"), windowRecord("tasks")],
    }),
    reportError: () => {},
  });
  const focusSource = createStorePollingFocusSource(store);
  const { manager, timers } = createFakePolling({ focusSource });
  const calls = { tasks: 0, review: 0, shell: 0 };
  for (const [key, scope, intervalMs] of [
    ["rate.tasks", "app:tasks", TASK_POLL_INTERVAL_MS],
    ["rate.review", "app:review", REVIEW_POLL_INTERVAL_MS],
    ["rate.shell", SHELL_POLL_SCOPE, SHELL_POLL_INTERVAL_MS],
  ]) {
    manager.start({
      key,
      scope,
      intervalMs,
      immediate: false,
      critical: false,
      resume: "immediate",
      task: async () => { calls[key.slice(5)] += 1; },
    });
  }

  const initial = new Map(manager.getSummary().map((entry) => [entry.key, entry]));
  assert.equal(initial.get("rate.tasks").effectiveIntervalMs, 1_500);
  assert.equal(initial.get("rate.review").effectiveIntervalMs, 6_000);
  assert.equal(initial.get("rate.shell").effectiveIntervalMs, 30_000);
  assert.deepEqual(timers.delays(), [1_500, 6_000, 30_000]);

  timers.advanceBy(1_000);
  const shellDeadline = initial.get("rate.shell").nextRunAt;
  store.dispatch(actionCreators.windowFocused("review"));
  const switched = new Map(manager.getSummary().map((entry) => [entry.key, entry]));
  assert.equal(switched.get("rate.tasks").effectiveIntervalMs, 6_000);
  assert.equal(switched.get("rate.review").effectiveIntervalMs, 1_500);
  assert.equal(switched.get("rate.shell").effectiveIntervalMs, 30_000);
  assert.equal(switched.get("rate.shell").nextRunAt, shellDeadline);
  assert.deepEqual(timers.delays(), [0, 6_000, 29_000]);

  timers.runNext();
  await flushPromises();
  assert.deepEqual(calls, { tasks: 0, review: 1, shell: 0 });
  assert.deepEqual(timers.delays(), [1_500, 6_000, 29_000]);
  manager.destroy();
});

test("minimized 与 closed 窗口挂起既存 entry 并中止活动请求", async () => {
  const store = createStore({
    initialState: createInitialState({ windows: [windowRecord("tasks")] }),
    reportError: () => {},
  });
  const { manager, timers } = createFakePolling({
    focusSource: createStorePollingFocusSource(store),
  });
  let activeSignal = null;
  let release = null;
  manager.start({
    key: "lifecycle.tasks",
    scope: "app:tasks",
    intervalMs: 1_000,
    immediate: true,
    critical: false,
    alwaysFocusRate: true,
    task(signal) {
      activeSignal = signal;
      return new Promise((resolve) => { release = resolve; });
    },
  });
  timers.runNext();
  await flushPromises();
  assert.equal(activeSignal.aborted, false);

  store.dispatch(actionCreators.windowStateChanged("tasks", "minimized"));
  assert.equal(activeSignal.aborted, true);
  assert.equal(timers.jobs.size, 0);
  assert.equal(manager.getSummary()[0].state, "paused");
  assert.equal(manager.getSummary()[0].effectiveIntervalMs, null);

  manager.start({
    key: "lifecycle.closed",
    scope: "app:review",
    intervalMs: 1_000,
    immediate: false,
    critical: false,
    alwaysFocusRate: true,
    task: async () => {},
  });
  const closed = manager.getSummary().find((entry) => entry.key === "lifecycle.closed");
  assert.equal(closed.state, "paused");
  assert.equal(closed.effectiveIntervalMs, null);
  assert.equal(timers.jobs.size, 0);

  store.dispatch(actionCreators.windowClosed("tasks"));
  release();
  await flushPromises();
  assert.equal(manager.getSummary().every((entry) => entry.state === "paused"), true);
  assert.equal(timers.jobs.size, 0);
  manager.destroy();
});

test("alwaysFocusRate 仅绕过未聚焦降频，页面 hidden 仍优先挂起全部非关键 entry", () => {
  const store = createStore({
    initialState: createInitialState({
      windows: [
        windowRecord("vault"),
        windowRecord("review"),
        windowRecord("tasks"),
      ],
    }),
    reportError: () => {},
  });
  const visibility = new FakeVisibility();
  const { manager, timers } = createFakePolling({
    visibility,
    focusSource: createStorePollingFocusSource(store),
  });
  manager.start({
    key: "authorization.vault",
    scope: "app:vault",
    intervalMs: 800,
    immediate: false,
    critical: false,
    alwaysFocusRate: true,
    task: async () => {},
  });
  manager.start({
    key: "authorization.review",
    scope: "app:review",
    intervalMs: 800,
    immediate: false,
    critical: false,
    task: async () => {},
  });
  manager.start({
    key: "authorization.shell",
    scope: SHELL_POLL_SCOPE,
    intervalMs: SHELL_POLL_INTERVAL_MS,
    immediate: false,
    critical: false,
    task: async () => {},
  });
  const visible = new Map(manager.getSummary().map((entry) => [entry.key, entry]));
  assert.equal(visible.get("authorization.vault").effectiveIntervalMs, 800);
  assert.equal(visible.get("authorization.vault").alwaysFocusRate, true);
  assert.equal(visible.get("authorization.review").effectiveIntervalMs, 3_200);
  assert.equal(visible.get("authorization.shell").effectiveIntervalMs, 30_000);

  visibility.set("hidden");
  assert.equal(manager.getSummary().every((entry) => entry.state === "paused"), true);
  assert.equal(manager.getSummary().every((entry) => entry.effectiveIntervalMs === null), true);
  assert.equal(timers.jobs.size, 0);
  visibility.set("visible");
  assert.deepEqual(timers.delays(), [0, 0, 0]);
  manager.destroy();
});

test("opened-unfocused 恢复聚焦时 interval 策略等待基础周期", async () => {
  const store = createStore({
    initialState: createInitialState({
      windows: [windowRecord("review"), windowRecord("tasks")],
    }),
    reportError: () => {},
  });
  const { manager, timers } = createFakePolling({
    focusSource: createStorePollingFocusSource(store),
  });
  let calls = 0;
  manager.start({
    key: "resume.interval",
    scope: "app:review",
    intervalMs: 1_000,
    immediate: false,
    critical: false,
    resume: "interval",
    task: async () => { calls += 1; },
  });
  assert.deepEqual(timers.delays(), [4_000]);
  timers.advanceBy(500);
  store.dispatch(actionCreators.windowFocused("review"));
  assert.deepEqual(timers.delays(), [1_000]);
  timers.advanceBy(999);
  assert.equal(calls, 0);
  timers.advanceBy(1);
  await flushPromises();
  assert.equal(calls, 1);
  assert.deepEqual(timers.delays(), [1_000]);
  manager.destroy();
});

test("活动请求切回聚焦保持单飞并分别沿用 immediate 与 interval 恢复策略", async () => {
  const store = createStore({
    initialState: createInitialState({
      windows: [
        windowRecord("tasks"),
        windowRecord("review"),
        windowRecord("diagnostics"),
      ],
    }),
    reportError: () => {},
  });
  const { manager, timers } = createFakePolling({
    focusSource: createStorePollingFocusSource(store),
  });
  let immediateCalls = 0;
  let intervalCalls = 0;
  let immediateActive = 0;
  let intervalActive = 0;
  let maxImmediateActive = 0;
  let maxIntervalActive = 0;
  let releaseImmediate;
  let releaseInterval;

  manager.start({
    key: "active.immediate",
    scope: "app:tasks",
    intervalMs: 1_000,
    immediate: true,
    critical: false,
    resume: "immediate",
    task() {
      immediateCalls += 1;
      immediateActive += 1;
      maxImmediateActive = Math.max(maxImmediateActive, immediateActive);
      if (immediateCalls === 1) {
        return new Promise((resolve) => {
          releaseImmediate = () => {
            immediateActive -= 1;
            resolve();
          };
        });
      }
      immediateActive -= 1;
      return Promise.resolve();
    },
  });
  manager.start({
    key: "active.interval",
    scope: "app:review",
    intervalMs: 1_000,
    immediate: true,
    critical: false,
    resume: "interval",
    task() {
      intervalCalls += 1;
      intervalActive += 1;
      maxIntervalActive = Math.max(maxIntervalActive, intervalActive);
      if (intervalCalls === 1) {
        return new Promise((resolve) => {
          releaseInterval = () => {
            intervalActive -= 1;
            resolve();
          };
        });
      }
      intervalActive -= 1;
      return Promise.resolve();
    },
  });

  timers.advanceBy(0);
  await flushPromises();
  assert.deepEqual([immediateCalls, intervalCalls], [1, 1]);
  store.dispatch(actionCreators.windowFocused("tasks"));
  assert.equal(timers.jobs.size, 0, "活动请求恢复时不得并发创建 timer");
  const firstTrigger = manager.trigger("active.immediate");
  assert.equal(manager.trigger("active.immediate"), firstTrigger);
  assert.equal(immediateCalls, 1);

  releaseImmediate();
  await flushPromises();
  assert.deepEqual(timers.delays(), [0]);
  timers.runNext();
  await flushPromises();
  assert.equal(immediateCalls, 2);
  assert.deepEqual(timers.delays(), [1_000]);

  store.dispatch(actionCreators.windowFocused("review"));
  assert.deepEqual(timers.delays(), [4_000]);
  releaseInterval();
  await flushPromises();
  assert.deepEqual(timers.delays(), [1_000, 4_000]);
  timers.advanceBy(999);
  assert.equal(intervalCalls, 1);
  timers.advanceBy(1);
  await flushPromises();
  assert.equal(intervalCalls, 2);
  assert.equal(maxImmediateActive, 1);
  assert.equal(maxIntervalActive, 1);
  manager.destroy();
});

test("反复切焦 50 次保持每 entry 一个 timer 且不增长状态源监听器", () => {
  const focusSource = new FakeFocusSource({
    focusedScope: "app:tasks",
    scopeStates: {
      "app:tasks": POLLING_SCOPE_STATES.OPEN,
      "app:review": POLLING_SCOPE_STATES.OPEN,
    },
  });
  const visibility = new FakeVisibility();
  const { manager, timers } = createFakePolling({ visibility, focusSource });
  for (const [key, scope, intervalMs] of [
    ["cardinality.tasks", "app:tasks", 1_000],
    ["cardinality.review", "app:review", 1_000],
    ["cardinality.shell", SHELL_POLL_SCOPE, SHELL_POLL_INTERVAL_MS],
  ]) {
    manager.start({
      key,
      scope,
      intervalMs,
      immediate: false,
      critical: false,
      resume: "interval",
      task: async () => {},
    });
  }
  const shell = manager.getSummary().find((entry) => entry.key === "cardinality.shell");
  const shellTimerId = [...timers.jobs.entries()]
    .find(([, job]) => job.due === shell.nextRunAt)?.[0];
  assert.equal(timers.jobs.size, 3);
  assert.equal(focusSource.listeners.size, 1);
  assert.equal(visibility.listeners.size, 1);

  for (let index = 0; index < 50; index += 1) {
    focusSource.update({
      focusedScope: index % 2 === 0 ? "app:review" : "app:tasks",
    });
    assert.equal(timers.jobs.size, 3, `第 ${index + 1} 次切焦`);
    assert.equal(focusSource.listeners.size, 1);
    assert.equal(visibility.listeners.size, 1);
  }
  assert.equal(timers.jobs.has(shellTimerId), true, "shell timer 不得被切焦替换");
  assert.equal(
    manager.getSummary().find((entry) => entry.key === "cardinality.shell").nextRunAt,
    shell.nextRunAt,
  );

  manager.destroy();
  assert.equal(timers.jobs.size, 0);
  assert.equal(focusSource.listeners.size, 0);
  assert.equal(visibility.listeners.size, 0);
});

test("个性化模型固定六色、界面主题默认值与不可变白名单", () => {
  assert.deepEqual(BUILT_IN_WALLPAPER_COLORS, {
    graphite: "#20242A",
    slate: "#384554",
    "deep-ocean": "#20364A",
    forest: "#294039",
    "plum-gray": "#403341",
    "warm-paper": "#E7E1D6",
  });
  assert.deepEqual(PERSONALIZATION_DEFAULTS, {
    animations: "on",
    wallpaperKind: "color",
    wallpaperColor: "graphite",
    wallpaperFit: "cover",
    wallpaperPosition: "center",
    wallpaperMaskTone: "dark",
    wallpaperMaskStrength: 40,
    wallpaperBlur: "off",
    windowOpacity: "solid",
    themeAccent: "#46515D",
    themeSurface: "#F4F1EA",
  });
  assert.deepEqual(INTERFACE_THEME_DEFAULTS, {
    themeAccent: "#46515D",
    themeSurface: "#F4F1EA",
  });
  assert.deepEqual(INTERFACE_THEME_PREFERENCE_KEYS, [
    "themeAccent",
    "themeSurface",
  ]);
  assert.equal(
    INTERFACE_THEME_TONE_LUMINANCE_THRESHOLD,
    Math.sqrt(1.05 * 0.05) - 0.05,
  );
  assert.equal(Object.isFrozen(BUILT_IN_WALLPAPER_COLORS), true);
  assert.equal(Object.isFrozen(INTERFACE_THEME_DEFAULTS), true);
  assert.equal(Object.isFrozen(INTERFACE_THEME_PREFERENCE_KEYS), true);
  assert.equal(Object.isFrozen(PERSONALIZATION_DEFAULTS), true);
  assert.equal(Object.isFrozen(PERSONALIZATION_OPTIONS), true);
  assert.equal(
    Object.values(PERSONALIZATION_OPTIONS).every((values) => Object.isFrozen(values)),
    true,
  );
  assert.deepEqual(PERSONALIZATION_OPTIONS.wallpaperPosition, [
    "top-left", "top", "top-right", "left", "center", "right",
    "bottom-left", "bottom", "bottom-right",
  ]);
});

test("界面主题颜色规范化、WCAG 对比度计算与底色 tone 派生使用固定算法", () => {
  for (const [input, expected] of [
    ["#46515D", "#46515D"],
    ["#f4f1ea", "#F4F1EA"],
    ["#a0B1c2", "#A0B1C2"],
  ]) {
    assert.equal(normalizeThemeHex(input), expected, input);
  }
  for (const invalid of [
    "#123",
    "#46515DFF",
    "46515D",
    "transparent",
    "red",
    "rgb(70 81 93)",
    "var(--unsafe)",
    "url(https://example.invalid/theme.css)",
    "#GGGGGG",
    null,
  ]) {
    assert.equal(normalizeThemeHex(invalid), null, String(invalid));
  }

  assert.ok(Math.abs(
    calculateSrgbRelativeLuminance("#46515D") - 0.07977263878707866,
  ) < 1e-12);
  const defaultRatio = calculateThemeContrastRatio("#46515D", "#F4F1EA");
  assert.ok(Math.abs(defaultRatio - 7.172868210874588) < 1e-12);
  assert.equal(isValidInterfaceTheme("#46515D", "#F4F1EA"), true);

  // 对比度只用于 live status；低对比、同色与真实用户组合仍是合法主题。
  assert.ok(calculateThemeContrastRatio("#767676", "#FFFFFF") > 4.5);
  assert.ok(calculateThemeContrastRatio("#777777", "#FFFFFF") < 4.5);
  const userRatio = calculateThemeContrastRatio("#0065D1", "#7E6425");
  assert.ok(userRatio > 1 && userRatio < 1.02);
  assert.equal(isValidInterfaceTheme("#767676", "#FFFFFF"), true);
  assert.equal(isValidInterfaceTheme("#777777", "#FFFFFF"), true);
  assert.equal(isValidInterfaceTheme("#0065D1", "#7E6425"), true);
  assert.equal(isValidInterfaceTheme("#101010", "#101010"), true);
  assert.equal(isValidInterfaceTheme("#FFFFFF", "#101010"), true);
  assert.equal(isValidInterfaceTheme("#FFF", "#101010"), false);
  assert.equal(isValidInterfaceTheme("var(--unsafe)", "#101010"), false);

  // #757575 和 #767676 分别位于黑/白前景等对比阈值两侧。
  assert.ok(
    calculateSrgbRelativeLuminance("#757575")
      < INTERFACE_THEME_TONE_LUMINANCE_THRESHOLD,
  );
  assert.ok(
    calculateSrgbRelativeLuminance("#767676")
      > INTERFACE_THEME_TONE_LUMINANCE_THRESHOLD,
  );
  assert.equal(deriveInterfaceThemeTone("#FFFFFF"), "light");
  assert.equal(deriveInterfaceThemeTone("#767676"), "light");
  assert.equal(deriveInterfaceThemeTone("#757575"), "dark");
  assert.equal(deriveInterfaceThemeTone("#101010"), "dark");
  assert.throws(() => calculateSrgbRelativeLuminance("rgb(0 0 0)"), TypeError);
  assert.throws(() => deriveInterfaceThemeTone("#0008"), TypeError);
});

test("个性化严格投影接受全部白名单值并拒绝越界、对象与 CSS 字符串", () => {
  for (const [field, allowed] of Object.entries(PERSONALIZATION_OPTIONS)) {
    for (const value of allowed) {
      const projected = projectPersonalizationPreferences({
        ...PERSONALIZATION_DEFAULTS,
        [field]: value,
      });
      assert.equal(projected[field], value, `${field}: ${value}`);
      assert.equal(Object.isFrozen(projected), true);
    }
  }

  const darkTheme = projectPersonalizationPreferences({
    ...PERSONALIZATION_DEFAULTS,
    themeAccent: "#ffffff",
    themeSurface: "#101010",
  });
  assert.equal(darkTheme.themeAccent, "#FFFFFF");
  assert.equal(darkTheme.themeSurface, "#101010");

  const lowContrastTheme = projectPersonalizationPreferences({
    ...PERSONALIZATION_DEFAULTS,
    themeAccent: "#0065d1",
    themeSurface: "#7e6425",
  });
  assert.equal(lowContrastTheme.themeAccent, "#0065D1");
  assert.equal(lowContrastTheme.themeSurface, "#7E6425");

  for (const [themeAccent, themeSurface] of [
    ["#FFFFFF00", "#101010"],
    ["#FFF", "#101010"],
    ["white", "#101010"],
    ["rgb(255 255 255)", "#101010"],
    ["var(--imageweave-accent)", "#101010"],
    ["url(https://example.invalid/theme.css)", "#101010"],
    ["} body { color: red", "#101010"],
  ]) {
    assert.throws(
      () => projectPersonalizationPreferences({
        ...PERSONALIZATION_DEFAULTS,
        themeAccent,
        themeSurface,
      }),
      TypeError,
      `${themeAccent} / ${themeSurface}`,
    );
  }

  for (const wallpaperMaskStrength of [-5, 3, 40.5, 85, "40"]) {
    assert.throws(
      () => projectPersonalizationPreferences({ wallpaperMaskStrength }),
      TypeError,
    );
  }
  for (const [field, value] of [
    ["animations", "system"],
    ["wallpaperKind", "remote"],
    ["wallpaperColor", "#20242A"],
    ["wallpaperColor", "url(https://example.invalid/wallpaper.png)"],
    ["wallpaperFit", "auto"],
    ["wallpaperPosition", "center center"],
    ["wallpaperMaskTone", "transparent"],
    ["wallpaperBlur", "strong"],
    ["windowOpacity", "transparent"],
  ]) {
    assert.throws(
      () => projectPersonalizationPreferences({ [field]: value }),
      TypeError,
    );
  }
  assert.throws(
    () => projectPersonalizationPreferences({ wallpaperColor: { id: "graphite" } }),
    TypeError,
  );
  assert.throws(
    () => projectPersonalizationPreferences({ ...PERSONALIZATION_DEFAULTS, unknown: true }),
    TypeError,
  );
  assert.equal(isValidPersonalizationPreferences(PERSONALIZATION_DEFAULTS), true);
  assert.equal(isValidPersonalizationPreferences(new Blob(["unsafe"])), false);
});

test("个性化宽容规范化逐字段回退，草稿复制、比较与恢复默认安全", () => {
  const normalized = normalizePersonalizationPreferences({
    animations: "unexpected",
    wallpaperKind: "custom",
    wallpaperColor: "unknown-color",
    wallpaperFit: "contain",
    wallpaperPosition: { row: 1, column: 1 },
    wallpaperMaskTone: "light",
    wallpaperMaskStrength: 42,
    wallpaperBlur: "medium",
    windowOpacity: "subtle",
    unknown: "discarded",
  });
  assert.deepEqual(normalized, {
    ...PERSONALIZATION_DEFAULTS,
    wallpaperKind: "custom",
    wallpaperFit: "contain",
    wallpaperMaskTone: "light",
    wallpaperBlur: "medium",
    windowOpacity: "subtle",
  });
  assert.equal("unknown" in normalized, false);
  assert.deepEqual(normalizePersonalizationPreferences(null), PERSONALIZATION_DEFAULTS);

  const lowercaseTheme = normalizePersonalizationPreferences({
    wallpaperFit: "contain",
    themeAccent: "#ffffff",
    themeSurface: "#101010",
  });
  assert.deepEqual(lowercaseTheme, {
    ...PERSONALIZATION_DEFAULTS,
    wallpaperFit: "contain",
    themeAccent: "#FFFFFF",
    themeSurface: "#101010",
  });
  const lowContrastTheme = normalizePersonalizationPreferences({
    wallpaperFit: "contain",
    themeAccent: "#0065d1",
    themeSurface: "#7e6425",
  });
  assert.deepEqual(lowContrastTheme, {
    ...PERSONALIZATION_DEFAULTS,
    wallpaperFit: "contain",
    themeAccent: "#0065D1",
    themeSurface: "#7E6425",
  });
  for (const damagedTheme of [
    { themeAccent: "#46515DCC", themeSurface: "#101010" },
    { themeAccent: "var(--unsafe)", themeSurface: "#101010" },
  ]) {
    const recovered = normalizePersonalizationPreferences({
      wallpaperFit: "contain",
      wallpaperMaskTone: "light",
      ...damagedTheme,
    });
    assert.equal(recovered.themeAccent, INTERFACE_THEME_DEFAULTS.themeAccent);
    assert.equal(recovered.themeSurface, INTERFACE_THEME_DEFAULTS.themeSurface);
    assert.equal(recovered.wallpaperFit, "contain");
    assert.equal(recovered.wallpaperMaskTone, "light");
  }

  let getterCalled = false;
  const accessor = Object.create(null);
  Object.defineProperty(accessor, "wallpaperColor", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "forest";
    },
  });
  Object.defineProperty(accessor, "themeAccent", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "#FFFFFF";
    },
  });
  assert.equal(normalizePersonalizationPreferences(accessor).wallpaperColor, "graphite");
  assert.equal(
    normalizePersonalizationPreferences(accessor).themeAccent,
    INTERFACE_THEME_DEFAULTS.themeAccent,
  );
  assert.throws(() => projectPersonalizationPreferences(accessor), TypeError);
  assert.equal(getterCalled, false);

  let proxyGetCalled = false;
  const proxied = new Proxy({
    themeAccent: "#ffffff",
    themeSurface: "#101010",
  }, {
    get(target, key, receiver) {
      proxyGetCalled = true;
      return Reflect.get(target, key, receiver);
    },
  });
  assert.equal(normalizePersonalizationPreferences(proxied).themeAccent, "#FFFFFF");
  assert.equal(proxyGetCalled, false);

  const draft = copyPersonalizationPreferences(normalized);
  draft.wallpaperColor = "forest";
  draft.themeAccent = "#000000";
  assert.equal(PERSONALIZATION_DEFAULTS.wallpaperColor, "graphite");
  assert.equal(PERSONALIZATION_DEFAULTS.themeAccent, "#46515D");
  assert.equal(personalizationPreferencesEqual(draft, normalized), false);
  assert.equal(personalizationPreferencesEqual({}, PERSONALIZATION_DEFAULTS), true);
  assert.equal(
    personalizationPreferencesEqual({ wallpaperMaskStrength: 42 }, PERSONALIZATION_DEFAULTS),
    false,
  );

  const restored = restoreDefaultPersonalizationPreferences();
  assert.deepEqual(restored, PERSONALIZATION_DEFAULTS);
  assert.notEqual(restored, PERSONALIZATION_DEFAULTS);
  restored.animations = "off";
  assert.equal(PERSONALIZATION_DEFAULTS.animations, "on");
});

test("E2 设置视图聚合回显禁用语义，并严格读取完整可读性草稿", () => {
  const previousDocument = globalThis.document;
  const previousNode = globalThis.Node;
  const previousButton = globalThis.HTMLButtonElement;
  const previousForm = globalThis.HTMLFormElement;

  class ViewTestNode {}
  class ViewTestClassList {
    constructor() {
      this.values = new Set();
    }

    add(...names) {
      for (const name of names) this.values.add(name);
    }

    remove(...names) {
      for (const name of names) this.values.delete(name);
    }
  }
  class ViewTestElement extends ViewTestNode {
    constructor(tagName) {
      super();
      this.tagName = tagName.toUpperCase();
      this.attributes = new Map();
      this.dataset = {};
      this.children = [];
      this.classList = new ViewTestClassList();
      this.className = "";
      this.textContent = "";
      this.value = "";
      this.checked = false;
      this.disabled = false;
      this.hidden = false;
    }

    setAttribute(name, value) {
      const normalized = String(value);
      this.attributes.set(name, normalized);
      if (name === "value") this.value = normalized;
      if (name === "type") this.type = normalized;
      if (name === "name") this.name = normalized;
      if (name === "id") this.id = normalized;
      if (name === "hidden") this.hidden = true;
    }

    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }

    removeAttribute(name) {
      this.attributes.delete(name);
    }

    append(...children) {
      this.children.push(...children);
    }

    replaceChildren(...children) {
      this.children = children;
    }

    focus() {}
  }
  class ViewTestButton extends ViewTestElement {}
  class ViewTestForm extends ViewTestElement {}

  globalThis.Node = ViewTestNode;
  globalThis.HTMLButtonElement = ViewTestButton;
  globalThis.HTMLFormElement = ViewTestForm;
  globalThis.document = {
    createElement(tagName) {
      if (tagName === "button") return new ViewTestButton(tagName);
      if (tagName === "form") return new ViewTestForm(tagName);
      return new ViewTestElement(tagName);
    },
  };

  let view = null;
  try {
    const root = new ViewTestElement("main");
    view = createPersonalizationView({
      root,
      app: { label: "外观设置", windowTitle: "C:\\IMAGEWEAVE\\DESKTOP.CPL" },
    });
    const state = ({ draft = {}, customWallpaper = {}, busy = false, dirty = true }) => ({
      committed: { ...PERSONALIZATION_DEFAULTS },
      draft: { ...PERSONALIZATION_DEFAULTS, ...draft },
      dirty,
      busy,
      customWallpaper: {
        loading: false,
        saved: false,
        pending: false,
        selectedReady: false,
        storageAvailable: true,
        ...customWallpaper,
      },
      motion: {
        userMode: "on",
        systemReduced: false,
        effective: true,
        limitedBySystem: false,
      },
    });
    const elements = view.elements;
    const descendants = (element) => [
      element,
      ...element.children.flatMap((child) => (
        child instanceof ViewTestElement ? descendants(child) : []
      )),
    ];

    assert.equal(elements.form.children[0].children[0].textContent, "动效");
    assert.equal(elements.form.children[1], elements.themeFieldset);
    assert.equal(elements.themeFieldset.children[0].textContent, "界面主题");
    assert.equal(elements.themeAccentInput.type, "color");
    assert.equal(elements.themeSurfaceInput.type, "color");
    assert.equal(elements.themeAccentInput.dataset.personalizationThemeAccent, "setting");
    assert.equal(elements.themeSurfaceInput.dataset.personalizationThemeSurface, "setting");
    assert.equal(elements.themeAccentOutput.textContent, "#46515D");
    assert.equal(elements.themeSurfaceOutput.textContent, "#F4F1EA");
    assert.equal(elements.themeContrastStatus.getAttribute("role"), "status");
    assert.equal(elements.themeContrastStatus.getAttribute("aria-live"), "polite");
    assert.equal(elements.themeContrastStatus.getAttribute("aria-atomic"), "true");
    assert.match(elements.themeContrastStatus.textContent, /7\.17:1.*可正常使用/);
    assert.equal(
      elements.themeAccentInput.getAttribute("aria-describedby"),
      "personalization-theme-help personalization-theme-contrast-status",
    );
    assert.equal(
      elements.themeSurfaceInput.getAttribute("aria-describedby"),
      "personalization-theme-help personalization-theme-contrast-status",
    );
    const labels = descendants(elements.themeFieldset).filter(
      (element) => element.tagName === "LABEL",
    );
    assert.equal(labels.some((label) => (
      label.textContent === "强调色"
      && label.getAttribute("for") === "personalization-theme-accent"
    )), true);
    assert.equal(labels.some((label) => (
      label.textContent === "窗口底色"
      && label.getAttribute("for") === "personalization-theme-surface"
    )), true);

    view.renderState(state({
      draft: {
        wallpaperKind: "color",
        wallpaperFit: "contain",
        wallpaperPosition: "bottom",
        wallpaperMaskTone: "light",
        wallpaperMaskStrength: 35,
        wallpaperBlur: "soft",
        windowOpacity: "subtle",
        themeAccent: "#ffffff",
        themeSurface: "#101010",
      },
    }));
    assert.equal(elements.imageSettingsPanel.hidden, true);
    assert.equal(elements.wallpaperFit.disabled, true);
    assert.equal(elements.positionFieldset.disabled, true);
    assert.equal(elements.wallpaperMaskTone.disabled, true);
    assert.equal(elements.maskStrengthInput.disabled, true);
    assert.equal(elements.wallpaperBlur.disabled, true);
    assert.equal(elements.windowOpacity.disabled, false, "窗口透明度在纯色模式仍可用");
    assert.equal(elements.wallpaperFit.value, "contain", "隐藏控件仍完整回显草稿");
    assert.equal(elements.maskStrengthInput.value, "35");
    assert.equal(elements.maskStrengthOutput.textContent, "35%");
    assert.equal(elements.maskStrengthInput.getAttribute("aria-valuetext"), "35%");
    assert.equal(elements.maskStrengthOutput.getAttribute("aria-live"), "polite");
    assert.equal(elements.themeAccentOutput.textContent, "#FFFFFF");
    assert.equal(elements.themeSurfaceOutput.textContent, "#101010");
    assert.match(elements.themeContrastStatus.textContent, /可正常使用/);
    assert.equal(elements.themeAccentInput.getAttribute("aria-invalid"), null);
    assert.equal(elements.themeSurfaceInput.getAttribute("aria-invalid"), null);
    assert.deepEqual(
      ["min", "max", "step"].map((name) => elements.maskStrengthInput.getAttribute(name)),
      ["0", "80", "5"],
    );

    view.renderState(state({
      draft: { wallpaperKind: "custom" },
      customWallpaper: { selectedReady: false },
    }));
    assert.equal(elements.imageSettingsPanel.hidden, false);
    assert.equal(elements.wallpaperFit.disabled, true);
    assert.equal(elements.maskStrengthInput.disabled, true);
    assert.equal(elements.windowOpacity.disabled, false);
    assert.equal(elements.applyButton.disabled, true);
    assert.match(elements.imageControlsStatus.textContent, /尚无可显示.*已禁用.*不会被视为已生效/);

    const currentDraft = {
      ...PERSONALIZATION_DEFAULTS,
      animations: "off",
      wallpaperKind: "custom",
      wallpaperColor: "forest",
      wallpaperFit: "tile",
      wallpaperPosition: "top-left",
      wallpaperMaskTone: "dark",
      wallpaperMaskStrength: 65,
      wallpaperBlur: "soft",
      windowOpacity: "subtle",
    };
    view.renderState(state({
      draft: currentDraft,
      customWallpaper: { saved: true, selectedReady: true },
    }));
    assert.equal(elements.wallpaperFit.disabled, false);
    assert.equal(elements.positionFieldset.disabled, true, "平铺只禁用位置组");
    assert.equal(elements.positionInputs["top-left"].checked, true);
    assert.equal(elements.tilePositionNote.hidden, false);
    assert.match(elements.tilePositionNote.textContent, /切换回其他模式后恢复“左上”/);
    assert.equal(elements.maskStrengthInput.disabled, false);
    assert.equal(elements.maskStrengthOutput.textContent, "65%");
    assert.equal(elements.windowOpacity.disabled, false);
    assert.deepEqual(Object.keys(elements.positionInputs), [
      "top-left", "top", "top-right", "left", "center", "right",
      "bottom-left", "bottom", "bottom-right",
    ]);

    elements.wallpaperFit.value = "stretch";
    for (const input of Object.values(elements.positionInputs)) input.checked = false;
    elements.positionInputs["bottom-right"].checked = true;
    elements.wallpaperMaskTone.value = "light";
    elements.maskStrengthInput.value = "70";
    elements.wallpaperBlur.value = "medium";
    elements.windowOpacity.value = "soft";
    elements.themeAccentInput.value = "#ffffff";
    elements.themeSurfaceInput.value = "#101010";
    const read = view.readDraft(currentDraft);
    assert.deepEqual(read, {
      ...currentDraft,
      wallpaperFit: "stretch",
      wallpaperPosition: "bottom-right",
      wallpaperMaskTone: "light",
      wallpaperMaskStrength: 70,
      wallpaperBlur: "medium",
      windowOpacity: "soft",
      themeAccent: "#FFFFFF",
      themeSurface: "#101010",
    });
    assert.equal(typeof read.wallpaperMaskStrength, "number");

    elements.maskStrengthInput.value = "42";
    assert.throws(() => view.readDraft(currentDraft), TypeError);

    elements.maskStrengthInput.value = "70";
    elements.themeAccentInput.value = "#0065d1";
    elements.themeSurfaceInput.value = "#7e6425";
    const unrestrictedTheme = view.beginThemeDraft();
    assert.equal(unrestrictedTheme.valid, true);
    assert.ok(unrestrictedTheme.contrastRatio > 1 && unrestrictedTheme.contrastRatio < 1.02);
    assert.equal(elements.themeAccentOutput.textContent, "#0065D1");
    assert.equal(elements.themeSurfaceOutput.textContent, "#7E6425");
    assert.match(elements.themeContrastStatus.textContent, /1\.01:1.*可正常使用/);
    assert.equal(elements.themeContrastStatus.dataset.personalizationThemeStatus, "valid");
    assert.equal(elements.themeAccentInput.getAttribute("aria-invalid"), null);
    assert.equal(elements.themeSurfaceInput.getAttribute("aria-invalid"), null);
    assert.equal(elements.applyButton.disabled, true, "同步 preview 结算前仅暂存主题输入");
    assert.equal(elements.cancelButton.disabled, false);
    assert.equal(root.dataset.dirty, "true");

    const unrestrictedState = state({
      draft: {
        ...currentDraft,
        themeAccent: "#0065D1",
        themeSurface: "#7E6425",
      },
      customWallpaper: { saved: true, selectedReady: true },
    });
    view.acceptThemeDraft(unrestrictedState);
    assert.equal(view.hasLocalThemeDraft(), false);
    assert.equal(elements.applyButton.disabled, false, "低对比 runtime 草稿可直接应用");

    view.renderState(state({
      draft: {
        ...currentDraft,
        themeAccent: "#0065D1",
        themeSurface: "#7E6425",
      },
      customWallpaper: { saved: true, selectedReady: true },
      busy: true,
    }));
    assert.equal(elements.themeAccentInput.value, "#0065D1");
    assert.equal(elements.themeSurfaceInput.value, "#7E6425");
    assert.equal(elements.themeAccentInput.disabled, true);
    assert.equal(elements.themeSurfaceInput.disabled, true);
    assert.equal(elements.themeFieldset.disabled, true);

    view.clearLocalThemeDraft();
    view.renderState(state({
      draft: { ...read },
      customWallpaper: { saved: true, selectedReady: true },
      busy: true,
    }));
    assert.equal(elements.wallpaperFit.disabled, true);
    assert.equal(elements.maskStrengthInput.disabled, true);
    assert.equal(elements.windowOpacity.disabled, true);
    assert.equal(elements.themeAccentInput.value, "#FFFFFF");
    assert.equal(elements.themeSurfaceInput.value, "#101010");
    assert.equal(elements.themeAccentOutput.textContent, "#FFFFFF");
    assert.equal(elements.themeSurfaceOutput.textContent, "#101010");

    view.renderState(state({
      draft: { ...read },
      customWallpaper: { saved: true, selectedReady: true },
    }));
    elements.themeAccentInput.value = "#123";
    const invalidFormat = view.beginThemeDraft();
    assert.equal(invalidFormat.valid, false);
    assert.equal(elements.themeAccentInput.getAttribute("aria-invalid"), "true");
    assert.equal(elements.themeSurfaceInput.getAttribute("aria-invalid"), "true");
    assert.match(elements.themeContrastStatus.textContent, /颜色格式无效.*6 位十六进制颜色值/);
    assert.equal(elements.applyButton.disabled, true);
  } finally {
    view?.destroy();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousNode === undefined) delete globalThis.Node;
    else globalThis.Node = previousNode;
    if (previousButton === undefined) delete globalThis.HTMLButtonElement;
    else globalThis.HTMLButtonElement = previousButton;
    if (previousForm === undefined) delete globalThis.HTMLFormElement;
    else globalThis.HTMLFormElement = previousForm;
  }
});

test("G2 主题低对比即时预览应用，格式与 setter 失败仍安全阻断", async () => {
  const previousDocument = globalThis.document;
  const previousNode = globalThis.Node;
  const previousElement = globalThis.Element;
  const previousButton = globalThis.HTMLButtonElement;
  const previousForm = globalThis.HTMLFormElement;
  const previousAddEventListener = globalThis.addEventListener;
  const previousRemoveEventListener = globalThis.removeEventListener;

  class ControllerTestNode {}
  class ControllerTestClassList {
    constructor() {
      this.values = new Set();
    }

    add(...names) {
      for (const name of names) this.values.add(name);
    }

    remove(...names) {
      for (const name of names) this.values.delete(name);
    }

    toggle(name, force) {
      if (force) this.values.add(name);
      else this.values.delete(name);
      return this.values.has(name);
    }
  }
  class ControllerTestElement extends ControllerTestNode {
    constructor(tagName) {
      super();
      this.tagName = tagName.toUpperCase();
      this.attributes = new Map();
      this.dataset = {};
      this.children = [];
      this.parentElement = null;
      this.listeners = new Map();
      this.classList = new ControllerTestClassList();
      this.className = "";
      this._textContent = "";
      this.textContentWrites = 0;
      this._value = "";
      this.failNextValueWrite = false;
      this.checked = false;
      this.disabled = false;
      this.hidden = false;
      this.inert = false;
    }

    set textContent(next) {
      this._textContent = String(next);
      this.textContentWrites += 1;
    }

    get textContent() {
      return this._textContent;
    }

    set value(next) {
      if (this.failNextValueWrite) {
        this.failNextValueWrite = false;
        throw new Error("controlled form setter failure");
      }
      this._value = String(next);
    }

    get value() {
      return this._value;
    }

    setAttribute(name, value) {
      const normalized = String(value);
      this.attributes.set(name, normalized);
      if (name === "value") this.value = normalized;
      if (name === "type") this.type = normalized;
      if (name === "name") this.name = normalized;
      if (name === "id") this.id = normalized;
      if (name === "hidden") this.hidden = true;
    }

    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    }

    removeAttribute(name) {
      this.attributes.delete(name);
      if (name === "hidden") this.hidden = false;
    }

    toggleAttribute(name, force) {
      if (force) this.setAttribute(name, "");
      else this.removeAttribute(name);
    }

    append(...children) {
      for (const child of children) {
        if (child instanceof ControllerTestElement) child.parentElement = this;
        this.children.push(child);
      }
    }

    replaceChildren(...children) {
      this.children = [];
      this.append(...children);
    }

    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }

    removeEventListener(type, listener) {
      this.listeners.get(type)?.delete(listener);
    }

    matches(selectorList) {
      return selectorList.split(",").some((rawSelector) => {
        const selector = rawSelector.trim();
        const match = /^\[data-([a-z0-9-]+)(?:="([^"]*)")?\]$/.exec(selector);
        if (!match) return false;
        const key = match[1].replace(/-([a-z])/g, (_whole, letter) => letter.toUpperCase());
        if (!Object.prototype.hasOwnProperty.call(this.dataset, key)) return false;
        return match[2] === undefined || this.dataset[key] === match[2];
      });
    }

    closest(selector) {
      let current = this;
      while (current) {
        if (current.matches(selector)) return current;
        current = current.parentElement;
      }
      return null;
    }

    emit(type, target = this) {
      const event = {
        target,
        defaultPrevented: false,
        returnValue: undefined,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
      return event;
    }

    find(predicate) {
      if (predicate(this)) return this;
      for (const child of this.children) {
        if (!(child instanceof ControllerTestElement)) continue;
        const found = child.find(predicate);
        if (found) return found;
      }
      return null;
    }

    focus() {}
    click() {}
  }
  class ControllerTestButton extends ControllerTestElement {}
  class ControllerTestForm extends ControllerTestElement {}

  const globalListeners = new Map();
  globalThis.Node = ControllerTestNode;
  globalThis.Element = ControllerTestElement;
  globalThis.HTMLButtonElement = ControllerTestButton;
  globalThis.HTMLFormElement = ControllerTestForm;
  globalThis.document = {
    createElement(tagName) {
      if (tagName === "button") return new ControllerTestButton(tagName);
      if (tagName === "form") return new ControllerTestForm(tagName);
      return new ControllerTestElement(tagName);
    },
  };
  globalThis.addEventListener = (type, listener) => {
    if (!globalListeners.has(type)) globalListeners.set(type, new Set());
    globalListeners.get(type).add(listener);
  };
  globalThis.removeEventListener = (type, listener) => {
    globalListeners.get(type)?.delete(listener);
  };

  let mounted = false;
  let runtime = null;
  try {
    const root = new ControllerTestElement("main");
    const surface = createWallpaperSurfaceFixture();
    const themeRoot = new FakeThemeRoot();
    const preferenceStorage = createPersonalizationStorageFixture(
      PERSONALIZATION_DEFAULTS,
    );
    runtime = createPersonalizationRuntime({
      wallpaper: surface.wallpaper,
      wallpaperImage: surface.image,
      wallpaperMask: surface.mask,
      windowLayer: surface.windowLayer,
      themeRoot,
      storage: preferenceStorage.service,
      wallpaperStorage: null,
      urlApi: surface.urlApi,
    });
    await runtime.ready();

    const calls = { preview: 0 };
    const personalization = Object.freeze({
      getState: runtime.getState,
      preview(preferences) {
        calls.preview += 1;
        return runtime.preview(preferences);
      },
      selectCustomWallpaper: runtime.selectCustomWallpaper,
      previewCustomImage: runtime.previewCustomImage,
      commit: runtime.commit,
      cancel: runtime.cancel,
      deleteCustomWallpaper: runtime.deleteCustomWallpaper,
      subscribe: runtime.subscribe,
    });
    const dialogChoices = [];
    const dialogCalls = [];
    const dialogs = Object.freeze({
      async open(options) {
        dialogCalls.push(options);
        return dialogChoices.shift() ?? "cancel";
      },
      destroy() {},
    });

    personalizationApplication.mount({
      root,
      dialogs,
      personalization,
      app: { label: "外观设置", windowTitle: "C:\\IMAGEWEAVE\\DESKTOP.CPL" },
    });
    mounted = true;
    personalizationApplication.activate();

    const byDataset = (key, value = undefined) => root.find((element) => (
      Object.prototype.hasOwnProperty.call(element.dataset, key)
      && (value === undefined || element.dataset[key] === value)
    ));
    const accent = byDataset("personalizationThemeAccent");
    const surfaceInput = byDataset("personalizationThemeSurface");
    const windowOpacity = byDataset("personalizationWindowOpacity");
    const form = byDataset("personalizationForm");
    const apply = byDataset("personalizationAction", "apply");
    const cancel = byDataset("personalizationAction", "cancel");
    const reset = byDataset("personalizationAction", "reset");
    const contrastStatus = byDataset("personalizationThemeStatus");
    const saveStatus = byDataset("personalizationStatus");
    const maskStrengthOutput = root.find((element) => (
      element.getAttribute("id") === "personalization-mask-strength-value"
    ));
    const safeTheme = themeRoot.snapshot();

    const beforeChangeOnly = maskStrengthOutput.textContentWrites;
    accent.value = "#0065d1";
    root.emit("change", accent);
    assert.equal(calls.preview, 1, "change-only 第一色必须立即预览");
    assert.equal(maskStrengthOutput.textContentWrites, beforeChangeOnly);
    assert.equal(runtime.getState().draft.themeAccent, "#0065D1");
    assert.equal(runtime.getState().draft.themeSurface, "#F4F1EA");
    assert.equal(apply.disabled, false);

    surfaceInput.value = "#7e6425";
    root.emit("change", surfaceInput);
    assert.equal(calls.preview, 2, "change-only 低对比真实颜色对也必须立即预览");
    assert.equal(maskStrengthOutput.textContentWrites, beforeChangeOnly);
    assert.equal(runtime.getState().draft.themeAccent, "#0065D1");
    assert.equal(runtime.getState().draft.themeSurface, "#7E6425");
    assert.deepEqual(themeRoot.snapshot(), {
      themeAccent: "#0065D1",
      themeSurface: "#7E6425",
      tone: "dark",
    });
    assert.equal(apply.disabled, false, "低对比草稿必须保持 Apply enabled");
    assert.equal(accent.getAttribute("aria-invalid"), null);
    assert.equal(surfaceInput.getAttribute("aria-invalid"), null);
    assert.match(contrastStatus.textContent, /1\.01:1.*可正常使用/);
    root.emit("change", surfaceInput);
    assert.equal(calls.preview, 2, "相同规范化颜色对的重复 change 必须值级去重");
    assert.equal(maskStrengthOutput.textContentWrites, beforeChangeOnly);

    root.emit("click", cancel);
    calls.preview = 0;
    assert.deepEqual(themeRoot.snapshot(), safeTheme);
    assert.equal(accent.value, "#46515D");
    assert.equal(surfaceInput.value, "#F4F1EA");

    const beforeThemeInput = maskStrengthOutput.textContentWrites;
    accent.value = "#123";
    root.emit("input", accent);
    assert.equal(calls.preview, 0, "非法格式不得调用 runtime.preview");
    assert.equal(
      maskStrengthOutput.textContentWrites,
      beforeThemeInput,
      "主题 input 轻量刷新不得写无关表单输出",
    );
    assert.deepEqual(themeRoot.snapshot(), safeTheme, "非法格式不得改变根 Token");
    assert.equal(preferenceStorage.writes.length, 0);
    assert.equal(runtime.getState().dirty, false);
    assert.equal(accent.value, "#123");
    assert.equal(surfaceInput.value, "#F4F1EA");
    assert.equal(accent.getAttribute("aria-invalid"), "true");
    assert.equal(surfaceInput.getAttribute("aria-invalid"), "true");
    assert.equal(apply.disabled, true);
    assert.equal(cancel.disabled, false);
    assert.equal(root.dataset.dirty, "true");
    assert.match(contrastStatus.textContent, /颜色格式无效.*6 位十六进制颜色值/);
    assert.match(saveStatus.textContent, /颜色格式无效.*6 位十六进制颜色值/);

    const beforeUnload = [...(globalListeners.get("beforeunload") ?? [])][0];
    const unloadEvent = {
      returnValue: undefined,
      prevented: false,
      preventDefault() { this.prevented = true; },
    };
    beforeUnload(unloadEvent);
    assert.equal(unloadEvent.prevented, true);
    assert.equal(unloadEvent.returnValue, "");

    dialogChoices.push("cancel");
    assert.equal(await personalizationApplication.beforeLeave(), false);
    assert.match(dialogCalls.at(-1).message, /切换应用后将放弃/);
    assert.equal(accent.value, "#123", "取消离开继续保留非法格式表单值");

    windowOpacity.value = "soft";
    const beforeInvalidControlRefresh = maskStrengthOutput.textContentWrites;
    root.emit("change", windowOpacity);
    assert.equal(calls.preview, 0, "格式非法时其他控件不得绕过主题校验");
    assert.equal(runtime.getState().draft.windowOpacity, "solid");
    assert.equal(
      maskStrengthOutput.textContentWrites,
      beforeInvalidControlRefresh + 1,
      "格式非法时的非主题控件只按需完整刷新一次",
    );

    const beforeExternalPublish = maskStrengthOutput.textContentWrites;
    runtime.preview({ ...runtime.getState().draft, animations: "off" });
    assert.equal(
      maskStrengthOutput.textContentWrites,
      beforeExternalPublish + 1,
      "外部 runtime publish 仍须完整刷新一次",
    );
    assert.equal(accent.value, "#123", "外部 publish 不得覆盖非法格式表单值");
    assert.equal(surfaceInput.value, "#F4F1EA", "外部 publish 不得覆盖本地主题表单值");
    assert.equal(windowOpacity.value, "soft", "完整 DOM 表单调整应一并保留");

    const beforeAcceptedTheme = maskStrengthOutput.textContentWrites;
    accent.value = "#0065d1";
    root.emit("input", accent);
    assert.equal(calls.preview, 1, "修正为严格 HEX 后必须立即预览");
    surfaceInput.value = "#7e6425";
    root.emit("input", surfaceInput);
    assert.equal(calls.preview, 2, "真实低对比颜色对必须继续即时预览");
    assert.equal(
      maskStrengthOutput.textContentWrites,
      beforeAcceptedTheme,
      "同步 publish 回显与 accept 均不得完整刷新主题表单",
    );
    assert.equal(runtime.getState().draft.themeAccent, "#0065D1");
    assert.equal(runtime.getState().draft.themeSurface, "#7E6425");
    assert.equal(runtime.getState().draft.windowOpacity, "soft");
    assert.equal(runtime.getState().draft.animations, "on");
    assert.deepEqual(themeRoot.snapshot(), {
      themeAccent: "#0065D1",
      themeSurface: "#7E6425",
      tone: "dark",
    });
    assert.equal(accent.getAttribute("aria-invalid"), null);
    assert.equal(surfaceInput.getAttribute("aria-invalid"), null);
    assert.equal(apply.disabled, false);
    assert.equal(root.dataset.dirty, "true");
    assert.match(contrastStatus.textContent, /1\.01:1.*可正常使用/);

    root.emit("change", surfaceInput);
    assert.equal(calls.preview, 2, "input 后同值 change 不得重复 preview");
    assert.equal(maskStrengthOutput.textContentWrites, beforeAcceptedTheme);

    const submitEvent = root.emit("submit", form);
    assert.equal(submitEvent.defaultPrevented, true);
    await flushPromises();
    assert.equal(preferenceStorage.writes.length, 1, "完整 Apply 只写一次偏好");
    assert.deepEqual(preferenceStorage.writes[0], runtime.getState().committed);
    assert.equal(preferenceStorage.writes[0].themeAccent, "#0065D1");
    assert.equal(preferenceStorage.writes[0].themeSurface, "#7E6425");
    assert.equal(preferenceStorage.writes[0].windowOpacity, "soft");

    const committedTheme = themeRoot.snapshot();
    themeRoot.failNext("setProperty:--imageweave-surface");
    accent.value = "#F4F1EA";
    const beforePreviewError = maskStrengthOutput.textContentWrites;
    root.emit("input", accent);
    assert.equal(
      maskStrengthOutput.textContentWrites,
      beforePreviewError,
      "preview error 必须只刷新主题与相关按钮",
    );
    assert.deepEqual(themeRoot.snapshot(), committedTheme, "runtime setter 失败回滚根 Token");
    assert.equal(runtime.getState().draft.themeAccent, "#0065D1");
    assert.equal(runtime.getState().draft.themeSurface, "#7E6425");
    assert.equal(preferenceStorage.writes.length, 1);
    assert.equal(apply.disabled, true);
    assert.equal(root.dataset.dirty, "true");
    assert.match(saveStatus.textContent, /无法预览当前设置.*上次预览已保留/);

    const beforePublishAfterError = maskStrengthOutput.textContentWrites;
    runtime.preview({ ...runtime.getState().draft, animations: "off" });
    assert.equal(
      maskStrengthOutput.textContentWrites,
      beforePublishAfterError + 1,
      "异常后必须恢复订阅标志并接收后续外部 publish",
    );
    assert.equal(accent.value, "#F4F1EA", "外部 publish 仍保留 preview error 表单颜色");
    root.emit("click", cancel);

    accent.failNextValueWrite = true;
    windowOpacity.value = "solid";
    root.emit("change", windowOpacity);
    assert.deepEqual(themeRoot.snapshot(), committedTheme, "表单 setter 失败保留安全界面");
    assert.equal(runtime.getState().draft.windowOpacity, "solid");
    assert.equal(preferenceStorage.writes.length, 1);
    assert.equal(apply.disabled, true, "受控 DOM 回显错误不得继续提交");
    assert.equal(root.dataset.dirty, "true");
    assert.match(saveStatus.textContent, /无法显示部分设置.*当前预览已保留/);
    root.emit("click", cancel);

    accent.value = "#101010";
    root.emit("input", accent);
    root.emit("click", cancel);
    assert.equal(accent.value, "#0065D1");
    assert.equal(surfaceInput.value, "#7E6425");
    assert.equal(root.dataset.dirty, "false", "Cancel 恢复已提交真实颜色对");

    accent.value = "#101010";
    root.emit("input", accent);
    root.emit("click", reset);
    assert.equal(accent.value, "#46515D");
    assert.equal(surfaceInput.value, "#F4F1EA");
    assert.equal(runtime.getState().draft.themeAccent, "#46515D");
    assert.equal(runtime.getState().draft.themeSurface, "#F4F1EA");
    root.emit("click", cancel);

    accent.value = "#101010";
    root.emit("input", accent);
    dialogChoices.push("confirm");
    assert.equal(
      await personalizationApplication.beforeWindowHide(null, "minimized"),
      true,
    );
    assert.match(dialogCalls.at(-1).message, /最小化窗口/);
    assert.equal(accent.value, "#0065D1", "确认离开恢复已提交主题");
    assert.equal(surfaceInput.value, "#7E6425");

    windowOpacity.value = "solid";
    root.emit("change", windowOpacity);
    assert.equal(runtime.getState().dirty, true);
    accent.value = "#101010";
    root.emit("input", accent);
    personalizationApplication.deactivate();
    assert.equal(runtime.getState().dirty, false);
    assert.equal(windowOpacity.value, "soft", "deactivate 恢复最后提交的完整表单");
    personalizationApplication.activate();
    assert.equal(accent.value, "#0065D1", "重新 activate 回显最后提交主题");
    assert.equal(surfaceInput.value, "#7E6425");

    accent.value = "#101010";
    root.emit("input", accent);
    personalizationApplication.unmount();
    mounted = false;
    assert.equal(runtime.getState().dirty, false, "destroy 取消安全草稿");
    assert.equal(root.children.length, 0, "destroy 清除仅 DOM 中间态");
    assert.equal(globalListeners.get("beforeunload")?.size ?? 0, 0);
  } finally {
    if (mounted) personalizationApplication.unmount();
    runtime?.destroy();
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousNode === undefined) delete globalThis.Node;
    else globalThis.Node = previousNode;
    if (previousElement === undefined) delete globalThis.Element;
    else globalThis.Element = previousElement;
    if (previousButton === undefined) delete globalThis.HTMLButtonElement;
    else globalThis.HTMLButtonElement = previousButton;
    if (previousForm === undefined) delete globalThis.HTMLFormElement;
    else globalThis.HTMLFormElement = previousForm;
    if (previousAddEventListener === undefined) delete globalThis.addEventListener;
    else globalThis.addEventListener = previousAddEventListener;
    if (previousRemoveEventListener === undefined) delete globalThis.removeEventListener;
    else globalThis.removeEventListener = previousRemoveEventListener;
  }
});

test("图片输入以扩展名、MIME、签名和 15 MiB 上限共同判定", async () => {
  assert.deepEqual(WALLPAPER_IMAGE_LIMITS, {
    inputExtensions: ["jpg", "jpeg", "png", "webp"],
    inputMediaTypes: ["image/jpeg", "image/png", "image/webp"],
    outputMediaTypes: ["image/webp", "image/png"],
    maxInputBytes: 15 * 1024 * 1024,
    maxEdge: 4096,
    suggestedMinWidth: 320,
    suggestedMinHeight: 180,
    webpQuality: 0.88,
    version: 1,
  });

  for (const [file, mediaType] of [
    [localImageFile(JPEG_SIGNATURE_BYTES, { name: "wallpaper.JPG", type: "image/jpeg" }), "image/jpeg"],
    [localImageFile(JPEG_SIGNATURE_BYTES, { name: "wallpaper.jpeg", type: "image/jpeg" }), "image/jpeg"],
    [localImageFile(PNG_SIGNATURE_BYTES, { name: "wallpaper.png", type: "image/png" }), "image/png"],
    [localImageFile(webpSignatureBytes(), { name: "wallpaper.webp", type: "image/webp" }), "image/webp"],
  ]) {
    assert.deepEqual(await validateWallpaperImageInput(file), { mediaType });
  }

  const exactLimit = localImageFile(PNG_SIGNATURE_BYTES, {
    name: "limit.png",
    type: "image/png",
    size: WALLPAPER_IMAGE_LIMITS.maxInputBytes,
  });
  assert.deepEqual(await validateWallpaperImageInput(exactLimit), { mediaType: "image/png" });
  await assert.rejects(
    validateWallpaperImageInput(localImageFile(PNG_SIGNATURE_BYTES, {
      name: "too-large.png",
      type: "image/png",
      size: WALLPAPER_IMAGE_LIMITS.maxInputBytes + 1,
    })),
    (error) => error instanceof WallpaperImageImportError
      && error.code === "file_too_large"
      && !error.message.includes("too-large.png"),
  );

  const rejected = [
    [localImageFile(new TextEncoder().encode("<svg/>"), { name: "wallpaper.svg", type: "image/svg+xml" }), "unsupported_extension"],
    [localImageFile(GIF_SIGNATURE_BYTES, { name: "wallpaper.gif", type: "image/gif" }), "unsupported_extension"],
    [localImageFile(new TextEncoder().encode("video"), { name: "wallpaper.mp4", type: "video/mp4" }), "unsupported_extension"],
    [localImageFile(new TextEncoder().encode("<html>"), { name: "wallpaper.html", type: "text/html" }), "unsupported_extension"],
    [localImageFile(GIF_SIGNATURE_BYTES, { name: "forged.png", type: "image/png" }), "format_mismatch"],
    [localImageFile(PNG_SIGNATURE_BYTES, { name: "forged.jpg", type: "image/png" }), "format_mismatch"],
    [localImageFile(JPEG_SIGNATURE_BYTES, { name: "forged.png", type: "image/jpeg" }), "format_mismatch"],
    [localImageFile(PNG_SIGNATURE_BYTES, { name: "forged.png", type: "text/html" }), "unsupported_media_type"],
  ];
  for (const [file, code] of rejected) {
    await assert.rejects(validateWallpaperImageInput(file), (error) => {
      assert(error instanceof WallpaperImageImportError);
      assert.equal(error.code, code);
      assert.equal(error.message.includes(file.name), false);
      return true;
    });
  }

  assert.equal(
    await hasSafeWallpaperOutputSignature(
      new Blob([webpSignatureBytes()], { type: "image/webp" }),
      "image/webp",
    ),
    true,
  );
  assert.equal(
    await hasSafeWallpaperOutputSignature(
      new Blob([webpSignatureBytes({ animated: true })], { type: "image/webp" }),
      "image/webp",
    ),
    false,
  );
});

test("图片导入按正确尺寸有界缩放、静态重编码并只返回安全投影", async () => {
  assert.deepEqual(calculateWallpaperOutputDimensions(8000, 1000), {
    width: 4096,
    height: 512,
  });
  assert.deepEqual(calculateWallpaperOutputDimensions(1, 10000), {
    width: 1,
    height: 4096,
  });
  assert.deepEqual(calculateWallpaperOutputDimensions(4096, 180), {
    width: 4096,
    height: 180,
  });
  assert.throws(() => calculateWallpaperOutputDimensions(0, 180), TypeError);

  const privateName = "private-original-wallpaper.png";
  const file = localImageFile(PNG_SIGNATURE_BYTES, {
    name: privateName,
    type: "image/png",
  });
  let sourceWidth = 8000;
  let sourceHeight = 1000;
  const calls = [];
  const released = { decoded: 0, canvas: 0 };
  const adapter = {
    async decode() {
      calls.push(["decode"]);
      return {
        source: { originalFileName: privateName, laterFrames: [2, 3] },
        width: sourceWidth,
        height: sourceHeight,
      };
    },
    createCanvas(width, height) {
      calls.push(["canvas", width, height]);
      return { width, height };
    },
    draw(canvas, source, width, height) {
      calls.push(["draw", canvas.width, source.laterFrames.length, width, height]);
    },
    async encode(_canvas, mediaType, quality) {
      calls.push(["encode", mediaType, quality]);
      return new Blob([webpSignatureBytes()], { type: "image/webp" });
    },
    releaseDecoded() {
      released.decoded += 1;
    },
    releaseCanvas() {
      released.canvas += 1;
    },
  };

  const imported = await importWallpaperImage(file, { adapter });
  assert.deepEqual(Object.keys(imported), ["image", "warning"]);
  assert.deepEqual(Object.keys(imported.image), [
    "blob", "mediaType", "width", "height", "version",
  ]);
  assert.deepEqual({
    mediaType: imported.image.mediaType,
    width: imported.image.width,
    height: imported.image.height,
    version: imported.image.version,
    warning: imported.warning,
  }, {
    mediaType: "image/webp",
    width: 4096,
    height: 512,
    version: 1,
    warning: null,
  });
  assert.equal(Object.prototype.toString.call(imported.image.blob), "[object Blob]");
  assert.equal(Object.isFrozen(imported), true);
  assert.equal(Object.isFrozen(imported.image), true);
  assert.deepEqual(calls.slice(-3), [
    ["canvas", 4096, 512],
    ["draw", 4096, 2, 4096, 512],
    ["encode", "image/webp", 0.88],
  ]);
  assert.deepEqual(released, { decoded: 1, canvas: 1 });
  assert.equal(JSON.stringify(imported).includes(privateName), false);

  sourceWidth = 319;
  sourceHeight = 180;
  const small = await importWallpaperImage(file, { adapter });
  assert.equal(small.image.width, 319);
  assert.deepEqual(small.warning, {
    code: "small_dimensions",
    message: "图片尺寸低于建议的 320 × 180 像素，仍可继续使用。",
  });

  await assert.rejects(importWallpaperImage(file, {
    adapter: {
      ...adapter,
      async decode() {
        throw new Error("raw decoder detail");
      },
    },
  }), (error) => error instanceof WallpaperImageImportError
    && error.code === "decode_failed"
    && !error.message.includes("raw decoder detail"));
});

test("壁纸仓库记录采用严格 Blob 与字段白名单", () => {
  const blob = new Blob([PNG_SIGNATURE_BYTES], { type: "image/png" });
  const image = {
    blob,
    mediaType: "image/png",
    width: 4096,
    height: 2160,
    version: 1,
  };
  const projectedImage = projectWallpaperImportResult(image);
  assert.deepEqual(Object.keys(projectedImage), [
    "blob", "mediaType", "width", "height", "version",
  ]);
  assert.equal(Object.isFrozen(projectedImage), true);

  const record = { ...image, updatedAt: 1_700_000_000_000 };
  const projected = projectWallpaperRecord(record);
  assert.deepEqual(Object.keys(projected), [
    "blob", "mediaType", "width", "height", "updatedAt", "version",
  ]);
  assert.equal(projected.blob, blob);
  assert.equal(Object.isFrozen(projected), true);

  for (const invalid of [
    { ...record, originalFileName: "private.png" },
    { ...record, originalPath: "hidden" },
    { ...record, remoteSource: "https://example.invalid/wallpaper.png" },
    { ...record, blobUrl: "blob:https://example.invalid/private" },
    { ...record, width: 4097 },
    { ...record, height: 0 },
    { ...record, version: 2 },
    { ...record, updatedAt: 0 },
    { ...record, blob: new Blob([JPEG_SIGNATURE_BYTES], { type: "image/jpeg" }), mediaType: "image/jpeg" },
    { ...record, blob: new Blob([PNG_SIGNATURE_BYTES], { type: "image/png" }), mediaType: "image/webp" },
  ]) {
    assert.throws(() => projectWallpaperRecord(invalid), TypeError);
  }
  assert.throws(
    () => projectWallpaperImportResult({ ...image, updatedAt: record.updatedAt }),
    TypeError,
  );

  let getterCalled = false;
  const accessor = { ...record };
  Object.defineProperty(accessor, "width", {
    enumerable: true,
    get() {
      getterCalled = true;
      return 100;
    },
  });
  assert.throws(() => projectWallpaperRecord(accessor), TypeError);
  assert.equal(getterCalled, false);

  if (typeof File === "function") {
    const fileBlob = new File([PNG_SIGNATURE_BYTES], "private.png", { type: "image/png" });
    assert.throws(
      () => projectWallpaperImportResult({ ...image, blob: fileBlob }),
      TypeError,
    );
  }
});

test("壁纸仓库固定 schema、归一化错误且关闭后不泄漏连接行为", async () => {
  assert.deepEqual(WALLPAPER_STORAGE_SCHEMA, {
    databaseName: "imageweave-ui",
    databaseVersion: 1,
    storeName: "wallpapers",
    customKey: "custom",
  });
  const privateDetail = "private storage implementation detail";
  for (const [name, operation, code] of [
    ["QuotaExceededError", "write", "storage_quota_exceeded"],
    ["SecurityError", "open", "indexeddb_unavailable"],
    ["UnknownError", "read", "storage_read_failed"],
    ["AbortError", "delete", "storage_delete_failed"],
  ]) {
    const raw = new Error(privateDetail);
    raw.name = name;
    const normalized = normalizeWallpaperStorageError(raw, operation);
    assert(normalized instanceof WallpaperStorageError);
    assert.equal(normalized.code, code);
    assert.equal(normalized.message.includes(privateDetail), false);
  }

  const repository = createWallpaperStorage({ indexedDB: null });
  for (const method of [
    "open", "read", "write", "replace", "delete", "remove",
    "snapshot", "restore", "close", "destroy",
  ]) {
    assert.equal(typeof repository[method], "function", method);
  }
  await assert.rejects(repository.open(), (error) => (
    error instanceof WallpaperStorageError
    && error.code === "indexeddb_unavailable"
  ));
  repository.close();
  repository.destroy();
  await assert.rejects(repository.read(), (error) => (
    error instanceof WallpaperStorageError
    && error.code === "storage_closed"
  ));
});

test("Storage 只写固定命名空间白名单并区分 session/local", () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const storage = createStorageService({ localStorage: local, sessionStorage: session });
  assert.equal(storage.writeCurrentApp("review"), true);
  assert.equal(storage.writeActiveBatchId("batch-123"), true);
  const savedLayout = [windowRecord("review", "normal")];
  assert.equal(storage.writeWindowLayout(savedLayout), true);
  assert.equal(storage.writeUiPreferences({ taskbarDensity: "compact" }), true);

  assert.deepEqual([...session.values.keys()].sort(), [
    STORAGE_KEYS.activeBatch,
    STORAGE_KEYS.currentApp,
  ].sort());
  assert.deepEqual([...local.values.keys()].sort(), [
    STORAGE_KEYS.uiPreferences,
    STORAGE_KEYS.windowLayout,
  ].sort());
  assert.equal(storage.readCurrentApp(), "review");
  assert.equal(storage.readActiveBatchId(), "batch-123");
  assert.deepEqual(storage.readWindowLayout({ width: 1280, height: 720 }), savedLayout);
  assert.deepEqual(storage.readUiPreferences(), {
    ...PERSONALIZATION_DEFAULTS,
    taskbarDensity: "compact",
  });
  assert.equal(storage.setItem, undefined);
  assert.equal(storage.getItem, undefined);
});

test("Storage 迁移动效旧值并对损坏字段逐项回退", () => {
  for (const [storedAnimations, expectedAnimations] of [
    ["system", "on"],
    ["reduced", "off"],
    ["unexpected", "on"],
    [undefined, "on"],
  ]) {
    const local = new MemoryStorage();
    const stored = {
      wallpaperFit: "contain",
      wallpaperColor: "url(https://example.invalid/wallpaper.png)",
      wallpaperMaskStrength: 42,
      taskbarDensity: "compact",
      unknown: "discarded",
    };
    if (storedAnimations !== undefined) stored.animations = storedAnimations;
    local.values.set(STORAGE_KEYS.uiPreferences, JSON.stringify(stored));
    const storage = createStorageService({
      localStorage: local,
      sessionStorage: new MemoryStorage(),
    });

    const expected = {
      ...PERSONALIZATION_DEFAULTS,
      animations: expectedAnimations,
      wallpaperFit: "contain",
      taskbarDensity: "compact",
    };
    assert.deepEqual(storage.readUiPreferences(), expected);
    assert.deepEqual(JSON.parse(local.values.get(STORAGE_KEYS.uiPreferences)), expected);
  }

  for (const { storedTheme, expectedTheme } of [
    {
      storedTheme: { themeAccent: "#ffffff", themeSurface: "#101010" },
      expectedTheme: { themeAccent: "#FFFFFF", themeSurface: "#101010" },
    },
    {
      storedTheme: { themeAccent: "#0065d1", themeSurface: "#7e6425" },
      expectedTheme: { themeAccent: "#0065D1", themeSurface: "#7E6425" },
    },
    {
      storedTheme: { themeAccent: "#777777", themeSurface: "#FFFFFF" },
      expectedTheme: { themeAccent: "#777777", themeSurface: "#FFFFFF" },
    },
    {
      storedTheme: { themeAccent: "#1234", themeSurface: "#101010" },
      expectedTheme: INTERFACE_THEME_DEFAULTS,
    },
  ]) {
    const local = new MemoryStorage();
    local.values.set(STORAGE_KEYS.uiPreferences, JSON.stringify({
      animations: "off",
      wallpaperFit: "contain",
      taskbarDensity: "compact",
      ...storedTheme,
    }));
    const storage = createStorageService({
      localStorage: local,
      sessionStorage: new MemoryStorage(),
    });
    const expected = {
      ...PERSONALIZATION_DEFAULTS,
      animations: "off",
      wallpaperFit: "contain",
      ...expectedTheme,
      taskbarDensity: "compact",
    };
    assert.deepEqual(storage.readUiPreferences(), expected);
    assert.deepEqual(JSON.parse(local.values.get(STORAGE_KEYS.uiPreferences)), expected);
  }

  const empty = createStorageService({
    localStorage: new MemoryStorage(),
    sessionStorage: new MemoryStorage(),
  });
  assert.deepEqual(empty.readUiPreferences(), PERSONALIZATION_DEFAULTS);
});

test("Storage 严格写入完整安全对象并拒绝图片载荷、路径、URL 与未知字段", () => {
  assert.equal(isValidBatchId("batch:abc-123"), true);
  assert.equal(isValidBatchId("../private"), false);
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const storage = createStorageService({ localStorage: local, sessionStorage: session });
  assert.throws(() => storage.writeCurrentApp("unknown"), TypeError);
  assert.throws(() => storage.writeActiveBatchId("bad/path"), TypeError);
  assert.throws(
    () => storage.writeWindowLayout([windowRecord("unknown")]),
    TypeError,
  );
  assert.throws(
    () => storage.writeWindowLayout([{ ...windowRecord("review"), backendUrl: "/api/private" }]),
    TypeError,
  );

  const safePreferences = {
    ...PERSONALIZATION_DEFAULTS,
    animations: "off",
    wallpaperKind: "custom",
    wallpaperColor: "warm-paper",
    wallpaperFit: "stretch",
    wallpaperPosition: "bottom-right",
    wallpaperMaskTone: "light",
    wallpaperMaskStrength: 80,
    wallpaperBlur: "medium",
    windowOpacity: "soft",
    taskbarDensity: "comfortable",
  };
  const lowercaseThemePreferences = {
    ...safePreferences,
    themeAccent: "#0065d1",
    themeSurface: "#7e6425",
  };
  assert.equal(storage.writeUiPreferences(lowercaseThemePreferences), true);
  assert.deepEqual(
    JSON.parse(local.values.get(STORAGE_KEYS.uiPreferences)),
    {
      ...lowercaseThemePreferences,
      themeAccent: "#0065D1",
      themeSurface: "#7E6425",
    },
  );

  assert.equal(storage.writeUiPreferences(safePreferences), true);
  assert.deepEqual(
    JSON.parse(local.values.get(STORAGE_KEYS.uiPreferences)),
    safePreferences,
  );
  const serializedSafePreferences = local.values.get(STORAGE_KEYS.uiPreferences);

  const unsafePreferences = [
    { ...safePreferences, animations: "system" },
    { ...safePreferences, wallpaperMaskStrength: -5 },
    { ...safePreferences, wallpaperMaskStrength: 42 },
    { ...safePreferences, wallpaperMaskStrength: 85 },
    { ...safePreferences, wallpaperColor: "data:image/png;base64,AAAA" },
    { ...safePreferences, wallpaperColor: "blob:https://example.invalid/private" },
    { ...safePreferences, wallpaperColor: "https://example.invalid/wallpaper.png" },
    { ...safePreferences, wallpaperCss: "url(https://example.invalid/a.png)" },
    { ...safePreferences, wallpaperData: "QUFBQQ==" },
    { ...safePreferences, originalFileName: "private-wallpaper.png" },
    { ...safePreferences, originalPath: "/home/user/private-wallpaper.png" },
    { ...safePreferences, wallpaperPayload: { bytes: [1, 2, 3] } },
    { ...safePreferences, themeAccent: "#FFFFFF80", themeSurface: "#101010" },
    { ...safePreferences, themeAccent: "#FFF", themeSurface: "#101010" },
    { ...safePreferences, themeAccent: "var(--unsafe)", themeSurface: "#101010" },
    { ...safePreferences, themeAccent: "red", themeSurface: "#FFFFFF" },
    { ...safePreferences, taskbarDensity: "dense" },
  ];
  if (typeof Blob === "function") {
    unsafePreferences.push(new Blob(["unsafe"], { type: "image/png" }));
    unsafePreferences.push({ ...safePreferences, wallpaperBlob: new Blob(["unsafe"]) });
  }
  if (typeof File === "function") {
    unsafePreferences.push(new File(["unsafe"], "private.png", { type: "image/png" }));
    unsafePreferences.push({
      ...safePreferences,
      wallpaperFile: new File(["unsafe"], "private.png", { type: "image/png" }),
    });
  }
  for (const unsafe of unsafePreferences) {
    assert.throws(() => storage.writeUiPreferences(unsafe), TypeError);
  }

  let getterCalled = false;
  const accessorPreferences = { ...safePreferences };
  Object.defineProperty(accessorPreferences, "wallpaperColor", {
    enumerable: true,
    get() {
      getterCalled = true;
      return "forest";
    },
  });
  assert.throws(() => storage.writeUiPreferences(accessorPreferences), TypeError);
  assert.equal(getterCalled, false);
  assert.equal(local.values.get(STORAGE_KEYS.uiPreferences), serializedSafePreferences);
});

test("Storage 兼容不可用或损坏的浏览器存储并自愈偏好 JSON", () => {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  const storage = createStorageService({ localStorage: local, sessionStorage: session });
  session.values.set(STORAGE_KEYS.currentApp, "invalid-app");
  session.values.set(STORAGE_KEYS.activeBatch, "bad/path");
  local.values.set(STORAGE_KEYS.windowLayout, "not-json");
  local.values.set(STORAGE_KEYS.uiPreferences, "{broken-json");
  assert.equal(storage.readCurrentApp(), null);
  assert.equal(storage.readActiveBatchId(), null);
  assert.deepEqual(
    storage.readWindowLayout({ width: 800, height: 600 }),
    [windowRecord("crawl", "normal", { x: 160, y: 40, w: 800, h: 560 })],
  );
  assert.deepEqual(storage.readUiPreferences(), PERSONALIZATION_DEFAULTS);
  assert.deepEqual(
    JSON.parse(local.values.get(STORAGE_KEYS.uiPreferences)),
    PERSONALIZATION_DEFAULTS,
  );

  const unavailable = createStorageService({
    localStorage: new MemoryStorage({ throws: true }),
    sessionStorage: new MemoryStorage({ throws: true }),
  });
  assert.equal(unavailable.readCurrentApp(), null);
  assert.equal(unavailable.writeCurrentApp("crawl"), false);
  assert.deepEqual(
    unavailable.readWindowLayout({ width: 800, height: 600 }),
    [windowRecord("crawl", "normal", { x: 160, y: 40, w: 800, h: 560 })],
  );
  assert.equal(unavailable.writeWindowLayout([windowRecord("crawl")]), false);
  assert.deepEqual(unavailable.readUiPreferences(), PERSONALIZATION_DEFAULTS);
  assert.equal(unavailable.writeUiPreferences(PERSONALIZATION_DEFAULTS), false);
});

test("动效控制器落实系统覆盖且切换时保留完整个性化偏好", () => {
  const retainedPreferences = {
    ...PERSONALIZATION_DEFAULTS,
    wallpaperColor: "plum-gray",
    wallpaperFit: "tile",
    wallpaperPosition: "top-left",
    wallpaperMaskTone: "light",
    wallpaperMaskStrength: 75,
    wallpaperBlur: "soft",
    windowOpacity: "subtle",
    taskbarDensity: "compact",
  };
  const local = new MemoryStorage();
  local.values.set(STORAGE_KEYS.uiPreferences, JSON.stringify(retainedPreferences));
  const storage = createStorageService({
    localStorage: local,
    sessionStorage: new MemoryStorage(),
  });
  const root = new FakeRootElement();
  const mediaQuery = new FakeMediaQueryList(true);
  let requestedQuery = "";
  const controller = createMotionController({
    root,
    storage,
    matchMedia(query) {
      requestedQuery = query;
      return mediaQuery;
    },
  });

  assert.equal(requestedQuery, MOTION_MEDIA_QUERY);
  assert.deepEqual(controller.getState(), {
    userMode: "on",
    systemReduced: true,
    effective: false,
    limitedBySystem: true,
  });
  assert.equal(root.getAttribute("data-motion"), "on");
  assert.equal(root.getAttribute("data-motion-effective"), "off");
  assert.equal(root.getAttribute("data-motion-limited"), "true");

  const observed = [];
  const unsubscribe = controller.subscribe((state) => observed.push(state));
  assert.equal(controller.setUserMode("off"), true);
  assert.equal(root.getAttribute("data-motion"), "off");
  assert.equal(root.getAttribute("data-motion-limited"), "false");
  assert.deepEqual(
    JSON.parse(local.values.get(STORAGE_KEYS.uiPreferences)),
    { ...retainedPreferences, animations: "off" },
  );

  mediaQuery.setMatches(false);
  assert.equal(controller.getState().effective, false);
  assert.equal(controller.setUserMode("on"), true);
  assert.equal(controller.getState().effective, true);
  assert.equal(root.getAttribute("data-motion-effective"), "on");
  assert.deepEqual(
    JSON.parse(local.values.get(STORAGE_KEYS.uiPreferences)),
    retainedPreferences,
  );

  mediaQuery.setMatches(true);
  assert.equal(controller.getState().limitedBySystem, true);
  assert.equal(root.getAttribute("data-motion-effective"), "off");
  assert.equal(observed.length, 4);
  assert.throws(() => controller.setUserMode("system"), TypeError);
  assert.throws(() => controller.setUserMode("reduced"), TypeError);

  unsubscribe();
  controller.destroy();
  assert.equal(mediaQuery.listeners.size, 0);
  mediaQuery.setMatches(false);
  assert.equal(root.getAttribute("data-motion-limited"), "true");
});

test("动效控制器初始化失败时使用安全默认值且不阻断调用方", () => {
  let controller;
  assert.doesNotThrow(() => {
    controller = createMotionController({
      root: { setAttribute() { throw new Error("root unavailable"); } },
      storage: {
        readUiPreferences() { throw new Error("storage unavailable"); },
        writeUiPreferences() { throw new Error("storage unavailable"); },
      },
      matchMedia() { throw new Error("media query unavailable"); },
    });
  });
  assert.deepEqual(controller.getState(), {
    userMode: "on",
    systemReduced: false,
    effective: true,
    limitedBySystem: false,
  });
  assert.equal(controller.setUserMode("off"), false);
  assert.doesNotThrow(() => controller.destroy());
});

test("G1 任意对比主题随预览、提交与存储恢复同步应用", async () => {
  const preferenceStorage = createPersonalizationStorageFixture(
    PERSONALIZATION_DEFAULTS,
  );
  const themeRoot = new FakeThemeRoot();
  const runtime = createPersonalizationRuntime({
    themeRoot,
    storage: preferenceStorage.service,
  });

  assert.deepEqual(runtime.getState().committed, PERSONALIZATION_DEFAULTS);
  assert.deepEqual(themeRoot.snapshot(), {
    themeAccent: "#46515D",
    themeSurface: "#F4F1EA",
    tone: "light",
  });
  assert.equal(preferenceStorage.writes.length, 0, "同步恢复不得写存储");
  await runtime.ready();

  const beforeRejectedPreview = themeRoot.snapshot();
  assert.throws(() => runtime.preview({
    ...runtime.getState().draft,
    themeAccent: "#0065D180",
    themeSurface: "#7E6425",
  }), TypeError);
  assert.deepEqual(themeRoot.snapshot(), beforeRejectedPreview);
  assert.equal(preferenceStorage.writes.length, 0, "非法格式不得预览或写存储");

  let state = runtime.preview({
    ...runtime.getState().draft,
    themeAccent: "#0065d1",
    themeSurface: "#7e6425",
  });
  assert.equal(state.draft.themeAccent, "#0065D1");
  assert.equal(state.draft.themeSurface, "#7E6425");
  assert.equal(state.dirty, true);
  assert.deepEqual(themeRoot.snapshot(), {
    themeAccent: "#0065D1",
    themeSurface: "#7E6425",
    tone: "dark",
  });
  assert.equal(preferenceStorage.writes.length, 0, "低对比主题预览不得写存储");

  state = runtime.cancel();
  assert.equal(state.dirty, false);
  assert.deepEqual(themeRoot.snapshot(), {
    themeAccent: "#46515D",
    themeSurface: "#F4F1EA",
    tone: "light",
  });

  runtime.preview({
    ...state.draft,
    themeAccent: "#0065d1",
    themeSurface: "#7e6425",
  });
  const committed = await runtime.commit();
  assert.equal(committed.ok, true);
  assert.equal(committed.state.committed.themeAccent, "#0065D1");
  assert.equal(committed.state.committed.themeSurface, "#7E6425");
  assert.deepEqual(themeRoot.snapshot(), {
    themeAccent: "#0065D1",
    themeSurface: "#7E6425",
    tone: "dark",
  });
  assert.equal(preferenceStorage.writes.length, 1);
  assert.equal(preferenceStorage.current().themeAccent, "#0065D1");
  assert.equal(preferenceStorage.current().themeSurface, "#7E6425");

  state = runtime.preview(restoreDefaultPersonalizationPreferences());
  assert.equal(state.dirty, true);
  assert.deepEqual(themeRoot.snapshot(), {
    themeAccent: "#46515D",
    themeSurface: "#F4F1EA",
    tone: "light",
  });
  state = runtime.cancel();
  assert.equal(state.draft.themeAccent, "#0065D1");
  assert.equal(state.draft.themeSurface, "#7E6425");

  runtime.preview({
    ...state.draft,
    themeAccent: "#101010",
    themeSurface: "#101010",
  });
  assert.deepEqual(themeRoot.snapshot(), {
    themeAccent: "#101010",
    themeSurface: "#101010",
    tone: "dark",
  });
  runtime.destroy();
  assert.deepEqual(themeRoot.snapshot(), {
    themeAccent: "#0065D1",
    themeSurface: "#7E6425",
    tone: "dark",
  });

  const restoredRoot = new FakeThemeRoot();
  const restoredRuntime = createPersonalizationRuntime({
    themeRoot: restoredRoot,
    storage: preferenceStorage.service,
  });
  assert.equal(restoredRuntime.getState().committed.themeAccent, "#0065D1");
  assert.equal(restoredRuntime.getState().committed.themeSurface, "#7E6425");
  assert.deepEqual(restoredRoot.snapshot(), {
    themeAccent: "#0065D1",
    themeSurface: "#7E6425",
    tone: "dark",
  });
  await restoredRuntime.ready();
  assert.equal(preferenceStorage.writes.length, 1, "重新读取不得额外写存储");
  restoredRuntime.destroy();
});

test("主题-only 预览只应用 Token，等值草稿 no-op，混合字段仍完整应用", async () => {
  const preferenceStorage = createPersonalizationStorageFixture(
    PERSONALIZATION_DEFAULTS,
  );
  const surface = createWallpaperSurfaceFixture();
  const themeRoot = new FakeThemeRoot();
  let motionMode = "on";
  const motionCalls = [];
  const motion = Object.freeze({
    getState() {
      return {
        userMode: motionMode,
        systemReduced: false,
        effective: motionMode === "on",
        limitedBySystem: false,
      };
    },
    previewUserMode(mode) {
      motionMode = mode;
      motionCalls.push(mode);
    },
    subscribe() {
      return () => {};
    },
  });
  const runtime = createPersonalizationRuntime({
    wallpaper: surface.wallpaper,
    wallpaperImage: surface.image,
    wallpaperMask: surface.mask,
    windowLayer: surface.windowLayer,
    themeRoot,
    storage: preferenceStorage.service,
    motion,
    urlApi: surface.urlApi,
  });
  await runtime.ready();

  let publishes = 0;
  const unsubscribe = runtime.subscribe(() => { publishes += 1; });
  const unrelatedOperations = () => ({
    wallpaperClasses: surface.wallpaper.classList.operations.length,
    imageSourceClears: surface.calls.clearImageSource,
    backgroundImageClears: surface.calls.clearBackgroundImage,
    windowClasses: surface.windowLayer.classList.operations.length,
    motion: motionCalls.length,
  });

  const beforeTheme = unrelatedOperations();
  let state = runtime.preview({
    ...runtime.getState().draft,
    themeAccent: "#0065d1",
    themeSurface: "#7e6425",
  });
  assert.equal(publishes, 1);
  assert.equal(state.draft.themeAccent, "#0065D1");
  assert.equal(state.draft.themeSurface, "#7E6425");
  assert.deepEqual(unrelatedOperations(), beforeTheme, "主题快路径不得触碰非主题运行时");
  assert.deepEqual(themeRoot.snapshot(), {
    themeAccent: "#0065D1",
    themeSurface: "#7E6425",
    tone: "dark",
  });

  const beforeNoOp = {
    unrelated: unrelatedOperations(),
    theme: themeRoot.operations.length,
  };
  state = runtime.preview({
    ...state.draft,
    themeAccent: "#0065d1",
    themeSurface: "#7e6425",
  });
  assert.equal(publishes, 1, "等值完整草稿不得再次 publish");
  assert.deepEqual(unrelatedOperations(), beforeNoOp.unrelated);
  assert.equal(themeRoot.operations.length, beforeNoOp.theme, "等值草稿不得重写 Token");

  const beforeMixed = unrelatedOperations();
  state = runtime.preview({
    ...state.draft,
    animations: "off",
    wallpaperColor: "forest",
    windowOpacity: "soft",
    themeAccent: "#46515D",
    themeSurface: "#F4F1EA",
  });
  assert.equal(publishes, 2);
  assert.equal(state.draft.wallpaperColor, "forest");
  assert.equal(state.draft.windowOpacity, "soft");
  assert.ok(
    surface.wallpaper.classList.operations.length > beforeMixed.wallpaperClasses,
    "混合草稿必须重做壁纸固定类",
  );
  assert.ok(surface.calls.clearImageSource > beforeMixed.imageSourceClears);
  assert.ok(surface.calls.clearBackgroundImage > beforeMixed.backgroundImageClears);
  assert.ok(
    surface.windowLayer.classList.operations.length > beforeMixed.windowClasses,
    "混合草稿必须应用窗口透明度类",
  );
  assert.ok(motionCalls.length > beforeMixed.motion, "混合草稿必须应用动效");
  assert.equal(preferenceStorage.writes.length, 0, "所有预览路径均不得写 LocalStorage");

  unsubscribe();
  runtime.destroy();
});

test("G1 界面主题 setter 部分失败时原子回滚且启动继续使用 CSS 回退", () => {
  const startupRoot = new FakeThemeRoot();
  startupRoot.failNext("setProperty:--imageweave-surface");
  let startupRuntime;
  assert.doesNotThrow(() => {
    startupRuntime = createPersonalizationRuntime({
      themeRoot: startupRoot,
      storage: createPersonalizationStorageFixture(PERSONALIZATION_DEFAULTS).service,
    });
  });
  assert.deepEqual(startupRoot.snapshot(), {
    themeAccent: "",
    themeSurface: "",
    tone: "light",
  });
  assert.deepEqual(startupRuntime.getState().draft, PERSONALIZATION_DEFAULTS);
  startupRuntime.destroy();

  const themeRoot = new FakeThemeRoot();
  const runtime = createPersonalizationRuntime({
    themeRoot,
    storage: createPersonalizationStorageFixture(PERSONALIZATION_DEFAULTS).service,
  });
  const previous = themeRoot.snapshot();
  themeRoot.failNext("setAttribute:data-theme-tone");
  assert.throws(() => runtime.preview({
    ...runtime.getState().draft,
    themeAccent: "#FFFFFF",
    themeSurface: "#101010",
  }), /外观预览暂时无法应用/);
  assert.deepEqual(themeRoot.snapshot(), previous);
  assert.deepEqual(runtime.getState().draft, PERSONALIZATION_DEFAULTS);
  assert.equal(runtime.getState().dirty, false);
  assert.equal(
    themeRoot.operations.some((operation) => (
      operation[0] === "setAttribute"
      && operation[2] === "dark"
    )),
    true,
  );
  runtime.destroy();
});

test("个性化运行时只预览受控类，单次提交持久化，取消与失败恢复基线", async () => {
  const savedPreferences = {
    ...PERSONALIZATION_DEFAULTS,
    animations: "off",
    wallpaperColor: "slate",
    taskbarDensity: "compact",
  };
  const local = new MemoryStorage();
  local.values.set(STORAGE_KEYS.uiPreferences, JSON.stringify(savedPreferences));
  const storage = createStorageService({
    localStorage: local,
    sessionStorage: new MemoryStorage(),
  });
  const motionRoot = new FakeRootElement();
  const mediaQuery = new FakeMediaQueryList(false);
  const motion = createMotionController({
    root: motionRoot,
    storage,
    matchMedia: () => mediaQuery,
  });
  const classList = new FakeClassList([
    WALLPAPER_COLOR_CLASSES.graphite,
    "desktop-wallpaper-unrelated",
  ]);
  const runtime = createPersonalizationRuntime({
    wallpaper: { classList },
    storage,
    motion,
  });

  assert.equal(classList.contains(WALLPAPER_COLOR_CLASSES.slate), true);
  assert.equal(classList.contains(WALLPAPER_COLOR_CLASSES.graphite), false);
  assert.equal(classList.contains("desktop-wallpaper-unrelated"), true);
  assert.equal(motionRoot.getAttribute("data-motion"), "off");
  assert.equal(local.setCalls, 0);

  mediaQuery.setMatches(true);
  let state = runtime.preview({
    ...runtime.getState().draft,
    animations: "on",
    wallpaperKind: "color",
    wallpaperColor: "forest",
  });
  assert.equal(state.dirty, true);
  assert.equal(classList.contains(WALLPAPER_COLOR_CLASSES.forest), true);
  assert.equal(local.setCalls, 0, "预览不得写 LocalStorage");
  assert.deepEqual(
    deriveMotionLimitationState(state.draft.animations, state.motion),
    { limited: true, message: MOTION_LIMITATION_MESSAGE },
  );

  state = runtime.cancel();
  assert.equal(state.dirty, false);
  assert.equal(state.draft.wallpaperColor, "slate");
  assert.equal(classList.contains(WALLPAPER_COLOR_CLASSES.slate), true);
  assert.equal(motionRoot.getAttribute("data-motion"), "off");
  assert.equal(local.setCalls, 0, "取消不得写 LocalStorage");
  assert.deepEqual(
    deriveMotionLimitationState(state.draft.animations, state.motion),
    { limited: false, message: "" },
  );

  runtime.preview({
    ...state.draft,
    animations: "on",
    wallpaperColor: "plum-gray",
  });
  const committed = await runtime.commit();
  assert.equal(committed.ok, true);
  assert.equal(committed.code, "saved");
  assert.equal(committed.state.dirty, false);
  assert.equal(local.setCalls, 1, "动效和纯色必须由一次原子偏好写入提交");
  assert.deepEqual(JSON.parse(local.values.get(STORAGE_KEYS.uiPreferences)), {
    ...PERSONALIZATION_DEFAULTS,
    animations: "on",
    wallpaperColor: "plum-gray",
    taskbarDensity: "compact",
  });

  runtime.preview({
    ...committed.state.draft,
    animations: "off",
    wallpaperColor: "warm-paper",
  });
  const persistedBeforeFailure = local.values.get(STORAGE_KEYS.uiPreferences);
  local.throws = true;
  const failed = await runtime.commit();
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "preference_storage_unavailable");
  assert.equal(failed.state.dirty, true);
  assert.equal(failed.state.committed.wallpaperColor, "plum-gray");
  assert.equal(failed.state.draft.wallpaperColor, "warm-paper");
  assert.equal(local.values.get(STORAGE_KEYS.uiPreferences), persistedBeforeFailure);

  runtime.destroy();
  assert.equal(classList.contains(WALLPAPER_COLOR_CLASSES["plum-gray"]), true);
  assert.equal(motionRoot.getAttribute("data-motion"), "on");
  motion.destroy();
});

test("E1 受控类实时映射并在平铺全生命周期先断开再撤销 URL", async () => {
  const initialPreferences = {
    ...PERSONALIZATION_DEFAULTS,
    wallpaperKind: "custom",
    wallpaperColor: "warm-paper",
    wallpaperFit: "contain",
    wallpaperPosition: "bottom-right",
    wallpaperMaskTone: "light",
    wallpaperMaskStrength: 75,
    wallpaperBlur: "soft",
    windowOpacity: "subtle",
  };
  const stored = storedWallpaperFixture(importedWallpaperFixture(8));
  const preferenceStorage = createPersonalizationStorageFixture(initialPreferences);
  const wallpaperRepository = createWallpaperRepositoryFixture(stored);
  const surface = createWallpaperSurfaceFixture();
  const runtime = createPersonalizationRuntime({
    wallpaper: surface.wallpaper,
    wallpaperImage: surface.image,
    windowLayer: surface.windowLayer,
    storage: preferenceStorage.service,
    wallpaperStorage: wallpaperRepository.repository,
    decodeWallpaperBlob: async () => ({ width: 640, height: 360 }),
    urlApi: surface.urlApi,
  });

  assert.deepEqual(Object.keys(PERSONALIZATION_RUNTIME_CLASS_MAPS), [
    "wallpaperFit",
    "wallpaperPosition",
    "wallpaperMaskTone",
    "wallpaperMaskStrength",
    "wallpaperBlur",
    "windowOpacity",
  ]);
  for (const [field, classMap] of Object.entries(PERSONALIZATION_RUNTIME_CLASS_MAPS)) {
    assert.deepEqual(
      Object.keys(classMap),
      PERSONALIZATION_OPTIONS[field].map(String),
      `${field} 必须与安全模型白名单一一对应`,
    );
    assert.equal(Object.isFrozen(classMap), true, field);
    assert.equal(
      Object.values(classMap).every((className) => /^[a-z0-9-]+$/.test(className)),
      true,
      field,
    );
  }

  const assertRuntimeClasses = (state) => {
    for (const field of [
      "wallpaperFit",
      "wallpaperPosition",
      "wallpaperMaskTone",
      "wallpaperMaskStrength",
      "wallpaperBlur",
    ]) {
      const classMap = PERSONALIZATION_RUNTIME_CLASS_MAPS[field];
      assert.equal(
        surface.wallpaper.classList.contains(classMap[state.draft[field]]),
        true,
        field,
      );
      assert.equal(
        Object.values(classMap).filter(
          (className) => surface.wallpaper.classList.contains(className),
        ).length,
        1,
        field,
      );
    }
    const opacityClasses = PERSONALIZATION_RUNTIME_CLASS_MAPS.windowOpacity;
    assert.equal(
      surface.windowLayer.classList.contains(opacityClasses[state.draft.windowOpacity]),
      true,
    );
    assert.equal(
      Object.values(opacityClasses).filter(
        (className) => surface.windowLayer.classList.contains(className),
      ).length,
      1,
    );
  };
  const assertDetachedBeforeRevoked = (objectUrl, clearKind) => {
    const clearIndex = surface.events.findIndex(
      ([kind, value]) => kind === clearKind && value.includes(objectUrl),
    );
    const revokeIndex = surface.events.findIndex(
      ([kind, value]) => kind === "revoke" && value === objectUrl,
    );
    assert(clearIndex >= 0, `${objectUrl} 缺少 ${clearKind}`);
    assert(revokeIndex > clearIndex, `${objectUrl} 必须先断开 DOM 引用再 revoke`);
  };

  let state = await runtime.ready();
  const firstUrl = surface.image.src;
  assert.equal(firstUrl, "blob:wallpaper-fixture/1");
  assert.equal(surface.image.style.backgroundImage, "");
  assert.equal(surface.mask.hidden, false);
  assert.equal(surface.wallpaper.classList.contains(WALLPAPER_CUSTOM_CLASS), true);
  assert.equal(surface.wallpaper.classList.contains(WALLPAPER_COLOR_CLASSES.graphite), true);
  assertRuntimeClasses(state);

  assert.throws(() => runtime.preview({
    ...state.draft,
    wallpaperFit: 'url("https://example.invalid/wallpaper")',
  }), TypeError);
  assert.equal(surface.image.src, firstUrl);

  state = runtime.preview({
    ...state.draft,
    wallpaperFit: "tile",
    wallpaperPosition: "top-left",
    wallpaperMaskTone: "dark",
    wallpaperMaskStrength: 80,
    wallpaperBlur: "medium",
    windowOpacity: "soft",
  });
  assertRuntimeClasses(state);
  assert.equal(state.draft.wallpaperPosition, "top-left", "平铺不得损坏九宫格存储值");
  assert.equal(surface.image.src, "");
  assert.equal(surface.image.style.backgroundImage, `url(${JSON.stringify(firstUrl)})`);
  assert.deepEqual(surface.revoked, [], "同一图片切换 fit 不应撤销仍在使用的 URL");

  const replacement = importedWallpaperFixture(9);
  assert.equal((await runtime.previewCustomImage(replacement)).ok, true);
  const secondUrl = surface.created[1].url;
  assert.equal(surface.image.style.backgroundImage, `url(${JSON.stringify(secondUrl)})`);
  assertDetachedBeforeRevoked(firstUrl, "clear-background");

  state = runtime.cancel();
  const restoredUrl = surface.image.src;
  assert.equal(state.draft.wallpaperFit, "contain");
  assert.equal(state.draft.windowOpacity, "subtle");
  assert.equal(surface.image.style.backgroundImage, "");
  assert.equal(restoredUrl, "blob:wallpaper-fixture/3");
  assertDetachedBeforeRevoked(secondUrl, "clear-background");
  assertRuntimeClasses(state);

  state = runtime.preview({
    ...state.draft,
    wallpaperFit: "tile",
    wallpaperPosition: "top-left",
    wallpaperMaskTone: "dark",
    wallpaperMaskStrength: 80,
    wallpaperBlur: "medium",
    windowOpacity: "soft",
  });
  const committed = await runtime.commit();
  assert.equal(committed.ok, true);
  assert.equal(committed.state.committed.wallpaperFit, "tile");
  assert.equal(committed.state.committed.wallpaperPosition, "top-left");
  assertRuntimeClasses(committed.state);

  const deleted = await runtime.deleteCustomWallpaper();
  assert.equal(deleted.ok, true);
  assert.equal(deleted.state.draft.wallpaperKind, "color");
  assert.equal(deleted.state.draft.wallpaperFit, "tile");
  assert.equal(deleted.state.draft.wallpaperPosition, "top-left");
  assert.equal(deleted.state.draft.windowOpacity, "soft");
  assert.equal(surface.mask.hidden, true);
  assert.equal(surface.wallpaper.classList.contains(WALLPAPER_CUSTOM_CLASS), false);
  assert.equal(surface.wallpaper.classList.contains(WALLPAPER_COLOR_CLASSES.graphite), true);
  assertDetachedBeforeRevoked(restoredUrl, "clear-background");

  assert.equal((await runtime.previewCustomImage(importedWallpaperFixture(10))).ok, true);
  const finalTileUrl = surface.created.at(-1).url;
  assert.equal(surface.image.style.backgroundImage, `url(${JSON.stringify(finalTileUrl)})`);
  runtime.destroy();
  assert.equal(surface.image.style.backgroundImage, "");
  assert.equal(surface.mask.hidden, true);
  assertDetachedBeforeRevoked(finalTileUrl, "clear-background");
  assert.equal(new Set(surface.revoked).size, surface.revoked.length);
});

test("D2 本地图片预览、替换、取消与提交保持存储边界并 revoke URL", async () => {
  const preferenceStorage = createPersonalizationStorageFixture(PERSONALIZATION_DEFAULTS);
  const wallpaperRepository = createWallpaperRepositoryFixture();
  const surface = createWallpaperSurfaceFixture();
  const runtime = createPersonalizationRuntime({
    wallpaper: surface.wallpaper,
    wallpaperImage: surface.image,
    storage: preferenceStorage.service,
    wallpaperStorage: wallpaperRepository.repository,
    decodeWallpaperBlob: async () => ({ width: 640, height: 360 }),
    urlApi: surface.urlApi,
  });
  await runtime.ready();

  const first = importedWallpaperFixture(1);
  let result = await runtime.previewCustomImage(first);
  assert.equal(result.ok, true);
  assert.equal(result.code, "preview_ready");
  assert.equal(result.state.customWallpaper.pending, true);
  assert.equal(result.state.dirty, true);
  assert.equal(preferenceStorage.writes.length, 0, "pending 预览不得写 LocalStorage");
  assert.equal(wallpaperRepository.calls.snapshot, 0, "pending 预览不得读取提交快照");
  assert.equal(wallpaperRepository.calls.replace, 0, "pending 预览不得写 IndexedDB");
  assert.equal(stateContainsPrivateImageValue(result.state), false);

  const second = importedWallpaperFixture(2);
  result = await runtime.previewCustomImage(second);
  assert.equal(result.ok, true);
  assert.deepEqual(surface.revoked, ["blob:wallpaper-fixture/1"]);
  assert.equal(preferenceStorage.writes.length, 0);
  assert.equal(wallpaperRepository.calls.replace, 0);

  let state = runtime.cancel();
  assert.equal(state.draft.wallpaperKind, "color");
  assert.equal(state.customWallpaper.pending, false);
  assert.deepEqual(surface.revoked, [
    "blob:wallpaper-fixture/1",
    "blob:wallpaper-fixture/2",
  ]);

  result = await runtime.previewCustomImage(second);
  assert.equal(result.ok, true);
  const committed = await runtime.commit();
  assert.equal(committed.ok, true);
  assert.equal(committed.code, "saved");
  assert.equal(committed.state.dirty, false);
  assert.equal(committed.state.committed.wallpaperKind, "custom");
  assert.equal(committed.state.customWallpaper.saved, true);
  assert.equal(committed.state.customWallpaper.pending, false);
  assert.equal(wallpaperRepository.calls.snapshot, 1);
  assert.equal(wallpaperRepository.calls.replace, 1);
  assert.equal(wallpaperRepository.calls.restore, 0);
  assert.equal(wallpaperRepository.current().blob, second.image.blob);
  assert.equal(preferenceStorage.writes.length, 1);
  assert.equal(preferenceStorage.current().wallpaperKind, "custom");
  assert.equal(stateContainsPrivateImageValue(committed.state), false);

  runtime.destroy();
  assert.deepEqual(surface.revoked, surface.created.map(({ url }) => url));
  assert.equal(new Set(surface.revoked).size, surface.revoked.length);
});

test("D2 新图片偏好写入失败 rollback 旧 IDB，删除成功共同回退 graphite", async () => {
  const initialPreferences = {
    ...PERSONALIZATION_DEFAULTS,
    animations: "off",
    wallpaperKind: "custom",
    wallpaperColor: "warm-paper",
  };
  const oldImport = importedWallpaperFixture(3);
  const oldRecord = storedWallpaperFixture(oldImport);
  const preferenceStorage = createPersonalizationStorageFixture(initialPreferences);
  const wallpaperRepository = createWallpaperRepositoryFixture(oldRecord);
  const surface = createWallpaperSurfaceFixture();
  const runtime = createPersonalizationRuntime({
    wallpaper: surface.wallpaper,
    wallpaperImage: surface.image,
    storage: preferenceStorage.service,
    wallpaperStorage: wallpaperRepository.repository,
    decodeWallpaperBlob: async () => ({ width: 640, height: 360 }),
    urlApi: surface.urlApi,
  });
  await runtime.ready();
  assert.equal(runtime.getState().customWallpaper.saved, true);
  assert.equal(surface.created.length, 1);

  const replacement = importedWallpaperFixture(4);
  assert.equal((await runtime.previewCustomImage(replacement)).ok, true);
  preferenceStorage.setWritesAllowed(false);
  const failed = await runtime.commit();
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "preference_storage_unavailable");
  assert.equal(failed.state.committed.wallpaperKind, "custom");
  assert.equal(failed.state.customWallpaper.pending, true);
  assert.equal(wallpaperRepository.calls.replace, 1);
  assert.equal(wallpaperRepository.calls.restore, 1);
  assert.equal(wallpaperRepository.current(), oldRecord, "LocalStorage 失败后必须恢复旧 IDB 快照");
  assert.equal(preferenceStorage.current().wallpaperKind, "custom");

  preferenceStorage.setWritesAllowed(true);
  const cancelled = runtime.cancel();
  assert.equal(cancelled.dirty, false);
  assert.equal(cancelled.customWallpaper.pending, false);
  assert.equal(cancelled.committed.wallpaperKind, "custom");

  const deleted = await runtime.deleteCustomWallpaper();
  assert.equal(deleted.ok, true);
  assert.equal(deleted.code, "deleted");
  assert.equal(wallpaperRepository.current(), null);
  assert.equal(wallpaperRepository.calls.remove, 1);
  assert.deepEqual({
    committedKind: deleted.state.committed.wallpaperKind,
    committedColor: deleted.state.committed.wallpaperColor,
    draftKind: deleted.state.draft.wallpaperKind,
    draftColor: deleted.state.draft.wallpaperColor,
    saved: deleted.state.customWallpaper.saved,
  }, {
    committedKind: "color",
    committedColor: "graphite",
    draftKind: "color",
    draftColor: "graphite",
    saved: false,
  });
  assert.deepEqual({
    kind: preferenceStorage.current().wallpaperKind,
    color: preferenceStorage.current().wallpaperColor,
    animations: preferenceStorage.current().animations,
  }, {
    kind: "color",
    color: "graphite",
    animations: "off",
  });
  assert.deepEqual(surface.revoked, surface.created.map(({ url }) => url));
  runtime.destroy();
});

test("D2 启动损坏回退与异步取消/销毁不会污染状态或泄漏 Object URL", async () => {
  for (const mode of ["missing", "damaged"]) {
    const preferenceStorage = createPersonalizationStorageFixture({
      ...PERSONALIZATION_DEFAULTS,
      wallpaperKind: "custom",
      wallpaperColor: "slate",
    });
    const stored = mode === "damaged"
      ? storedWallpaperFixture(importedWallpaperFixture(5))
      : null;
    const wallpaperRepository = createWallpaperRepositoryFixture(stored);
    const surface = createWallpaperSurfaceFixture();
    const runtime = createPersonalizationRuntime({
      wallpaper: surface.wallpaper,
      wallpaperImage: surface.image,
      storage: preferenceStorage.service,
      wallpaperStorage: wallpaperRepository.repository,
      decodeWallpaperBlob: async () => {
        if (mode === "damaged") throw new Error("private decoder detail");
        return { width: 640, height: 360 };
      },
      urlApi: surface.urlApi,
    });
    const state = await runtime.ready();
    assert.equal(state.committed.wallpaperKind, "color", mode);
    assert.equal(state.committed.wallpaperColor, "graphite", mode);
    assert.equal(state.draft.wallpaperKind, "color", mode);
    assert.equal(preferenceStorage.current().wallpaperKind, "color", mode);
    assert.equal(preferenceStorage.current().wallpaperColor, "graphite", mode);
    assert.equal(surface.created.length, 0, mode);
    assert.equal(wallpaperRepository.calls.remove, mode === "damaged" ? 1 : 0, mode);
    runtime.destroy();
  }

  let releaseDecode;
  const delayedDecode = new Promise((resolve) => { releaseDecode = resolve; });
  const delayedSurface = createWallpaperSurfaceFixture();
  const delayedRuntime = createPersonalizationRuntime({
    wallpaper: delayedSurface.wallpaper,
    wallpaperImage: delayedSurface.image,
    storage: createPersonalizationStorageFixture(PERSONALIZATION_DEFAULTS).service,
    wallpaperStorage: createWallpaperRepositoryFixture().repository,
    decodeWallpaperBlob: () => delayedDecode,
    urlApi: delayedSurface.urlApi,
  });
  await delayedRuntime.ready();
  const delayedPreview = delayedRuntime.previewCustomImage(importedWallpaperFixture(6));
  await flushPromises();
  assert.equal(delayedRuntime.getState().busy, true);
  const cancellingState = delayedRuntime.cancel();
  assert.equal(cancellingState.draft.wallpaperKind, "color");
  assert.equal(cancellingState.customWallpaper.pending, false);
  releaseDecode({ width: 640, height: 360 });
  const cancelled = await delayedPreview;
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.code, "cancelled");
  assert.equal(cancelled.state.busy, false);
  assert.equal(delayedSurface.created.length, 0);
  delayedRuntime.destroy();

  let raceRuntime = null;
  let destroyOnFirstSource = true;
  const raceSurface = createWallpaperSurfaceFixture({
    onSourceChange(source) {
      if (destroyOnFirstSource && source.startsWith("blob:")) {
        destroyOnFirstSource = false;
        raceRuntime.destroy();
      }
    },
  });
  raceRuntime = createPersonalizationRuntime({
    wallpaper: raceSurface.wallpaper,
    wallpaperImage: raceSurface.image,
    storage: createPersonalizationStorageFixture(PERSONALIZATION_DEFAULTS).service,
    wallpaperStorage: createWallpaperRepositoryFixture().repository,
    decodeWallpaperBlob: async () => ({ width: 640, height: 360 }),
    urlApi: raceSurface.urlApi,
  });
  await raceRuntime.ready();
  const destroyed = await raceRuntime.previewCustomImage(importedWallpaperFixture(7));
  assert.equal(destroyed.ok, false);
  assert.equal(destroyed.code, "destroyed");
  assert.equal(destroyed.state.customWallpaper.pending, false);
  assert.equal(destroyed.state.busy, false);
  assert.equal(raceSurface.image.src, "");
  assert.deepEqual(raceSurface.revoked, ["blob:wallpaper-fixture/1"]);
  assert.equal(raceSurface.created.length, 1);
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
    api: { status: "warning", label: "服务未就绪" },
    proxy: { status: "running", label: "可用代理 4" },
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
  assert.match(running.reload.reason, /无需重新加载/);
  assert.equal(running.probe.disabled, false);

  const leased = deriveProxyControls(controlStatus({ running: true, leases: 3 }));
  assert.equal(leased.stop.disabled, true);
  assert.equal(leased.reload.disabled, true);
  assert.match(leased.stop.reason, /3 项正在使用代理/);
  assert.equal(leased.probe.disabled, false);

  const busy = deriveProxyControls(controlStatus({ running: true }), { busy: "probe" });
  assert.equal(Object.values(busy).every((item) => item.disabled), true);
  assert.equal(busy.probe.label, "正在检测…");
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
  assert.deepEqual(formatRevisionPair(CONFIGURED_REVISION, CONFIGURED_REVISION).relation, "已生效");
  assert.deepEqual(formatRevisionPair(CONFIGURED_REVISION, ACTIVE_REVISION).relation, "有更新");
});

test("409、422、413 与安全 index/reason 映射不回显 details 原文", () => {
  const conflict = proxyErrorGuidance({ code: "proxy_conflict", status: 409 });
  assert.match(conflict.nextStep, /正在使用代理的任务结束/);
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
  assert.throws(() => gate.beginRead("credentials"), /未知授权请求通道/);
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
  assert.match(vaultErrorGuidance({ code: "network_error" }).nextStep, /刷新授权状态/);
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
      policy: { ...policy },
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

test("POLICY sanitizer 只采用四字段、固定五站并丢弃未知或危险响应", () => {
  const raw = rawPolicySnapshot();
  raw.unknown_secret = POLICY_FIXTURE_SECRET;
  raw.default.policy.request_body = { token: POLICY_FIXTURE_SECRET };
  raw.items.push({
    site: "unknown",
    label: POLICY_FIXTURE_SECRET,
    policy: { path: `/home/${POLICY_FIXTURE_SECRET}` },
  });
  raw.items[1].policy = rawPolicy({
    extra_args: [`token=${POLICY_FIXTURE_SECRET}`],
  });
  const sanitized = sanitizePolicyResponse(raw);
  assert.deepEqual([...sanitized.bySite.keys()], [
    "danbooru", "twitter", "pixiv", "exhentai", "pawchive",
  ]);
  assert.equal(sanitized.defaultPolicy, null);
  assert.equal(sanitized.bySite.get("twitter").editable, false);
  assert.equal(sanitized.bySite.get("twitter").policy, null);
  assert.equal(sanitized.unknownOverrideCount, 1);
  const serialized = serializedPolicySnapshot(sanitized);
  for (const forbidden of [
    POLICY_FIXTURE_SECRET,
    "unknown_secret",
    "request_body",
    "extra_args",
    "/home/",
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
  assert.equal(
    formatPolicySource(sanitized.bySite.get("exhentai")).policyState,
    "使用默认设置",
  );
  assert.equal(
    formatPolicySource(sanitized.bySite.get("pixiv")).badge.label,
    "暂时无法设置",
  );
});

test("POLICY payload builder 只包含四个可设置字段并覆盖安全范围", () => {
  const draft = policyConfigToDraft(rawPolicy());
  Object.assign(draft, {
    max_concurrency: "128",
    retry_limit: "0",
    backoff_base_seconds: "0",
    proxy_mode: "required",
  });
  const payload = buildPolicyPayload(draft);
  assert.deepEqual(Object.keys(payload), [
    "max_concurrency", "retry_limit", "backoff_base_seconds", "proxy_mode",
  ]);
  assert.deepEqual(payload, {
    max_concurrency: 128,
    retry_limit: 0,
    backoff_base_seconds: 0,
    proxy_mode: "required",
  });

  for (const [changes, field, reason] of [
    [{ max_concurrency: "129" }, "max_concurrency", "out_of_range"],
    [{ retry_limit: "1.5" }, "retry_limit", "not_integer"],
    [{ backoff_base_seconds: "3600.1" }, "backoff_base_seconds", "out_of_range"],
    [{ proxy_mode: "auto" }, "proxy_mode", "invalid_enum"],
    [{ probe_url: `https://${POLICY_FIXTURE_SECRET}.invalid/` }, "policy", "unknown_field"],
  ]) {
    const validation = validatePolicyDraft({ ...draft, ...changes });
    assert.equal(validation.valid, false);
    assert.equal(validation.field, field);
    assert.equal(validation.reason, reason);
    assert.equal(validation.payload, null);
  }
});

test("POLICY dirty 比较只看规范化四字段且不受键顺序影响", () => {
  const current = rawPolicy();
  const reordered = Object.fromEntries(Object.entries(current).reverse());
  assert.equal(policyConfigsEqual(current, reordered), true);
  const draft = policyConfigToDraft(current);
  assert.equal(isPolicyDirty(current, draft), false);
  draft.backoff_base_seconds = "2.5";
  assert.equal(isPolicyDirty(current, draft), true);
  draft.backoff_base_seconds = "not-a-number";
  assert.equal(isPolicyDirty(current, draft), true);
});

test("POLICY 保存、恢复、busy 与只读按钮矩阵准确", () => {
  const item = sanitizePolicyResponse(rawPolicySnapshot()).bySite.get("pixiv");
  let controls = derivePolicyControls(item, { dirty: false, valid: true });
  assert.equal(controls.save.disabled, true);
  assert.equal(controls.reset.disabled, true);
  assert.deepEqual(Object.keys(controls), ["save", "reset", "siteSelect"]);

  controls = derivePolicyControls({ ...item, hasOverride: true, inherited: false }, {
    dirty: true,
    valid: true,
  });
  assert.equal(controls.save.disabled, false);
  assert.equal(controls.reset.disabled, false);
  assert.equal(controls.save.label, "保存设置");
  assert.equal(controls.reset.label, "恢复默认设置");

  controls = derivePolicyControls(item, { dirty: true, valid: false });
  assert.equal(controls.save.disabled, true);
  assert.equal(controls.reset.disabled, false, "未保存草稿可恢复默认设置");
  assert.match(controls.save.reason, /修正/);
  controls = derivePolicyControls(item, { dirty: true, valid: true, busy: "save" });
  assert.equal(Object.values(controls).every((control) => control.disabled), true);
  assert.equal(controls.save.label, "正在保存…");

  const readOnly = {
    ...item,
    editable: false,
    policy: null,
    reason: "unsafe_stored_policy",
    hasOverride: true,
    inherited: false,
  };
  controls = derivePolicyControls(readOnly, { dirty: false, valid: false });
  assert.equal(controls.save.disabled, true);
  assert.equal(controls.reset.disabled, false);
});

test("POLICY 安全错误映射只采用四字段、原因与 request id 白名单", () => {
  const error = {
    code: "invalid_policy",
    status: 422,
    requestId: "policy-request-123",
    message: `token=${POLICY_FIXTURE_SECRET}`,
    details: {
      field: "backoff_base_seconds",
      reason: "less_than_equal",
      raw: `/home/${POLICY_FIXTURE_SECRET}`,
    },
  };
  const guidance = policyErrorGuidance(error);
  assert.equal(guidance.requestId, "policy-request-123");
  assert.match(guidance.detail, /首次重试等待/);
  assert.match(guidance.detail, /超过允许范围/);
  assert.equal(JSON.stringify(guidance).includes(POLICY_FIXTURE_SECRET), false);
  assert.equal(safePolicyErrorDetail({ details: { field: "secret", raw: POLICY_FIXTURE_SECRET } }), "");
  assert.match(policyErrorGuidance({ status: 413 }).title, /太大/);
  assert.equal(policyErrorGuidance({ status: 409 }).conflict, true);
  assert.match(policyErrorGuidance({ code: "network_error" }).nextStep, /服务正在运行/);
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
  raw.items[0].policy.max_concurrency = 99;
  const stored = store.getState().policy.config;
  assert.equal(stored.bySite.get("danbooru").policy.max_concurrency, 20);
  assert.equal(serializedPolicySnapshot(stored).includes(POLICY_FIXTURE_SECRET), false);
  assert.throws(() => stored.bySite.set("unknown", {}), TypeError);
  assert.throws(() => {
    stored.bySite.get("pixiv").policy.max_concurrency = 99;
  }, TypeError);

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

test("POLICY 应用保留离开确认生命周期、单一端点且没有轮询资源", () => {
  for (const hook of [
    "mount", "activate", "beforeLeave", "beforeWindowHide", "deactivate", "unmount",
  ]) {
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

test("CRAWL 来源错误消息按纯文本投影、限长并兼容缺失消息", () => {
  const malicious = '<img src=x onerror="globalThis.compromised=true">';
  const projected = projectCrawlSearchResponse({
    sources: [{
      site: "exhentai",
      status: "failed",
      attempts: 2,
      error: { code: "discovery_failed", message: malicious },
      addresses: [],
    }],
  });
  const source = projected.snapshot.sources[0];
  assert.equal(source.errorCode, "discovery_failed");
  assert.equal(source.errorMessage, malicious);

  const long = projectCrawlSearchResponse({
    sources: [{
      site: "pixiv",
      status: "failed",
      error: { code: "extractor_error", message: "x".repeat(900) },
      addresses: [],
    }],
  }).snapshot.sources[0];
  assert.equal(long.errorMessage.length, 500);

  const compatible = projectCrawlSearchResponse({
    sources: [{
      site: "twitter",
      status: "failed",
      error: { code: "authentication" },
      addresses: [],
    }],
  }).snapshot.sources[0];
  assert.equal(compatible.errorMessage, "");

  const previousDocument = globalThis.document;
  let innerHtmlWrites = 0;
  globalThis.document = {
    createElement(tagName) {
      return {
        tagName,
        className: "",
        dataset: {},
        value: "",
        _textContent: "",
        set textContent(value) { this._textContent = String(value); },
        get textContent() { return this._textContent; },
        set innerHTML(_value) { innerHtmlWrites += 1; },
        setAttribute() {},
        append() {},
      };
    },
  };
  try {
    const warning = createSourceErrorWarning(source);
    assert.equal(warning.textContent.includes(malicious), true);
    assert.equal(innerHtmlWrites, 0);
    assert.equal(
      createSourceErrorWarning(compatible).textContent,
      "来源搜索失败（authentication）。请检查授权或代理后重试。",
    );
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
  }
});

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
