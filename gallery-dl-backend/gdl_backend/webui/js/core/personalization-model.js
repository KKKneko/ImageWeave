export const BUILT_IN_WALLPAPER_COLORS = Object.freeze({
  graphite: "#20242A",
  slate: "#384554",
  "deep-ocean": "#20364A",
  forest: "#294039",
  "plum-gray": "#403341",
  "warm-paper": "#E7E1D6",
});

export const BUILT_IN_WALLPAPER_COLOR_IDS = Object.freeze(
  Object.keys(BUILT_IN_WALLPAPER_COLORS),
);

export const WALLPAPER_IMAGE_LIMITS = Object.freeze({
  inputExtensions: Object.freeze(["jpg", "jpeg", "png", "webp"]),
  inputMediaTypes: Object.freeze(["image/jpeg", "image/png", "image/webp"]),
  outputMediaTypes: Object.freeze(["image/webp", "image/png"]),
  maxInputBytes: 15 * 1024 * 1024,
  maxEdge: 4096,
  suggestedMinWidth: 320,
  suggestedMinHeight: 180,
  webpQuality: 0.88,
  version: 1,
});

export const INTERFACE_THEME_DEFAULTS = Object.freeze({
  themeAccent: "#46515D",
  themeSurface: "#F4F1EA",
});

export const INTERFACE_THEME_PREFERENCE_KEYS = Object.freeze([
  "themeAccent",
  "themeSurface",
]);

// 黑色与白色前景对底色的对比度相等时：
// (L + 0.05) / 0.05 = 1.05 / (L + 0.05)。
export const INTERFACE_THEME_TONE_LUMINANCE_THRESHOLD =
  Math.sqrt(1.05 * 0.05) - 0.05;

export function normalizeThemeHex(value) {
  if (typeof value !== "string" || !/^#[0-9A-Fa-f]{6}$/.test(value)) {
    return null;
  }
  return value.toUpperCase();
}

function requireThemeHex(value) {
  const normalized = normalizeThemeHex(value);
  if (!normalized) throw new TypeError("界面主题颜色必须是六位 HEX");
  return normalized;
}

export function calculateSrgbRelativeLuminance(value) {
  const normalized = requireThemeHex(value);
  const linearChannel = (offset) => {
    const channel = Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * linearChannel(1)
    + 0.7152 * linearChannel(3)
    + 0.0722 * linearChannel(5)
  );
}

export function calculateThemeContrastRatio(themeAccent, themeSurface) {
  const accentLuminance = calculateSrgbRelativeLuminance(themeAccent);
  const surfaceLuminance = calculateSrgbRelativeLuminance(themeSurface);
  return (
    (Math.max(accentLuminance, surfaceLuminance) + 0.05)
    / (Math.min(accentLuminance, surfaceLuminance) + 0.05)
  );
}

export function isValidInterfaceTheme(themeAccent, themeSurface) {
  return normalizeThemeHex(themeAccent) !== null
    && normalizeThemeHex(themeSurface) !== null;
}

export function deriveInterfaceThemeTone(themeSurface) {
  return calculateSrgbRelativeLuminance(themeSurface)
    >= INTERFACE_THEME_TONE_LUMINANCE_THRESHOLD
    ? "light"
    : "dark";
}

const MASK_STRENGTHS = Object.freeze(
  Array.from({ length: 17 }, (_, index) => index * 5),
);

export const PERSONALIZATION_OPTIONS = Object.freeze({
  animations: Object.freeze(["on", "off"]),
  wallpaperKind: Object.freeze(["color", "custom"]),
  wallpaperColor: BUILT_IN_WALLPAPER_COLOR_IDS,
  wallpaperFit: Object.freeze(["cover", "contain", "stretch", "tile"]),
  wallpaperPosition: Object.freeze([
    "top-left",
    "top",
    "top-right",
    "left",
    "center",
    "right",
    "bottom-left",
    "bottom",
    "bottom-right",
  ]),
  wallpaperMaskTone: Object.freeze(["dark", "light"]),
  wallpaperMaskStrength: MASK_STRENGTHS,
  wallpaperBlur: Object.freeze(["off", "soft", "medium"]),
  windowOpacity: Object.freeze(["solid", "subtle", "soft"]),
});

const ENUM_PREFERENCE_KEYS = Object.freeze(
  Object.keys(PERSONALIZATION_OPTIONS),
);

export const PERSONALIZATION_PREFERENCE_KEYS = Object.freeze([
  ...ENUM_PREFERENCE_KEYS,
  ...INTERFACE_THEME_PREFERENCE_KEYS,
]);

export const PERSONALIZATION_DEFAULTS = Object.freeze({
  animations: "on",
  wallpaperKind: "color",
  wallpaperColor: "graphite",
  wallpaperFit: "cover",
  wallpaperPosition: "center",
  wallpaperMaskTone: "dark",
  wallpaperMaskStrength: 40,
  wallpaperBlur: "off",
  windowOpacity: "solid",
  ...INTERFACE_THEME_DEFAULTS,
});

const PREFERENCE_KEY_SET = new Set(PERSONALIZATION_PREFERENCE_KEYS);
const OPTION_SETS = Object.freeze(Object.fromEntries(
  Object.entries(PERSONALIZATION_OPTIONS).map(([key, values]) => [key, new Set(values)]),
));

function recordDescriptors(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    return Object.getOwnPropertyDescriptors(value);
  } catch {
    return null;
  }
}

function sourceDescriptor(descriptors, key) {
  return descriptors
    ? Object.getOwnPropertyDescriptor(descriptors, key)?.value
    : undefined;
}

function dataValue(descriptors, key) {
  const descriptor = sourceDescriptor(descriptors, key);
  return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
    ? descriptor.value
    : undefined;
}

function validPreference(key, value) {
  return OPTION_SETS[key].has(value);
}

function freezeProjection(projected) {
  return Object.freeze(projected);
}

function normalizedThemeFromDescriptors(descriptors) {
  let invalid = false;
  const normalized = {};
  for (const key of INTERFACE_THEME_PREFERENCE_KEYS) {
    const descriptor = sourceDescriptor(descriptors, key);
    if (!descriptor) {
      normalized[key] = INTERFACE_THEME_DEFAULTS[key];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      invalid = true;
      continue;
    }
    const candidate = normalizeThemeHex(descriptor.value);
    if (!candidate) {
      invalid = true;
      continue;
    }
    normalized[key] = candidate;
  }
  if (invalid) return INTERFACE_THEME_DEFAULTS;
  return Object.freeze(normalized);
}

function projectedThemeFromDescriptors(descriptors) {
  const projected = {};
  for (const key of INTERFACE_THEME_PREFERENCE_KEYS) {
    const descriptor = sourceDescriptor(descriptors, key);
    const candidate = descriptor
      ? descriptor.value
      : INTERFACE_THEME_DEFAULTS[key];
    const normalized = normalizeThemeHex(candidate);
    if (!normalized) throw new TypeError(`个性化偏好 ${key} 无效`);
    projected[key] = normalized;
  }
  return Object.freeze(projected);
}

export function normalizePersonalizationPreferences(value) {
  const descriptors = recordDescriptors(value);
  const normalized = {};
  for (const key of ENUM_PREFERENCE_KEYS) {
    const candidate = dataValue(descriptors, key);
    normalized[key] = validPreference(key, candidate)
      ? candidate
      : PERSONALIZATION_DEFAULTS[key];
  }
  Object.assign(normalized, normalizedThemeFromDescriptors(descriptors));
  return freezeProjection(normalized);
}

export function projectPersonalizationPreferences(value) {
  const descriptors = recordDescriptors(value);
  if (!descriptors) throw new TypeError("个性化偏好必须是普通对象");

  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string" || !PREFERENCE_KEY_SET.has(key)) {
      throw new TypeError("个性化偏好包含未知字段");
    }
    const descriptor = sourceDescriptor(descriptors, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new TypeError("个性化偏好字段必须是数据值");
    }
  }

  const projected = {};
  for (const key of ENUM_PREFERENCE_KEYS) {
    const descriptor = sourceDescriptor(descriptors, key);
    if (!descriptor) {
      projected[key] = PERSONALIZATION_DEFAULTS[key];
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new TypeError("个性化偏好字段必须是数据值");
    }
    if (!validPreference(key, descriptor.value)) {
      throw new TypeError(`个性化偏好 ${key} 无效`);
    }
    projected[key] = descriptor.value;
  }
  Object.assign(projected, projectedThemeFromDescriptors(descriptors));
  return freezeProjection(projected);
}

export function isValidPersonalizationPreferences(value) {
  try {
    projectPersonalizationPreferences(value);
    return true;
  } catch {
    return false;
  }
}

export function copyPersonalizationPreferences(value) {
  return { ...normalizePersonalizationPreferences(value) };
}

export function personalizationPreferencesEqual(left, right) {
  try {
    const projectedLeft = projectPersonalizationPreferences(left);
    const projectedRight = projectPersonalizationPreferences(right);
    return PERSONALIZATION_PREFERENCE_KEYS.every(
      (key) => projectedLeft[key] === projectedRight[key],
    );
  } catch {
    return false;
  }
}

export function restoreDefaultPersonalizationPreferences() {
  return { ...PERSONALIZATION_DEFAULTS };
}
