import { getApplicationById } from "./app-registry.js";
import {
  crawlCandidateVisible,
  projectCrawlSearchResponse,
  validateCrawlSnapshot,
} from "./crawl-model.js";
import { validateDiagnosticsSnapshot } from "./diagnostics-model.js";
import { sanitizePolicyResponse, validatePolicySnapshot } from "./policy-model.js";
import { sanitizeProxySources, sanitizeProxyStatus } from "./proxy-model.js";
import {
  markReviewPageSaved,
  sanitizeReviewSummary,
  setReviewGroupMode,
  setReviewPageMode,
  updateReviewImageSelection,
  validateReviewState,
} from "./review-model.js";
import {
  sanitizeBatchDetail,
  sanitizeRecentBatches,
  sanitizeTaskPage,
  validateBatchState,
} from "./tasks-model.js";
import {
  sanitizeVaultSiteStatus,
  sanitizeVaultStatus,
  validateVaultSiteViewModel,
  validateVaultSnapshot,
} from "./vault-model.js";

export const ACTION_TYPES = Object.freeze({
  SYSTEM_SHELL_SUMMARY_UPDATED: "system/shellSummaryUpdated",
  DIAGNOSTICS_RECEIVED: "diagnostics/received",
  PROXY_STATUS_RECEIVED: "proxy/statusReceived",
  PROXY_SOURCES_RECEIVED: "proxy/sourcesReceived",
  POLICY_CONFIG_RECEIVED: "policy/configReceived",
  AUTH_STATUS_RECEIVED: "auth/statusReceived",
  AUTH_SITE_STATUS_RECEIVED: "auth/siteStatusReceived",
  CRAWL_SEARCH_RECEIVED: "crawl/searchReceived",
  CRAWL_CANDIDATE_SELECTION_CHANGED: "crawl/candidateSelectionChanged",
  CRAWL_VISIBLE_SELECTION_CHANGED: "crawl/visibleSelectionChanged",
  CRAWL_SOURCE_MOVED: "crawl/sourceMoved",
  CRAWL_CANDIDATE_MOVED: "crawl/candidateMoved",
  CRAWL_WEAK_VISIBILITY_CHANGED: "crawl/weakVisibilityChanged",
  CRAWL_EH_FILTER_CHANGED: "crawl/ehFilterChanged",
  CRAWL_EH_FILTER_CLEARED: "crawl/ehFilterCleared",
  BATCH_ACTIVE_ID_CHANGED: "batches/activeIdChanged",
  BATCH_RECENT_RECEIVED: "batches/recentReceived",
  BATCH_SNAPSHOT_RECEIVED: "batches/snapshotReceived",
  BATCH_SNAPSHOT_CLEARED: "batches/snapshotCleared",
  REVIEW_WORKSPACE_RECEIVED: "review/workspaceReceived",
  REVIEW_SUMMARY_RECEIVED: "review/summaryReceived",
  REVIEW_IMAGE_SELECTION_CHANGED: "review/imageSelectionChanged",
  REVIEW_GROUP_MODE_CHANGED: "review/groupModeChanged",
  REVIEW_PAGE_MODE_CHANGED: "review/pageModeChanged",
  REVIEW_PAGE_SAVED: "review/pageSaved",
  REVIEW_CLEARED: "review/cleared",
  UI_ROUTE_RESOLVED: "ui/routeResolved",
  UI_WINDOW_VISIBILITY_CHANGED: "ui/windowVisibilityChanged",
  UI_WINDOW_STATE_CHANGED: "ui/windowStateChanged",
  UI_START_MENU_CHANGED: "ui/startMenuChanged",
});

const UI_STATUSES = new Set(["ready", "running", "warning", "error", "disabled"]);
const WINDOW_STATES = new Set(["normal", "maximized"]);
const WINDOW_VISIBILITIES = new Set(["open", "minimized", "closed"]);
const IMMUTABLE_VALUES = new WeakSet();
const READONLY_MAPS = new WeakSet();
const DANGEROUS_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class UnknownActionError extends Error {
  constructor(type) {
    super(`未知状态 action：${type}`);
    this.name = "UnknownActionError";
    this.actionType = type;
  }
}

function initialSummary() {
  return {
    api: { status: "disabled", label: "服务检查中" },
    proxy: { status: "disabled", label: "代理检查中" },
    dedup: { status: "disabled", label: "去重检查中" },
  };
}

export function createInitialState() {
  return {
    system: {
      health: null,
      readiness: null,
      apiConnected: false,
      summary: initialSummary(),
      errors: { health: null, readiness: null },
      lastCheckedAt: null,
    },
    diagnostics: {
      snapshot: null,
    },
    proxy: {
      status: null,
      sources: null,
    },
    auth: {
      bySite: new Map(),
      browserProfile: null,
      authorizationProxy: null,
    },
    policy: {
      config: null,
    },
    crawl: {
      sources: [],
      relatedProfiles: [],
      addressCount: 0,
      weakEvidenceCount: 0,
      showWeakEvidence: false,
      ehTagFilter: new Map(),
    },
    batches: {
      activeId: "",
      active: null,
      tasks: [],
      recent: [],
    },
    review: {
      batchId: "",
      summary: null,
      groups: [],
      filter: "",
      offset: 0,
      limit: 8,
      total: 0,
      dirty: false,
    },
    ui: {
      activeApp: "crawl",
      windowState: "normal",
      windowVisibility: "closed",
      startMenuOpen: false,
    },
  };
}

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function cloneInput(value, seen = new WeakSet()) {
  if (value === null || ["string", "number", "boolean", "undefined"].includes(typeof value)) {
    return value;
  }
  if (typeof value !== "object") throw new TypeError("状态 payload 只能包含可复制数据");
  if (seen.has(value)) throw new TypeError("状态 payload 不得包含循环引用");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => cloneInput(item, seen));
    if (value instanceof Map) {
      const result = new Map();
      for (const [key, item] of value) {
        result.set(cloneInput(key, seen), cloneInput(item, seen));
      }
      return result;
    }
    if (!isPlainObject(value)) throw new TypeError("状态 payload 包含不支持的对象类型");
    const result = {};
    for (const [key, item] of Object.entries(value)) {
      if (DANGEROUS_OBJECT_KEYS.has(key)) {
        throw new TypeError("状态 payload 包含危险对象键");
      }
      result[key] = cloneInput(item, seen);
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

function readonlyMutation() {
  throw new TypeError("中央状态只允许通过 action 修改");
}

function readonlyMap(source, seen) {
  const target = new Map();
  let proxy;
  proxy = new Proxy(target, {
    get(map, property) {
      if (property === "set" || property === "delete" || property === "clear") {
        return readonlyMutation;
      }
      if (property === "size") return map.size;
      if (property === "forEach") {
        return (callback, thisArg) => {
          map.forEach((value, key) => callback.call(thisArg, value, key, proxy));
        };
      }
      const value = Reflect.get(map, property, map);
      return typeof value === "function" ? value.bind(map) : value;
    },
  });
  seen.set(source, proxy);
  for (const [key, value] of source) {
    target.set(makeImmutable(key, seen), makeImmutable(value, seen));
  }
  Object.freeze(target);
  READONLY_MAPS.add(proxy);
  IMMUTABLE_VALUES.add(proxy);
  return proxy;
}

function makeImmutable(value, seen = new WeakMap()) {
  if (value === null || typeof value !== "object") return value;
  if (IMMUTABLE_VALUES.has(value) || READONLY_MAPS.has(value)) return value;
  if (seen.has(value)) return seen.get(value);
  if (value instanceof Map) return readonlyMap(value, seen);

  const target = Array.isArray(value) ? [] : {};
  seen.set(value, target);
  if (Array.isArray(value)) {
    for (const item of value) target.push(makeImmutable(item, seen));
  } else {
    if (!isPlainObject(value)) throw new TypeError("中央状态包含不支持的对象类型");
    for (const [key, item] of Object.entries(value)) {
      target[key] = makeImmutable(item, seen);
    }
  }
  Object.freeze(target);
  IMMUTABLE_VALUES.add(target);
  return target;
}

function requireBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label}必须是布尔值`);
  return value;
}

function requireString(value, label, maximum = 160) {
  if (typeof value !== "string" || value.length > maximum) {
    throw new TypeError(`${label}必须是长度不超过 ${maximum} 的字符串`);
  }
  return value;
}

function requireAppId(value) {
  if (typeof value !== "string" || !getApplicationById(value)) {
    throw new TypeError("应用 ID 无效");
  }
  return value;
}

function requireBatchId(value) {
  if (value === "") return value;
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    throw new TypeError("批次 ID 格式无效");
  }
  return value;
}

function validateSafeError(error) {
  if (error === null) return null;
  if (!isPlainObject(error)) throw new TypeError("摘要错误必须是对象或 null");
  const status = Number.isInteger(error.status) && error.status >= 0 ? error.status : 0;
  const code = requireString(error.code || "request_failed", "错误码", 128);
  const requestId = requireString(error.requestId || "", "请求 ID", 128);
  return { status, code, requestId };
}

function validateStatusDescriptor(descriptor) {
  if (!isPlainObject(descriptor) || !UI_STATUSES.has(descriptor.status)) {
    throw new TypeError("任务栏状态描述无效");
  }
  return {
    status: descriptor.status,
    label: requireString(descriptor.label, "状态文本", 100),
  };
}

function validateShellSnapshot(payload) {
  if (!isPlainObject(payload) || !isPlainObject(payload.summary)) {
    throw new TypeError("系统摘要 payload 无效");
  }
  if (!isPlainObject(payload.errors)) throw new TypeError("系统摘要错误字段无效");
  const lastCheckedAt = Number(payload.lastCheckedAt);
  if (!Number.isFinite(lastCheckedAt) || lastCheckedAt < 0) {
    throw new TypeError("系统摘要时间无效");
  }
  return {
    health: payload.health ?? null,
    readiness: payload.readiness ?? null,
    apiConnected: requireBoolean(payload.apiConnected, "API 连接状态"),
    summary: {
      api: validateStatusDescriptor(payload.summary.api),
      proxy: validateStatusDescriptor(payload.summary.proxy),
      dedup: validateStatusDescriptor(payload.summary.dedup),
    },
    errors: {
      health: validateSafeError(payload.errors.health ?? null),
      readiness: validateSafeError(payload.errors.readiness ?? null),
    },
    lastCheckedAt,
  };
}

function requireCandidateKey(value) {
  if (typeof value !== "string" || !/^candidate:\d+:\d+$/.test(value)) {
    throw new TypeError("抓取候选键无效");
  }
  return value;
}

function requireSourceKey(value) {
  if (typeof value !== "string" || !/^source:[a-z]+:\d+$/.test(value)) {
    throw new TypeError("抓取来源键无效");
  }
  return value;
}

function requireDirection(value) {
  if (value !== -1 && value !== 1) throw new TypeError("移动方向无效");
  return value;
}

function moveAt(items, index, target) {
  if (index < 0 || target < 0 || target >= items.length || index === target) return items;
  const result = [...items];
  [result[index], result[target]] = [result[target], result[index]];
  return result;
}

function mapCrawlCandidates(crawl, keys, selected) {
  const keySet = new Set(keys.map(requireCandidateKey));
  let changed = false;
  const sources = crawl.sources.map((source) => {
    const addresses = source.addresses.map((candidate) => {
      if (!keySet.has(candidate.key) || candidate.selected === selected) return candidate;
      changed = true;
      return { ...candidate, selected };
    });
    return addresses === source.addresses ? source : { ...source, addresses };
  });
  return changed ? { ...crawl, sources } : crawl;
}

function emptyReviewState(batchId = "") {
  return {
    batchId: requireBatchId(batchId),
    summary: null,
    groups: [],
    filter: "",
    offset: 0,
    limit: 8,
    total: 0,
    dirty: false,
  };
}

export function rootReducer(state, action) {
  switch (action.type) {
    case ACTION_TYPES.SYSTEM_SHELL_SUMMARY_UPDATED: {
      const snapshot = validateShellSnapshot(action.payload);
      return { ...state, system: { ...state.system, ...snapshot } };
    }
    case ACTION_TYPES.DIAGNOSTICS_RECEIVED:
      return {
        ...state,
        diagnostics: { snapshot: validateDiagnosticsSnapshot(action.payload) },
      };
    case ACTION_TYPES.PROXY_STATUS_RECEIVED:
      return {
        ...state,
        proxy: { ...state.proxy, status: sanitizeProxyStatus(action.payload) },
      };
    case ACTION_TYPES.PROXY_SOURCES_RECEIVED:
      return {
        ...state,
        proxy: { ...state.proxy, sources: sanitizeProxySources(action.payload) },
      };
    case ACTION_TYPES.POLICY_CONFIG_RECEIVED:
      return {
        ...state,
        policy: { config: validatePolicySnapshot(action.payload) },
      };
    case ACTION_TYPES.AUTH_STATUS_RECEIVED: {
      const snapshot = validateVaultSnapshot(action.payload);
      const bySite = new Map(state.auth.bySite);
      for (const [siteId, site] of snapshot.bySite) bySite.set(siteId, site);
      return {
        ...state,
        auth: {
          bySite,
          browserProfile: snapshot.browserProfile,
          authorizationProxy: snapshot.authorizationProxy,
        },
      };
    }
    case ACTION_TYPES.AUTH_SITE_STATUS_RECEIVED: {
      const site = validateVaultSiteViewModel(action.payload);
      const bySite = new Map(state.auth.bySite);
      bySite.set(site.site, site);
      return { ...state, auth: { ...state.auth, bySite } };
    }
    case ACTION_TYPES.CRAWL_SEARCH_RECEIVED:
      return { ...state, crawl: validateCrawlSnapshot(action.payload) };
    case ACTION_TYPES.CRAWL_CANDIDATE_SELECTION_CHANGED: {
      const key = requireCandidateKey(action.payload?.key);
      const selected = requireBoolean(action.payload?.selected, "候选选择状态");
      return {
        ...state,
        crawl: mapCrawlCandidates(state.crawl, [key], selected),
      };
    }
    case ACTION_TYPES.CRAWL_VISIBLE_SELECTION_CHANGED: {
      if (!Array.isArray(action.payload?.keys)) throw new TypeError("可见候选键列表无效");
      const selected = requireBoolean(action.payload?.selected, "批量选择状态");
      return {
        ...state,
        crawl: mapCrawlCandidates(state.crawl, action.payload.keys, selected),
      };
    }
    case ACTION_TYPES.CRAWL_SOURCE_MOVED: {
      const key = requireSourceKey(action.payload?.key);
      const direction = requireDirection(action.payload?.direction);
      const index = state.crawl.sources.findIndex((source) => source.key === key);
      const sources = moveAt(state.crawl.sources, index, index + direction);
      return sources === state.crawl.sources ? state : { ...state, crawl: { ...state.crawl, sources } };
    }
    case ACTION_TYPES.CRAWL_CANDIDATE_MOVED: {
      const sourceKey = requireSourceKey(action.payload?.sourceKey);
      const key = requireCandidateKey(action.payload?.key);
      const direction = requireDirection(action.payload?.direction);
      let changed = false;
      const sources = state.crawl.sources.map((source) => {
        if (source.key !== sourceKey) return source;
        const visibleIndices = source.addresses
          .map((candidate, index) => crawlCandidateVisible(state.crawl, source, candidate) ? index : -1)
          .filter((index) => index >= 0);
        const index = source.addresses.findIndex((candidate) => candidate.key === key);
        const visiblePosition = visibleIndices.indexOf(index);
        const targetPosition = visiblePosition + direction;
        if (visiblePosition < 0 || targetPosition < 0 || targetPosition >= visibleIndices.length) return source;
        const addresses = moveAt(source.addresses, index, visibleIndices[targetPosition]);
        if (addresses === source.addresses) return source;
        changed = true;
        return { ...source, addresses };
      });
      return changed ? { ...state, crawl: { ...state.crawl, sources } } : state;
    }
    case ACTION_TYPES.CRAWL_WEAK_VISIBILITY_CHANGED: {
      const visible = requireBoolean(action.payload?.visible, "待核实结果显示状态");
      let crawl = { ...state.crawl, showWeakEvidence: visible };
      if (!visible) {
        const weakKeys = crawl.sources.flatMap((source) =>
          source.addresses.filter((candidate) => candidate.weak).map((candidate) => candidate.key));
        crawl = mapCrawlCandidates(crawl, weakKeys, false);
      }
      return { ...state, crawl };
    }
    case ACTION_TYPES.CRAWL_EH_FILTER_CHANGED: {
      const key = requireString(action.payload?.key, "EH 标签键", 180);
      if (!/^[a-z]+:[^\u0000-\u001f\u007f]{1,160}$/.test(key)) throw new TypeError("EH 标签键无效");
      const mode = action.payload?.mode;
      if (!["include", "exclude", ""].includes(mode)) throw new TypeError("EH 标签模式无效");
      const filter = new Map(state.crawl.ehTagFilter);
      if (mode) filter.set(key, mode);
      else filter.delete(key);
      return { ...state, crawl: { ...state.crawl, ehTagFilter: filter } };
    }
    case ACTION_TYPES.CRAWL_EH_FILTER_CLEARED:
      return { ...state, crawl: { ...state.crawl, ehTagFilter: new Map() } };
    case ACTION_TYPES.BATCH_ACTIVE_ID_CHANGED:
      return {
        ...state,
        batches: { ...state.batches, activeId: requireBatchId(action.payload?.batchId) },
      };
    case ACTION_TYPES.BATCH_RECENT_RECEIVED: {
      const projected = validateBatchState({
        batch: state.batches.active,
        tasks: state.batches.tasks,
        recent: action.payload,
      });
      return {
        ...state,
        batches: { ...state.batches, recent: projected.recent },
      };
    }
    case ACTION_TYPES.BATCH_SNAPSHOT_RECEIVED: {
      const projected = validateBatchState({
        batch: action.payload?.batch,
        tasks: action.payload?.tasks,
        recent: state.batches.recent,
      });
      return {
        ...state,
        batches: { ...state.batches, active: projected.batch, tasks: projected.tasks },
      };
    }
    case ACTION_TYPES.BATCH_SNAPSHOT_CLEARED:
      return { ...state, batches: { ...state.batches, active: null, tasks: [] } };
    case ACTION_TYPES.REVIEW_WORKSPACE_RECEIVED:
      return { ...state, review: validateReviewState(action.payload) };
    case ACTION_TYPES.REVIEW_SUMMARY_RECEIVED: {
      const batchId = requireBatchId(action.payload?.batchId);
      const summary = sanitizeReviewSummary(action.payload?.summary, batchId);
      const review = state.review.batchId === batchId
        ? { ...state.review, summary }
        : { ...emptyReviewState(batchId), summary };
      return { ...state, review };
    }
    case ACTION_TYPES.REVIEW_IMAGE_SELECTION_CHANGED:
      return {
        ...state,
        review: updateReviewImageSelection(
          state.review,
          action.payload?.groupId,
          action.payload?.imageId,
          requireBoolean(action.payload?.selected, "审核图片选择状态"),
        ),
      };
    case ACTION_TYPES.REVIEW_GROUP_MODE_CHANGED:
      return {
        ...state,
        review: setReviewGroupMode(state.review, action.payload?.groupId, action.payload?.mode),
      };
    case ACTION_TYPES.REVIEW_PAGE_MODE_CHANGED:
      return { ...state, review: setReviewPageMode(state.review, action.payload?.mode) };
    case ACTION_TYPES.REVIEW_PAGE_SAVED:
      return { ...state, review: markReviewPageSaved(state.review, action.payload?.summary) };
    case ACTION_TYPES.REVIEW_CLEARED:
      return { ...state, review: emptyReviewState(action.payload?.batchId || "") };
    case ACTION_TYPES.UI_ROUTE_RESOLVED: {
      const appId = requireAppId(action.payload?.appId);
      const windowState = action.payload?.windowState;
      if (!WINDOW_STATES.has(windowState)) throw new TypeError("窗口状态无效");
      return {
        ...state,
        ui: {
          ...state.ui,
          activeApp: appId,
          windowState,
          windowVisibility: "open",
          startMenuOpen: false,
        },
      };
    }
    case ACTION_TYPES.UI_WINDOW_VISIBILITY_CHANGED: {
      const visibility = action.payload?.visibility;
      if (!WINDOW_VISIBILITIES.has(visibility)) throw new TypeError("窗口可见状态无效");
      return { ...state, ui: { ...state.ui, windowVisibility: visibility } };
    }
    case ACTION_TYPES.UI_WINDOW_STATE_CHANGED: {
      const windowState = action.payload?.windowState;
      if (!WINDOW_STATES.has(windowState)) throw new TypeError("窗口状态无效");
      return { ...state, ui: { ...state.ui, windowState } };
    }
    case ACTION_TYPES.UI_START_MENU_CHANGED:
      return {
        ...state,
        ui: {
          ...state.ui,
          startMenuOpen: requireBoolean(action.payload?.open, "START 菜单状态"),
        },
      };
    default:
      throw new UnknownActionError(action.type);
  }
}

function action(type, payload) {
  return { type, payload };
}

export const actionCreators = Object.freeze({
  shellSummaryUpdated(snapshot) {
    return action(ACTION_TYPES.SYSTEM_SHELL_SUMMARY_UPDATED, snapshot);
  },
  diagnosticsReceived(snapshot) {
    return action(ACTION_TYPES.DIAGNOSTICS_RECEIVED, validateDiagnosticsSnapshot(snapshot));
  },
  proxyStatusReceived(status) {
    return action(ACTION_TYPES.PROXY_STATUS_RECEIVED, status);
  },
  proxySourcesReceived(sources) {
    return action(ACTION_TYPES.PROXY_SOURCES_RECEIVED, sources);
  },
  policyConfigReceived(config) {
    return action(ACTION_TYPES.POLICY_CONFIG_RECEIVED, sanitizePolicyResponse(config));
  },
  authStatusReceived(status) {
    return action(ACTION_TYPES.AUTH_STATUS_RECEIVED, sanitizeVaultStatus(status));
  },
  authSiteStatusReceived(status) {
    return action(ACTION_TYPES.AUTH_SITE_STATUS_RECEIVED, sanitizeVaultSiteStatus(status));
  },
  crawlSearchReceived(response) {
    return action(ACTION_TYPES.CRAWL_SEARCH_RECEIVED, projectCrawlSearchResponse(response).snapshot);
  },
  crawlCandidateSelectionChanged(key, selected) {
    return action(ACTION_TYPES.CRAWL_CANDIDATE_SELECTION_CHANGED, { key, selected });
  },
  crawlVisibleSelectionChanged(keys, selected) {
    return action(ACTION_TYPES.CRAWL_VISIBLE_SELECTION_CHANGED, { keys, selected });
  },
  crawlSourceMoved(key, direction) {
    return action(ACTION_TYPES.CRAWL_SOURCE_MOVED, { key, direction });
  },
  crawlCandidateMoved(sourceKey, key, direction) {
    return action(ACTION_TYPES.CRAWL_CANDIDATE_MOVED, { sourceKey, key, direction });
  },
  crawlWeakVisibilityChanged(visible) {
    return action(ACTION_TYPES.CRAWL_WEAK_VISIBILITY_CHANGED, { visible });
  },
  crawlEhFilterChanged(key, mode) {
    return action(ACTION_TYPES.CRAWL_EH_FILTER_CHANGED, { key, mode });
  },
  crawlEhFilterCleared() {
    return action(ACTION_TYPES.CRAWL_EH_FILTER_CLEARED, {});
  },
  activeBatchIdChanged(batchId) {
    return action(ACTION_TYPES.BATCH_ACTIVE_ID_CHANGED, { batchId });
  },
  recentBatchesReceived(response) {
    return action(ACTION_TYPES.BATCH_RECENT_RECEIVED, sanitizeRecentBatches(response));
  },
  batchSnapshotReceived(batch, tasks) {
    const safeBatch = sanitizeBatchDetail(batch);
    const safeTasks = sanitizeTaskPage(tasks, safeBatch.id).tasks;
    return action(ACTION_TYPES.BATCH_SNAPSHOT_RECEIVED, { batch: safeBatch, tasks: safeTasks });
  },
  batchSnapshotCleared() {
    return action(ACTION_TYPES.BATCH_SNAPSHOT_CLEARED, {});
  },
  reviewWorkspaceReceived(workspace) {
    return action(ACTION_TYPES.REVIEW_WORKSPACE_RECEIVED, validateReviewState(workspace));
  },
  reviewSummaryReceived(batchId, summary) {
    return action(ACTION_TYPES.REVIEW_SUMMARY_RECEIVED, {
      batchId,
      summary: sanitizeReviewSummary(summary, batchId),
    });
  },
  reviewImageSelectionChanged(groupId, imageId, selected) {
    return action(ACTION_TYPES.REVIEW_IMAGE_SELECTION_CHANGED, { groupId, imageId, selected });
  },
  reviewGroupModeChanged(groupId, mode) {
    return action(ACTION_TYPES.REVIEW_GROUP_MODE_CHANGED, { groupId, mode });
  },
  reviewPageModeChanged(mode) {
    return action(ACTION_TYPES.REVIEW_PAGE_MODE_CHANGED, { mode });
  },
  reviewPageSaved(summary) {
    const batchId = typeof summary?.batch_id === "string" ? summary.batch_id : "";
    return action(ACTION_TYPES.REVIEW_PAGE_SAVED, {
      summary: sanitizeReviewSummary(summary, batchId),
    });
  },
  reviewCleared(batchId = "") {
    return action(ACTION_TYPES.REVIEW_CLEARED, { batchId });
  },
  routeResolved(appId, windowState) {
    return action(ACTION_TYPES.UI_ROUTE_RESOLVED, { appId, windowState });
  },
  windowVisibilityChanged(visibility) {
    return action(ACTION_TYPES.UI_WINDOW_VISIBILITY_CHANGED, { visibility });
  },
  windowStateChanged(windowState) {
    return action(ACTION_TYPES.UI_WINDOW_STATE_CHANGED, { windowState });
  },
  startMenuChanged(open) {
    return action(ACTION_TYPES.UI_START_MENU_CHANGED, { open });
  },
});

function normalizeAction(input) {
  if (!isPlainObject(input) || typeof input.type !== "string" || !input.type) {
    throw new TypeError("action 必须包含非空 type");
  }
  if (!Object.values(ACTION_TYPES).includes(input.type)) throw new UnknownActionError(input.type);
  return {
    type: input.type,
    payload: cloneInput(input.payload),
  };
}

function reportSubscriberFailure(reportError) {
  try {
    reportError(Object.freeze({ kind: "subscriber_error" }));
  } catch {
    // 错误报告器不得中断其余订阅者。
  }
}

export function createStore({
  initialState = createInitialState(),
  reducer = rootReducer,
  reportError = () => console.error("ImageWeave 状态订阅者执行失败"),
} = {}) {
  if (typeof reducer !== "function") throw new TypeError("reducer 必须是函数");
  if (typeof reportError !== "function") throw new TypeError("错误报告器必须是函数");
  let state = makeImmutable(cloneInput(initialState));
  let phase = "idle";
  const subscribers = new Set();

  const dispatch = (input) => {
    if (phase !== "idle") throw new Error("状态通知期间不得嵌套 dispatch");
    const normalized = normalizeAction(input);
    let nextState;
    phase = "reducing";
    try {
      nextState = reducer(state, normalized);
      if (nextState === undefined) throw new TypeError("reducer 必须返回状态");
      nextState = makeImmutable(nextState);
    } finally {
      phase = "idle";
    }
    if (nextState === state) return Object.freeze({ type: normalized.type });

    state = nextState;
    phase = "notifying";
    try {
      for (const subscription of [...subscribers]) {
        if (!subscribers.has(subscription)) continue;
        let selected;
        try {
          selected = subscription.selector(state);
          if (subscription.equality(selected, subscription.selected)) continue;
          const previous = subscription.selected;
          subscription.selected = selected;
          subscription.listener(
            selected,
            previous,
            Object.freeze({ type: normalized.type }),
          );
        } catch {
          reportSubscriberFailure(reportError);
        }
      }
    } finally {
      phase = "idle";
    }
    return Object.freeze({ type: normalized.type });
  };

  const subscribe = (selector, listener, options = {}) => {
    if (typeof listener !== "function") {
      listener = selector;
      selector = (current) => current;
    }
    if (typeof selector !== "function" || typeof listener !== "function") {
      throw new TypeError("subscribe 需要 selector 与 listener 函数");
    }
    const equality = options.equality || Object.is;
    if (typeof equality !== "function") throw new TypeError("订阅比较器必须是函数");
    const subscription = {
      selector,
      listener,
      equality,
      selected: selector(state),
    };
    subscribers.add(subscription);
    if (options.fireImmediately) {
      const previousPhase = phase;
      phase = "notifying";
      try {
        listener(subscription.selected, undefined, Object.freeze({ type: "store/initial" }));
      } catch {
        reportSubscriberFailure(reportError);
      } finally {
        phase = previousPhase;
      }
    }
    return () => subscribers.delete(subscription);
  };

  return Object.freeze({
    getState() {
      return state;
    },
    dispatch,
    subscribe,
  });
}

export function shallowEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) &&
      Object.is(left[key], right[key]));
}

export const selectors = Object.freeze({
  activeApp: (state) => state.ui.activeApp,
  startMenuOpen: (state) => state.ui.startMenuOpen,
  taskbarSummary: (state) => state.system.summary,
  diagnostics: (state) => state.diagnostics.snapshot,
  proxyStatus: (state) => state.proxy.status,
  proxySources: (state) => state.proxy.sources,
  policyConfig: (state) => state.policy.config,
  authSites: (state) => state.auth.bySite,
  authBrowserProfile: (state) => state.auth.browserProfile,
  authAuthorizationProxy: (state) => state.auth.authorizationProxy,
  crawl: (state) => state.crawl,
  activeBatchId: (state) => state.batches.activeId,
  activeBatch: (state) => state.batches.active,
  batchTasks: (state) => state.batches.tasks,
  recentBatches: (state) => state.batches.recent,
  review: (state) => state.review,
  windowView: (state) => ({
    appId: state.ui.activeApp,
    windowState: state.ui.windowState,
    visibility: state.ui.windowVisibility,
  }),
});
