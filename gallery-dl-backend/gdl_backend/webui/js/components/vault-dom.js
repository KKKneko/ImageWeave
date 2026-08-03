import { createElement } from "../core/dom.js";
import { createIcon } from "./icons.js";
import { createStatusBadge } from "./status.js";

export function vaultButton(action, label, pendingLabel = label, {
  dangerous = false,
  primary = false,
  className = "",
} = {}) {
  return createElement("button", {
    className: [
      "vault-button",
      dangerous ? "vault-button--dangerous" : "",
      primary ? "vault-button--primary" : "",
      className,
    ].filter(Boolean).join(" "),
    text: label,
    attributes: { type: "button" },
    dataset: {
      vaultAction: action,
      operationKind: action,
      defaultLabel: label,
      pendingLabel,
    },
  });
}

export function vaultDefinitionList(items, className = "vault-definition-list") {
  const list = createElement("dl", { className });
  for (const [term, value] of items) {
    list.append(createElement("div", {}, [
      createElement("dt", { text: term }),
      createElement("dd", { text: value }),
    ]));
  }
  return list;
}

function securityBoundaryList() {
  const list = createElement("ul", { className: "vault-security-list" });
  for (const item of [
    "Cookie、Token 与 OAuth 回调只由后端私有目录管理，页面没有手工粘贴入口。",
    "授权代理输入只存在于当前密码控件和提交函数局部；提交、失败、取消或离开页面都会清空。",
    "“已配置”不等于远端验证成功；只有实际任务认证失败时，后端才会标记相应材料失效。",
  ]) {
    list.append(createElement("li", { text: item }));
  }
  return list;
}

export function buildVaultDom(context) {
  const { root, app } = context;
  const headingId = "vault-heading";
  const headerBadge = createStatusBadge("disabled", "授权状态待加载");
  const refreshButton = vaultButton("refresh", "刷新安全状态", "正在刷新…");
  const operationLive = createElement("p", {
    className: "vault-operation-live",
    text: "等待操作。",
    attributes: { role: "status", "aria-live": "polite", "aria-atomic": "true" },
  });
  const errorHost = createElement("div", {
    className: "vault-error-host",
    attributes: { id: "vault-error-host", "aria-live": "assertive" },
  });

  const siteHost = createElement("div", { className: "vault-site-grid" });
  const sitesSection = createElement("section", {
    className: "vault-panel vault-sites-panel",
    attributes: { "aria-labelledby": "vault-sites-heading" },
  }, [
    createElement("div", { className: "vault-panel-heading" }, [
      createElement("div", {}, [
        createElement("h2", { text: "授权目标概览", attributes: { id: "vault-sites-heading" } }),
        createElement("p", {
          text: "Danbooru 与 Pawchive 无需登录；X、Pixiv、EH 共用后端项目授权 Chrome。",
        }),
      ]),
      refreshButton,
    ]),
    siteHost,
  ]);

  const profileStatusHost = createElement("div", { className: "vault-profile-status" });
  const profileClearButton = vaultButton(
    "profile-clear",
    "清空共享 Profile",
    "正在清空…",
    { dangerous: true },
  );
  const profileReasons = createElement("p", {
    className: "vault-control-reason",
    attributes: { id: "vault-profile-reason", "aria-live": "polite" },
  });
  profileClearButton.setAttribute("aria-describedby", "vault-profile-impact vault-profile-reason");
  const profileSection = createElement("section", {
    className: "vault-panel vault-profile-panel",
    attributes: { "aria-labelledby": "vault-profile-heading" },
  }, [
    createElement("div", { className: "vault-panel-heading" }, [
      createElement("div", {}, [
        createElement("h2", { text: "共享授权浏览器 Profile", attributes: { id: "vault-profile-heading" } }),
        createElement("p", {
          text: "X、Pixiv 与 EH 共享同一份项目专属 Profile；不会读取日常浏览器资料。",
        }),
      ]),
      profileClearButton,
    ]),
    createElement("p", {
      className: "vault-impact-note",
      text: "清空 Profile 会关闭活动授权会话并删除浏览器登录状态，但不会删除已经导出的单站 Cookie 或 Pixiv Token。",
      attributes: { id: "vault-profile-impact" },
    }),
    profileReasons,
    profileStatusHost,
  ]);

  const proxyStatusHost = createElement("div", { className: "vault-proxy-status" });
  const proxyInput = createElement("input", {
    className: "vault-secret-input",
    attributes: {
      id: "vault-proxy-input",
      name: "authorization-proxy-replacement",
      type: "password",
      maxlength: "300",
      autocomplete: "new-password",
      spellcheck: "false",
      autocapitalize: "none",
      inputmode: "url",
      placeholder: "输入完整新代理；留空表示直连",
      "aria-describedby": "vault-proxy-help vault-proxy-validation vault-error-host",
      "aria-errormessage": "vault-proxy-validation",
    },
    dataset: { vaultSecret: "" },
  });
  const revealButton = vaultButton("proxy-reveal", "显示代理输入", "显示代理输入", {
    className: "vault-button--reveal",
  });
  revealButton.removeAttribute("data-operation-kind");
  revealButton.setAttribute("aria-controls", "vault-proxy-input");
  revealButton.setAttribute("aria-pressed", "false");
  revealButton.setAttribute("aria-label", "显示授权代理输入");

  const proxyValidation = createElement("p", {
    className: "vault-field-error",
    attributes: { id: "vault-proxy-validation", role: "alert" },
  });
  const proxySaveButton = vaultButton(
    "proxy-save",
    "保存新代理 / 设置直连",
    "正在保存…",
    { primary: true },
  );
  proxySaveButton.type = "submit";
  proxySaveButton.removeAttribute("data-vault-action");
  const proxyResetButton = vaultButton(
    "proxy-reset",
    "恢复 config 默认",
    "正在恢复…",
    { dangerous: true },
  );
  const proxyReasons = createElement("p", {
    className: "vault-control-reason",
    attributes: { id: "vault-proxy-reason", "aria-live": "polite" },
  });
  proxySaveButton.setAttribute("aria-describedby", "vault-proxy-help vault-proxy-reason");
  proxyResetButton.setAttribute("aria-describedby", "vault-proxy-reset-help vault-proxy-reason");

  const proxyForm = createElement("form", {
    className: "vault-proxy-form",
    attributes: { autocomplete: "off", novalidate: "" },
    dataset: { vaultForm: "proxy" },
  }, [
    createElement("fieldset", {}, [
      createElement("legend", { text: "替换授权专用代理" }),
      createElement("label", {
        text: "完整代理地址",
        attributes: { for: "vault-proxy-input" },
      }),
      createElement("div", { className: "vault-secret-row" }, [proxyInput, revealButton]),
      createElement("p", {
        className: "vault-field-help",
        text: "支持 http、https、socks4、socks5、socks5h，必须带显式端口且不能含路径/query/fragment。HTTP(S) 可含凭据；SOCKS 不可含凭据。旧值永不回填，留空提交会建立“运行时直连”覆盖。",
        attributes: { id: "vault-proxy-help" },
      }),
      proxyValidation,
      createElement("div", { className: "vault-form-actions" }, [
        proxySaveButton,
        proxyResetButton,
      ]),
      createElement("p", {
        className: "vault-field-help",
        text: "恢复 config 默认会删除界面运行时覆盖；它与提交空值形成的“运行时直连”不同。",
        attributes: { id: "vault-proxy-reset-help" },
      }),
      proxyReasons,
    ]),
  ]);

  const proxySection = createElement("section", {
    className: "vault-panel vault-proxy-panel",
    attributes: { "aria-labelledby": "vault-proxy-heading" },
  }, [
    createElement("div", { className: "vault-panel-heading" }, [
      createElement("div", {}, [
        createElement("h2", { text: "授权专用代理", attributes: { id: "vault-proxy-heading" } }),
        createElement("p", {
          text: "仅用于共享授权 Chrome 与 Pixiv Token 交换；和抓取代理池完全独立。",
        }),
      ]),
      createIcon("network", { size: 28, strokeWidth: 1.8, className: "vault-panel-icon" }),
    ]),
    proxyStatusHost,
    proxyForm,
  ]);

  const boundarySection = createElement("section", {
    className: "vault-panel vault-boundary-panel",
    attributes: { "aria-labelledby": "vault-boundary-heading" },
  }, [
    createElement("div", { className: "vault-panel-heading" }, [
      createElement("h2", { text: "秘密边界", attributes: { id: "vault-boundary-heading" } }),
      createIcon("key", { size: 28, strokeWidth: 1.8, className: "vault-panel-icon" }),
    ]),
    securityBoundaryList(),
  ]);

  root.classList.add("app-view", "vault-app");
  root.setAttribute("aria-labelledby", headingId);
  root.replaceChildren(
    createElement("header", { className: "app-header vault-app-header" }, [
      createElement("p", { className: "app-executable", text: app.windowTitle }),
      createElement("h1", { text: app.label, attributes: { id: headingId } }),
      headerBadge,
      createElement("p", {
        className: "app-summary",
        text: "查看后端脱敏授权状态，启动共享浏览器授权，并管理单站导出材料、共享 Profile 与授权专用代理。",
      }),
    ]),
    operationLive,
    errorHost,
    sitesSection,
    profileSection,
    proxySection,
    boundarySection,
  );

  return {
    headerBadge,
    refreshButton,
    operationLive,
    errorHost,
    siteHost,
    profileStatusHost,
    profileClearButton,
    profileReasons,
    proxyStatusHost,
    proxyForm,
    proxyInput,
    revealButton,
    proxyValidation,
    proxySaveButton,
    proxyResetButton,
    proxyReasons,
  };
}
