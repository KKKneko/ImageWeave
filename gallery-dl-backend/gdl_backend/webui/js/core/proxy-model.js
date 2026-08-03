const SOURCE_KINDS = new Set(["config", "runtime", "none"]);
const SOURCE_ID_PATTERNS = Object.freeze({
  subscription: /^sub_[0-9a-f]{64}$/,
  inlineNode: /^node_[0-9a-f]{64}$/,
});
const REVISION_PATTERN = /^[0-9a-f]{64}$/;
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]{0,23}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]+/g;
const URL_LIKE = /\bhttps?:\/\/[^\s]+/gi;
const SENSITIVE_ASSIGNMENT = /\b(token|cookie|password|secret|authorization|uuid)\s*[:=]\s*[^\s,;]+/gi;
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ABSOLUTE_PATH_PATTERN = /(^|[\s(])(?:[A-Za-z]:[\\/]|\/)[^\s,;，；)]+/g;
const LONG_TOKEN_PATTERN = /(^|[^A-Za-z0-9])[A-Za-z0-9_~+/=-]{32,}(?=$|[^A-Za-z0-9])/g;

export const PROXY_STATUS_NODE_LIMIT = 500;
export const PROXY_NODE_RENDER_LIMIT = 160;
export const PROXY_SUBSCRIPTION_LIMIT = 128;
export const PROXY_INLINE_NODE_LIMIT = 512;

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label}必须是对象`);
  return value;
}

function safeBoolean(value) {
  return value === true;
}

function safeInteger(value, { minimum = 0, maximum = 1_000_000, fallback = 0 } = {}) {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(maximum, Math.max(minimum, value));
}

function safeNumber(value, { minimum = 0, maximum = 86_400_000, fallback = null } = {}) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

function normalizedText(value, maximum, fallback = "") {
  if (typeof value !== "string") return fallback;
  let text;
  try {
    text = value.normalize("NFKC");
  } catch {
    text = value;
  }
  text = text.replace(CONTROL_CHARACTERS, " ").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.length > maximum ? `${text.slice(0, Math.max(1, maximum - 1))}…` : text;
}

function safeSensitiveText(value, maximum = 300, fallback = "") {
  let text = normalizedText(value, maximum * 2, fallback);
  if (!text) return fallback;
  text = text
    .replace(URL_LIKE, "[地址已隐藏]")
    .replace(SENSITIVE_ASSIGNMENT, "$1=[已隐藏]")
    .replace(UUID_PATTERN, "***")
    .replace(ABSOLUTE_PATH_PATTERN, "$1[路径已隐藏]")
    .replace(LONG_TOKEN_PATTERN, "$1***")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > maximum ? `${text.slice(0, Math.max(1, maximum - 1))}…` : text;
}

function safeToken(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  const text = value.trim();
  return SAFE_TOKEN_PATTERN.test(text) ? text : fallback;
}

function safeScheme(value, fallback = "unknown") {
  if (typeof value !== "string") return fallback;
  const text = value.trim().toLowerCase();
  return SAFE_SCHEME_PATTERN.test(text) ? text : fallback;
}

function safeHost(value) {
  const host = normalizedText(value, 253, "");
  if (!host || /[\s/@?#\\]/.test(host)) return "";
  if (host.startsWith("[") || host.endsWith("]")) return "";
  return host;
}

function displayHost(host) {
  return host.includes(":") ? `[${host}]` : host;
}

function safePort(value) {
  return safeInteger(value, { minimum: 1, maximum: 65_535, fallback: 0 });
}

function safeRevision(value, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  return typeof value === "string" && REVISION_PATTERN.test(value) ? value : null;
}

function safeSourceKind(value) {
  return typeof value === "string" && SOURCE_KINDS.has(value) ? value : "none";
}

function safeDisplayPath(value) {
  const path = normalizedText(value, 240, "");
  if (!path) return null;
  const normalized = path.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    return "路径已隐藏";
  }
  return normalized;
}

function safeTags(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value.slice(0, 32)) {
    const tag = normalizedText(item, 32, "").toLowerCase();
    if (!tag || /[\s/@?#\\]/.test(tag) || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

function sanitizeRuntimeNode(value) {
  if (!isRecord(value)) return null;
  const id = safeToken(value.id);
  if (!id) return null;
  const protocol = safeScheme(value.protocol);
  const endpoint = normalizedText(value.endpoint, 240, "");
  const safeEndpoint = endpoint === "[REDACTED_PROXY]" || (
    /^[a-z][a-z0-9+.-]{0,23}:\/\/(?:\*\*\*@)?(?:\[[0-9a-f:.]+\]|[A-Za-z0-9._-]+)(?::[0-9]{1,5})?$/i.test(endpoint) &&
    !/[?#]/.test(endpoint)
  ) ? endpoint : "端点已隐藏";
  const refCount = safeInteger(value.ref_count, { maximum: 100_000 });
  return {
    id,
    name: safeSensitiveText(value.name, 80, "未命名节点"),
    protocol,
    endpoint: safeEndpoint,
    tags: safeTags(value.tags),
    healthy: safeBoolean(value.healthy),
    retry_eligible: safeBoolean(value.retry_eligible),
    ref_count: refCount,
    success_count: safeInteger(value.success_count, { maximum: 1_000_000_000 }),
    fail_count: safeInteger(value.fail_count, { maximum: 1_000_000_000 }),
    last_latency_ms: safeNumber(value.last_latency_ms),
    cooldown_until: safeNumber(value.cooldown_until, {
      minimum: 0,
      maximum: 10_000_000_000,
      fallback: 0,
    }),
    last_error: safeSensitiveText(value.last_error, 300, ""),
  };
}

function sanitizeTransportCore(value) {
  const core = isRecord(value) ? value : {};
  return {
    enabled: safeBoolean(core.enabled),
    running: safeBoolean(core.running),
    listeners: safeInteger(core.listeners, { maximum: 100_000 }),
    last_error: safeSensitiveText(core.last_error, 300, ""),
  };
}

function sanitizeRuntimeSourceSummary(value) {
  const summary = isRecord(value) ? value : {};
  const rawSchemes = isRecord(summary.scheme_counts) ? summary.scheme_counts : {};
  const schemeCounts = {};
  for (const [rawScheme, rawCount] of Object.entries(rawSchemes).slice(0, 32)) {
    const scheme = safeScheme(rawScheme, "");
    if (scheme) schemeCounts[scheme] = safeInteger(rawCount, { maximum: 1_000_000 });
  }
  const warnings = Array.isArray(summary.warnings)
    ? summary.warnings.slice(0, 20).map((item) => safeSensitiveText(item, 300, "")).filter(Boolean)
    : [];
  return {
    subscriptions: safeInteger(summary.subscriptions, { maximum: PROXY_SUBSCRIPTION_LIMIT }),
    source_nodes: safeInteger(summary.source_nodes),
    pool_nodes: safeInteger(summary.pool_nodes),
    core_candidates: safeInteger(summary.core_candidates),
    core_nodes: safeInteger(summary.core_nodes),
    skipped_nodes: safeInteger(summary.skipped_nodes),
    scheme_counts: schemeCounts,
    warnings,
  };
}

export function sanitizeProxyStatus(value) {
  const status = requireRecord(value, "代理运行状态");
  const rawNodes = Array.isArray(status.nodes) ? status.nodes : [];
  const nodes = rawNodes
    .slice(0, PROXY_STATUS_NODE_LIMIT)
    .map(sanitizeRuntimeNode)
    .filter(Boolean);
  const total = safeInteger(status.total);
  return {
    enabled: safeBoolean(status.enabled),
    engine: normalizedText(status.engine, 32, "unknown"),
    managed_by_backend: safeBoolean(status.managed_by_backend),
    auto_start: safeBoolean(status.auto_start),
    running: safeBoolean(status.running),
    total,
    healthy: Math.min(total, safeInteger(status.healthy)),
    retry_eligible: Math.min(total, safeInteger(status.retry_eligible)),
    leases: safeInteger(status.leases, { maximum: 1_000_000 }),
    last_error: safeSensitiveText(status.last_error, 500, ""),
    transport_core: sanitizeTransportCore(status.transport_core),
    sources: sanitizeRuntimeSourceSummary(status.sources),
    nodes,
    node_rows_received: rawNodes.length,
    nodes_truncated: rawNodes.length > PROXY_STATUS_NODE_LIMIT,
    configured_revision: safeRevision(status.configured_revision),
    active_revision: safeRevision(status.active_revision, { nullable: true }),
    reload_required: safeBoolean(status.reload_required),
  };
}

function sanitizeSubscription(value) {
  if (!isRecord(value) || !SOURCE_ID_PATTERNS.subscription.test(value.id || "")) return null;
  const scheme = value.scheme === "http" || value.scheme === "https" ? value.scheme : "https";
  const host = safeHost(value.host);
  const port = value.port === null ? null : safePort(value.port) || null;
  const authority = host ? `${displayHost(host)}${port ? `:${port}` : ""}` : "…";
  const expectedDisplay = `${scheme}://${authority}/…`;
  const suppliedDisplay = normalizedText(value.display_url, 240, "");
  const displayUrl = /^https?:\/\/(?:\[[0-9a-f:.]+\]|[A-Za-z0-9._-]+|…)(?::[0-9]{1,5})?\/…$/i.test(suppliedDisplay)
    ? suppliedDisplay
    : expectedDisplay;
  return {
    id: value.id,
    source: safeSourceKind(value.source),
    scheme,
    host,
    port,
    display_url: displayUrl,
    credentials_redacted: safeBoolean(value.credentials_redacted),
    sensitive_parts_redacted: safeBoolean(value.sensitive_parts_redacted),
  };
}

function sanitizeInlineNode(value) {
  if (!isRecord(value) || !SOURCE_ID_PATTERNS.inlineNode.test(value.id || "")) return null;
  const scheme = safeScheme(value.scheme);
  const name = safeSensitiveText(value.name, 80, "");
  const host = safeHost(value.host);
  const port = safePort(value.port);
  const authority = host ? `${displayHost(host)}${port ? `:${port}` : ""}` : "";
  // display_endpoint 虽由后端脱敏，仍从同一条目的白名单字段重建，
  // 防止异常响应把额外 userinfo、查询参数或 fragment 秘密带入 DOM。
  const safeDisplay = `${scheme}://***${authority ? `@${authority}` : ""}${name ? `#${name}` : ""}`;
  return {
    id: value.id,
    source: safeSourceKind(value.source),
    scheme,
    name,
    host,
    port,
    requires_transport_core: safeBoolean(value.requires_transport_core),
    display_endpoint: safeDisplay,
  };
}

export function sanitizeProxySources(value) {
  const sources = requireRecord(value, "代理源快照");
  const subscriptions = (Array.isArray(sources.subscriptions) ? sources.subscriptions : [])
    .slice(0, PROXY_SUBSCRIPTION_LIMIT)
    .map(sanitizeSubscription)
    .filter(Boolean);
  const inlineNodes = (Array.isArray(sources.inline_nodes) ? sources.inline_nodes : [])
    .slice(0, PROXY_INLINE_NODE_LIMIT)
    .map(sanitizeInlineNode)
    .filter(Boolean);
  const rawNodeFile = isRecord(sources.node_file) ? sources.node_file : {};
  const rawCounts = isRecord(sources.counts) ? sources.counts : {};
  return {
    source: safeSourceKind(sources.source),
    has_runtime_override: safeBoolean(sources.has_runtime_override),
    runtime_override_valid: safeBoolean(sources.runtime_override_valid),
    configured_revision: safeRevision(sources.configured_revision),
    active_revision: safeRevision(sources.active_revision, { nullable: true }),
    reload_required: safeBoolean(sources.reload_required),
    subscriptions,
    node_file: {
      configured: safeBoolean(rawNodeFile.configured),
      source: safeSourceKind(rawNodeFile.source),
      display_path: safeDisplayPath(rawNodeFile.display_path),
    },
    inline_nodes: inlineNodes,
    counts: {
      subscriptions: safeInteger(rawCounts.subscriptions, { maximum: PROXY_SUBSCRIPTION_LIMIT }),
      node_file: safeInteger(rawCounts.node_file, { maximum: 1 }),
      inline_nodes: safeInteger(rawCounts.inline_nodes, { maximum: PROXY_INLINE_NODE_LIMIT }),
      total: safeInteger(rawCounts.total, { maximum: PROXY_SUBSCRIPTION_LIMIT + PROXY_INLINE_NODE_LIMIT + 1 }),
    },
  };
}

export function formatProxyStatus(status) {
  if (!status) return Object.freeze({ status: "disabled", label: "运行状态待加载" });
  if (!status.enabled) return Object.freeze({ status: "disabled", label: "代理池已停用" });
  if (status.running && status.last_error) {
    return Object.freeze({ status: "warning", label: "运行中，但存在警告" });
  }
  if (status.running) return Object.freeze({ status: "running", label: "代理池运行中" });
  if (status.last_error) return Object.freeze({ status: "error", label: "代理池未运行" });
  return Object.freeze({ status: "warning", label: "代理池尚未启动" });
}

export function formatRevisionPair(configuredRevision, activeRevision) {
  const shorten = (value) => value && REVISION_PATTERN.test(value)
    ? `${value.slice(0, 8)}…${value.slice(-6)}`
    : "—";
  const relation = !activeRevision
    ? "尚未应用"
    : configuredRevision === activeRevision
      ? "相同"
      : "不同";
  return Object.freeze({
    configured: shorten(configuredRevision),
    active: shorten(activeRevision),
    relation,
  });
}

export function formatLatency(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "尚无数据";
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(2)} s`;
}

export function formatCooldown(value, nowMilliseconds = Date.now()) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "无冷却";
  const remaining = Math.ceil(value - Math.max(0, Number(nowMilliseconds) || 0) / 1_000);
  if (remaining <= 0) return "可立即重试";
  if (remaining < 60) return `约 ${remaining} 秒`;
  return `约 ${Math.ceil(remaining / 60)} 分钟`;
}

export function formatRuntimeNode(node, nowMilliseconds = Date.now()) {
  const state = node.healthy
    ? { status: "ready", label: "健康" }
    : node.retry_eligible
      ? { status: "warning", label: "可重试" }
      : { status: "error", label: "冷却或失败" };
  return Object.freeze({
    name: node.name,
    protocol: node.protocol.toUpperCase(),
    endpoint: node.endpoint,
    tags: [...node.tags],
    state,
    lease: node.ref_count > 0 ? `已租用 · 引用 ${node.ref_count}` : "未租用",
    latency: formatLatency(node.last_latency_ms),
    attempts: `成功 ${node.success_count} / 失败 ${node.fail_count}`,
    cooldown: formatCooldown(node.cooldown_until, nowMilliseconds),
    lastError: node.last_error || "无最近错误",
  });
}

export function formatSubscriptionSource(subscription) {
  return Object.freeze({
    display: subscription.display_url,
    authority: `${subscription.scheme} · ${subscription.host || "主机已隐藏"}${subscription.port ? `:${subscription.port}` : ""}`,
    source: subscription.source,
    redaction: subscription.credentials_redacted || subscription.sensitive_parts_redacted
      ? "敏感部分已脱敏"
      : "未包含额外敏感部分",
  });
}

export function formatInlineNodeSource(node) {
  return Object.freeze({
    display: node.display_endpoint,
    identity: `${node.scheme.toUpperCase()} · ${node.name || "未命名节点"}`,
    authority: `${node.host || "主机已隐藏"}${node.port ? `:${node.port}` : ""}`,
    source: node.source,
    transport: node.requires_transport_core ? "需要 Mihomo 传输核心" : "可由原生池加载",
  });
}

export function splitInlineNodeInput(value) {
  if (typeof value !== "string") throw new TypeError("批量节点输入必须是字符串");
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function control(disabled, reason, label) {
  return Object.freeze({ disabled, reason: disabled ? reason : "", label });
}

export function deriveProxyControls(status, { busy = "" } = {}) {
  const isBusy = Boolean(busy);
  const pendingLabel = (kind, normal, pending) => busy === kind ? pending : normal;
  if (!status) {
    const reason = isBusy ? "正在执行其他代理操作" : "请先刷新运行状态";
    return Object.freeze({
      start: control(true, reason, pendingLabel("start", "启动", "正在启动…")),
      stop: control(true, reason, pendingLabel("stop", "停止", "正在停止…")),
      reload: control(true, reason, pendingLabel("reload", "应用并重载", "正在应用…")),
      probe: control(true, reason, pendingLabel("probe", "全池探活", "正在探活…")),
      refresh: control(isBusy, isBusy ? "正在执行其他代理操作" : "", "刷新状态与代理源"),
    });
  }

  const hasLeases = status.leases > 0;
  const busyReason = "正在执行其他代理操作";
  const disabledReason = "代理池在后端配置中已停用";
  const leaseReason = `仍有 ${status.leases} 个活动租约`;
  const startReason = isBusy
    ? busyReason
    : !status.enabled
      ? disabledReason
      : status.running
        ? "代理池已在运行"
        : hasLeases
          ? leaseReason
          : "";
  const stopReason = isBusy
    ? busyReason
    : !status.running
      ? "代理池当前未运行"
      : hasLeases
        ? leaseReason
        : "";
  const reloadReason = isBusy
    ? busyReason
    : !status.enabled
      ? disabledReason
      : hasLeases
        ? leaseReason
        : !status.reload_required
          ? "当前配置已经应用，无需重载"
          : "";
  const probeReason = isBusy
    ? busyReason
    : !status.enabled
      ? disabledReason
      : !status.running
        ? "请先启动代理池"
        : "";

  return Object.freeze({
    start: control(Boolean(startReason), startReason, pendingLabel("start", "启动", "正在启动…")),
    stop: control(Boolean(stopReason), stopReason, pendingLabel("stop", "停止", "正在停止…")),
    reload: control(Boolean(reloadReason), reloadReason, pendingLabel("reload", "应用并重载", "正在应用…")),
    probe: control(Boolean(probeReason), probeReason, pendingLabel("probe", "全池探活", "正在探活…")),
    refresh: control(isBusy, isBusy ? busyReason : "", "刷新状态与代理源"),
  });
}

const ERROR_NEXT_STEPS = Object.freeze({
  proxy_conflict: "请等待任务释放活动租约，再刷新状态后重试；界面不会强制停止任务。",
  invalid_proxy_subscription: "请输入包含主机名的完整 http:// 或 https:// 订阅地址。",
  invalid_proxy_inline_node: "请检查节点格式；批量提交时按提示修正对应行后重试。",
  invalid_proxy_node_file: "请选择许可目录中的可解析普通节点文件。",
  invalid_proxy_source_id: "该列表项已失效，请刷新代理源后重试。",
  proxy_source_path_forbidden: "请把节点文件放入后端配置的 allowed_node_roots 许可目录。",
  proxy_source_not_found: "该代理源可能已被其他操作删除，请刷新列表。",
  proxy_sources_store_error: "托管覆盖可能损坏或发生并发修改；请刷新，损坏时仅使用“恢复 config 默认”。",
  proxy_sources_request_too_large: "请减少本次节点数量或每行长度，再分批提交。",
  invalid_content_length: "请求大小信息无效，请刷新页面后重试。",
  proxy_error: "请保留现有列表并刷新状态；必要时检查节点源与 Mihomo 配置。",
  network_error: "请确认后端仍在运行，连接恢复后使用手动刷新。",
  invalid_response: "后端响应未通过界面校验，请刷新或打开 DIAG.EXE 检查版本。",
});

export function safeProxyErrorDetail(error) {
  const details = isRecord(error?.details) ? error.details : null;
  if (!details) return "";
  const reason = typeof details.reason === "string" && /^[a-z0-9_.:-]{1,64}$/i.test(details.reason)
    ? details.reason
    : "";
  const index = Number.isInteger(details.index) && details.index >= 0 && details.index < PROXY_INLINE_NODE_LIMIT
    ? details.index
    : null;
  if (index !== null && reason) return `后端定位：第 ${index + 1} 行（索引 ${index}），原因 ${reason}`;
  if (index !== null) return `后端定位：第 ${index + 1} 行（索引 ${index}）`;
  if (reason) return `后端原因：${reason}`;
  return "";
}

export function proxyErrorGuidance(error) {
  const code = safeToken(error?.code, "request_failed");
  const status = safeInteger(error?.status, { maximum: 599 });
  const nextStep = ERROR_NEXT_STEPS[code] || (
    status === 413
      ? ERROR_NEXT_STEPS.proxy_sources_request_too_large
      : status === 422
        ? "请检查输入格式后重试；界面不会回显刚提交的秘密值。"
        : status === 409
          ? ERROR_NEXT_STEPS.proxy_conflict
          : "请稍后重试，或打开 DIAG.EXE 检查系统状态。"
  );
  return Object.freeze({ code, nextStep, detail: safeProxyErrorDetail(error) });
}
