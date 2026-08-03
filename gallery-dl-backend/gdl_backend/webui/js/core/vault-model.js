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
    method: "anonymous",
    authorizeAction: "",
  }),
  twitter: Object.freeze({
    id: "twitter",
    label: "X / Twitter",
    mark: "X",
    method: "managed_browser",
    authorizeAction: "managed_browser_login",
  }),
  pixiv: Object.freeze({
    id: "pixiv",
    label: "Pixiv",
    mark: "P",
    method: "oauth",
    authorizeAction: "oauth",
  }),
  exhentai: Object.freeze({
    id: "exhentai",
    label: "EH",
    mark: "EH",
    method: "managed_browser",
    authorizeAction: "managed_browser_login",
  }),
  pawchive: Object.freeze({
    id: "pawchive",
    label: "Pawchive",
    mark: "PA",
    method: "anonymous",
    authorizeAction: "",
  }),
});

const SITE_STATES = new Set(["ready", "authorized", "authorizing", "required"]);
const SESSION_STATES = new Set([
  "starting",
  "starting_browser",
  "awaiting_login",
  "awaiting_code",
  "exchanging",
  "authorized",
  "cancelled",
  "timed_out",
  "failed",
  "token_ready",
]);
const MANAGED_ACTIVE_STATES = new Set(["starting", "awaiting_login"]);
const PIXIV_ACTIVE_STATES = new Set([
  "starting",
  "starting_browser",
  "awaiting_login",
  "awaiting_code",
  "exchanging",
]);
const PROXY_SOURCES = new Set(["runtime", "config", "none"]);
const PROXY_SCHEMES = new Set(["http", "https", "socks4", "socks5", "socks5h"]);
const VAULT_REQUEST_LANES = new Set(["status", "session"]);
const SESSION_ID_PATTERN = /^[0-9a-f]{32}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const SAFE_HOST_PATTERN = /^(?:\[[0-9a-f:.]+\]|[A-Za-z0-9.-]+)$/i;
const SAFE_PROXY_DISPLAY_PATTERN = /^(?:HTTP|HTTPS|SOCKS4|SOCKS5|SOCKS5H) · (?:\[[0-9a-f:.]+\]|[A-Za-z0-9.-]+):[0-9]{1,5}$/;
const MAX_AUTH_PROXY_LENGTH = 300;
const MAX_COOKIE_COUNT = 100_000;
const MAX_TIMESTAMP = 4_102_444_800;

export const VAULT_SITE_IDS = SITE_ORDER;
export const VAULT_AUTH_PROXY_MAX_LENGTH = MAX_AUTH_PROXY_LENGTH;

export function createVaultRequestGate() {
  let lifecycleVersion = 0;
  let writeVersion = 0;
  const laneVersions = new Map([...VAULT_REQUEST_LANES].map((lane) => [lane, 0]));

  const advanceLifecycle = () => {
    lifecycleVersion += 1;
    return lifecycleVersion;
  };

  const beginWrite = () => {
    writeVersion += 1;
    return Object.freeze({ lifecycleVersion, writeVersion });
  };

  const beginRead = (lane) => {
    if (!VAULT_REQUEST_LANES.has(lane)) throw new TypeError("未知 VAULT 请求通道");
    const laneVersion = laneVersions.get(lane) + 1;
    laneVersions.set(lane, laneVersion);
    return Object.freeze({ lane, laneVersion, lifecycleVersion, writeVersion });
  };

  const isReadCurrent = (ticket) => Boolean(
    ticket
    && VAULT_REQUEST_LANES.has(ticket.lane)
    && ticket.lifecycleVersion === lifecycleVersion
    && ticket.writeVersion === writeVersion
    && ticket.laneVersion === laneVersions.get(ticket.lane)
  );

  return Object.freeze({ advanceLifecycle, beginWrite, beginRead, isReadCurrent });
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new TypeError(`${label}必须是对象`);
  return value;
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every((key) => allowed.has(key));
}

function safeBoolean(value) {
  return value === true;
}

function safeInteger(value, maximum = MAX_COOKIE_COUNT) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? Math.min(value, maximum)
    : 0;
}

function safeTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_TIMESTAMP
    ? value
    : null;
}

function safeSessionState(value) {
  return typeof value === "string" && SESSION_STATES.has(value) ? value : "none";
}

function safeSiteState(value) {
  return typeof value === "string" && SITE_STATES.has(value) ? value : "required";
}

function safeActions(value) {
  if (!Array.isArray(value)) return new Set();
  return new Set(value.filter((item) =>
    item === "managed_browser_login" || item === "oauth" || item === "clear"));
}

function safeHost(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 255) return "";
  const host = value.trim();
  if (!SAFE_HOST_PATTERN.test(host) || CONTROL_CHARACTERS.test(host)) return "";
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!bare || (!bare.includes(":") && bare.split(".").some((label) => !label || label.length > 63))) {
    return "";
  }
  return host;
}

function explicitPortFromUrl(text) {
  const schemeEnd = text.indexOf("://");
  if (schemeEnd < 0) return 0;
  let authority = text.slice(schemeEnd + 3);
  const slash = authority.indexOf("/");
  if (slash >= 0) authority = authority.slice(0, slash);
  const at = authority.lastIndexOf("@");
  const hostPort = at >= 0 ? authority.slice(at + 1) : authority;
  let rawPort = "";
  if (hostPort.startsWith("[")) {
    const match = hostPort.match(/^\[[^\]]+\]:([0-9]{1,5})$/);
    rawPort = match?.[1] || "";
  } else {
    const separator = hostPort.lastIndexOf(":");
    if (separator < 1 || hostPort.slice(0, separator).includes(":")) return 0;
    rawPort = hostPort.slice(separator + 1);
  }
  const port = Number(rawPort);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : 0;
}

function parseProxyUrl(value, { allowSecrets }) {
  if (typeof value !== "string") throw new TypeError("授权代理地址必须是文本");
  const text = value.trim();
  if (!text) return Object.freeze({ mode: "direct", value: "" });
  if (text.length > MAX_AUTH_PROXY_LENGTH) throw new TypeError("授权代理地址不能超过 300 个字符");
  if (CONTROL_CHARACTERS.test(text) || /\s/.test(text)) {
    throw new TypeError("授权代理地址不能包含空白或控制字符");
  }

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new TypeError("请输入完整的 scheme://host:port 授权代理地址");
  }
  const scheme = parsed.protocol.slice(0, -1).toLowerCase();
  if (!PROXY_SCHEMES.has(scheme)) {
    throw new TypeError("只支持 http、https、socks4、socks5 或 socks5h 代理");
  }
  if (parsed.search || parsed.hash || (parsed.pathname && parsed.pathname !== "/")) {
    throw new TypeError("授权代理地址不能包含路径、查询参数或 fragment");
  }
  const host = safeHost(parsed.hostname);
  const port = explicitPortFromUrl(text);
  if (!host || !port) throw new TypeError("授权代理地址必须包含有效主机和显式端口");
  const hasCredentials = Boolean(parsed.username || parsed.password || text.slice(text.indexOf("://") + 3).includes("@"));
  if (scheme.startsWith("socks") && hasCredentials) {
    throw new TypeError("SOCKS 授权代理不能携带用户名或密码");
  }
  if (!allowSecrets && hasCredentials && !text.includes("***@")) {
    throw new TypeError("代理状态包含未脱敏凭据");
  }
  return Object.freeze({
    mode: "proxy",
    value: text,
    scheme,
    host,
    port,
    hasCredentials,
    display: `${scheme.toUpperCase()} · ${host}:${port}`,
  });
}

function sanitizeProxyStatus(value) {
  const proxy = requireRecord(value, "授权代理状态");
  const source = PROXY_SOURCES.has(proxy.source) ? proxy.source : "none";
  let parsed = null;
  let valid = proxy.proxy_url === null;
  if (typeof proxy.proxy_url === "string") {
    try {
      parsed = parseProxyUrl(proxy.proxy_url, { allowSecrets: false });
      valid = parsed.mode === "proxy";
    } catch {
      parsed = null;
      valid = false;
    }
  }
  return {
    source,
    configured: Boolean(parsed),
    direct: proxy.proxy_url === null,
    scheme: parsed?.scheme || "",
    displayEndpoint: parsed?.display || "",
    credentialsRedacted: safeBoolean(proxy.credentials_redacted),
    browserRunning: safeBoolean(proxy.browser_running),
    restartPending: safeBoolean(proxy.restart_pending),
    updatedAt: safeTimestamp(proxy.updated_at),
    valid,
  };
}

function sanitizeBrowserProfile(value) {
  const profile = requireRecord(value, "共享浏览器状态");
  return {
    shared: safeBoolean(profile.shared),
    present: safeBoolean(profile.present),
    running: safeBoolean(profile.running),
    resetting: safeBoolean(profile.resetting),
  };
}

function rawSessionForSite(status, definition) {
  return definition.method === "oauth" ? status.oauth : status.login;
}

function sanitizeSession(status, definition) {
  const raw = isRecord(rawSessionForSite(status, definition))
    ? rawSessionForSite(status, definition)
    : null;
  const state = safeSessionState(raw?.state);
  const activeStates = definition.method === "oauth" ? PIXIV_ACTIVE_STATES : MANAGED_ACTIVE_STATES;
  const hasSafeId = typeof raw?.session_id === "string" && SESSION_ID_PATTERN.test(raw.session_id);
  return {
    present: Boolean(raw),
    active: Boolean(raw && hasSafeId && activeStates.has(state)),
    state,
    createdAt: safeTimestamp(raw?.created_at),
    expiresAt: safeTimestamp(raw?.expires_at),
  };
}

export function sanitizeVaultSiteStatus(value) {
  const status = requireRecord(value, "站点授权状态");
  const definition = SITE_DEFINITIONS[status.site];
  if (!definition || status.method !== definition.method) {
    throw new TypeError("站点授权状态包含不支持的目标或方法");
  }
  const actions = safeActions(status.actions);
  const session = sanitizeSession(status, definition);
  const cookie = isRecord(status.cookies) ? status.cookies : {};
  const invalidatedAt = safeTimestamp(status.invalidated_at);
  const authorized = safeBoolean(status.authorized);
  const configured = definition.method === "managed_browser"
    ? safeBoolean(cookie.present)
    : definition.method === "oauth"
      ? authorized
      : false;
  const materialValid = definition.method === "managed_browser"
    ? Boolean(safeBoolean(cookie.valid) && authorized)
    : definition.method === "oauth"
      ? authorized
      : true;

  return {
    site: definition.id,
    label: definition.label,
    method: definition.method,
    state: safeSiteState(status.state),
    authorized,
    configured,
    materialValid,
    invalidated: invalidatedAt !== null,
    updatedAt: safeTimestamp(status.updated_at) ?? safeTimestamp(cookie.updated_at),
    cookieCount: definition.method === "managed_browser"
      ? safeInteger(cookie.cookie_count)
      : 0,
    session,
    capabilities: {
      authorize: Boolean(definition.authorizeAction && actions.has(definition.authorizeAction)),
      clear: actions.has("clear"),
    },
  };
}

export function sanitizeVaultStatus(value) {
  const snapshot = requireRecord(value, "授权状态快照");
  if (snapshot.secrets_exposed !== false) {
    throw new TypeError("后端未声明授权状态已经脱敏");
  }
  if (!Array.isArray(snapshot.items)) throw new TypeError("授权目标列表无效");
  const bySite = new Map();
  for (const item of snapshot.items.slice(0, SITE_ORDER.length * 2)) {
    try {
      const sanitized = sanitizeVaultSiteStatus(item);
      if (!bySite.has(sanitized.site)) bySite.set(sanitized.site, sanitized);
    } catch {
      // 单个异常目标不得污染其余安全状态。
    }
  }
  return {
    bySite,
    browserProfile: sanitizeBrowserProfile(snapshot.browser_profile),
    authorizationProxy: sanitizeProxyStatus(snapshot.authorization_proxy),
  };
}

function requireExactBoolean(value, label) {
  if (typeof value !== "boolean") throw new TypeError(`${label}必须是布尔值`);
  return value;
}

function requireNullableTimestamp(value, label) {
  if (value === null) return null;
  if (safeTimestamp(value) === null) throw new TypeError(`${label}无效`);
  return value;
}

const SITE_VIEW_KEYS = new Set([
  "site", "label", "method", "state", "authorized", "configured", "materialValid",
  "invalidated", "updatedAt", "cookieCount", "session", "capabilities",
]);
const SESSION_VIEW_KEYS = new Set(["present", "active", "state", "createdAt", "expiresAt"]);
const CAPABILITY_KEYS = new Set(["authorize", "clear"]);

export function validateVaultSiteViewModel(value) {
  const site = requireRecord(value, "授权站点 view model");
  if (!hasOnlyKeys(site, SITE_VIEW_KEYS)) throw new TypeError("授权站点包含未知字段");
  const definition = SITE_DEFINITIONS[site.site];
  if (!definition || site.label !== definition.label || site.method !== definition.method) {
    throw new TypeError("授权站点标识无效");
  }
  if (!SITE_STATES.has(site.state)) throw new TypeError("授权站点状态无效");
  const session = requireRecord(site.session, "授权会话摘要");
  if (!hasOnlyKeys(session, SESSION_VIEW_KEYS) || !SESSION_STATES.has(session.state) && session.state !== "none") {
    throw new TypeError("授权会话摘要无效");
  }
  const capabilities = requireRecord(site.capabilities, "授权能力摘要");
  if (!hasOnlyKeys(capabilities, CAPABILITY_KEYS)) throw new TypeError("授权能力摘要包含未知字段");
  if (!Number.isInteger(site.cookieCount) || site.cookieCount < 0 || site.cookieCount > MAX_COOKIE_COUNT) {
    throw new TypeError("Cookie 数量无效");
  }
  return {
    site: definition.id,
    label: definition.label,
    method: definition.method,
    state: site.state,
    authorized: requireExactBoolean(site.authorized, "授权状态"),
    configured: requireExactBoolean(site.configured, "配置状态"),
    materialValid: requireExactBoolean(site.materialValid, "材料状态"),
    invalidated: requireExactBoolean(site.invalidated, "失效状态"),
    updatedAt: requireNullableTimestamp(site.updatedAt, "更新时间"),
    cookieCount: site.cookieCount,
    session: {
      present: requireExactBoolean(session.present, "会话存在状态"),
      active: requireExactBoolean(session.active, "会话活动状态"),
      state: session.state,
      createdAt: requireNullableTimestamp(session.createdAt, "会话创建时间"),
      expiresAt: requireNullableTimestamp(session.expiresAt, "会话过期时间"),
    },
    capabilities: {
      authorize: requireExactBoolean(capabilities.authorize, "授权能力"),
      clear: requireExactBoolean(capabilities.clear, "清除能力"),
    },
  };
}

const PROFILE_VIEW_KEYS = new Set(["shared", "present", "running", "resetting"]);
const PROXY_VIEW_KEYS = new Set([
  "source", "configured", "direct", "scheme", "displayEndpoint", "credentialsRedacted",
  "browserRunning", "restartPending", "updatedAt", "valid",
]);
const SNAPSHOT_VIEW_KEYS = new Set(["bySite", "browserProfile", "authorizationProxy"]);

function validateBrowserProfileView(value) {
  const profile = requireRecord(value, "共享浏览器 view model");
  if (!hasOnlyKeys(profile, PROFILE_VIEW_KEYS)) throw new TypeError("共享浏览器状态包含未知字段");
  return {
    shared: requireExactBoolean(profile.shared, "共享状态"),
    present: requireExactBoolean(profile.present, "Profile 存在状态"),
    running: requireExactBoolean(profile.running, "浏览器运行状态"),
    resetting: requireExactBoolean(profile.resetting, "Profile 清理状态"),
  };
}

function validateAuthorizationProxyView(value) {
  const proxy = requireRecord(value, "授权代理 view model");
  if (!hasOnlyKeys(proxy, PROXY_VIEW_KEYS) || !PROXY_SOURCES.has(proxy.source)) {
    throw new TypeError("授权代理状态无效");
  }
  if (typeof proxy.scheme !== "string" || (proxy.scheme && !PROXY_SCHEMES.has(proxy.scheme))) {
    throw new TypeError("授权代理 scheme 无效");
  }
  if (typeof proxy.displayEndpoint !== "string" || (
    proxy.displayEndpoint && !SAFE_PROXY_DISPLAY_PATTERN.test(proxy.displayEndpoint)
  )) {
    throw new TypeError("授权代理展示值无效");
  }
  return {
    source: proxy.source,
    configured: requireExactBoolean(proxy.configured, "代理配置状态"),
    direct: requireExactBoolean(proxy.direct, "直连状态"),
    scheme: proxy.scheme,
    displayEndpoint: proxy.displayEndpoint,
    credentialsRedacted: requireExactBoolean(proxy.credentialsRedacted, "代理脱敏状态"),
    browserRunning: requireExactBoolean(proxy.browserRunning, "浏览器代理状态"),
    restartPending: requireExactBoolean(proxy.restartPending, "代理重启状态"),
    updatedAt: requireNullableTimestamp(proxy.updatedAt, "代理更新时间"),
    valid: requireExactBoolean(proxy.valid, "代理响应状态"),
  };
}

export function validateVaultSnapshot(value) {
  const snapshot = requireRecord(value, "授权 Store payload");
  if (!hasOnlyKeys(snapshot, SNAPSHOT_VIEW_KEYS) || !(snapshot.bySite instanceof Map)) {
    throw new TypeError("授权 Store payload 无效");
  }
  const bySite = new Map();
  for (const [siteId, site] of snapshot.bySite) {
    if (siteId !== site?.site || !SITE_DEFINITIONS[siteId] || bySite.has(siteId)) {
      throw new TypeError("授权 Store 目标无效");
    }
    bySite.set(siteId, validateVaultSiteViewModel(site));
  }
  return {
    bySite,
    browserProfile: validateBrowserProfileView(snapshot.browserProfile),
    authorizationProxy: validateAuthorizationProxyView(snapshot.authorizationProxy),
  };
}

export function getVaultSiteDefinition(siteId) {
  return SITE_DEFINITIONS[siteId] || null;
}

export function extractVaultSessionReference(value) {
  const status = isRecord(value?.status) ? value.status : value;
  if (!isRecord(status)) return null;
  const definition = SITE_DEFINITIONS[status.site];
  if (!definition) return null;
  const directSession = isRecord(value?.session)
    ? value.session
    : typeof value?.session_id === "string"
      ? value
      : null;
  const session = directSession || (isRecord(rawSessionForSite(status, definition))
    ? rawSessionForSite(status, definition)
    : null);
  if (!session || typeof session.session_id !== "string" || !SESSION_ID_PATTERN.test(session.session_id)) {
    return null;
  }
  const state = safeSessionState(session.state);
  const activeStates = definition.method === "oauth" ? PIXIV_ACTIVE_STATES : MANAGED_ACTIVE_STATES;
  if (!activeStates.has(state)) return null;
  return Object.freeze({
    site: definition.id,
    kind: definition.method === "oauth" ? "oauth" : "managed_browser",
    sessionId: session.session_id,
  });
}

export function extractVaultSessionFromSnapshot(value) {
  if (!isRecord(value) || !Array.isArray(value.items)) return null;
  for (const item of value.items.slice(0, SITE_ORDER.length * 2)) {
    const reference = extractVaultSessionReference(item);
    if (reference) return reference;
  }
  return null;
}

export function validateAuthorizationProxyInput(value) {
  try {
    const parsed = parseProxyUrl(value, { allowSecrets: true });
    return Object.freeze({ valid: true, mode: parsed.mode, error: "" });
  } catch (error) {
    return Object.freeze({
      valid: false,
      mode: "invalid",
      error: error instanceof TypeError ? error.message : "授权代理地址格式无效",
    });
  }
}

export function buildAuthorizationProxyPayload(value) {
  const parsed = parseProxyUrl(value, { allowSecrets: true });
  return { proxy_url: parsed.value };
}

export function formatVaultTime(value) {
  const timestamp = safeTimestamp(value);
  if (timestamp === null) return "尚无记录";
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

export function formatVaultSite(status, siteId = status?.site) {
  const definition = SITE_DEFINITIONS[siteId];
  if (!definition || !status) {
    return Object.freeze({
      label: definition?.label || "未知目标",
      mark: definition?.mark || "?",
      badge: Object.freeze({ status: "error", label: "状态不可用" }),
      headline: "尚未收到此目标的安全状态。",
      proof: "可刷新重试；其他目标的最后安全状态不会被清空。",
      material: "未知",
      session: "无活动会话",
      updatedAt: "尚无记录",
      source: "后端状态未加载",
    });
  }

  let badge;
  let headline;
  let proof;
  if (definition.method === "anonymous") {
    badge = { status: "ready", label: "公开访问就绪" };
    headline = "此目标按后端契约无需登录。";
    proof = "这里只证明公开访问模式已启用，不代表外部站点始终在线。";
  } else if (status.session.active) {
    badge = { status: "running", label: "授权进行中" };
    headline = "共享授权浏览器标签页正在等待操作。";
    proof = "完成、失败或取消后，页面会刷新后端托管材料状态。";
  } else if (status.invalidated) {
    badge = { status: "error", label: "实际访问判定失效" };
    headline = "后端在真实访问中判定现有材料不可用。";
    proof = "请重新授权；页面不会显示原始失败文本或凭证片段。";
  } else if (status.authorized && status.materialValid) {
    badge = { status: "warning", label: "已配置，未远端验证" };
    headline = "后端检测到可供任务使用的托管授权材料。";
    proof = "该状态只证明本地 Cookie 结构或缓存 Token 存在，不等于远端登录验证成功。";
  } else if (status.configured) {
    badge = { status: "error", label: "材料不完整" };
    headline = "后端发现授权材料，但当前不满足使用条件。";
    proof = "请重新授权；旧秘密不会回填到页面。";
  } else if (["failed", "timed_out"].includes(status.session.state)) {
    badge = { status: "error", label: status.session.state === "timed_out" ? "授权已超时" : "授权失败" };
    headline = "最近一次共享浏览器授权未完成。";
    proof = "可重新开始；错误区只显示受控指引与安全 request id。";
  } else {
    badge = { status: "disabled", label: "未配置" };
    headline = "尚无可供任务使用的托管授权材料。";
    proof = "使用共享授权浏览器完成一次授权后，后端会保存导出材料。";
  }

  return Object.freeze({
    label: definition.label,
    mark: definition.mark,
    badge: Object.freeze(badge),
    headline,
    proof,
    material: definition.method === "anonymous"
      ? "无需凭证"
      : status.configured
        ? status.materialValid ? "后端托管材料存在" : "材料存在但不可用"
        : "未保存",
    session: status.session.active
      ? `活动会话 · ${status.session.state}`
      : status.session.present
        ? `最近会话 · ${status.session.state}`
        : "无活动会话",
    updatedAt: formatVaultTime(status.updatedAt),
    source: definition.method === "anonymous"
      ? "后端公开访问契约"
      : definition.method === "oauth"
        ? "后端 gallery-dl 授权缓存"
        : `后端导出 Cookie${status.cookieCount ? ` · ${status.cookieCount} 条` : ""}`,
  });
}

export function formatBrowserProfile(profile) {
  if (!profile) return Object.freeze({
    badge: Object.freeze({ status: "error", label: "Profile 状态不可用" }),
    presence: "未知",
    runtime: "未知",
  });
  const badge = profile.resetting
    ? { status: "running", label: "正在清空" }
    : profile.running
      ? { status: "running", label: "共享浏览器运行中" }
      : profile.present
        ? { status: "warning", label: "Profile 已保存" }
        : { status: "disabled", label: "Profile 尚未建立" };
  return Object.freeze({
    badge: Object.freeze(badge),
    presence: profile.present ? "后端私有目录中存在" : "尚不存在",
    runtime: profile.running ? "当前有共享 Chrome 进程" : "当前无共享 Chrome 进程",
  });
}

export function formatAuthorizationProxy(proxy) {
  if (!proxy || !proxy.valid) return Object.freeze({
    badge: Object.freeze({ status: "error", label: "代理状态不可用" }),
    endpoint: "未采用后端展示值",
    source: "未知",
    runtime: "请刷新后重试",
    updatedAt: "尚无记录",
  });
  const sourceNames = { runtime: "界面运行时覆盖", config: "config 基线", none: "未设置" };
  const configured = proxy.configured;
  const badge = proxy.restartPending
    ? { status: "warning", label: "等待下次授权重启" }
    : configured
      ? { status: "ready", label: "授权代理已配置" }
      : { status: "disabled", label: "授权流量直连" };
  return Object.freeze({
    badge: Object.freeze(badge),
    endpoint: configured ? proxy.displayEndpoint : "直连（无授权代理）",
    source: sourceNames[proxy.source] || "未知",
    runtime: proxy.restartPending
      ? "已运行浏览器仍使用旧线路；下次授权会按新设置重启"
      : proxy.browserRunning
        ? "共享浏览器当前正在运行"
        : "新设置将在下一次授权启动时使用",
    updatedAt: formatVaultTime(proxy.updatedAt),
  });
}

function control(disabled, reason, label) {
  return Object.freeze({ disabled, reason: disabled ? reason : "", label });
}

export function deriveVaultControls(snapshot, {
  busy = "",
  proxyInputValid = true,
} = {}) {
  const bySite = snapshot?.bySite instanceof Map ? snapshot.bySite : new Map();
  const profile = snapshot?.browserProfile || null;
  const proxy = snapshot?.authorizationProxy || null;
  const isBusy = Boolean(busy);
  const activeSite = SITE_ORDER.find((siteId) => bySite.get(siteId)?.session.active) || "";
  const busyReason = "正在执行其他凭证操作";
  const sites = {};

  for (const siteId of SITE_ORDER) {
    const definition = SITE_DEFINITIONS[siteId];
    const status = bySite.get(siteId) || null;
    const authorizeKind = `authorize:${siteId}`;
    const cancelKind = `cancel:${siteId}`;
    const clearKind = `clear:${siteId}`;
    const authorizeReason = isBusy
      ? busyReason
      : !status
        ? "请先刷新此目标状态"
        : !status.capabilities.authorize
          ? "后端未声明此目标支持浏览器授权"
          : profile?.resetting
            ? "共享浏览器 Profile 正在清空"
            : activeSite && activeSite !== siteId
              ? `共享浏览器正用于 ${SITE_DEFINITIONS[activeSite].label}`
              : status.session.active
                ? "此目标已有活动授权会话"
                : "";
    const cancelReason = isBusy
      ? busyReason
      : !status?.session.active
        ? "当前没有可取消的授权会话"
        : "";
    const clearReason = isBusy
      ? busyReason
      : !status?.capabilities.clear
        ? "后端未声明此目标支持清除"
        : !status.configured
          ? "当前没有可删除的后端导出材料"
          : status.session.active
            ? "请先取消当前授权会话"
            : "";
    sites[siteId] = Object.freeze({
      authorize: control(
        Boolean(authorizeReason),
        authorizeReason,
        busy === authorizeKind
          ? "正在打开…"
          : status?.authorized ? "重新授权" : "在共享浏览器中授权",
      ),
      cancel: control(
        Boolean(cancelReason),
        cancelReason,
        busy === cancelKind ? "正在关闭…" : "关闭授权标签页",
      ),
      clear: control(
        Boolean(clearReason),
        clearReason,
        busy === clearKind ? "正在删除…" : "删除导出凭证",
      ),
      showAuthorize: Boolean(definition.authorizeAction),
      showCancel: Boolean(status?.session.active),
      showClear: Boolean(status?.capabilities.clear && status.configured),
    });
  }

  const profileReason = isBusy
    ? busyReason
    : !profile
      ? "请先刷新共享浏览器状态"
      : profile.resetting
        ? "共享浏览器 Profile 已在清空"
        : activeSite
          ? `请先关闭 ${SITE_DEFINITIONS[activeSite].label} 授权标签页`
          : !profile.present
            ? "当前没有可清空的共享 Profile"
            : "";
  const saveReason = isBusy
    ? busyReason
    : !proxy
      ? "请先刷新授权代理状态"
      : !proxyInputValid
        ? "请修正授权代理地址格式"
        : "";
  const resetReason = isBusy
    ? busyReason
    : !proxy
      ? "请先刷新授权代理状态"
      : proxy.source !== "runtime"
        ? "当前没有界面运行时覆盖"
        : "";

  return Object.freeze({
    sites: Object.freeze(sites),
    refresh: control(isBusy, busyReason, busy === "refresh" ? "正在刷新…" : "刷新安全状态"),
    profileClear: control(
      Boolean(profileReason),
      profileReason,
      busy === "profile-clear" ? "正在清空…" : "清空共享 Profile",
    ),
    proxySave: control(
      Boolean(saveReason),
      saveReason,
      busy === "proxy-save" ? "正在保存…" : "保存新代理 / 设置直连",
    ),
    proxyReset: control(
      Boolean(resetReason),
      resetReason,
      busy === "proxy-reset" ? "正在恢复…" : "恢复 config 默认",
    ),
    reveal: control(isBusy, busyReason, "显示或隐藏代理输入"),
    activeSite,
  });
}

const ERROR_GUIDANCE = Object.freeze({
  invalid_authorization_proxy: Object.freeze({
    title: "授权代理格式无效",
    message: "后端拒绝了授权代理地址；刚提交的值不会在错误区回显。",
    nextStep: "请使用 scheme://host:port；不要添加路径、查询参数或 fragment。",
  }),
  auth_request_too_large: Object.freeze({
    title: "授权代理请求过大",
    message: "请求超过授权代理接口的大小上限。",
    nextStep: "请缩短代理地址并确认没有粘贴 Cookie、Header 或配置文件内容。",
  }),
  invalid_content_length: Object.freeze({
    title: "请求大小信息无效",
    message: "后端拒绝了异常的 Content-Length。",
    nextStep: "请刷新页面后重新输入完整代理地址。",
  }),
  unsupported_auth_site: Object.freeze({
    title: "授权目标不支持",
    message: "当前后端版本不支持该授权目标。",
    nextStep: "请刷新状态；不要改写地址栏尝试未声明的目标。",
  }),
  managed_browser_unsupported: Object.freeze({
    title: "授权方式不支持",
    message: "该目标不能使用共享浏览器登录流程。",
    nextStep: "请刷新状态并使用目标卡片中后端声明的操作。",
  }),
  shared_browser_busy: Object.freeze({
    title: "共享浏览器正忙",
    message: "另一项授权或 Profile 清理正在占用共享浏览器。",
    nextStep: "完成或取消当前授权后，刷新状态再试。",
  }),
  chrome_not_found: Object.freeze({
    title: "未找到 Chrome / Chromium",
    message: "后端无法启动项目专属授权浏览器。",
    nextStep: "请在后端配置 auth.chrome_executable，然后手动重试。",
  }),
  browser_profile_busy: Object.freeze({
    title: "共享 Profile 正在使用",
    message: "后端无法安全取得共享授权 Profile。",
    nextStep: "请关闭残留的项目授权 Chrome，再刷新状态重试。",
  }),
  browser_login_start_failed: Object.freeze({
    title: "授权浏览器启动失败",
    message: "后端未能打开共享授权浏览器标签页。",
    nextStep: "请检查 Chrome 配置与桌面会话，然后手动重试。",
  }),
  browser_login_session_not_found: Object.freeze({
    title: "授权会话已失效",
    message: "后端找不到刚才的共享浏览器会话。",
    nextStep: "请刷新目标状态；如仍未配置，请重新开始授权。",
  }),
  pixiv_oauth_session_not_found: Object.freeze({
    title: "Pixiv 会话已失效",
    message: "后端找不到当前 Pixiv 授权会话。",
    nextStep: "请刷新 Pixiv 状态并重新开始授权。",
  }),
  pixiv_oauth_session_expired: Object.freeze({
    title: "Pixiv 授权已过期",
    message: "本次 Pixiv 授权没有在时限内完成。",
    nextStep: "请重新开始，并在共享浏览器中完成登录。",
  }),
  pixiv_oauth_start_timeout: Object.freeze({
    title: "Pixiv 授权启动超时",
    message: "后端未能及时建立 Pixiv 授权流程。",
    nextStep: "请检查 Chrome 与网络线路，刷新状态后重试。",
  }),
  pixiv_oauth_start_failed: Object.freeze({
    title: "Pixiv 授权启动失败",
    message: "后端未能启动 Pixiv OAuth 与共享浏览器流程。",
    nextStep: "请检查 gallery-dl、Chrome 与授权代理，然后重试。",
  }),
  pixiv_oauth_exchange_active: Object.freeze({
    title: "Pixiv 正在确认授权",
    message: "后端正在交换已捕获的 Pixiv 回调。",
    nextStep: "请等待状态轮询完成，不要重复提交。",
  }),
  pixiv_oauth_process_ended: Object.freeze({
    title: "Pixiv 授权进程已结束",
    message: "本次 Pixiv 授权进程无法继续。",
    nextStep: "请刷新状态后重新开始授权。",
  }),
  pixiv_oauth_exchange_timeout: Object.freeze({
    title: "Pixiv 授权确认超时",
    message: "后端未能在时限内完成 Token 交换。",
    nextStep: "请检查授权代理与外部网络，然后重新开始。",
  }),
  pixiv_oauth_exchange_failed: Object.freeze({
    title: "Pixiv 授权确认失败",
    message: "后端没有保存可用的 Pixiv 授权缓存。",
    nextStep: "请重新授权；不要把浏览器回调或 Token 粘贴到页面。",
  }),
  pixiv_oauth_cache_failed: Object.freeze({
    title: "Pixiv 授权保存失败",
    message: "后端无法安全保存 Pixiv 授权缓存。",
    nextStep: "请检查 credentials 私有目录权限后重新授权。",
  }),
  auth_cache_clear_failed: Object.freeze({
    title: "授权材料清理失败",
    message: "后端未确认授权缓存已经删除。",
    nextStep: "现有状态不会乐观标记为已清除；请检查权限后重试。",
  }),
  browser_profile_reset_active: Object.freeze({
    title: "Profile 正在清空",
    message: "共享授权 Profile 已有一个清理操作在执行。",
    nextStep: "请等待并手动刷新状态。",
  }),
  invalid_browser_profile_path: Object.freeze({
    title: "Profile 路径安全校验失败",
    message: "后端拒绝清理不符合私有目录边界的 Profile。",
    nextStep: "请检查 credentials/managed 路径与符号链接，再重试。",
  }),
  network_error: Object.freeze({
    title: "后端连接中断",
    message: "VAULT 无法连接到 ImageWeave 后端。",
    nextStep: "确认后端恢复后使用“刷新安全状态”手动刷新，无需重载整个桌面。",
  }),
  invalid_response: Object.freeze({
    title: "授权响应未通过校验",
    message: "页面拒绝采用包含未知或危险字段的授权响应。",
    nextStep: "请刷新；若持续发生，请检查后端与桌面 WebUI 版本是否匹配。",
  }),
});

function safeErrorCode(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
    ? value
    : "request_failed";
}

function safeRequestId(value) {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value.trim()) ? value.trim() : "";
}

export function vaultErrorGuidance(error) {
  let code = safeErrorCode(error?.code);
  if (code === "request_failed" && error instanceof TypeError) code = "invalid_response";
  const status = Number.isInteger(error?.status) ? error.status : 0;
  let guidance = ERROR_GUIDANCE[code];
  if (!guidance && (status === 401 || status === 403)) {
    guidance = {
      title: "授权 API 拒绝访问",
      message: "后端拒绝了当前 VAULT 请求。",
      nextStep: "请确认仍通过同源 /ui/ 访问，并检查后端访问策略。",
    };
  } else if (!guidance && status === 409) {
    guidance = {
      title: "授权操作冲突",
      message: "后端拒绝并发或状态冲突操作。",
      nextStep: "请刷新安全状态，完成当前授权后再重试。",
    };
  } else if (!guidance && status === 413) {
    guidance = ERROR_GUIDANCE.auth_request_too_large;
  } else if (!guidance && status === 422) {
    guidance = {
      title: "授权请求格式无效",
      message: "后端未接受本次请求。",
      nextStep: "请检查当前控件格式；页面不会显示原始请求或 details。",
    };
  } else if (!guidance && status >= 500) {
    guidance = {
      title: "授权后端暂时不可用",
      message: "后端未能完成本次授权操作。",
      nextStep: "保留已加载状态，稍后手动刷新；必要时打开 DIAG.EXE。",
    };
  } else if (!guidance) {
    guidance = {
      title: "授权操作未完成",
      message: "本次 VAULT 操作没有完成。",
      nextStep: "请刷新安全状态后重试；页面不会渲染原始错误 details。",
    };
  }
  return Object.freeze({
    code,
    title: guidance.title,
    message: guidance.message,
    nextStep: guidance.nextStep,
    requestId: safeRequestId(error?.requestId),
  });
}
