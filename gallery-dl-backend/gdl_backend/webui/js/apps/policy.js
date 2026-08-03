import { isAbortError } from "../core/api.js";
import { setElementInert } from "../core/dom.js";
import {
  createPolicyRequestGate,
  getPolicySiteDefinition,
  policyConfigsEqual,
  PolicyValidationError,
} from "../core/policy-model.js";
import { actionCreators } from "../core/store.js";
import { createPolicyView } from "../components/policy-view.js";

export const POLICY_ENDPOINTS = Object.freeze({
  policies: "/api/v1/sites/policies",
});

const POLICY_VIEW_QUERY = "view=policy";

function policyViewUrl(path) {
  return `${path}${path.includes("?") ? "&" : "?"}${POLICY_VIEW_QUERY}`;
}

function policySitePath(siteId) {
  if (!getPolicySiteDefinition(siteId)) throw new TypeError("POLICY 来源无效");
  return `${POLICY_ENDPOINTS.policies}/${encodeURIComponent(siteId)}`;
}

function createPolicyController(context) {
  const { root, api, store, dialogs, actions } = context;
  const view = createPolicyView(context);
  const requestGate = createPolicyRequestGate();
  let active = false;
  let destroyed = false;
  let busy = "";
  let operationSequence = 0;
  let activeOperationController = null;
  let configRead = null;

  const linkSignal = (externalSignal, controller) => {
    if (!externalSignal) return () => {};
    const abort = () => controller.abort();
    if (externalSignal.aborted) abort();
    else externalSignal.addEventListener("abort", abort, { once: true });
    return () => externalSignal.removeEventListener("abort", abort);
  };

  const abortRead = () => configRead?.controller.abort();

  const readConfig = async (externalSignal, { replace = false, report = true } = {}) => {
    if (!active || destroyed) return false;
    if (configRead) {
      if (!replace) return configRead.promise;
      abortRead();
      try {
        await configRead.promise;
      } catch {
        // 被替换的读取由原调用方处理。
      }
      if (!active || destroyed) return false;
    }
    const controller = new AbortController();
    const unlink = linkSignal(externalSignal, controller);
    const ticket = requestGate.beginRead();
    const promise = api.get(policyViewUrl(POLICY_ENDPOINTS.policies), {
      signal: controller.signal,
    })
      .then((payload) => {
        if (!active || destroyed || controller.signal.aborted ||
            !requestGate.isReadCurrent(ticket)) return false;
        store.dispatch(actionCreators.policyConfigReceived(payload));
        view.setConflict(false);
        return true;
      })
      .catch((error) => {
        if (isAbortError(error) || controller.signal.aborted) return false;
        if (active && (report || !store.getState().policy.config)) view.showError(error);
        throw error;
      })
      .finally(() => {
        unlink();
        if (configRead?.promise === promise) configRead = null;
      });
    configRead = { controller, promise };
    return promise;
  };

  const setBusy = (kind) => {
    busy = kind;
    view.setBusy(kind);
  };

  const invalidateReadsForWrite = () => {
    requestGate.beginWrite();
    abortRead();
  };

  const runOperation = async ({ kind, request, successMessage, writes = true }) => {
    if (!active || destroyed || busy) return false;
    const operation = ++operationSequence;
    const baselinePolicy = writes ? view.getCurrentItem()?.policy || null : null;
    if (writes) invalidateReadsForWrite();
    else abortRead();
    view.clearError();
    view.setConflict(false);
    setBusy(kind);
    view.setOperationMessage(
      kind === "refresh"
        ? "正在读取后端 POLICY 安全投影…"
        : "正在写入单个站点策略，请勿重复提交…",
    );
    const controller = new AbortController();
    activeOperationController = controller;
    try {
      if (request) await request(controller.signal);
      if (!active || destroyed || controller.signal.aborted) return false;
      const loaded = await readConfig(null, { replace: true, report: false });
      if (!loaded || !active || destroyed || controller.signal.aborted) return false;
      view.clearError();
      view.setOperationMessage(successMessage);
      return true;
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || !active) return false;
      // 写失败后仍读取权威状态，但把草稿恢复到 DOM；草稿绝不进入 Store。
      const preservedDraft = writes && view.isDirty() ? view.readDraft() : null;
      let authoritativeChanged = false;
      if (writes) {
        try {
          const loaded = await readConfig(null, { replace: true, report: false });
          if (!active || destroyed || controller.signal.aborted) return false;
          if (loaded) {
            const currentPolicy = view.getCurrentItem()?.policy || null;
            authoritativeChanged = Boolean(
              baselinePolicy && currentPolicy && !policyConfigsEqual(baselinePolicy, currentPolicy),
            );
            if (preservedDraft) view.restoreDraft(preservedDraft);
          }
        } catch (readError) {
          if (isAbortError(readError) || controller.signal.aborted || !active) return false;
          // 原写错误更能解释当前操作；读取错误不覆盖它，也不输出原始细节。
        }
      }
      view.showError(error);
      if (authoritativeChanged) view.setConflict(true);
      view.setOperationMessage("操作未完成；当前草稿仍留在本页，可修正或手动刷新。");
      return false;
    } finally {
      if (activeOperationController === controller) activeOperationController = null;
      if (operation === operationSequence) {
        setBusy("");
        if (active && !destroyed) view.focusAfterOperation(kind);
      }
    }
  };

  const confirm = async (options) => {
    const choice = await dialogs.open(options);
    return choice === "confirm" && active && !destroyed;
  };

  const confirmDiscard = async (purpose) => {
    if (!view.isDirty()) return true;
    const confirmed = await confirm({
      title: "放弃 POLICY 未保存更改？",
      message: `当前来源草稿尚未保存。${purpose}会立即清除这些局部值。`,
      confirmLabel: "放弃草稿并继续",
      dangerous: true,
      confirmationText: "草稿没有写入中央 Store、Storage 或后端；放弃后无法从页面恢复。",
    });
    if (!confirmed) {
      view.restoreSourceSelection();
      view.setOperationMessage("已取消；未保存草稿继续保留在当前页面。");
    }
    return confirmed;
  };

  const save = async () => {
    const validation = view.validateDraft({ announce: true });
    if (!validation.valid || !validation.payload) {
      view.showError(new PolicyValidationError(
        validation.field,
        validation.reason,
        { index: validation.index },
      ));
      view.setOperationMessage("没有发送未通过本地安全预检的策略草稿。");
      return;
    }
    const siteId = view.getSelectedSite();
    let payload = validation.payload;
    let capturedPayload = payload;
    payload = null;
    try {
      await runOperation({
        kind: "save",
        request: (signal) => {
          const body = capturedPayload;
          capturedPayload = null;
          return api.put(policyViewUrl(policySitePath(siteId)), body, { signal });
        },
        successMessage: "✓ 站点覆盖已由后端确认保存；只影响之后的新搜索、规划与任务快照。",
      });
    } finally {
      payload = null;
      capturedPayload = null;
    }
  };

  const reset = async () => {
    const item = view.getCurrentItem();
    if (!item?.hasOverride) return;
    if (!await confirm({
      title: `恢复 ${item.label} 启动默认？`,
      message: "这会删除该站点的完整 SQLite 覆盖，并重新继承进程启动时的默认策略快照。",
      confirmLabel: "删除覆盖并恢复",
      dangerous: true,
      confirmationText: "不会热重载 config，不会修改已创建或运行中的任务，也不会触发代理/授权/抓取操作。",
    })) return;
    await runOperation({
      kind: "reset",
      request: (signal) => api.delete(policyViewUrl(policySitePath(item.site)), { signal }),
      successMessage: "✓ 站点覆盖已删除并恢复启动默认；后端权威配置已重新读取。",
    });
  };

  const refresh = async () => {
    if (!await confirmDiscard("手动刷新")) return;
    await runOperation({
      kind: "refresh",
      writes: false,
      request: null,
      successMessage: "✓ 五个来源的后端权威策略已刷新。",
    });
  };

  const discard = async () => {
    if (!view.isDirty()) return;
    if (!await confirmDiscard("放弃更改")) return;
    view.discardDraft();
    view.clearError();
    view.setConflict(false);
    view.setOperationMessage("✓ 未保存草稿已清除，表单恢复为最后读取的服务器配置。");
    view.focusAfterOperation("discard");
  };

  const switchSite = async (siteId) => {
    if (!getPolicySiteDefinition(siteId) || siteId === view.getSelectedSite()) {
      view.restoreSourceSelection();
      return;
    }
    if (!await confirmDiscard("切换来源")) return;
    view.selectSite(siteId);
    view.clearError();
    view.setOperationMessage("已切换来源；表单来自中央 Store 中最后一次安全服务器投影。");
  };

  const navigateToVault = async () => {
    const item = view.getCurrentItem();
    if (!item || item.authorization === "anonymous") return;
    if (!await confirmDiscard("打开 VAULT.CPL")) return;
    actions.navigateToApp("vault");
  };

  const onClick = async (event) => {
    if (!(event.target instanceof Element)) return;
    const sourceOption = event.target.closest(".policy-source-option");
    if (sourceOption) {
      const radio = sourceOption.querySelector("[data-policy-site]");
      if (!(radio instanceof HTMLInputElement) || radio.disabled) return;
      // Radio 自身的鼠标/键盘激活交给原生 change；卡片空白与文字点击才走手动切换。
      if (event.target === radio) return;
      event.preventDefault();
      await switchSite(radio.value);
      return;
    }
    const button = event.target.closest("[data-policy-action]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    const action = button.dataset.policyAction;
    if (action === "discard") await discard();
    else if (action === "reset") await reset();
    else if (action === "refresh") await refresh();
    else if (action === "vault") await navigateToVault();
  };

  const onChange = async (event) => {
    if (event.target instanceof HTMLInputElement && event.target.matches("[data-policy-site]")) {
      // 键盘方向键可能只触发 change；恢复 DOM 选择后走统一确认流程。
      const siteId = event.target.value;
      view.restoreSourceSelection();
      await switchSite(siteId);
      return;
    }
    if (event.target instanceof Element && event.target.matches("[data-policy-field]")) {
      view.renderDraftState({ announce: true });
    }
  };

  const onInput = (event) => {
    if (event.target instanceof Element && event.target.matches("[data-policy-field]")) {
      view.renderDraftState({ announce: true });
    }
  };

  const onSubmit = async (event) => {
    if (!(event.target instanceof HTMLFormElement) || event.target !== view.elements.form) return;
    event.preventDefault();
    if (!busy) await save();
  };

  const onBeforeUnload = (event) => {
    if (!active || !view.isDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  };

  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  root.addEventListener("input", onInput);
  root.addEventListener("submit", onSubmit);
  globalThis.addEventListener?.("beforeunload", onBeforeUnload);

  return Object.freeze({
    activate() {
      if (destroyed || active) return;
      active = true;
      requestGate.advanceLifecycle();
      root.hidden = false;
      setElementInert(root, false);
      root.dataset.lifecycle = "active";
      view.clearDraft();
      view.clearError();
      view.setConflict(false);
      view.setOperationMessage("正在加载后端 POLICY 安全投影…");
      void readConfig(null, { replace: true, report: true })
        .then((loaded) => {
          if (loaded && active) {
            view.setOperationMessage("✓ 站点策略已加载；配置不轮询，可保存后刷新或手动刷新。");
          }
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
      abortRead();
      busy = "";
      view.setBusy("");
      view.clearDraft();
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
      abortRead();
      view.clearDraft();
      root.removeEventListener("click", onClick);
      root.removeEventListener("change", onChange);
      root.removeEventListener("input", onInput);
      root.removeEventListener("submit", onSubmit);
      globalThis.removeEventListener?.("beforeunload", onBeforeUnload);
      view.destroy();
      root.removeAttribute("data-lifecycle");
    },
  });
}

let controller = null;

export default Object.freeze({
  mount(context) {
    if (controller) throw new Error("POLICY.CPL 已挂载");
    controller = createPolicyController(context);
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
