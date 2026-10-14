const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sharp = require("sharp");

const ROOT = path.resolve(__dirname, "..");
const BUILD_SCRIPT = path.join(ROOT, "src", "build-assets.js");

function runBuild(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BUILD_SCRIPT, ...args], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => child.kill(), 30000);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, output });
    });
  });
}

async function writeImage(file, color, index = 0) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await sharp({
    create: {
      width: 64,
      height: 80,
      channels: 3,
      background: color,
    },
  }).png().toFile(file);
  // Keep the fixture inputs distinct even when two sets use the same color.
  if (index) await fs.utimes(file, new Date(), new Date(Date.now() + index));
}

async function writeSet(root, parts, color, count = 2) {
  const directory = path.join(root, ...parts);
  for (let index = 0; index < count; index += 1) {
    await writeImage(path.join(directory, `${String(index + 1).padStart(3, "0")}.png`), color, index);
  }
}

async function assertOutputPair(outputRoot, categoryParts, workName) {
  const directory = path.join(outputRoot, ...categoryParts);
  await Promise.all([
    fs.access(path.join(directory, `${workName}.zip`)),
    fs.access(path.join(directory, `${workName}.pdf`)),
    fs.access(path.join(directory, `${workName}.assets.json`)),
  ]);
}

test("nested category/forum/work conversion keeps paths and same names independent", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-nested-conversion-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const input = path.join(root, "raw_images");
  const output = path.join(root, "optimized_webp_pdf");
  const env = { LOCALAPPDATA: path.join(root, "localappdata") };

  // The two identical work names must remain separate because their Discord
  // categories differ.  The same forum name is intentional as well.
  await writeSet(input, ["カテゴリA", "フォーラムX", "共通作品"], { r: 200, g: 40, b: 60 });
  await writeSet(input, ["カテゴリB", "フォーラムX", "共通作品"], { r: 40, g: 80, b: 200 });
  await writeSet(input, ["カテゴリA", "フォーラムY", "別作品"], { r: 40, g: 160, b: 80 }, 1);

  // Existing shallow layouts remain supported.
  await writeSet(input, ["旧カテゴリ", "旧作品"], { r: 120, g: 80, b: 20 }, 1);
  await writeSet(input, ["直作品"], { r: 80, g: 20, b: 140 }, 1);

  const plan = await runBuild([
    "plan", "--input", input, "--output", output,
    "--category", "フォールバックカテゴリ", "--chunk-size", "100",
  ], env);
  assert.equal(plan.code, 0, plan.output);
  assert.match(plan.output, /カテゴリA[\\/]フォーラムX/);
  assert.match(plan.output, /カテゴリB[\\/]フォーラムX/);
  assert.match(plan.output, /共通作品/);

  const first = await runBuild([
    "run", "--input", input, "--output", output,
    "--category", "フォールバックカテゴリ", "--chunk-size", "100", "--concurrency", "1",
  ], env);
  assert.equal(first.code, 0, first.output);

  await assertOutputPair(output, ["カテゴリA", "フォーラムX"], "共通作品");
  await assertOutputPair(output, ["カテゴリB", "フォーラムX"], "共通作品");
  await assertOutputPair(output, ["カテゴリA", "フォーラムY"], "別作品");
  await assertOutputPair(output, ["旧カテゴリ"], "旧作品");
  await assertOutputPair(output, ["フォールバックカテゴリ"], "直作品");

  const second = await runBuild([
    "run", "--input", input, "--output", output,
    "--category", "フォールバックカテゴリ", "--chunk-size", "100", "--concurrency", "1",
  ], env);
  assert.equal(second.code, 0, second.output);
  assert.equal(
    (second.output.match(/already built with the current profile under target; skipping/g) || []).length,
    5
  );
});

test("conversion rejects ambiguous deep and mixed image layouts before output", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-nested-conversion-errors-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { LOCALAPPDATA: path.join(root, "localappdata") };

  const deepInput = path.join(root, "deep-input");
  const deepOutput = path.join(root, "deep-output");
  await writeSet(deepInput, ["A", "B", "C", "D", "深すぎる作品"], { r: 80, g: 80, b: 80 }, 1);
  const deep = await runBuild(["run", "--input", deepInput, "--output", deepOutput], env);
  assert.equal(deep.code, 1);
  assert.match(deep.output, /階層が曖昧/);
  await assert.rejects(fs.access(deepOutput), { code: "ENOENT" });

  const mixedInput = path.join(root, "mixed-input");
  const mixedOutput = path.join(root, "mixed-output");
  const work = path.join(mixedInput, "カテゴリ", "フォーラム", "混在作品");
  await writeImage(path.join(work, "直下.png"), { r: 180, g: 50, b: 50 });
  await writeImage(path.join(work, "子作品", "001.png"), { r: 50, g: 50, b: 180 });
  const mixed = await runBuild(["run", "--input", mixedInput, "--output", mixedOutput], env);
  assert.equal(mixed.code, 1);
  assert.match(mixed.output, /混在/);
  await assert.rejects(fs.access(mixedOutput), { code: "ENOENT" });
});

test("distinct composed and decomposed Unicode work names are never grouped together", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-nested-unicode-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const input = path.join(root, "input"), output = path.join(root, "output");
  await writeSet(input, ["category", "forum", "Caf\u00e9"], { r: 200, g: 30, b: 50 }, 1);
  await writeSet(input, ["category", "forum", "Cafe\u0301"], { r: 30, g: 50, b: 200 }, 1);
  const result = await runBuild(["run", "--input", input, "--output", output, "--concurrency", "1"],
    { LOCALAPPDATA: path.join(root, "localappdata") });
  assert.equal(result.code, 0, result.output);
  await assertOutputPair(output, ["category", "forum"], "Caf\u00e9");
  await assertOutputPair(output, ["category", "forum"], "Cafe\u0301");
});
