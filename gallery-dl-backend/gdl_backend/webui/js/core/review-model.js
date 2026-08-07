const REVIEW_STATUSES = new Set([
  "not_started", "waiting_for_crawl", "pending", "analyzing", "auto_applying",
  "ready", "applying", "applied", "failed", "apply_failed", "disabled",
]);
const FILTERS = new Set(["", "duplicate", "single", "unreadable"]);
const GROUP_KINDS = new Set(["duplicate", "single", "unreadable"]);
const ACTIVE_STATUSES = new Set(["pending", "analyzing", "auto_applying", "applying"]);
const LISTABLE_STATUSES = new Set(["ready", "applying", "applied", "apply_failed"]);
const STABLE_STATUSES = new Set([
  "not_started", "waiting_for_crawl", "ready", "applied", "failed", "apply_failed", "disabled",
]);
const STATUS_LABELS = Object.freeze({
  not_started: "去重未开始", waiting_for_crawl: "待开始分析", pending: "分析已排队",
  analyzing: "去重分析中", auto_applying: "自动去重中", ready: "待审核",
  applying: "正在应用", applied: "审核已应用", failed: "分析失败",
  apply_failed: "部分处理失败", disabled: "审核未启用",
});

export const REVIEW_PAGE_LIMIT = 8;
export const REVIEW_POLL_INTERVAL_MS = 1_500;
export const REVIEW_FILTERS = Object.freeze([
  Object.freeze({ id: "", label: "全部" }),
  Object.freeze({ id: "duplicate", label: "重复组" }),
  Object.freeze({ id: "single", label: "独立图片" }),
  Object.freeze({ id: "unreadable", label: "读取失败" }),
]);

const DECK_EDIT_COMMANDS = new Set([
  "accept-advance", "keep-all", "discard-all", "reset-recommended", "save",
]);

function requireDeckPosition({ focusedIndex, groupCount, offset, limit, total }) {
  const values = { focusedIndex, groupCount, offset, limit, total };
  if (!Object.values(values).every(Number.isInteger) || focusedIndex < 0 || groupCount < 0 ||
      offset < 0 || limit <= 0 || total < 0 || (groupCount && focusedIndex >= groupCount)) {
    throw new TypeError("审核分拣台位置无效");
  }
  return values;
}

export function resolveDeckCommand(key, { editable = false } = {}) {
  if (typeof key !== "string") return null;
  let command = null;
  if (/^[1-9]$/.test(key)) command = `toggle-${key}`;
  else if (key === "Enter" || key === " ") command = "accept-advance";
  else if (key === "Backspace") command = "discard-all";
  else if (key === "ArrowLeft") command = "prev-group";
  else if (key === "ArrowRight") command = "next-group";
  else if (key === "Home") command = "first-group";
  else if (key === "End") command = "last-group";
  else if (key === "PageUp") command = "prev-page";
  else if (key === "PageDown") command = "next-page";
  else {
    const normalized = key.toLowerCase();
    command = ({
      a: "keep-all",
      d: "discard-all",
      r: "reset-recommended",
      h: "prev-group",
      l: "next-group",
      i: "toggle-inspector",
      s: "save",
    })[normalized] || null;
  }
  const editCommand = /^toggle-[1-9]$/.test(command || "") || DECK_EDIT_COMMANDS.has(command);
  return editCommand && !editable ? null : command;
}

export function deckAdvanceTarget(position) {
  const { focusedIndex, groupCount, offset, limit, total } = requireDeckPosition(position);
  if (groupCount && focusedIndex + 1 < groupCount) {
    return Object.freeze({ type: "group", index: focusedIndex + 1 });
  }
  if (offset + limit < total) {
    return Object.freeze({ type: "next-page", offset: offset + limit });
  }
  return Object.freeze({ type: "complete" });
}

export function deckStepTarget(direction, position) {
  if (direction !== -1 && direction !== 1) throw new TypeError("审核分拣台方向无效");
  const { focusedIndex, groupCount, offset, limit, total } = requireDeckPosition(position);
  if (!groupCount) return Object.freeze({ type: "edge" });
  if (direction < 0) {
    if (focusedIndex > 0) return Object.freeze({ type: "group", index: focusedIndex - 1 });
    if (offset > 0) return Object.freeze({ type: "prev-page", offset: Math.max(0, offset - limit) });
    return Object.freeze({ type: "edge" });
  }
  if (focusedIndex + 1 < groupCount) {
    return Object.freeze({ type: "group", index: focusedIndex + 1 });
  }
  if (offset + limit < total) {
    return Object.freeze({ type: "next-page", offset: offset + limit });
  }
  return Object.freeze({ type: "edge" });
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeText(value, fallback = "", maximum = 120) {
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

function boundedMetric(value, minimum = 0, maximum = 1_000_000_000) {
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function safeStatus(value) {
  return typeof value === "string" && REVIEW_STATUSES.has(value) ? value : "failed";
}

function statusKind(status) {
  if (["ready", "applied"].includes(status)) return "ready";
  if (ACTIVE_STATUSES.has(status)) return "running";
  if (["not_started", "waiting_for_crawl", "apply_failed"].includes(status)) return "warning";
  if (status === "disabled") return "disabled";
  return "error";
}

function safeFormat(value) {
  const format = safeText(value, "未知格式", 24).toUpperCase();
  return /^[A-Z0-9+._-]{1,24}$/.test(format) ? format : "未知格式";
}

function sanitizeMetrics(value) {
  if (!isRecord(value)) return null;
  return Object.freeze({
    candidateLevel: safeText(value.candidate_level, "候选", 40),
    sscdSimilarity: boundedMetric(value.sscd_similarity, -1, 1),
    dinoSimilarity: boundedMetric(value.dino_similarity, -1, 1),
  });
}

function sanitizeImage(raw, imageIndex) {
  if (!isRecord(raw)) return null;
  const id = safeId(raw.id);
  if (!id) return null;
  const metadata = isRecord(raw.metadata) ? raw.metadata : {};
  return Object.freeze({
    id,
    ordinal: boundedCount(raw.ordinal, 100_000) || imageIndex + 1,
    readable: Boolean(raw.readable),
    recommended: Boolean(raw.recommended),
    selected: Boolean(raw.selected),
    width: boundedCount(metadata.w, 1_000_000),
    height: boundedCount(metadata.h, 1_000_000),
    format: safeFormat(metadata.format),
    bytes: boundedCount(metadata.size, Number.MAX_SAFE_INTEGER),
    jpegQuality: boundedMetric(metadata.jpeg_quality, 0, 100),
    sharpness: boundedMetric(metadata.sharpness, -1_000_000, 1_000_000),
    noiseSigma: boundedMetric(metadata.noise_sigma, 0, 1_000_000),
    metrics: sanitizeMetrics(metadata.review_metrics),
  });
}

function sanitizeGroup(raw, groupIndex) {
  if (!isRecord(raw)) return null;
  const id = safeId(raw.id);
  if (!id) return null;
  const kind = typeof raw.kind === "string" && GROUP_KINDS.has(raw.kind) ? raw.kind : "single";
  const images = [];
  for (const item of Array.isArray(raw.images) ? raw.images.slice(0, 1_000) : []) {
    const image = sanitizeImage(item, images.length);
    if (image && !images.some((candidate) => candidate.id === image.id)) images.push(image);
  }
  const matchLevels = [];
  for (const level of Array.isArray(raw.match_levels) ? raw.match_levels.slice(0, 12) : []) {
    const text = safeText(level, "", 40);
    if (text) matchLevels.push(text);
  }
  return Object.freeze({
    id,
    ordinal: boundedCount(raw.ordinal, 100_000) || groupIndex + 1,
    kind,
    decided: Boolean(raw.decided),
    matchLevels,
    imageCount: images.length,
    selectedImageCount: images.filter((image) => image.selected).length,
    images,
  });
}

export function sanitizeReviewSummary(value, batchId = value?.batch_id || value?.batchId) {
  if (!isRecord(value)) throw new TypeError("审核摘要格式无效");
  const safeBatchId = safeId(batchId);
  if (!safeBatchId) throw new TypeError("审核批次 ID 无效");
  const status = safeStatus(value.status);
  const projected = Object.prototype.hasOwnProperty.call(value, "totalImageCount");
  const count = (legacyName, projectedName) => boundedCount(
    projected ? value[projectedName] : value[legacyName],
  );
  return Object.freeze({
    batchId: safeBatchId,
    status,
    statusLabel: STATUS_LABELS[status] || status,
    statusKind: statusKind(status),
    totalImageCount: count("total_image_count", "totalImageCount"),
    totalGroupCount: count("total_group_count", "totalGroupCount"),
    duplicateGroupCount: count("duplicate_group_count", "duplicateGroupCount"),
    unreadableImageCount: count("unreadable_image_count", "unreadableImageCount"),
    automaticGroupCount: count("automatic_group_count", "automaticGroupCount"),
    automaticRejectedImageCount: count("automatic_rejected_image_count", "automaticRejectedImageCount"),
    selectedImageCount: count("selected_image_count", "selectedImageCount"),
    decidedGroupCount: count("decided_group_count", "decidedGroupCount"),
    keptImageCount: count("kept_image_count", "keptImageCount"),
    rejectedImageCount: count("rejected_image_count", "rejectedImageCount"),
    failedImageCount: count("failed_image_count", "failedImageCount"),
    hasError: projected ? Boolean(value.hasError) : Boolean(safeText(value.error, "", 8)),
  });
}

export function sanitizeReviewPage(value, { batchId, filter = "", requestedOffset = 0 } = {}) {
  if (!isRecord(value) || !isRecord(value.groups) || !Array.isArray(value.groups.items)) {
    throw new TypeError("审核分页格式无效");
  }
  const safeBatchId = safeId(batchId || value.batch_id);
  if (!safeBatchId || !FILTERS.has(filter)) throw new TypeError("审核分页参数无效");
  const summary = sanitizeReviewSummary(value, safeBatchId);
  const groups = [];
  for (const raw of value.groups.items.slice(0, REVIEW_PAGE_LIMIT)) {
    const group = sanitizeGroup(raw, groups.length);
    if (group && !groups.some((candidate) => candidate.id === group.id)) groups.push(group);
  }
  const offset = boundedCount(value.groups.offset, 1_000_000);
  if (Math.abs(offset - boundedCount(requestedOffset, 1_000_000)) > REVIEW_PAGE_LIMIT) {
    throw new TypeError("审核分页位置与请求不一致");
  }
  return Object.freeze({
    batchId: safeBatchId,
    summary,
    groups,
    filter,
    offset,
    limit: REVIEW_PAGE_LIMIT,
    total: boundedCount(value.groups.total, 1_000_000),
    dirty: false,
  });
}

export function validateReviewState(value) {
  if (!isRecord(value) || !safeId(value.batchId) || !isRecord(value.summary) ||
      !Array.isArray(value.groups) || !FILTERS.has(value.filter) || typeof value.dirty !== "boolean") {
    throw new TypeError("审核状态数据无效");
  }
  for (const group of value.groups) {
    if (!safeId(group.id) || !Array.isArray(group.images)) throw new TypeError("审核分组数据无效");
    for (const image of group.images) {
      if (!safeId(image.id) || Object.prototype.hasOwnProperty.call(image, "relative_path") ||
          Object.prototype.hasOwnProperty.call(image, "url")) {
        throw new TypeError("审核图片数据包含不允许的字段");
      }
    }
  }
  return value;
}

export function buildReviewDecisionPayload(reviewState) {
  validateReviewState(reviewState);
  if (reviewState.summary.status !== "ready" || !reviewState.groups.length) {
    throw new TypeError("当前审核页不能保存决策");
  }
  return {
    groups: reviewState.groups.map((group) => ({
      group_id: group.id,
      selected_image_ids: group.images.filter((image) => image.selected).map((image) => image.id),
    })),
  };
}

export function updateReviewImageSelection(reviewState, groupId, imageId, selected) {
  validateReviewState(reviewState);
  const safeGroupId = safeId(groupId);
  const safeImageId = safeId(imageId);
  let changed = false;
  const groups = reviewState.groups.map((group) => {
    if (group.id !== safeGroupId) return group;
    const images = group.images.map((image) => {
      if (image.id !== safeImageId || image.selected === Boolean(selected)) return image;
      changed = true;
      return { ...image, selected: Boolean(selected) };
    });
    if (!changed) return group;
    return {
      ...group,
      decided: false,
      selectedImageCount: images.filter((image) => image.selected).length,
      images,
    };
  });
  return changed ? { ...reviewState, groups, dirty: true } : reviewState;
}

export function setReviewGroupMode(reviewState, groupId, mode) {
  validateReviewState(reviewState);
  if (!["all", "none", "recommended"].includes(mode)) throw new TypeError("审核选择模式无效");
  const safeGroupId = safeId(groupId);
  let found = false;
  const groups = reviewState.groups.map((group) => {
    if (group.id !== safeGroupId) return group;
    found = true;
    const images = group.images.map((image) => ({
      ...image,
      selected: mode === "all" || (mode === "recommended" && image.recommended),
    }));
    return {
      ...group,
      decided: false,
      selectedImageCount: images.filter((image) => image.selected).length,
      images,
    };
  });
  return found ? { ...reviewState, groups, dirty: true } : reviewState;
}

export function setReviewPageMode(reviewState, mode) {
  validateReviewState(reviewState);
  if (!["all", "none", "recommended"].includes(mode)) throw new TypeError("审核选择模式无效");
  const groups = reviewState.groups.map((group) => {
    const images = group.images.map((image) => ({
      ...image,
      selected: mode === "all" || (mode === "recommended" && image.recommended),
    }));
    return {
      ...group,
      decided: false,
      selectedImageCount: images.filter((image) => image.selected).length,
      images,
    };
  });
  return { ...reviewState, groups, dirty: Boolean(groups.length) };
}

export function markReviewPageSaved(reviewState, summary) {
  validateReviewState(reviewState);
  const safeSummary = sanitizeReviewSummary(summary, reviewState.batchId);
  return {
    ...reviewState,
    summary: safeSummary,
    groups: reviewState.groups.map((group) => ({ ...group, decided: true })),
    dirty: false,
  };
}

export function shouldPollReview(summary) {
  return Boolean(summary && ACTIVE_STATUSES.has(summary.status));
}

export function reviewIsStable(summary) {
  return Boolean(summary && STABLE_STATUSES.has(summary.status));
}

export function reviewCanList(summary) {
  return Boolean(summary && LISTABLE_STATUSES.has(summary.status));
}

export function reviewApplyCounts(summary) {
  const total = summary?.totalImageCount || 0;
  const selected = summary?.selectedImageCount || 0;
  return Object.freeze({
    automatic: summary?.automaticRejectedImageCount || 0,
    selected,
    rejected: Math.max(0, total - selected),
  });
}

export function formatReviewBytes(value) {
  const bytes = boundedCount(value, Number.MAX_SAFE_INTEGER);
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(2)} MB`;
}

export function reviewImageUrl(batchId, imageId) {
  const batch = safeId(batchId);
  const image = safeId(imageId);
  if (!batch || !image) throw new TypeError("审核图片引用无效");
  return `/api/v1/crawls/${encodeURIComponent(batch)}/review/images/${encodeURIComponent(image)}`;
}

export function reviewErrorGuidance(error) {
  const code = safeText(error?.code, "request_failed", 128).replace(/[^A-Za-z0-9._:-]/g, "") || "request_failed";
  const status = Number.isInteger(error?.status) ? error.status : 0;
  const requestId = safeId(error?.requestId);
  const conflict = status === 409 || code === "review_state_conflict" || code === "crawl_not_finished";
  const missing = status === 404;
  return Object.freeze({
    code,
    requestId,
    conflict,
    missing,
    title: missing ? "审核内容不存在" : conflict ? "审核状态已变化" : "审核请求失败",
    message: status === 0 ? "无法连接到 ImageWeave 服务。" : "服务未接受本次审核操作。",
    nextStep: missing
      ? "返回已结束批次列表并选择仍存在的批次。"
      : conflict
        ? "页面将重新读取最新状态，不会覆盖其他页面已保存的结果。"
        : "保留本页更改并重试；若持续失败，请打开系统诊断。",
  });
}

export function createReviewRequestGate() {
  let lifecycle = 0;
  let write = 0;
  let sequence = 0;
  let applied = 0;
  return Object.freeze({
    beginRead(batchId, filter, offset) {
      const ticket = Object.freeze({
        lifecycle,
        write,
        sequence: ++sequence,
        batchId: safeId(batchId),
        filter: FILTERS.has(filter) ? filter : "",
        offset: boundedCount(offset, 1_000_000),
      });
      if (!ticket.batchId) throw new TypeError("审核读取 ID 无效");
      return ticket;
    },
    isReadCurrent(ticket, { batchId, filter, offset }) {
      const current = ticket?.lifecycle === lifecycle && ticket?.write === write &&
        ticket?.sequence >= applied && ticket?.batchId === safeId(batchId) &&
        ticket?.filter === filter && ticket?.offset === boundedCount(offset, 1_000_000);
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
