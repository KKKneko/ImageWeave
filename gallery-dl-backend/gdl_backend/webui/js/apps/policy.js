import { isAbortError } from "../core/api.js";
import { setElementInert } from "../core/dom.js";
import {
  createPolicyRequestGate,
  getPolicySiteDefinition,
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
  if (!getPolicySiteDefinition(siteId)) throw new TypeError("站点无效");
  return `${POLICY_ENDPOINTS.policies}/${encodeURIComponent(siteId)}`;
}

function createPolicyController(context) {
  const { root, api, store, dialogs } = context;
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
        // 被新读取替换的请求由原调用方收尾。
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

  const runOperation = async ({ kind, request, successMessage }) => {
    if (!active || destroyed || busy) return false;
    const operation = ++operationSequence;
    invalidateReadsForWrite();
    view.clearError();
    setBusy(kind);
    view.setOperationMessage(
      kind === "save" ? "正在保存站点设置……" : "正在恢复默认设置……",
    );
    const controller = new AbortController();
    activeOperationController = controller;
    try {
      await request(controller.signal);
      if (!active || destroyed || controller.signal.aborted) return false;
      const loaded = await readConfig(null, { replace: true, report: false });
      if (!loaded || !active || destroyed || controller.signal.aborted) return false;
      view.clearError();
      view.setOperationMessage(successMessage);
      return true;
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || !active) return false;
      const preservedDraft = view.isDirty() ? view.readDraft() : null;
      try {
        const loaded = await readConfig(null, { replace: true, report: false });
        if (!active || destroyed || controller.signal.aborted) return false;
        if (loaded && preservedDraft) view.restoreDraft(preservedDraft);
      } catch (readError) {
        if (isAbortError(readError) || controller.signal.aborted || !active) return false;
        // 保留原操作错误和当前表单，不展示第二个原始错误。
      }
      view.showError(error);
      view.setOperationMessage("操作失败，修改已保留。请检查后重试。");
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
    if (busy) {
      view.setOperationMessage("请等待当前操作完成后再离开。");
      return false;
    }
    if (!view.isDirty()) return true;
    const confirmed = await confirm({
      title: "放弃未保存的更改？",
      message: `当前站点有未保存的更改，${purpose}后将丢失。`,
      confirmLabel: "放弃更改并继续",
      dangerous: true,
      confirmationText: "已保存的设置和运行中的任务不受影响。",
    });
    if (!confirmed) {
      view.restoreSourceSelection();
      view.setOperationMessage("已取消，未保存的更改继续保留。");
    }
    return confirmed;
  };

  const save = async () => {
    const validation = view.validateDraft({ announce: true });
    if (!validation.valid || !validation.payload) {
      view.showError(new PolicyValidationError(validation.field, validation.reason));
      view.setOperationMessage("请修正标记项后再保存。");
      return;
    }
    const siteId = view.getSelectedSite();
    let capturedPayload = validation.payload;
    try {
      await runOperation({
        kind: "save",
        request: (signal) => {
          const body = capturedPayload;
          capturedPayload = null;
          return api.put(policyViewUrl(policySitePath(siteId)), body, { signal });
        },
        successMessage: "设置已保存，将用于新建任务。",
      });
    } finally {
      capturedPayload = null;
    }
  };

  const reset = async () => {
    const item = view.getCurrentItem();
    const hasLocalChanges = view.isDirty();
    if (!item || (!item.hasOverride && !hasLocalChanges)) return;
    if (!await confirm({
      title: `恢复 ${item.label} 的默认设置？`,
      message: item.hasOverride
        ? "将删除该站点的自定义设置并恢复默认值。"
        : "将清除本页未保存的更改。",
      confirmLabel: "恢复默认设置",
      dangerous: true,
      confirmationText: "已创建和运行中的任务不受影响。",
    })) return;
    if (!item.hasOverride) {
      view.reloadDraft();
      view.clearError();
      view.setOperationMessage("已清除本页更改，继续使用默认设置。");
      view.focusAfterOperation("reset");
      return;
    }
    await runOperation({
      kind: "reset",
      request: (signal) => api.delete(policyViewUrl(policySitePath(item.site)), { signal }),
      successMessage: "该站点已恢复默认设置。",
    });
  };

  const switchSite = async (siteId) => {
    if (!getPolicySiteDefinition(siteId) || siteId === view.getSelectedSite()) {
      view.restoreSourceSelection();
      return;
    }
    if (!await confirmDiscard("切换站点")) return;
    view.selectSite(siteId);
    view.clearError();
    view.setOperationMessage("已切换站点；保存后仅影响新建任务。");
  };

  const onClick = async (event) => {
    if (!(event.target instanceof Element)) return;
    const sourceOption = event.target.closest(".policy-source-option");
    if (sourceOption) {
      const radio = sourceOption.querySelector("[data-policy-site]");
      if (!(radio instanceof HTMLInputElement) || radio.disabled) return;
      if (event.target === radio) return;
      event.preventDefault();
      await switchSite(radio.value);
      return;
    }
    const button = event.target.closest("[data-policy-action]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    if (button.dataset.policyAction === "reset") await reset();
  };

  const onChange = async (event) => {
    if (event.target instanceof HTMLInputElement && event.target.matches("[data-policy-site]")) {
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
    if (!active || (!view.isDirty() && !busy)) return;
    event.preventDefault();
    event.returnValue = "";
  };

  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  root.addEventListener("input", onInput);
  root.addEventListener("submit", onSubmit);
  globalThis.addEventListener?.("beforeunload", onBeforeUnload);

  return Object.freeze({
    beforeLeave() {
      return confirmDiscard("切换应用");
    },
    beforeWindowHide(visibility) {
      return confirmDiscard(visibility === "closed" ? "关闭窗口" : "最小化窗口");
    },
    activate() {
      if (destroyed || active) return;
      active = true;
      requestGate.advanceLifecycle();
      root.hidden = false;
      setElementInert(root, false);
      root.dataset.lifecycle = "active";
      view.clearDraft();
      view.clearError();
      view.setOperationMessage("正在加载站点设置……");
      void readConfig(null, { replace: true, report: true })
        .then((loaded) => {
          if (loaded && active) view.setOperationMessage("站点设置已加载。");
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
  beforeLeave() {
    return controller?.beforeLeave() ?? true;
  },
  beforeWindowHide(_context, visibility) {
    return controller?.beforeWindowHide(visibility) ?? true;
  },
  deactivate() {
    controller?.deactivate();
  },
  unmount() {
    controller?.destroy();
    controller = null;
  },
});
