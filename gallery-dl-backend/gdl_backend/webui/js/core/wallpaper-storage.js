import { hasSafeWallpaperOutputSignature } from "./wallpaper-image-import.js";
import { WALLPAPER_IMAGE_LIMITS } from "./personalization-model.js";

export const WALLPAPER_STORAGE_SCHEMA = Object.freeze({
  databaseName: "imageweave-ui",
  databaseVersion: 1,
  storeName: "wallpapers",
  customKey: "custom",
});

const STORED_RECORD_KEYS = Object.freeze([
  "blob",
  "mediaType",
  "width",
  "height",
  "updatedAt",
  "version",
]);
const IMPORT_RESULT_KEYS = Object.freeze([
  "blob",
  "mediaType",
  "width",
  "height",
  "version",
]);
const OUTPUT_MEDIA_TYPES = new Set(WALLPAPER_IMAGE_LIMITS.outputMediaTypes);

const STORAGE_ERROR_MESSAGES = Object.freeze({
  indexeddb_unavailable: "当前浏览器无法使用本地壁纸存储。",
  storage_open_failed: "无法打开本地壁纸存储。",
  storage_blocked: "本地壁纸存储暂时被其他页面占用。",
  storage_read_failed: "无法读取已保存的本地壁纸。",
  storage_write_failed: "无法保存本地壁纸。",
  storage_delete_failed: "无法删除已保存的本地壁纸。",
  storage_quota_exceeded: "浏览器存储空间不足，未能保存本地壁纸。",
  storage_closed: "本地壁纸存储已关闭。",
});

const OPERATION_ERROR_CODES = Object.freeze({
  open: "storage_open_failed",
  read: "storage_read_failed",
  write: "storage_write_failed",
  delete: "storage_delete_failed",
});

export class WallpaperStorageError extends Error {
  constructor(code) {
    const safeCode = Object.prototype.hasOwnProperty.call(STORAGE_ERROR_MESSAGES, code)
      ? code
      : "storage_open_failed";
    super(STORAGE_ERROR_MESSAGES[safeCode]);
    this.name = "WallpaperStorageError";
    this.code = safeCode;
  }
}

function browserValue(name) {
  try {
    return globalThis[name];
  } catch {
    return undefined;
  }
}

function safeErrorName(error) {
  try {
    return typeof error?.name === "string" ? error.name : "";
  } catch {
    return "";
  }
}

export function normalizeWallpaperStorageError(error, operation = "open") {
  if (error instanceof WallpaperStorageError) return error;
  const name = safeErrorName(error);
  if (name === "QuotaExceededError") {
    return new WallpaperStorageError("storage_quota_exceeded");
  }
  if (
    name === "SecurityError"
    || name === "NotAllowedError"
    || name === "NotSupportedError"
  ) {
    return new WallpaperStorageError("indexeddb_unavailable");
  }
  const code = OPERATION_ERROR_CODES[operation] ?? "storage_open_failed";
  return new WallpaperStorageError(code);
}

function recordDescriptors(value, expectedKeys, label) {
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
  const expected = new Set(expectedKeys);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== "string" || !expected.has(key))
  ) {
    throw new TypeError(`${label}包含未知或缺失字段`);
  }
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(descriptors, key)?.value;
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
      throw new TypeError(`${label}字段必须是数据值`);
    }
  }
  return descriptors;
}

function descriptorValue(descriptors, key) {
  return Object.getOwnPropertyDescriptor(descriptors, key).value.value;
}

function isPlainBlob(value, BlobConstructor) {
  if (typeof BlobConstructor !== "function") return false;
  try {
    return value instanceof BlobConstructor
      && Object.prototype.toString.call(value) === "[object Blob]";
  } catch {
    return false;
  }
}

function validateImageFields(fields, BlobConstructor, label) {
  const blob = fields.blob;
  const mediaType = fields.mediaType;
  if (
    !isPlainBlob(blob, BlobConstructor)
    || !Number.isSafeInteger(blob.size)
    || blob.size <= 0
  ) {
    throw new TypeError(`${label} blob 无效`);
  }
  if (!OUTPUT_MEDIA_TYPES.has(mediaType) || blob.type !== mediaType) {
    throw new TypeError(`${label}媒体类型无效`);
  }
  if (
    !Number.isSafeInteger(fields.width)
    || !Number.isSafeInteger(fields.height)
    || fields.width <= 0
    || fields.height <= 0
    || fields.width > WALLPAPER_IMAGE_LIMITS.maxEdge
    || fields.height > WALLPAPER_IMAGE_LIMITS.maxEdge
  ) {
    throw new TypeError(`${label}尺寸无效`);
  }
  if (fields.version !== WALLPAPER_IMAGE_LIMITS.version) {
    throw new TypeError(`${label}版本无效`);
  }
}

export function projectWallpaperImportResult(
  value,
  { BlobConstructor = browserValue("Blob") } = {},
) {
  const descriptors = recordDescriptors(value, IMPORT_RESULT_KEYS, "壁纸导入结果");
  const projected = {
    blob: descriptorValue(descriptors, "blob"),
    mediaType: descriptorValue(descriptors, "mediaType"),
    width: descriptorValue(descriptors, "width"),
    height: descriptorValue(descriptors, "height"),
    version: descriptorValue(descriptors, "version"),
  };
  validateImageFields(projected, BlobConstructor, "壁纸导入结果");
  return Object.freeze(projected);
}

export function projectWallpaperRecord(
  value,
  { BlobConstructor = browserValue("Blob") } = {},
) {
  const descriptors = recordDescriptors(value, STORED_RECORD_KEYS, "壁纸记录");
  const projected = {
    blob: descriptorValue(descriptors, "blob"),
    mediaType: descriptorValue(descriptors, "mediaType"),
    width: descriptorValue(descriptors, "width"),
    height: descriptorValue(descriptors, "height"),
    updatedAt: descriptorValue(descriptors, "updatedAt"),
    version: descriptorValue(descriptors, "version"),
  };
  validateImageFields(projected, BlobConstructor, "壁纸记录");
  if (
    !Number.isSafeInteger(projected.updatedAt)
    || projected.updatedAt <= 0
  ) {
    throw new TypeError("壁纸记录时间无效");
  }
  return Object.freeze(projected);
}

function requestFailure(transaction, request) {
  try {
    return request?.error ?? transaction?.error ?? null;
  } catch {
    return null;
  }
}

export function createWallpaperStorage({
  indexedDB: indexedDBFactory = browserValue("indexedDB"),
  BlobConstructor = browserValue("Blob"),
  now = Date.now,
} = {}) {
  if (typeof now !== "function") throw new TypeError("壁纸存储时钟无效");

  let connection = null;
  let opening = null;
  let closed = false;
  let operationTail = Promise.resolve();

  function requireActive() {
    if (closed) throw new WallpaperStorageError("storage_closed");
  }

  function attachConnection(database) {
    database.onversionchange = () => {
      try {
        database.close();
      } catch {
        // 连接已经关闭时无需再次处理。
      }
      if (connection === database) connection = null;
    };
    database.onclose = () => {
      if (connection === database) connection = null;
    };
    connection = database;
    return database;
  }

  async function ensureOpen() {
    requireActive();
    if (connection) return connection;
    if (opening) return opening;
    if (!indexedDBFactory || typeof indexedDBFactory.open !== "function") {
      throw new WallpaperStorageError("indexeddb_unavailable");
    }

    let request;
    try {
      request = indexedDBFactory.open(
        WALLPAPER_STORAGE_SCHEMA.databaseName,
        WALLPAPER_STORAGE_SCHEMA.databaseVersion,
      );
    } catch (error) {
      throw normalizeWallpaperStorageError(error, "open");
    }

    const pending = new Promise((resolve, reject) => {
      let settled = false;
      const rejectOpen = (error) => {
        if (settled) return;
        settled = true;
        reject(normalizeWallpaperStorageError(error, "open"));
      };

      request.onupgradeneeded = () => {
        try {
          const database = request.result;
          if (!database.objectStoreNames.contains(WALLPAPER_STORAGE_SCHEMA.storeName)) {
            database.createObjectStore(WALLPAPER_STORAGE_SCHEMA.storeName);
          }
        } catch (error) {
          try {
            request.transaction?.abort();
          } catch {
            // 打开请求会通过受控错误结束。
          }
          rejectOpen(error);
        }
      };
      request.onblocked = () => {
        rejectOpen(new WallpaperStorageError("storage_blocked"));
      };
      request.onerror = () => {
        rejectOpen(requestFailure(null, request));
      };
      request.onsuccess = () => {
        let database;
        try {
          database = request.result;
        } catch (error) {
          rejectOpen(error);
          return;
        }
        if (settled || closed) {
          try {
            database.close();
          } catch {
            // 被放弃的连接不向调用方暴露实现异常。
          }
          if (!settled) rejectOpen(new WallpaperStorageError("storage_closed"));
          return;
        }
        try {
          const attached = attachConnection(database);
          settled = true;
          resolve(attached);
        } catch (error) {
          try {
            database.close();
          } catch {
            // 未采用的连接必须尽快释放。
          }
          rejectOpen(error);
        }
      };
    });
    opening = pending;
    try {
      return await pending;
    } catch (error) {
      throw normalizeWallpaperStorageError(error, "open");
    } finally {
      if (opening === pending) opening = null;
    }
  }

  async function runTransaction(mode, operation, issueRequest) {
    requireActive();
    const database = await ensureOpen();
    requireActive();
    return new Promise((resolve, reject) => {
      let transaction;
      let request;
      let requestResult;
      let settled = false;
      const rejectTransaction = (error) => {
        if (settled) return;
        settled = true;
        reject(normalizeWallpaperStorageError(error, operation));
      };
      try {
        transaction = database.transaction(WALLPAPER_STORAGE_SCHEMA.storeName, mode);
        const store = transaction.objectStore(WALLPAPER_STORAGE_SCHEMA.storeName);
        request = issueRequest(store);
        request.onsuccess = () => {
          try {
            requestResult = request.result;
          } catch (error) {
            rejectTransaction(error);
          }
        };
        transaction.oncomplete = () => {
          if (settled) return;
          settled = true;
          resolve(requestResult);
        };
        transaction.onerror = () => {
          rejectTransaction(requestFailure(transaction, request));
        };
        transaction.onabort = () => {
          rejectTransaction(requestFailure(transaction, request));
        };
      } catch (error) {
        try {
          transaction?.abort();
        } catch {
          // 同一受控事务错误已经足够。
        }
        rejectTransaction(error);
      }
    });
  }

  const readRaw = () => runTransaction("readonly", "read", (store) => (
    store.get(WALLPAPER_STORAGE_SCHEMA.customKey)
  ));
  const putRaw = (record) => runTransaction("readwrite", "write", (store) => (
    store.put(record, WALLPAPER_STORAGE_SCHEMA.customKey)
  ));
  const deleteRaw = () => runTransaction("readwrite", "delete", (store) => (
    store.delete(WALLPAPER_STORAGE_SCHEMA.customKey)
  ));

  function enqueue(operation) {
    const pending = operationTail.then(operation, operation);
    operationTail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async function validStoredRecord(raw) {
    const record = projectWallpaperRecord(raw, { BlobConstructor });
    if (!await hasSafeWallpaperOutputSignature(
      record.blob,
      record.mediaType,
      { BlobConstructor },
    )) {
      throw new TypeError("壁纸记录内容无效");
    }
    return record;
  }

  async function readRecord() {
    const raw = await readRaw();
    if (raw === undefined) return null;
    try {
      return await validStoredRecord(raw);
    } catch {
      try {
        await deleteRaw();
      } catch {
        // 损坏记录始终按缺失处理，清理失败也不能阻断桌面启动。
      }
      return null;
    }
  }

  async function replaceRecord(value) {
    const image = projectWallpaperImportResult(value, { BlobConstructor });
    if (!await hasSafeWallpaperOutputSignature(
      image.blob,
      image.mediaType,
      { BlobConstructor },
    )) {
      throw new TypeError("壁纸导入结果内容无效");
    }
    let updatedAt;
    try {
      updatedAt = now();
    } catch {
      throw new TypeError("壁纸存储时钟无效");
    }
    if (!Number.isSafeInteger(updatedAt) || updatedAt <= 0) {
      throw new TypeError("壁纸存储时钟无效");
    }
    const record = Object.freeze({
      blob: image.blob,
      mediaType: image.mediaType,
      width: image.width,
      height: image.height,
      updatedAt,
      version: image.version,
    });
    await putRaw(record);
    return record;
  }

  async function restoreRecord(snapshot) {
    if (snapshot === null) {
      await deleteRaw();
      return null;
    }
    const record = await validStoredRecord(snapshot);
    await putRaw(record);
    return record;
  }

  const open = async () => {
    await ensureOpen();
    return true;
  };
  const read = () => enqueue(readRecord);
  const replace = (value) => enqueue(() => replaceRecord(value));
  const remove = () => enqueue(async () => {
    await deleteRaw();
    return true;
  });
  const snapshot = () => enqueue(readRecord);
  const restore = (value) => enqueue(() => restoreRecord(value));

  function close() {
    if (closed) return;
    closed = true;
    const database = connection;
    connection = null;
    if (!database) return;
    try {
      database.onversionchange = null;
      database.onclose = null;
      database.close();
    } catch {
      // close/destroy 幂等且不向调用方泄漏连接实现细节。
    }
  }

  return Object.freeze({
    open,
    read,
    write: replace,
    replace,
    delete: remove,
    remove,
    snapshot,
    restore,
    close,
    destroy: close,
  });
}
