const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PDFDocument } = require("pdf-lib");
const sharp = require("sharp");

const ROOT_DIR = path.resolve(__dirname, "..");
const BUILD_SCRIPT = path.join(ROOT_DIR, "src", "build-assets.js");

test("raises quality when size allows and builds one WebP ZIP plus one JPEG PDF", async (t) => {
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "discord-post-tool-test-"));
  t.after(() => fs.rm(testDir, { recursive: true, force: true }));

  const inputDir = path.join(testDir, "input");
  const imageDir = path.join(inputDir, "sample_png");
  const outputDir = path.join(testDir, "output");
  await fs.mkdir(imageDir, { recursive: true });

  await Promise.all([
    createFixtureImage(path.join(imageDir, "001.png"), "#e36a76"),
    createFixtureImage(path.join(imageDir, "002.png"), "#6c8de3"),
  ]);

  const defaultPlan = runBuild([BUILD_SCRIPT, "plan", "--input", inputDir, "--limit", "1"]);
  assert.equal(defaultPlan.status, 0, defaultPlan.stderr || defaultPlan.stdout);
  assert.match(defaultPlan.stdout, /optimized_webp_pdf/);

  const buildArgs = [
    BUILD_SCRIPT,
    "run",
    "--input",
    inputDir,
    "--output",
    outputDir,
    "--chunk-size",
    "100",
  ];
  const result = runBuild([...buildArgs, "--force"]);

  assert.equal(result.status, 0, result.stderr || result.stdout);

  const categoryDir = path.join(outputDir, "カテゴリ1");
  const zipPath = path.join(categoryDir, "sample.zip");
  const pdfPath = path.join(categoryDir, "sample.pdf");
  const profilePath = path.join(categoryDir, "sample.assets.json");
  const [zipBuffer, pdfBuffer, profileText] = await Promise.all([
    fs.readFile(zipPath),
    fs.readFile(pdfPath),
    fs.readFile(profilePath, "utf8"),
  ]);

  assert.deepEqual(readZipEntryNames(zipBuffer), ["001.webp", "002.webp"]);
  assert.ok(zipBuffer.length < 9.8 * 1024 * 1024);
  assert.ok(pdfBuffer.length < 9.8 * 1024 * 1024);

  const pdf = await PDFDocument.load(pdfBuffer);
  assert.equal(pdf.getPageCount(), 2);
  assert.deepEqual(pdf.getPage(0).getSize(), { width: 1244, height: 1600 });

  const profile = JSON.parse(profileText);
  assert.equal(profile.profileVersion, 3);
  assert.equal(profile.imageCount, 2);
  assert.match(profile.sourceSignature, /^[a-f0-9]{64}$/);
  assert.equal(profile.zip.format, "webp");
  assert.equal(profile.zip.requestedQuality, 75);
  assert.equal(profile.zip.maximumQuality, 85);
  assert.equal(profile.zip.selectedQuality, 85);
  assert.match(profile.zip.sha256, /^[a-f0-9]{64}$/);
  assert.equal(profile.pdf.imageFormat, "jpeg");
  assert.equal(profile.pdf.quality, 70);
  assert.equal(profile.pdf.maximumQuality, 75);
  assert.equal(profile.pdf.selectedQuality, 75);
  assert.equal(profile.pdf.maximumLongEdge, 1600);
  assert.equal(profile.pdf.selectedLongEdge, 1600);
  assert.match(profile.pdf.sha256, /^[a-f0-9]{64}$/);

  const reused = runBuild(buildArgs);
  assert.equal(reused.status, 0, reused.stderr || reused.stdout);
  assert.match(reused.stdout, /already built with the current profile under target; skipping/);

  const rebuilt = runBuild([...buildArgs, "--force"]);
  assert.equal(rebuilt.status, 0, rebuilt.stderr || rebuilt.stdout);

  await Promise.all([
    fs.writeFile(path.join(categoryDir, "sample_1-1.zip"), "old split zip"),
    fs.writeFile(path.join(categoryDir, "sample_1-1.pdf"), "old split pdf"),
  ]);
  const mixedOutputs = runBuild([...buildArgs, "--force"]);
  assert.equal(mixedOutputs.status, 1);
  assert.match(mixedOutputs.stderr, /旧分割出力が残っています/);
});

test("falls below the WebP baseline when a heavy set needs it", async (t) => {
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), "discord-post-tool-heavy-test-"));
  t.after(() => fs.rm(testDir, { recursive: true, force: true }));

  const inputDir = path.join(testDir, "input");
  const imageDir = path.join(inputDir, "heavy_png");
  const outputDir = path.join(testDir, "output");
  await fs.mkdir(imageDir, { recursive: true });

  for (let index = 0; index < 4; index += 1) {
    await createNoiseFixture(path.join(imageDir, `${index + 1}.png`), index);
  }

  const targetMiB = 1.86;
  const result = runBuild([
    BUILD_SCRIPT,
    "run",
    "--input",
    inputDir,
    "--output",
    outputDir,
    "--target-mib",
    String(targetMiB),
    "--zip-webp-quality",
    "75",
    "--zip-webp-max-quality",
    "85",
    "--zip-webp-min-quality",
    "70",
    "--pdf-jpeg-quality",
    "50",
    "--pdf-jpeg-max-quality",
    "50",
    "--pdf-long-edge",
    "200",
    "--pdf-max-long-edge",
    "200",
    "--pdf-min-long-edge",
    "200",
    "--force",
  ]);
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const profile = JSON.parse(
    await fs.readFile(path.join(outputDir, "カテゴリ1", "heavy.assets.json"), "utf8")
  );
  assert.ok(profile.zip.selectedQuality >= 70);
  assert.ok(profile.zip.selectedQuality < 75);
  assert.ok(profile.zip.bytes <= targetMiB * 1024 * 1024);
  assert.ok(profile.pdf.bytes <= targetMiB * 1024 * 1024);
});

async function createFixtureImage(file, color) {
  const svg = Buffer.from(
    `<svg width="1400" height="1800" xmlns="http://www.w3.org/2000/svg">` +
      `<rect width="1400" height="1800" fill="${color}"/>` +
      `<circle cx="700" cy="700" r="420" fill="#f8d8b0"/>` +
      `<path d="M100 1650 L700 300 L1300 1650" fill="none" stroke="#222" stroke-width="24"/>` +
      `</svg>`
  );
  await sharp(svg).png().toFile(file);
}

async function createNoiseFixture(file, seedOffset) {
  const width = 800;
  const height = 1000;
  const data = Buffer.alloc(width * height * 3);
  let value = (0x12345678 + seedOffset) >>> 0;
  for (let index = 0; index < data.length; index += 1) {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    data[index] = value & 0xff;
  }
  await sharp(data, { raw: { width, height, channels: 3 } }).png().toFile(file);
}

function readZipEntryNames(buffer) {
  const eocdOffset = findSignatureFromEnd(buffer, 0x06054b50);
  assert.notEqual(eocdOffset, -1, "ZIP end-of-central-directory record was not found");

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  const names = [];

  for (let index = 0; index < entryCount; index += 1) {
    assert.equal(buffer.readUInt32LE(offset), 0x02014b50, "Invalid ZIP central directory entry");
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    names.push(buffer.toString("utf8", offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return names;
}

function findSignatureFromEnd(buffer, signature) {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) {
      return offset;
    }
  }
  return -1;
}

function runBuild(args) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT_DIR,
    encoding: "utf8",
  });
}
