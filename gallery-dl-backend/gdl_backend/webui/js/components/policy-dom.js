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

export function policyDefinitionList(items, className = "policy-definition-list") {
  const list = createElement("dl", { className });
  for (const [term, value] of items) {
    list.append(createElement("div", {}, [
      createElement("dt", { text: term }),
      createElement("dd", { text: value }),
    ]));
  }
  return list;
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

function textareaField({ id, name, label, rows, maxlength, help }) {
  const helpId = `${id}-help`;
  const input = createElement("textarea", {
    attributes: {
      id,
      name,
      rows: String(rows),
      maxlength: String(maxlength),
      spellcheck: "false",
      autocomplete: "off",
      autocapitalize: "none",
      "aria-describedby": `${helpId} policy-validation policy-error-host`,
      "aria-errormessage": "policy-validation",
    },
    dataset: { policyField: name },
  });
  return {
    input,
    element: createElement("div", { className: "policy-field policy-field--wide" }, [
      createElement("label", { text: label, attributes: { for: id } }),
      input,
      fieldHelp(helpId, help),
    ]),
  };
}

export function buildPolicyDom(context) {
  const { root, app } = context;
  const headingId = "policy-heading";
  const headerBadge = createStatusBadge("disabled", "站点策略待加载");
  const operationLive = createElement("p", {
    className: "policy-operation-live",
    text: "等待操作。",
    attributes: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
  });
  const errorHost = createElement("div", {
    className: "policy-error-host",
    attributes: { id: "policy-error-host", "aria-live": "assertive" },
  });
  const warningHost = createElement("div", {
    className: "policy-warning-host",
    attributes: { "aria-live": "polite" },
  });

  const contractSection = createElement("section", {
    className: "policy-panel policy-contract-panel",
    attributes: { "aria-labelledby": "policy-contract-heading" },
  }, [
    createElement("h2", { text: "真实契约边界", attributes: { id: "policy-contract-heading" } }),
    policyDefinitionList([
      ["作用时机", "保存后供后续新搜索、新建任务和新规划读取；已创建/运行任务保留原快照"],
      ["默认来源", "进程启动时由内置常量与 config 合并；外部改 config 不会热重载"],
      ["持久化", "单个站点覆盖写入私有 SQLite 事务；恢复默认即删除该行"],
      ["并发语义", "后端没有 revision / ETag；多个客户端最后完成的写入生效"],
    ], "policy-contract-list"),
    createElement("p", {
      className: "policy-scope-note",
      text: "POLICY 不启用/关闭来源，也不执行远端登录或可用性探测。来源勾选、排序、每请求路由，以及 EH 标签 include/exclude 过滤仍属于 CRAWL.EXE（阶段 5）。",
    }),
    warningHost,
  ]);

  const sourceHost = createElement("div", { className: "policy-source-options" });
  const sourceFieldset = createElement("fieldset", { className: "policy-source-fieldset" }, [
    createElement("legend", { text: "选择要编辑的后端来源策略" }),
    createElement("p", {
      className: "policy-field-help",
      text: "这里选择配置对象，不改变搜索来源启用状态或执行顺序。",
      attributes: { id: "policy-source-help" },
    }),
    sourceHost,
  ]);
  const sourceSummaryHost = createElement("div", { className: "policy-source-summary" });
  const vaultButton = policyButton("vault", "打开 VAULT.CPL");
  vaultButton.setAttribute("aria-describedby", "policy-source-auth-note");
  const sourceAuthNote = createElement("p", {
    className: "policy-field-help",
    text: "授权状态只在 VAULT.CPL 查看；POLICY 不读取 Auth Store、会话或秘密。",
    attributes: { id: "policy-source-auth-note" },
  });
  const sourcesSection = createElement("section", {
    className: "policy-panel policy-sources-panel",
    attributes: { "aria-labelledby": "policy-sources-heading" },
  }, [
    createElement("div", { className: "policy-panel-heading" }, [
      createElement("div", {}, [
        createElement("h2", { text: "来源与策略状态", attributes: { id: "policy-sources-heading" } }),
        createElement("p", { text: "“支持”“请求选择”“授权材料”“当前可用”是四个不同概念。" }),
      ]),
      vaultButton,
    ]),
    sourceFieldset,
    sourceSummaryHost,
    sourceAuthNote,
  ]);

  const maxConcurrency = numericField({
    id: "policy-max-concurrency",
    name: "max_concurrency",
    label: "站点最大并发",
    min: 1,
    max: 128,
    help: "调度器同时运行该站点任务的上限；还受全局 scheduler 上限约束。",
  });
  const retryLimit = numericField({
    id: "policy-retry-limit",
    name: "retry_limit",
    label: "后端重试次数",
    min: 0,
    max: 20,
    help: "总尝试预算通常为重试次数 + 1；新任务创建时固化。",
  });
  const backoff = numericField({
    id: "policy-backoff-base",
    name: "backoff_base_seconds",
    label: "指数退避基数（秒）",
    min: 0,
    max: 3600,
    step: "0.1",
    help: "0 表示不等待；调度器仍应用其全局退避上限与抖动。",
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
    createElement("option", { text: "直连（direct）", attributes: { value: "direct" } }),
    createElement("option", { text: "优先代理，可降级直连（prefer）", attributes: { value: "prefer" } }),
    createElement("option", { text: "必须代理（required）", attributes: { value: "required" } }),
  ]);
  const proxyModeField = createElement("div", { className: "policy-field" }, [
    createElement("label", { text: "默认代理模式", attributes: { for: "policy-proxy-mode" } }),
    proxyMode,
    fieldHelp("policy-proxy-mode-help", "仅在请求没有显式 proxy_mode 时使用；不启动或重载 PROXY.CPL。"),
  ]);

  const probeUrl = createElement("input", {
    attributes: {
      id: "policy-probe-url",
      name: "probe_url",
      type: "url",
      inputmode: "url",
      maxlength: "2048",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "留空表示使用代理池默认探活目标",
      "aria-describedby": "policy-probe-url-help policy-validation policy-error-host",
      "aria-errormessage": "policy-validation",
    },
    dataset: { policyField: "probe_url" },
  });
  const probeBeforeUse = createElement("input", {
    attributes: {
      id: "policy-probe-before-use",
      name: "probe_before_use",
      type: "checkbox",
      "aria-describedby": "policy-probe-before-use-help",
    },
    dataset: { policyField: "probe_before_use" },
  });
  const nodeTags = textareaField({
    id: "policy-node-tags",
    name: "node_tags",
    label: "代理节点标签（每行一个）",
    rows: 4,
    maxlength: 2080,
    help: "最多 32 项、每项 64 个 Unicode 字符；后端 trim、转小写并稳定去重。匹配语义是任一标签命中，不提供优先级或排序。",
  });

  const httpTimeout = numericField({
    id: "policy-http-timeout",
    name: "http_timeout",
    label: "HTTP 超时（秒）",
    min: 1,
    max: 3600,
    step: "0.1",
    help: "传给站点 API 请求及 gallery-dl --http-timeout。",
  });
  const galleryRetries = numericField({
    id: "policy-gallery-retries",
    name: "gallery_retries",
    label: "gallery-dl 内部重试",
    min: 0,
    max: 50,
    help: "传给 gallery-dl --retries；与后端任务尝试预算是不同层级。",
  });
  const taskTimeout = numericField({
    id: "policy-task-timeout",
    name: "task_timeout_seconds",
    label: "任务总超时（秒）",
    min: 0,
    max: 604800,
    step: "0.1",
    help: "0 表示禁用总超时；只影响后续新任务快照。",
  });
  const stallTimeout = numericField({
    id: "policy-stall-timeout",
    name: "download_stall_timeout_seconds",
    label: "EH 无进展超时（秒）",
    min: 0,
    max: 604800,
    step: "0.1",
    help: "仅 EH 图片任务使用；0 表示禁用。它不是 EH 标签筛选规则。",
  });
  const extraArgs = textareaField({
    id: "policy-extra-args",
    name: "extra_args",
    label: "额外 gallery-dl argv（每行一个参数）",
    rows: 6,
    maxlength: "8192",
    help: "最多 128 项、单项 512 字符、总计 8192 字符；完整策略 JSON 另限 16 KiB UTF-8。纯空行过滤，顺序与重复项原样保留。后端拒绝其托管参数，POLICY 另拒绝 URL、绝对路径、控制字符和疑似秘密赋值。",
  });

  const ehPreservedHost = createElement("div", {
    className: "policy-preserved-field",
    attributes: { id: "policy-eh-preserved", role: "note" },
  });
  const validation = createElement("p", {
    className: "policy-validation",
    attributes: { id: "policy-validation", role: "alert", "aria-live": "assertive" },
  });
  const dirtyLive = createElement("p", {
    className: "policy-dirty-live",
    text: "表单状态待加载。",
    attributes: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
  });

  const saveButton = policyButton("save", "保存站点覆盖", "正在保存…", {
    primary: true,
    type: "submit",
  });
  saveButton.removeAttribute("data-policy-action");
  const discardButton = policyButton("discard", "放弃未保存更改");
  const resetButton = policyButton("reset", "恢复启动默认", "正在恢复…", { dangerous: true });
  const refreshButton = policyButton("refresh", "手动刷新", "正在刷新…");
  const actionReasons = createElement("ul", {
    className: "policy-action-reasons",
    attributes: { id: "policy-action-reasons", "aria-live": "polite" },
  });
  for (const button of [saveButton, discardButton, resetButton, refreshButton]) {
    button.setAttribute("aria-describedby", "policy-action-reasons policy-dirty-state");
  }

  const form = createElement("form", {
    className: "policy-form",
    attributes: { autocomplete: "off", novalidate: "", "aria-labelledby": "policy-editor-heading" },
    dataset: { policyForm: "site" },
  }, [
    createElement("fieldset", { className: "policy-fieldset" }, [
      createElement("legend", { text: "调度与路由" }),
      createElement("div", { className: "policy-field-grid" }, [
        maxConcurrency.element,
        retryLimit.element,
        backoff.element,
        proxyModeField,
      ]),
    ]),
    createElement("fieldset", { className: "policy-fieldset" }, [
      createElement("legend", { text: "代理探活与节点约束" }),
      createElement("div", { className: "policy-field-grid" }, [
        createElement("div", { className: "policy-field policy-field--wide" }, [
          createElement("label", { text: "HTTPS 探活地址", attributes: { for: "policy-probe-url" } }),
          probeUrl,
          fieldHelp("policy-probe-url-help", "只接受无凭据、query、fragment 的公共 HTTPS 地址；保存不会主动发起探活。"),
        ]),
        createElement("div", { className: "policy-field policy-checkbox-field" }, [
          createElement("label", { attributes: { for: "policy-probe-before-use" } }, [
            probeBeforeUse,
            createElement("span", { text: "租用节点前执行探活" }),
          ]),
          fieldHelp("policy-probe-before-use-help", "仅在后续请求租用代理节点时执行，不是 POLICY 定时网络探测。"),
        ]),
        nodeTags.element,
      ]),
    ]),
    createElement("fieldset", { className: "policy-fieldset" }, [
      createElement("legend", { text: "超时与 gallery-dl" }),
      createElement("div", { className: "policy-field-grid" }, [
        httpTimeout.element,
        galleryRetries.element,
        taskTimeout.element,
        stallTimeout.element,
      ]),
      ehPreservedHost,
      extraArgs.element,
    ]),
    validation,
    dirtyLive,
    createElement("div", { className: "policy-form-actions" }, [
      saveButton,
      discardButton,
      resetButton,
      refreshButton,
    ]),
    actionReasons,
  ]);

  const editorSection = createElement("section", {
    className: "policy-panel policy-editor-panel",
    attributes: { "aria-labelledby": "policy-editor-heading" },
  }, [
    createElement("div", { className: "policy-panel-heading" }, [
      createElement("div", {}, [
        createElement("h2", { text: "站点覆盖编辑器", attributes: { id: "policy-editor-heading" } }),
        createElement("p", {
          text: "草稿仅存在于当前应用 DOM/控制器；不会进入中央 Store、Storage、URL、通知或 diagnostics。",
        }),
      ]),
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
        text: "管理后端五个聚合来源的站点运行策略，并清楚区分启动默认、SQLite 覆盖与每请求选择。",
      }),
    ]),
    operationLive,
    errorHost,
    contractSection,
    sourcesSection,
    editorSection,
  );

  return {
    headerBadge,
    operationLive,
    errorHost,
    warningHost,
    sourceHost,
    sourceFieldset,
    sourceSummaryHost,
    vaultButton,
    editorSection,
    form,
    fields: {
      max_concurrency: maxConcurrency.input,
      retry_limit: retryLimit.input,
      backoff_base_seconds: backoff.input,
      proxy_mode: proxyMode,
      probe_url: probeUrl,
      probe_before_use: probeBeforeUse,
      node_tags: nodeTags.input,
      http_timeout: httpTimeout.input,
      gallery_retries: galleryRetries.input,
      task_timeout_seconds: taskTimeout.input,
      download_stall_timeout_seconds: stallTimeout.input,
      extra_args: extraArgs.input,
    },
    ehPreservedHost,
    validation,
    dirtyLive,
    saveButton,
    discardButton,
    resetButton,
    refreshButton,
    actionReasons,
  };
}
