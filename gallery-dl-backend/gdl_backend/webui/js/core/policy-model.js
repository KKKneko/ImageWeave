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
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export const POLICY_SITE_IDS = SITE_ORDER;
export const POLICY_LIMITS = Object.freeze({
  requestBytes: 16 * 1024,
});

const NUMERIC_RULES = Object.freeze({
  max_concurrency: Object.freeze({ minimum: 1, maximum: 128, integer: true }),
  retry_limit: Object.freeze({ minimum: 0, maximum: 20, integer: true }),
  backoff_base_seconds: Object.freeze({ minimum: 0, maximum: 3600, integer: false }),
});

const FIELD_LABELS = Object.freeze({
  policy: "站点设置",
  max_concurrency: "最大并发数",
  retry_limit: "重试次数",
  backoff_base_seconds: "首次重试等待",
  proxy_mode: "连接方式",
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
  constructor(field, reason) {
    const safeField = CONFIG_KEY_SET.has(field) ? field : "policy";
    const safeReason = typeof reason === "string" && /^[a-z0-9_.:-]{1,64}$/i.test(reason)
      ? reason
      : "invalid_value";
    super(`${FIELD_LABELS[safeField] || "站点设置"}无效`);
    this.name = "PolicyValidationError";
    this.code = "invalid_policy_draft";
    this.status = 0;
    this.field = safeField;
    this.reason = safeReason;
    this.index = null;
  }
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

function normalizePolicyConfig(value, { allowStringNumbers = false } = {}) {
  const policy = requireRecord(value, "站点设置");
  if (hasDangerousOwnKey(policy)) throw new PolicyValidationError("policy", "dangerous_key");
  if (!hasOnlyKeys(policy, CONFIG_KEY_SET)) {
    throw new PolicyValidationError("policy", "unknown_field");
  }
  for (const key of CONFIG_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(policy, key)) {
      throw new PolicyValidationError(key, "missing_field");
    }
  }
  if (typeof policy.proxy_mode !== "string" || !PROXY_MODES.has(policy.proxy_mode)) {
    throw new PolicyValidationError("proxy_mode", "invalid_enum");
  }
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
    proxy_mode: policy.proxy_mode,
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
  const snapshot = requireRecord(value, "站点设置响应");
  if (hasDangerousOwnKey(snapshot)) throw new TypeError("站点设置响应包含危险键");
  if (snapshot.response_profile !== "policy" || snapshot.secrets_exposed !== false) {
    throw new TypeError("服务没有返回可用的站点设置");
  }
  if (!EFFECT_SCOPES.has(snapshot.effect_scope) ||
      !CONCURRENCY_PROTECTIONS.has(snapshot.concurrency_protection) ||
      !DEFAULT_SOURCES.has(snapshot.default_source) ||
      !PERSISTENCE_KINDS.has(snapshot.persistence) ||
      !Array.isArray(snapshot.items)) {
    throw new TypeError("站点设置响应格式无效");
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
  const config = requireRecord(value, "站点设置数据");
  if (!hasOnlyKeys(config, POLICY_VIEW_KEYS)) throw new TypeError("站点设置包含未知字段");
  return normalizePolicyConfig(config);
}

function validatePolicyItemView(value) {
  const item = requireRecord(value, "站点设置项目");
  if (!hasOnlyKeys(item, ITEM_VIEW_KEYS)) throw new TypeError("站点设置项目包含未知字段");
  const definition = SITE_DEFINITIONS[item.site];
  if (!definition || item.label !== definition.label || item.mark !== definition.mark ||
      item.authorization !== definition.authorization || !AUTHORIZATION_KINDS.has(item.authorization)) {
    throw new TypeError("站点标识无效");
  }
  if (!SELECTION_MODES.has(item.selectionMode) || !AVAILABILITY_MODES.has(item.availability) ||
      !ITEM_REASONS.has(item.reason)) {
    throw new TypeError("站点状态无效");
  }
  const inherited = exactBoolean(item.inherited, "默认状态");
  const hasOverride = exactBoolean(item.hasOverride, "单独设置状态");
  if (inherited === hasOverride) throw new TypeError("站点设置状态矛盾");
  const editable = exactBoolean(item.editable, "可编辑状态");
  let policy = null;
  if (item.policy !== null) policy = validatePolicyConfigView(item.policy);
  if (editable !== Boolean(policy) || (editable && item.reason)) {
    throw new TypeError("站点可编辑状态无效");
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
  const snapshot = requireRecord(value, "站点设置数据");
  if (!hasOnlyKeys(snapshot, SNAPSHOT_VIEW_KEYS) || !(snapshot.bySite instanceof Map)) {
    throw new TypeError("站点设置数据无效");
  }
  const bySite = new Map();
  for (const [siteId, item] of snapshot.bySite) {
    if (!SITE_DEFINITIONS[siteId] || siteId !== item?.site || bySite.has(siteId)) {
      throw new TypeError("站点设置来源无效");
    }
    bySite.set(siteId, validatePolicyItemView(item));
  }
  if (bySite.size !== SITE_ORDER.length) throw new TypeError("站点列表不完整");
  const defaultPolicy = snapshot.defaultPolicy === null
    ? null
    : validatePolicyConfigView(snapshot.defaultPolicy);
  const defaultEditable = exactBoolean(snapshot.defaultEditable, "默认设置可编辑状态");
  if (defaultEditable !== Boolean(defaultPolicy) || !ITEM_REASONS.has(snapshot.defaultReason)) {
    throw new TypeError("默认设置状态无效");
  }
  if (!EFFECT_SCOPES.has(snapshot.effectScope) ||
      !CONCURRENCY_PROTECTIONS.has(snapshot.concurrencyProtection) ||
      !DEFAULT_SOURCES.has(snapshot.defaultSource) ||
      !PERSISTENCE_KINDS.has(snapshot.persistence)) {
    throw new TypeError("站点设置数据格式无效");
  }
  if (!Number.isInteger(snapshot.unknownOverrideCount) || snapshot.unknownOverrideCount < 0 ||
      snapshot.unknownOverrideCount > 1_000_000) {
    throw new TypeError("站点设置计数无效");
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
  };
}

export function buildPolicyPayload(draft) {
  const normalized = normalizePolicyConfig(draft, { allowStringNumbers: true });
  const payload = {
    max_concurrency: normalized.max_concurrency,
    retry_limit: normalized.retry_limit,
    backoff_base_seconds: normalized.backoff_base_seconds,
    proxy_mode: normalized.proxy_mode,
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
    return Object.freeze({
      valid: true,
      payload,
      field: "",
      index: null,
      reason: "",
    });
  } catch (error) {
    const validation = error instanceof PolicyValidationError
      ? error
      : new PolicyValidationError("policy", "invalid_value");
    return Object.freeze({
      valid: false,
      payload: null,
      field: validation.field,
      index: null,
      reason: validation.reason,
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
} = {}) {
  const isBusy = Boolean(busy);
  const loaded = Boolean(item);
  const editable = Boolean(item?.editable);
  const busyReason = "请等待当前操作完成";
  const readOnlyReason = "当前站点设置暂时无法编辑";
  const saveReason = isBusy
    ? busyReason
    : !loaded
      ? "请先等待设置加载"
      : !editable
        ? readOnlyReason
        : !valid
          ? "请先修正填写内容"
          : !dirty
            ? "当前内容没有变化"
            : "";
  const resetReason = isBusy
    ? busyReason
    : !loaded
      ? "请先等待设置加载"
      : !item.hasOverride && !dirty
        ? "当前已使用默认设置"
        : "";
  return Object.freeze({
    save: control(Boolean(saveReason), saveReason, busy === "save" ? "正在保存…" : "保存设置"),
    reset: control(Boolean(resetReason), resetReason, busy === "reset" ? "正在恢复…" : "恢复默认设置"),
    siteSelect: control(isBusy, busyReason, "切换站点"),
  });
}

export function formatPolicySource(item) {
  if (!item) return Object.freeze({
    badge: Object.freeze({ status: "disabled", label: "正在加载" }),
    policyState: "正在加载",
  });
  const badge = !item.editable
    ? { status: "error", label: "暂时无法设置" }
    : item.hasOverride
      ? { status: "running", label: "自定义设置" }
      : { status: "ready", label: "默认设置" };
  return Object.freeze({
    badge: Object.freeze(badge),
    policyState: item.hasOverride ? "使用自定义设置" : "使用默认设置",
  });
}

const ERROR_GUIDANCE = Object.freeze({
  invalid_policy: Object.freeze({
    title: "设置有误",
    message: "服务未接受本次站点设置。",
    nextStep: "请检查标出的项目后再保存。",
  }),
  invalid_policy_draft: Object.freeze({
    title: "请修正设置",
    message: "更改尚未发送。",
    nextStep: "请修正标出的项目后再保存。",
  }),
  unsupported_policy_site: Object.freeze({
    title: "该站点不支持自定义设置",
    message: "当前版本不支持修改该站点。",
    nextStep: "请刷新页面；如果仍然出现，请更新服务和界面版本。",
  }),
  site_policy_not_found: Object.freeze({
    title: "已使用默认设置",
    message: "该站点没有单独保存的设置。",
    nextStep: "请刷新站点设置。",
  }),
  policy_request_too_large: Object.freeze({
    title: "提交内容太大",
    message: "服务拒绝了异常大的设置请求。",
    nextStep: "请刷新页面后重试。",
  }),
  policy_store_error: Object.freeze({
    title: "暂时无法保存设置",
    message: "服务未确认本次修改已保存。",
    nextStep: "修改已保留，请稍后重试。",
  }),
  invalid_content_length: Object.freeze({
    title: "请求格式不正确",
    message: "服务未接受请求大小信息。",
    nextStep: "请刷新页面后重试。",
  }),
  network_error: Object.freeze({
    title: "无法连接服务",
    message: "站点设置无法连接到 ImageWeave 服务。",
    nextStep: "请确认服务正在运行，然后重试。",
  }),
  invalid_response: Object.freeze({
    title: "设置数据无效",
    message: "页面未采用格式无效的服务数据。",
    nextStep: "请刷新页面；如果仍然出现，请更新服务和界面版本。",
  }),
});

const SAFE_DETAIL_FIELDS = new Set([...CONFIG_KEYS, "policy"]);
const SAFE_DETAIL_REASONS = /^[a-z0-9_.:-]{1,64}$/i;
const SAFE_DETAIL_REASON_TEXT = Object.freeze({
  missing_field: "缺少必填内容",
  extra_forbidden: "包含不支持的项目",
  int_type: "需要填写整数",
  int_parsing: "需要填写整数",
  float_type: "需要填写数字",
  float_parsing: "需要填写数字",
  greater_than_equal: "小于允许范围",
  less_than_equal: "超过允许范围",
  literal_error: "不是可选内容",
  invalid_policy: "内容不正确",
  invalid_enum: "不是可选内容",
  not_number: "需要填写数字",
  not_integer: "需要填写整数",
  empty_number: "不能留空",
  out_of_range: "超出允许范围",
  unknown_field: "包含不支持的项目",
  dangerous_key: "包含不安全的内容",
  invalid_value: "内容不正确",
});

function safePolicyReasonText(reason) {
  return SAFE_DETAIL_REASON_TEXT[reason] || "内容不正确";
}

export function safePolicyErrorDetail(error) {
  if (error instanceof PolicyValidationError) {
    return `${FIELD_LABELS[error.field] || "站点设置"}：${safePolicyReasonText(error.reason)}`;
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
  if (!field && !reason) return "";
  const parts = [];
  if (field) parts.push(FIELD_LABELS[field] || "站点设置");
  if (reason) parts.push(safePolicyReasonText(reason));
  return parts.join("：");
}

export function policyErrorGuidance(error) {
  let code = safeErrorCode(error?.code);
  if (code === "request_failed" && error instanceof PolicyValidationError) code = "invalid_policy_draft";
  if (code === "request_failed" && error instanceof TypeError) code = "invalid_response";
  const status = Number.isInteger(error?.status) ? error.status : 0;
  let guidance = ERROR_GUIDANCE[code];
  if (!guidance && (status === 401 || status === 403)) {
    guidance = {
      title: "访问被拒绝",
      message: "本次站点设置请求未通过。",
      nextStep: "请从 ImageWeave 的 /ui/ 页面重新打开。",
    };
  } else if (!guidance && status === 409) {
    guidance = {
      title: "设置已更新",
      message: "服务未接受本次修改。",
      nextStep: "请刷新最新设置，核对后重新保存。",
    };
  } else if (!guidance && status === 413) {
    guidance = ERROR_GUIDANCE.policy_request_too_large;
  } else if (!guidance && status === 422) {
    guidance = ERROR_GUIDANCE.invalid_policy;
  } else if (!guidance && status >= 500) {
    guidance = {
      title: "服务暂时不可用",
      message: "本次站点设置没有完成。",
      nextStep: "修改已保留，请稍后重试。",
    };
  } else if (!guidance) {
    guidance = {
      title: "操作失败",
      message: "本次站点设置没有完成。",
      nextStep: "请稍后重试。",
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
