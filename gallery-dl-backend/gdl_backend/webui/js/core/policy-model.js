const SITE_ORDER = Object.freeze([
  "danbooru",
  "twitter",
  "pixiv",
  "exhentai",
  "pawchive",
]);

const SITE_DEFINITIONS = Object.freeze({
  danbooru: Object.freeze({
    id: "danbooru",
    label: "Danbooru",
    mark: "D",
    authorization: "anonymous",
  }),
  twitter: Object.freeze({
    id: "twitter",
    label: "X / Twitter",
    mark: "X",
    authorization: "managed_browser",
  }),
  pixiv: Object.freeze({
    id: "pixiv",
    label: "Pixiv",
    mark: "P",
    authorization: "oauth",
  }),
  exhentai: Object.freeze({
    id: "exhentai",
    label: "EH",
    mark: "EH",
    authorization: "managed_browser_for_private_content",
  }),
  pawchive: Object.freeze({
    id: "pawchive",
    label: "Pawchive",
    mark: "PA",
    authorization: "anonymous",
  }),
});

const CONFIG_KEYS = Object.freeze([
  "max_concurrency",
  "retry_limit",
  "backoff_base_seconds",
  "proxy_mode",
  "probe_url",
  "probe_before_use",
  "node_tags",
  "http_timeout",
  "gallery_retries",
  "task_timeout_seconds",
  "download_stall_timeout_seconds",
  "eh_download",
  "extra_args",
]);
const CONFIG_KEY_SET = new Set(CONFIG_KEYS);
const PROXY_MODES = new Set(["direct", "prefer", "required"]);
const AUTHORIZATION_KINDS = new Set([
  "anonymous",
  "managed_browser",
  "oauth",
  "managed_browser_for_private_content",
]);
const SELECTION_MODES = new Set(["per_request"]);
const AVAILABILITY_MODES = new Set(["not_probed"]);
const ITEM_REASONS = new Set([
  "",
  "unsafe_default_policy",
  "unsafe_stored_policy",
  "missing_source",
  "invalid_response",
]);
const EFFECT_SCOPES = new Set(["new_requests_and_tasks"]);
const CONCURRENCY_PROTECTIONS = new Set(["none"]);
const DEFAULT_SOURCES = new Set(["startup_snapshot"]);
const PERSISTENCE_KINDS = new Set(["sqlite_atomic"]);
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const ABSOLUTE_PATH = /(?:^|[\s=])(?:[A-Za-z]:[\\/]|\/[^/\s]|\\\\[^\\\s]+\\)/;
const URL_LIKE = /[a-z][a-z0-9+.-]*:\/\//i;
const SENSITIVE_ASSIGNMENT = /(?:^|[^a-z0-9_])(?:token|cookie|password|secret|authorization|api[_-]?key)\s*[:=]/i;
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export const POLICY_SITE_IDS = SITE_ORDER;
export const POLICY_LIMITS = Object.freeze({
  requestBytes: 16 * 1024,
  probeUrlLength: 2048,
  nodeTagCount: 32,
  nodeTagLength: 64,
  extraArgCount: 128,
  extraArgLength: 512,
  extraArgsTotalChars: 8192,
});

const NUMERIC_RULES = Object.freeze({
  max_concurrency: Object.freeze({ minimum: 1, maximum: 128, integer: true }),
  retry_limit: Object.freeze({ minimum: 0, maximum: 20, integer: true }),
  backoff_base_seconds: Object.freeze({ minimum: 0, maximum: 3600, integer: false }),
  http_timeout: Object.freeze({ minimum: 1, maximum: 3600, integer: false }),
  gallery_retries: Object.freeze({ minimum: 0, maximum: 50, integer: true }),
  task_timeout_seconds: Object.freeze({ minimum: 0, maximum: 604800, integer: false }),
  download_stall_timeout_seconds: Object.freeze({ minimum: 0, maximum: 604800, integer: false }),
});

const FIELD_LABELS = Object.freeze({
  policy: "策略",
  max_concurrency: "最大并发",
  retry_limit: "重试次数",
  backoff_base_seconds: "退避基数",
  proxy_mode: "默认代理模式",
  probe_url: "HTTPS 探活地址",
  probe_before_use: "使用前探活",
  node_tags: "节点标签",
  http_timeout: "HTTP 超时",
  gallery_retries: "gallery-dl 重试",
  task_timeout_seconds: "任务总超时",
  download_stall_timeout_seconds: "EH 无进展超时",
  eh_download: "EH 下载默认值",
  extra_args: "额外 gallery-dl 参数",
});

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label}必须是对象`);
  return value;
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function hasDangerousOwnKey(value) {
  return isRecord(value) && Object.keys(value).some((key) => DANGEROUS_KEYS.has(key));
}

function codePointLength(value) {
  return [...value].length;
}

function exactBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label}必须是布尔值`);
  return value;
}

function safeTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 4_102_444_800
    ? value
    : null;
}

function safeCount(value, maximum = 1_000_000) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? Math.min(value, maximum)
    : 0;
}

function safeRequestId(value) {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value.trim()) ? value.trim() : "";
}

function safeErrorCode(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
    ? value
    : "request_failed";
}

export class PolicyValidationError extends TypeError {
  constructor(field, reason, { index = null } = {}) {
    const safeField = CONFIG_KEY_SET.has(field) ? field : "policy";
    const safeReason = typeof reason === "string" && /^[a-z0-9_.:-]{1,64}$/i.test(reason)
      ? reason
      : "invalid_value";
    super(`${FIELD_LABELS[safeField] || "策略字段"}无效`);
    this.name = "PolicyValidationError";
    this.code = "invalid_policy_draft";
    this.status = 0;
    this.field = safeField;
    this.reason = safeReason;
    this.index = Number.isInteger(index) && index >= 0 ? index : null;
  }
}

function validateSafeText(value, {
  field,
  index = null,
  maximum,
  rejectUrls = true,
} = {}) {
  if (typeof value !== "string") throw new PolicyValidationError(field, "not_text", { index });
  if (CONTROL_CHARACTERS.test(value)) {
    throw new PolicyValidationError(field, "control_characters", { index });
  }
  if (codePointLength(value) > maximum) {
    throw new PolicyValidationError(field, "too_long", { index });
  }
  if (ABSOLUTE_PATH.test(value)) {
    throw new PolicyValidationError(field, "absolute_path", { index });
  }
  if (rejectUrls && URL_LIKE.test(value)) {
    throw new PolicyValidationError(field, "url_not_allowed", { index });
  }
  if (SENSITIVE_ASSIGNMENT.test(value)) {
    throw new PolicyValidationError(field, "sensitive_assignment", { index });
  }
  return value;
}

function privateIpv4(host) {
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return false;
  const octets = parts.map(Number);
  if (octets.some((part) => part > 255)) return true;
  return octets[0] === 10 || octets[0] === 127 || octets[0] === 0 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168) ||
    octets[0] >= 224;
}

function validateProbeUrl(value) {
  if (value === null) return null;
  if (typeof value !== "string") throw new PolicyValidationError("probe_url", "not_text");
  const text = value.trim();
  if (!text) return null;
  validateSafeText(text, {
    field: "probe_url",
    maximum: POLICY_LIMITS.probeUrlLength,
    rejectUrls: false,
  });
  if (/\s/.test(text)) throw new PolicyValidationError("probe_url", "control_characters");
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new PolicyValidationError("probe_url", "url_host_invalid");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname) {
    throw new PolicyValidationError("probe_url", "url_host_invalid");
  }
  if (parsed.username || parsed.password || text.slice(text.indexOf("://") + 3).includes("@")) {
    throw new PolicyValidationError("probe_url", "url_credentials");
  }
  if (parsed.search || parsed.hash) {
    throw new PolicyValidationError("probe_url", "url_query_or_fragment");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (
    host === "localhost" || host === "localhost.localdomain" || host.endsWith(".local") ||
    privateIpv4(host) || host === "::1" || host === "::" || /^f[cd][0-9a-f:]*$/i.test(host) ||
    /^fe[89ab][0-9a-f:]*$/i.test(host)
  ) {
    throw new PolicyValidationError("probe_url", "url_target_forbidden");
  }
  return text;
}

function numericValue(value, field, { allowString = false } = {}) {
  const rule = NUMERIC_RULES[field];
  if (!rule) throw new PolicyValidationError("policy", "unknown_numeric_field");
  if (allowString && typeof value === "string") {
    if (!value.trim()) throw new PolicyValidationError(field, "empty_number");
    value = Number(value);
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PolicyValidationError(field, "not_number");
  }
  if (rule.integer && !Number.isInteger(value)) {
    throw new PolicyValidationError(field, "not_integer");
  }
  if (value < rule.minimum || value > rule.maximum) {
    throw new PolicyValidationError(field, "out_of_range");
  }
  return value;
}

function inputLines(value, field) {
  if (typeof value === "string") return value.split(/\r?\n/);
  if (Array.isArray(value)) return [...value];
  throw new PolicyValidationError(field, "not_list");
}

export function normalizePolicyLines(value, kind) {
  if (kind !== "node_tags" && kind !== "extra_args") {
    throw new TypeError("未知 POLICY 逐行字段");
  }
  const lines = inputLines(value, kind);
  const maximumCount = kind === "node_tags"
    ? POLICY_LIMITS.nodeTagCount
    : POLICY_LIMITS.extraArgCount;
  const maximumLength = kind === "node_tags"
    ? POLICY_LIMITS.nodeTagLength
    : POLICY_LIMITS.extraArgLength;
  const items = [];
  const seen = new Set();
  let duplicatesRemoved = 0;
  let totalChars = 0;

  for (let sourceIndex = 0; sourceIndex < lines.length; sourceIndex += 1) {
    const raw = lines[sourceIndex];
    if (typeof raw !== "string") {
      throw new PolicyValidationError(kind, "not_text", { index: sourceIndex });
    }
    if (!raw.trim()) continue;
    const item = kind === "node_tags" ? raw.trim().toLowerCase() : raw;
    validateSafeText(item, {
      field: kind,
      index: sourceIndex,
      maximum: maximumLength,
    });
    totalChars += codePointLength(item);
    if (kind === "node_tags") {
      if (seen.has(item)) {
        duplicatesRemoved += 1;
        continue;
      }
      seen.add(item);
    }
    items.push(item);
    if (items.length > maximumCount) {
      throw new PolicyValidationError(kind, "too_many_items", { index: sourceIndex });
    }
  }
  if (kind === "extra_args" && totalChars > POLICY_LIMITS.extraArgsTotalChars) {
    throw new PolicyValidationError(kind, "total_too_large");
  }
  return Object.freeze({ items, duplicatesRemoved });
}

function normalizeEhDownload(value) {
  if (value === null) return null;
  const options = requireRecord(value, "EH 下载策略");
  if (hasDangerousOwnKey(options)) throw new PolicyValidationError("eh_download", "dangerous_key");
  const imageMode = options.image_mode;
  const gpPolicy = options.gp_policy;
  if (!new Set(["original", "resample"]).has(imageMode) ||
      !new Set(["stop", "resized"]).has(gpPolicy)) {
    throw new PolicyValidationError("eh_download", "invalid_enum");
  }
  return { image_mode: imageMode, gp_policy: gpPolicy };
}

function normalizePolicyConfig(value, { allowStringNumbers = false } = {}) {
  const policy = requireRecord(value, "站点策略");
  if (hasDangerousOwnKey(policy)) throw new PolicyValidationError("policy", "dangerous_key");
  for (const key of CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(policy, key)) {
      throw new PolicyValidationError(key, "missing_field");
    }
  }
  const proxyMode = policy.proxy_mode;
  if (typeof proxyMode !== "string" || !PROXY_MODES.has(proxyMode)) {
    throw new PolicyValidationError("proxy_mode", "invalid_enum");
  }
  const nodeTags = normalizePolicyLines(policy.node_tags, "node_tags");
  const extraArgs = normalizePolicyLines(policy.extra_args, "extra_args");
  return {
    max_concurrency: numericValue(policy.max_concurrency, "max_concurrency", {
      allowString: allowStringNumbers,
    }),
    retry_limit: numericValue(policy.retry_limit, "retry_limit", {
      allowString: allowStringNumbers,
    }),
    backoff_base_seconds: numericValue(policy.backoff_base_seconds, "backoff_base_seconds", {
      allowString: allowStringNumbers,
    }),
    proxy_mode: proxyMode,
    probe_url: validateProbeUrl(policy.probe_url),
    probe_before_use: exactBoolean(policy.probe_before_use, "使用前探活"),
    node_tags: nodeTags.items,
    http_timeout: numericValue(policy.http_timeout, "http_timeout", {
      allowString: allowStringNumbers,
    }),
    gallery_retries: numericValue(policy.gallery_retries, "gallery_retries", {
      allowString: allowStringNumbers,
    }),
    task_timeout_seconds: numericValue(policy.task_timeout_seconds, "task_timeout_seconds", {
      allowString: allowStringNumbers,
    }),
    download_stall_timeout_seconds: numericValue(
      policy.download_stall_timeout_seconds,
      "download_stall_timeout_seconds",
      { allowString: allowStringNumbers },
    ),
    eh_download: normalizeEhDownload(policy.eh_download),
    extra_args: extraArgs.items,
  };
}

function sanitizePolicyState(value, reasonFallback) {
  const state = isRecord(value) ? value : {};
  if (hasDangerousOwnKey(state)) {
    return { editable: false, reason: "invalid_response", policy: null };
  }
  const requestedEditable = state.editable === true;
  let policy = null;
  if (requestedEditable) {
    try {
      policy = normalizePolicyConfig(state.policy);
    } catch {
      policy = null;
    }
  }
  return {
    editable: Boolean(requestedEditable && policy),
    reason: requestedEditable && policy
      ? ""
      : ITEM_REASONS.has(state.reason) && state.reason
        ? state.reason
        : reasonFallback,
    policy,
  };
}

function sanitizePolicyItem(value) {
  if (!isRecord(value) || hasDangerousOwnKey(value)) return null;
  const definition = SITE_DEFINITIONS[value.site];
  if (!definition || value.label !== definition.label || value.authorization !== definition.authorization) {
    return null;
  }
  const supported = value.supported === true;
  const selectionMode = SELECTION_MODES.has(value.selection_mode) ? value.selection_mode : "per_request";
  const availability = AVAILABILITY_MODES.has(value.availability) ? value.availability : "not_probed";
  const inherited = value.inherited === true;
  const hasOverride = value.has_override === true;
  const state = sanitizePolicyState(value, "invalid_response");
  const shapeValid = supported && inherited !== hasOverride;
  return {
    site: definition.id,
    label: definition.label,
    mark: definition.mark,
    supported,
    authorization: definition.authorization,
    selectionMode,
    availability,
    inherited,
    hasOverride,
    editable: Boolean(shapeValid && state.editable),
    reason: shapeValid && state.editable ? "" : state.reason || "invalid_response",
    updatedAt: inherited ? null : safeTimestamp(value.updated_at),
    policy: shapeValid ? state.policy : null,
  };
}

function unavailablePolicyItem(siteId) {
  const definition = SITE_DEFINITIONS[siteId];
  return {
    site: definition.id,
    label: definition.label,
    mark: definition.mark,
    supported: true,
    authorization: definition.authorization,
    selectionMode: "per_request",
    availability: "not_probed",
    inherited: true,
    hasOverride: false,
    editable: false,
    reason: "missing_source",
    updatedAt: null,
    policy: null,
  };
}

export function sanitizePolicyResponse(value) {
  const snapshot = requireRecord(value, "POLICY 响应");
  if (hasDangerousOwnKey(snapshot)) throw new TypeError("POLICY 响应包含危险键");
  if (snapshot.response_profile !== "policy" || snapshot.secrets_exposed !== false) {
    throw new TypeError("后端未返回 POLICY 安全投影");
  }
  if (!EFFECT_SCOPES.has(snapshot.effect_scope) ||
      !CONCURRENCY_PROTECTIONS.has(snapshot.concurrency_protection) ||
      !DEFAULT_SOURCES.has(snapshot.default_source) ||
      !PERSISTENCE_KINDS.has(snapshot.persistence) ||
      !Array.isArray(snapshot.items)) {
    throw new TypeError("POLICY 契约元数据无效");
  }

  const defaultState = sanitizePolicyState(snapshot.default, "unsafe_default_policy");
  const bySite = new Map();
  let ignoredUnknown = 0;
  for (const raw of snapshot.items.slice(0, SITE_ORDER.length * 3)) {
    if (!isRecord(raw) || !SITE_DEFINITIONS[raw.site]) {
      ignoredUnknown += 1;
      continue;
    }
    const item = sanitizePolicyItem(raw);
    if (!item || bySite.has(item.site)) {
      ignoredUnknown += 1;
      continue;
    }
    bySite.set(item.site, item);
  }
  for (const siteId of SITE_ORDER) {
    if (!bySite.has(siteId)) bySite.set(siteId, unavailablePolicyItem(siteId));
  }
  return {
    bySite,
    defaultPolicy: defaultState.policy,
    defaultEditable: defaultState.editable,
    defaultReason: defaultState.reason,
    effectScope: snapshot.effect_scope,
    concurrencyProtection: snapshot.concurrency_protection,
    defaultSource: snapshot.default_source,
    persistence: snapshot.persistence,
    unknownOverrideCount: Math.min(
      1_000_000,
      safeCount(snapshot.unknown_override_count) + ignoredUnknown,
    ),
  };
}

const POLICY_VIEW_KEYS = new Set(CONFIG_KEYS);
const ITEM_VIEW_KEYS = new Set([
  "site", "label", "mark", "supported", "authorization", "selectionMode", "availability",
  "inherited", "hasOverride", "editable", "reason", "updatedAt", "policy",
]);
const SNAPSHOT_VIEW_KEYS = new Set([
  "bySite", "defaultPolicy", "defaultEditable", "defaultReason", "effectScope",
  "concurrencyProtection", "defaultSource", "persistence", "unknownOverrideCount",
]);

function validatePolicyConfigView(value) {
  const config = requireRecord(value, "POLICY config view model");
  if (!hasOnlyKeys(config, POLICY_VIEW_KEYS)) throw new TypeError("POLICY config 包含未知字段");
  return normalizePolicyConfig(config);
}

function validatePolicyItemView(value) {
  const item = requireRecord(value, "POLICY 来源 view model");
  if (!hasOnlyKeys(item, ITEM_VIEW_KEYS)) throw new TypeError("POLICY 来源包含未知字段");
  const definition = SITE_DEFINITIONS[item.site];
  if (!definition || item.label !== definition.label || item.mark !== definition.mark ||
      item.authorization !== definition.authorization || !AUTHORIZATION_KINDS.has(item.authorization)) {
    throw new TypeError("POLICY 来源标识无效");
  }
  if (!SELECTION_MODES.has(item.selectionMode) || !AVAILABILITY_MODES.has(item.availability) ||
      !ITEM_REASONS.has(item.reason)) {
    throw new TypeError("POLICY 来源能力无效");
  }
  const inherited = exactBoolean(item.inherited, "继承状态");
  const hasOverride = exactBoolean(item.hasOverride, "覆盖状态");
  if (inherited === hasOverride) throw new TypeError("POLICY 覆盖状态矛盾");
  const editable = exactBoolean(item.editable, "可编辑状态");
  let policy = null;
  if (item.policy !== null) policy = validatePolicyConfigView(item.policy);
  if (editable !== Boolean(policy) || (editable && item.reason)) {
    throw new TypeError("POLICY 可编辑状态无效");
  }
  return {
    site: definition.id,
    label: definition.label,
    mark: definition.mark,
    supported: exactBoolean(item.supported, "支持状态"),
    authorization: definition.authorization,
    selectionMode: item.selectionMode,
    availability: item.availability,
    inherited,
    hasOverride,
    editable,
    reason: item.reason,
    updatedAt: item.updatedAt === null ? null : safeTimestamp(item.updatedAt),
    policy,
  };
}

export function validatePolicySnapshot(value) {
  const snapshot = requireRecord(value, "POLICY Store payload");
  if (!hasOnlyKeys(snapshot, SNAPSHOT_VIEW_KEYS) || !(snapshot.bySite instanceof Map)) {
    throw new TypeError("POLICY Store payload 无效");
  }
  const bySite = new Map();
  for (const [siteId, item] of snapshot.bySite) {
    if (!SITE_DEFINITIONS[siteId] || siteId !== item?.site || bySite.has(siteId)) {
      throw new TypeError("POLICY Store 来源无效");
    }
    bySite.set(siteId, validatePolicyItemView(item));
  }
  if (bySite.size !== SITE_ORDER.length) throw new TypeError("POLICY Store 来源不完整");
  const defaultPolicy = snapshot.defaultPolicy === null
    ? null
    : validatePolicyConfigView(snapshot.defaultPolicy);
  const defaultEditable = exactBoolean(snapshot.defaultEditable, "默认策略可编辑状态");
  if (defaultEditable !== Boolean(defaultPolicy) || !ITEM_REASONS.has(snapshot.defaultReason)) {
    throw new TypeError("POLICY 默认策略状态无效");
  }
  if (!EFFECT_SCOPES.has(snapshot.effectScope) ||
      !CONCURRENCY_PROTECTIONS.has(snapshot.concurrencyProtection) ||
      !DEFAULT_SOURCES.has(snapshot.defaultSource) ||
      !PERSISTENCE_KINDS.has(snapshot.persistence)) {
    throw new TypeError("POLICY Store 契约元数据无效");
  }
  if (!Number.isInteger(snapshot.unknownOverrideCount) || snapshot.unknownOverrideCount < 0 ||
      snapshot.unknownOverrideCount > 1_000_000) {
    throw new TypeError("POLICY 未知覆盖计数无效");
  }
  return {
    bySite,
    defaultPolicy,
    defaultEditable,
    defaultReason: snapshot.defaultReason,
    effectScope: snapshot.effectScope,
    concurrencyProtection: snapshot.concurrencyProtection,
    defaultSource: snapshot.defaultSource,
    persistence: snapshot.persistence,
    unknownOverrideCount: snapshot.unknownOverrideCount,
  };
}

export function getPolicySiteDefinition(siteId) {
  return SITE_DEFINITIONS[siteId] || null;
}

export function policyConfigToDraft(config) {
  const normalized = validatePolicyConfigView(config);
  return {
    max_concurrency: String(normalized.max_concurrency),
    retry_limit: String(normalized.retry_limit),
    backoff_base_seconds: String(normalized.backoff_base_seconds),
    proxy_mode: normalized.proxy_mode,
    probe_url: normalized.probe_url || "",
    probe_before_use: normalized.probe_before_use,
    node_tags: normalized.node_tags.join("\n"),
    http_timeout: String(normalized.http_timeout),
    gallery_retries: String(normalized.gallery_retries),
    task_timeout_seconds: String(normalized.task_timeout_seconds),
    download_stall_timeout_seconds: String(normalized.download_stall_timeout_seconds),
    eh_download: normalized.eh_download ? { ...normalized.eh_download } : null,
    extra_args: normalized.extra_args.join("\n"),
  };
}

export function buildPolicyPayload(draft) {
  const normalized = normalizePolicyConfig(draft, { allowStringNumbers: true });
  const payload = {
    max_concurrency: normalized.max_concurrency,
    retry_limit: normalized.retry_limit,
    backoff_base_seconds: normalized.backoff_base_seconds,
    proxy_mode: normalized.proxy_mode,
    probe_url: normalized.probe_url,
    probe_before_use: normalized.probe_before_use,
    node_tags: [...normalized.node_tags],
    http_timeout: normalized.http_timeout,
    gallery_retries: normalized.gallery_retries,
    task_timeout_seconds: normalized.task_timeout_seconds,
    download_stall_timeout_seconds: normalized.download_stall_timeout_seconds,
    eh_download: normalized.eh_download ? { ...normalized.eh_download } : null,
    extra_args: [...normalized.extra_args],
  };
  const requestBytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  if (requestBytes > POLICY_LIMITS.requestBytes) {
    throw new PolicyValidationError("policy", "request_too_large");
  }
  return payload;
}

function canonicalPolicyJson(config) {
  const normalized = validatePolicyConfigView(config);
  return JSON.stringify(CONFIG_KEYS.map((key) => [key, normalized[key]]));
}

export function policyConfigsEqual(left, right) {
  try {
    return canonicalPolicyJson(left) === canonicalPolicyJson(right);
  } catch {
    return false;
  }
}

export function isPolicyDirty(currentConfig, draft) {
  if (!currentConfig) return false;
  try {
    return !policyConfigsEqual(currentConfig, buildPolicyPayload(draft));
  } catch {
    return true;
  }
}

export function validatePolicyDraft(draft) {
  try {
    const payload = buildPolicyPayload(draft);
    const tags = normalizePolicyLines(draft.node_tags, "node_tags");
    return Object.freeze({
      valid: true,
      payload,
      field: "",
      index: null,
      reason: "",
      duplicateNodeTags: tags.duplicatesRemoved,
    });
  } catch (error) {
    const validation = error instanceof PolicyValidationError
      ? error
      : new PolicyValidationError("policy", "invalid_value");
    return Object.freeze({
      valid: false,
      payload: null,
      field: validation.field,
      index: validation.index,
      reason: validation.reason,
      duplicateNodeTags: 0,
    });
  }
}

function control(disabled, reason, label) {
  return Object.freeze({ disabled, reason: disabled ? reason : "", label });
}

export function derivePolicyControls(item, {
  busy = "",
  dirty = false,
  valid = true,
  conflict = false,
} = {}) {
  const isBusy = Boolean(busy);
  const loaded = Boolean(item);
  const editable = Boolean(item?.editable);
  const busyReason = "正在执行其他策略操作";
  const conflictReason = "服务器配置可能已变化，请先刷新后重新编辑";
  const readOnlyReason = item?.reason === "unsafe_stored_policy"
    ? "现有覆盖含 UI 不会读取的危险值；只能恢复默认或在后端修复"
    : "当前来源没有可安全编辑的策略投影";
  const saveReason = isBusy
    ? busyReason
    : conflict
      ? conflictReason
      : !loaded
        ? "请先加载策略"
        : !editable
          ? readOnlyReason
          : !valid
            ? "请修正表单校验错误"
            : !dirty
              ? "当前表单与服务器权威配置一致"
              : "";
  const resetReason = isBusy
    ? busyReason
    : conflict
      ? conflictReason
      : !loaded
        ? "请先加载策略"
        : !item.hasOverride
          ? "当前已经继承启动默认值"
          : "";
  const discardReason = isBusy
    ? busyReason
    : !dirty
      ? "当前没有未保存更改"
      : "";
  return Object.freeze({
    save: control(Boolean(saveReason), saveReason, busy === "save" ? "正在保存…" : "保存站点覆盖"),
    reset: control(Boolean(resetReason), resetReason, busy === "reset" ? "正在恢复…" : "恢复启动默认"),
    discard: control(Boolean(discardReason), discardReason, "放弃未保存更改"),
    refresh: control(isBusy, busyReason, busy === "refresh" ? "正在刷新…" : "手动刷新"),
    siteSelect: control(isBusy, busyReason, "切换来源"),
    vault: control(
      isBusy || item?.authorization === "anonymous",
      isBusy ? busyReason : "此来源不需要 VAULT 授权",
      "打开 VAULT.CPL",
    ),
  });
}

export function formatPolicyTime(value) {
  const timestamp = safeTimestamp(value);
  if (timestamp === null) return "继承值没有单独更新时间";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).format(new Date(timestamp * 1000));
  } catch {
    return "时间不可用";
  }
}

export function formatPolicySource(item) {
  if (!item) return Object.freeze({
    badge: Object.freeze({ status: "disabled", label: "策略待加载" }),
    policyState: "未知",
    support: "尚未加载",
    enablement: "POLICY 不管理来源开关",
    authorization: "尚未加载",
    availability: "未探测",
    updatedAt: "尚无记录",
  });
  const authorization = {
    anonymous: "无需登录材料",
    managed_browser: "需要共享浏览器导出材料；状态请到 VAULT 查看",
    oauth: "需要后端 OAuth 缓存；状态请到 VAULT 查看",
    managed_browser_for_private_content: "E-Hentai 公开搜索可直连；ExHentai 私有内容需要共享浏览器材料",
  }[item.authorization];
  const badge = !item.editable
    ? { status: "error", label: "策略只读" }
    : item.hasOverride
      ? { status: "running", label: "站点覆盖生效" }
      : { status: "ready", label: "继承启动默认" };
  return Object.freeze({
    badge: Object.freeze(badge),
    policyState: item.hasOverride ? "SQLite 站点覆盖" : "进程启动默认快照",
    support: item.supported ? "后端聚合来源已支持" : "后端未声明支持",
    enablement: "由每次搜索/批次请求选择；POLICY 没有启用开关",
    authorization,
    availability: "未执行远端探测；支持、授权与当前可用互不等价",
    updatedAt: formatPolicyTime(item.updatedAt),
  });
}

const ERROR_GUIDANCE = Object.freeze({
  invalid_policy: Object.freeze({
    title: "策略字段未通过校验",
    message: "后端拒绝了当前站点策略；页面不会回显整份表单或原始 details。",
    nextStep: "请按字段帮助与安全定位修正后重试。",
  }),
  invalid_policy_draft: Object.freeze({
    title: "表单字段无效",
    message: "当前草稿没有发送到后端。",
    nextStep: "请修正标记字段；危险输入不会进入 Store、Storage 或错误历史。",
  }),
  unsupported_policy_site: Object.freeze({
    title: "来源不支持 POLICY 编辑",
    message: "当前后端没有把该来源列入 POLICY 受控枚举。",
    nextStep: "请手动刷新；不要通过地址栏构造未知来源。",
  }),
  site_policy_not_found: Object.freeze({
    title: "站点覆盖已经不存在",
    message: "该覆盖可能已在其他客户端删除。",
    nextStep: "请刷新服务器权威配置后重新编辑。",
  }),
  policy_request_too_large: Object.freeze({
    title: "策略请求过大",
    message: "请求超过 POLICY 专用大小上限。",
    nextStep: "请减少节点标签或额外参数的数量/长度。",
  }),
  policy_store_error: Object.freeze({
    title: "策略存储不可用",
    message: "后端未确认 SQLite 原子事务完成。",
    nextStep: "当前页面不会乐观标记成功；请检查磁盘与权限后手动刷新。",
  }),
  invalid_content_length: Object.freeze({
    title: "请求大小信息无效",
    message: "后端拒绝了异常的 Content-Length。",
    nextStep: "请刷新页面并重新编辑。",
  }),
  network_error: Object.freeze({
    title: "后端连接中断",
    message: "POLICY 无法连接到 ImageWeave 后端。",
    nextStep: "连接恢复后使用“手动刷新”，无需重载整个桌面。",
  }),
  invalid_response: Object.freeze({
    title: "策略响应未通过校验",
    message: "页面拒绝采用包含未知、危险或不完整字段的响应。",
    nextStep: "请刷新；若持续发生，请检查后端与桌面 WebUI 版本。",
  }),
});

const SAFE_DETAIL_FIELDS = new Set([...CONFIG_KEYS, "policy"]);
const SAFE_DETAIL_REASONS = /^[a-z0-9_.:-]{1,64}$/i;

export function safePolicyErrorDetail(error) {
  if (error instanceof PolicyValidationError) {
    const index = error.index === null ? "" : `第 ${error.index + 1} 行，`;
    return `${FIELD_LABELS[error.field] || "策略字段"}：${index}原因 ${error.reason}`;
  }
  const rawDetails = Array.isArray(error?.details)
    ? error.details[0]
    : isRecord(error?.details)
      ? error.details
      : null;
  if (!isRecord(rawDetails)) return "";
  const field = SAFE_DETAIL_FIELDS.has(rawDetails.field) ? rawDetails.field : "";
  const reason = typeof rawDetails.reason === "string" && SAFE_DETAIL_REASONS.test(rawDetails.reason)
    ? rawDetails.reason
    : "";
  const index = Number.isInteger(rawDetails.index) && rawDetails.index >= 0 &&
    rawDetails.index < POLICY_LIMITS.extraArgCount
    ? rawDetails.index
    : null;
  if (!field && !reason && index === null) return "";
  const parts = [];
  if (field) parts.push(FIELD_LABELS[field] || "策略字段");
  if (index !== null) parts.push(`第 ${index + 1} 行`);
  if (reason) parts.push(`原因 ${reason}`);
  return parts.join(" · ");
}

export function policyErrorGuidance(error) {
  let code = safeErrorCode(error?.code);
  if (code === "request_failed" && error instanceof PolicyValidationError) code = "invalid_policy_draft";
  if (code === "request_failed" && error instanceof TypeError) code = "invalid_response";
  const status = Number.isInteger(error?.status) ? error.status : 0;
  let guidance = ERROR_GUIDANCE[code];
  if (!guidance && (status === 401 || status === 403)) {
    guidance = {
      title: "POLICY API 拒绝访问",
      message: "后端拒绝了当前同源策略请求。",
      nextStep: "请确认通过 /ui/ 访问并检查后端访问策略。",
    };
  } else if (!guidance && status === 409) {
    guidance = {
      title: "服务器策略状态冲突",
      message: "后端没有接受当前写入。",
      nextStep: "请刷新服务器权威配置后重新编辑；页面不会自动覆盖。",
    };
  } else if (!guidance && status === 413) {
    guidance = ERROR_GUIDANCE.policy_request_too_large;
  } else if (!guidance && status === 422) {
    guidance = ERROR_GUIDANCE.invalid_policy;
  } else if (!guidance && status >= 500) {
    guidance = {
      title: "策略后端暂时不可用",
      message: "后端未完成本次 POLICY 操作。",
      nextStep: "保留当前页面并稍后手动刷新；DIAG.EXE 尚未迁移，当前请检查后端日志。",
    };
  } else if (!guidance) {
    guidance = {
      title: "策略操作未完成",
      message: "本次 POLICY 操作没有完成。",
      nextStep: "请手动刷新后重试；页面不会渲染原始错误 details。",
    };
  }
  return Object.freeze({
    code,
    title: guidance.title,
    message: guidance.message,
    nextStep: guidance.nextStep,
    detail: safePolicyErrorDetail(error),
    requestId: safeRequestId(error?.requestId),
    conflict: status === 409,
  });
}

export function createPolicyRequestGate() {
  let lifecycleVersion = 0;
  let writeVersion = 0;
  let readVersion = 0;

  return Object.freeze({
    advanceLifecycle() {
      lifecycleVersion += 1;
      return lifecycleVersion;
    },
    beginWrite() {
      writeVersion += 1;
      return Object.freeze({ lifecycleVersion, writeVersion });
    },
    beginRead() {
      readVersion += 1;
      return Object.freeze({ lifecycleVersion, writeVersion, readVersion });
    },
    isReadCurrent(ticket) {
      return Boolean(ticket && ticket.lifecycleVersion === lifecycleVersion &&
        ticket.writeVersion === writeVersion && ticket.readVersion === readVersion);
    },
  });
}
