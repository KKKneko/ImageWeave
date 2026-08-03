const SUPPORTED_METHODS = new Set(["GET", "POST", "PUT", "DELETE"]);
const DEFAULT_ACCEPT = "application/json";
const IDEMPOTENCY_HEADER = "Idempotency-Key";

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function boundedString(value, fallback, maximum = 500) {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maximum) : fallback;
}

function normalizeRequestId(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(normalized) ? normalized : "";
}

export class ApiError extends Error {
  constructor({ status = 0, code, message, details = null, requestId = "" }) {
    super(message);
    this.name = "ApiError";
    this.status = Number.isInteger(status) ? status : 0;
    this.code = boundedString(code, "request_failed", 128);
    this.details = details ?? null;
    this.requestId = normalizeRequestId(requestId);
  }
}

export function isAbortError(error) {
  return Boolean(error && typeof error === "object" && error.name === "AbortError");
}

export function parseResponseText(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return Object.freeze({ kind: "empty", value: null });
  }
  try {
    return Object.freeze({ kind: "json", value: JSON.parse(text) });
  } catch {
    return Object.freeze({ kind: "invalid", value: null });
  }
}

export function normalizeApiError({
  status = 0,
  payload = null,
  requestId = "",
  kind = "http",
} = {}) {
  const backendError = isRecord(payload) && isRecord(payload.error) ? payload.error : null;
  const resolvedRequestId = normalizeRequestId(
    backendError?.request_id || (isRecord(payload) ? payload.request_id : "") || requestId,
  );

  if (backendError) {
    return new ApiError({
      status,
      code: boundedString(backendError.code, "backend_error", 128),
      message: boundedString(backendError.message, "后端拒绝了该请求"),
      details: Object.prototype.hasOwnProperty.call(backendError, "details")
        ? backendError.details
        : null,
      requestId: resolvedRequestId,
    });
  }

  if (kind === "network") {
    return new ApiError({
      status: 0,
      code: "network_error",
      message: "无法连接到 ImageWeave 后端",
      details: null,
      requestId: resolvedRequestId,
    });
  }

  if (kind === "invalid_response") {
    return new ApiError({
      status,
      code: "invalid_response",
      message: "服务器返回了无法解析的 JSON 响应",
      details: null,
      requestId: resolvedRequestId,
    });
  }

  return new ApiError({
    status,
    code: "http_error",
    message: status ? `请求失败（HTTP ${status}）` : "请求失败",
    details: isRecord(payload) || Array.isArray(payload) ? payload : null,
    requestId: resolvedRequestId,
  });
}

function normalizeMethod(method) {
  const normalized = typeof method === "string" ? method.toUpperCase() : "GET";
  if (!SUPPORTED_METHODS.has(normalized)) {
    throw new TypeError(`不支持的 HTTP 方法：${normalized}`);
  }
  return normalized;
}

function normalizeIdempotencyKey(value) {
  if (typeof value !== "string") throw new TypeError("幂等键必须是字符串");
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(normalized)) {
    throw new TypeError("幂等键格式无效");
  }
  return normalized;
}

export function createIdempotencyKey({
  prefix = "webui",
  cryptoObject = globalThis.crypto,
  now = Date.now,
  random = Math.random,
} = {}) {
  if (!/^[a-z][a-z0-9_-]{0,23}$/i.test(prefix)) {
    throw new TypeError("幂等键前缀格式无效");
  }
  try {
    if (typeof cryptoObject?.randomUUID === "function") {
      return `${prefix}-${cryptoObject.randomUUID()}`;
    }
  } catch {
    // 浏览器拒绝随机源时使用不含业务数据的本地回退值。
  }
  const timestamp = Math.max(0, Number(now()) || 0).toString(36);
  const entropy = Math.floor(Math.max(0, Math.min(0.999999999999, Number(random()) || 0)) * 0x100000000)
    .toString(36)
    .padStart(7, "0");
  return `${prefix}-${timestamp}-${entropy}`;
}

export function injectIdempotencyKey(headers = {}, key = createIdempotencyKey()) {
  const result = new Headers(headers);
  if (!result.has(IDEMPOTENCY_HEADER)) {
    result.set(IDEMPOTENCY_HEADER, normalizeIdempotencyKey(key));
  }
  return result;
}

export function buildRequestOptions(method = "GET", options = {}) {
  if (!isRecord(options)) throw new TypeError("请求选项必须是对象");
  const normalizedMethod = normalizeMethod(method);
  let headers = new Headers(options.headers || {});
  if (!headers.has("Accept")) headers.set("Accept", DEFAULT_ACCEPT);

  const hasBody = Object.prototype.hasOwnProperty.call(options, "body") &&
    options.body !== undefined;
  if (hasBody && normalizedMethod === "GET") {
    throw new TypeError("GET 请求不得携带请求体");
  }

  let serializedBody;
  if (hasBody) {
    try {
      serializedBody = JSON.stringify(options.body);
    } catch {
      throw new ApiError({
        status: 0,
        code: "invalid_request_body",
        message: "请求体无法序列化为 JSON",
      });
    }
    if (serializedBody === undefined) {
      throw new ApiError({
        status: 0,
        code: "invalid_request_body",
        message: "请求体无法序列化为 JSON",
      });
    }
    headers.set("Content-Type", "application/json");
  } else {
    headers.delete("Content-Type");
  }

  if (options.idempotencyKey) {
    const key = options.idempotencyKey === true
      ? createIdempotencyKey(options.idempotencyOptions)
      : normalizeIdempotencyKey(options.idempotencyKey);
    headers = injectIdempotencyKey(headers, key);
  }

  const requestOptions = {
    method: normalizedMethod,
    cache: "no-store",
    headers,
  };
  if (hasBody) requestOptions.body = serializedBody;
  if (options.signal !== undefined) requestOptions.signal = options.signal;
  return requestOptions;
}

async function readResponse(response) {
  if (response.status === 204) return Object.freeze({ parsed: null, kind: "empty" });
  const text = await response.text();
  const result = parseResponseText(text);
  return Object.freeze({ parsed: result.value, kind: result.kind });
}

export function createApiClient({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("Fetch 实现不可用");

  const request = async (url, options = {}) => {
    if (typeof url !== "string" || url.trim() === "") {
      throw new TypeError("请求 URL 必须是非空字符串");
    }
    const requestOptions = buildRequestOptions(options.method || "GET", options);
    let response;
    try {
      response = await fetchImpl(url, requestOptions);
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (error instanceof ApiError) throw error;
      throw normalizeApiError({ kind: "network" });
    }

    const headerRequestId = normalizeRequestId(response.headers?.get("X-Request-ID") || "");
    let body;
    try {
      body = await readResponse(response);
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw normalizeApiError({
        status: response.status,
        requestId: headerRequestId,
        kind: "network",
      });
    }

    if (!response.ok) {
      throw normalizeApiError({
        status: response.status,
        payload: body.kind === "json" ? body.parsed : null,
        requestId: headerRequestId,
      });
    }
    if (body.kind === "invalid") {
      throw normalizeApiError({
        status: response.status,
        requestId: headerRequestId,
        kind: "invalid_response",
      });
    }
    if (isRecord(body.parsed) && isRecord(body.parsed.error)) {
      throw normalizeApiError({
        status: response.status,
        payload: body.parsed,
        requestId: headerRequestId,
      });
    }
    return body.parsed;
  };

  return Object.freeze({
    request,
    get(url, options = {}) {
      return request(url, { ...options, method: "GET" });
    },
    post(url, body, options = {}) {
      return request(url, {
        ...options,
        method: "POST",
        ...(body === undefined ? {} : { body }),
      });
    },
    put(url, body, options = {}) {
      return request(url, {
        ...options,
        method: "PUT",
        ...(body === undefined ? {} : { body }),
      });
    },
    delete(url, options = {}) {
      return request(url, { ...options, method: "DELETE" });
    },
    createIdempotencyKey,
  });
}
