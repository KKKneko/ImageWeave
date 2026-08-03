import { createElement } from "../core/dom.js";
import {
  calculateThemeContrastRatio,
  deriveInterfaceThemeTone,
  isValidInterfaceTheme,
  normalizeThemeHex,
  PERSONALIZATION_DEFAULTS,
  personalizationPreferencesEqual,
  projectPersonalizationPreferences,
} from "../core/personalization-model.js";

export const MOTION_LIMITATION_MESSAGE =
  "已开启界面动效，但系统“减少动态效果”设置会限制部分效果。";

export const WALLPAPER_COLOR_CHOICES = Object.freeze([
  Object.freeze({ id: "graphite", label: "石墨" }),
  Object.freeze({ id: "slate", label: "岩灰" }),
  Object.freeze({ id: "deep-ocean", label: "深海" }),
  Object.freeze({ id: "forest", label: "深林" }),
  Object.freeze({ id: "plum-gray", label: "灰梅" }),
  Object.freeze({ id: "warm-paper", label: "暖纸" }),
]);

const STATUS_KINDS = new Set(["clean", "dirty", "saving", "success", "error"]);
const IMPORT_STATUS_KINDS = new Set([
  "idle",
  "loading",
  "success",
  "warning",
  "error",
]);

const WALLPAPER_SOURCE_CHOICES = Object.freeze([
  Object.freeze({
    id: "color",
    label: "内置纯色",
    description: "从 6 种预设颜色中选择。",
  }),
  Object.freeze({
    id: "custom",
    label: "本地图片",
    description: "选择并保存本地图片，文件不会上传。",
  }),
]);

const WALLPAPER_FIT_CHOICES = Object.freeze([
  Object.freeze({ id: "cover", label: "填充" }),
  Object.freeze({ id: "contain", label: "适应" }),
  Object.freeze({ id: "stretch", label: "拉伸" }),
  Object.freeze({ id: "tile", label: "平铺" }),
]);

const WALLPAPER_POSITION_CHOICES = Object.freeze([
  Object.freeze({ id: "top-left", label: "左上" }),
  Object.freeze({ id: "top", label: "顶部" }),
  Object.freeze({ id: "top-right", label: "右上" }),
  Object.freeze({ id: "left", label: "左侧" }),
  Object.freeze({ id: "center", label: "居中" }),
  Object.freeze({ id: "right", label: "右侧" }),
  Object.freeze({ id: "bottom-left", label: "左下" }),
  Object.freeze({ id: "bottom", label: "底部" }),
  Object.freeze({ id: "bottom-right", label: "右下" }),
]);

const WALLPAPER_MASK_TONE_CHOICES = Object.freeze([
  Object.freeze({ id: "dark", label: "深色" }),
  Object.freeze({ id: "light", label: "浅色" }),
]);

const WALLPAPER_BLUR_CHOICES = Object.freeze([
  Object.freeze({ id: "off", label: "关闭（0px）" }),
  Object.freeze({ id: "soft", label: "轻微（4px）" }),
  Object.freeze({ id: "medium", label: "中等（10px）" }),
]);

const WINDOW_OPACITY_CHOICES = Object.freeze([
  Object.freeze({ id: "solid", label: "实色（100%）" }),
  Object.freeze({ id: "subtle", label: "轻微透明（96%）" }),
  Object.freeze({ id: "soft", label: "柔和透明（92%）" }),
]);

export function deriveMotionLimitationState(userMode, motionState) {
  if (userMode !== "on" && userMode !== "off") {
    throw new TypeError("动效模式必须是 on 或 off");
  }
  const limited = userMode === "on" && motionState?.systemReduced === true;
  return Object.freeze({
    limited,
    message: limited ? MOTION_LIMITATION_MESSAGE : "",
  });
}

function choiceSelectionText(selected) {
  return selected ? "当前" : "";
}

function createMotionChoice(value, label) {
  const id = `personalization-motion-${value}`;
  const input = createElement("input", {
    attributes: {
      id,
      type: "radio",
      name: "personalization-motion",
      value,
      "aria-describedby": "personalization-motion-help personalization-motion-limit",
    },
    dataset: { personalizationMotion: value },
  });
  const selection = createElement("span", {
    className: "personalization-choice__selection",
    text: choiceSelectionText(false),
    attributes: { "aria-hidden": "true" },
  });
  const element = createElement("label", {
    className: "personalization-choice personalization-motion-choice",
    attributes: { for: id },
  }, [
    input,
    createElement("strong", { text: label }),
    selection,
  ]);
  return { element, input, selection };
}

function createSourceChoice(choice) {
  const id = `personalization-source-${choice.id}`;
  const descriptionId = `${id}-description`;
  const input = createElement("input", {
    attributes: {
      id,
      type: "radio",
      name: "personalization-source",
      value: choice.id,
      "aria-describedby": descriptionId,
    },
    dataset: { personalizationSource: choice.id },
  });
  const selection = createElement("span", {
    className: "personalization-choice__selection",
    text: choiceSelectionText(false),
    attributes: { "aria-hidden": "true" },
  });
  const element = createElement("label", {
    className: "personalization-choice personalization-source-choice",
    attributes: { for: id },
  }, [
    input,
    createElement("strong", { text: choice.label }),
    createElement("span", {
      className: "personalization-source-choice__description",
      text: choice.description,
      attributes: { id: descriptionId },
    }),
    selection,
  ]);
  return { element, input, selection };
}

function createColorChoice(choice) {
  const id = `personalization-color-${choice.id}`;
  const input = createElement("input", {
    attributes: {
      id,
      type: "radio",
      name: "personalization-color",
      value: choice.id,
      "aria-describedby": "personalization-color-help",
    },
    dataset: { personalizationColor: choice.id },
  });
  const selection = createElement("span", {
    className: "personalization-choice__selection",
    text: choiceSelectionText(false),
    attributes: { "aria-hidden": "true" },
  });
  const element = createElement("label", {
    className: "personalization-choice personalization-color-choice",
    attributes: { for: id },
  }, [
    input,
    createElement("span", {
      className: `personalization-swatch personalization-swatch--${choice.id}`,
      attributes: { "aria-hidden": "true" },
    }),
    createElement("strong", { text: choice.label }),
    selection,
  ]);
  return { element, input, selection };
}

function createThemeColorControl({ id, label, datasetName, defaultValue }) {
  const helpIds = "personalization-theme-help personalization-theme-contrast-status";
  const input = createElement("input", {
    className: "personalization-theme-color",
    attributes: {
      id,
      type: "color",
      name: id,
      value: defaultValue,
      "aria-describedby": helpIds,
    },
    dataset: { [datasetName]: "setting" },
  });
  const output = createElement("output", {
    className: "personalization-theme-hex",
    text: defaultValue,
    attributes: {
      id: `${id}-value`,
      for: id,
      "aria-label": `当前${label}：${defaultValue}`,
    },
  });
  return {
    element: createElement("div", {
      className: "personalization-theme-control",
    }, [
      createElement("label", {
        className: "personalization-control__label",
        text: label,
        attributes: { for: id },
      }),
      createElement("div", { className: "personalization-theme-color-row" }, [
        input,
        output,
      ]),
    ]),
    input,
    output,
    label,
  };
}

function readThemeInputState(themeAccent, themeSurface) {
  const normalizedAccent = normalizeThemeHex(themeAccent);
  const normalizedSurface = normalizeThemeHex(themeSurface);
  let contrastRatio = null;
  let tone = null;
  if (normalizedAccent && normalizedSurface) {
    contrastRatio = calculateThemeContrastRatio(
      normalizedAccent,
      normalizedSurface,
    );
    tone = deriveInterfaceThemeTone(normalizedSurface);
  }
  const valid = Boolean(normalizedAccent && normalizedSurface)
    && isValidInterfaceTheme(normalizedAccent, normalizedSurface);
  return Object.freeze({
    themeAccent: normalizedAccent,
    themeSurface: normalizedSurface,
    contrastRatio,
    tone,
    valid,
  });
}

function themeStatusText(theme, { previewError = false } = {}) {
  const ratio = Number.isFinite(theme.contrastRatio)
    ? `${theme.contrastRatio.toFixed(2)}:1`
    : "无法计算";
  const tone = theme.tone === "dark"
    ? "深色界面"
    : theme.tone === "light"
      ? "浅色界面"
      : "界面色调待确认";
  if (previewError) {
    return theme.valid
      ? `无法预览当前配色（对比度 ${ratio}，${tone}），请重试。`
      : "颜色格式无效，请输入 6 位十六进制颜色值（如 #116DA7）。";
  }
  if (!theme.valid) {
    return "颜色格式无效，请输入 6 位十六进制颜色值（如 #116DA7）。";
  }
  return `对比度 ${ratio}，可正常使用。`;
}

function createSettingSelect({ id, label, datasetName, choices, describedBy }) {
  const attributes = { id, name: id };
  if (describedBy) attributes["aria-describedby"] = describedBy;
  const select = createElement("select", {
    className: "personalization-select",
    attributes,
    dataset: { [datasetName]: "setting" },
  }, choices.map((choice) => createElement("option", {
    text: choice.label,
    attributes: { value: choice.id },
  })));
  return {
    element: createElement("div", { className: "personalization-control" }, [
      createElement("label", {
        className: "personalization-control__label",
        text: label,
        attributes: { for: id },
      }),
      select,
    ]),
    select,
  };
}

function createPositionChoice(choice) {
  const id = `personalization-position-${choice.id}`;
  const input = createElement("input", {
    attributes: {
      id,
      type: "radio",
      name: "personalization-position",
      value: choice.id,
    },
    dataset: { personalizationWallpaperPosition: choice.id },
  });
  input.checked = choice.id === PERSONALIZATION_DEFAULTS.wallpaperPosition;
  const element = createElement("label", {
    className: "personalization-position-choice",
    attributes: { for: id },
  }, [
    input,
    createElement("span", { text: choice.label }),
  ]);
  return { element, input };
}

function actionButton(
  action,
  label,
  { primary = false, dangerous = false, type = "button" } = {},
) {
  const classes = ["personalization-button"];
  if (primary) classes.push("personalization-button--primary");
  if (dangerous) classes.push("personalization-button--dangerous");
  return createElement("button", {
    className: classes.join(" "),
    text: label,
    attributes: { type },
    dataset: { personalizationAction: action },
  });
}

export function createPersonalizationView({ root, app }) {
  const motionOn = createMotionChoice("on", "开启界面动效");
  const motionOff = createMotionChoice("off", "关闭界面动效");
  const motionChoices = new Map([
    ["on", motionOn],
    ["off", motionOff],
  ]);
  const themeAccent = createThemeColorControl({
    id: "personalization-theme-accent",
    label: "强调色",
    datasetName: "personalizationThemeAccent",
    defaultValue: PERSONALIZATION_DEFAULTS.themeAccent,
  });
  const themeSurface = createThemeColorControl({
    id: "personalization-theme-surface",
    label: "窗口底色",
    datasetName: "personalizationThemeSurface",
    defaultValue: PERSONALIZATION_DEFAULTS.themeSurface,
  });
  const sourceChoices = new Map(
    WALLPAPER_SOURCE_CHOICES.map((choice) => [choice.id, createSourceChoice(choice)]),
  );
  const colorChoices = new Map(
    WALLPAPER_COLOR_CHOICES.map((choice) => [choice.id, createColorChoice(choice)]),
  );
  const wallpaperFit = createSettingSelect({
    id: "personalization-wallpaper-fit",
    label: "显示方式",
    datasetName: "personalizationWallpaperFit",
    choices: WALLPAPER_FIT_CHOICES,
    describedBy: "personalization-fit-help personalization-image-controls-status",
  });
  const positionChoices = new Map(
    WALLPAPER_POSITION_CHOICES.map((choice) => [choice.id, createPositionChoice(choice)]),
  );
  const wallpaperMaskTone = createSettingSelect({
    id: "personalization-wallpaper-mask-tone",
    label: "遮罩色调",
    datasetName: "personalizationWallpaperMaskTone",
    choices: WALLPAPER_MASK_TONE_CHOICES,
    describedBy: "personalization-mask-help personalization-image-controls-status",
  });
  const wallpaperBlur = createSettingSelect({
    id: "personalization-wallpaper-blur",
    label: "模糊",
    datasetName: "personalizationWallpaperBlur",
    choices: WALLPAPER_BLUR_CHOICES,
    describedBy: "personalization-image-controls-status",
  });
  const windowOpacity = createSettingSelect({
    id: "personalization-window-opacity",
    label: "窗口透明度",
    datasetName: "personalizationWindowOpacity",
    choices: WINDOW_OPACITY_CHOICES,
    describedBy: "personalization-opacity-help",
  });
  const maskStrengthInput = createElement("input", {
    className: "personalization-range",
    attributes: {
      id: "personalization-wallpaper-mask-strength",
      type: "range",
      name: "personalization-wallpaper-mask-strength",
      min: "0",
      max: "80",
      step: "5",
      value: String(PERSONALIZATION_DEFAULTS.wallpaperMaskStrength),
      "aria-describedby": "personalization-mask-help personalization-mask-strength-value personalization-image-controls-status",
      "aria-valuetext": `${PERSONALIZATION_DEFAULTS.wallpaperMaskStrength}%`,
    },
    dataset: { personalizationWallpaperMaskStrength: "setting" },
  });
  const maskStrengthOutput = createElement("output", {
    className: "personalization-range-output",
    text: `${PERSONALIZATION_DEFAULTS.wallpaperMaskStrength}%`,
    attributes: {
      id: "personalization-mask-strength-value",
      for: "personalization-wallpaper-mask-strength",
      "aria-label": `当前遮罩强度：${PERSONALIZATION_DEFAULTS.wallpaperMaskStrength}%`,
      "aria-live": "polite",
      "aria-atomic": "true",
    },
  });
  const imageControlsStatus = createElement("p", {
    className: "personalization-settings-status",
    text: "图片设置仅在有可显示的本地图片时启用。",
    attributes: {
      id: "personalization-image-controls-status",
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
    },
  });
  const tilePositionNote = createElement("p", {
    className: "personalization-position-note",
    text: "平铺模式不使用图片位置；切换回其他模式后恢复原位置。",
    attributes: {
      id: "personalization-position-tile-note",
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
    },
  });
  tilePositionNote.hidden = true;
  const motionLimit = createElement("p", {
    className: "personalization-motion-limit",
    attributes: {
      id: "personalization-motion-limit",
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
    },
  });
  const initialTheme = readThemeInputState(
    PERSONALIZATION_DEFAULTS.themeAccent,
    PERSONALIZATION_DEFAULTS.themeSurface,
  );
  const themeContrastStatus = createElement("p", {
    className: "personalization-theme-status",
    text: themeStatusText(initialTheme),
    attributes: {
      id: "personalization-theme-contrast-status",
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
    },
    dataset: { personalizationThemeStatus: "valid" },
  });
  const customImageState = createElement("p", {
    className: "personalization-image-state",
    text: "正在检查浏览器中已保存的本地壁纸…",
    attributes: {
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
    },
    dataset: { personalizationImageState: "loading" },
  });
  const importStatus = createElement("p", {
    className: "personalization-import-status",
    text: "尚未选择新图片。",
    attributes: {
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
    },
    dataset: { personalizationImportStatus: "idle" },
  });
  const status = createElement("p", {
    className: "personalization-save-status",
    text: "设置已保存。",
    attributes: {
      role: "status",
      "aria-live": "polite",
      "aria-atomic": "true",
    },
    dataset: { personalizationStatus: "clean" },
  });
  const fileInput = createElement("input", {
    className: "personalization-file-input",
    attributes: {
      type: "file",
      accept: ".jpg,.jpeg,.png,.webp,image/jpeg,image/png,image/webp",
      hidden: "",
      tabindex: "-1",
      "aria-label": "选择 JPG、JPEG、PNG 或 WebP 本地图片",
    },
    dataset: { personalizationFileInput: "wallpaper" },
  });
  const chooseImageButton = actionButton("choose-image", "选择本地图片");
  const deleteButton = actionButton("delete-image", "删除已保存图片", {
    dangerous: true,
  });
  const applyButton = actionButton("apply", "应用", { primary: true, type: "submit" });
  const cancelButton = actionButton("cancel", "取消");
  const resetButton = actionButton("reset", "恢复默认");

  const motionFieldset = createElement("fieldset", {
    className: "personalization-panel personalization-fieldset",
  }, [
    createElement("legend", { text: "动效" }),
    createElement("p", {
      className: "personalization-help",
      text: "仅影响界面过渡，不影响静态壁纸。",
      attributes: { id: "personalization-motion-help" },
    }),
    createElement("div", { className: "personalization-motion-options" }, [
      motionOn.element,
      motionOff.element,
    ]),
    motionLimit,
  ]);

  const themeFieldset = createElement("fieldset", {
    className: "personalization-panel personalization-fieldset personalization-theme-panel",
  }, [
    createElement("legend", { text: "界面主题" }),
    createElement("p", {
      className: "personalization-help",
      text: "选择强调色和窗口底色，可输入 6 位十六进制颜色值。",
      attributes: { id: "personalization-theme-help" },
    }),
    createElement("div", { className: "personalization-theme-grid" }, [
      themeAccent.element,
      themeSurface.element,
    ]),
    themeContrastStatus,
  ]);

  const sourceFieldset = createElement("fieldset", {
    className: "personalization-panel personalization-fieldset",
  }, [
    createElement("legend", { text: "背景来源" }),
    createElement("p", {
      className: "personalization-help",
      text: "本地图片仅在本机处理，不会上传。",
    }),
    createElement("div", { className: "personalization-source-options" }, [
      ...[...sourceChoices.values()].map((choice) => choice.element),
    ]),
  ]);

  const colorFieldset = createElement("fieldset", {
    className: "personalization-panel personalization-fieldset",
  }, [
    createElement("legend", { text: "内置纯色背景" }),
    createElement("p", {
      className: "personalization-help",
      text: "从 6 种预设颜色中选择。",
      attributes: { id: "personalization-color-help" },
    }),
    createElement("div", { className: "personalization-color-options" }, [
      ...[...colorChoices.values()].map((choice) => choice.element),
    ]),
  ]);

  const customFieldset = createElement("fieldset", {
    className: "personalization-panel personalization-fieldset personalization-image-panel",
  }, [
    createElement("legend", { text: "本地图片" }),
    createElement("p", {
      className: "personalization-help",
      text: "支持 JPG、PNG 和 WebP，最大 15 MiB。图片仅在本机处理，文件名和元数据不会保存。",
    }),
    fileInput,
    createElement("div", { className: "personalization-image-actions" }, [
      chooseImageButton,
      deleteButton,
    ]),
    customImageState,
    importStatus,
    createElement("p", {
      className: "personalization-help personalization-image-note",
      text: "选择后先预览，点击“应用”才会替换当前壁纸。",
    }),
  ]);

  const positionFieldset = createElement("fieldset", {
    className: "personalization-position-fieldset",
    attributes: {
      "aria-describedby": "personalization-position-help personalization-position-tile-note personalization-image-controls-status",
    },
  }, [
    createElement("legend", { text: "图片位置" }),
    createElement("p", {
      className: "personalization-help",
      text: "选择图片在桌面中的对齐位置，默认为居中。",
      attributes: { id: "personalization-position-help" },
    }),
    createElement("div", { className: "personalization-position-grid" }, [
      ...[...positionChoices.values()].map((choice) => choice.element),
    ]),
    tilePositionNote,
  ]);

  const imageSettingsPanel = createElement("section", {
    className: "personalization-panel personalization-image-settings",
    attributes: { "aria-labelledby": "personalization-image-settings-heading" },
  }, [
    createElement("h2", {
      text: "图片显示",
      attributes: { id: "personalization-image-settings-heading" },
    }),
    createElement("p", {
      className: "personalization-help",
      text: "仅在使用本地图片时生效。",
    }),
    imageControlsStatus,
    createElement("div", { className: "personalization-control-grid" }, [
      createElement("div", { className: "personalization-control-group" }, [
        wallpaperFit.element,
        createElement("p", {
          className: "personalization-help",
          text: "填充会裁切，适应会完整显示，拉伸会改变比例，平铺会重复图片。",
          attributes: { id: "personalization-fit-help" },
        }),
      ]),
      positionFieldset,
    ]),
    createElement("div", { className: "personalization-control-grid" }, [
      createElement("div", { className: "personalization-control-group" }, [
        wallpaperMaskTone.element,
        createElement("p", {
          className: "personalization-help",
          text: "遮罩仅影响壁纸，不影响窗口颜色。",
          attributes: { id: "personalization-mask-help" },
        }),
        createElement("div", { className: "personalization-control" }, [
          createElement("label", {
            className: "personalization-control__label",
            text: "遮罩强度",
            attributes: { for: "personalization-wallpaper-mask-strength" },
          }),
          createElement("div", { className: "personalization-range-row" }, [
            maskStrengthInput,
            maskStrengthOutput,
          ]),
        ]),
      ]),
      createElement("div", { className: "personalization-control-group" }, [
        wallpaperBlur.element,
      ]),
    ]),
  ]);

  const windowFieldset = createElement("fieldset", {
    className: "personalization-panel personalization-fieldset personalization-window-panel",
  }, [
    createElement("legend", { text: "窗口" }),
    createElement("p", {
      className: "personalization-help",
      text: "选择窗口透明度；对话框、提示、任务栏和开始菜单始终不透明。",
    }),
    windowOpacity.element,
    createElement("p", {
      className: "personalization-help personalization-opacity-note",
      text: "系统强制颜色或高对比度模式下会自动回到实色 100%，无需手动调整。",
      attributes: { id: "personalization-opacity-help" },
    }),
  ]);

  const form = createElement("form", {
    className: "personalization-form",
    attributes: { autocomplete: "off" },
    dataset: { personalizationForm: "settings" },
  }, [
    motionFieldset,
    themeFieldset,
    sourceFieldset,
    colorFieldset,
    customFieldset,
    imageSettingsPanel,
    windowFieldset,
    createElement("section", {
      className: "personalization-panel personalization-actions-panel",
      attributes: { "aria-labelledby": "personalization-actions-heading" },
    }, [
      createElement("h2", {
        text: "操作",
        attributes: { id: "personalization-actions-heading" },
      }),
      status,
      createElement("div", { className: "personalization-actions" }, [
        applyButton,
        cancelButton,
        resetButton,
      ]),
      createElement("p", {
        className: "personalization-help",
        text: "恢复推荐配色、石墨背景、默认图片显示、实色窗口和界面动效；点击“应用”后保存。",
      }),
    ]),
  ]);

  root.classList.add("app-view", "personalization-app");
  root.setAttribute("aria-labelledby", "personalization-heading");
  root.replaceChildren(
    createElement("header", { className: "app-header personalization-app-header" }, [
      createElement("p", { className: "app-executable", text: app.windowTitle }),
      createElement("h1", {
        text: app.label,
        attributes: { id: "personalization-heading" },
      }),
      createElement("p", {
        className: "app-summary",
        text: "自定义主题、桌面背景、窗口透明度和界面动效。所有调整都会立即预览，点击“应用”后保存。",
      }),
    ]),
    form,
  );

  let busy = false;
  let busyAction = "";
  let latestState = null;
  let localThemeDraft = false;
  let localThemeInvalid = false;
  let themePreviewError = false;

  const selectedChoiceValue = (choices, fallback) => (
    [...choices].find(([, choice]) => choice.input.checked)?.[0] ?? fallback
  );

  const renderMaskStrength = (value) => {
    const maskStrengthText = `${value}%`;
    maskStrengthOutput.value = maskStrengthText;
    maskStrengthOutput.textContent = maskStrengthText;
    maskStrengthOutput.setAttribute(
      "aria-label",
      `当前遮罩强度：${maskStrengthText}`,
    );
    maskStrengthInput.setAttribute("aria-valuetext", maskStrengthText);
  };

  const currentThemeInputState = () => readThemeInputState(
    themeAccent.input.value,
    themeSurface.input.value,
  );

  const renderThemePresentation = (theme = currentThemeInputState()) => {
    for (const control of [themeAccent, themeSurface]) {
      const normalized = control === themeAccent
        ? theme.themeAccent
        : theme.themeSurface;
      const displayed = normalized ?? "无效";
      control.output.value = displayed;
      control.output.textContent = displayed;
      control.output.setAttribute(
        "aria-label",
        `当前${control.label}：${displayed}`,
      );
      if (theme.valid) {
        control.input.removeAttribute("aria-invalid");
      } else {
        control.input.setAttribute("aria-invalid", "true");
      }
    }
    themeContrastStatus.dataset.personalizationThemeStatus = themePreviewError
      ? "error"
      : theme.valid
        ? "valid"
        : "invalid";
    themeContrastStatus.textContent = themeStatusText(theme, {
      previewError: themePreviewError,
    });
    return theme;
  };

  const setThemeInputsFromDraft = (draft) => {
    const nextAccent = normalizeThemeHex(draft.themeAccent);
    const nextSurface = normalizeThemeHex(draft.themeSurface);
    if (
      !nextAccent
      || !nextSurface
      || !isValidInterfaceTheme(nextAccent, nextSurface)
    ) {
      throw new TypeError("界面主题预览数据无效");
    }
    const previousAccent = themeAccent.input.value;
    const previousSurface = themeSurface.input.value;
    try {
      themeAccent.input.value = nextAccent;
      themeSurface.input.value = nextSurface;
    } catch {
      try {
        themeAccent.input.value = previousAccent;
      } catch {
        // 单个原生颜色控件失效时仍继续恢复另一个控件。
      }
      try {
        themeSurface.input.value = previousSurface;
      } catch {
        // 表单无法恢复时，运行时 Token 仍保持上一份安全界面。
      }
      throw new Error("界面主题控件暂时无法更新");
    }
  };

  const customSelectionMissingForState = (state) => {
    const customWallpaper = state.customWallpaper ?? {};
    const formWallpaperKind = selectedChoiceValue(
      sourceChoices,
      state.draft.wallpaperKind,
    );
    if (formWallpaperKind !== "custom") return false;
    const runtimeDraftCustom = state.draft.wallpaperKind === "custom";
    return !(runtimeDraftCustom
      ? customWallpaper.selectedReady === true
      : customWallpaper.pending === true || customWallpaper.saved === true);
  };

  const renderThemeDraftControls = (state) => {
    const interactionBusy = busy || state.busy === true;
    const customWallpaper = state.customWallpaper ?? {};
    const formDirty = state.dirty || localThemeDraft;
    root.dataset.dirty = String(formDirty);
    fileInput.disabled = interactionBusy || localThemeDraft;
    chooseImageButton.disabled = interactionBusy || localThemeDraft;
    deleteButton.disabled = interactionBusy
      || localThemeDraft
      || customWallpaper.saved !== true;
    applyButton.disabled = interactionBusy
      || localThemeDraft
      || !state.dirty
      || customSelectionMissingForState(state);
    cancelButton.disabled = interactionBusy || !formDirty;
    resetButton.disabled = interactionBusy || (
      !localThemeDraft
      && personalizationPreferencesEqual(state.draft, PERSONALIZATION_DEFAULTS)
    );
  };

  const renderThemeDraft = (
    state = latestState,
    theme = currentThemeInputState(),
  ) => {
    renderThemePresentation(theme);
    if (state) renderThemeDraftControls(state);
    return theme;
  };

  const renderState = (state, { preserveDraftValues = false } = {}) => {
    latestState = state;
    const preserveFormDraft = localThemeDraft || preserveDraftValues;
    const interactionBusy = busy || state.busy === true;
    const customWallpaper = state.customWallpaper ?? {};
    for (const [value, choice] of motionChoices) {
      if (!preserveFormDraft) choice.input.checked = state.draft.animations === value;
      choice.selection.textContent = choiceSelectionText(choice.input.checked);
    }
    for (const [value, choice] of sourceChoices) {
      if (!preserveFormDraft) choice.input.checked = state.draft.wallpaperKind === value;
      choice.selection.textContent = choiceSelectionText(choice.input.checked);
    }
    for (const [value, choice] of colorChoices) {
      if (!preserveFormDraft) choice.input.checked = state.draft.wallpaperColor === value;
      choice.selection.textContent = choiceSelectionText(choice.input.checked);
    }
    if (!preserveFormDraft) {
      setThemeInputsFromDraft(state.draft);
      wallpaperFit.select.value = state.draft.wallpaperFit;
      for (const [value, choice] of positionChoices) {
        choice.input.checked = state.draft.wallpaperPosition === value;
      }
      wallpaperMaskTone.select.value = state.draft.wallpaperMaskTone;
      maskStrengthInput.value = String(state.draft.wallpaperMaskStrength);
      wallpaperBlur.select.value = state.draft.wallpaperBlur;
      windowOpacity.select.value = state.draft.windowOpacity;
    }
    renderThemePresentation();
    renderMaskStrength(maskStrengthInput.value);

    const formAnimations = selectedChoiceValue(
      motionChoices,
      state.draft.animations,
    );
    const limitation = deriveMotionLimitationState(formAnimations, state.motion);
    motionLimit.hidden = !limitation.limited;
    motionLimit.textContent = limitation.message;

    if (customWallpaper.loading) {
      customImageState.dataset.personalizationImageState = "loading";
      customImageState.textContent = "正在检查浏览器中已保存的本地壁纸…";
    } else if (customWallpaper.pending && customWallpaper.saved) {
      customImageState.dataset.personalizationImageState = "pending";
      customImageState.textContent = "待应用：新图片正在预览，当前壁纸尚未替换。";
    } else if (customWallpaper.pending) {
      customImageState.dataset.personalizationImageState = "pending";
      customImageState.textContent = "待应用：新图片正在预览。";
    } else if (customWallpaper.saved) {
      customImageState.dataset.personalizationImageState = "saved";
      customImageState.textContent = "本地壁纸已保存。";
    } else if (customWallpaper.storageAvailable === false) {
      customImageState.dataset.personalizationImageState = "unavailable";
      customImageState.textContent = "无法保存本地壁纸，但仍可临时预览。";
    } else {
      customImageState.dataset.personalizationImageState = "empty";
      customImageState.textContent = "尚未保存本地壁纸。";
    }
    if (
      !customWallpaper.loading
      && busyAction === ""
      && importStatus.dataset.personalizationImportStatus === "loading"
    ) {
      importStatus.dataset.personalizationImportStatus = "idle";
      importStatus.textContent = customWallpaper.saved
        ? "已找到浏览器中保存的本地壁纸。"
        : "尚无可用的已保存图片；可以选择一张新图片。";
    }

    const formWallpaperKind = selectedChoiceValue(
      sourceChoices,
      state.draft.wallpaperKind,
    );
    const customMode = formWallpaperKind === "custom";
    const runtimeDraftCustom = state.draft.wallpaperKind === "custom";
    const customSelectionReady = customMode && (
      runtimeDraftCustom
        ? customWallpaper.selectedReady === true
        : customWallpaper.pending === true || customWallpaper.saved === true
    );
    const imageControlsDisabled = interactionBusy || !customSelectionReady;
    const formWallpaperFit = wallpaperFit.select.value || state.draft.wallpaperFit;
    const tileSelected = formWallpaperFit === "tile";
    const formWallpaperPosition = selectedChoiceValue(
      positionChoices,
      state.draft.wallpaperPosition,
    );
    const retainedPosition = WALLPAPER_POSITION_CHOICES.find(
      (choice) => choice.id === formWallpaperPosition,
    )?.label ?? "居中";

    imageSettingsPanel.hidden = !customMode;
    imageSettingsPanel.setAttribute("aria-disabled", String(imageControlsDisabled));
    if (!customMode) {
      imageControlsStatus.dataset.personalizationImageControls = "inactive";
      imageControlsStatus.textContent = "图片设置在内置纯色模式下不启用。";
    } else if (customWallpaper.loading && !customSelectionReady) {
      imageControlsStatus.dataset.personalizationImageControls = "loading";
      imageControlsStatus.textContent = "正在检查本地图片；确认有可显示图片前，以下控件暂时禁用。";
    } else if (!customSelectionReady) {
      imageControlsStatus.dataset.personalizationImageControls = "missing";
      imageControlsStatus.textContent = "尚无可显示的本地图片；以下控件已禁用，当前图片设置不会被视为已生效。";
    } else if (interactionBusy) {
      imageControlsStatus.dataset.personalizationImageControls = "busy";
      imageControlsStatus.textContent = "图片或设置操作正在处理；以下控件暂时禁用，完成后可继续调整。";
    } else {
      imageControlsStatus.dataset.personalizationImageControls = "ready";
      imageControlsStatus.textContent = "本地图片可显示。";
    }
    tilePositionNote.hidden = !tileSelected;
    tilePositionNote.textContent = `平铺模式不使用图片位置；切换回其他模式后恢复“${retainedPosition}”。`;

    motionFieldset.disabled = interactionBusy;
    themeFieldset.disabled = interactionBusy;
    themeAccent.input.disabled = interactionBusy;
    themeSurface.input.disabled = interactionBusy;
    sourceFieldset.disabled = interactionBusy;
    colorFieldset.disabled = interactionBusy || customMode;
    wallpaperFit.select.disabled = imageControlsDisabled;
    positionFieldset.disabled = imageControlsDisabled || tileSelected;
    wallpaperMaskTone.select.disabled = imageControlsDisabled;
    maskStrengthInput.disabled = imageControlsDisabled;
    wallpaperBlur.select.disabled = imageControlsDisabled;
    windowFieldset.disabled = interactionBusy;
    windowOpacity.select.disabled = interactionBusy;
    renderThemeDraftControls(state);
    applyButton.setAttribute("aria-busy", String(busyAction === "apply"));
    chooseImageButton.setAttribute("aria-busy", String(busyAction === "import"));
    deleteButton.setAttribute("aria-busy", String(busyAction === "delete"));
    applyButton.textContent = busyAction === "apply" ? "正在应用…" : "应用";
    chooseImageButton.textContent = busyAction === "import"
      ? "正在处理图片…"
      : "选择本地图片";
    deleteButton.textContent = busyAction === "delete"
      ? "正在删除…"
      : "删除已保存图片";
  };

  return Object.freeze({
    elements: Object.freeze({
      form,
      fileInput,
      chooseImageButton,
      deleteButton,
      applyButton,
      cancelButton,
      resetButton,
      status,
      importStatus,
      customImageState,
      motionLimit,
      themeFieldset,
      themeAccentInput: themeAccent.input,
      themeAccentOutput: themeAccent.output,
      themeSurfaceInput: themeSurface.input,
      themeSurfaceOutput: themeSurface.output,
      themeContrastStatus,
      imageSettingsPanel,
      imageControlsStatus,
      wallpaperFit: wallpaperFit.select,
      positionFieldset,
      positionInputs: Object.freeze(Object.fromEntries(
        [...positionChoices].map(([value, choice]) => [value, choice.input]),
      )),
      tilePositionNote,
      wallpaperMaskTone: wallpaperMaskTone.select,
      maskStrengthInput,
      maskStrengthOutput,
      wallpaperBlur: wallpaperBlur.select,
      windowFieldset,
      windowOpacity: windowOpacity.select,
    }),
    readDraft(currentDraft) {
      const animations = [...motionChoices].find(([, choice]) => choice.input.checked)?.[0]
        ?? currentDraft.animations;
      const wallpaperKind = [...sourceChoices].find(([, choice]) => choice.input.checked)?.[0]
        ?? currentDraft.wallpaperKind;
      const wallpaperColor = [...colorChoices].find(([, choice]) => choice.input.checked)?.[0]
        ?? currentDraft.wallpaperColor;
      const wallpaperPosition = [...positionChoices].find(
        ([, choice]) => choice.input.checked,
      )?.[0] ?? currentDraft.wallpaperPosition;
      const rawMaskStrength = String(maskStrengthInput.value);
      const wallpaperMaskStrength = /^(?:0|[1-9]\d*)$/.test(rawMaskStrength)
        ? Number(rawMaskStrength)
        : Number.NaN;
      return {
        ...projectPersonalizationPreferences({
          ...currentDraft,
          animations,
          wallpaperKind,
          wallpaperColor,
          wallpaperFit: wallpaperFit.select.value,
          wallpaperPosition,
          wallpaperMaskTone: wallpaperMaskTone.select.value,
          wallpaperMaskStrength,
          wallpaperBlur: wallpaperBlur.select.value,
          windowOpacity: windowOpacity.select.value,
          themeAccent: themeAccent.input.value,
          themeSurface: themeSurface.input.value,
        }),
      };
    },
    beginThemeDraft() {
      localThemeDraft = true;
      themePreviewError = false;
      const theme = currentThemeInputState();
      localThemeInvalid = !theme.valid;
      return renderThemeDraft(latestState, theme);
    },
    getThemeDraftState() {
      return currentThemeInputState();
    },
    hasLocalThemeDraft() {
      return localThemeDraft;
    },
    hasInvalidThemeDraft() {
      return localThemeDraft && localThemeInvalid;
    },
    retainThemePreviewError() {
      localThemeDraft = true;
      const theme = currentThemeInputState();
      localThemeInvalid = !theme.valid;
      themePreviewError = true;
      renderThemeDraft(latestState, theme);
    },
    acceptThemeDraft(state) {
      latestState = state;
      localThemeDraft = false;
      localThemeInvalid = false;
      themePreviewError = false;
      renderThemeDraft(state);
    },
    clearLocalThemeDraft() {
      localThemeDraft = false;
      localThemeInvalid = false;
      themePreviewError = false;
    },
    refreshLocalDraft() {
      if (latestState) renderState(latestState);
      return currentThemeInputState();
    },
    isDirty(state = latestState) {
      return localThemeDraft || state?.dirty === true;
    },
    renderState,
    setBusy(value, action = "") {
      busy = Boolean(value);
      busyAction = busy ? action : "";
      if (latestState) renderState(latestState);
    },
    setStatus(kind, message) {
      if (!STATUS_KINDS.has(kind)) throw new TypeError("外观设置状态类型无效");
      status.dataset.personalizationStatus = kind;
      status.textContent = message;
    },
    setImportStatus(kind, message) {
      if (!IMPORT_STATUS_KINDS.has(kind)) throw new TypeError("图片导入状态类型无效");
      importStatus.dataset.personalizationImportStatus = kind;
      importStatus.textContent = message;
    },
    focusAfter(action) {
      const preferred = {
        apply: applyButton,
        cancel: cancelButton,
        reset: resetButton,
        import: chooseImageButton,
        delete: deleteButton,
      }[action];
      if (preferred instanceof HTMLButtonElement && !preferred.disabled) {
        preferred.focus({ preventScroll: true });
        return;
      }
      sourceChoices.get("color")?.input.focus({ preventScroll: true });
    },
    destroy() {
      latestState = null;
      localThemeDraft = false;
      localThemeInvalid = false;
      themePreviewError = false;
      root.replaceChildren();
      root.removeAttribute("aria-labelledby");
      root.removeAttribute("data-dirty");
      root.removeAttribute("aria-busy");
    },
  });
}
