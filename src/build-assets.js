#!/usr/bin/env node

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const sharp = require("sharp");
const yazl = require("yazl");
const { PDFDocument } = require("pdf-lib");

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const SOURCE_RANK = {
  png: 3,
  jpg: 2,
  jpeg: 2,
  webp: 1,
};
const ASSET_PROFILE_VERSION = 3;
const DEFAULT_CHUNK_SIZE = 100;
const DEFAULT_ZIP_WEBP_QUALITY = 75;
const DEFAULT_ZIP_WEBP_MAX_QUALITY = 85;
const DEFAULT_ZIP_WEBP_MIN_QUALITY = 65;
const DEFAULT_PDF_JPEG_QUALITY = 70;
const DEFAULT_PDF_JPEG_MAX_QUALITY = 75;
const DEFAULT_PDF_LONG_EDGE = 1350;
const DEFAULT_PDF_MAX_LONG_EDGE = 1600;
const DEFAULT_PDF_MIN_LONG_EDGE = 900;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "plan";

  if (command === "help" || args.help || args.h) {
    printHelp();
    return;
  }

  if (!["plan", "run"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  const inputDir = path.resolve(process.cwd(), String(args.input || "./raw_images"));
  const outputDir = path.resolve(
    process.cwd(),
    String(args.output || "./optimized_webp_pdf")
  );
  const categoryName = String(args.category || "カテゴリ1");
  const targetMiB = readNumberArg(args, "target-mib", 9.8);
  const zipWebpQuality = readIntegerArg(
    args,
    "zip-webp-quality",
    DEFAULT_ZIP_WEBP_QUALITY
  );
  const zipWebpMinQuality = readIntegerArg(
    args,
    "zip-webp-min-quality",
    DEFAULT_ZIP_WEBP_MIN_QUALITY
  );
  const zipWebpMaxQuality = readIntegerArg(
    args,
    "zip-webp-max-quality",
    DEFAULT_ZIP_WEBP_MAX_QUALITY
  );
  const pdfJpegQuality = readIntegerArg(
    args,
    "pdf-jpeg-quality",
    DEFAULT_PDF_JPEG_QUALITY
  );
  const pdfJpegMaxQuality = readIntegerArg(
    args,
    "pdf-jpeg-max-quality",
    DEFAULT_PDF_JPEG_MAX_QUALITY
  );
  const pdfLongEdge = readIntegerArg(args, "pdf-long-edge", DEFAULT_PDF_LONG_EDGE);
  const pdfMaxLongEdge = readIntegerArg(
    args,
    "pdf-max-long-edge",
    DEFAULT_PDF_MAX_LONG_EDGE
  );
  const pdfMinLongEdge = readIntegerArg(
    args,
    "pdf-min-long-edge",
    DEFAULT_PDF_MIN_LONG_EDGE
  );
  const concurrency = readIntegerArg(args, "concurrency", 4);
  const chunkSize = readIntegerArg(args, "chunk-size", DEFAULT_CHUNK_SIZE);
  const minTailSize =
    args["min-tail-size"] === undefined ? null : readIntegerArg(args, "min-tail-size", 1);
  const limit = args.limit === undefined ? null : readIntegerArg(args, "limit", 1);
  const setFilter = args.set ? String(args.set) : null;
  const keepJpgs = Boolean(args["keep-jpgs"]);
  const force = Boolean(args.force);

  if (zipWebpMinQuality > zipWebpQuality || zipWebpQuality > zipWebpMaxQuality) {
    throw new Error(
      "WebP quality must satisfy --zip-webp-min-quality <= " +
        "--zip-webp-quality <= --zip-webp-max-quality"
    );
  }
  if (
    zipWebpMinQuality < 1 ||
    zipWebpMaxQuality > 100 ||
    pdfJpegQuality < 1 ||
    pdfJpegMaxQuality > 100
  ) {
    throw new Error("WebP and JPEG quality values must be between 1 and 100");
  }
  if (pdfJpegQuality > pdfJpegMaxQuality) {
    throw new Error("--pdf-jpeg-quality must be <= --pdf-jpeg-max-quality");
  }
  if (pdfMinLongEdge > pdfLongEdge || pdfLongEdge > pdfMaxLongEdge) {
    throw new Error(
      "PDF long edge must satisfy --pdf-min-long-edge <= " +
        "--pdf-long-edge <= --pdf-max-long-edge"
    );
  }

  const sets = await discoverImageSets(inputDir, {
    fallbackCategory: categoryName,
    setFilter,
  });
  const selectedSets = limit === null ? sets : sets.slice(0, limit);

  printBuildPlan(selectedSets, {
    inputDir,
    outputDir,
    targetMiB,
    zipWebpQuality,
    zipWebpMinQuality,
    zipWebpMaxQuality,
    pdfJpegQuality,
    pdfJpegMaxQuality,
    pdfLongEdge,
    pdfMaxLongEdge,
    pdfMinLongEdge,
    concurrency,
    chunkSize,
    minTailSize,
    limit,
    setFilter,
  });

  if (command === "plan") {
    return;
  }

  if (selectedSets.length === 0) {
    throw new Error("No image sets found.");
  }

  await validateInputImages(selectedSets, concurrency);

  for (const set of selectedSets) {
    await buildSet(set, {
      outputDir,
      targetBytes: mibToBytes(targetMiB),
      targetMiB,
      zipWebpQuality,
      zipWebpMinQuality,
      zipWebpMaxQuality,
      pdfJpegQuality,
      pdfJpegMaxQuality,
      pdfLongEdge,
      pdfMaxLongEdge,
      pdfMinLongEdge,
      concurrency,
      chunkSize,
      minTailSize,
      keepJpgs,
      force,
    });
  }
}

async function discoverImageSets(inputDir, options) {
  const stat = await fs.stat(inputDir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Input directory does not exist: ${inputDir}`);
  }

  const imageDirs = [];
  await walkImageDirs(inputDir, imageDirs);

  const grouped = new Map();
  for (const dir of imageDirs) {
    const files = await getImageFiles(dir);
    if (files.length === 0) {
      continue;
    }

    const parsed = parseImageSetDir(inputDir, dir, options.fallbackCategory);
    const key = `${parsed.category}\0${parsed.name}`;
    const sourceType = parsed.sourceType || detectDominantSourceType(files);
    const candidate = {
      ...parsed,
      dir,
      sourceType,
      files,
      sourceBytes: await sumFileSizes(files),
    };

    const existing = grouped.get(key);
    if (!existing || sourceScore(candidate.sourceType) > sourceScore(existing.sourceType)) {
      grouped.set(key, candidate);
    }
  }

  return Array.from(grouped.values())
    .filter((set) => !options.setFilter || set.name === options.setFilter)
    .sort((a, b) => {
      const category = compareNames(a.category, b.category);
      return category === 0 ? compareNames(a.name, b.name) : category;
    });
}

async function walkImageDirs(dir, results) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const hasImage = entries.some(
    (entry) => entry.isFile() && IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
  );

  if (hasImage) {
    results.push(dir);
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    await walkImageDirs(path.join(dir, entry.name), results);
  }
}

async function getImageFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .filter((entry) => IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => path.join(dir, entry.name))
    .sort(compareNames);
}

function parseImageSetDir(inputDir, dir, fallbackCategory) {
  const parent = path.dirname(dir);
  const dirName = path.basename(dir);
  const match = dirName.match(/^(.*)_(png|jpg|jpeg|webp)$/i);
  const name = match ? match[1] : dirName;
  const sourceType = match ? match[2].toLowerCase() : null;
  const category = path.resolve(parent) === path.resolve(inputDir) ? fallbackCategory : path.basename(parent);

  return { category, name, sourceType };
}

function detectDominantSourceType(files) {
  const counts = new Map();
  for (const file of files) {
    const ext = path.extname(file).toLowerCase().replace(".", "");
    counts.set(ext, (counts.get(ext) || 0) + 1);
  }

  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";
}

function sourceScore(sourceType) {
  return SOURCE_RANK[sourceType] || 0;
}

function printBuildPlan(sets, options) {
  console.log(`Input: ${options.inputDir}`);
  console.log(`Output: ${options.outputDir}`);
  console.log(
    `Target: ${options.targetMiB} MiB per zip/pdf / concurrency ${options.concurrency}`
  );
  console.log(
    `ZIP: source-resolution WebP / quality ${options.zipWebpMinQuality}-` +
      `${options.zipWebpMaxQuality} (baseline ${options.zipWebpQuality})`
  );
  console.log(
    `PDF: JPEG quality ${options.pdfJpegQuality}-${options.pdfJpegMaxQuality} / long edge ` +
      `${options.pdfMinLongEdge}-${options.pdfMaxLongEdge}px ` +
      `(baseline ${options.pdfLongEdge}px / quality ${options.pdfJpegQuality})`
  );
  if (options.chunkSize) {
    const effectiveMinTailSize = getEffectiveMinTailSize(options.chunkSize, options.minTailSize);
    console.log(
      `Chunk size: ${options.chunkSize} image(s) per zip/pdf pair ` +
        `(tail <= ${effectiveMinTailSize} image(s) is merged)`
    );
  }
  if (options.setFilter) {
    console.log(`Set filter: ${options.setFilter}`);
  }
  if (options.limit !== null) {
    console.log(`Limit: ${options.limit} set(s)`);
  }
  console.log(`Plan: ${sets.length} image set(s)`);

  for (const set of sets) {
    console.log("");
    console.log(`[${set.category}] ${set.name}`);
    console.log(`  Source: ${set.sourceType} / ${set.files.length} images / ${formatBytes(set.sourceBytes)}`);
    for (const chunk of splitFileChunks(set.files, options.chunkSize, options.minTailSize)) {
      const outputBaseName = getOutputBaseName(set.name, chunk, set.files.length);
      const chunkText =
        chunk.start === 1 && chunk.end === set.files.length
          ? ""
          : ` (${chunk.start}-${chunk.end})`;
      console.log(`  Output${chunkText}: ${path.join(options.outputDir, set.category, `${outputBaseName}.zip`)}`);
      console.log(`            ${path.join(options.outputDir, set.category, `${outputBaseName}.pdf`)}`);
    }
  }
}

async function buildSet(set, options) {
  const chunks = splitFileChunks(set.files, options.chunkSize, options.minTailSize);
  await assertNoObsoleteOutputs(set, chunks, options);
  for (const chunk of chunks) {
    await buildChunk(set, chunk, options);
  }
}

async function assertNoObsoleteOutputs(set, chunks, options) {
  const outputCategoryDir = path.join(options.outputDir, set.category);
  const entries = await fs.readdir(outputCategoryDir, { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  });
  const expectedBaseNames = new Set(
    chunks.map((chunk) => getOutputBaseName(set.name, chunk, set.files.length))
  );
  const escapedName = escapeRegExp(set.name);
  const outputPattern = new RegExp(
    `^(${escapedName}(?:_\\d+-\\d+)?)(?:\\.(?:zip|pdf|assets\\.json)|_jpg)$`,
    "i"
  );
  const obsolete = entries
    .map((entry) => ({ entry, match: entry.name.match(outputPattern) }))
    .filter(({ match }) => match && !expectedBaseNames.has(match[1]))
    .map(({ entry }) => entry.name);

  if (obsolete.length > 0) {
    throw new Error(
      [
        `${set.name}: 選択した出力フォルダに旧分割出力が残っています。`,
        ...obsolete.map((name) => `- ${path.join(outputCategoryDir, name)}`),
        "重複投稿を防ぐため停止しました。新しい空の出力フォルダ（推奨: optimized_webp_pdf）を選ぶか、旧出力を別の場所へ移動してから再実行してください。",
      ].join("\n")
    );
  }
}

async function buildChunk(set, chunk, options) {
  const outputCategoryDir = path.join(options.outputDir, set.category);
  const outputBaseName = getOutputBaseName(set.name, chunk, set.files.length);
  const zipPath = path.join(outputCategoryDir, `${outputBaseName}.zip`);
  const pdfPath = path.join(outputCategoryDir, `${outputBaseName}.pdf`);
  const profilePath = path.join(outputCategoryDir, `${outputBaseName}.assets.json`);
  const jpgDir = path.join(outputCategoryDir, `${outputBaseName}_jpg`);
  const label = `[${set.category}] ${outputBaseName}`;
  const sourceSignature = await createSourceSignature(chunk.files);

  if (!options.force && (await exists(zipPath)) && (await exists(pdfPath))) {
    const [zipStat, pdfStat] = await Promise.all([fs.stat(zipPath), fs.stat(pdfPath)]);
    if (
      zipStat.size <= options.targetBytes &&
      pdfStat.size <= options.targetBytes &&
      (await outputProfileMatches(
        profilePath,
        options,
        chunk.files.length,
        sourceSignature,
        zipPath,
        pdfPath,
        zipStat,
        pdfStat
      ))
    ) {
      console.log(`${label}: already built with the current profile under target; skipping`);
      return;
    }
  }

  console.log("");
  console.log(`${label}: optimizing ${chunk.files.length} image(s)...`);
  const zipResult = await findWebpZip(outputBaseName, chunk.files, options);
  const pdfResult = await findJpegPdf(outputBaseName, chunk.files, options);

  console.log(
    `${label}: ZIP selected source-resolution WebP quality ${zipResult.quality} / ` +
      `${formatBytes(zipResult.buffer.length)}`
  );
  console.log(
    `${label}: PDF selected JPEG quality ${pdfResult.quality} / ` +
      `${pdfResult.longEdge}px / ${formatBytes(pdfResult.buffer.length)}`
  );

  const zipSize = zipResult.buffer.length;
  const pdfSize = pdfResult.buffer.length;
  if (zipSize > options.targetBytes || pdfSize > options.targetBytes) {
    throw new Error(
      `${outputBaseName} could not be reduced under ${formatBytes(options.targetBytes)}. ` +
        `zip=${formatBytes(zipSize)}, pdf=${formatBytes(pdfSize)}.`
    );
  }

  if (options.keepJpgs) {
    await fs.rm(jpgDir, { recursive: true, force: true });
    await fs.mkdir(jpgDir, { recursive: true });
    for (const image of pdfResult.images) {
      await fs.writeFile(path.join(jpgDir, image.name), image.buffer);
    }
  }

  const profileBuffer = Buffer.from(
    `${JSON.stringify(
      createOutputProfile(options, chunk.files.length, sourceSignature, zipResult, pdfResult),
      null,
      2
    )}\n`,
    "utf8"
  );
  await writeOutputSetAtomically(
    { zipPath, pdfPath, profilePath },
    { zipBuffer: zipResult.buffer, pdfBuffer: pdfResult.buffer, profileBuffer }
  );

  console.log(`${label}: zip ${formatBytes(zipSize)} -> ${zipPath}`);
  console.log(`${label}: pdf ${formatBytes(pdfSize)} -> ${pdfPath}`);
}

async function findWebpZip(label, files, options) {
  const tried = new Map();
  let smallest = null;

  async function tryQuality(quality) {
    if (tried.has(quality)) {
      return tried.get(quality);
    }

    console.log(`  ZIP: trying source-resolution WebP quality ${quality}...`);
    const images = await renderWebpImages(files, {
      quality,
      concurrency: options.concurrency,
    });
    const candidate = { quality, images, buffer: await createZipBuffer(images) };
    tried.set(quality, candidate);
    if (!smallest || candidate.buffer.length < smallest.buffer.length) {
      smallest = candidate;
    }
    return candidate;
  }

  const baseline = await tryQuality(options.zipWebpQuality);
  let best = baseline.buffer.length <= options.targetBytes ? baseline : null;
  let low = best ? options.zipWebpQuality + 1 : options.zipWebpMinQuality;
  let high = best ? options.zipWebpMaxQuality : options.zipWebpQuality - 1;

  while (low <= high) {
    const quality = high === options.zipWebpMaxQuality ? high : Math.floor((low + high) / 2);
    const candidate = await tryQuality(quality);

    if (candidate.buffer.length <= options.targetBytes) {
      best = candidate;
      low = quality + 1;
    } else {
      high = quality - 1;
    }
  }

  if (best) {
    return best;
  }

  throw new Error(
    `${label}: ZIP用WebPを最低品質 ${options.zipWebpMinQuality} まで下げても ` +
      `${formatBytes(smallest?.buffer.length || 0)} あり、目標の ` +
      `${formatBytes(options.targetBytes)} を超えています。` +
      "GUIの「ZIP WebP 最低品質」をさらに下げるか、1組あたりの最大枚数を減らしてください。"
  );
}

async function findJpegPdf(label, files, options) {
  const candidates = await buildPdfCandidates(files, options);
  let smallest = null;

  for (const settings of candidates) {
    console.log(`  PDF: trying JPEG quality ${settings.quality} / ${settings.longEdge}px...`);
    const images = await renderJpegImages(files, {
      longEdge: settings.longEdge,
      quality: settings.quality,
      concurrency: options.concurrency,
    });
    const buffer = await createPdfBuffer(images);
    const candidate = {
      longEdge: settings.longEdge,
      quality: settings.quality,
      images,
      buffer,
    };
    if (!smallest || buffer.length < smallest.buffer.length) {
      smallest = candidate;
    }
    if (buffer.length <= options.targetBytes) {
      return candidate;
    }
  }

  throw new Error(
    `${label}: the JPEG PDF is ${formatBytes(smallest?.buffer.length || 0)} at quality ` +
      `${smallest?.quality || options.pdfJpegQuality} / ` +
      `${smallest?.longEdge || options.pdfMinLongEdge}px, above the ` +
      `${formatBytes(options.targetBytes)} target. Lower --pdf-min-long-edge or ` +
      "--pdf-jpeg-quality if necessary."
  );
}

async function buildPdfCandidates(files, options) {
  const metadata = await mapWithConcurrency(files, options.concurrency, readImageMetadata);
  const sourceLongEdge = Math.max(
    ...metadata.map((image) =>
      Math.max(image.width || options.pdfMaxLongEdge, image.height || options.pdfMaxLongEdge)
    )
  );
  const maximum = Math.min(options.pdfMaxLongEdge, sourceLongEdge);
  const baseline = Math.min(options.pdfLongEdge, sourceLongEdge);
  const minimum = Math.min(options.pdfMinLongEdge, baseline);
  const candidates = [];
  const seen = new Set();

  function addCandidate(longEdge, quality) {
    const normalizedEdge = Math.max(minimum, Math.min(maximum, Math.round(longEdge)));
    const normalizedQuality = Math.max(
      options.pdfJpegQuality,
      Math.min(options.pdfJpegMaxQuality, Math.round(quality))
    );
    const key = `${normalizedEdge}:${normalizedQuality}`;
    if (!seen.has(key)) {
      seen.add(key);
      candidates.push({ longEdge: normalizedEdge, quality: normalizedQuality });
    }
  }

  const edgeIncrease = Math.max(0, maximum - baseline);
  const qualityIncrease = Math.max(0, options.pdfJpegMaxQuality - options.pdfJpegQuality);
  const enhancementSteps = Math.min(
    5,
    Math.max(1, qualityIncrease, Math.ceil(edgeIncrease / 64))
  );
  for (let step = 0; step <= enhancementSteps; step += 1) {
    const progress = step / enhancementSteps;
    const longEdge =
      step === enhancementSteps
        ? baseline
        : roundToMultiple(maximum - edgeIncrease * progress, 16);
    const quality =
      step === enhancementSteps
        ? options.pdfJpegQuality
        : options.pdfJpegMaxQuality - qualityIncrease * progress;
    addCandidate(longEdge, quality);
  }

  const fallbackEdges = [
    baseline,
    1344,
    1320,
    1280,
    1200,
    1120,
    1024,
    960,
    minimum,
  ];
  for (const edge of fallbackEdges) {
    if (edge <= baseline && edge >= minimum) {
      addCandidate(edge, options.pdfJpegQuality);
    }
  }

  return candidates;
}

function roundToMultiple(value, multiple) {
  return Math.round(value / multiple) * multiple;
}

async function renderWebpImages(files, options) {
  return mapWithConcurrency(files, options.concurrency, async (file) => {
    const outputName = `${path.basename(file, path.extname(file))}.webp`;

    try {
      const buffer = await sharp(file, { limitInputPixels: false })
        .rotate()
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .webp({ quality: options.quality })
        .toBuffer();
      return { source: file, name: outputName, buffer };
    } catch (error) {
      throw createImageReadError(file, error);
    }
  });
}

async function renderJpegImages(files, options) {
  return mapWithConcurrency(files, options.concurrency, async (file) => {
    const outputName = `${path.basename(file, path.extname(file))}.jpg`;

    try {
      const buffer = await sharp(file, { limitInputPixels: false })
        .rotate()
        .flatten({ background: { r: 255, g: 255, b: 255 } })
        .resize({
          width: options.longEdge,
          height: options.longEdge,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({
          quality: options.quality,
          mozjpeg: true,
          progressive: true,
          chromaSubsampling: "4:2:0",
        })
        .toBuffer();
      return { source: file, name: outputName, buffer };
    } catch (error) {
      throw createImageReadError(file, error);
    }
  });
}

async function validateInputImages(sets, concurrency) {
  const files = Array.from(new Set(sets.flatMap((set) => set.files)));
  console.log("");
  console.log(`Validating ${files.length} input image(s)...`);

  const results = await mapWithConcurrency(files, concurrency, async (file) => {
    try {
      const stat = await fs.stat(file);
      if (stat.size === 0) {
        throw new Error("The file is empty.");
      }

      const metadata = await sharp(file, { limitInputPixels: false }).metadata();
      if (!metadata.format || !metadata.width || !metadata.height) {
        throw new Error("Image dimensions or format could not be detected.");
      }
      return null;
    } catch (error) {
      return {
        file,
        message: getErrorMessage(error),
      };
    }
  });

  const invalidFiles = results.filter(Boolean);
  if (invalidFiles.length === 0) {
    console.log("Input image validation passed.");
    return;
  }

  const details = invalidFiles.flatMap(({ file, message }) => [`- ${file}`, `  ${message}`]);
  throw new Error(
    [
      `読み込めない入力画像が ${invalidFiles.length} 件あります。`,
      ...details,
      "画像が破損しているか、拡張子と実際の形式が一致していません。",
      "該当画像を元データから再コピーまたは再出力して、もう一度実行してください。",
    ].join("\n")
  );
}

async function readImageMetadata(file) {
  try {
    return await sharp(file, { limitInputPixels: false }).metadata();
  } catch (error) {
    throw createImageReadError(file, error);
  }
}

function createImageReadError(file, error) {
  return new Error(`画像を読み込めません: ${file}\n${getErrorMessage(error)}`);
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.max(1, Math.min(concurrency || 1, items.length));

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    })
  );

  return results;
}

function splitFileChunks(files, chunkSize, minTailSize = null) {
  if (!chunkSize || chunkSize >= files.length) {
    return [
      {
        start: 1,
        end: files.length,
        files,
      },
    ];
  }

  const chunks = [];
  for (let index = 0; index < files.length; index += chunkSize) {
    const chunkFiles = files.slice(index, index + chunkSize);
    chunks.push({
      start: index + 1,
      end: index + chunkFiles.length,
      files: chunkFiles,
    });
  }

  const effectiveMinTailSize = getEffectiveMinTailSize(chunkSize, minTailSize);
  const tail = chunks[chunks.length - 1];
  const previous = chunks[chunks.length - 2];
  if (chunks.length > 1 && tail.files.length <= effectiveMinTailSize) {
    previous.end = tail.end;
    previous.files = [...previous.files, ...tail.files];
    chunks.pop();
  }

  return chunks;
}

function getEffectiveMinTailSize(chunkSize, minTailSize) {
  if (!chunkSize) {
    return 0;
  }
  return minTailSize === null ? Math.max(1, Math.ceil(chunkSize * 0.1)) : minTailSize;
}

function getOutputBaseName(setName, chunk, totalFiles) {
  if (chunk.start === 1 && chunk.end === totalFiles) {
    return setName;
  }
  return `${setName}_${chunk.start}-${chunk.end}`;
}

function createOutputProfile(options, imageCount, sourceSignature, zipResult, pdfResult) {
  return {
    profileVersion: ASSET_PROFILE_VERSION,
    imageCount,
    sourceSignature,
    targetMiB: options.targetMiB,
    zip: {
      format: "webp",
      preserveResolution: true,
      requestedQuality: options.zipWebpQuality,
      maximumQuality: options.zipWebpMaxQuality,
      minimumQuality: options.zipWebpMinQuality,
      selectedQuality: zipResult.quality,
      bytes: zipResult.buffer.length,
      sha256: hashBuffer(zipResult.buffer),
    },
    pdf: {
      imageFormat: "jpeg",
      requestedLongEdge: options.pdfLongEdge,
      maximumLongEdge: options.pdfMaxLongEdge,
      minimumLongEdge: options.pdfMinLongEdge,
      quality: options.pdfJpegQuality,
      maximumQuality: options.pdfJpegMaxQuality,
      selectedQuality: pdfResult.quality,
      selectedLongEdge: pdfResult.longEdge,
      bytes: pdfResult.buffer.length,
      sha256: hashBuffer(pdfResult.buffer),
    },
  };
}

async function outputProfileMatches(
  profilePath,
  options,
  imageCount,
  sourceSignature,
  zipPath,
  pdfPath,
  zipStat,
  pdfStat
) {
  try {
    const profile = JSON.parse(await fs.readFile(profilePath, "utf8"));
    const settingsMatch =
      profile.profileVersion === ASSET_PROFILE_VERSION &&
      profile.imageCount === imageCount &&
      profile.sourceSignature === sourceSignature &&
      profile.targetMiB === options.targetMiB &&
      profile.zip?.format === "webp" &&
      profile.zip?.preserveResolution === true &&
      profile.zip?.requestedQuality === options.zipWebpQuality &&
      profile.zip?.maximumQuality === options.zipWebpMaxQuality &&
      profile.zip?.selectedQuality >= options.zipWebpMinQuality &&
      profile.pdf?.imageFormat === "jpeg" &&
      profile.pdf?.requestedLongEdge === options.pdfLongEdge &&
      profile.pdf?.maximumLongEdge === options.pdfMaxLongEdge &&
      profile.pdf?.minimumLongEdge === options.pdfMinLongEdge &&
      profile.pdf?.quality === options.pdfJpegQuality &&
      profile.pdf?.maximumQuality === options.pdfJpegMaxQuality;
    if (
      !settingsMatch ||
      profile.zip?.bytes !== zipStat.size ||
      profile.pdf?.bytes !== pdfStat.size ||
      !profile.zip?.sha256 ||
      !profile.pdf?.sha256
    ) {
      return false;
    }

    const [zipBuffer, pdfBuffer] = await Promise.all([fs.readFile(zipPath), fs.readFile(pdfPath)]);
    return (
      hashBuffer(zipBuffer) === profile.zip.sha256 &&
      hashBuffer(pdfBuffer) === profile.pdf.sha256
    );
  } catch {
    return false;
  }
}

async function writeOutputSetAtomically(paths, buffers) {
  await fs.mkdir(path.dirname(paths.zipPath), { recursive: true });
  const suffix = `.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const temporary = {
    zipPath: `${paths.zipPath}${suffix}`,
    pdfPath: `${paths.pdfPath}${suffix}`,
    profilePath: `${paths.profilePath}${suffix}`,
  };

  try {
    await Promise.all([
      fs.writeFile(temporary.zipPath, buffers.zipBuffer),
      fs.writeFile(temporary.pdfPath, buffers.pdfBuffer),
      fs.writeFile(temporary.profilePath, buffers.profileBuffer),
    ]);
    await fs.rename(temporary.zipPath, paths.zipPath);
    await fs.rename(temporary.pdfPath, paths.pdfPath);
    await fs.rename(temporary.profilePath, paths.profilePath);
  } finally {
    await Promise.all(
      Object.values(temporary).map((file) => fs.rm(file, { force: true }).catch(() => {}))
    );
  }
}

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function createSourceSignature(files) {
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    const stat = await fs.stat(file);
    hash.update(path.basename(file));
    hash.update("\0");
    hash.update(String(stat.size));
    hash.update("\0");
    hash.update(String(stat.mtimeMs));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function createZipBuffer(images) {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks = [];

    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));

    for (const image of images) {
      zip.addBuffer(image.buffer, image.name, {
        mtime: new Date(0),
        mode: 0o100644,
        compress: true,
      });
    }

    zip.end();
  });
}

async function createPdfBuffer(images) {
  const pdf = await PDFDocument.create();
  pdf.setTitle("Discord upload package");
  pdf.setProducer("discord-post-tool");
  pdf.setCreator("discord-post-tool");

  for (const image of images) {
    const embedded = await pdf.embedJpg(image.buffer);
    const page = pdf.addPage([embedded.width, embedded.height]);
    page.drawImage(embedded, {
      x: 0,
      y: 0,
      width: embedded.width,
      height: embedded.height,
    });
  }

  return Buffer.from(
    await pdf.save({
      useObjectStreams: true,
      addDefaultPage: false,
      objectsPerTick: 200,
    })
  );
}

async function sumFileSizes(files) {
  let total = 0;
  for (const file of files) {
    total += (await fs.stat(file)).size;
  }
  return total;
}

async function exists(file) {
  return fsSync.existsSync(file);
}

function parseArgs(argv) {
  const parsed = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("-") || arg === "-") {
      parsed._.push(arg);
      continue;
    }

    if (arg === "--") {
      parsed._.push(...argv.slice(index + 1));
      break;
    }

    const long = arg.startsWith("--");
    const body = long ? arg.slice(2) : arg.slice(1);
    const equalsIndex = body.indexOf("=");
    let key = body;
    let value = true;

    if (equalsIndex !== -1) {
      key = body.slice(0, equalsIndex);
      value = body.slice(equalsIndex + 1);
    } else if (key.startsWith("no-")) {
      key = key.slice(3);
      value = false;
    } else if (argv[index + 1] && !argv[index + 1].startsWith("-")) {
      value = argv[index + 1];
      index += 1;
    }

    parsed[key] = value;
  }

  return parsed;
}

function readNumberArg(args, name, defaultValue) {
  const raw = args[name] === undefined ? defaultValue : args[name];
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive number`);
  }
  return value;
}

function readIntegerArg(args, name, defaultValue) {
  const value = readNumberArg(args, name, defaultValue);
  if (!Number.isInteger(value)) {
    throw new Error(`--${name} must be an integer`);
  }
  return value;
}

function compareNames(a, b) {
  return a.localeCompare(b, "ja");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function mibToBytes(mib) {
  return mib * 1024 * 1024;
}

function printHelp() {
  console.log(`discord-post-tool asset builder

Usage:
  npm run build-assets -- plan --input ./raw_images
  npm run build-assets -- run --input ./raw_images --output ./optimized_webp_pdf
  npm run build-assets -- run --input ./raw_images --chunk-size 100

Input:
  raw_images/
    title_png/*.png
    title_jpg/*.jpg

Output:
  optimized_webp_pdf/
    category/
      title.zip
      title.pdf
      title.assets.json
      title_1-100.zip
      title_1-100.pdf

Options:
  --input <path>          Source image root. Default: ./raw_images
  --output <path>         Output folder for zip/pdf pairs. Default: ./optimized_webp_pdf
  --category <name>       Category used when sets are directly under input. Default: category1
  --set <name>            Build only one image set
  --limit <n>             Build only the first n image sets
  --target-mib <n>        Max size for each zip/pdf. Default: 9.8
  --chunk-size <n>        Split each image set into chunks of n images. Default: 100
  --min-tail-size <n>     Merge final chunk when it has n or fewer images. Default: 10% of chunk size
  --zip-webp-quality <n>  Baseline WebP quality for ZIP images. Default: 75
  --zip-webp-max-quality <n> Highest WebP quality used when size allows. Default: 85
  --zip-webp-min-quality <n> Lowest WebP quality allowed. Default: 65
  --pdf-jpeg-quality <n>  Baseline/minimum JPEG quality for PDF pages. Default: 70
  --pdf-jpeg-max-quality <n> Highest JPEG quality used when size allows. Default: 75
  --pdf-long-edge <px>    Baseline PDF image long edge. Default: 1350
  --pdf-max-long-edge <px> Highest PDF image long edge when size allows. Default: 1600
  --pdf-min-long-edge <px> Lowest PDF image long edge. Default: 900
  --concurrency <n>       Number of images to convert in parallel. Default: 4
  --keep-jpgs             Also save the PDF-optimized JPGs next to zip/pdf
  --force                 Rebuild even if existing outputs are under target
`);
}

main().catch((error) => {
  console.error("");
  console.error(error.message);
  process.exitCode = 1;
});
