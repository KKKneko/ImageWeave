const COMPONENT_STATUSES = new Set(["ok", "error", "disabled", "optional_missing", "optional_warning"]);
const COMPONENT_STATUS_LABELS = Object.freeze({
  ok: "正常",
  error: "异常",
  disabled: "已禁用",
  optional_missing: "可选组件缺失",
  optional_warning: "提示",
});
const COMPONENTS = Object.freeze([
  Object.freeze({ id: "process", label: "服务进程", next: "刷新诊断；若持续离线，请重新启动本地服务。" }),
  Object.freeze({ id: "database", label: "SQLite", next: "请检查数据库目录和权限。" }),
  Object.freeze({ id: "gallery_source", label: "gallery-dl", next: "请检查 gallery-dl 子模块。" }),
  Object.freeze({ id: "project_proxy", label: "代理池", next: "打开代理管理检查节点来源和运行状态。", app: "proxy" }),
  Object.freeze({ id: "mihomo", label: "Mihomo", next: "打开代理管理检查传输核心的安装和状态。", app: "proxy" }),
  Object.freeze({ id: "scheduler", label: "任务调度器", next: "打开批次管理查看活动批次。", app: "tasks" }),
  Object.freeze({ id: "ordered_crawls", label: "批次调度", next: "打开批次管理查看活动批次。", app: "tasks" }),
  Object.freeze({ id: "dedup", label: "去重环境", next: "请检查去重运行环境和模型缓存。" }),
  Object.freeze({ id: "dedup_python", label: "去重运行环境", next: "请检查虚拟环境。" }),
  Object.freeze({ id: "torch", label: "计算环境", next: "请核对 CPU/CUDA 环境。" }),
  Object.freeze({ id: "sscd_model", label: "SSCD 模型", next: "请检查模型缓存。" }),
  Object.freeze({ id: "dino_model", label: "DINOv2 模型", next: "请检查模型缓存。" }),
]);

export const DIAGNOSTICS_POLL_INTERVAL_MS = 20_000;
export const DIAGNOSTIC_COMPONENTS = COMPONENTS;

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedCount(value, maximum = 1_000_000_000) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= maximum ? number : 0;
}

function safeText(value, fallback = "", maximum = 80) {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const text = String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/https?:\/\/[^\s]+/gi, "[地址已隐藏]")
    .replace(/\b(token|cookie|password|secret|authorization|oauth|session)\s*[:=]\s*[^\s,;]+/gi, "$1=[已隐藏]")
    .replace(/(^|[\s(])(?:[A-Za-z]:[\\/]|\/)[^\s,;，；)]+/g, "$1[路径已隐藏]")
    .replace(/\s+/g, " ")
    .trim();
  return text ? text.slice(0, maximum) : fallback;
}

function safeStatus(value, fallback = "error") {
  return typeof value === "string" && COMPONENT_STATUSES.has(value) ? value : fallback;
}

function uiStatus(status) {
  if (status === "ok") return "ready";
  if (status === "disabled") return "disabled";
  if (["optional_missing", "optional_warning"].includes(status)) return "warning";
  return "error";
}

function componentDetail(id, raw) {
  if (!isRecord(raw)) return "";
  if (id === "project_proxy") {
    return `节点来源 ${boundedCount(raw.source_count)} · 健康 ${boundedCount(raw.healthy)} · ${raw.running ? "运行中" : "未运行"}`;
  }
  if (id === "torch") {
    const actual = ["cpu", "cuda", "unknown"].includes(raw.actual_device) ? raw.actual_device : "unknown";
    const configured = ["auto", "cpu", "cuda"].includes(raw.configured_device) ? raw.configured_device : "unknown";
    const version = safeText(raw.version, "未知版本", 40);
    return `Torch ${version} · 配置 ${configured} · 实际 ${actual} · CUDA ${raw.cuda_available ? "可用" : "不可用"}`;
  }
  if (id === "dedup") {
    const resources = isRecord(raw.configured_resources) ? raw.configured_resources : {};
    return `工作线程 ${boundedCount(resources.workers, 64)} · 批大小 ${boundedCount(resources.deep_batch_size, 128)} · 分块 ${boundedCount(resources.neighbor_block_size, 8192)}`;
  }
  if (id === "scheduler") {
    const details = isRecord(raw.details) ? raw.details : {};
    return `活动任务 ${boundedCount(details.active)} / ${boundedCount(details.max_concurrent, 100_000)}`;
  }
  if (id === "ordered_crawls") {
    const details = isRecord(raw.details) ? raw.details : {};
    return `活动批次 ${boundedCount(details.active_batches)}`;
  }
  if (id === "mihomo") return raw.required === false ? "当前设置不需要传输核心" : "按当前代理设置检查";
  return "";
}

export function sanitizeHealthDiagnostics(value) {
  if (!isRecord(value) || typeof value.ok !== "boolean") throw new TypeError("健康响应格式无效");
  const components = isRecord(value.components) ? value.components : {};
  return Object.freeze({
    ok: value.ok,
    process: safeStatus(components.process?.status),
    database: safeStatus(components.database?.status),
  });
}

export function sanitizeReadinessDiagnostics(value) {
  if (!isRecord(value) || typeof value.ready !== "boolean") throw new TypeError("就绪响应格式无效");
  const rawComponents = isRecord(value.components) ? value.components : {};
  const components = [];
  for (const definition of COMPONENTS) {
    const raw = rawComponents[definition.id];
    if (!isRecord(raw)) continue;
    const status = safeStatus(raw.status);
    components.push(Object.freeze({
      id: definition.id,
      label: definition.label,
      status,
      statusLabel: COMPONENT_STATUS_LABELS[status] || "异常",
      uiStatus: uiStatus(status),
      required: raw.required !== false,
      detail: componentDetail(definition.id, raw),
      nextStep: definition.next,
      targetApp: definition.app || "",
    }));
  }
  return Object.freeze({ ready: value.ready, components });
}

export function sanitizeDiagnosticsConfig(value) {
  if (!isRecord(value) || value.response_profile !== "diagnostics" || value.secrets_exposed !== false) {
    throw new TypeError("安全配置数据无效");
  }
  const configuredDevice = ["auto", "cpu", "cuda"].includes(value.dedup?.configured_device)
    ? value.dedup.configured_device
    : "unknown";
  return Object.freeze({
    loopbackOnly: Boolean(value.server?.loopback_only),
    corsEnabled: Boolean(value.server?.cors_enabled),
    privateTargetsEnabled: Boolean(value.server?.private_targets_enabled),
    managedAuthCache: Boolean(value.gallery?.managed_auth_cache),
    proxyEnabled: Boolean(value.proxy?.enabled),
    proxyAutoStart: Boolean(value.proxy?.auto_start),
    transportCoreEnabled: Boolean(value.proxy?.transport_core_enabled),
    schedulerCapacity: boundedCount(value.scheduler?.max_concurrent_tasks, 100_000),
    dedupEnabled: Boolean(value.dedup?.enabled),
    configuredDevice,
    sscdEnabled: Boolean(value.dedup?.sscd_enabled),
    dinoEnabled: Boolean(value.dedup?.dino_enabled),
  });
}

export function sanitizeDiagnosticsScheduler(value) {
  if (!isRecord(value) || value.response_profile !== "diagnostics" || value.secrets_exposed !== false) {
    throw new TypeError("任务调度数据无效");
  }
  return Object.freeze({
    tasksRunning: Boolean(value.tasks?.running),
    activeTasks: boundedCount(value.tasks?.active),
    maxConcurrent: boundedCount(value.tasks?.max_concurrent, 100_000),
    activeSiteCount: boundedCount(value.tasks?.active_site_count, 10_000),
    crawlsRunning: Boolean(value.ordered_crawls?.running),
    activeBatches: boundedCount(value.ordered_crawls?.active_batches),
    executionOrder: value.ordered_crawls?.execution_order === "source_then_address"
      ? "按来源和地址顺序"
      : "未知",
    addressParallelism: value.ordered_crawls?.address_parallelism === "media_tasks"
      ? "图片任务并发"
      : "未知",
  });
}

function outcomeData(outcome) {
  if (!outcome || typeof outcome !== "object") return null;
  if (outcome.data) return outcome.data;
  return isRecord(outcome.error?.details) ? outcome.error.details : null;
}

function safeOutcomeError(outcome) {
  const error = outcome?.error;
  if (!error || typeof error !== "object") return null;
  const code = safeText(error.code, "request_failed", 128).replace(/[^A-Za-z0-9._:-]/g, "") || "request_failed";
  const requestId = safeText(error.requestId, "", 128).replace(/[^A-Za-z0-9._:-]/g, "");
  return Object.freeze({
    status: Number.isInteger(error.status) && error.status >= 0 ? error.status : 0,
    code,
    requestId,
  });
}

export function buildDiagnosticsSnapshot({ health, readiness, config, scheduler, checkedAt = Date.now(), previous = null }) {
  const errors = {
    health: safeOutcomeError(health),
    readiness: safeOutcomeError(readiness),
    config: safeOutcomeError(config),
    scheduler: safeOutcomeError(scheduler),
  };
  const connected = [health, readiness, config, scheduler].some((item) => item?.connected);
  let safeHealth = null;
  let safeReadiness = null;
  let safeConfig = null;
  let safeScheduler = null;
  try { safeHealth = sanitizeHealthDiagnostics(outcomeData(health)); } catch { /* 拒绝采用无效响应。 */ }
  try { safeReadiness = sanitizeReadinessDiagnostics(outcomeData(readiness)); } catch { /* 拒绝采用无效响应。 */ }
  try { safeConfig = sanitizeDiagnosticsConfig(outcomeData(config)); } catch { /* 拒绝采用无效响应。 */ }
  try { safeScheduler = sanitizeDiagnosticsScheduler(outcomeData(scheduler)); } catch { /* 拒绝采用无效响应。 */ }

  const complete = Boolean(safeHealth && safeReadiness && safeConfig && safeScheduler);
  const stale = !complete;
  const previousSnapshot = isRecord(previous) ? previous : null;
  return {
    health: safeHealth || previousSnapshot?.health || null,
    readiness: safeReadiness || previousSnapshot?.readiness || null,
    config: safeConfig || previousSnapshot?.config || null,
    scheduler: safeScheduler || previousSnapshot?.scheduler || null,
    connected,
    offline: !connected,
    stale,
    errors,
    lastCheckedAt: Math.max(0, Number(checkedAt) || 0),
  };
}

export function validateDiagnosticsSnapshot(value) {
  if (!isRecord(value) || typeof value.connected !== "boolean" || typeof value.offline !== "boolean" ||
      typeof value.stale !== "boolean" || !isRecord(value.errors) || !Number.isFinite(value.lastCheckedAt)) {
    throw new TypeError("诊断数据无效");
  }
  if (value.readiness && !Array.isArray(value.readiness.components)) {
    throw new TypeError("组件状态数据无效");
  }
  return value;
}

export function diagnosticsCopyText(snapshot) {
  validateDiagnosticsSnapshot(snapshot);
  const lines = [
    "ImageWeave 诊断摘要（敏感信息已隐藏）",
    `连接：${snapshot.offline ? "离线" : snapshot.stale ? "部分状态未更新" : "在线"}`,
    `服务状态：${snapshot.health?.ok ? "正常" : "异常或未知"}`,
    `功能状态：${snapshot.readiness?.ready ? "已就绪" : "未完全就绪"}`,
    `任务调度：${snapshot.scheduler ? `${snapshot.scheduler.activeTasks}/${snapshot.scheduler.maxConcurrent} 个活动任务，${snapshot.scheduler.activeBatches} 个活动批次` : "未知"}`,
  ];
  for (const component of snapshot.readiness?.components || []) {
    lines.push(`${component.label}：${component.statusLabel}${component.detail ? `（${component.detail}）` : ""}`);
  }
  lines.push(`检查时间：${new Date(snapshot.lastCheckedAt).toISOString()}`);
  return lines.join("\n");
}
