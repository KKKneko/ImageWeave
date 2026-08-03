import { createElement } from "../core/dom.js";
import { createStatusBadge } from "./status.js";

export function policyButton(action, label, pendingLabel = label, {
  primary = false,
  dangerous = false,
  type = "button",
} = {}) {
  return createElement("button", {
    className: [
      "policy-button",
      primary ? "policy-button--primary" : "",
      dangerous ? "policy-button--dangerous" : "",
    ].filter(Boolean).join(" "),
    text: label,
    attributes: { type },
    dataset: {
      policyAction: action,
      operationKind: action,
      defaultLabel: label,
      pendingLabel,
    },
  });
}

function fieldHelp(id, text) {
  return createElement("p", {
    className: "policy-field-help",
    text,
    attributes: { id },
  });
}

function numericField({ id, name, label, min, max, step = "1", help }) {
  const helpId = `${id}-help`;
  const input = createElement("input", {
    attributes: {
      id,
      name,
      type: "number",
      min: String(min),
      max: String(max),
      step,
      required: "",
      inputmode: step === "1" ? "numeric" : "decimal",
      "aria-describedby": `${helpId} policy-validation policy-error-host`,
      "aria-errormessage": "policy-validation",
    },
    dataset: { policyField: name },
  });
  return {
    input,
    element: createElement("div", { className: "policy-field" }, [
      createElement("label", { text: label, attributes: { for: id } }),
      input,
      fieldHelp(helpId, help),
    ]),
  };
}

export function buildPolicyDom(context) {
  const { root, app } = context;
  const headingId = "policy-heading";
  const headerBadge = createStatusBadge("disabled", "正在加载");
  const operationLive = createElement("p", {
    className: "policy-operation-live",
    text: "正在加载站点设置……",
    attributes: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
  });
  const errorHost = createElement("div", {
    className: "policy-error-host",
    attributes: { id: "policy-error-host", "aria-live": "assertive" },
  });

  const sourceHost = createElement("div", { className: "policy-source-options" });
  const sourceFieldset = createElement("fieldset", { className: "policy-source-fieldset" }, [
    createElement("legend", { text: "选择站点" }),
    createElement("p", {
      className: "policy-field-help",
      text: "选择要配置的站点。",
      attributes: { id: "policy-source-help" },
    }),
    sourceHost,
  ]);

  const maxConcurrency = numericField({
    id: "policy-max-concurrency",
    name: "max_concurrency",
    label: "最大并发数",
    min: 1,
    max: 128,
    help: "范围：1–128。实际并发数还受系统总上限限制。",
  });
  const retryLimit = numericField({
    id: "policy-retry-limit",
    name: "retry_limit",
    label: "重试次数",
    min: 0,
    max: 20,
    help: "范围：0–20。0 表示不自动重试。",
  });
  const backoff = numericField({
    id: "policy-backoff-base",
    name: "backoff_base_seconds",
    label: "首次重试等待",
    min: 0,
    max: 3600,
    step: "0.1",
    help: "首次重试前的等待时间；后续间隔会随连续失败增加。",
  });
  const proxyMode = createElement("select", {
    attributes: {
      id: "policy-proxy-mode",
      name: "proxy_mode",
      "aria-describedby": "policy-proxy-mode-help policy-validation policy-error-host",
      "aria-errormessage": "policy-validation",
    },
    dataset: { policyField: "proxy_mode" },
  }, [
    createElement("option", { text: "直连", attributes: { value: "direct" } }),
    createElement("option", {
      text: "优先代理（不可用时直连）",
      attributes: { value: "prefer" },
    }),
    createElement("option", {
      text: "仅代理（不可用时失败）",
      attributes: { value: "required" },
    }),
  ]);
  const proxyModeField = createElement("div", { className: "policy-field" }, [
    createElement("label", { text: "连接方式", attributes: { for: "policy-proxy-mode" } }),
    proxyMode,
    fieldHelp(
      "policy-proxy-mode-help",
      "单次搜索或批次中的设置优先于此处。",
    ),
  ]);

  const validation = createElement("p", {
    className: "policy-validation",
    attributes: { id: "policy-validation", role: "alert", "aria-live": "assertive" },
  });
  const dirtyLive = createElement("p", {
    className: "policy-dirty-live",
    text: "设置正在加载。",
    attributes: {
      id: "policy-dirty-state",
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
    },
  });

  const saveButton = policyButton("save", "保存设置", "正在保存…", {
    primary: true,
    type: "submit",
  });
  saveButton.removeAttribute("data-policy-action");
  const resetButton = policyButton("reset", "恢复默认设置", "正在恢复…", {
    dangerous: true,
  });
  for (const button of [saveButton, resetButton]) {
    button.setAttribute("aria-describedby", "policy-dirty-state policy-validation");
  }

  const editorHeading = createElement("h2", {
    text: "站点设置",
    attributes: { id: "policy-editor-heading" },
  });
  const form = createElement("form", {
    className: "policy-form",
    attributes: {
      autocomplete: "off",
      novalidate: "",
      "aria-labelledby": "policy-editor-heading",
    },
    dataset: { policyForm: "site" },
  }, [
    createElement("div", { className: "policy-field-grid" }, [
      maxConcurrency.element,
      retryLimit.element,
      backoff.element,
      proxyModeField,
    ]),
    validation,
    dirtyLive,
    createElement("div", { className: "policy-form-actions" }, [
      saveButton,
      resetButton,
    ]),
  ]);

  const settingsSection = createElement("section", {
    className: "policy-panel policy-settings-panel",
    attributes: { "aria-labelledby": "policy-sites-heading" },
  }, [
    createElement("h2", { text: "站点", attributes: { id: "policy-sites-heading" } }),
    sourceFieldset,
    createElement("div", { className: "policy-editor-heading" }, [
      editorHeading,
      createElement("p", {
        text: "保存后仅影响新建的搜索和采集任务。",
      }),
    ]),
    form,
  ]);

  root.classList.add("app-view", "policy-app");
  root.setAttribute("aria-labelledby", headingId);
  root.replaceChildren(
    createElement("header", { className: "app-header policy-app-header" }, [
      createElement("p", { className: "app-executable", text: app.windowTitle }),
      createElement("h1", { text: app.label, attributes: { id: headingId } }),
      headerBadge,
      createElement("p", {
        className: "app-summary",
        text: "为各站点设置并发数、重试策略和连接方式。",
      }),
    ]),
    operationLive,
    errorHost,
    settingsSection,
  );

  return {
    headerBadge,
    operationLive,
    errorHost,
    sourceHost,
    sourceFieldset,
    editorHeading,
    form,
    fields: {
      max_concurrency: maxConcurrency.input,
      retry_limit: retryLimit.input,
      backoff_base_seconds: backoff.input,
      proxy_mode: proxyMode,
    },
    validation,
    dirtyLive,
    saveButton,
    resetButton,
  };
}
