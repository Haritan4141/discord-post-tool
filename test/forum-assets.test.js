const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const yazl = require("yazl");
const sharp = require("sharp");

const {
  ForumAssetError,
  batchImages,
  readGroupImages,
  readZipImages,
  splitImageBatches,
} = require("../src/forum-assets");

async function createWebp(color, width = 8, height = 8) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: color,
    },
  }).webp({ quality: 80 }).toBuffer();
}

function createZipBuffer(entries) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks = [];
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    for (const entry of entries) {
      zip.addBuffer(entry.buffer, entry.name, {
        compress: entry.compress !== false,
        mtime: new Date(0),
        mode: 0o100644,
      });
    }
    zip.end();
  });
}

async function writeArchive(directory, name, entries) {
  const filePath = path.join(directory, name);
  await fs.writeFile(filePath, await createZipBuffer(entries));
  return filePath;
}

function replaceAllBytes(buffer, oldValue, newValue) {
  assert.equal(oldValue.length, newValue.length);
  let offset = 0;
  while ((offset = buffer.indexOf(oldValue, offset)) !== -1) {
    newValue.copy(buffer, offset);
    offset += newValue.length;
  }
  return buffer;
}

function expectForumAssetError(error, code) {
  assert.ok(error instanceof ForumAssetError, error);
  assert.equal(error.code, code);
}

test("reads valid WebP entries, verifies CRC, and exposes stable upload metadata", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "discord-forum-assets-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = await createWebp({ r: 220, g: 80, b: 90 });
  const second = await createWebp({ r: 40, g: 120, b: 220 });
  const archivePath = await writeArchive(directory, "sample.zip", [
    { name: "001.webp", buffer: first },
    { name: "002.webp", buffer: second },
    { name: "README.txt", buffer: Buffer.from("ignored") },
  ]);

  const images = await readZipImages(archivePath);
  assert.deepEqual(images.map((image) => image.name), ["001.webp", "002.webp"]);
  assert.deepEqual(images.map((image) => image.mime), ["image/webp", "image/webp"]);
  assert.equal(images[0].size, first.length);
  assert.strictEqual(images[0].buffer, images[0].data);
  assert.equal(
    images[0].hash,
    crypto.createHash("sha256").update(first).digest("hex")
  );
  assert.match(images[0].stableKey, /^001\.webp\0[a-f0-9]{64}$/);
});

test("reads sorted ZIP parts and preserves source basenames with distinct keys", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "discord-forum-group-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const first = await createWebp({ r: 220, g: 60, b: 80 });
  const second = await createWebp({ r: 60, g: 220, b: 100 });
  const third = await createWebp({ r: 60, g: 100, b: 220 });
  const part10 = await writeArchive(directory, "作品_10-12.zip", [
    { name: "001.webp", buffer: third },
  ]);
  const part2 = await writeArchive(directory, "作品_2-9.zip", [
    { name: "001.webp", buffer: first },
    { name: "002.webp", buffer: second },
  ]);

  const images = await readGroupImages({
    files: [part10, path.join(directory, "作品.pdf"), part2],
  });
  assert.deepEqual(images.map((image) => image.sourceArchiveName), [
    "作品_2-9.zip",
    "作品_2-9.zip",
    "作品_10-12.zip",
  ]);
  assert.deepEqual(images.map((image) => image.name), ["001.webp", "002.webp", "001.webp"]);
  assert.equal(images[0].sha256, images[0].hash);
  assert.equal(new Set(images.map((image) => image.key)).size, 3);
  assert.notEqual(images[0].key, images[2].key);
});

test("batches at most ten images and respects optional raw-byte budget", () => {
  const images = Array.from({ length: 21 }, (_, index) => ({
    name: `${String(index + 1).padStart(3, "0")}.webp`,
    size: 10,
  }));
  const batches = batchImages(images, { maxImages: 10, maxBytes: 95 });
  assert.deepEqual(batches.map((batch) => batch.length), [9, 9, 3]);
  assert.deepEqual(batches.flat(), images);
  assert.deepEqual(splitImageBatches(images, { maxImages: 10 }).map((batch) => batch.length), [10, 10, 1]);
  assert.throws(
    () => batchImages([{ name: "too-large.webp", size: 101 }], { maxBytes: 100 }),
    (error) => error.code === "BATCH_IMAGE_TOO_LARGE"
  );
});

test("rejects traversal, duplicate names, unsupported archives, and malformed data", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "discord-forum-invalid-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const image = await createWebp({ r: 150, g: 90, b: 30 });

  const traversal = await writeArchive(directory, "traversal.zip", [
    { name: "safe.webp", buffer: image },
  ]);
  const traversalBuffer = await fs.readFile(traversal);
  replaceAllBytes(traversalBuffer, Buffer.from("safe.webp"), Buffer.from("../a.webp"));
  await fs.writeFile(traversal, traversalBuffer);
  await assert.rejects(readZipImages(traversal), (error) => {
    expectForumAssetError(error, "ZIP_PATH_TRAVERSAL");
    return true;
  });

  const duplicate = await writeArchive(directory, "duplicate.zip", [
    { name: "same.webp", buffer: image },
    { name: "same.webp", buffer: image },
  ]);
  await assert.rejects(readZipImages(duplicate), (error) => {
    expectForumAssetError(error, "ZIP_DUPLICATE_IMAGE_NAME");
    return true;
  });

  const noImages = await writeArchive(directory, "none.zip", [
    { name: "notes.txt", buffer: Buffer.from("not an image") },
  ]);
  await assert.rejects(readZipImages(noImages), (error) => {
    expectForumAssetError(error, "ZIP_NO_WEBP_IMAGES");
    return true;
  });

  const malformed = await fs.readFile(noImages);
  await fs.writeFile(path.join(directory, "malformed.zip"), malformed.subarray(0, malformed.length - 3));
  await assert.rejects(readZipImages(path.join(directory, "malformed.zip")), (error) => {
    expectForumAssetError(error, "ZIP_EOCD_MISSING");
    return true;
  });
});

test("rejects invalid WebP, CRC corruption, ZIP64 metadata, and expansion limits", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "discord-forum-limits-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const image = await createWebp({ r: 90, g: 140, b: 220 });

  const invalidWebp = await writeArchive(directory, "invalid-webp.zip", [
    { name: "001.webp", buffer: Buffer.from("not a webp") },
  ]);
  await assert.rejects(readZipImages(invalidWebp), (error) => {
    expectForumAssetError(error, "ZIP_INVALID_WEBP");
    return true;
  });

  const corrupted = await fs.readFile(
    await writeArchive(directory, "corrupted.zip", [{ name: "001.webp", buffer: image }])
  );
  const localNameLength = corrupted.readUInt16LE(26);
  const localExtraLength = corrupted.readUInt16LE(28);
  corrupted[30 + localNameLength + localExtraLength] ^= 0xff;
  const corruptedPath = path.join(directory, "corrupted-mutated.zip");
  await fs.writeFile(corruptedPath, corrupted);
  await assert.rejects(readZipImages(corruptedPath), (error) => {
    assert.ok(["ZIP_INFLATE_FAILED", "ZIP_CRC_MISMATCH"].includes(error.code), error.code);
    return true;
  });

  const expansionBuffer = Buffer.alloc(3000);
  expansionBuffer.write("RIFF", 0, "ascii");
  expansionBuffer.writeUInt32LE(expansionBuffer.length - 8, 4);
  expansionBuffer.write("WEBP", 8, "ascii");
  const expansionPath = await writeArchive(directory, "expansion.zip", [
    { name: "001.webp", buffer: expansionBuffer },
  ]);
  await assert.rejects(
    readZipImages(expansionPath, { maxFileBytes: 1000 }),
    (error) => {
      expectForumAssetError(error, "ZIP_IMAGE_TOO_LARGE");
      return true;
    }
  );

  const totalPath = await writeArchive(directory, "total.zip", [
    { name: "001.webp", buffer: image },
    { name: "002.webp", buffer: image },
  ]);
  await assert.rejects(
    readZipImages(totalPath, { maxTotalBytes: image.length * 2 - 1 }),
    (error) => {
      expectForumAssetError(error, "ZIP_IMAGES_TOO_LARGE");
      return true;
    }
  );

  const zip64Path = await writeArchive(directory, "zip64.zip", [
    { name: "001.webp", buffer: image },
  ]);
  const zip64 = await fs.readFile(zip64Path);
  const eocd = zip64.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const centralOffset = zip64.readUInt32LE(eocd + 16);
  zip64.writeUInt32LE(0xffffffff, centralOffset + 24);
  await fs.writeFile(zip64Path, zip64);
  await assert.rejects(readZipImages(zip64Path), (error) => {
    expectForumAssetError(error, "ZIP64_UNSUPPORTED");
    return true;
  });
});
