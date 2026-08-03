import { createElement } from "../core/dom.js";
import {
  derivePolicyControls,
  formatPolicySource,
  getPolicySiteDefinition,
  isPolicyDirty,
  POLICY_SITE_IDS,
  policyConfigToDraft,
  policyErrorGuidance,
  validatePolicyDraft,
} from "../core/policy-model.js";
import { selectors } from "../core/store.js";
import { createErrorView } from "./error-view.js";
import { buildPolicyDom } from "./policy-dom.js";
import { createStatusBadge, updateStatusBadge } from "./status.js";

const FIELD_NAMES = Object.freeze({
  policy: "站点设置",
  max_concurrency: "最大并发数",
  retry_limit: "重试次数",
  backoff_base_seconds: "首次重试等待",
  proxy_mode: "连接方式",
});

const REASON_TEXT = Object.freeze({
  not_number: "需要填写数字",
  not_integer: "需要填写整数",
  empty_number: "不能留空",
  out_of_range: "超出允许范围",
  invalid_enum: "不是可选的连接方式",
  missing_field: "缺少必填内容",
  unknown_field: "包含不支持的项目",
  dangerous_key: "包含不安全的内容",
  invalid_value: "内容无效",
  request_too_large: "提交内容异常过大",
});

function setControl(button, model) {
  button.disabled = model.disabled;
  button.setAttribute("aria-disabled", String(model.disabled));
  button.textContent = model.label;
  button.title = model.reason || model.label;
  if (model.reason) button.dataset.disabledReason = model.reason;
  else delete button.dataset.disabledReason;
}

function validationText(validation) {
  if (validation.valid) return "";
  const field = FIELD_NAMES[validation.field] || "站点设置";
  const reason = REASON_TEXT[validation.reason] || "内容不正确";
  return `${field}：${reason}。`;
}

export function createPolicyView(context) {
  const { root, store } = context;
  const elements = buildPolicyDom(context);
  let busy = "";
  let selectedSite = POLICY_SITE_IDS[0];
  let renderedError = null;
  let formLoaded = false;
  let validationAnnounced = false;

  const currentSnapshot = () => store.getState().policy.config;
  const currentItem = () => currentSnapshot()?.bySite.get(selectedSite) || null;

  const clearError = () => {
    renderedError?.destroy();
    renderedError = null;
    elements.errorHost.replaceChildren();
  };

  const showError = (error) => {
    clearError();
    const guidance = policyErrorGuidance(error);
    renderedError = createErrorView({
      code: guidance.code,
      message: guidance.message,
      requestId: guidance.requestId,
      details: null,
    }, {
      statusLabel: guidance.title,
      nextStep: guidance.nextStep,
    });
    if (guidance.detail) {
      renderedError.element.append(createElement("p", {
        className: "policy-error-detail",
        text: guidance.detail,
      }));
    }
    elements.errorHost.replaceChildren(renderedError.element);
    renderFormState();
  };

  const setOperationMessage = (message) => {
    elements.operationLive.textContent = message;
  };

  const readDraft = () => ({
    max_concurrency: elements.fields.max_concurrency.value,
    retry_limit: elements.fields.retry_limit.value,
    backoff_base_seconds: elements.fields.backoff_base_seconds.value,
    proxy_mode: elements.fields.proxy_mode.value,
  });

  const currentValidation = () => {
    const item = currentItem();
    if (!formLoaded || !item?.editable || !item.policy) {
      return Object.freeze({
        valid: false,
        payload: null,
        field: "policy",
        index: null,
        reason: "invalid_value",
      });
    }
    return validatePolicyDraft(readDraft());
  };

  const dirty = () => {
    const item = currentItem();
    return Boolean(
      formLoaded
      && item?.editable
      && item.policy
      && isPolicyDirty(item.policy, readDraft())
    );
  };

  const renderBusyAttributes = () => {
    root.toggleAttribute("aria-busy", Boolean(busy));
    for (const button of root.querySelectorAll("[data-operation-kind]")) {
      if (!(button instanceof HTMLButtonElement)) continue;
      button.setAttribute(
        "aria-busy",
        String(Boolean(busy && button.dataset.operationKind === busy)),
      );
    }
  };

  const renderHeader = () => {
    const snapshot = currentSnapshot();
    if (!snapshot) {
      updateStatusBadge(elements.headerBadge, "disabled", "正在加载");
      return;
    }
    const items = [...snapshot.bySite.values()];
    const unavailable = items.filter((item) => !item.editable).length;
    const customized = items.filter((item) => item.hasOverride).length;
    if (unavailable) {
      updateStatusBadge(elements.headerBadge, "error", `${unavailable} 个站点暂时无法设置`);
    } else if (customized) {
      updateStatusBadge(elements.headerBadge, "running", `${customized} 个站点使用自定义设置`);
    } else {
      updateStatusBadge(elements.headerBadge, "ready", "全部使用默认设置");
    }
  };

  const renderSources = () => {
    const snapshot = currentSnapshot();
    const fragment = document.createDocumentFragment();
    for (const siteId of POLICY_SITE_IDS) {
      const definition = getPolicySiteDefinition(siteId);
      const item = snapshot?.bySite.get(siteId) || null;
      const model = formatPolicySource(item);
      const id = `policy-source-${siteId}`;
      const radio = createElement("input", {
        attributes: {
          id,
          type: "radio",
          name: "policy-source",
          value: siteId,
          "aria-describedby": "policy-source-help",
        },
        dataset: { policySite: siteId },
      });
      radio.checked = siteId === selectedSite;
      radio.disabled = Boolean(busy || !snapshot);
      const label = createElement("label", {
        className: "policy-source-option",
        attributes: { for: id },
        dataset: { policyState: model.badge.status },
      }, [
        radio,
        createElement("span", {
          className: "policy-source-mark",
          text: definition.mark,
          attributes: { "aria-hidden": "true" },
        }),
        createElement("span", { className: "policy-source-copy" }, [
          createElement("strong", { text: definition.label }),
          createElement("small", { text: model.policyState }),
        ]),
        createStatusBadge(model.badge.status, model.badge.label, { compact: true }),
      ]);
      fragment.append(label);
    }
    elements.sourceHost.replaceChildren(fragment);
    elements.sourceFieldset.disabled = Boolean(busy || !snapshot);
  };

  const setFormValues = (draft) => {
    for (const [name, element] of Object.entries(elements.fields)) {
      element.value = draft[name] ?? "";
      element.setAttribute("aria-invalid", "false");
    }
  };

  const clearDraft = () => {
    for (const element of Object.values(elements.fields)) {
      element.value = "";
      element.setAttribute("aria-invalid", "false");
    }
    formLoaded = false;
    validationAnnounced = false;
    elements.validation.textContent = "";
    elements.dirtyLive.dataset.dirty = "false";
    elements.dirtyLive.textContent = "所有更改均已保存。";
  };

  const loadSelectedDraft = () => {
    const item = currentItem();
    validationAnnounced = false;
    elements.editorHeading.textContent = item ? `${item.label} 设置` : "站点设置";
    if (!item?.editable || !item.policy) {
      clearDraft();
      renderFormState();
      return false;
    }
    setFormValues(policyConfigToDraft(item.policy));
    formLoaded = true;
    renderFormState();
    return true;
  };

  const renderValidation = (validation) => {
    for (const element of Object.values(elements.fields)) {
      element.setAttribute("aria-invalid", "false");
    }
    if (!validationAnnounced) {
      elements.validation.textContent = "";
      return;
    }
    elements.validation.textContent = validationText(validation);
    if (!validation.valid && elements.fields[validation.field]) {
      elements.fields[validation.field].setAttribute("aria-invalid", "true");
    }
  };

  const renderFormState = () => {
    const item = currentItem();
    const validation = currentValidation();
    const isDirty = dirty();
    const controls = derivePolicyControls(item, {
      busy,
      dirty: isDirty,
      valid: validation.valid,
    });
    setControl(elements.saveButton, controls.save);
    setControl(elements.resetButton, controls.reset);
    for (const input of Object.values(elements.fields)) {
      input.disabled = Boolean(busy || !item?.editable);
      input.setAttribute("aria-disabled", String(input.disabled));
    }
    elements.dirtyLive.dataset.dirty = String(isDirty);
    elements.dirtyLive.textContent = !formLoaded
      ? item?.hasOverride && !item.editable
        ? "该站点的自定义设置无法读取，可以恢复默认设置。"
        : "该站点设置暂时无法编辑。"
      : !validation.valid
        ? "请修正标记项。"
        : isDirty
          ? "有未保存的更改。"
          : item?.hasOverride
            ? "正在使用站点自定义设置。"
            : "正在使用默认设置。";
    renderValidation(validation);
    renderBusyAttributes();
  };

  const renderSnapshot = () => {
    const snapshot = currentSnapshot();
    if (snapshot && !snapshot.bySite.has(selectedSite)) selectedSite = POLICY_SITE_IDS[0];
    renderHeader();
    renderSources();
    loadSelectedDraft();
  };

  const unsubscribe = store.subscribe(selectors.policyConfig, renderSnapshot, {
    fireImmediately: true,
  });

  return Object.freeze({
    elements,
    getSelectedSite: () => selectedSite,
    getCurrentItem: currentItem,
    readDraft,
    validateDraft({ announce = false } = {}) {
      if (announce) validationAnnounced = true;
      const validation = currentValidation();
      renderFormState();
      return validation;
    },
    isDirty: dirty,
    selectSite(siteId) {
      if (!getPolicySiteDefinition(siteId)) throw new TypeError("站点无效");
      selectedSite = siteId;
      for (const radio of elements.sourceHost.querySelectorAll("[data-policy-site]")) {
        if (radio instanceof HTMLInputElement) radio.checked = radio.value === selectedSite;
      }
      loadSelectedDraft();
      elements.sourceHost.querySelector(`[data-policy-site="${siteId}"]`)
        ?.focus({ preventScroll: true });
    },
    restoreSourceSelection() {
      for (const radio of elements.sourceHost.querySelectorAll("[data-policy-site]")) {
        if (radio instanceof HTMLInputElement) radio.checked = radio.value === selectedSite;
      }
    },
    focusAfterOperation(action) {
      const preferred = action === "save" ? elements.saveButton : elements.resetButton;
      if (preferred instanceof HTMLButtonElement && !preferred.disabled) {
        preferred.focus({ preventScroll: true });
        return;
      }
      elements.sourceHost.querySelector(`[data-policy-site="${selectedSite}"]`)
        ?.focus({ preventScroll: true });
    },
    reloadDraft() {
      return loadSelectedDraft();
    },
    restoreDraft(draft) {
      const item = currentItem();
      if (!item?.editable || !item.policy || !draft || typeof draft !== "object") return false;
      setFormValues(draft);
      formLoaded = true;
      validationAnnounced = true;
      renderFormState();
      return true;
    },
    clearDraft,
    clearError,
    showError,
    setOperationMessage,
    setBusy(kind) {
      busy = kind;
      renderSources();
      renderFormState();
    },
    renderDraftState({ announce = false } = {}) {
      if (announce) validationAnnounced = true;
      renderFormState();
    },
    destroy() {
      clearDraft();
      unsubscribe();
      clearError();
      root.replaceChildren();
      root.removeAttribute("aria-busy");
    },
  });
}
