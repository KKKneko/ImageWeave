import { setElementInert } from "../core/dom.js";
import {
  importWallpaperImage,
  WallpaperImageImportError,
} from "../core/wallpaper-image-import.js";
import { restoreDefaultPersonalizationPreferences } from "../core/personalization-model.js";
import { createPersonalizationView } from "../components/personalization-view.js";

const CLEAN_MESSAGE = "设置已保存。";
const DIRTY_MESSAGE = "有未应用的更改。";
const INVALID_THEME_MESSAGE = "颜色格式无效，请输入 6 位十六进制颜色值（如 #116DA7）。";
const LIVE_DRAFT_CONTROL_SELECTOR = [
  "[data-personalization-motion]",
  "[data-personalization-color]",
  "[data-personalization-wallpaper-fit]",
  "[data-personalization-wallpaper-position]",
  "[data-personalization-wallpaper-mask-tone]",
  "[data-personalization-wallpaper-mask-strength]",
  "[data-personalization-wallpaper-blur]",
  "[data-personalization-window-opacity]",
].join(", ");
const MASK_STRENGTH_SELECTOR = "[data-personalization-wallpaper-mask-strength]";
const THEME_INPUT_SELECTOR = [
  "[data-personalization-theme-accent]",
  "[data-personalization-theme-surface]",
].join(", ");

function createPersonalizationController(context) {
  const { root, dialogs, personalization } = context;
  if (
    !personalization
    || typeof personalization.getState !== "function"
    || typeof personalization.preview !== "function"
    || typeof personalization.selectCustomWallpaper !== "function"
    || typeof personalization.previewCustomImage !== "function"
    || typeof personalization.commit !== "function"
    || typeof personalization.cancel !== "function"
    || typeof personalization.deleteCustomWallpaper !== "function"
    || typeof personalization.subscribe !== "function"
  ) {
    throw new TypeError("DESKTOP.CPL 缺少全局个性化运行时");
  }

  const view = createPersonalizationView(context);
  let active = false;
  let destroyed = false;
  let activeOperation = null;
  let operationSequence = 0;
  let lifecycleVersion = 0;
  let suppressThemePreviewPublish = false;

  const render = (state = personalization.getState()) => {
    try {
      view.renderState(state);
    } catch {
      try {
        view.retainThemePreviewError();
      } catch {
        // 若控件树已部分失效，仍直接阻止当前表单提交。
      }
      try {
        view.elements.applyButton.disabled = true;
        view.setStatus(
          "error",
          "无法显示部分设置，当前预览已保留。",
        );
      } catch {
        // DOM 正在卸载时不传播受控回显错误。
      }
    }
    return state;
  };

  const hasUnappliedDraft = (state = personalization.getState()) => (
    state.dirty === true || view.hasLocalThemeDraft()
  );

  const operationBusy = () => (
    activeOperation !== null || personalization.getState().busy === true
  );

  const beginViewOperation = (kind) => {
    if (!active || destroyed || operationBusy()) return null;
    operationSequence += 1;
    const operation = Object.freeze({
      id: operationSequence,
      kind,
      lifecycle: lifecycleVersion,
    });
    activeOperation = operation;
    root.setAttribute("aria-busy", "true");
    view.setBusy(true, kind);
    return operation;
  };

  const operationIsCurrent = (operation) => (
    active
    && !destroyed
    && activeOperation === operation
    && operation.lifecycle === lifecycleVersion
  );

  const finishViewOperation = (operation) => {
    if (!operationIsCurrent(operation)) return false;
    activeOperation = null;
    root.removeAttribute("aria-busy");
    view.setBusy(false);
    return true;
  };

  const invalidateViewOperations = () => {
    lifecycleVersion += 1;
    activeOperation = null;
    root.removeAttribute("aria-busy");
    view.setBusy(false);
  };

  const showDraftStatus = (state, message = "") => {
    if (hasUnappliedDraft(state)) {
      view.setStatus("dirty", message || DIRTY_MESSAGE);
    } else {
      view.setStatus("clean", message || CLEAN_MESSAGE);
    }
  };

  let runtimeWasBusy = personalization.getState().busy === true;
  const unsubscribe = personalization.subscribe((state) => {
    if (active && !destroyed && !suppressThemePreviewPublish) {
      render(state);
      if (runtimeWasBusy && !state.busy && activeOperation === null) {
        showDraftStatus(state);
      }
    }
    runtimeWasBusy = state.busy === true;
  });

  const previewFormDraft = ({ themeInput = false } = {}) => {
    if (!active || destroyed || operationBusy()) return null;
    const hadLocalThemeDraft = view.hasLocalThemeDraft() || themeInput;
    let theme;
    try {
      theme = themeInput
        ? view.beginThemeDraft()
        : view.getThemeDraftState();
    } catch {
      render();
      view.setStatus(
        "error",
        "无法读取主题设置，当前草稿已保留。",
      );
      return null;
    }
    if (hadLocalThemeDraft && !theme.valid) {
      if (!themeInput) view.refreshLocalDraft();
      view.setStatus("dirty", INVALID_THEME_MESSAGE);
      return null;
    }
    try {
      const current = personalization.getState();
      const draft = view.readDraft(current.draft);
      let next;
      if (hadLocalThemeDraft) {
        const previousSuppression = suppressThemePreviewPublish;
        suppressThemePreviewPublish = true;
        try {
          next = personalization.preview(draft);
        } finally {
          suppressThemePreviewPublish = previousSuppression;
        }
      } else {
        next = personalization.preview(draft);
      }
      if (!hadLocalThemeDraft && view.hasLocalThemeDraft()) {
        view.setStatus(
          "error",
          "无法显示部分设置，当前预览已保留。",
        );
        return null;
      }
      if (hadLocalThemeDraft) view.acceptThemeDraft(next);
      else render(next);
      showDraftStatus(next);
      return next;
    } catch {
      const restored = personalization.getState();
      if (hadLocalThemeDraft) {
        try {
          view.retainThemePreviewError();
        } catch {
          try {
            view.elements.applyButton.disabled = true;
          } catch {
            // 控件卸载时仍不得继续进入提交路径。
          }
        }
        view.setStatus(
          "error",
          "无法预览当前设置，表单内容和上次预览已保留。",
        );
      } else {
        render(restored);
        view.setStatus(
          "error",
          restored.dirty
            ? "设置值无效，已保留上次预览。"
            : "设置值无效，当前设置未改变。",
        );
      }
      return null;
    }
  };

  const cancelDraft = (message = "未应用的更改已取消，设置已恢复。") => {
    if (destroyed) return false;
    const hadPendingImage = personalization.getState().customWallpaper.pending === true;
    view.clearLocalThemeDraft();
    let state;
    try {
      state = personalization.cancel();
    } catch {
      state = personalization.getState();
      if (active) {
        render(state);
        view.setStatus(
          "error",
          "无法清除草稿，当前设置已保留，请稍后重试。",
        );
      }
      return false;
    }
    if (active) {
      render(state);
      view.setStatus("clean", message);
      if (hadPendingImage) {
        view.setImportStatus("idle", "未应用的新图片已丢弃。");
      }
    }
    return true;
  };

  const restoreDefaults = () => {
    if (!active || destroyed || operationBusy()) return;
    const hadPendingImage = personalization.getState().customWallpaper.pending === true;
    view.clearLocalThemeDraft();
    let state;
    try {
      state = personalization.preview(restoreDefaultPersonalizationPreferences());
    } catch {
      state = render();
      view.setStatus(
        "error",
        "无法预览默认设置，当前草稿已保留。",
      );
      view.focusAfter("reset");
      return;
    }
    render(state);
    showDraftStatus(
      state,
      state.dirty
        ? "已预览默认设置，点击“应用”后保存。"
        : "当前已经使用默认设置。",
    );
    if (hadPendingImage) {
      view.setImportStatus("idle", "已恢复默认草稿，未应用的新图片已丢弃。");
    }
    view.focusAfter("reset");
  };

  const applyDraft = async () => {
    if (
      !active
      || destroyed
      || operationBusy()
      || view.hasLocalThemeDraft()
      || !personalization.getState().dirty
    ) return;
    const operation = beginViewOperation("apply");
    if (!operation) return;
    view.setStatus("saving", "正在保存设置，请勿重复提交……");

    // 先让静态 busy 文案与禁用状态完成一次渲染，再进入异步持久化边界。
    await Promise.resolve();
    if (!operationIsCurrent(operation)) return;

    let result;
    try {
      result = await personalization.commit();
    } catch {
      result = Object.freeze({
        ok: false,
        message: "无法保存设置，原设置未改变。",
        state: personalization.getState(),
      });
    }
    if (!operationIsCurrent(operation)) return;
    finishViewOperation(operation);
    render(result.state);
    view.setStatus(result.ok ? "success" : "error", result.message);
    if (result.ok && result.state.committed.wallpaperKind === "custom") {
      view.setImportStatus("success", "本地图片和背景来源已保存。");
    }
    view.focusAfter("apply");
  };

  const safeImportFailureMessage = (error) => (
    error instanceof WallpaperImageImportError
      ? error.message
      : "无法处理所选图片，当前壁纸未改变。"
  );

  const selectCustomSource = () => {
    if (!active || destroyed || operationBusy() || view.hasLocalThemeDraft()) return;
    const result = personalization.selectCustomWallpaper();
    render(result.state);
    if (result.ok) {
      showDraftStatus(result.state, `${result.message} 点击“应用”后保存。`);
      view.setImportStatus("success", result.message);
      return;
    }
    const kind = result.code === "custom_loading" ? "loading" : "idle";
    view.setImportStatus(kind, result.message);
    showDraftStatus(result.state, result.message);
  };

  const importSelectedFile = async (input) => {
    let file = null;
    let operation = null;
    try {
      if (view.hasLocalThemeDraft()) {
        input.value = "";
        view.setImportStatus(
          "warning",
          "请先修正主题颜色格式，再选择图片。",
        );
        return;
      }
      file = input.files?.item?.(0) ?? input.files?.[0] ?? null;
      if (!file) return;
      operation = beginViewOperation("import");
      if (!operation) return;
      view.setImportStatus(
        "loading",
        "正在本机处理图片，文件不会上传。",
      );
      view.setStatus("saving", "正在准备本地图片预览，请勿重复选择……");

      await Promise.resolve();
      if (!operationIsCurrent(operation)) return;
      const imported = await importWallpaperImage(file);
      file = null;
      if (!operationIsCurrent(operation)) return;

      const result = await personalization.previewCustomImage(imported);
      if (!operationIsCurrent(operation)) return;
      finishViewOperation(operation);
      render(result.state);
      if (!result.ok) {
        view.setImportStatus("error", result.message);
        showDraftStatus(result.state, result.message);
        view.focusAfter("import");
        return;
      }

      const smallImage = imported.warning?.code === "small_dimensions";
      view.setImportStatus(
        smallImage ? "warning" : "success",
        smallImage
          ? `${result.message} 图片尺寸低于建议的 320 × 180 像素，仍可继续使用。`
          : result.message,
      );
      showDraftStatus(result.state, result.message);
      view.focusAfter("import");
    } catch (error) {
      if (!operation || !operationIsCurrent(operation)) return;
      finishViewOperation(operation);
      const state = render();
      const message = safeImportFailureMessage(error);
      view.setImportStatus("error", message);
      showDraftStatus(
        state,
        state.dirty
          ? `${message} 上次草稿仍在预览。`
          : message,
      );
      view.focusAfter("import");
    } finally {
      file = null;
      try {
        input.value = "";
      } catch {
        // 文件控件即使在卸载中失效，也不得把名称或路径复制到其他 DOM。
      }
      if (operation && operationIsCurrent(operation)) finishViewOperation(operation);
    }
  };

  const deleteSavedCustomWallpaper = async () => {
    if (
      !active
      || destroyed
      || operationBusy()
      || view.hasLocalThemeDraft()
      || personalization.getState().customWallpaper.saved !== true
    ) return;

    const confirmationOperation = beginViewOperation("confirm");
    if (!confirmationOperation) return;
    let choice = "cancel";
    try {
      choice = await dialogs.open({
        title: "删除已保存的自定义壁纸？",
        message: "这会删除浏览器中保存的自定义壁纸，并恢复默认石墨背景；已保存的主题设置不受影响。",
        confirmLabel: "删除并恢复石墨",
        dangerous: true,
        confirmationText: "删除后无法撤销；其他未应用更改也会恢复到上次保存状态。",
      });
    } catch {
      choice = "cancel";
    }
    if (!operationIsCurrent(confirmationOperation)) return;
    finishViewOperation(confirmationOperation);
    if (choice !== "confirm") {
      view.setImportStatus("idle", "已取消删除，本地壁纸保持不变。");
      view.focusAfter("delete");
      return;
    }

    const operation = beginViewOperation("delete");
    if (!operation) return;
    view.setImportStatus("loading", "正在删除已保存的本地壁纸…");
    view.setStatus("saving", "正在更新壁纸和设置……");
    let result;
    try {
      result = await personalization.deleteCustomWallpaper();
    } catch {
      result = Object.freeze({
        ok: false,
        message: "无法删除本地壁纸，原壁纸和设置已保留。",
        state: personalization.getState(),
      });
    }
    if (!operationIsCurrent(operation)) return;
    finishViewOperation(operation);
    render(result.state);
    view.setImportStatus(result.ok ? "success" : "error", result.message);
    view.setStatus(result.ok ? "success" : "error", result.message);
    view.focusAfter("delete");
  };

  const confirmDiscard = async (purpose) => {
    if (operationBusy()) {
      view.setStatus("saving", "图片或设置正在处理，完成前无法离开外观设置。");
      return false;
    }
    if (!hasUnappliedDraft()) return true;
    let choice = "cancel";
    try {
      choice = await dialogs.open({
        title: "放弃未应用的外观设置？",
        message: `当前主题、动效、背景、图片显示或窗口透明度尚未应用。${purpose}后将放弃这些更改。`,
        confirmLabel: "放弃更改并离开",
        dangerous: true,
        confirmationText: "确认后将恢复上次保存的设置，未应用内容不会写入浏览器存储。",
      });
    } catch {
      choice = "cancel";
    }
    if (choice !== "confirm" || !active || destroyed) {
      if (active && !destroyed) {
        view.setStatus("dirty", "已取消离开，未应用的更改继续保留。");
      }
      return false;
    }
    return cancelDraft(
      "已放弃未应用的更改，设置已恢复。",
    );
  };

  const themeInputValuesMatchRuntimeDraft = () => {
    try {
      const theme = view.getThemeDraftState();
      const runtimeDraft = personalization.getState().draft;
      return Boolean(theme.themeAccent && theme.themeSurface)
        && theme.themeAccent === runtimeDraft.themeAccent
        && theme.themeSurface === runtimeDraft.themeSurface;
    } catch {
      return false;
    }
  };

  const onChange = (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.matches("[data-personalization-file-input]")) {
      void importSelectedFile(event.target);
      return;
    }
    if (event.target.matches(THEME_INPUT_SELECTOR)) {
      if (
        !view.hasLocalThemeDraft()
        && themeInputValuesMatchRuntimeDraft()
      ) return;
      previewFormDraft({ themeInput: true });
      return;
    }
    if (event.target.matches('[data-personalization-source="custom"]')) {
      if (view.hasLocalThemeDraft()) previewFormDraft();
      else selectCustomSource();
      return;
    }
    if (event.target.matches('[data-personalization-source="color"]')) {
      const hadPendingImage = personalization.getState().customWallpaper.pending === true;
      const state = previewFormDraft();
      if (state && hadPendingImage) {
        view.setImportStatus("idle", "已切换到内置纯色；未应用的新图片已丢弃。");
      }
      return;
    }
    if (event.target.matches(LIVE_DRAFT_CONTROL_SELECTOR)) {
      previewFormDraft();
    }
  };

  const onInput = (event) => {
    if (!(event.target instanceof Element)) return;
    if (event.target.matches(THEME_INPUT_SELECTOR)) {
      previewFormDraft({ themeInput: true });
      return;
    }
    if (event.target.matches(MASK_STRENGTH_SELECTOR)) previewFormDraft();
  };

  const onClick = (event) => {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest("[data-personalization-action]");
    if (!(button instanceof HTMLButtonElement) || button.disabled) return;
    const action = button.dataset.personalizationAction;
    if (action === "choose-image") {
      try {
        view.elements.fileInput.click();
      } catch {
        view.setImportStatus("error", "当前浏览器无法打开本地图片选择器。");
      }
    } else if (action === "delete-image") {
      void deleteSavedCustomWallpaper();
    } else if (action === "cancel") {
      cancelDraft();
      view.focusAfter("cancel");
    } else if (action === "reset") {
      restoreDefaults();
    }
  };

  const onSubmit = (event) => {
    if (!(event.target instanceof HTMLFormElement) || event.target !== view.elements.form) return;
    event.preventDefault();
    void applyDraft();
  };

  const onBeforeUnload = (event) => {
    if (
      !active
      || (!hasUnappliedDraft() && !operationBusy())
    ) return;
    event.preventDefault();
    event.returnValue = "";
  };

  root.addEventListener("change", onChange);
  root.addEventListener("input", onInput);
  root.addEventListener("click", onClick);
  root.addEventListener("submit", onSubmit);
  globalThis.addEventListener?.("beforeunload", onBeforeUnload);
  render();

  return Object.freeze({
    beforeLeave() {
      return confirmDiscard("切换应用");
    },
    beforeWindowHide(visibility) {
      return confirmDiscard(visibility === "closed" ? "关闭窗口" : "最小化窗口");
    },
    activate() {
      if (destroyed || active) return;
      lifecycleVersion += 1;
      active = true;
      root.hidden = false;
      setElementInert(root, false);
      root.dataset.lifecycle = "active";
      view.clearLocalThemeDraft();
      let state;
      try {
        state = personalization.cancel();
      } catch {
        state = personalization.getState();
      }
      render(state);
      view.setBusy(false);
      if (state.busy) {
        view.setStatus("saving", "正在完成上一项操作的清理……");
      } else {
        view.setStatus("clean", CLEAN_MESSAGE);
      }
    },
    deactivate() {
      if (destroyed) return;
      active = false;
      view.clearLocalThemeDraft();
      invalidateViewOperations();
      dialogs.destroy();
      // 即使壳层被外部动作强制隐藏，也绝不把未提交或在途预览留在桌面。
      try {
        const state = personalization.cancel();
        render(state);
      } catch {
        // 全局运行时先销毁时，桌面仍应继续完成应用卸载。
      }
      root.hidden = true;
      setElementInert(root, true);
      root.dataset.lifecycle = "inactive";
    },
    destroy() {
      if (destroyed) return;
      active = false;
      view.clearLocalThemeDraft();
      invalidateViewOperations();
      dialogs.destroy();
      try {
        personalization.cancel();
      } catch {
        // 页面卸载期间只需保证不继续传播草稿。
      }
      destroyed = true;
      unsubscribe();
      root.removeEventListener("change", onChange);
      root.removeEventListener("input", onInput);
      root.removeEventListener("click", onClick);
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
    if (controller) throw new Error("DESKTOP.CPL 已挂载");
    controller = createPersonalizationController(context);
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
