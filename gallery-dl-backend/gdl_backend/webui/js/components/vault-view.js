import { createElement } from "../core/dom.js";
import {
  deriveVaultControls,
  formatAuthorizationProxy,
  formatBrowserProfile,
  formatVaultSite,
  getVaultSiteDefinition,
  validateAuthorizationProxyInput,
  VAULT_SITE_IDS,
  vaultErrorGuidance,
} from "../core/vault-model.js";
import { selectors } from "../core/store.js";
import { createEmptyState } from "./empty-state.js";
import { createErrorView } from "./error-view.js";
import { buildVaultDom, vaultButton, vaultDefinitionList } from "./vault-dom.js";
import { createStatusBadge, updateStatusBadge } from "./status.js";

function setControl(button, model) {
  button.disabled = model.disabled;
  button.setAttribute("aria-disabled", String(model.disabled));
  button.textContent = model.label;
  if (model.reason) button.dataset.disabledReason = model.reason;
  else delete button.dataset.disabledReason;
}

export function createVaultView(context) {
  const { root, store } = context;
  const elements = buildVaultDom(context);
  let busy = "";
  let renderedError = null;
  let proxyInputTouched = false;

  const currentSnapshot = () => ({
    bySite: store.getState().auth.bySite,
    browserProfile: store.getState().auth.browserProfile,
    authorizationProxy: store.getState().auth.authorizationProxy,
  });

  const currentValidation = () => validateAuthorizationProxyInput(elements.proxyInput.value);

  const clearError = () => {
    renderedError?.destroy();
    renderedError = null;
    elements.errorHost.replaceChildren();
  };

  const showError = (error) => {
    clearError();
    const guidance = vaultErrorGuidance(error);
    renderedError = createErrorView({
      code: guidance.code,
      message: guidance.message,
      requestId: guidance.requestId,
      details: null,
    }, {
      statusLabel: guidance.title,
      nextStep: guidance.nextStep,
    });
    elements.errorHost.replaceChildren(renderedError.element);
  };

  const setOperationMessage = (message) => {
    elements.operationLive.textContent = message;
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
    const statuses = VAULT_SITE_IDS.map((siteId) => snapshot.bySite.get(siteId)).filter(Boolean);
    const anyActive = statuses.some((status) => status.session.active);
    const anyInvalidated = statuses.some((status) => status.invalidated);
    const complete = statuses.length === VAULT_SITE_IDS.length && snapshot.browserProfile && snapshot.authorizationProxy;
    if (anyActive) updateStatusBadge(elements.headerBadge, "running", "共享浏览器授权进行中");
    else if (anyInvalidated) updateStatusBadge(elements.headerBadge, "error", "存在失效授权材料");
    else if (complete) updateStatusBadge(elements.headerBadge, "ready", "安全状态已加载");
    else updateStatusBadge(elements.headerBadge, "disabled", "授权状态待加载");
  };

  const renderSites = (bySite) => {
    const controls = deriveVaultControls(currentSnapshot(), {
      busy,
      proxyInputValid: currentValidation().valid,
    });
    const fragment = document.createDocumentFragment();
    for (const siteId of VAULT_SITE_IDS) {
      const definition = getVaultSiteDefinition(siteId);
      const status = bySite.get(siteId) || null;
      const model = formatVaultSite(status, siteId);
      const siteControls = controls.sites[siteId];
      const actionHost = createElement("div", { className: "vault-site-actions" });
      if (siteControls.showAuthorize) {
        const authorize = vaultButton(
          `authorize:${siteId}`,
          siteControls.authorize.label,
          "正在打开…",
          { primary: true },
        );
        setControl(authorize, siteControls.authorize);
        actionHost.append(authorize);
      }
      if (siteControls.showCancel) {
        const cancel = vaultButton(
          `cancel:${siteId}`,
          siteControls.cancel.label,
          "正在关闭…",
        );
        setControl(cancel, siteControls.cancel);
        actionHost.append(cancel);
      }
      if (siteControls.showClear) {
        const clear = vaultButton(
          `clear:${siteId}`,
          siteControls.clear.label,
          "正在删除…",
          { dangerous: true },
        );
        setControl(clear, siteControls.clear);
        actionHost.append(clear);
      }
      const reasons = [
        siteControls.authorize.reason,
        siteControls.cancel.reason,
        siteControls.clear.reason,
      ].filter(Boolean);
      const reason = createElement("p", {
        className: "vault-control-reason",
        text: reasons[0] || (definition.method === "anonymous"
          ? "此目标没有授权写操作。"
          : "可用操作由后端 actions 白名单决定。"),
      });
      const card = createElement("article", {
        className: "vault-site-card",
        attributes: { "aria-label": `${definition.label} 授权状态` },
        dataset: { siteState: model.badge.status },
      }, [
        createElement("div", { className: "vault-site-heading" }, [
          createElement("div", { className: "vault-site-identity" }, [
            createElement("span", {
              className: "vault-site-mark",
              text: model.mark,
              attributes: { "aria-hidden": "true" },
            }),
            createElement("h3", { text: model.label }),
          ]),
          createStatusBadge(model.badge.status, model.badge.label),
        ]),
        createElement("p", { className: "vault-site-headline", text: model.headline }),
        createElement("p", { className: "vault-proof-note", text: model.proof }),
        vaultDefinitionList([
          ["材料", model.material],
          ["会话", model.session],
          ["安全来源", model.source],
          ["最近更新", model.updatedAt],
        ]),
        actionHost,
        reason,
      ]);
      fragment.append(card);
    }
    elements.siteHost.replaceChildren(fragment);
    renderBusyAttributes();
  };

  const renderProfile = (profile) => {
    const model = formatBrowserProfile(profile);
    if (!profile) {
      elements.profileStatusHost.replaceChildren(createEmptyState({
        status: "error",
        label: "状态不可用",
        title: "共享 Profile 状态尚未加载",
        message: "其他授权目标仍可保留最后一次安全状态；请手动刷新。",
      }));
    } else {
      elements.profileStatusHost.replaceChildren(
        createStatusBadge(model.badge.status, model.badge.label),
        vaultDefinitionList([
          ["共享范围", "X / Twitter、Pixiv、EH"],
          ["磁盘状态", model.presence],
          ["运行状态", model.runtime],
          ["导出材料", "单独管理，不随 Profile 自动删除"],
        ]),
      );
    }
    renderControls();
  };

  const renderProxy = (proxy) => {
    const model = formatAuthorizationProxy(proxy);
    if (!proxy) {
      elements.proxyStatusHost.replaceChildren(createEmptyState({
        status: "error",
        label: "状态不可用",
        title: "授权代理状态尚未加载",
        message: "输入框不会回填任何旧值；请刷新后再提交。",
      }));
    } else {
      elements.proxyStatusHost.replaceChildren(
        createStatusBadge(model.badge.status, model.badge.label),
        vaultDefinitionList([
          ["脱敏端点", model.endpoint],
          ["配置来源", model.source],
          ["生效说明", model.runtime],
          ["最近更新", model.updatedAt],
          ["凭据显示", proxy.credentialsRedacted ? "用户名和密码已隐藏" : "响应未包含代理凭据"],
        ]),
      );
    }
    renderControls();
  };

  const renderControls = () => {
    const validation = currentValidation();
    const controls = deriveVaultControls(currentSnapshot(), {
      busy,
      proxyInputValid: validation.valid,
    });
    setControl(elements.refreshButton, controls.refresh);
    setControl(elements.profileClearButton, controls.profileClear);
    setControl(elements.proxySaveButton, controls.proxySave);
    setControl(elements.proxyResetButton, controls.proxyReset);
    elements.revealButton.disabled = controls.reveal.disabled;
    elements.revealButton.setAttribute("aria-disabled", String(controls.reveal.disabled));
    elements.proxyInput.disabled = Boolean(busy);
    elements.proxyInput.setAttribute("aria-disabled", String(Boolean(busy)));
    elements.profileReasons.textContent = controls.profileClear.reason ||
      "清空前会再次确认；后端导出材料不会随 Profile 删除。";
    const proxyReasons = [controls.proxySave.reason, controls.proxyReset.reason].filter(Boolean);
    elements.proxyReasons.textContent = proxyReasons[0] ||
      "保存只改变后续授权线路；不会触碰 PROXY.CPL 的抓取代理池。";
    renderBusyAttributes();
  };

  const validateProxyInput = ({ announce = false } = {}) => {
    if (announce) proxyInputTouched = true;
    const validation = currentValidation();
    elements.proxyInput.setAttribute("aria-invalid", String(proxyInputTouched && !validation.valid));
    elements.proxyValidation.textContent = proxyInputTouched && !validation.valid ? validation.error : "";
    renderControls();
    return validation.valid;
  };

  const clearSensitiveInputs = () => {
    elements.proxyInput.value = "";
    elements.proxyInput.type = "password";
    elements.proxyInput.setAttribute("autocomplete", "new-password");
    elements.proxyInput.setAttribute("aria-invalid", "false");
    elements.revealButton.setAttribute("aria-pressed", "false");
    elements.revealButton.setAttribute("aria-label", "显示授权代理输入");
    elements.revealButton.textContent = "显示代理输入";
    elements.proxyValidation.textContent = "";
    proxyInputTouched = false;
    renderControls();
  };

  const toggleProxyVisibility = () => {
    const reveal = elements.proxyInput.type === "password";
    elements.proxyInput.type = reveal ? "text" : "password";
    elements.revealButton.setAttribute("aria-pressed", String(reveal));
    elements.revealButton.setAttribute(
      "aria-label",
      reveal ? "隐藏授权代理输入" : "显示授权代理输入",
    );
    elements.revealButton.textContent = reveal ? "隐藏代理输入" : "显示代理输入";
    elements.proxyInput.focus({ preventScroll: true });
  };

  const unsubscribeSites = store.subscribe(selectors.authSites, (bySite) => {
    renderSites(bySite);
    renderHeader();
    renderControls();
  }, { fireImmediately: true });
  const unsubscribeProfile = store.subscribe(selectors.authBrowserProfile, (profile) => {
    renderProfile(profile);
    renderHeader();
  }, { fireImmediately: true });
  const unsubscribeProxy = store.subscribe(selectors.authAuthorizationProxy, (proxy) => {
    renderProxy(proxy);
    renderHeader();
  }, { fireImmediately: true });

  return Object.freeze({
    elements,
    clearSensitiveInputs,
    clearError,
    showError,
    setOperationMessage,
    validateProxyInput,
    toggleProxyVisibility,
    setBusy(kind) {
      busy = kind;
      renderSites(store.getState().auth.bySite);
      renderControls();
    },
    destroy() {
      clearSensitiveInputs();
      unsubscribeSites();
      unsubscribeProfile();
      unsubscribeProxy();
      clearError();
      root.replaceChildren();
      root.removeAttribute("aria-busy");
    },
  });
}
