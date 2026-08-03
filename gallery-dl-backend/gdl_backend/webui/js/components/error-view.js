import { createElement } from "../core/dom.js";
import { createStatusBadge } from "./status.js";

const SAFE_GENERIC_MESSAGES = Object.freeze({
  network_error: "无法连接到 ImageWeave 后端。",
  invalid_response: "后端响应格式无效，界面没有采用该响应。",
  http_error: "后端返回了错误状态。",
  request_failed: "请求未能完成。",
});

function safeText(value, fallback, maximum = 300) {
  if (typeof value !== "string") return fallback;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/https?:\/\/[^\s]+/gi, "[地址已隐藏]")
    .replace(/\b(token|cookie|password|secret|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[已隐藏]")
    .replace(/(^|[\s(])(?:[A-Za-z]:[\\/]|\/)[^\s,;，；)]+/g, "$1[路径已隐藏]")
    .replace(/\s+/g, " ")
    .trim();
  return normalized ? normalized.slice(0, maximum) : fallback;
}

function safeRequestId(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return /^[A-Za-z0-9._:-]{1,128}$/.test(normalized) ? normalized : "";
}

export function toSafeErrorViewModel(error, {
  fallbackMessage = "请求未能完成。",
  nextStep = "请稍后重试，或打开 DIAG.EXE 检查系统状态。",
} = {}) {
  const code = typeof error?.code === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(error.code)
    ? error.code
    : "request_failed";
  const generic = SAFE_GENERIC_MESSAGES[code];
  const message = generic || safeText(error?.message, fallbackMessage);
  return Object.freeze({
    code,
    message,
    requestId: safeRequestId(error?.requestId),
    nextStep: safeText(nextStep, "请稍后重试。", 200),
  });
}

export function createErrorView(error, {
  nextStep,
  statusLabel = "操作失败",
  actionLabel = "打开 DIAG.EXE",
  onAction = null,
} = {}) {
  const model = toSafeErrorViewModel(error, { nextStep });
  const element = createElement("section", {
    className: "error-view",
    attributes: { role: "alert" },
  });
  const children = [
    createStatusBadge("error", safeText(statusLabel, "操作失败", 120)),
    createElement("p", { className: "error-view__message", text: model.message }),
  ];
  if (model.requestId) {
    children.push(
      createElement("p", { className: "error-view__request" }, [
        "请求 ID：",
        createElement("code", { text: model.requestId }),
      ]),
    );
  }
  children.push(createElement("p", { className: "error-view__next", text: model.nextStep }));

  let button = null;
  let listener = null;
  if (typeof onAction === "function") {
    button = createElement("button", {
      className: "route-button",
      text: actionLabel,
      attributes: { type: "button" },
    });
    listener = () => onAction();
    button.addEventListener("click", listener);
    children.push(button);
  }
  element.append(...children);

  return Object.freeze({
    element,
    model,
    destroy() {
      if (button && listener) button.removeEventListener("click", listener);
      element.remove();
    },
  });
}
