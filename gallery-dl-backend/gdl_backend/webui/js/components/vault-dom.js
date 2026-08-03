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

export function buildVaultDom(context) {
  const { root, app } = context;
  const headingId = "vault-heading";
  const headerBadge = createStatusBadge("disabled", "正在加载授权状态");
  const refreshButton = vaultButton("refresh", "刷新授权状态", "正在刷新…");
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
        createElement("h2", { text: "站点授权", attributes: { id: "vault-sites-heading" } }),
        createElement("p", {
          text: "Danbooru 和 Pawchive 无需登录；X、Pixiv 和 EH 共用一个独立的授权浏览器。",
        }),
      ]),
      refreshButton,
    ]),
    siteHost,
  ]);

  const profileStatusHost = createElement("div", { className: "vault-profile-status" });
  const profileClearButton = vaultButton(
    "profile-clear",
    "清除授权浏览器数据",
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
        createElement("h2", { text: "授权浏览器数据", attributes: { id: "vault-profile-heading" } }),
        createElement("p", {
          text: "X、Pixiv 和 EH 共用一份独立的授权浏览器数据，不会读取日常浏览器资料。",
        }),
      ]),
      profileClearButton,
    ]),
    createElement("p", {
      className: "vault-impact-note",
      text: "清除后会关闭活动授权并删除浏览器登录状态，但不会删除各站点已保存的 Cookie 或 Pixiv Token。",
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
  revealButton.setAttribute("aria-label", "显示登录代理输入");

  const proxyValidation = createElement("p", {
    className: "vault-field-error",
    attributes: { id: "vault-proxy-validation", role: "alert" },
  });
  const proxySaveButton = vaultButton(
    "proxy-save",
    "保存登录代理设置",
    "正在保存…",
    { primary: true },
  );
  proxySaveButton.type = "submit";
  proxySaveButton.removeAttribute("data-vault-action");
  const proxyResetButton = vaultButton(
    "proxy-reset",
    "恢复默认设置",
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
      createElement("legend", { text: "设置登录代理" }),
      createElement("label", {
        text: "完整代理地址",
        attributes: { for: "vault-proxy-input" },
      }),
      createElement("div", { className: "vault-secret-row" }, [proxyInput, revealButton]),
      createElement("p", {
        className: "vault-field-help",
        text: "格式：协议://主机:端口。支持 HTTP(S)、SOCKS4、SOCKS5 和 SOCKS5H；地址不能包含路径或查询参数。HTTP(S) 可包含账号密码，SOCKS 不支持。",
        attributes: { id: "vault-proxy-help" },
      }),
      proxyValidation,
      createElement("div", { className: "vault-form-actions" }, [
        proxySaveButton,
        proxyResetButton,
      ]),
      createElement("p", {
        className: "vault-field-help",
        text: "留空保存表示始终直连；“恢复默认设置”则重新采用配置文件中的值。",
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
        createElement("h2", { text: "登录代理", attributes: { id: "vault-proxy-heading" } }),
        createElement("p", {
          text: "仅用于授权浏览器和 Pixiv Token 交换，与图片采集使用的代理池相互独立。",
        }),
      ]),
      createIcon("network", { size: 28, strokeWidth: 1.8, className: "vault-panel-icon" }),
    ]),
    proxyStatusHost,
    proxyForm,
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
        text: "查看各站授权状态，打开独立浏览器完成登录，并管理登录凭证和登录代理。",
      }),
    ]),
    operationLive,
    errorHost,
    sitesSection,
    profileSection,
    proxySection,
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
