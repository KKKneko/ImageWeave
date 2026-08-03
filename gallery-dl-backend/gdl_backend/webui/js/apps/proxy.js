import { isAbortError } from "../core/api.js";
import { setElementInert } from "../core/dom.js";
import { splitInlineNodeInput } from "../core/proxy-model.js";
import { actionCreators } from "../core/store.js";
import { createProxyView } from "../components/proxy-view.js";

export const PROXY_ENDPOINTS = Object.freeze({
  status: "/api/v1/proxy/status",
  start: "/api/v1/proxy/start",
  reload: "/api/v1/proxy/reload",
  probe: "/api/v1/proxy/probe",
  stop: "/api/v1/proxy/stop",
  sources: "/api/v1/proxy/sources",
  subscriptions: "/api/v1/proxy/sources/subscriptions",
  nodeFile: "/api/v1/proxy/sources/node-file",
  inlineNodes: "/api/v1/proxy/sources/inline-nodes",
  override: "/api/v1/proxy/sources/override",
});

const STATUS_POLL_KEY = "proxy.status";
const STATUS_POLL_INTERVAL_MS = 10_000;

function createProxyController(context) {
  const { root, api, store, polling, dialogs } = context;
  const view = createProxyView(context);
  let active = false;
  let destroyed = false;
  let busy = "";
  let lifecycleVersion = 0;
  let writeVersion = 0;
  let operationSequence = 0;
  let activeOperationController = null;
  let statusRead = null;
  let sourcesRead = null;
  let statusSequence = 0;
  let sourcesSequence = 0;
  let appliedStatusSequence = 0;
  let appliedSourcesSequence = 0;

  const currentStatus = () => store.getState().proxy.status;
  const currentSources = () => store.getState().proxy.sources;

  const linkSignal = (externalSignal, controller) => {
    if (!externalSignal) return () => {};
    const abort = () => controller.abort();
    if (externalSignal.aborted) abort();
    else externalSignal.addEventListener("abort", abort, { once: true });
    return () => externalSignal.removeEventListener("abort", abort);
  };

  const abortRead = (entry) => {
    entry?.controller.abort();
  };

  const readStatus = async (externalSignal, { replace = false, report = true } = {}) => {
    if (!active || destroyed) return false;
    if (statusRead) {
      if (!replace) return statusRead.promise;
      abortRead(statusRead);
      try {
        await statusRead.promise;
      } catch {
        // 被替换的读取已由原调用方处理。
      }
      if (!active || destroyed) return false;
    }
    const controller = new AbortController();
    const unlink = linkSignal(externalSignal, controller);
    const sequence = ++statusSequence;
    const readLifecycle = lifecycleVersion;
    const readWriteVersion = writeVersion;
    const promise = api.get(PROXY_ENDPOINTS.status, { signal: controller.signal })
      .then((payload) => {
        if (
          !active || destroyed || controller.signal.aborted ||
          readLifecycle !== lifecycleVersion || readWriteVersion !== writeVersion ||
          sequence < appliedStatusSequence
        ) return false;
        store.dispatch(actionCreators.proxyStatusReceived(payload));
        appliedStatusSequence = sequence;
        return true;
      })
      .catch((error) => {
        if (isAbortError(error) || controller.signal.aborted) return false;
        if (active && (report || !currentStatus())) view.showError(error);
        throw error;
      })
      .finally(() => {
        unlink();
        if (statusRead?.promise === promise) statusRead = null;
      });
    statusRead = { controller, promise };
    return promise;
  };

  const readSources = async (externalSignal, { replace = false, report = true } = {}) => {
    if (!active || destroyed) return false;
    if (sourcesRead) {
      if (!replace) return sourcesRead.promise;
      abortRead(sourcesRead);
      try {
        await sourcesRead.promise;
      } catch {
        // 被替换的读取已由原调用方处理。
      }
      if (!active || destroyed) return false;
    }
    const controller = new AbortController();
    const unlink = linkSignal(externalSignal, controller);
    const sequence = ++sourcesSequence;
    const readLifecycle = lifecycleVersion;
    const readWriteVersion = writeVersion;
    const promise = api.get(PROXY_ENDPOINTS.sources, { signal: controller.signal })
      .then((payload) => {
        if (
          !active || destroyed || controller.signal.aborted ||
          readLifecycle !== lifecycleVersion || readWriteVersion !== writeVersion ||
          sequence < appliedSourcesSequence
        ) return false;
        store.dispatch(actionCreators.proxySourcesReceived(payload));
        appliedSourcesSequence = sequence;
        return true;
      })
      .catch((error) => {
        if (isAbortError(error) || controller.signal.aborted) return false;
        if (active && (report || !currentSources())) view.showError(error);
        throw error;
      })
      .finally(() => {
        unlink();
        if (sourcesRead?.promise === promise) sourcesRead = null;
      });
    sourcesRead = { controller, promise };
    return promise;
  };

  const refreshBoth = async ({ report = true } = {}) => {
    const outcomes = await Promise.allSettled([
      readStatus(null, { replace: true, report }),
      readSources(null, { replace: true, report }),
    ]);
    const rejection = outcomes.find((outcome) => outcome.status === "rejected");
    if (rejection) throw rejection.reason;
    return true;
  };

  const setBusy = (kind) => {
    busy = kind;
    view.setBusy(kind);
  };

  const invalidateReadsForWrite = () => {
    writeVersion += 1;
    abortRead(statusRead);
    abortRead(sourcesRead);
  };

  const runOperation = async ({ kind, request, successMessage, writes = true }) => {
    if (!active || destroyed || busy) return false;
    const operation = ++operationSequence;
    if (writes) invalidateReadsForWrite();
    else {
      abortRead(statusRead);
      abortRead(sourcesRead);
    }
    view.clearError();
    setBusy(kind);
    view.setOperationMessage(
      kind === "refresh" ? "正在刷新代理状态和节点来源……" : "正在执行代理操作，请勿重复提交……",
    );
    const controller = new AbortController();
    activeOperationController = controller;
    try {
      if (request) await request(controller.signal);
      if (!active || destroyed || controller.signal.aborted) return false;
      await refreshBoth({ report: false });
      if (!active || destroyed || controller.signal.aborted) return false;
      view.clearError();
      view.setOperationMessage(successMessage);
      return true;
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted || !active) return false;
      try {
        await refreshBoth({ report: false });
      } catch {
        // 保留原操作错误；刷新失败不能覆盖更有用的安全指引。
      }
      view.showError(error);
      view.setOperationMessage("操作失败，当前列表已保留。请刷新后重试。");
      return false;
    } finally {
      if (activeOperationController === controller) activeOperationController = null;
      if (operation === operationSequence) setBusy("");
    }
  };

  const runSecretOperation = async ({
    kind,
    input,
    request,
    successMessage,
    transform = (value) => value,
  }) => {
    let secret = input.value;
    let payload = null;
    let capturedPayload = null;
    input.value = "";
    try {
      payload = transform(secret);
      if (
        (Array.isArray(payload) && !payload.length) ||
        (!Array.isArray(payload) && !String(payload || "").trim())
      ) {
        view.showError({
          code: kind === "inline-add" ? "invalid_proxy_inline_node" : "request_failed",
          message: kind === "inline-add" ? "请至少输入一个非空节点" : "请输入完整的新值",
          status: 422,
          details: null,
        });
        view.setOperationMessage("请填写要保存的节点来源。");
        return false;
      }
      capturedPayload = payload;
      secret = "";
      payload = null;
      return await runOperation({
        kind,
        request: (signal) => {
          try {
            return request(capturedPayload, signal);
          } finally {
            // context.api 已同步完成 JSON 序列化；不让局部秘密等待后续 GET 刷新。
            capturedPayload = null;
          }
        },
        successMessage,
      });
    } finally {
      secret = "";
      payload = null;
      capturedPayload = null;
      input.value = "";
    }
  };

  const requireMutableSources = () => {
    const sources = currentSources();
    if (sources?.runtime_override_valid) return true;
    view.showError({
      code: "proxy_sources_store_error",
      message: "界面自定义节点来源无效",
      status: 409,
      details: { reason: "invalid_runtime_override" },
    });
    return false;
  };

  const confirm = async (options) => {
    const choice = await dialogs.open(options);
    if (choice !== "confirm") {
      view.clearSecretInputs();
      view.setOperationMessage("已取消操作，敏感输入已清空。");
      return false;
    }
    return active && !destroyed;
  };

  const deleteSubscription = async (sourceId) => {
    if (!requireMutableSources()) return;
    if (!await confirm({
      title: "删除订阅？",
      message: "将删除该订阅。运行中的代理池不会自动改变。",
      confirmLabel: "删除订阅",
      dangerous: true,
      confirmationText: "删除后点击“应用并重新加载”才会生效。",
    })) return;
    await runOperation({
      kind: "subscription-delete",
      request: (signal) => api.delete(
        `${PROXY_ENDPOINTS.subscriptions}/${encodeURIComponent(sourceId)}`,
        { signal },
      ),
      successMessage: "订阅已删除；点击“应用并重新加载”后生效。",
    });
  };

  const deleteInlineNode = async (sourceId) => {
    if (!requireMutableSources()) return;
    if (!await confirm({
      title: "删除手动节点？",
      message: "将删除该手动节点。运行中的代理池不会自动改变。",
      confirmLabel: "删除节点",
      dangerous: true,
      confirmationText: "删除后点击“应用并重新加载”才会生效。",
    })) return;
    await runOperation({
      kind: "inline-delete",
      request: (signal) => api.delete(
        `${PROXY_ENDPOINTS.inlineNodes}/${encodeURIComponent(sourceId)}`,
        { signal },
      ),
      successMessage: "手动节点已删除；点击“应用并重新加载”后生效。",
    });
  };

  const clearNodeFile = async () => {
    if (!requireMutableSources()) return;
    if (!await confirm({
      title: "清除节点文件？",
      message: "节点来源将不再引用当前文件；磁盘上的文件不会被删除。",
      confirmLabel: "清除引用",
      dangerous: true,
      confirmationText: "运行中的代理池保持不变，点击“应用并重新加载”后生效。",
    })) return;
    await runOperation({
      kind: "node-file-clear",
      request: (signal) => api.delete(PROXY_ENDPOINTS.nodeFile, { signal }),
      successMessage: "节点文件引用已清除；点击“应用并重新加载”后生效。",
    });
  };

  const resetOverride = async () => {
    const sources = currentSources();
    if (!sources?.has_runtime_override) return;
    if (!await confirm({
      title: "恢复配置文件中的节点来源？",
      message: "将删除界面保存的节点来源，并恢复配置文件默认值。",
      confirmLabel: "恢复默认设置",
      dangerous: true,
      confirmationText: "运行中的代理池不会自动改变；有配置待应用时，页面会继续提示。",
    })) return;
    await runOperation({
      kind: "override-reset",
      request: (signal) => api.delete(PROXY_ENDPOINTS.override, { signal }),
      successMessage: "已恢复配置文件默认值；运行中的代理池尚未改变。",
    });
  };

  const openReplacement = (button) => {
    if (!requireMutableSources()) return;
    const card = button.closest(".proxy-source-card");
    const form = card?.querySelector(".proxy-replace-form");
    if (!(form instanceof HTMLFormElement)) return;
    view.clearSecretInputs();
    for (const other of root.querySelectorAll(".proxy-replace-form")) {
      if (other !== form) other.hidden = true;
    }
    form.hidden = false;
    const input = form.querySelector("[data-proxy-secret]");
    if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
      input.focus({ preventScroll: true });
    }
  };

  const onRuntimeAction = (action) => {
    if (action === "refresh") {
      return runOperation({
        kind: "refresh",
        writes: false,
        request: null,
        successMessage: "代理状态和节点来源已刷新。",
      });
    }
    const request = {
      start: (signal) => api.post(PROXY_ENDPOINTS.start, { force_refresh: true }, { signal }),
      stop: (signal) => api.post(PROXY_ENDPOINTS.stop, { force: false }, { signal }),
      reload: (signal) => api.post(PROXY_ENDPOINTS.reload, { force_refresh: true }, { signal }),
      probe: (signal) => api.post(PROXY_ENDPOINTS.probe, {}, { signal }),
    }[action];
    const successMessage = {
      start: "代理池已启动，状态已刷新。",
      stop: "代理池已停止，现有任务未被强制中断。",
      reload: "节点来源已应用，配置版本已更新。",
      probe: "全部节点检测完成，状态已刷新。",
    }[action];
    return runOperation({ kind: action, request, successMessage });
  };

  const onClick = async (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-proxy-action]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    const action = button.dataset.proxyAction;
    if (["start", "stop", "reload", "probe", "refresh"].includes(action)) {
      await onRuntimeAction(action);
      return;
    }
    if (action === "subscription-replace-open" || action === "inline-replace-open") {
      openReplacement(button);
      return;
    }
    if (action === "replacement-cancel") {
      const form = button.closest("form");
      if (form) {
        view.clearSecretInputs(form);
        form.hidden = true;
      }
      view.setOperationMessage("已取消替换，敏感输入已清空。");
      return;
    }
    if (action === "subscription-delete") {
      await deleteSubscription(button.closest("[data-source-id]")?.dataset.sourceId || "");
      return;
    }
    if (action === "inline-delete") {
      await deleteInlineNode(button.closest("[data-source-id]")?.dataset.sourceId || "");
      return;
    }
    if (action === "node-file-clear") {
      await clearNodeFile();
      return;
    }
    if (action === "override-reset") await resetOverride();
  };

  const onSubmit = async (event) => {
    if (!(event.target instanceof HTMLFormElement) || !event.target.dataset.proxyForm) return;
    event.preventDefault();
    const form = event.target;
    if (busy || !requireMutableSources()) {
      view.clearSecretInputs(form);
      return;
    }
    const input = form.querySelector("[data-proxy-secret]");
    if (!(input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement)) return;
    const kind = form.dataset.proxyForm;
    if (kind === "subscription-add") {
      await runSecretOperation({
        kind,
        input,
        request: (url, signal) => api.post(PROXY_ENDPOINTS.subscriptions, { url }, { signal }),
        successMessage: "订阅已保存；点击“应用并重新加载”后生效。",
        transform: (value) => value.trim(),
      });
      return;
    }
    if (kind === "subscription-replace") {
      const sourceId = form.dataset.sourceId || "";
      await runSecretOperation({
        kind,
        input,
        request: (url, signal) => api.put(
          `${PROXY_ENDPOINTS.subscriptions}/${encodeURIComponent(sourceId)}`,
          { url },
          { signal },
        ),
        successMessage: "订阅已更新；原地址不会重新显示，点击“应用并重新加载”后生效。",
        transform: (value) => value.trim(),
      });
      form.hidden = true;
      return;
    }
    if (kind === "node-file-set") {
      await runSecretOperation({
        kind,
        input,
        request: (path, signal) => api.put(PROXY_ENDPOINTS.nodeFile, { path }, { signal }),
        successMessage: "节点文件已保存；点击“应用并重新加载”后生效。",
        transform: (value) => value.trim(),
      });
      return;
    }
    if (kind === "inline-add") {
      await runSecretOperation({
        kind,
        input,
        request: (nodes, signal) => api.post(PROXY_ENDPOINTS.inlineNodes, { nodes }, { signal }),
        successMessage: "手动节点已保存；完整节点信息已清空，点击“应用并重新加载”后生效。",
        transform: splitInlineNodeInput,
      });
      return;
    }
    if (kind === "inline-replace") {
      const sourceId = form.dataset.sourceId || "";
      await runSecretOperation({
        kind,
        input,
        request: (node, signal) => api.put(
          `${PROXY_ENDPOINTS.inlineNodes}/${encodeURIComponent(sourceId)}`,
          { node },
          { signal },
        ),
        successMessage: "手动节点已更新；原节点不会重新显示，点击“应用并重新加载”后生效。",
        transform: (value) => value.trim(),
      });
      form.hidden = true;
    }
  };

  root.addEventListener("click", onClick);
  root.addEventListener("submit", onSubmit);

  return Object.freeze({
    activate() {
      if (destroyed || active) return;
      active = true;
      lifecycleVersion += 1;
      root.hidden = false;
      setElementInert(root, false);
      root.dataset.lifecycle = "active";
      view.setOperationMessage("正在加载代理状态和节点来源……");
      void readSources(null, { replace: true, report: true }).catch(() => {});
      polling.start({
        key: STATUS_POLL_KEY,
        scope: context.pollingScope,
        intervalMs: STATUS_POLL_INTERVAL_MS,
        immediate: true,
        critical: false,
        resume: "immediate",
        task(signal) {
          if (busy) return Promise.resolve(false);
          return readStatus(signal, { replace: false, report: false });
        },
      });
    },

    deactivate() {
      if (destroyed) return;
      active = false;
      lifecycleVersion += 1;
      operationSequence += 1;
      activeOperationController?.abort();
      activeOperationController = null;
      abortRead(statusRead);
      abortRead(sourcesRead);
      view.clearSecretInputs();
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
      lifecycleVersion += 1;
      operationSequence += 1;
      activeOperationController?.abort();
      abortRead(statusRead);
      abortRead(sourcesRead);
      view.clearSecretInputs();
      root.removeEventListener("click", onClick);
      root.removeEventListener("submit", onSubmit);
      view.destroy();
      root.removeAttribute("data-lifecycle");
    },
  });
}

let controller = null;

export default Object.freeze({
  mount(context) {
    if (controller) throw new Error("PROXY.CPL 已挂载");
    controller = createProxyController(context);
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
