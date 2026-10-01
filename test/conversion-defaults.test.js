const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const sharp = require("sharp");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const sha = data => crypto.createHash("sha256").update(data).digest("hex");

function build(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, "src/build-assets.js"), ...args], {
      cwd: ROOT, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    child.on("error", reject);
    const timer = setTimeout(() => child.kill(), 30000);
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(output));
      else resolve(output);
    });
  });
}

test("default CLI conversion preserves explicit serial output and skips existing outputs", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "discord-conversion-defaults-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, "input", "sample_png");
  await fs.mkdir(input, { recursive: true });
  for (let i = 0; i < 3; i++) {
    await sharp({ create: { width: 160, height: 220, channels: 3,
      background: { r: 60 + i * 30, g: 100, b: 170 } } }).png().toFile(path.join(input, `${i}.png`));
  }
  const env = { ...process.env, LOCALAPPDATA: dir };
  delete env.UV_THREADPOOL_SIZE;
  const output = path.join(dir, "default");
  const serial = path.join(dir, "serial");
  const args = ["run", "--input", path.dirname(input), "--keep-jpgs"];
  const log = await build([...args, "--output", output], env);
  assert.match(log, /concurrency 8/);
  await build([...args, "--output", serial, "--concurrency", "1"], { ...env, UV_THREADPOOL_SIZE: "1" });
  const category = (await fs.readdir(output))[0];
  const files = await fs.readdir(path.join(output, category));
  const profileName = files.find(name => name.endsWith(".assets.json"));
  const loadProfile = root => fs.readFile(path.join(root, category, profileName), "utf8").then(JSON.parse);
  const [a, b] = await Promise.all([loadProfile(output), loadProfile(serial)]);
  assert.equal(a.zip.selectedQuality, b.zip.selectedQuality);
  assert.equal(a.pdf.selectedQuality, b.pdf.selectedQuality);
  assert.equal(a.pdf.selectedLongEdge, b.pdf.selectedLongEdge);
  assert.equal(a.zip.sha256, b.zip.sha256);
  assert.equal(a.pdf.bytes, b.pdf.bytes);
  const jpgNames = (await fs.readdir(path.join(output, category), { recursive: true }))
    .filter(name => name.endsWith(".jpg"));
  assert.equal(jpgNames.length, 3);
  for (const name of jpgNames) {
    assert.equal(sha(await fs.readFile(path.join(output, category, name))),
      sha(await fs.readFile(path.join(serial, category, name))));
  }
  const before = await fs.readFile(path.join(output, category, profileName));
  const skipLog = await build([...args, "--output", output], env);
  assert.match(skipLog, /already built.*skipping/);
  assert.deepEqual(await fs.readFile(path.join(output, category, profileName)), before);
});

async function restore(saved) {
  const html = await fs.readFile(path.join(ROOT, "src/gui/renderer/index.html"), "utf8");
  const inputs = [...html.matchAll(/<(input|select)\b([^>]*\bid="([^"]+)"[^>]*)>/g)].map(match => ({
    id: match[3], value: /\bvalue="([^"]*)"/.exec(match[2])?.[1] || "",
    type: /\btype="([^"]*)"/.exec(match[2])?.[1] || "select", checked: false,
  }));
  const nodes = new Map(inputs.map(input => [input.id, input]));
  let stored = JSON.stringify(saved);
  const context = vm.createContext({
    window: { discordPostTool: {} },
    document: { addEventListener() {}, querySelectorAll: () => inputs },
    localStorage: { getItem: () => stored, setItem: (_key, value) => { stored = value; } },
    nodes,
  });
  vm.runInContext(await fs.readFile(path.join(ROOT, "src/gui/renderer/renderer.js"), "utf8"), context);
  vm.runInContext(`for (const [id, input] of nodes) elements[id] = input;
    switchTab = tab => { state.activeTab = tab; };
    restoreLocalState();`, context);
  return { inputs: nodes, saved: JSON.parse(stored) };
}

test("GUI migrates old default parallelism without changing paths, quality or active tab", async () => {
  const saved = { assetProfileVersion: 4, assetConcurrency: "4", activeTab: "post",
    assetInputDir: "custom-input", assetOutputDir: "custom-output", postInputDir: "unposted",
    assetPdfJpegQuality: "71", assetChunkSize: "80", postGuildId: "fixture-guild" };
  const result = await restore(saved);
  assert.equal(result.inputs.get("assetConcurrency").value, "8");
  for (const [key, value] of Object.entries(saved)) {
    if (key !== "assetConcurrency") assert.equal(result.saved[key], value);
  }
  assert.equal(result.saved.assetPerformanceVersion, 1);
});

test("GUI preserves custom parallelism and allows choosing 4 after migration", async () => {
  for (const value of ["2", "6", "12"]) {
    const result = await restore({ assetProfileVersion: 4, assetConcurrency: value });
    assert.equal(result.inputs.get("assetConcurrency").value, value);
  }
  const result = await restore({ assetProfileVersion: 4, assetPerformanceVersion: 1, assetConcurrency: "4" });
  assert.equal(result.inputs.get("assetConcurrency").value, "4");
});

test("GUI applies default parallelism when older settings have no saved value", async () => {
  const result = await restore({ assetProfileVersion: 4 });
  assert.equal(result.inputs.get("assetConcurrency").value, "8");
});

test("GUI supplies pool size only to conversion children and respects explicit environment", async () => {
  const context = vm.createContext({
    require: name => name === "electron" ? {
      app: { getPath: () => os.tmpdir(), setPath() {}, requestSingleInstanceLock: () => false,
        quit() {}, on() {}, whenReady: () => Promise.resolve() },
    } : name === "./project-profile" ? { projectProfilePath: () => os.tmpdir() }
      : name === "../discord-request" ? {} : require(name),
    __dirname: path.join(ROOT, "src/gui"), process: { argv: [], env: {} },
  });
  vm.runInContext(await fs.readFile(path.join(ROOT, "src/gui/main.js"), "utf8"), context);
  assert.equal(vm.runInContext('buildAssetsJob({}).env.UV_THREADPOOL_SIZE', context), "8");
  assert.equal(vm.runInContext('buildPostJob({}).env.UV_THREADPOOL_SIZE', context), undefined);
  vm.runInContext('process.env.UV_THREADPOOL_SIZE = "3"', context);
  assert.equal(vm.runInContext('buildAssetsJob({}).env.UV_THREADPOOL_SIZE', context), "3");
});
