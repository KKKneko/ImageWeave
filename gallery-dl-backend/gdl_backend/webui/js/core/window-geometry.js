const RECT_KEYS = Object.freeze(["x", "y", "w", "h"]);
const VIEWPORT_KEYS = Object.freeze(["width", "height"]);
const DELTA_KEYS = Object.freeze(["x", "y"]);
const OFFSET_DELTA_KEYS = Object.freeze(["dx", "dy"]);
const OPTION_KEYS = Object.freeze(["minW", "minH", "taskbarHeight"]);

export const WINDOW_MIN_WIDTH = 360;
export const WINDOW_MIN_HEIGHT = 240;
export const WINDOW_VISIBLE_MARGIN = 32;

function dataDescriptors(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label}必须是普通对象`);
  }
  let prototype;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError(`${label}必须是普通对象`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label}必须是普通对象`);
  }
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = descriptors[key];
    if (typeof key !== "string" || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new TypeError(`${label}只能包含数据字段`);
    }
  }
  return descriptors;
}

function exactRecord(value, keys, label) {
  const descriptors = dataDescriptors(value, label);
  const actualKeys = Reflect.ownKeys(descriptors);
  if (
    actualKeys.length !== keys.length
    || keys.some((key) => !Object.prototype.hasOwnProperty.call(descriptors, key))
  ) {
    throw new TypeError(`${label}字段无效`);
  }
  const result = {};
  for (const key of keys) {
    const field = descriptors[key].value;
    if (!Number.isFinite(field)) throw new TypeError(`${label}字段必须是有限数字`);
    result[key] = field;
  }
  return result;
}

function projectRect(value) {
  const rect = exactRecord(value, RECT_KEYS, "窗口矩形");
  if (rect.w <= 0 || rect.h <= 0) throw new TypeError("窗口尺寸必须大于零");
  return rect;
}

function projectViewport(value) {
  const viewport = exactRecord(value, VIEWPORT_KEYS, "视口");
  if (
    viewport.width < WINDOW_VISIBLE_MARGIN
    || viewport.height < WINDOW_VISIBLE_MARGIN
  ) {
    throw new RangeError("视口尺寸过小");
  }
  return viewport;
}

function projectDelta(value) {
  const descriptors = dataDescriptors(value, "窗口位移");
  const keys = Reflect.ownKeys(descriptors);
  const usesCoordinates = keys.length === DELTA_KEYS.length
    && DELTA_KEYS.every((key) => Object.prototype.hasOwnProperty.call(descriptors, key));
  const usesOffsets = keys.length === OFFSET_DELTA_KEYS.length
    && OFFSET_DELTA_KEYS.every((key) => Object.prototype.hasOwnProperty.call(descriptors, key));
  if (!usesCoordinates && !usesOffsets) throw new TypeError("窗口位移字段无效");
  const x = descriptors[usesCoordinates ? "x" : "dx"].value;
  const y = descriptors[usesCoordinates ? "y" : "dy"].value;
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new TypeError("窗口位移字段必须是有限数字");
  }
  return { x, y };
}

function projectOptions(value = {}) {
  const descriptors = dataDescriptors(value, "窗口几何选项");
  for (const key of Reflect.ownKeys(descriptors)) {
    if (!OPTION_KEYS.includes(key)) throw new TypeError("窗口几何选项包含未知字段");
  }
  const numberOption = (key, fallback) => {
    if (!Object.prototype.hasOwnProperty.call(descriptors, key)) return fallback;
    const candidate = descriptors[key].value;
    if (!Number.isFinite(candidate)) throw new TypeError(`窗口几何选项 ${key} 无效`);
    return candidate;
  };
  const minW = numberOption("minW", WINDOW_MIN_WIDTH);
  const minH = numberOption("minH", WINDOW_MIN_HEIGHT);
  const taskbarHeight = numberOption("taskbarHeight", 0);
  if (minW < WINDOW_VISIBLE_MARGIN || minH < WINDOW_VISIBLE_MARGIN) {
    throw new RangeError("窗口最小尺寸不得小于可见边界");
  }
  if (taskbarHeight < 0) throw new RangeError("任务栏高度不得为负数");
  return { minW, minH, taskbarHeight };
}

function projectGeometry(viewportValue, optionsValue) {
  const viewport = projectViewport(viewportValue);
  const options = projectOptions(optionsValue);
  const availableHeight = viewport.height - options.taskbarHeight;
  if (availableHeight < WINDOW_VISIBLE_MARGIN) {
    throw new RangeError("任务栏之外的可用高度过小");
  }
  return { viewport, options, availableHeight };
}

function clamp(value, minimum, maximum) {
  return Math.min(Math.max(value, minimum), maximum);
}

export function clampRect(rectValue, viewportValue, optionsValue = {}) {
  const rect = projectRect(rectValue);
  const { viewport, options, availableHeight } = projectGeometry(
    viewportValue,
    optionsValue,
  );
  const w = Math.max(rect.w, options.minW);
  const h = Math.max(rect.h, options.minH);
  return {
    x: clamp(rect.x, WINDOW_VISIBLE_MARGIN - w, viewport.width - WINDOW_VISIBLE_MARGIN),
    // 下边缘始终停在任务栏上方；窗口过高时允许标题区域以外部分越过视口顶部。
    y: clamp(rect.y, WINDOW_VISIBLE_MARGIN - h, availableHeight - h),
    w,
    h,
  };
}

export function nextRectForDrag(
  startRectValue,
  deltaValue,
  viewportValue,
  optionsValue = {},
) {
  const delta = projectDelta(deltaValue);
  const startRect = clampRect(startRectValue, viewportValue, optionsValue);
  return clampRect({
    ...startRect,
    x: startRect.x + delta.x,
    y: startRect.y + delta.y,
  }, viewportValue, optionsValue);
}

export function nextRectForResize(
  startRectValue,
  deltaValue,
  viewportValue,
  optionsValue = {},
) {
  const delta = projectDelta(deltaValue);
  const { viewport, options, availableHeight } = projectGeometry(
    viewportValue,
    optionsValue,
  );
  const startRect = clampRect(startRectValue, viewport, options);
  const desiredWidth = Math.max(options.minW, startRect.w + delta.x);
  const desiredHeight = Math.max(options.minH, startRect.h + delta.y);
  const horizontalRoom = viewport.width - startRect.x;
  const verticalRoom = availableHeight - startRect.y;
  const w = horizontalRoom >= options.minW
    ? Math.min(desiredWidth, horizontalRoom)
    : options.minW;
  const h = verticalRoom >= options.minH
    ? Math.min(desiredHeight, verticalRoom)
    : options.minH;
  return clampRect({ x: startRect.x, y: startRect.y, w, h }, viewport, options);
}

export function maximizedRect(viewportValue, optionsValue = {}) {
  const { viewport, availableHeight } = projectGeometry(viewportValue, optionsValue);
  return { x: 0, y: 0, w: viewport.width, h: availableHeight };
}
