import { WALLPAPER_IMAGE_LIMITS } from "./personalization-model.js";

const EXTENSION_MEDIA_TYPES = new Map([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["webp", "image/webp"],
]);
const INPUT_MEDIA_TYPES = new Set(WALLPAPER_IMAGE_LIMITS.inputMediaTypes);
const OUTPUT_MEDIA_TYPES = new Set(WALLPAPER_IMAGE_LIMITS.outputMediaTypes);

const IMPORT_ERROR_MESSAGES = Object.freeze({
  invalid_file: "请选择有效的本地图片文件。",
  unsupported_extension: "仅支持 JPG、PNG 或 WebP 图片。",
  unsupported_media_type: "文件声明的图片类型不受支持。",
  empty_file: "所选图片为空。",
  file_too_large: "图片大小不能超过 15 MiB。",
  file_unreadable: "无法安全读取所选图片。",
  format_mismatch: "图片格式与文件声明不一致。",
  decode_failed: "图片无法解码或内容已损坏。",
  invalid_dimensions: "图片尺寸无效。",
  capability_unavailable: "当前浏览器无法安全处理本地图片。",
  image_processing_failed: "图片处理失败，请选择其他图片。",
  encode_failed: "图片无法重新编码为安全的静态格式。",
});

const SMALL_IMAGE_WARNING = Object.freeze({
  code: "small_dimensions",
  message: "图片尺寸低于建议的 320 × 180 像素，仍可继续使用。",
});

export class WallpaperImageImportError extends Error {
  constructor(code) {
    const safeCode = Object.prototype.hasOwnProperty.call(IMPORT_ERROR_MESSAGES, code)
      ? code
      : "image_processing_failed";
    super(IMPORT_ERROR_MESSAGES[safeCode]);
    this.name = "WallpaperImageImportError";
    this.code = safeCode;
  }
}

function importError(code) {
  return new WallpaperImageImportError(code);
}

function controlledImportError(error, fallbackCode) {
  return error instanceof WallpaperImageImportError ? error : importError(fallbackCode);
}

function browserValue(name) {
  try {
    return globalThis[name];
  } catch {
    return undefined;
  }
}

function optionValue(options, key, fallback) {
  return Object.prototype.hasOwnProperty.call(options, key) ? options[key] : fallback;
}

function fileMetadata(file) {
  if (!file || (typeof file !== "object" && typeof file !== "function")) {
    throw importError("invalid_file");
  }
  try {
    const metadata = {
      name: file.name,
      mediaType: file.type,
      size: file.size,
      slice: file.slice,
    };
    if (
      typeof metadata.name !== "string"
      || typeof metadata.mediaType !== "string"
      || !Number.isSafeInteger(metadata.size)
      || metadata.size < 0
      || typeof metadata.slice !== "function"
    ) {
      throw importError("invalid_file");
    }
    return metadata;
  } catch (error) {
    throw controlledImportError(error, "invalid_file");
  }
}

function extensionMediaType(name) {
  const match = /\.([^.]+)$/.exec(name);
  if (!match) return null;
  return EXTENSION_MEDIA_TYPES.get(match[1].toLowerCase()) ?? null;
}

async function readHeader(blobLike, byteLength = 32) {
  try {
    const headerBlob = blobLike.slice(0, byteLength);
    if (!headerBlob || typeof headerBlob.arrayBuffer !== "function") {
      throw importError("file_unreadable");
    }
    const buffer = await headerBlob.arrayBuffer();
    return new Uint8Array(buffer);
  } catch (error) {
    throw controlledImportError(error, "file_unreadable");
  }
}

function bytesEqual(bytes, expected, offset = 0) {
  if (bytes.length < offset + expected.length) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

function asciiEquals(bytes, text, offset = 0) {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index += 1) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
}

function littleEndianUint32(bytes, offset) {
  if (bytes.length < offset + 4) return null;
  return (
    bytes[offset]
    + (bytes[offset + 1] * 0x100)
    + (bytes[offset + 2] * 0x10000)
    + (bytes[offset + 3] * 0x1000000)
  );
}

function signatureMediaType(bytes, size) {
  if (bytesEqual(bytes, [0xFF, 0xD8, 0xFF])) return "image/jpeg";
  if (bytesEqual(bytes, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) {
    return "image/png";
  }
  if (
    asciiEquals(bytes, "RIFF", 0)
    && asciiEquals(bytes, "WEBP", 8)
    && ["VP8 ", "VP8L", "VP8X"].some((chunk) => asciiEquals(bytes, chunk, 12))
    && littleEndianUint32(bytes, 4) === size - 8
  ) {
    return "image/webp";
  }
  return null;
}

function nativeBlob(value, BlobConstructor = browserValue("Blob")) {
  if (typeof BlobConstructor !== "function") return false;
  try {
    return value instanceof BlobConstructor
      && Object.prototype.toString.call(value) === "[object Blob]";
  } catch {
    return false;
  }
}

export async function hasSafeWallpaperOutputSignature(
  blob,
  mediaType,
  { BlobConstructor = browserValue("Blob") } = {},
) {
  if (
    !nativeBlob(blob, BlobConstructor)
    || !OUTPUT_MEDIA_TYPES.has(mediaType)
    || blob.type !== mediaType
    || !Number.isSafeInteger(blob.size)
    || blob.size <= 0
  ) {
    return false;
  }
  let bytes;
  try {
    bytes = await readHeader(blob);
  } catch {
    return false;
  }
  if (signatureMediaType(bytes, blob.size) !== mediaType) return false;
  if (mediaType === "image/webp" && asciiEquals(bytes, "VP8X", 12)) {
    if (bytes.length < 21 || (bytes[20] & 0x02) !== 0) return false;
  }
  return true;
}

export async function validateWallpaperImageInput(file) {
  const metadata = fileMetadata(file);
  const expectedFromExtension = extensionMediaType(metadata.name);
  if (!expectedFromExtension) throw importError("unsupported_extension");
  if (!INPUT_MEDIA_TYPES.has(metadata.mediaType)) {
    throw importError("unsupported_media_type");
  }
  if (metadata.size === 0) throw importError("empty_file");
  if (metadata.size > WALLPAPER_IMAGE_LIMITS.maxInputBytes) {
    throw importError("file_too_large");
  }

  const bytes = await readHeader(file);
  const detectedMediaType = signatureMediaType(bytes, metadata.size);
  if (
    detectedMediaType === null
    || detectedMediaType !== metadata.mediaType
    || detectedMediaType !== expectedFromExtension
  ) {
    throw importError("format_mismatch");
  }
  return Object.freeze({ mediaType: detectedMediaType });
}

export function calculateWallpaperOutputDimensions(
  sourceWidth,
  sourceHeight,
  maxEdge = WALLPAPER_IMAGE_LIMITS.maxEdge,
) {
  if (
    !Number.isSafeInteger(sourceWidth)
    || !Number.isSafeInteger(sourceHeight)
    || sourceWidth <= 0
    || sourceHeight <= 0
    || !Number.isSafeInteger(maxEdge)
    || maxEdge <= 0
  ) {
    throw new TypeError("图片尺寸必须是正整数");
  }

  const longestEdge = Math.max(sourceWidth, sourceHeight);
  if (longestEdge <= maxEdge) {
    return Object.freeze({ width: sourceWidth, height: sourceHeight });
  }
  const scale = maxEdge / longestEdge;
  return Object.freeze({
    width: Math.max(1, Math.min(maxEdge, Math.round(sourceWidth * scale))),
    height: Math.max(1, Math.min(maxEdge, Math.round(sourceHeight * scale))),
  });
}

function createImageElementDecoder({ ImageConstructor, urlApi }) {
  if (
    typeof ImageConstructor !== "function"
    || typeof urlApi?.createObjectURL !== "function"
    || typeof urlApi?.revokeObjectURL !== "function"
  ) {
    return null;
  }
  return async (blob) => {
    const objectUrl = urlApi.createObjectURL(blob);
    let image = null;
    let retained = true;
    const release = () => {
      if (!retained) return;
      retained = false;
      try {
        if (image) {
          image.onload = null;
          image.onerror = null;
          image.removeAttribute?.("src");
        }
      } catch {
        // 临时图片资源清理失败不能暴露输入信息或覆盖主错误。
      }
      try {
        urlApi.revokeObjectURL(objectUrl);
      } catch {
        // 同上；Object URL 永不离开本适配器。
      }
    };
    try {
      image = new ImageConstructor();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = objectUrl;
      });
      image.onload = null;
      image.onerror = null;
      return {
        source: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        release,
      };
    } catch (error) {
      release();
      throw error;
    }
  };
}

export function createBrowserWallpaperImageAdapter(options = {}) {
  const createImageBitmapFunction = optionValue(
    options,
    "createImageBitmap",
    browserValue("createImageBitmap"),
  );
  const OffscreenCanvasConstructor = optionValue(
    options,
    "OffscreenCanvas",
    browserValue("OffscreenCanvas"),
  );
  const documentObject = optionValue(options, "document", browserValue("document"));
  const ImageConstructor = optionValue(options, "Image", browserValue("Image"));
  const urlApi = optionValue(options, "URL", browserValue("URL"));
  const decodeWithImageElement = createImageElementDecoder({ ImageConstructor, urlApi });

  return Object.freeze({
    async decode(blob) {
      if (typeof createImageBitmapFunction === "function") {
        let bitmap = null;
        try {
          bitmap = await createImageBitmapFunction(blob, {
            imageOrientation: "from-image",
          });
          const width = bitmap.width;
          const height = bitmap.height;
          let retained = true;
          return {
            source: bitmap,
            width,
            height,
            release() {
              if (!retained) return;
              retained = false;
              if (typeof bitmap.close === "function") bitmap.close();
            },
          };
        } catch (error) {
          try {
            bitmap?.close?.();
          } catch {
            // 失败的临时位图不再被引用。
          }
          if (!decodeWithImageElement) throw error;
        }
      }
      if (decodeWithImageElement) return decodeWithImageElement(blob);
      throw importError("capability_unavailable");
    },
    createCanvas(width, height) {
      let canvas;
      if (typeof OffscreenCanvasConstructor === "function") {
        canvas = new OffscreenCanvasConstructor(width, height);
      } else if (typeof documentObject?.createElement === "function") {
        canvas = documentObject.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
      } else {
        throw importError("capability_unavailable");
      }
      return canvas;
    },
    draw(canvas, source, width, height) {
      const context = canvas?.getContext?.("2d");
      if (!context || typeof context.drawImage !== "function") {
        throw importError("capability_unavailable");
      }
      context.clearRect(0, 0, width, height);
      context.drawImage(source, 0, 0, width, height);
    },
    async encode(canvas, mediaType, quality) {
      if (typeof canvas?.convertToBlob === "function") {
        return canvas.convertToBlob({ type: mediaType, quality });
      }
      if (typeof canvas?.toBlob === "function") {
        return new Promise((resolve, reject) => {
          canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error("canvas_encode_failed"));
          }, mediaType, quality);
        });
      }
      throw importError("capability_unavailable");
    },
    releaseDecoded(decoded) {
      decoded?.release?.();
    },
    releaseCanvas(canvas) {
      if (!canvas) return;
      try {
        canvas.width = 0;
        canvas.height = 0;
      } catch {
        // 一次性 Canvas 不再被引用，忽略实现特定的释放异常。
      }
    },
  });
}

function requireAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") throw importError("capability_unavailable");
  for (const method of ["decode", "createCanvas", "draw", "encode"]) {
    if (typeof adapter[method] !== "function") throw importError("capability_unavailable");
  }
  return adapter;
}

async function encodeStaticImage(canvas, adapter) {
  const attempts = [
    ["image/webp", WALLPAPER_IMAGE_LIMITS.webpQuality],
    ["image/png", undefined],
  ];
  for (const [mediaType, quality] of attempts) {
    try {
      const blob = await adapter.encode(canvas, mediaType, quality);
      if (await hasSafeWallpaperOutputSignature(blob, blob?.type)) {
        const BlobConstructor = browserValue("Blob");
        if (typeof BlobConstructor !== "function") {
          throw importError("capability_unavailable");
        }
        const safeBlob = new BlobConstructor([blob], { type: blob.type });
        if (await hasSafeWallpaperOutputSignature(safeBlob, safeBlob.type)) {
          return safeBlob;
        }
      }
    } catch {
      // WebP 不可用时继续尝试静态 PNG；底层异常不向外泄漏。
    }
  }
  throw importError("encode_failed");
}

function imageWarning(width, height) {
  return width < WALLPAPER_IMAGE_LIMITS.suggestedMinWidth
    || height < WALLPAPER_IMAGE_LIMITS.suggestedMinHeight
    ? SMALL_IMAGE_WARNING
    : null;
}

export async function probeWallpaperImageBlob(
  blob,
  {
    mediaType = blob?.type,
    adapter: suppliedAdapter,
  } = {},
) {
  if (!await hasSafeWallpaperOutputSignature(blob, mediaType)) {
    throw importError("decode_failed");
  }

  let adapter;
  try {
    adapter = requireAdapter(suppliedAdapter ?? createBrowserWallpaperImageAdapter());
  } catch (error) {
    throw controlledImportError(error, "capability_unavailable");
  }

  let decoded = null;
  try {
    decoded = await adapter.decode(blob);
    const width = decoded?.width;
    const height = decoded?.height;
    if (
      !Number.isSafeInteger(width)
      || !Number.isSafeInteger(height)
      || width <= 0
      || height <= 0
      || width > WALLPAPER_IMAGE_LIMITS.maxEdge
      || height > WALLPAPER_IMAGE_LIMITS.maxEdge
    ) {
      throw importError("invalid_dimensions");
    }
    return Object.freeze({ width, height });
  } catch (error) {
    throw controlledImportError(error, "decode_failed");
  } finally {
    try {
      adapter.releaseDecoded?.(decoded);
    } catch {
      // 持久化 Blob 的一次性解码探测不得遗留临时位图或 Object URL。
    }
  }
}

export async function importWallpaperImage(file, { adapter: suppliedAdapter } = {}) {
  await validateWallpaperImageInput(file);
  let adapter;
  try {
    adapter = requireAdapter(suppliedAdapter ?? createBrowserWallpaperImageAdapter());
  } catch (error) {
    throw controlledImportError(error, "capability_unavailable");
  }

  let decoded = null;
  let canvas = null;
  let failureCode = "decode_failed";
  try {
    decoded = await adapter.decode(file);
    let dimensions;
    try {
      dimensions = calculateWallpaperOutputDimensions(decoded?.width, decoded?.height);
    } catch {
      throw importError("invalid_dimensions");
    }

    failureCode = "image_processing_failed";
    canvas = adapter.createCanvas(dimensions.width, dimensions.height);
    await adapter.draw(
      canvas,
      decoded.source,
      dimensions.width,
      dimensions.height,
    );

    failureCode = "encode_failed";
    const blob = await encodeStaticImage(canvas, adapter);
    const image = Object.freeze({
      blob,
      mediaType: blob.type,
      width: dimensions.width,
      height: dimensions.height,
      version: WALLPAPER_IMAGE_LIMITS.version,
    });
    return Object.freeze({
      image,
      warning: imageWarning(dimensions.width, dimensions.height),
    });
  } catch (error) {
    throw controlledImportError(error, failureCode);
  } finally {
    try {
      adapter.releaseCanvas?.(canvas);
    } catch {
      // 清理异常不覆盖受控导入结果。
    }
    try {
      adapter.releaseDecoded?.(decoded);
    } catch {
      // 清理异常不覆盖受控导入结果。
    }
  }
}
