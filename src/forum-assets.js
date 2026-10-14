const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");

const MIME_WEBP = "image/webp";
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP64_EXTRA_FIELD = 0x0001;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_ENCRYPTED_FLAG = 0x0001;
const ZIP_STRONG_ENCRYPTION_FLAG = 0x0040;
const ZIP_MAX_COMMENT_BYTES = 0xffff;
const ZIP_CENTRAL_RECORD_BYTES = 46;
const ZIP_LOCAL_RECORD_BYTES = 30;

// The generated archives are currently below Discord's conservative 10 MiB
// upload limit. These limits are for archive expansion safety and callers can
// lower them when their upload policy is stricter.
const DEFAULT_MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 1000;
const DEFAULT_MAX_IMAGES = 10;

class ForumAssetError extends Error {
  constructor(message, code = "FORUM_ASSET_ERROR", options = {}) {
    super(message, options);
    this.name = "ForumAssetError";
    this.code = code;
  }
}

/**
 * Read WebP image entries from a ZIP without extracting anything to disk.
 *
 * The reader intentionally supports the two compression methods produced by
 * yazl (stored and deflate), rejects ZIP64/encrypted archives, validates local
 * headers and CRC-32, and bounds both individual and aggregate expansion.
 * Returned buffers are safe to pass directly to a multipart upload.
 */
async function readZipImages(filePath, options = {}) {
  const archivePath = path.resolve(String(filePath));
  const limits = normalizeReadLimits(options);
  const stat = await fs.stat(archivePath).catch((error) => {
    throw new ForumAssetError(
      `Unable to read ZIP archive ${archivePath}: ${error.message}`,
      "ZIP_READ_FAILED",
      { cause: error }
    );
  });

  if (!stat.isFile()) {
    throw new ForumAssetError(`ZIP path is not a file: ${archivePath}`, "ZIP_NOT_FILE");
  }
  if (stat.size > limits.maxArchiveBytes) {
    throw new ForumAssetError(
      `ZIP archive exceeds the safety limit (${stat.size} > ${limits.maxArchiveBytes} bytes): ${archivePath}`,
      "ZIP_ARCHIVE_TOO_LARGE"
    );
  }

  const archive = await fs.readFile(archivePath);
  if (archive.length !== stat.size) {
    throw new ForumAssetError(
      `ZIP archive changed while it was read: ${archivePath}`,
      "ZIP_CHANGED_DURING_READ"
    );
  }

  const entries = parseCentralDirectory(archive, limits);
  const images = [];
  const seenNames = new Set();
  let totalBytes = 0;

  for (const entry of entries) {
    const entryName = decodeZipName(entry.nameBytes, entry.flags);
    const normalizedEntryName = validateEntryName(entryName);
    if (normalizedEntryName.endsWith("/")) {
      continue;
    }

    const basename = path.posix.basename(normalizedEntryName);
    if (path.extname(basename).toLowerCase() !== ".webp") {
      continue;
    }
    if (!basename || basename === "." || basename === "..") {
      throw new ForumAssetError(
        `ZIP image entry has an invalid filename: ${entryName}`,
        "ZIP_INVALID_ENTRY_NAME"
      );
    }

    const nameKey = basename.toLowerCase();
    if (seenNames.has(nameKey)) {
      throw new ForumAssetError(
        `ZIP contains duplicate WebP filenames: ${basename}`,
        "ZIP_DUPLICATE_IMAGE_NAME"
      );
    }
    seenNames.add(nameKey);

    if (entry.uncompressedSize > limits.maxFileBytes) {
      throw new ForumAssetError(
        `ZIP image exceeds the per-image safety limit (${entry.uncompressedSize} > ${limits.maxFileBytes} bytes): ${entryName}`,
        "ZIP_IMAGE_TOO_LARGE"
      );
    }
    if (totalBytes > limits.maxTotalBytes - entry.uncompressedSize) {
      throw new ForumAssetError(
        `ZIP images exceed the aggregate safety limit (${limits.maxTotalBytes} bytes): ${archivePath}`,
        "ZIP_IMAGES_TOO_LARGE"
      );
    }

    const buffer = inflateEntry(archive, entry, entryName, limits.maxFileBytes);
    if (buffer.length !== entry.uncompressedSize) {
      throw new ForumAssetError(
        `ZIP image size does not match its central directory entry: ${entryName}`,
        "ZIP_SIZE_MISMATCH"
      );
    }
    if (crc32(buffer) !== entry.crc32) {
      throw new ForumAssetError(
        `ZIP image CRC-32 validation failed: ${entryName}`,
        "ZIP_CRC_MISMATCH"
      );
    }
    if (!isWebp(buffer)) {
      throw new ForumAssetError(
        `ZIP entry is named .webp but does not contain a WebP image: ${entryName}`,
        "ZIP_INVALID_WEBP"
      );
    }

    totalBytes += buffer.length;
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    images.push({
      name: basename,
      entryName: normalizedEntryName,
      size: buffer.length,
      mime: MIME_WEBP,
      buffer,
      // `data` is an alias so callers that use either multipart naming style
      // do not accidentally copy the image bytes.
      data: buffer,
      hash,
      sha256: hash,
      stableKey: `${normalizedEntryName}\0${hash}`,
      key: `${normalizedEntryName}\0${hash}`,
      sourceArchive: archivePath,
    });
  }

  if (images.length === 0) {
    throw new ForumAssetError(
      `ZIP archive contains no supported WebP images: ${archivePath}`,
      "ZIP_NO_WEBP_IMAGES"
    );
  }
  return images;
}

/**
 * Read all ZIP parts belonging to one work and make attachment names unique.
 * `groupFiles` may be an array of paths, an object with a `files` array, or
 * an object with an `uploadFiles` array. Non-ZIP files are ignored here so a
 * caller can pass the complete paired ZIP/PDF group.
 */
async function readGroupImages(groupFiles, options = {}) {
  const zipPaths = extractZipPaths(groupFiles).sort(compareNatural);
  if (zipPaths.length === 0) {
    throw new ForumAssetError("No ZIP parts were found in the work group", "GROUP_NO_ZIP");
  }

  const images = [];
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  if (!Number.isSafeInteger(maxTotalBytes) || maxTotalBytes < 1) {
    throw new RangeError("maxTotalBytes must be a positive safe integer");
  }
  let totalBytes = 0;
  for (let archiveIndex = 0; archiveIndex < zipPaths.length; archiveIndex += 1) {
    const archivePath = path.resolve(zipPaths[archiveIndex]);
    const archiveImages = await readZipImages(archivePath, options);
    for (const image of archiveImages) {
      if (totalBytes > maxTotalBytes - image.size) {
        throw new ForumAssetError(
          `ZIP parts exceed the aggregate image safety limit (${maxTotalBytes} bytes)`,
          "ZIP_IMAGES_TOO_LARGE"
        );
      }
      totalBytes += image.size;
      // Keep the archive basename intact. The uploader adds a deterministic
      // hash prefix when it needs globally unique Discord attachment names;
      // doing that here would make source names harder to inspect and would
      // couple this reader to a particular upload policy.
      const stableKey = `${path.basename(archivePath)}\0${image.entryName}\0${image.sha256}`;
      images.push({
        ...image,
        sourceArchive: archivePath,
        sourceArchiveName: path.basename(archivePath),
        stableKey,
        key: stableKey,
      });
    }
  }
  return images;
}

/**
 * Split image attachments while respecting both Discord's ten-file practical
 * limit and an optional byte budget. `maxBytes` is the sum of raw attachment
 * bytes; multipart overhead is intentionally left to the API caller.
 */
function batchImages(images, options = {}) {
  if (!Array.isArray(images)) {
    throw new TypeError("images must be an array");
  }
  const maxImages = options.maxImages === undefined ? DEFAULT_MAX_IMAGES : options.maxImages;
  const maxBytes = options.maxBytes === undefined ? Infinity : options.maxBytes;
  if (!Number.isSafeInteger(maxImages) || maxImages < 1) {
    throw new RangeError("maxImages must be a positive safe integer");
  }
  if (maxBytes !== Infinity && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) {
    throw new RangeError("maxBytes must be a positive safe integer or Infinity");
  }

  const batches = [];
  let batch = [];
  let batchBytes = 0;
  for (const image of images) {
    const size = getImageSize(image);
    if (size > maxBytes) {
      throw new ForumAssetError(
        `Image exceeds the batch byte limit (${size} > ${maxBytes} bytes): ${image?.name || "(unnamed)"}`,
        "BATCH_IMAGE_TOO_LARGE"
      );
    }
    if (batch.length > 0 && (batch.length >= maxImages || batchBytes > maxBytes - size)) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
    }
    batch.push(image);
    batchBytes += size;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}

// Descriptive alias for callers that prefer the operation name.
const splitImageBatches = batchImages;

function normalizeReadLimits(options) {
  const limits = {
    maxArchiveBytes: options.maxArchiveBytes ?? options.maxCompressedBytes ?? DEFAULT_MAX_ARCHIVE_BYTES,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError(`${name} must be a positive safe integer`);
    }
  }
  return limits;
}

function parseCentralDirectory(archive, limits) {
  const eocdOffset = findEndOfCentralDirectory(archive);
  const diskNumber = archive.readUInt16LE(eocdOffset + 4);
  const centralDisk = archive.readUInt16LE(eocdOffset + 6);
  const entriesOnDisk = archive.readUInt16LE(eocdOffset + 8);
  const totalEntries = archive.readUInt16LE(eocdOffset + 10);
  const centralSize = archive.readUInt32LE(eocdOffset + 12);
  const centralOffset = archive.readUInt32LE(eocdOffset + 16);

  if (diskNumber !== 0 || centralDisk !== 0 || entriesOnDisk !== totalEntries) {
    throw new ForumAssetError("Multi-disk ZIP archives are not supported", "ZIP_MULTIDISK");
  }
  if (
    totalEntries === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    throw new ForumAssetError("ZIP64 archives are not supported", "ZIP64_UNSUPPORTED");
  }
  if (totalEntries > limits.maxEntries) {
    throw new ForumAssetError(
      `ZIP contains too many entries (${totalEntries} > ${limits.maxEntries})`,
      "ZIP_TOO_MANY_ENTRIES"
    );
  }

  const centralEnd = centralOffset + centralSize;
  if (
    centralOffset > archive.length ||
    centralEnd < centralOffset ||
    centralEnd > eocdOffset ||
    centralEnd > archive.length
  ) {
    throw new ForumAssetError("ZIP central directory is outside the archive", "ZIP_CENTRAL_OUT_OF_RANGE");
  }

  const entries = [];
  let offset = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (offset + ZIP_CENTRAL_RECORD_BYTES > centralEnd) {
      throw new ForumAssetError("ZIP central directory is truncated", "ZIP_CENTRAL_TRUNCATED");
    }
    if (archive.readUInt32LE(offset) !== ZIP_CENTRAL_SIGNATURE) {
      throw new ForumAssetError("ZIP central directory record is invalid", "ZIP_CENTRAL_INVALID");
    }

    const flags = archive.readUInt16LE(offset + 8);
    const compressionMethod = archive.readUInt16LE(offset + 10);
    const crc32Value = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const uncompressedSize = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const diskStart = archive.readUInt16LE(offset + 34);
    const localHeaderOffset = archive.readUInt32LE(offset + 42);
    const recordEnd = offset + ZIP_CENTRAL_RECORD_BYTES + nameLength + extraLength + commentLength;

    if (recordEnd > centralEnd || recordEnd < offset) {
      throw new ForumAssetError("ZIP central directory record is truncated", "ZIP_CENTRAL_TRUNCATED");
    }
    if (
      diskStart !== 0 ||
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new ForumAssetError("ZIP64 or multi-disk ZIP entries are not supported", "ZIP64_UNSUPPORTED");
    }
    if (flags & (ZIP_ENCRYPTED_FLAG | ZIP_STRONG_ENCRYPTION_FLAG)) {
      throw new ForumAssetError("Encrypted ZIP entries are not supported", "ZIP_ENCRYPTED");
    }

    const nameStart = offset + ZIP_CENTRAL_RECORD_BYTES;
    const extraStart = nameStart + nameLength;
    const extra = archive.subarray(extraStart, extraStart + extraLength);
    if (containsZip64Extra(extra)) {
      throw new ForumAssetError("ZIP64 archives are not supported", "ZIP64_UNSUPPORTED");
    }
    entries.push({
      flags,
      compressionMethod,
      crc32: crc32Value,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
      nameBytes: archive.subarray(nameStart, extraStart),
    });
    offset = recordEnd;
  }
  if (offset !== centralEnd) {
    throw new ForumAssetError("ZIP central directory has trailing records", "ZIP_CENTRAL_INVALID");
  }
  return entries;
}

function findEndOfCentralDirectory(archive) {
  const minimum = Math.max(0, archive.length - 22 - ZIP_MAX_COMMENT_BYTES);
  for (let offset = archive.length - 22; offset >= minimum; offset -= 1) {
    if (offset < 0 || archive.readUInt32LE(offset) !== ZIP_EOCD_SIGNATURE) {
      continue;
    }
    const commentLength = archive.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === archive.length) {
      return offset;
    }
  }
  throw new ForumAssetError("ZIP end-of-central-directory record was not found", "ZIP_EOCD_MISSING");
}

function decodeZipName(nameBytes, flags) {
  if (flags & ZIP_UTF8_FLAG) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    } catch (error) {
      throw new ForumAssetError("ZIP entry filename is not valid UTF-8", "ZIP_INVALID_FILENAME", { cause: error });
    }
  }
  // yazl emits UTF-8 names with the UTF-8 flag. For legacy archives, byte
  // preserving latin1 is safer than silently introducing replacement chars.
  return nameBytes.toString("latin1");
}

function validateEntryName(name) {
  if (!name || name.includes("\0")) {
    throw new ForumAssetError("ZIP entry filename is empty or contains NUL", "ZIP_INVALID_ENTRY_NAME");
  }
  const normalized = name.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.split("/").some((part) => part === "..")
  ) {
    throw new ForumAssetError(`ZIP entry path is unsafe: ${name}`, "ZIP_PATH_TRAVERSAL");
  }
  return normalized;
}

function inflateEntry(archive, entry, entryName, maxFileBytes) {
  const localOffset = entry.localHeaderOffset;
  if (localOffset + ZIP_LOCAL_RECORD_BYTES > archive.length) {
    throw new ForumAssetError(`ZIP local header is outside the archive: ${entryName}`, "ZIP_LOCAL_OUT_OF_RANGE");
  }
  if (archive.readUInt32LE(localOffset) !== ZIP_LOCAL_SIGNATURE) {
    throw new ForumAssetError(`ZIP local header is invalid: ${entryName}`, "ZIP_LOCAL_INVALID");
  }

  const localFlags = archive.readUInt16LE(localOffset + 6);
  const localMethod = archive.readUInt16LE(localOffset + 8);
  const localNameLength = archive.readUInt16LE(localOffset + 26);
  const localExtraLength = archive.readUInt16LE(localOffset + 28);
  if (localFlags & (ZIP_ENCRYPTED_FLAG | ZIP_STRONG_ENCRYPTION_FLAG)) {
    throw new ForumAssetError(`Encrypted ZIP entry is not supported: ${entryName}`, "ZIP_ENCRYPTED");
  }
  if (localMethod !== entry.compressionMethod) {
    throw new ForumAssetError(`ZIP compression method differs between headers: ${entryName}`, "ZIP_HEADER_MISMATCH");
  }
  const localNameStart = localOffset + ZIP_LOCAL_RECORD_BYTES;
  const dataStart = localNameStart + localNameLength + localExtraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataStart < localNameStart || dataEnd < dataStart || dataEnd > archive.length) {
    throw new ForumAssetError(`ZIP compressed data is outside the archive: ${entryName}`, "ZIP_DATA_OUT_OF_RANGE");
  }

  const compressed = archive.subarray(dataStart, dataEnd);
  if (entry.compressionMethod === 0) {
    return Buffer.from(compressed);
  }
  if (entry.compressionMethod !== 8) {
    throw new ForumAssetError(
      `ZIP compression method ${entry.compressionMethod} is not supported for ${entryName}`,
      "ZIP_COMPRESSION_UNSUPPORTED"
    );
  }
  try {
    return zlib.inflateRawSync(compressed, { maxOutputLength: maxFileBytes });
  } catch (error) {
    throw new ForumAssetError(
      `Unable to inflate ZIP image ${entryName}: ${error.message}`,
      "ZIP_INFLATE_FAILED",
      { cause: error }
    );
  }
}

function containsZip64Extra(extra) {
  let offset = 0;
  while (offset + 4 <= extra.length) {
    const id = extra.readUInt16LE(offset);
    const length = extra.readUInt16LE(offset + 2);
    offset += 4;
    if (offset + length > extra.length) {
      throw new ForumAssetError("ZIP extra field is truncated", "ZIP_EXTRA_TRUNCATED");
    }
    if (id === ZIP64_EXTRA_FIELD) {
      return true;
    }
    offset += length;
  }
  if (offset !== extra.length) {
    throw new ForumAssetError("ZIP extra field is malformed", "ZIP_EXTRA_INVALID");
  }
  return false;
}

function isWebp(buffer) {
  return (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  );
}

function getImageSize(image) {
  const size = image?.size ?? image?.buffer?.length ?? image?.data?.length;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new TypeError(`Image ${image?.name || "(unnamed)"} has no valid byte size`);
  }
  return size;
}

function extractZipPaths(groupFiles) {
  let values = groupFiles;
  if (!Array.isArray(values) && values && Array.isArray(values.files)) {
    values = values.files;
  }
  if (!Array.isArray(values) && values && Array.isArray(values.uploadFiles)) {
    values = values.uploadFiles;
  }
  if (!Array.isArray(values)) {
    throw new TypeError("groupFiles must be an array or an object containing files");
  }
  return values
    .map((value) => (typeof value === "string" ? value : value?.path || value?.file))
    .filter((value) => typeof value === "string")
    .filter((value) => path.extname(value).toLowerCase() === ".zip");
}

function compareNatural(left, right) {
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

// Standard CRC-32 (polynomial 0xEDB88320), kept local to avoid another
// dependency for an operation needed only while validating ZIP entries.
const CRC_TABLE = createCrcTable();
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function createCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

module.exports = {
  DEFAULT_MAX_ARCHIVE_BYTES,
  DEFAULT_MAX_ENTRIES,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_IMAGES,
  DEFAULT_MAX_TOTAL_BYTES,
  ForumAssetError,
  MIME_WEBP,
  batchImages,
  crc32,
  isWebp,
  readGroupImages,
  readZipImages,
  splitImageBatches,
};
