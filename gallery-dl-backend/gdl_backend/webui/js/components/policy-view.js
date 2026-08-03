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
import { createEmptyState } from "./empty-state.js";
import { createErrorView } from "./error-view.js";
import { buildPolicyDom, policyDefinitionList } from "./policy-dom.js";
import { createStatusBadge, updateStatusBadge } from "./status.js";

const FIELD_NAMES = Object.freeze({
  policy: "策略",
  max_concurrency: "站点最大并发",
  retry_limit: "后端重试次数",
  backoff_base_seconds: "退避基数",
  proxy_mode: "默认代理模式",
  probe_url: "HTTPS 探活地址",
  probe_before_use: "使用前探活",
  node_tags: "节点标签",
  http_timeout: "HTTP 超时",
  gallery_retries: "gallery-dl 重试",
  task_timeout_seconds: "任务总超时",
  download_stall_timeout_seconds: "EH 无进展超时",
  eh_download: "EH 下载默认值",
  extra_args: "额外 gallery-dl 参数",
});

const REASON_TEXT = Object.freeze({
  not_text: "必须是文本",
  control_characters: "不能包含控制字符或空白 URL",
  too_long: "单项超过长度上限",
  too_many_items: "项目数量超过上限",
  total_too_large: "全部项目总长度超过上限",
  request_too_large: "完整策略 JSON 的 UTF-8 大小超过 16 KiB",
  absolute_path: "不能包含绝对路径",
  url_not_allowed: "此字段不能包含 URL",
  url_credentials: "探活 URL 不能包含用户名或密码",
  url_query_or_fragment: "探活 URL 不能包含 query 或 fragment",
  url_host_invalid: "必须是包含有效公共主机的 HTTPS URL",
  url_target_forbidden: "不能指向本机、私有地址或 .local 主机",
  sensitive_assignment: "不能包含疑似凭据赋值",
  not_number: "必须是有限数字",
  not_integer: "必须是整数",
  empty_number: "不能为空",
  out_of_range: "超出后端允许范围",
  invalid_enum: "枚举值不受后端支持",
  not_list: "逐行字段格式无效",
  missing_field: "缺少必需字段",
  dangerous_key: "包含危险对象键",
  invalid_value: "值无效",
});

function setControl(button, model) {
  button.disabled = model.disabled;
  button.setAttribute("aria-disabled", String(model.disabled));
  button.textContent = model.label;
  if (model.reason) button.dataset.disabledReason = model.reason;
  else delete button.dataset.disabledReason;
}

function validationText(validation) {
  if (validation.valid) {
    return validation.duplicateNodeTags
      ? `已按后端语义稳定去除 ${validation.duplicateNodeTags} 个重复节点标签；首次出现顺序保留。`
      : "";
  }
  const field = FIELD_NAMES[validation.field] || "策略字段";
  const index = validation.index === null ? "" : `第 ${validation.index + 1} 行：`;
  const reason = REASON_TEXT[validation.reason] || `原因 ${validation.reason}`;
  return `${field}：${index}${reason}。`;
}

export function createPolicyView(context) {
  const { root, store } = context;
  const elements = buildPolicyDom(context);
  let busy = "";
  let conflict = false;
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
    if (guidance.conflict) conflict = true;
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

  const readDraft = () => {
    const item = currentItem();
    const fields = elements.fields;
    return {
      max_concurrency: fields.max_concurrency.value,
      retry_limit: fields.retry_limit.value,
      backoff_base_seconds: fields.backoff_base_seconds.value,
      proxy_mode: fields.proxy_mode.value,
      probe_url: fields.probe_url.value,
      probe_before_use: fields.probe_before_use.checked,
      node_tags: fields.node_tags.value,
      http_timeout: fields.http_timeout.value,
      gallery_retries: fields.gallery_retries.value,
      task_timeout_seconds: fields.task_timeout_seconds.value,
      download_stall_timeout_seconds: fields.download_stall_timeout_seconds.value,
      eh_download: item?.policy?.eh_download
        ? { ...item.policy.eh_download }
        : null,
      extra_args: fields.extra_args.value,
    };
  };

  const currentValidation = () => {
    const item = currentItem();
    if (!formLoaded || !item?.editable || !item.policy) {
      return Object.freeze({
        valid: false,
        payload: null,
        field: "policy",
        index: null,
        reason: "invalid_value",
        duplicateNodeTags: 0,
      });
    }
    return validatePolicyDraft(readDraft());
  };

  const dirty = () => {
    const item = currentItem();
    return Boolean(formLoaded && item?.editable && item.policy && isPolicyDirty(item.policy, readDraft()));
  };

  const renderBusyAttributes = () => {
    root.toggleAttribute("aria-busy", Boolean(busy));
    for (const button of root.querySelectorAll("[data-operation-kind]")) {
      if (!(button instanceof HTMLButtonElement)) continue;
      button.setAttribute("aria-busy", String(Boolean(busy && button.dataset.operationKind === busy)));
    }
  };

  const renderHeader = () => {
    const snapshot = currentSnapshot();
    if (!snapshot) {
      updateStatusBadge(elements.headerBadge, "disabled", "站点策略待加载");
      return;
    }
    const items = [...snapshot.bySite.values()];
    const readOnly = items.filter((item) => !item.editable).length;
    const overrides = items.filter((item) => item.hasOverride).length;
    if (readOnly) updateStatusBadge(elements.headerBadge, "error", `${readOnly} 个来源策略只读`);
    else if (overrides) updateStatusBadge(elements.headerBadge, "running", `${overrides} 个站点覆盖生效`);
    else updateStatusBadge(elements.headerBadge, "ready", "全部来源继承启动默认");
  };

  const renderWarnings = () => {
    const snapshot = currentSnapshot();
    const notices = [];
    if (snapshot?.unknownOverrideCount) {
      notices.push(createElement("section", {
        className: "policy-contract-warning",
        attributes: { role: "status" },
      }, [
        createStatusBadge("warning", "存在未知站点覆盖"),
        createElement("p", {
          text: `后端还有 ${snapshot.unknownOverrideCount} 个不属于五个聚合来源的覆盖；POLICY 不显示 ID、不读取内容，也不会回写它们。`,
        }),
      ]));
    }
    if (snapshot?.concurrencyProtection === "none") {
      notices.push(createElement("section", { className: "policy-contract-warning" }, [
        createStatusBadge("warning", "无跨客户端冲突令牌"),
        createElement("p", {
          text: "读取世代门只能阻止本页旧 GET 覆盖新保存；它不是 ETag/revision，多个客户端仍是最后完成的写入生效。",
        }),
      ]));
    }
    elements.warningHost.replaceChildren(...notices);
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
          checked: siteId === selectedSite ? "" : null,
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

  const renderSourceSummary = () => {
    const item = currentItem();
    if (!item) {
      elements.sourceSummaryHost.replaceChildren(createEmptyState({
        label: "等待策略",
        title: "来源能力尚未加载",
        message: "POLICY 激活后读取一次后端安全投影。",
      }));
      elements.vaultButton.hidden = true;
      return;
    }
    const model = formatPolicySource(item);
    elements.sourceSummaryHost.replaceChildren(
      createStatusBadge(model.badge.status, model.badge.label),
      policyDefinitionList([
        ["后端支持", model.support],
        ["当前启用", model.enablement],
        ["授权要求", model.authorization],
        ["当前可用", model.availability],
        ["策略来源", model.policyState],
        ["覆盖更新时间", model.updatedAt],
      ]),
    );
    elements.vaultButton.hidden = item.authorization === "anonymous";
  };

  const setFormValues = (draft) => {
    for (const [name, element] of Object.entries(elements.fields)) {
      if (name === "probe_before_use") element.checked = Boolean(draft[name]);
      else element.value = draft[name] ?? "";
      element.setAttribute("aria-invalid", "false");
    }
  };

  const clearDraft = () => {
    for (const [name, element] of Object.entries(elements.fields)) {
      if (name === "probe_before_use") element.checked = false;
      else element.value = "";
      element.setAttribute("aria-invalid", "false");
    }
    formLoaded = false;
    validationAnnounced = false;
    elements.validation.textContent = "";
    elements.dirtyLive.dataset.dirty = "false";
    elements.dirtyLive.textContent = "草稿已从当前应用清除。";
  };

  const renderPreservedEh = (item) => {
    if (!item?.policy) {
      elements.ehPreservedHost.replaceChildren();
      return;
    }
    const value = item.policy.eh_download;
    const description = value
      ? `当前后端值为 ${value.image_mode} + ${value.gp_policy}；保存其他字段时会原样保留。`
      : "当前后端值为 null；保存其他字段时继续保留 null。";
    elements.ehPreservedHost.replaceChildren(
      createStatusBadge("disabled", "阶段 5 每请求控件"),
      createElement("p", {
        text: `${description} 4B 不把旧 UI 的 EH 图片版本/GP 选择迁入 POLICY。`,
      }),
    );
  };

  const loadSelectedDraft = () => {
    const item = currentItem();
    validationAnnounced = false;
    conflict = false;
    if (!item?.editable || !item.policy) {
      clearDraft();
      renderPreservedEh(item);
      renderFormState();
      return false;
    }
    setFormValues(policyConfigToDraft(item.policy));
    formLoaded = true;
    renderPreservedEh(item);
    renderFormState();
    return true;
  };

  const renderValidation = (validation) => {
    for (const element of Object.values(elements.fields)) element.setAttribute("aria-invalid", "false");
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
      conflict,
    });
    setControl(elements.saveButton, controls.save);
    setControl(elements.discardButton, controls.discard);
    setControl(elements.resetButton, controls.reset);
    setControl(elements.refreshButton, controls.refresh);
    setControl(elements.vaultButton, controls.vault);
    for (const input of Object.values(elements.fields)) {
      input.disabled = Boolean(busy || !item?.editable);
      input.setAttribute("aria-disabled", String(input.disabled));
    }
    const reasons = [
      controls.save.reason,
      controls.reset.reason,
      controls.discard.reason,
    ].filter((reason, index, all) => reason && all.indexOf(reason) === index);
    elements.actionReasons.replaceChildren(
      ...(reasons.length
        ? reasons.map((reason) => createElement("li", { text: reason }))
        : [createElement("li", {
            text: "保存会建立完整站点覆盖；不会触发抓取、授权、代理重载或正在运行任务变更。",
          })]),
    );
    elements.dirtyLive.id = "policy-dirty-state";
    elements.dirtyLive.dataset.dirty = String(isDirty);
    elements.dirtyLive.textContent = !formLoaded
      ? item?.hasOverride && !item.editable
        ? "当前覆盖因安全值不可读取而只读；可确认后恢复启动默认。"
        : "当前来源没有可编辑草稿。"
      : !validation.valid
        ? "△ 未保存草稿含校验错误。离开、最小化或关闭 POLICY 将丢弃全部草稿。"
        : isDirty
          ? "△ 有未保存更改。离开、最小化或关闭 POLICY 将丢弃全部草稿。"
          : "✓ 表单与最后读取的服务器权威配置一致。";
    renderValidation(validation);
    renderBusyAttributes();
  };

  const renderSnapshot = () => {
    const snapshot = currentSnapshot();
    if (snapshot && !snapshot.bySite.has(selectedSite)) selectedSite = POLICY_SITE_IDS[0];
    renderHeader();
    renderWarnings();
    renderSources();
    renderSourceSummary();
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
      if (!getPolicySiteDefinition(siteId)) throw new TypeError("POLICY 来源无效");
      selectedSite = siteId;
      for (const radio of elements.sourceHost.querySelectorAll("[data-policy-site]")) {
        if (radio instanceof HTMLInputElement) radio.checked = radio.value === selectedSite;
      }
      renderSourceSummary();
      loadSelectedDraft();
      elements.sourceHost.querySelector(`[data-policy-site="${siteId}"]`)?.focus({ preventScroll: true });
    },
    restoreSourceSelection() {
      for (const radio of elements.sourceHost.querySelectorAll("[data-policy-site]")) {
        if (radio instanceof HTMLInputElement) radio.checked = radio.value === selectedSite;
      }
    },
    focusAfterOperation(action) {
      const preferred = {
        save: elements.saveButton,
        reset: elements.resetButton,
        refresh: elements.refreshButton,
        discard: elements.discardButton,
      }[action];
      if (preferred instanceof HTMLButtonElement && !preferred.disabled) {
        preferred.focus({ preventScroll: true });
        return;
      }
      elements.sourceHost.querySelector(`[data-policy-site="${selectedSite}"]`)
        ?.focus({ preventScroll: true });
    },
    discardDraft() {
      return loadSelectedDraft();
    },
    restoreDraft(draft) {
      const item = currentItem();
      if (!item?.editable || !item.policy || !draft || typeof draft !== "object") return false;
      setFormValues(draft);
      formLoaded = true;
      validationAnnounced = true;
      renderPreservedEh(item);
      renderFormState();
      return true;
    },
    clearDraft,
    clearError,
    showError,
    setOperationMessage,
    setConflict(value) {
      conflict = Boolean(value);
      renderFormState();
    },
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
