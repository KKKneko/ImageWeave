import { createElement } from "../core/dom.js";
import {
  CRAWL_SITE_DEFINITIONS,
  crawlCandidateVisible,
} from "../core/crawl-model.js";
import { selectors } from "../core/store.js";
import { createEmptyState } from "./empty-state.js";
import { createErrorView } from "./error-view.js";
import { createStatusBadge } from "./status.js";

const CATEGORY_LABELS = Object.freeze({
  artist: "画师", character: "角色", copyright: "作品", general: "标签", meta: "META",
});
const CONFIDENCE_LABELS = Object.freeze({
  verified: "已验证", site_search: "站内候选", weak: "弱证据",
});
const TAG_MODE_LABELS = Object.freeze({ include: "包含", exclude: "排除", none: "未筛选" });

function button(action, label, { primary = false, dangerous = false, small = false } = {}) {
  return createElement("button", {
    className: [
      "crawl-button",
      primary ? "crawl-button--primary" : "",
      dangerous ? "crawl-button--dangerous" : "",
      small ? "crawl-button--small" : "",
    ].filter(Boolean).join(" "),
    text: label,
    attributes: { type: "button" },
    dataset: { crawlAction: action },
  });
}

function field(label, control, help = "") {
  return createElement("label", { className: "crawl-field" }, [
    createElement("span", { text: label }),
    control,
    ...(help ? [createElement("small", { text: help })] : []),
  ]);
}

function selectProxyMode(name, value = "required", { inherit = false } = {}) {
  const select = createElement("select", {
    attributes: { name, "aria-label": name },
  });
  if (inherit) select.append(createElement("option", { text: "继承全局", attributes: { value: "" } }));
  for (const [mode, label] of [
    ["required", "必须使用代理池"], ["prefer", "优先代理池"], ["direct", "直连"],
  ]) {
    const option = createElement("option", { text: label, attributes: { value: mode } });
    option.selected = mode === value;
    select.append(option);
  }
  return select;
}

function buildDom(context) {
  const { root, app } = context;
  const headingId = "crawl-heading";
  const keyword = createElement("input", {
    attributes: {
      type: "search", name: "keyword", maxlength: "1000", autocomplete: "off",
      placeholder: "画师、角色或作品关键词", required: "",
      "aria-controls": "crawl-suggestions",
    },
    dataset: { crawlInput: "keyword" },
  });
  const suggestions = createElement("div", {
    className: "crawl-suggestions",
    attributes: { id: "crawl-suggestions", role: "listbox", hidden: "" },
  });
  const keywordField = field("关键词", keyword, "至少 2 个字符时查询 Danbooru 补全；输入不会写入 Storage。");
  keywordField.classList.add("crawl-field--keyword");
  keywordField.append(suggestions);

  const searchLimit = createElement("input", {
    attributes: { type: "number", name: "search-limit", min: "1", max: "200", value: "20" },
  });
  const searchProxy = selectProxyMode("search-proxy", "required");
  const sitePicker = createElement("fieldset", { className: "crawl-site-picker" }, [
    createElement("legend", { text: "搜索来源（提交时保持当前顺序）" }),
    ...CRAWL_SITE_DEFINITIONS.map((site) => {
      const input = createElement("input", {
        attributes: { type: "checkbox", name: "crawl-site", value: site.id, checked: "" },
      });
      input.checked = true;
      return createElement("label", {}, [input, createElement("span", { text: site.label })]);
    }),
  ]);

  const sourceOverrides = createElement("div", { className: "crawl-source-overrides" });
  for (const site of CRAWL_SITE_DEFINITIONS) {
    sourceOverrides.append(createElement("label", {}, [
      createElement("strong", { text: site.label }),
      selectProxyMode(`source-${site.id}`, "", { inherit: true }),
    ]));
  }

  const searchButton = createElement("button", {
    className: "crawl-button crawl-button--primary",
    text: "搜索候选图库",
    attributes: { type: "submit" },
    dataset: { operationKind: "search" },
  });
  const searchForm = createElement("form", { className: "crawl-search-form", dataset: { crawlForm: "search" } }, [
    createElement("div", { className: "crawl-search-grid" }, [
      keywordField,
      field("证据上限", searchLimit),
      field("搜索路由", searchProxy),
    ]),
    sitePicker,
    createElement("details", { className: "crawl-advanced" }, [
      createElement("summary", { text: "来源级路由覆盖" }),
      createElement("p", { text: "只发送实际选择的覆盖；空值继承全局搜索或下载路由。" }),
      sourceOverrides,
    ]),
    createElement("div", { className: "crawl-form-actions" }, [searchButton]),
  ]);

  const weakToggle = createElement("input", {
    attributes: { type: "checkbox" },
    dataset: { crawlWeakToggle: "" },
  });
  const sourceHost = createElement("div", { className: "crawl-source-list", dataset: { crawlSources: "" } });
  const ehTagQuery = createElement("input", {
    attributes: { type: "search", placeholder: "查找 EH 标签", autocomplete: "off" },
    dataset: { crawlEhQuery: "" },
  });
  const ehFilterHost = createElement("section", {
    className: "crawl-eh-filter",
    attributes: { hidden: "", "aria-labelledby": "crawl-eh-title" },
    dataset: { crawlEhFilter: "" },
  }, [
    createElement("div", { className: "crawl-panel-heading" }, [
      createElement("div", {}, [
        createElement("h3", { text: "EH 标签筛选", attributes: { id: "crawl-eh-title" } }),
        createElement("p", { text: "同命名空间取任一，跨命名空间同时满足；排除条件优先。" }),
      ]),
      field("筛选标签列表", ehTagQuery),
    ]),
    createElement("p", { className: "crawl-eh-summary", dataset: { crawlEhSummary: "" } }),
    createElement("div", { className: "crawl-eh-groups", dataset: { crawlEhGroups: "" } }),
    button("eh-clear", "清空标签筛选", { small: true }),
  ]);

  const profileHost = createElement("div", { className: "crawl-profiles", dataset: { crawlProfiles: "" } });
  const resultHost = createElement("section", {
    className: "crawl-panel crawl-results-panel",
    attributes: { hidden: "", "aria-labelledby": "crawl-results-title" },
    dataset: { crawlResults: "" },
  }, [
    createElement("div", { className: "crawl-panel-heading" }, [
      createElement("div", {}, [
        createElement("h2", { text: "选择来源与图库地址", attributes: { id: "crawl-results-title" } }),
        createElement("p", { dataset: { crawlResultSummary: "" } }),
      ]),
      createElement("div", { className: "crawl-toolbar" }, [
        createElement("label", { className: "crawl-toggle" }, [weakToggle, createElement("span", { text: "显示弱证据" })]),
        button("select-visible", "全选当前显示", { small: true }),
        button("clear-selection", "清空选择", { small: true }),
      ]),
    ]),
    ehFilterHost,
    sourceHost,
    profileHost,
  ]);

  const concurrency = createElement("input", {
    attributes: { type: "number", min: "1", max: "128", value: "20", name: "concurrency" },
  });
  const maxTasks = createElement("input", {
    attributes: { type: "number", min: "1", max: "100000", value: "10000", name: "max-tasks" },
  });
  const crawlProxy = selectProxyMode("crawl-proxy", "required");
  const outputDir = createElement("input", {
    attributes: {
      type: "text", maxlength: "2048", name: "output-dir", autocomplete: "off",
      placeholder: "可选：相对默认下载目录或后端许可目录",
    },
  });
  const imageOriginal = createElement("input", {
    attributes: { type: "radio", name: "eh-image-mode", value: "original", checked: "" },
  });
  imageOriginal.checked = true;
  const imageResample = createElement("input", {
    attributes: { type: "radio", name: "eh-image-mode", value: "resample" },
  });
  const gpPolicy = createElement("select", { attributes: { name: "eh-gp-policy" } }, [
    createElement("option", { text: "严格原图（失败即停止）", attributes: { value: "stop" } }),
    createElement("option", { text: "允许降级到 1280", attributes: { value: "resized" } }),
  ]);
  const ehOptions = createElement("fieldset", {
    className: "crawl-eh-download",
    attributes: { hidden: "" },
    dataset: { crawlEhDownload: "" },
  }, [
    createElement("legend", { text: "EH 下载" }),
    createElement("div", { className: "crawl-segmented" }, [
      createElement("label", {}, [imageOriginal, createElement("span", { text: "原图" })]),
      createElement("label", {}, [imageResample, createElement("span", { text: "1280" })]),
    ]),
    field("原图 GP 响应", gpPolicy),
  ]);
  const startButton = createElement("button", {
    className: "crawl-button crawl-button--primary",
    text: "按当前顺序创建批次",
    attributes: { type: "submit", disabled: "" },
    dataset: { operationKind: "crawl" },
  });
  const submitForm = createElement("form", {
    className: "crawl-panel crawl-submit-panel",
    attributes: { hidden: "" },
    dataset: { crawlForm: "submit", crawlSubmitPanel: "" },
  }, [
    createElement("div", { className: "crawl-panel-heading" }, [
      createElement("div", {}, [
        createElement("h2", { text: "提交顺序批次" }),
        createElement("p", { text: "来源与地址均按上方顺序执行；创建成功后自动打开 TASKMGR.EXE。" }),
      ]),
      createStatusBadge("disabled", "尚未选择地址"),
    ]),
    ehOptions,
    createElement("div", { className: "crawl-config-grid" }, [
      field("单地址图片并发", concurrency),
      field("任务保护上限", maxTasks),
      field("下载路由", crawlProxy),
      field("输出目录（可选）", outputDir, "不会保存到 Storage；后端仍执行许可目录校验。"),
    ]),
    createElement("div", { className: "crawl-form-actions" }, [startButton]),
  ]);

  const preconditions = createElement("div", { className: "crawl-preconditions", dataset: { crawlPreconditions: "" } });
  const errorHost = createElement("div", { className: "crawl-error-host", dataset: { crawlError: "" } });
  const operationLive = createElement("p", {
    className: "crawl-operation-live",
    text: "输入关键词并选择来源。",
    attributes: { "aria-live": "polite" },
    dataset: { crawlLive: "" },
  });

  root.classList.add("app-view", "crawl-app");
  root.setAttribute("aria-labelledby", headingId);
  root.replaceChildren(
    createElement("header", { className: "app-header crawl-app-header" }, [
      createElement("p", { className: "app-executable", text: app.windowTitle }),
      createElement("h1", { text: app.label, attributes: { id: headingId } }),
      createStatusBadge("ready", "真实搜索与顺序批次"),
      createElement("p", {
        className: "app-summary",
        text: "搜索、弱证据、EH 标签过滤与来源排序均在本应用完成；授权和代理控制通过专属应用修复。",
      }),
    ]),
    preconditions,
    errorHost,
    operationLive,
    createElement("section", { className: "crawl-panel", attributes: { "aria-labelledby": "crawl-search-title" } }, [
      createElement("h2", { text: "聚合关键词搜索", attributes: { id: "crawl-search-title" } }),
      searchForm,
    ]),
    resultHost,
    submitForm,
  );

  return {
    keyword, suggestions, searchLimit, searchProxy, sitePicker, sourceOverrides, searchButton,
    weakToggle, sourceHost, ehTagQuery, ehFilterHost,
    ehSummary: ehFilterHost.querySelector("[data-crawl-eh-summary]"),
    ehGroups: ehFilterHost.querySelector("[data-crawl-eh-groups]"),
    profileHost, resultHost, resultSummary: resultHost.querySelector("[data-crawl-result-summary]"),
    concurrency, maxTasks, crawlProxy, outputDir, imageOriginal, imageResample, gpPolicy,
    ehOptions, submitForm, submitBadge: submitForm.querySelector(".status-badge"), startButton,
    preconditions, errorHost, operationLive,
  };
}

function sourceOptionValues(elements) {
  const result = {};
  for (const site of CRAWL_SITE_DEFINITIONS) {
    const select = elements.sourceOverrides.querySelector(`[name="source-${site.id}"]`);
    if (select?.value) result[site.id] = { proxy_mode: select.value };
  }
  return result;
}

function selectedSites(elements) {
  return [...elements.sitePicker.querySelectorAll('input[name="crawl-site"]:checked')]
    .map((input) => input.value);
}

function focusToken(root) {
  const target = document.activeElement;
  if (!(target instanceof HTMLElement) || !root.contains(target)) return null;
  return {
    action: target.dataset.crawlAction || "",
    candidate: target.closest("[data-candidate-key]")?.dataset.candidateKey || "",
    source: target.closest("[data-source-key]")?.dataset.sourceKey || "",
  };
}

function restoreFocus(root, token) {
  if (!token) return;
  const candidates = [...root.querySelectorAll("button, input")];
  const target = candidates.find((element) =>
    (!token.action || element.dataset.crawlAction === token.action) &&
    (!token.candidate || element.closest("[data-candidate-key]")?.dataset.candidateKey === token.candidate) &&
    (!token.source || element.closest("[data-source-key]")?.dataset.sourceKey === token.source));
  target?.focus({ preventScroll: true });
}

export function createCrawlView(context) {
  const { root, store, actions } = context;
  const elements = buildDom(context);
  let busy = "";
  let renderedError = null;
  let ehQuery = "";

  const clearError = () => {
    renderedError?.destroy();
    renderedError = null;
    elements.errorHost.replaceChildren();
  };

  const showError = (guidance) => {
    clearError();
    renderedError = createErrorView({
      code: guidance.code,
      message: guidance.message,
      requestId: guidance.requestId,
    }, {
      statusLabel: guidance.title,
      nextStep: guidance.nextStep,
      actionLabel: guidance.targetApp === "vault"
        ? "打开 VAULT.CPL"
        : guidance.targetApp === "proxy"
          ? "打开 PROXY.CPL"
          : "打开 DIAG.EXE",
      onAction: () => actions.navigateToApp(guidance.targetApp),
    });
    elements.errorHost.replaceChildren(renderedError.element);
  };

  const setOperationMessage = (message) => {
    elements.operationLive.textContent = message;
  };

  const visibleKeys = (snapshot) => snapshot.sources.flatMap((source) =>
    source.addresses.filter((candidate) => crawlCandidateVisible(snapshot, source, candidate))
      .map((candidate) => candidate.key));

  const renderPreconditions = () => {
    const state = store.getState();
    const notices = [];
    const requiredSites = state.crawl.sources
      .filter((source) => source.auth.known && !source.auth.authorized && source.auth.state === "required");
    if (requiredSites.length) {
      notices.push(createElement("section", { className: "crawl-precondition" }, [
        createStatusBadge("warning", `需要授权：${requiredSites.map((item) => item.label).join("、")}`),
        button("open-vault", "打开 VAULT.CPL", { small: true }),
      ]));
    }
    const proxy = state.system.readiness?.proxy;
    const proxyNeeded = elements.searchProxy.value !== "direct" || elements.crawlProxy.value !== "direct";
    if (proxyNeeded && proxy && !proxy.running && proxy.status !== "disabled") {
      notices.push(createElement("section", { className: "crawl-precondition" }, [
        createStatusBadge("warning", "代理池尚未运行"),
        button("open-proxy", "打开 PROXY.CPL", { small: true }),
      ]));
    }
    elements.preconditions.replaceChildren(...notices);
  };

  const renderEhFilter = (snapshot) => {
    const source = snapshot.sources.find((item) => item.site === "exhentai");
    const facets = source?.tagFacets || [];
    elements.ehFilterHost.hidden = !facets.length;
    if (!facets.length) {
      elements.ehGroups.replaceChildren();
      return;
    }
    const total = source.addresses.filter((candidate) => !candidate.weak).length;
    const matched = source.addresses.filter((candidate) => !candidate.weak && crawlCandidateVisible(snapshot, source, candidate)).length;
    const hiddenSelected = source.addresses.filter((candidate) =>
      candidate.selected && !crawlCandidateVisible(snapshot, source, candidate)).length;
    const include = [...snapshot.ehTagFilter.values()].filter((mode) => mode === "include").length;
    const exclude = snapshot.ehTagFilter.size - include;
    elements.ehSummary.textContent = snapshot.ehTagFilter.size
      ? `显示 ${matched}/${total} · 包含 ${include} · 排除 ${exclude}${hiddenSelected ? ` · 筛选外已选 ${hiddenSelected}` : ""}`
      : `显示全部 ${total} 个 EH 候选。`;
    const query = ehQuery.trim().toLowerCase();
    const groups = [];
    for (const facet of facets) {
      const tags = facet.tags.filter((tag) =>
        !query || `${facet.namespace} ${facet.label} ${tag.value}`.toLowerCase().includes(query));
      if (!tags.length) continue;
      const details = createElement("details", { className: "crawl-eh-group" });
      details.open = Boolean(query) || tags.some((tag) => snapshot.ehTagFilter.has(tag.key));
      details.append(createElement("summary", {
        text: `${facet.label} · ${facet.galleryCount} 画廊`,
      }));
      const options = createElement("div", { className: "crawl-eh-options" });
      for (const tag of tags) {
        const mode = snapshot.ehTagFilter.get(tag.key) || "none";
        options.append(createElement("button", {
          className: `crawl-eh-tag crawl-eh-tag--${mode}`,
          text: `${tag.value} · ${tag.count} · ${TAG_MODE_LABELS[mode]}`,
          attributes: {
            type: "button",
            "aria-label": `${facet.label} ${tag.value}，${TAG_MODE_LABELS[mode]}`,
          },
          dataset: { crawlAction: "eh-cycle", tagKey: tag.key, tagMode: mode },
        }));
      }
      details.append(options);
      groups.push(details);
    }
    elements.ehGroups.replaceChildren(...(groups.length ? groups : [createEmptyState({
      label: "无匹配标签", title: "当前标签检索无结果", message: "清空检索词后查看全部标签。",
    })]));
  };

  const renderProfiles = (profiles) => {
    if (!profiles.length) {
      elements.profileHost.replaceChildren();
      return;
    }
    const details = createElement("details", { className: "crawl-profile-details" }, [
      createElement("summary", { text: `Danbooru 维护的关联主页（${profiles.length}）` }),
    ]);
    const list = createElement("ul");
    for (const profile of profiles) {
      const link = createElement("a", {
        text: `${profile.artist} · ${profile.platform} · ${profile.host}`,
        attributes: { href: profile.url, target: "_blank", rel: "noreferrer noopener" },
      });
      details.append(createElement("li", {}, [link]));
    }
    elements.profileHost.replaceChildren(details);
  };

  const renderSources = (snapshot) => {
    const token = focusToken(root);
    const cards = [];
    snapshot.sources.forEach((source, sourceIndex) => {
      const visible = source.addresses.filter((candidate) => crawlCandidateVisible(snapshot, source, candidate));
      const selected = source.addresses.filter((candidate) => candidate.selected).length;
      const actionsRow = createElement("div", { className: "crawl-source-actions" }, [
        button("source-toggle", visible.some((candidate) => !candidate.selected) ? "全选本来源" : "取消本来源", { small: true }),
        button("source-up", "↑", { small: true }),
        button("source-down", "↓", { small: true }),
      ]);
      actionsRow.children[1].disabled = sourceIndex === 0;
      actionsRow.children[2].disabled = sourceIndex === snapshot.sources.length - 1;
      const card = createElement("article", {
        className: "crawl-source-card",
        dataset: { sourceKey: source.key, sourceSite: source.site },
      }, [
        createElement("div", { className: "crawl-source-heading" }, [
          createElement("div", {}, [
            createElement("span", { className: "crawl-order", text: String(sourceIndex + 1) }),
            createElement("h3", { text: source.label }),
            createStatusBadge(
              source.status === "succeeded" ? "ready" : source.status === "partial" ? "warning" : "error",
              source.status === "succeeded" ? "搜索成功" : source.status === "partial" ? "部分结果" : "搜索失败",
              { compact: true },
            ),
          ]),
          actionsRow,
        ]),
        createElement("p", {
          className: "crawl-source-meta",
          text: `站内证据 ${source.evidenceCount} · 当前可见 ${visible.length} · 已选 ${selected} · 尝试 ${source.attempts}${source.enrichmentIssueCount ? ` · 附加步骤异常 ${source.enrichmentIssueCount}` : ""}`,
        }),
      ]);
      if (source.errorCode) {
        card.append(createElement("p", {
          className: "crawl-source-warning",
          text: `来源返回受控错误码 ${source.errorCode}；可修复前置条件后重新搜索。`,
        }));
      }
      const list = createElement("div", { className: "crawl-address-list" });
      if (!visible.length) {
        list.append(createEmptyState({
          label: source.addresses.some((candidate) => candidate.weak) ? "仅有弱证据" : "无候选",
          title: "此来源当前没有可选地址",
          message: source.addresses.some((candidate) => candidate.weak)
            ? "开启“显示弱证据”后人工核对。"
            : "调整关键词或前置条件后重新搜索。",
        }));
      }
      visible.forEach((candidate, visibleIndex) => {
        const checkbox = createElement("input", {
          attributes: { type: "checkbox", checked: candidate.selected ? "" : null },
          dataset: { crawlCandidateToggle: candidate.key },
        });
        checkbox.checked = candidate.selected;
        const copy = createElement("div", { className: "crawl-address-copy" }, [
          createElement("strong", { text: candidate.label }),
          createElement("span", { text: candidate.displayEndpoint }),
          createElement("div", { className: "crawl-address-badges" }, [
            createStatusBadge(candidate.weak ? "warning" : "ready", CONFIDENCE_LABELS[candidate.confidence], { compact: true }),
            ...(candidate.mediaCount ? [createElement("span", { text: `媒体 ${candidate.mediaCount}` })] : []),
            ...(candidate.relatedProfileCount ? [createElement("span", { text: `关联主页 ${candidate.relatedProfileCount}` })] : []),
            ...candidate.evidence.map((label) => createElement("span", { text: label })),
          ]),
        ]);
        const label = createElement("label", { className: "crawl-address-main" }, [checkbox]);
        if (candidate.thumbnailUrl) {
          label.append(createElement("img", {
            className: "crawl-address-thumbnail",
            attributes: {
              src: candidate.thumbnailUrl, alt: `${candidate.label} 封面`, loading: "lazy",
              decoding: "async", referrerpolicy: "no-referrer",
            },
          }));
        }
        label.append(copy);
        const row = createElement("div", {
          className: `crawl-address-row${candidate.selected ? " crawl-address-row--selected" : ""}`,
          dataset: { candidateKey: candidate.key },
        }, [
          label,
          createElement("div", { className: "crawl-address-actions" }, [
            button("candidate-up", "↑", { small: true }),
            button("candidate-down", "↓", { small: true }),
          ]),
        ]);
        row.querySelector('[data-crawl-action="candidate-up"]').disabled = visibleIndex === 0;
        row.querySelector('[data-crawl-action="candidate-down"]').disabled = visibleIndex === visible.length - 1;
        list.append(row);
      });
      card.append(list);
      cards.push(card);
    });
    elements.sourceHost.replaceChildren(...cards);
    queueMicrotask(() => restoreFocus(root, token));
  };

  const render = (snapshot) => {
    const hasResults = snapshot.sources.length > 0;
    elements.resultHost.hidden = !hasResults;
    elements.submitForm.hidden = !hasResults;
    elements.weakToggle.checked = snapshot.showWeakEvidence;
    const selected = snapshot.sources.reduce(
      (count, source) => count + source.addresses.filter((candidate) => candidate.selected).length,
      0,
    );
    const selectedSources = snapshot.sources.filter((source) => source.addresses.some((candidate) => candidate.selected)).length;
    elements.resultSummary.textContent = `${snapshot.addressCount} 个候选 · ${snapshot.weakEvidenceCount} 个弱证据 · 已选 ${selectedSources} 个来源 / ${selected} 个地址`;
    elements.startButton.disabled = !selected || Boolean(busy);
    elements.submitBadge.dataset.status = selected ? "ready" : "disabled";
    elements.submitBadge.replaceChildren(
      createElement("span", { text: selected ? "✓" : "—", attributes: { "aria-hidden": "true" } }),
      createElement("span", { text: selected ? `已选 ${selected} 个地址` : "尚未选择地址" }),
    );
    elements.ehOptions.hidden = !snapshot.sources.some((source) =>
      source.site === "exhentai" && source.addresses.some((candidate) => candidate.selected));
    renderEhFilter(snapshot);
    renderSources(snapshot);
    renderProfiles(snapshot.relatedProfiles);
    renderPreconditions();
  };

  const unsubscribe = store.subscribe(selectors.crawl, render, { fireImmediately: true });

  return Object.freeze({
    elements,
    readSearchDraft() {
      return {
        keyword: elements.keyword.value,
        sites: selectedSites(elements),
        limit: Number(elements.searchLimit.value),
        proxyMode: elements.searchProxy.value,
        sourceOptions: sourceOptionValues(elements),
      };
    },
    readCrawlDraft() {
      return {
        concurrency: Number(elements.concurrency.value),
        maxTasks: Number(elements.maxTasks.value),
        proxyMode: elements.crawlProxy.value,
        outputDir: elements.outputDir.value,
        sourceOptions: sourceOptionValues(elements),
        ehDownload: {
          image_mode: elements.imageResample.checked ? "resample" : "original",
          gp_policy: elements.gpPolicy.value,
        },
      };
    },
    visibleCandidateKeys() {
      return visibleKeys(store.getState().crawl);
    },
    sourceVisibleKeys(sourceKey) {
      const snapshot = store.getState().crawl;
      const source = snapshot.sources.find((item) => item.key === sourceKey);
      return source
        ? source.addresses.filter((candidate) => crawlCandidateVisible(snapshot, source, candidate)).map((candidate) => candidate.key)
        : [];
    },
    renderPreconditions,
    setSuggestions(items) {
      if (!items.length) {
        elements.suggestions.hidden = true;
        elements.suggestions.replaceChildren();
        return;
      }
      elements.suggestions.replaceChildren(...items.map((item) => createElement("button", {
        className: "crawl-suggestion",
        attributes: { type: "button", role: "option" },
        dataset: { crawlAction: "suggestion", suggestionValue: item.value },
      }, [
        createElement("strong", { text: CATEGORY_LABELS[item.category] || "标签" }),
        createElement("span", { text: item.label }),
        ...(item.antecedent ? [createElement("small", { text: `别名 ${item.antecedent}` })] : []),
        ...(item.postCount ? [createElement("small", { text: `${item.postCount} 图` })] : []),
      ])));
      elements.suggestions.hidden = false;
    },
    hideSuggestions() {
      elements.suggestions.hidden = true;
      elements.suggestions.replaceChildren();
    },
    setEhQuery(value) {
      ehQuery = String(value || "").slice(0, 160);
      renderEhFilter(store.getState().crawl);
    },
    setBusy(kind) {
      busy = kind;
      root.toggleAttribute("aria-busy", Boolean(kind));
      elements.searchButton.disabled = Boolean(kind);
      elements.searchButton.textContent = kind === "search" ? "正在聚合搜索…" : "搜索候选图库";
      elements.startButton.textContent = kind === "crawl" ? "正在创建批次…" : "按当前顺序创建批次";
      elements.startButton.disabled = Boolean(kind) || !store.getState().crawl.sources.some((source) =>
        source.addresses.some((candidate) => candidate.selected));
    },
    clearOutputInput() {
      elements.outputDir.value = "";
    },
    clearError,
    showError,
    setOperationMessage,
    destroy() {
      unsubscribe();
      clearError();
      elements.outputDir.value = "";
      root.replaceChildren();
      root.removeAttribute("aria-busy");
    },
  });
}
