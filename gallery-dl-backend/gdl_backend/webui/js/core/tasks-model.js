const BATCH_STATUSES = new Set([
  "queued", "pending", "planning", "starting", "running", "succeeded",
  "completed_with_errors", "cancelling", "cancelled", "failed",
]);
const TASK_STATUSES = new Set([
  "queued", "pending", "starting", "running", "succeeded", "failed",
  "cancelling", "cancelled",
]);
const REVIEW_STATUSES = new Set([
  "not_started", "waiting_for_crawl", "pending", "analyzing", "auto_applying",
  "ready", "applying", "applied", "failed", "apply_failed", "disabled",
]);
const TERMINAL_BATCHES = new Set(["succeeded", "completed_with_errors", "cancelled"]);
const TERMINAL_TASKS = new Set(["succeeded", "failed", "cancelled"]);
const ACTIVE_REVIEW = new Set(["pending", "analyzing", "auto_applying", "applying"]);
const SITE_IDS = new Set(["danbooru", "twitter", "pixiv", "exhentai", "pawchive"]);
const STATUS_LABELS = Object.freeze({
  queued: "等待", pending: "待处理", planning: "规划中", starting: "启动中",
  running: "运行中", succeeded: "成功", failed: "失败", cancelling: "取消中",
  cancelled: "已取消", completed_with_errors: "完成但有错误",
});
const REVIEW_LABELS = Object.freeze({
  not_started: "去重未开始", waiting_for_crawl: "等待手动启动", pending: "分析已排队",
  analyzing: "去重分析中", auto_applying: "严格自动整理中", ready: "待审核",
  applying: "正在应用", applied: "审核已应用", failed: "分析失败",
  apply_failed: "部分处理失败", disabled: "审核未启用",
});

export const TASK_DISPLAY_LIMIT = 1_000;
export const TASK_POLL_INTERVAL_MS = 1_500;
export const TERMINAL_BATCH_STATUSES = TERMINAL_BATCHES;

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeText(value, fallback = "", maximum = 160) {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const normalized = String(value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/https?:\/\/[^\s]+/gi, "[地址已隐藏]")
    .replace(/\b(token|cookie|password|secret|authorization|oauth|session)\s*[:=]\s*[^\s,;]+/gi, "$1=[已隐藏]")
    .replace(/(^|[\s(])(?:[A-Za-z]:[\\/]|\/)[^\s,;，；)]+/g, "$1[路径已隐藏]")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, maximum) : fallback;
}

function safeId(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text) ? text : "";
}

function boundedCount(value, maximum = 1_000_000_000) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= maximum ? number : 0;
}

function safeTime(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 10_000_000_000 ? number : null;
}

function safeSite(value) {
  const site = typeof value === "string" ? value.trim().toLowerCase() : "";
  return SITE_IDS.has(site) ? site : "unknown";
}

function safeStatus(value, allowed, fallback = "failed") {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function statusKind(status) {
  if (["succeeded"].includes(status)) return "ready";
  if (["queued", "pending", "planning", "starting", "running", "cancelling"].includes(status)) return "running";
  if (["completed_with_errors", "cancelled"].includes(status)) return "warning";
  return "error";
}

function sanitizeReview(value, batchId) {
  if (!isRecord(value)) return null;
  const status = safeStatus(value.status, REVIEW_STATUSES, "not_started");
  return Object.freeze({
    batchId,
    status,
    label: REVIEW_LABELS[status] || status,
    kind: ["ready", "applied"].includes(status)
      ? "ready"
      : ACTIVE_REVIEW.has(status)
        ? "running"
        : status === "disabled"
          ? "disabled"
          : ["failed", "apply_failed"].includes(status)
            ? "error"
            : "warning",
    totalImageCount: boundedCount(value.total_image_count),
    duplicateGroupCount: boundedCount(value.duplicate_group_count),
    decidedGroupCount: boundedCount(value.decided_group_count),
    totalGroupCount: boundedCount(value.total_group_count),
  });
}

function sanitizeAddress(raw, fallbackOrder = 0) {
  if (!isRecord(raw)) return null;
  const id = safeId(raw.id);
  if (!id) return null;
  const status = safeStatus(raw.status, BATCH_STATUSES, "failed");
  return Object.freeze({
    id,
    order: boundedCount(raw.address_order, 100_000) || fallbackOrder,
    label: safeText(raw.label, "未命名地址", 140),
    addressType: safeText(raw.address_type, "图库地址", 60),
    status,
    statusLabel: STATUS_LABELS[status] || status,
    statusKind: statusKind(status),
    plannedTaskCount: boundedCount(raw.planned_task_count),
    succeededTaskCount: boundedCount(raw.succeeded_task_count),
    failedTaskCount: boundedCount(raw.failed_task_count),
    cancelledTaskCount: boundedCount(raw.cancelled_task_count),
    preDedupSkippedCount: boundedCount(raw.pre_dedup_skipped_count),
    probedProxyCount: boundedCount(raw.probed_proxy_count),
    healthyProxyCount: boundedCount(raw.healthy_proxy_count),
    hasPlanningIssue: Boolean(safeText(raw.planning_error || raw.last_error, "", 10)),
  });
}

function sanitizeSources(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const raw of value.slice(0, 20)) {
    if (!isRecord(raw)) continue;
    const site = safeSite(raw.site);
    if (site === "unknown") continue;
    const status = safeStatus(raw.status, BATCH_STATUSES, "failed");
    const addresses = [];
    for (const item of Array.isArray(raw.addresses) ? raw.addresses.slice(0, 500) : []) {
      const address = sanitizeAddress(item, addresses.length);
      if (address) addresses.push(address);
    }
    result.push(Object.freeze({
      order: boundedCount(raw.order, 100_000) || result.length,
      site,
      status,
      statusLabel: STATUS_LABELS[status] || status,
      statusKind: statusKind(status),
      preDedupSkippedCount: boundedCount(raw.pre_dedup_skipped_count),
      addresses,
    }));
  }
  return result;
}

function sanitizeCurrent(value) {
  if (!isRecord(value)) return null;
  const addressId = safeId(value.address_id);
  if (!addressId) return null;
  const status = safeStatus(value.status, BATCH_STATUSES, "failed");
  return Object.freeze({
    addressId,
    site: safeSite(value.site),
    sourceOrder: boundedCount(value.source_order, 100_000),
    addressOrder: boundedCount(value.address_order, 100_000),
    status,
    statusLabel: STATUS_LABELS[status] || status,
  });
}

export function sanitizeBatchDetail(value) {
  if (!isRecord(value)) throw new TypeError("批次详情格式无效");
  const id = safeId(value.id);
  if (!id) throw new TypeError("批次 ID 无效");
  const status = safeStatus(value.status, BATCH_STATUSES, "failed");
  return Object.freeze({
    id,
    status,
    statusLabel: STATUS_LABELS[status] || status,
    statusKind: statusKind(status),
    createdAt: safeTime(value.created_at),
    updatedAt: safeTime(value.updated_at),
    finishedAt: safeTime(value.finished_at),
    cancelRequested: Boolean(value.cancel_requested),
    concurrency: boundedCount(value.concurrency, 128),
    maxTasks: boundedCount(value.max_tasks, 100_000),
    taskCount: boundedCount(value.task_count),
    succeededTaskCount: boundedCount(value.succeeded_task_count),
    failedTaskCount: boundedCount(value.failed_task_count),
    cancelledTaskCount: boundedCount(value.cancelled_task_count),
    preDedupSkippedCount: boundedCount(value.pre_dedup_skipped_count),
    resumable: Boolean(value.resumable),
    current: sanitizeCurrent(value.current),
    sources: sanitizeSources(value.sources),
    review: sanitizeReview(value.review, id),
  });
}

export function sanitizeTaskPage(value, batchId) {
  if (!isRecord(value) || !Array.isArray(value.items) || !safeId(batchId)) {
    throw new TypeError("批次任务页格式无效");
  }
  const tasks = [];
  for (const raw of value.items.slice(0, TASK_DISPLAY_LIMIT)) {
    if (!isRecord(raw)) continue;
    const id = safeId(raw.id);
    if (!id) continue;
    const status = safeStatus(raw.status, TASK_STATUSES, "failed");
    const errorClass = safeText(raw.error_class || raw.last_error_class, "", 80)
      .toLowerCase()
      .replace(/[^a-z0-9_.:-]/g, "");
    tasks.push(Object.freeze({
      id,
      site: safeSite(raw.site),
      status,
      statusLabel: STATUS_LABELS[status] || status,
      statusKind: statusKind(status),
      sourceOrder: boundedCount(raw.source_order, 100_000),
      addressOrder: boundedCount(raw.address_order, 100_000),
      sequence: boundedCount(raw.sequence_no, 1_000_000),
      attemptCount: boundedCount(raw.attempt_count, 1_000),
      maxAttempts: boundedCount(raw.max_attempts, 1_000),
      artifactCount: boundedCount(raw.artifact_count),
      errorClass,
      terminal: TERMINAL_TASKS.has(status),
    }));
  }
  return Object.freeze({ batchId, tasks });
}

export function sanitizeRecentBatches(value) {
  if (!isRecord(value) || !Array.isArray(value.items)) throw new TypeError("最近批次格式无效");
  const items = [];
  for (const raw of value.items.slice(0, 30)) {
    if (!isRecord(raw)) continue;
    const id = safeId(raw.id);
    if (!id) continue;
    const status = safeStatus(raw.status, BATCH_STATUSES, "failed");
    items.push(Object.freeze({
      id,
      status,
      statusLabel: STATUS_LABELS[status] || status,
      statusKind: statusKind(status),
      createdAt: safeTime(raw.created_at),
      taskCount: boundedCount(raw.task_count),
      succeededTaskCount: boundedCount(raw.succeeded_task_count),
      failedTaskCount: boundedCount(raw.failed_task_count),
      terminal: TERMINAL_BATCHES.has(status),
    }));
  }
  return items;
}

export function validateBatchState({ batch, tasks, recent }) {
  if (batch !== null && (!isRecord(batch) || !safeId(batch.id) ||
      Object.prototype.hasOwnProperty.call(batch, "output_dir") ||
      Object.prototype.hasOwnProperty.call(batch, "url"))) {
    throw new TypeError("批次安全投影无效");
  }
  if (!Array.isArray(tasks) || !Array.isArray(recent)) throw new TypeError("批次列表安全投影无效");
  for (const task of tasks) {
    if (!isRecord(task) || !safeId(task.id) || Object.prototype.hasOwnProperty.call(task, "url") ||
        Object.prototype.hasOwnProperty.call(task, "output_dir") ||
        Object.prototype.hasOwnProperty.call(task, "cookies_file")) {
      throw new TypeError("任务安全投影无效");
    }
  }
  for (const item of recent) {
    if (!isRecord(item) || !safeId(item.id) || Object.prototype.hasOwnProperty.call(item, "output_dir")) {
      throw new TypeError("最近批次安全投影无效");
    }
  }
  return { batch, tasks, recent };
}

export function shouldPollBatch(batch) {
  return Boolean(batch && !TERMINAL_BATCHES.has(batch.status));
}

export function batchProgress(batch) {
  if (!batch) return Object.freeze({ terminal: 0, total: 0, percent: 0 });
  const terminal = batch.succeededTaskCount + batch.failedTaskCount + batch.cancelledTaskCount;
  const total = batch.taskCount;
  const percent = total
    ? Math.min(100, Math.round((terminal / total) * 100))
    : TERMINAL_BATCHES.has(batch.status)
      ? 100
      : 0;
  return Object.freeze({ terminal, total, percent });
}

export function taskRecoveryTargets(tasks) {
  const authSites = new Set();
  let proxyIssue = false;
  for (const task of tasks || []) {
    if (task.errorClass === "authentication" && task.site !== "unknown") authSites.add(task.site);
    if (task.errorClass.includes("proxy")) proxyIssue = true;
  }
  return Object.freeze({ authSites: Object.freeze([...authSites]), proxyIssue });
}

export function formatBatchTime(value) {
  if (!Number.isFinite(value)) return "—";
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(value * 1_000));
  } catch {
    return "—";
  }
}

export function shortBatchId(value) {
  const id = safeId(value);
  if (!id) return "—";
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export function taskErrorGuidance(error) {
  const code = safeText(error?.code, "request_failed", 128).replace(/[^A-Za-z0-9._:-]/g, "") || "request_failed";
  const status = Number.isInteger(error?.status) ? error.status : 0;
  const requestId = safeId(error?.requestId);
  const missing = code === "crawl_not_found" || status === 404;
  const conflict = status === 409;
  const auth = /auth|credential|login/i.test(code);
  const proxy = /proxy/i.test(code);
  return Object.freeze({
    code,
    requestId,
    missing,
    conflict,
    targetApp: auth ? "vault" : proxy ? "proxy" : "diagnostics",
    title: missing ? "批次不存在" : conflict ? "批次状态已变化" : "批次操作未完成",
    message: status === 0 ? "无法连接到 ImageWeave 后端。" : "后端没有接受本次批次操作。",
    nextStep: missing
      ? "选择另一个最近批次；陈旧 session 批次 ID 会被清除。"
      : conflict
        ? "页面将重新读取权威状态；请根据最新状态选择可用操作。"
        : auth
          ? "打开 VAULT.CPL 修复授权后，再使用批次级恢复操作。"
          : proxy
            ? "打开 PROXY.CPL 检查代理池后，再使用批次级恢复操作。"
            : "保留当前批次，手动刷新或打开 DIAG.EXE 检查连接。",
  });
}

export function createBatchRequestGate() {
  let lifecycle = 0;
  let write = 0;
  let sequence = 0;
  let applied = 0;
  return Object.freeze({
    beginRead(batchId) {
      const ticket = Object.freeze({ lifecycle, write, sequence: ++sequence, batchId: safeId(batchId) });
      if (!ticket.batchId) throw new TypeError("批次读取 ID 无效");
      return ticket;
    },
    isReadCurrent(ticket, batchId) {
      const current = ticket?.lifecycle === lifecycle && ticket?.write === write &&
        ticket?.sequence >= applied && ticket?.batchId === safeId(batchId);
      if (current) applied = ticket.sequence;
      return current;
    },
    beginWrite() {
      write += 1;
    },
    advanceLifecycle() {
      lifecycle += 1;
    },
  });
}
