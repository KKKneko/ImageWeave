const SITE_DEFINITIONS = Object.freeze([
  Object.freeze({ id: "danbooru", label: "Danbooru" }),
  Object.freeze({ id: "twitter", label: "X / Twitter" }),
  Object.freeze({ id: "pixiv", label: "Pixiv" }),
  Object.freeze({ id: "exhentai", label: "EH" }),
  Object.freeze({ id: "pawchive", label: "Pawchive" }),
]);

const SITE_IDS = new Set(SITE_DEFINITIONS.map((item) => item.id));
const PROXY_MODES = new Set(["direct", "prefer", "required"]);
const SOURCE_STATUSES = new Set(["succeeded", "partial", "failed"]);
const AUTH_STATES = new Set(["ready", "authorized", "authorizing", "required", "public"]);
const FILTER_MODES = new Set(["include", "exclude"]);
const EH_NAMESPACES = new Set([
  "artist", "character", "cosplayer", "female", "group", "language", "location",
  "male", "mixed", "other", "parody", "reclass", "temp", "unknown",
]);
const EH_ALIASES = Object.freeze({
  a: "artist", artist: "artist", c: "character", char: "character", character: "character",
  cos: "cosplayer", cosplayer: "cosplayer", f: "female", female: "female",
  g: "group", circle: "group", group: "group", l: "language", lang: "language",
  language: "language", loc: "location", location: "location", m: "male", male: "male",
  x: "mixed", mixed: "mixed", o: "other", other: "other", p: "parody",
  series: "parody", parody: "parody", r: "reclass", reclass: "reclass", temp: "temp",
});
const EVIDENCE_LABELS = Object.freeze({
  site_search_work_evidence: "有站内作品证据",
  account_name_exact_match: "账号身份精确匹配",
  account_identity_unverified: "账号身份待核对",
  danbooru_artist_directory_match: "Danbooru 画师目录匹配",
  danbooru_artist_directory_alias_match: "Danbooru 画师别名待核对",
  artist_tag_exact_match: "画师标签精确匹配",
  character_tag_exact_match: "角色标签精确匹配",
  keyword_gallery_search_only: "仅关键词画廊命中",
  keyword_gallery_search: "站内关键词画廊候选",
  keyword_creator_search: "站内画师目录命中",
  danbooru_artist_url: "Danbooru 人工维护主页",
  danbooru_alias_search: "Danbooru 别名扩搜命中",
  danbooru_alias_name_match: "Danbooru 别名精确匹配",
});

export const CRAWL_SITE_DEFINITIONS = SITE_DEFINITIONS;
export const CRAWL_PAGE_LIMITS = Object.freeze({ search: 200, addresses: 500, tasks: 100_000 });

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeText(value, fallback = "", maximum = 180) {
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

function boundedInteger(value, minimum, maximum, fallback = minimum) {
  const number = Number(value);
  return Number.isInteger(number) && number >= minimum && number <= maximum ? number : fallback;
}

function safeIdentifier(value, maximum = 128) {
  const text = typeof value === "string" || typeof value === "number" ? String(value).trim() : "";
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text) && text.length <= maximum ? text : "";
}

function safeEnum(value, allowed, fallback) {
  return typeof value === "string" && allowed.has(value) ? value : fallback;
}

function safeOperationalUrl(value) {
  if (typeof value !== "string" || value.length < 4 || value.length > 8192 || /[\u0000-\u0020\u007f]/.test(value)) {
    return "";
  }
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
      return "";
    }
    return parsed.href;
  } catch {
    return "";
  }
}

function displayEndpoint(value, site, addressType) {
  const url = safeOperationalUrl(value);
  if (!url) return "地址不可用";
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^www\./, "");
  if (site === "exhentai") {
    const match = parsed.pathname.match(/^\/g\/(\d+)\//);
    return match ? `${host} · 画廊 ${match[1]} · 访问令牌已隐藏` : `${host} · EH 画廊`;
  }
  return `${host} · ${safeText(addressType, "图库地址", 50)}`;
}

function safeThumbnail(value, site) {
  if (site !== "exhentai") return "";
  const url = safeOperationalUrl(value);
  if (!url) return "";
  const parsed = new URL(url);
  const host = parsed.hostname.toLowerCase();
  if (!/(^|\.)(ehgt\.org|ehgt\.com|e-hentai\.org|exhentai\.org)$/.test(host)) return "";
  if (parsed.search || parsed.hash || /(?:token|secret|auth|session)/i.test(parsed.pathname)) return "";
  return parsed.href;
}

function safeExternalProfileUrl(value) {
  const url = safeOperationalUrl(value);
  if (!url) return "";
  const parsed = new URL(url);
  if (parsed.search || parsed.hash || /(?:token|secret|oauth|session)/i.test(parsed.pathname)) return "";
  return parsed.href;
}

function sanitizeTags(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  const seen = new Set();
  for (const item of value.slice(0, 160)) {
    const tag = parseEhTag(item);
    if (!tag || seen.has(tag.key)) continue;
    seen.add(tag.key);
    result.push(Object.freeze(tag));
  }
  return result;
}

function sanitizeFacets(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const facet of value.slice(0, 32)) {
    if (!isRecord(facet)) continue;
    const namespace = safeEnum(String(facet.namespace || ""), EH_NAMESPACES, "unknown");
    const tags = [];
    for (const item of Array.isArray(facet.tags) ? facet.tags.slice(0, 160) : []) {
      if (!isRecord(item)) continue;
      const parsed = parseEhTag(item.tag);
      if (!parsed) continue;
      tags.push(Object.freeze({
        key: parsed.key,
        value: parsed.value,
        count: boundedInteger(item.count, 0, 1_000_000_000, 0),
      }));
    }
    if (!tags.length) continue;
    result.push(Object.freeze({
      namespace,
      label: safeText(facet.label, namespace, 80),
      galleryCount: boundedInteger(facet.gallery_count, 0, 1_000_000_000, 0),
      tags,
    }));
  }
  return result;
}

function candidateKey(sourceIndex, candidateIndex) {
  return `candidate:${sourceIndex}:${candidateIndex}`;
}

function sourceKey(site, sourceIndex) {
  return `source:${site}:${sourceIndex}`;
}

function sanitizeCandidate(raw, { site, sourceIndex, candidateIndex, weak }) {
  if (!isRecord(raw)) return null;
  const url = safeOperationalUrl(raw.url);
  if (!url) return null;
  const addressType = safeText(raw.address_type, "图库地址", 64);
  const label = safeText(raw.label || raw.tag || raw.title || raw.id, "未命名地址", 180);
  const evidence = [];
  for (const reason of Array.isArray(raw.evidence_reasons) ? raw.evidence_reasons.slice(0, 12) : []) {
    if (typeof reason === "string" && Object.prototype.hasOwnProperty.call(EVIDENCE_LABELS, reason)) {
      evidence.push(EVIDENCE_LABELS[reason]);
    }
  }
  const confidence = weak
    ? "weak"
    : raw.confidence === "verified"
      ? "verified"
      : "site_search";
  return Object.freeze({
    key: candidateKey(sourceIndex, candidateIndex),
    site,
    weak: Boolean(weak),
    selected: false,
    submitId: safeIdentifier(raw.id, 128),
    label,
    addressType,
    displayEndpoint: displayEndpoint(url, site, addressType),
    confidence,
    origin: safeText(raw.origin, "", 64),
    mediaCount: boundedInteger(raw.media_count, 0, 1_000_000_000, 0),
    matchedItems: boundedInteger(raw.matched_items, 0, 1_000_000_000, 0),
    relatedProfileCount: boundedInteger(raw.related_profiles?.length, 0, 1_000, 0),
    evidence,
    tags: sanitizeTags(raw.metadata?.tags),
    thumbnailUrl: safeThumbnail(raw.thumbnail_url, site),
  });
}

function sanitizeAuth(raw) {
  if (!isRecord(raw)) return Object.freeze({ known: false, authorized: false, state: "unknown" });
  const state = safeEnum(raw.state, AUTH_STATES, "unknown");
  return Object.freeze({
    known: state !== "unknown",
    authorized: Boolean(raw.authorized),
    state,
  });
}

function sanitizeSource(raw, sourceIndex, operations) {
  if (!isRecord(raw)) return null;
  const site = typeof raw.site === "string" ? raw.site.trim().toLowerCase() : "";
  if (!SITE_IDS.has(site)) return null;
  const key = sourceKey(site, sourceIndex);
  const addresses = [];
  const rawCandidates = [
    ...(Array.isArray(raw.addresses) ? raw.addresses.map((item) => [item, false]) : []),
    ...(Array.isArray(raw.weak_evidence) ? raw.weak_evidence.map((item) => [item, true]) : []),
  ];
  const identities = new Set();
  for (const [candidate, weak] of rawCandidates.slice(0, 1_000)) {
    const operationalUrl = safeOperationalUrl(candidate?.url);
    if (!operationalUrl || identities.has(operationalUrl)) continue;
    identities.add(operationalUrl);
    const projected = sanitizeCandidate(candidate, {
      site,
      sourceIndex,
      candidateIndex: addresses.length,
      weak,
    });
    if (!projected) continue;
    addresses.push(projected);
    operations.set(projected.key, Object.freeze({
      site,
      url: operationalUrl,
      id: projected.submitId,
      label: projected.label,
      address_type: projected.addressType,
    }));
  }
  return Object.freeze({
    key,
    site,
    label: SITE_DEFINITIONS.find((item) => item.id === site)?.label || site,
    status: safeEnum(raw.status, SOURCE_STATUSES, "failed"),
    evidenceCount: boundedInteger(raw.evidence_count, 0, 1_000_000_000, 0),
    previewCount: boundedInteger(raw.preview_count, 0, 1_000_000_000, 0),
    attempts: boundedInteger(raw.attempts, 0, 1_000_000, 0),
    aliases: Array.isArray(raw.alias_keywords)
      ? raw.alias_keywords.slice(0, 16).map((item) => safeText(item, "", 80)).filter(Boolean)
      : [],
    errorCode: safeIdentifier(raw.error?.code, 128),
    enrichmentIssueCount: Array.isArray(raw.enrichment_errors)
      ? Math.min(raw.enrichment_errors.length, 1_000)
      : 0,
    auth: sanitizeAuth(raw.auth),
    tagFacets: site === "exhentai" ? sanitizeFacets(raw.tag_facets) : [],
    addresses,
  });
}

function sanitizeProfiles(value) {
  if (!Array.isArray(value)) return [];
  const result = [];
  for (const raw of value.slice(0, 80)) {
    if (!isRecord(raw)) continue;
    const url = safeExternalProfileUrl(raw.url);
    if (!url) continue;
    result.push(Object.freeze({
      artist: safeText(raw.artist_name, "画师", 100),
      platform: safeText(raw.platform, "external", 40),
      host: new URL(url).hostname.replace(/^www\./, ""),
      url,
    }));
  }
  return result;
}

export function sanitizeAutocompleteResponse(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.items)) return [];
  const allowedCategories = new Set(["artist", "character", "copyright", "general", "meta"]);
  const result = [];
  for (const raw of payload.items.slice(0, 10)) {
    if (!isRecord(raw)) continue;
    const value = safeText(raw.value, "", 180);
    if (!value) continue;
    result.push(Object.freeze({
      value,
      label: safeText(raw.label, value, 180),
      category: safeEnum(raw.category, allowedCategories, "general"),
      antecedent: safeText(raw.antecedent, "", 120),
      postCount: boundedInteger(raw.post_count, 0, 1_000_000_000, 0),
    }));
  }
  return result;
}

export function projectCrawlSearchResponse(payload) {
  if (!isRecord(payload) || !Array.isArray(payload.sources)) {
    throw new TypeError("搜索响应格式无效");
  }
  const operations = new Map();
  const sources = [];
  for (const raw of payload.sources.slice(0, SITE_DEFINITIONS.length)) {
    const source = sanitizeSource(raw, sources.length, operations);
    if (source && !sources.some((item) => item.site === source.site)) sources.push(source);
  }
  const addressCount = sources.reduce(
    (total, source) => total + source.addresses.filter((item) => !item.weak).length,
    0,
  );
  const weakCount = sources.reduce(
    (total, source) => total + source.addresses.filter((item) => item.weak).length,
    0,
  );
  return Object.freeze({
    snapshot: Object.freeze({
      sources,
      relatedProfiles: sanitizeProfiles(payload.related_profiles),
      addressCount,
      weakEvidenceCount: weakCount,
      showWeakEvidence: false,
      ehTagFilter: new Map(),
    }),
    operations,
  });
}

export function validateCrawlSnapshot(value) {
  if (!isRecord(value) || !Array.isArray(value.sources) || !(value.ehTagFilter instanceof Map)) {
    throw new TypeError("抓取搜索投影无效");
  }
  for (const source of value.sources) {
    if (!isRecord(source) || !SITE_IDS.has(source.site) || !Array.isArray(source.addresses)) {
      throw new TypeError("抓取来源投影无效");
    }
    for (const candidate of source.addresses) {
      if (!isRecord(candidate) || !/^candidate:\d+:\d+$/.test(candidate.key) || typeof candidate.selected !== "boolean") {
        throw new TypeError("抓取候选投影无效");
      }
      if (Object.prototype.hasOwnProperty.call(candidate, "url")) {
        throw new TypeError("抓取投影不得包含原始地址");
      }
    }
  }
  for (const [key, mode] of value.ehTagFilter) {
    if (!/^[a-z]+:[^\u0000-\u001f\u007f]{1,160}$/.test(key) || !FILTER_MODES.has(mode)) {
      throw new TypeError("EH 标签筛选投影无效");
    }
  }
  return value;
}

export function parseEhTag(value) {
  const text = safeText(value, "", 180);
  if (!text) return null;
  const separator = text.indexOf(":");
  let namespace = "temp";
  let tagValue = text;
  if (separator > 0) {
    namespace = EH_ALIASES[text.slice(0, separator).trim().toLowerCase()] || "unknown";
    tagValue = text.slice(separator + 1).trim();
  }
  if (!tagValue) return null;
  return Object.freeze({
    namespace,
    value: tagValue,
    key: `${namespace}:${tagValue.toLowerCase()}`,
  });
}

export function candidateMatchesEhFilter(candidate, filter) {
  if (!(filter instanceof Map) || filter.size === 0) return true;
  const keys = new Set((candidate?.tags || []).map((item) => item.key));
  const includeGroups = new Map();
  for (const [key, mode] of filter) {
    if (mode === "exclude" && keys.has(key)) return false;
    if (mode !== "include") continue;
    const namespace = key.slice(0, key.indexOf(":"));
    if (!includeGroups.has(namespace)) includeGroups.set(namespace, []);
    includeGroups.get(namespace).push(key);
  }
  for (const group of includeGroups.values()) {
    if (!group.some((key) => keys.has(key))) return false;
  }
  return true;
}

export function crawlCandidateVisible(snapshot, source, candidate) {
  if (candidate.weak && !snapshot.showWeakEvidence) return false;
  return source.site !== "exhentai" || candidateMatchesEhFilter(candidate, snapshot.ehTagFilter);
}

function strictProxyMode(value, fallback = "required") {
  if (!PROXY_MODES.has(value)) throw new TypeError("代理模式无效");
  return value || fallback;
}

function strictSourceOptions(value, selectedSites) {
  if (!isRecord(value)) return {};
  const result = {};
  for (const site of selectedSites) {
    const option = value[site];
    if (!isRecord(option) || !option.proxy_mode) continue;
    result[site] = { proxy_mode: strictProxyMode(option.proxy_mode) };
  }
  return result;
}

export function buildSearchPayload({ keyword, sites, limit, proxyMode, sourceOptions = {} }) {
  const text = typeof keyword === "string" ? keyword.trim() : "";
  if (!text || text.length > 1_000 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new TypeError("请输入长度不超过 1000 的有效关键词");
  }
  const requested = Array.isArray(sites) ? sites : [];
  const orderedSites = SITE_DEFINITIONS.map((item) => item.id).filter((site) => requested.includes(site));
  if (!orderedSites.length) throw new TypeError("至少选择一个搜索来源");
  return {
    keyword: text,
    sites: orderedSites,
    limit: boundedInteger(limit, 1, 200, 0) || (() => { throw new TypeError("证据上限需为 1–200 的整数"); })(),
    proxy_mode: strictProxyMode(proxyMode),
    source_options: strictSourceOptions(sourceOptions, orderedSites),
  };
}

function strictOutputDir(value) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return "";
  if (text.length > 2_048 || /[\u0000-\u001f\u007f]/.test(text)) {
    throw new TypeError("输出目录格式无效");
  }
  return text;
}

export function buildCrawlPayload({
  snapshot,
  operations,
  concurrency,
  maxTasks,
  proxyMode,
  outputDir = "",
  sourceOptions = {},
  ehDownload = { image_mode: "original", gp_policy: "stop" },
}) {
  validateCrawlSnapshot(snapshot);
  if (!(operations instanceof Map)) throw new TypeError("抓取地址映射无效");
  const selectedSources = [];
  for (const source of snapshot.sources) {
    const addresses = [];
    for (const candidate of source.addresses) {
      if (!candidate.selected) continue;
      const operational = operations.get(candidate.key);
      if (!operational || operational.site !== source.site || !safeOperationalUrl(operational.url)) {
        throw new TypeError("选中的地址已失效，请重新搜索");
      }
      const address = {
        url: operational.url,
        ...(operational.id ? { id: operational.id } : {}),
        ...(operational.label ? { label: operational.label } : {}),
        ...(operational.address_type ? { address_type: operational.address_type } : {}),
      };
      addresses.push(address);
    }
    if (!addresses.length) continue;
    const options = strictSourceOptions(sourceOptions, [source.site])[source.site] || {};
    const item = { site: source.site, addresses, ...options };
    if (source.site === "exhentai") {
      const imageMode = ehDownload?.image_mode;
      const gpPolicy = ehDownload?.gp_policy;
      if (!["original", "resample"].includes(imageMode) || !["stop", "resized"].includes(gpPolicy)) {
        throw new TypeError("EH 下载选项无效");
      }
      item.eh_download = { image_mode: imageMode, gp_policy: gpPolicy };
    }
    selectedSources.push(item);
  }
  if (!selectedSources.length) throw new TypeError("至少选择一个图库地址");
  const payload = {
    sources: selectedSources,
    concurrency: boundedInteger(concurrency, 1, 128, 0) || (() => { throw new TypeError("图片并发需为 1–128 的整数"); })(),
    max_tasks: boundedInteger(maxTasks, 1, 100_000, 0) || (() => { throw new TypeError("任务上限需为 1–100000 的整数"); })(),
    proxy_mode: strictProxyMode(proxyMode),
  };
  const output = strictOutputDir(outputDir);
  if (output) payload.output_dir = output;
  return payload;
}

export function crawlErrorGuidance(error) {
  const code = safeIdentifier(error?.code, 128) || "request_failed";
  const status = Number.isInteger(error?.status) ? error.status : 0;
  const requestId = safeIdentifier(error?.requestId, 128);
  const authentication = /auth|credential|login/i.test(code);
  const proxy = /proxy/i.test(code);
  return Object.freeze({
    code,
    requestId,
    targetApp: authentication ? "vault" : proxy ? "proxy" : "diagnostics",
    title: status === 409 ? "当前状态不允许此操作" : status === 422 ? "请求配置未通过校验" : "抓取请求未完成",
    message: status === 0 ? "无法连接到 ImageWeave 后端。" : "后端没有接受本次请求。",
    nextStep: authentication
      ? "打开 VAULT.CPL 检查对应站点授权后重试。"
      : proxy
        ? "打开 PROXY.CPL 检查代理池与租约状态后重试。"
        : "保留当前选择，修正输入或打开 DIAG.EXE 检查系统状态。",
  });
}
