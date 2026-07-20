#!/usr/bin/env node

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
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
  const outputDir = path.resolve(process.cwd(), String(args.output || "./optimized"));
  const categoryName = String(args.category || "カテゴリ1");
  const targetMiB = readNumberArg(args, "target-mib", 9.8);
  const maxLongEdge = readIntegerArg(args, "max-long-edge", 1600);
  const minLongEdge = readIntegerArg(args, "min-long-edge", 900);
  const maxQuality = readIntegerArg(args, "max-quality", 95);
  const minQuality = readIntegerArg(args, "min-quality", 42);
  const fixedQuality = args.quality === undefined ? null : readIntegerArg(args, "quality", 90);
  const concurrency = readIntegerArg(args, "concurrency", 4);
  const chunkSize = args["chunk-size"] === undefined ? null : readIntegerArg(args, "chunk-size", 1);
  const minTailSize =
    args["min-tail-size"] === undefined ? null : readIntegerArg(args, "min-tail-size", 1);
  const preserveResolution = Boolean(args["preserve-resolution"] || args["no-resize"]);
  const limit = args.limit === undefined ? null : readIntegerArg(args, "limit", 1);
  const setFilter = args.set ? String(args.set) : null;
  const keepJpgs = Boolean(args["keep-jpgs"]);
  const force = Boolean(args.force);

  if (minQuality > maxQuality) {
    throw new Error("--min-quality must be <= --max-quality");
  }
  if (fixedQuality !== null && (fixedQuality < 1 || fixedQuality > 100)) {
    throw new Error("--quality must be between 1 and 100");
  }
  if (minQuality < 1 || maxQuality > 100) {
    throw new Error("--min-quality and --max-quality must be between 1 and 100");
  }
  if (minLongEdge > maxLongEdge) {
    throw new Error("--min-long-edge must be <= --max-long-edge");
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
    maxLongEdge,
    minLongEdge,
    maxQuality,
    minQuality,
    fixedQuality,
    concurrency,
    chunkSize,
    minTailSize,
    preserveResolution,
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
      maxLongEdge,
      minLongEdge,
      maxQuality,
      minQuality,
      fixedQuality,
      concurrency,
      chunkSize,
      minTailSize,
      preserveResolution,
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
  const edgeText = options.preserveResolution
    ? "preserve source resolution"
    : `edge ${options.minLongEdge}-${options.maxLongEdge}px`;
  console.log(
    `Target: ${options.targetMiB} MiB per zip/pdf / ${edgeText} / ` +
      `${options.fixedQuality === null ? `quality ${options.minQuality}-${options.maxQuality}` : `fixed quality ${options.fixedQuality}`} / ` +
      `concurrency ${options.concurrency}`
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
  for (const chunk of splitFileChunks(set.files, options.chunkSize, options.minTailSize)) {
    await buildChunk(set, chunk, options);
  }
}

async function buildChunk(set, chunk, options) {
  const outputCategoryDir = path.join(options.outputDir, set.category);
  const outputBaseName = getOutputBaseName(set.name, chunk, set.files.length);
  const zipPath = path.join(outputCategoryDir, `${outputBaseName}.zip`);
  const pdfPath = path.join(outputCategoryDir, `${outputBaseName}.pdf`);
  const jpgDir = path.join(outputCategoryDir, `${outputBaseName}_jpg`);
  const label = `[${set.category}] ${outputBaseName}`;

  if (!options.force && (await exists(zipPath)) && (await exists(pdfPath))) {
    const [zipStat, pdfStat] = await Promise.all([fs.stat(zipPath), fs.stat(pdfPath)]);
    if (zipStat.size <= options.targetBytes && pdfStat.size <= options.targetBytes) {
      console.log(`${label}: already built under target; skipping`);
      return;
    }
  }

  console.log("");
  console.log(`${label}: optimizing ${chunk.files.length} image(s)...`);
  const optimized = await findOptimizedImages(outputBaseName, chunk.files, options);
  const edgeText = optimized.longEdge === null ? "source resolution" : `${optimized.longEdge}px`;

  console.log(
    `${label}: selected ${edgeText} / quality ${optimized.quality} / images ${formatBytes(
      sumBuffers(optimized.images)
    )}`
  );

  await fs.mkdir(outputCategoryDir, { recursive: true });

  const zipBuffer = await createZipBuffer(optimized.images);
  await fs.writeFile(zipPath, zipBuffer);

  const pdfBuffer = await createPdfBuffer(optimized.images);
  await fs.writeFile(pdfPath, pdfBuffer);

  if (options.keepJpgs) {
    await fs.rm(jpgDir, { recursive: true, force: true });
    await fs.mkdir(jpgDir, { recursive: true });
    for (const image of optimized.images) {
      await fs.writeFile(path.join(jpgDir, image.name), image.buffer);
    }
  }

  const zipSize = zipBuffer.length;
  const pdfSize = pdfBuffer.length;
  console.log(`${label}: zip ${formatBytes(zipSize)} -> ${zipPath}`);
  console.log(`${label}: pdf ${formatBytes(pdfSize)} -> ${pdfPath}`);

  if (zipSize > options.targetBytes || pdfSize > options.targetBytes) {
    throw new Error(
      `${outputBaseName} could not be reduced under ${formatBytes(options.targetBytes)}. ` +
        `zip=${formatBytes(zipSize)}, pdf=${formatBytes(pdfSize)}. ` +
        "Lower --min-quality, split the image set further, or allow resizing."
    );
  }
}

async function findOptimizedImages(label, files, options) {
  const edges = options.preserveResolution ? [null] : await buildLongEdgeCandidates(files, options);
  let lastCandidate = null;

  for (const edge of edges) {
    if (options.fixedQuality !== null) {
      const edgeText = edge === null ? "source resolution" : `${edge}px`;
      console.log(`  rendering ${edgeText} / fixed quality ${options.fixedQuality}...`);
      return renderImages(files, {
        longEdge: edge,
        quality: options.fixedQuality,
        concurrency: options.concurrency,
      });
    }

    const edgeText = edge === null ? "source resolution" : `${edge}px`;
    console.log(`  trying ${edgeText} / quality ${options.maxQuality}...`);
    const maxCandidate = await renderImages(files, {
      longEdge: edge,
      quality: options.maxQuality,
      concurrency: options.concurrency,
    });
    lastCandidate = maxCandidate;
    if (await fitsTarget(maxCandidate.images, options.targetBytes)) {
      return maxCandidate;
    }

    let low = options.minQuality;
    let high = options.maxQuality - 1;
    let best = null;

    while (low <= high) {
      const quality = Math.floor((low + high) / 2);
      console.log(`  trying ${edgeText} / quality ${quality}...`);
      const candidate = await renderImages(files, {
        longEdge: edge,
        quality,
        concurrency: options.concurrency,
      });
      lastCandidate = candidate;

      if (await fitsTarget(candidate.images, options.targetBytes)) {
        best = candidate;
        low = quality + 1;
      } else {
        high = quality - 1;
      }
    }

    if (best) {
      return best;
    }
  }

  if (lastCandidate) {
    return lastCandidate;
  }

  throw new Error(`${label}: no images were rendered.`);
}

async function buildLongEdgeCandidates(files, options) {
  const metadata = await readImageMetadata(files[0]);
  const sourceLongEdge = Math.max(metadata.width || options.maxLongEdge, metadata.height || options.maxLongEdge);
  const start = Math.min(options.maxLongEdge, sourceLongEdge);
  const baseCandidates = [
    start,
    1536,
    1440,
    1365,
    1280,
    1200,
    1120,
    1024,
    960,
    options.minLongEdge,
  ];

  return Array.from(new Set(baseCandidates))
    .filter((edge) => edge <= start && edge >= options.minLongEdge)
    .sort((a, b) => b - a);
}

async function renderImages(files, options) {
  return {
    longEdge: options.longEdge,
    quality: options.quality,
    images: await mapWithConcurrency(files, options.concurrency, async (file) => {
      const outputName = `${path.basename(file, path.extname(file))}.jpg`;

      try {
        let pipeline = sharp(file, { limitInputPixels: false })
          .rotate()
          .flatten({ background: { r: 255, g: 255, b: 255 } });

        if (options.longEdge !== null) {
          pipeline = pipeline.resize({
            width: options.longEdge,
            height: options.longEdge,
            fit: "inside",
            withoutEnlargement: true,
          });
        }

        const buffer = await pipeline
          .jpeg({
            quality: options.quality,
            mozjpeg: true,
            progressive: true,
            chromaSubsampling: "4:2:0",
          })
          .toBuffer();

        return {
          source: file,
          name: outputName,
          buffer,
        };
      } catch (error) {
        throw createImageReadError(file, error);
      }
    }),
  };
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

async function fitsTarget(images, targetBytes) {
  const imageBytes = sumBuffers(images);
  if (imageBytes > targetBytes) {
    return false;
  }

  const zipBuffer = await createZipBuffer(images);
  if (zipBuffer.length > targetBytes) {
    return false;
  }

  const pdfBuffer = await createPdfBuffer(images);
  return pdfBuffer.length <= targetBytes;
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

function sumBuffers(images) {
  return images.reduce((sum, image) => sum + image.buffer.length, 0);
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
  npm run build-assets -- run --input ./raw_images --output ./optimized
  npm run build-assets -- run --input ./raw_images --chunk-size 50 --preserve-resolution

Input:
  raw_images/
    title_png/*.png
    title_jpg/*.jpg

Output:
  optimized/
    category/
      title.zip
      title.pdf
      title_1-50.zip
      title_1-50.pdf

Options:
  --input <path>          Source image root. Default: ./raw_images
  --output <path>         Output folder for zip/pdf pairs. Default: ./optimized
  --category <name>       Category used when sets are directly under input. Default: category1
  --set <name>            Build only one image set
  --limit <n>             Build only the first n image sets
  --target-mib <n>        Max size for each zip/pdf. Default: 9.8
  --chunk-size <n>        Split each image set into chunks of n images
  --min-tail-size <n>     Merge final chunk when it has n or fewer images. Default: 10% of chunk size
  --preserve-resolution   Keep source dimensions and only change JPEG quality
  --no-resize             Alias for --preserve-resolution
  --max-long-edge <px>    First long-edge size to try. Default: 1600
  --min-long-edge <px>    Lowest long-edge size to try. Default: 900
  --max-quality <n>       Highest JPEG quality to try. Default: 95
  --min-quality <n>       Lowest JPEG quality to try. Default: 42
  --quality <n>           Fixed JPEG quality. Faster; skips quality search
  --concurrency <n>       Number of images to convert in parallel. Default: 4
  --keep-jpgs             Also save optimized JPGs next to zip/pdf
  --force                 Rebuild even if existing outputs are under target
`);
}

main().catch((error) => {
  console.error("");
  console.error(error.message);
  process.exitCode = 1;
});
