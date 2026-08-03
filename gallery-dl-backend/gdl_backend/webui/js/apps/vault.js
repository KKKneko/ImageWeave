import { isAbortError } from "../core/api.js";
import { setElementInert } from "../core/dom.js";
import {
  buildAuthorizationProxyPayload,
  createVaultRequestGate,
  extractVaultSessionFromSnapshot,
  extractVaultSessionReference,
  getVaultSiteDefinition,
  validateAuthorizationProxyInput,
} from "../core/vault-model.js";
import { actionCreators } from "../core/store.js";
import { createVaultView } from "../components/vault-view.js";

export const VAULT_ENDPOINTS = Object.freeze({
  status: "/api/v1/auth",
  proxy: "/api/v1/auth/proxy",
  browserProfile: "/api/v1/auth/browser-profile",
  pixivOAuthStart: "/api/v1/auth/pixiv/oauth/start",
  pixivOAuthSession: "/api/v1/auth/pixiv/oauth/session",
});

const AUTHORIZATION_POLL_KEY = "vault.authorization";
const AUTHORIZATION_POLL_INTERVAL_MS = 800;
const VAULT_VIEW_QUERY = "view=vault";

function vaultViewUrl(path) {
  return `${path}${path.includes("?") ? "&" : "?"}${VAULT_VIEW_QUERY}`;
}

function siteAuthPath(siteId) {
  if (!getVaultSiteDefinition(siteId)) throw new TypeError("授权目标无效");
  return `${VAULT_ENDPOINTS.status}/${encodeURIComponent(siteId)}`;
}

function sameSession(left, right) {
  return Boolean(left && right && left.site === right.site && left.kind === right.kind &&
    left.sessionId === right.sessionId);
}

function createVaultController(context) {
  const { root, api, store, polling, dialogs } = context;
  const view = createVaultView(context);
  let active = false;
  let destroyed = false;
  let busy = "";
  const requestGate = createVaultRequestGate();
  let operationSequence = 0;
  let activeSession = null;
  let activeOperationController = null;
  let statusRead = null;
  let sessionRead = null;

  const linkSignal = (externalSignal, controller) => {
    if (!externalSignal) return () => {};
    const abort = () => controller.abort();
    if (externalSignal.aborted) abort();
    else externalSignal.addEventListener("abort", abort, { once: true });
    return () => externalSignal.removeEventListener("abort", abort);
  };

  const abortRead = (entry) => entry?.controller.abort();

  const stopAuthorizationPolling = () => {
    polling.stop(AUTHORIZATION_POLL_KEY);
  };

  const syncAuthorizationPolling = () => {
    if (!active || destroyed || !activeSession) {
      stopAuthorizationPolling();
      return;
    }
    polling.start({
      key: AUTHORIZATION_POLL_KEY,
      scope: context.pollingScope,
      intervalMs: AUTHORIZATION_POLL_INTERVAL_MS,
      immediate: false,
      critical: false,
      resume: "immediate",
      task(signal) {
        if (busy || !activeSession) return Promise.resolve(false);
        return pollActiveSession(signal);
      },
    });
  };

  const applySnapshot = (payload) => {
    const action = actionCreators.authStatusReceived(payload);
    const reference = extractVaultSessionFromSnapshot(payload);
    store.dispatch(action);
    activeSession = reference;
    syncAuthorizationPolling();
  };

  const applySiteStatus = (payload, { syncPolling = true } = {}) => {
    const status = payload?.status && typeof payload.status === "object" ? payload.status : payload;
    store.dispatch(actionCreators.authSiteStatusReceived(status));
    activeSession = extractVaultSessionReference(payload);
    if (syncPolling) syncAuthorizationPolling();
  };

  const readStatus = async (externalSignal, { replace = false, report = true } = {}) => {
    if (!active || destroyed) return false;
    if (statusRead) {
      if (!replace) return statusRead.promise;
      abortRead(statusRead);
      try {
        await statusRead.promise;
      } catch {
        // 被替换的读取由原调用方处理。
      }
      if (!active || destroyed) return false;
    }
    const controller = new AbortController();
    const unlink = linkSignal(externalSignal, controller);
    const ticket = requestGate.beginRead("status");
    const promise = api.get(vaultViewUrl(VAULT_ENDPOINTS.status), { signal: controller.signal })
      .then((payload) => {
        if (
          !active || destroyed || controller.signal.aborted ||
          !requestGate.isReadCurrent(ticket)
        ) return false;
        applySnapshot(payload);
        return true;
      })
      .catch((error) => {
        if (isAbortError(error) || controller.signal.aborted) return false;
        if (active && (report || store.getState().auth.bySite.size === 0)) view.showError(error);
        throw error;
      })
      .finally(() => {
        unlink();
        if (statusRead?.promise === promise) statusRead = null;
      });
    statusRead = { controller, promise };
    return promise;
  };

  const pollActiveSession = async (externalSignal) => {
    if (!active || destroyed || !activeSession) return false;
    if (sessionRead) return sessionRead.promise;
    const reference = activeSession;
    const controller = new AbortController();
    const unlink = linkSignal(externalSignal, controller);
    const ticket = requestGate.beginRead("session");
    const path = reference.kind === "oauth"
      ? `${siteAuthPath("pixiv")}`
      : `${siteAuthPath(reference.site)}/login/${encodeURIComponent(reference.sessionId)}`;
    const promise = api.get(vaultViewUrl(path), { signal: controller.signal })
      .then(async (payload) => {
        if (
          !active || destroyed || controller.signal.aborted ||
          !requestGate.isReadCurrent(ticket) || !sameSession(reference, activeSession)
        ) return false;
        applySiteStatus(payload, { syncPolling: false });
        if (!activeSession && active && !destroyed) {
          view.setOperationMessage("授权流程已结束；请查看目标文字状态，页面不会把流程结束等同于登录成功。");
          await readStatus(controller.signal, { replace: false, report: false });
        } else {
          syncAuthorizationPolling();
        }
        return true;
      })
      .catch((error) => {
        if (isAbortError(error) || controller.signal.aborted) return false;
        if (active) view.showError(error);
        throw error;
      })
      .finally(() => {
        unlink();
        if (sessionRead?.promise === promise) sessionRead = null;
      });
    sessionRead = { controller, promise };
    return promise;
  };

  const setBusy = (kind) => {
    busy = kind;
    view.setBusy(kind);
  };

  const invalidateReadsForWrite = () => {
    requestGate.beginWrite();
    abortRead(statusRead);
    abortRead(sessionRead);
  };

  const processOperationPayload = (payload) => {
    const reference = extractVaultSessionReference(payload);
    if (reference) activeSession = reference;
    if (payload?.status || payload?.site) {
      try {
        applySiteStatus(payload);
      } catch {
        // 写后统一安全快照刷新负责最终校验；不采用异常局部响应。
      }
    }
  };

  const runOperation = async ({
    kind,
    request = null,
    successMessage,
    writes = true,
    processPayload = false,
  }) => {
    if (!active || destroyed || busy) return false;
    const operation = ++operationSequence;
    if (writes) invalidateReadsForWrite();
    else {
      abortRead(statusRead);
      abortRead(sessionRead);
    }
    view.clearError();
    setBusy(kind);
    view.setOperationMessage(
      kind === "refresh"
        ? "正在读取后端安全授权投影…"
        : "正在执行凭证操作，请勿重复提交…",
    );
    const controller = new AbortController();
    activeOperationController = controller;
    try {
      const payload = request ? await request(controller.signal) : null;
      if (!active || destroyed || controller.signal.aborted) return false;
      if (processPayload && payload) processOperationPayload(payload);
      await readStatus(null, { replace: true, report: false });
      if (!active || destroyed || controller.signal.aborted) return false;
      view.clearError();
      view.setOperationMessage(successMessage);
      return true;
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || !active) return false;
      try {
        await readStatus(null, { replace: true, report: false });
      } catch {
        // 保留原操作错误，失败刷新不能覆盖受控指引。
      }
      view.showError(error);
      view.setOperationMessage("操作未完成；其他目标的最后安全状态仍然保留。可手动刷新恢复。");
      return false;
    } finally {
      view.clearSensitiveInputs();
      if (activeOperationController === controller) activeOperationController = null;
      if (operation === operationSequence) setBusy("");
    }
  };

  const runProxySecretOperation = async () => {
    const input = view.elements.proxyInput;
    let secret = input.value;
    let payload = null;
    let capturedPayload = null;
    try {
      payload = buildAuthorizationProxyPayload(secret);
      input.value = "";
      secret = "";
      capturedPayload = payload;
      payload = null;
      return await runOperation({
        kind: "proxy-save",
        request: (signal) => {
          const body = capturedPayload;
          capturedPayload = null;
          return api.put(vaultViewUrl(VAULT_ENDPOINTS.proxy), body, { signal });
        },
        successMessage: "✓ 后端已保存授权线路设置；这不代表任何站点登录成功。",
      });
    } catch (error) {
      if (active && !busy) {
        view.showError({
          code: "invalid_authorization_proxy",
          status: 422,
          requestId: "",
          details: null,
        });
        view.setOperationMessage("没有发送格式无效的授权代理请求。");
      }
      return false;
    } finally {
      secret = "";
      payload = null;
      capturedPayload = null;
      input.value = "";
      view.clearSensitiveInputs();
    }
  };

  const confirm = async (options) => {
    // 对话框期间暂停会重建目标卡片的会话轮询，确保关闭后焦点返回原触发按钮。
    abortRead(sessionRead);
    stopAuthorizationPolling();
    const choice = await dialogs.open(options);
    view.clearSensitiveInputs();
    if (active && !destroyed) syncAuthorizationPolling();
    if (choice !== "confirm") {
      view.setOperationMessage("已取消操作；敏感输入已清空。后端状态未改变。");
      return false;
    }
    return active && !destroyed;
  };

  const authorizeSite = async (siteId) => {
    const definition = getVaultSiteDefinition(siteId);
    if (!definition?.authorizeAction) return;
    const path = siteId === "pixiv"
      ? VAULT_ENDPOINTS.pixivOAuthStart
      : `${siteAuthPath(siteId)}/login/start`;
    await runOperation({
      kind: `authorize:${siteId}`,
      request: (signal) => api.post(vaultViewUrl(path), undefined, { signal }),
      processPayload: true,
      successMessage: `▶ ${definition.label} 授权流程已启动；请在共享浏览器中完成操作。尚未声明登录成功。`,
    });
  };

  const cancelSite = async (siteId) => {
    const definition = getVaultSiteDefinition(siteId);
    const reference = activeSession;
    if (!definition || !reference || reference.site !== siteId) return;
    if (!await confirm({
      title: `关闭 ${definition.label} 授权标签页？`,
      message: "这会取消本次共享浏览器授权流程，不会删除此前已经导出的站点材料。",
      confirmLabel: "关闭授权标签页",
      dangerous: true,
      confirmationText: "关闭后可重新开始；页面不会自动取消抓取任务。",
    })) return;
    const path = reference.kind === "oauth"
      ? VAULT_ENDPOINTS.pixivOAuthSession
      : `${siteAuthPath(siteId)}/login/${encodeURIComponent(reference.sessionId)}`;
    await runOperation({
      kind: `cancel:${siteId}`,
      request: (signal) => api.delete(vaultViewUrl(path), { signal }),
      processPayload: true,
      successMessage: `✓ ${definition.label} 本次授权标签页已关闭；既有导出材料保持原样。`,
    });
  };

  const clearSite = async (siteId) => {
    const definition = getVaultSiteDefinition(siteId);
    if (!definition || definition.method === "anonymous") return;
    if (!await confirm({
      title: `删除 ${definition.label} 导出凭证？`,
      message: "这会删除后端托管的单站 Cookie 或 Token；共享浏览器 Profile 将继续保留。",
      confirmLabel: "删除导出凭证",
      dangerous: true,
      confirmationText: "后端没有承诺自动处理运行中任务；页面不会强制取消任务或乐观标记成功。",
    })) return;
    await runOperation({
      kind: `clear:${siteId}`,
      request: (signal) => api.delete(vaultViewUrl(siteAuthPath(siteId)), { signal }),
      processPayload: true,
      successMessage: `✓ ${definition.label} 导出材料已由后端确认删除；共享 Profile 未删除。`,
    });
  };

  const clearProfile = async () => {
    if (!await confirm({
      title: "清空共享授权 Profile？",
      message: "这会关闭活动授权并删除 X、Pixiv、EH 共用的项目 Chrome Profile。",
      confirmLabel: "清空共享 Profile",
      dangerous: true,
      confirmationText: "单站已导出的 Cookie/Token 不会随 Profile 删除；运行中任务不会被页面强制中断。",
    })) return;
    await runOperation({
      kind: "profile-clear",
      request: (signal) => api.delete(vaultViewUrl(VAULT_ENDPOINTS.browserProfile), { signal }),
      successMessage: "✓ 后端已确认共享 Profile 清空；单站导出材料保持原样。",
    });
  };

  const resetProxy = async () => {
    if (!await confirm({
      title: "恢复 config 授权代理默认值？",
      message: "这会删除 VAULT 保存的运行时授权代理覆盖，包括显式直连覆盖。",
      confirmLabel: "恢复 config 默认",
      dangerous: true,
      confirmationText: "只影响后续共享浏览器授权线路，不修改 PROXY.CPL 抓取代理池。",
    })) return;
    await runOperation({
      kind: "proxy-reset",
      request: (signal) => api.delete(vaultViewUrl(VAULT_ENDPOINTS.proxy), { signal }),
      successMessage: "✓ 授权代理已恢复 config 默认；后端安全状态已刷新。",
    });
  };

  const onClick = async (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-vault-action]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    const action = button.dataset.vaultAction || "";
    if (action === "refresh") {
      await runOperation({
        kind: "refresh",
        writes: false,
        successMessage: "✓ 授权目标、共享 Profile 与授权代理安全状态已刷新。",
      });
      return;
    }
    if (action === "proxy-reveal") {
      view.toggleProxyVisibility();
      return;
    }
    if (action === "profile-clear") {
      await clearProfile();
      return;
    }
    if (action === "proxy-reset") {
      await resetProxy();
      return;
    }
    const separator = action.indexOf(":");
    if (separator < 1) return;
    const kind = action.slice(0, separator);
    const siteId = action.slice(separator + 1);
    if (!getVaultSiteDefinition(siteId)) return;
    if (kind === "authorize") await authorizeSite(siteId);
    else if (kind === "cancel") await cancelSite(siteId);
    else if (kind === "clear") await clearSite(siteId);
  };

  const onSubmit = async (event) => {
    if (!(event.target instanceof HTMLFormElement) || event.target !== view.elements.proxyForm) return;
    event.preventDefault();
    if (busy) {
      view.clearSensitiveInputs();
      return;
    }
    if (!view.validateProxyInput({ announce: true })) {
      view.clearSensitiveInputs();
      view.showError({ code: "invalid_authorization_proxy", status: 422, requestId: "" });
      return;
    }
    const isDirect = view.elements.proxyInput.value.trim() === "";
    const currentProxy = store.getState().auth.authorizationProxy;
    if (isDirect && currentProxy?.configured && !await confirm({
      title: "将授权线路改为直连？",
      message: "空值会保存为运行时直连覆盖，而不是恢复 config 默认。",
      confirmLabel: "保存为直连",
      dangerous: true,
      confirmationText: "现有代理凭据不会回填；只影响下一次授权浏览器与 Pixiv Token 交换。",
    })) return;
    await runProxySecretOperation();
  };

  const onInput = (event) => {
    if (event.target === view.elements.proxyInput) view.validateProxyInput({ announce: true });
  };

  root.addEventListener("click", onClick);
  root.addEventListener("submit", onSubmit);
  root.addEventListener("input", onInput);

  return Object.freeze({
    activate() {
      if (destroyed || active) return;
      active = true;
      requestGate.advanceLifecycle();
      root.hidden = false;
      setElementInert(root, false);
      root.dataset.lifecycle = "active";
      view.clearSensitiveInputs();
      view.setOperationMessage("正在加载后端 VAULT 安全投影…");
      void readStatus(null, { replace: true, report: true })
        .then((loaded) => {
          if (loaded && active) view.setOperationMessage("✓ 安全授权状态已加载。可随时手动刷新。");
        })
        .catch(() => {});
    },

    deactivate() {
      if (destroyed) return;
      active = false;
      requestGate.advanceLifecycle();
      operationSequence += 1;
      dialogs.destroy();
      activeOperationController?.abort();
      activeOperationController = null;
      abortRead(statusRead);
      abortRead(sessionRead);
      activeSession = null;
      stopAuthorizationPolling();
      view.clearSensitiveInputs();
      busy = "";
      view.setBusy("");
      root.hidden = true;
      setElementInert(root, true);
      root.dataset.lifecycle = "inactive";
    },

    destroy() {
      if (destroyed) return;
      active = false;
      destroyed = true;
      requestGate.advanceLifecycle();
      operationSequence += 1;
      dialogs.destroy();
      activeOperationController?.abort();
      abortRead(statusRead);
      abortRead(sessionRead);
      activeSession = null;
      stopAuthorizationPolling();
      view.clearSensitiveInputs();
      root.removeEventListener("click", onClick);
      root.removeEventListener("submit", onSubmit);
      root.removeEventListener("input", onInput);
      view.destroy();
      root.removeAttribute("data-lifecycle");
    },
  });
}

let controller = null;

export default Object.freeze({
  mount(context) {
    if (controller) throw new Error("VAULT.CPL 已挂载");
    controller = createVaultController(context);
  },
  activate() {
    controller?.activate();
  },
  deactivate() {
    controller?.deactivate();
  },
  unmount() {
    controller?.destroy();
    controller = null;
  },
});
