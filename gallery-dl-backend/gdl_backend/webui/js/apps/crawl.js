import { isAbortError } from "../core/api.js";
import {
  buildCrawlPayload,
  buildSearchPayload,
  crawlErrorGuidance,
  projectCrawlSearchResponse,
  sanitizeAutocompleteResponse,
} from "../core/crawl-model.js";
import { setElementInert } from "../core/dom.js";
import { actionCreators } from "../core/store.js";
import { createCrawlView } from "../components/crawl-view.js";

export const CRAWL_ENDPOINTS = Object.freeze({
  search: "/api/v1/search",
  autocomplete: "/api/v1/search/autocomplete",
  crawls: "/api/v1/crawls",
});

const AUTOCOMPLETE_DELAY_MS = 300;

function createCrawlController(context) {
  const { root, api, store, actions } = context;
  const view = createCrawlView(context);
  let active = false;
  let destroyed = false;
  let busy = "";
  let lifecycle = 0;
  let autocompleteTimer = null;
  let autocompleteController = null;
  let autocompleteSequence = 0;
  let operationController = null;
  let operationSequence = 0;
  let addressOperations = new Map();

  const stopAutocomplete = () => {
    if (autocompleteTimer !== null) clearTimeout(autocompleteTimer);
    autocompleteTimer = null;
    autocompleteController?.abort();
    autocompleteController = null;
    autocompleteSequence += 1;
  };

  const setBusy = (kind) => {
    busy = kind;
    view.setBusy(kind);
  };

  const showError = (error) => {
    if (!isAbortError(error)) view.showError(crawlErrorGuidance(error));
  };

  const requestAutocomplete = () => {
    stopAutocomplete();
    if (!active || destroyed) return;
    const query = view.elements.keyword.value.trim();
    if (query.length < 2) {
      view.hideSuggestions();
      return;
    }
    const requestLifecycle = lifecycle;
    const sequence = ++autocompleteSequence;
    autocompleteTimer = setTimeout(async () => {
      autocompleteTimer = null;
      const controller = new AbortController();
      autocompleteController = controller;
      try {
        const response = await api.get(
          `${CRAWL_ENDPOINTS.autocomplete}?q=${encodeURIComponent(query)}&limit=10`,
          { signal: controller.signal },
        );
        if (!active || destroyed || controller.signal.aborted || requestLifecycle !== lifecycle ||
            sequence !== autocompleteSequence || view.elements.keyword.value.trim() !== query) return;
        view.setSuggestions(sanitizeAutocompleteResponse(response));
      } catch (error) {
        if (!isAbortError(error) && sequence === autocompleteSequence) view.hideSuggestions();
      } finally {
        if (autocompleteController === controller) autocompleteController = null;
      }
    }, AUTOCOMPLETE_DELAY_MS);
  };

  const runSearch = async () => {
    if (!active || destroyed || busy) return false;
    let payload;
    try {
      payload = buildSearchPayload(view.readSearchDraft());
    } catch (error) {
      showError({ code: "invalid_search", status: 422, message: error.message });
      view.setOperationMessage("没有发送未通过本地校验的搜索请求。");
      return false;
    }
    const operation = ++operationSequence;
    const requestLifecycle = lifecycle;
    operationController?.abort();
    const controller = new AbortController();
    operationController = controller;
    stopAutocomplete();
    view.hideSuggestions();
    view.clearError();
    setBusy("search");
    view.setOperationMessage("正在查询真实来源并归并候选；离开应用会取消本次请求…");
    let captured = payload;
    payload = null;
    try {
      const promise = api.post(CRAWL_ENDPOINTS.search, captured, { signal: controller.signal });
      captured = null;
      const response = await promise;
      if (!active || destroyed || controller.signal.aborted || requestLifecycle !== lifecycle ||
          operation !== operationSequence) return false;
      const projection = projectCrawlSearchResponse(response);
      addressOperations = projection.operations;
      store.dispatch(actionCreators.crawlSearchReceived(response));
      view.clearError();
      view.setOperationMessage(
        `✓ 搜索完成：${projection.snapshot.addressCount} 个候选，${projection.snapshot.weakEvidenceCount} 个弱证据。`,
      );
      return true;
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) return false;
      if (active && requestLifecycle === lifecycle) showError(error);
      view.setOperationMessage("搜索未完成；上一次安全结果仍保留，可修正前置条件后重试。");
      return false;
    } finally {
      captured = null;
      if (operationController === controller) operationController = null;
      if (operation === operationSequence) setBusy("");
    }
  };

  const createBatch = async () => {
    if (!active || destroyed || busy) return false;
    let payload;
    try {
      payload = buildCrawlPayload({
        snapshot: store.getState().crawl,
        operations: addressOperations,
        ...view.readCrawlDraft(),
      });
    } catch (error) {
      showError({ code: "invalid_crawl", status: 422, message: error.message });
      view.setOperationMessage("没有发送未通过本地校验的批次请求。");
      return false;
    }
    const operation = ++operationSequence;
    const requestLifecycle = lifecycle;
    const controller = new AbortController();
    operationController = controller;
    view.clearError();
    setBusy("crawl");
    view.setOperationMessage("正在创建顺序批次；重复点击已禁用并附带新的幂等键…");
    let captured = payload;
    payload = null;
    try {
      const promise = api.post(CRAWL_ENDPOINTS.crawls, captured, {
        signal: controller.signal,
        idempotencyKey: true,
      });
      captured = null;
      view.clearOutputInput();
      const batch = await promise;
      if (!active || destroyed || controller.signal.aborted || requestLifecycle !== lifecycle ||
          operation !== operationSequence) return false;
      const batchId = typeof batch?.id === "string" ? batch.id : "";
      actions.setActiveBatchId(batchId);
      store.dispatch(actionCreators.batchSnapshotReceived(batch, { items: [] }));
      view.setOperationMessage("✓ 批次已由后端确认创建，正在打开 TASKMGR.EXE。 ");
      actions.navigateToApp("tasks");
      return true;
    } catch (error) {
      if (isAbortError(error) || controller.signal.aborted) return false;
      if (active && requestLifecycle === lifecycle) showError(error);
      view.setOperationMessage("批次未创建；选择与顺序仍保留，可修正后重试。");
      return false;
    } finally {
      captured = null;
      view.clearOutputInput();
      if (operationController === controller) operationController = null;
      if (operation === operationSequence) setBusy("");
    }
  };

  const onSubmit = async (event) => {
    if (!(event.target instanceof HTMLFormElement)) return;
    if (event.target.dataset.crawlForm === "search") {
      event.preventDefault();
      await runSearch();
    } else if (event.target.dataset.crawlForm === "submit") {
      event.preventDefault();
      await createBatch();
    }
  };

  const onPointerDown = (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.closest('[data-crawl-action="suggestion"]')) event.preventDefault();
  };

  const onClick = (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-crawl-action]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    const action = button.dataset.crawlAction;
    if (action === "suggestion") {
      view.elements.keyword.value = button.dataset.suggestionValue || "";
      view.hideSuggestions();
      view.elements.keyword.focus({ preventScroll: true });
      return;
    }
    if (action === "open-vault") return actions.navigateToApp("vault");
    if (action === "open-proxy") return actions.navigateToApp("proxy");
    if (action === "select-visible") {
      const keys = view.visibleCandidateKeys();
      store.dispatch(actionCreators.crawlVisibleSelectionChanged(keys, true));
      return;
    }
    if (action === "clear-selection") {
      const keys = store.getState().crawl.sources.flatMap((source) =>
        source.addresses.map((candidate) => candidate.key));
      store.dispatch(actionCreators.crawlVisibleSelectionChanged(keys, false));
      return;
    }
    if (action === "eh-clear") {
      store.dispatch(actionCreators.crawlEhFilterCleared());
      view.elements.ehTagQuery.value = "";
      view.setEhQuery("");
      return;
    }
    if (action === "eh-cycle") {
      const next = button.dataset.tagMode === "none"
        ? "include"
        : button.dataset.tagMode === "include"
          ? "exclude"
          : "";
      store.dispatch(actionCreators.crawlEhFilterChanged(button.dataset.tagKey || "", next));
      return;
    }
    const source = button.closest("[data-source-key]");
    const sourceKey = source?.dataset.sourceKey || "";
    if (action === "source-toggle") {
      const keys = view.sourceVisibleKeys(sourceKey);
      const snapshot = store.getState().crawl;
      const candidates = snapshot.sources.find((item) => item.key === sourceKey)?.addresses || [];
      const selectedByKey = new Map(candidates.map((item) => [item.key, item.selected]));
      const selected = keys.some((key) => !selectedByKey.get(key));
      store.dispatch(actionCreators.crawlVisibleSelectionChanged(keys, selected));
      return;
    }
    if (action === "source-up" || action === "source-down") {
      store.dispatch(actionCreators.crawlSourceMoved(sourceKey, action === "source-up" ? -1 : 1));
      return;
    }
    const candidateKey = button.closest("[data-candidate-key]")?.dataset.candidateKey || "";
    if (action === "candidate-up" || action === "candidate-down") {
      store.dispatch(actionCreators.crawlCandidateMoved(
        sourceKey,
        candidateKey,
        action === "candidate-up" ? -1 : 1,
      ));
    }
  };

  const onChange = (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement && target.dataset.crawlCandidateToggle) {
      store.dispatch(actionCreators.crawlCandidateSelectionChanged(
        target.dataset.crawlCandidateToggle,
        target.checked,
      ));
      return;
    }
    if (target instanceof HTMLInputElement && target.matches("[data-crawl-weak-toggle]")) {
      store.dispatch(actionCreators.crawlWeakVisibilityChanged(target.checked));
      return;
    }
    if (target instanceof HTMLSelectElement && ["search-proxy", "crawl-proxy"].includes(target.name)) {
      view.renderPreconditions();
    }
    if (target instanceof HTMLInputElement && target.name === "eh-image-mode") {
      view.elements.gpPolicy.disabled = target.value === "resample" && target.checked;
    }
  };

  const onInput = (event) => {
    const target = event.target;
    if (target === view.elements.keyword) requestAutocomplete();
    if (target === view.elements.ehTagQuery) view.setEhQuery(target.value);
  };

  const onFocusOut = (event) => {
    if (event.target !== view.elements.keyword) return;
    setTimeout(() => {
      if (!view.elements.suggestions.contains(document.activeElement)) view.hideSuggestions();
    }, 0);
  };

  const onKeyDown = (event) => {
    if (event.key === "Escape" && !view.elements.suggestions.hidden) {
      event.preventDefault();
      view.hideSuggestions();
      view.elements.keyword.focus({ preventScroll: true });
    }
  };

  root.addEventListener("submit", onSubmit);
  root.addEventListener("pointerdown", onPointerDown);
  root.addEventListener("click", onClick);
  root.addEventListener("change", onChange);
  root.addEventListener("input", onInput);
  root.addEventListener("focusout", onFocusOut);
  root.addEventListener("keydown", onKeyDown);

  return Object.freeze({
    activate() {
      if (destroyed || active) return;
      active = true;
      lifecycle += 1;
      root.hidden = false;
      setElementInert(root, false);
      root.dataset.lifecycle = "active";
      view.renderPreconditions();
      view.setOperationMessage(store.getState().crawl.sources.length
        ? "上一次安全搜索结果仍在内存中；查询与输出目录未写入 Storage。"
        : "输入关键词并选择来源；所有请求只通过同源 context.api。 ");
    },
    deactivate() {
      if (destroyed) return;
      active = false;
      lifecycle += 1;
      operationSequence += 1;
      stopAutocomplete();
      operationController?.abort();
      operationController = null;
      busy = "";
      view.setBusy("");
      view.hideSuggestions();
      view.clearOutputInput();
      root.hidden = true;
      setElementInert(root, true);
      root.dataset.lifecycle = "inactive";
    },
    destroy() {
      if (destroyed) return;
      active = false;
      destroyed = true;
      lifecycle += 1;
      operationSequence += 1;
      stopAutocomplete();
      operationController?.abort();
      addressOperations.clear();
      root.removeEventListener("submit", onSubmit);
      root.removeEventListener("pointerdown", onPointerDown);
      root.removeEventListener("click", onClick);
      root.removeEventListener("change", onChange);
      root.removeEventListener("input", onInput);
      root.removeEventListener("focusout", onFocusOut);
      root.removeEventListener("keydown", onKeyDown);
      view.destroy();
      root.removeAttribute("data-lifecycle");
    },
  });
}

let controller = null;

export default Object.freeze({
  mount(context) {
    if (controller) throw new Error("CRAWL.EXE 已挂载");
    controller = createCrawlController(context);
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
