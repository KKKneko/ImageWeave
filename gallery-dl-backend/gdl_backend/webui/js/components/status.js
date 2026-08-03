import { createElement } from "../core/dom.js";

export const STATUS_PRESENTATION = Object.freeze({
  ready: Object.freeze({ icon: "✓", label: "已就绪" }),
  running: Object.freeze({ icon: "▶", label: "运行中" }),
  warning: Object.freeze({ icon: "△", label: "等待处理" }),
  error: Object.freeze({ icon: "!", label: "发生错误" }),
  disabled: Object.freeze({ icon: "—", label: "不可用" }),
});

const STATUS_ALIASES = Object.freeze({
  ok: "ready",
  ready: "ready",
  running: "running",
  pending: "warning",
  warning: "warning",
  optional_warning: "warning",
  optional_missing: "warning",
  error: "error",
  failed: "error",
  disabled: "disabled",
  placeholder: "disabled",
});

export function normalizeStatus(status) {
  if (typeof status !== "string") return null;
  return STATUS_ALIASES[status.trim().toLowerCase()] || null;
}

export function resolveStatusPresentation(status, label = "") {
  const normalized = normalizeStatus(status);
  if (!normalized) throw new Error(`未知状态：${status}`);
  const presentation = STATUS_PRESENTATION[normalized];
  return Object.freeze({
    status: normalized,
    icon: presentation.icon,
    label: typeof label === "string" && label.trim() ? label.trim() : presentation.label,
  });
}

export function updateStatusBadge(element, status, label, { title = "" } = {}) {
  if (!(element instanceof HTMLElement)) throw new TypeError("状态徽标元素无效");
  const presentation = resolveStatusPresentation(status, label);
  element.dataset.status = presentation.status;
  element.setAttribute("aria-label", presentation.label);
  if (title) element.title = title;
  else element.removeAttribute("title");

  let iconElement = element.children[0];
  let labelElement = element.children[1];
  if (!(iconElement instanceof HTMLElement) || !(labelElement instanceof HTMLElement)) {
    iconElement = createElement("span", { attributes: { "aria-hidden": "true" } });
    labelElement = createElement("span");
    element.replaceChildren(iconElement, labelElement);
  }
  iconElement.setAttribute("aria-hidden", "true");
  iconElement.textContent = presentation.icon;
  labelElement.textContent = presentation.label;
  return element;
}

export function createStatusBadge(status, label, { compact = false } = {}) {
  const element = createElement("span", {
    className: `status-badge${compact ? " status-badge--compact" : ""}`,
  });
  return updateStatusBadge(element, status, label);
}
