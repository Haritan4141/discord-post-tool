const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fsSync = require("node:fs");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const sharp = require("sharp");
const { main: cliMain } = require("../src/cli");
const { main: buildMain } = require("../src/build-assets");

const repoRoot = path.resolve(__dirname, "..");

function runNode(script, args, env) {
  return startNode([script, ...args], env).done;
}

function startNode(args, env, timeoutMs = 30000) {
  const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  let timer;
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
  timer = setTimeout(() => {
    timedOut = true;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, timeoutMs);
  return {
    child,
    done,
    async stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await done.catch(() => {});
    },
  };
}

function runNodeCode(code, args, env) {
  return startNode(["-e", code, ...args], env).done;
}

async function waitForFile(file, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (!fsSync.existsSync(file)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for barrier: ${file}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function withArgv(args, action) {
  const previous = process.argv;
  process.argv = [process.execPath, "test-cli", ...args];
  try {
    return await action();
  } finally {
    process.argv = previous;
  }
}

async function writeLegacyPair(categoryDir, baseName = "sample") {
  await fs.mkdir(categoryDir, { recursive: true });
  await fs.writeFile(path.join(categoryDir, `${baseName}.zip`), Buffer.from("fixture zip"));
  await fs.writeFile(path.join(categoryDir, `${baseName}.pdf`), Buffer.from("fixture pdf"));
}

function mockApiFactory(calls, prefix = "fixture") {
  let nextId = 0;
  return () => {
    calls.created += 1;
    return {
      async getGuildChannels() {
        calls.getGuildChannels += 1;
        return [];
      },
      async createGuildChannel(_guildId, options) {
        const id = `${prefix}-${++nextId}`;
        return {
          id,
          name: options.name,
          type: options.type,
          parent_id: options.parent_id || null,
        };
      },
      async getRecentMessages() {
        calls.getRecentMessages += 1;
        return [];
      },
      async createMessage(_channelId, _body, files) {
        calls.createMessage += 1;
        calls.fileCounts ||= [];
        calls.fileCounts.push(files?.length || 0);
        return { id: `${prefix}-message-${nextId}` };
      },
    };
  };
}

test("build leaves a pending marker fail-closed and a later build clears it", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-artifacts-build-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const inputDir = path.join(root, "input");
  const outputDir = path.join(root, "output");
  const imageDir = path.join(inputDir, "sample");
  await fs.mkdir(imageDir, { recursive: true });
  const image = await sharp({
    create: { width: 32, height: 32, channels: 3, background: { r: 35, g: 80, b: 160 } },
  }).png().toBuffer();
  await fs.writeFile(path.join(imageDir, "one.png"), image);

  const runtimeHome = path.join(root, "localappdata");
  const first = await runNode("src/build-assets.js", [
    "run", "--input", inputDir, "--output", outputDir, "--concurrency", "1",
  ], { LOCALAPPDATA: runtimeHome });
  assert.equal(first.code, 0, first.stderr || first.stdout);

  const categoryDir = path.join(outputDir, "カテゴリ1");
  const setPendingPath = path.join(categoryDir, "sample.assets.pending");
  await fs.writeFile(setPendingPath, "interrupted after all chunks\n");
  const recoveredReusable = await runNode("src/build-assets.js", [
    "run", "--input", inputDir, "--output", outputDir, "--concurrency", "1",
  ], { LOCALAPPDATA: runtimeHome });
  assert.equal(recoveredReusable.code, 0, recoveredReusable.stderr || recoveredReusable.stdout);
  await assert.rejects(fs.access(setPendingPath), { code: "ENOENT" });

  const pendingPath = path.join(categoryDir, "sample.pending");
  await fs.writeFile(pendingPath, "interrupted fixture\n");

  const second = await runNode("src/build-assets.js", [
    "run", "--input", inputDir, "--output", outputDir, "--concurrency", "1",
  ], { LOCALAPPDATA: runtimeHome });
  assert.equal(second.code, 0, second.stderr || second.stdout);
  await assert.rejects(fs.access(pendingPath), { code: "ENOENT" });
  await fs.access(path.join(categoryDir, "sample.zip"));
  await fs.access(path.join(categoryDir, "sample.pdf"));
  await fs.access(path.join(categoryDir, "sample.assets.json"));

  const calls = { created: 0, getGuildChannels: 0, getRecentMessages: 0, createMessage: 0 };
  await withArgv([
    "run", "--input", outputDir, "--manifest", path.join(root, "manifest.json"),
    "--guild", "guild-generated", "--token", "fixture-token", "--yes", "--no-remote-check",
  ], () => cliMain({ runtimeDir: path.join(root, "cli-runtime"), apiFactory: mockApiFactory(calls) }));
  assert.equal(calls.createMessage, 1);
});

test("posting refuses pending generated output before creating an API client", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-artifacts-pending-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputDir = path.join(root, "input");
  const categoryDir = path.join(inputDir, "category");
  await writeLegacyPair(categoryDir);
  await fs.writeFile(path.join(categoryDir, "sample.pending"), "pending\n");

  const calls = { created: 0, getGuildChannels: 0, getRecentMessages: 0, createMessage: 0 };
  await assert.rejects(
    withArgv([
      "run", "--input", inputDir, "--manifest", path.join(root, "manifest.json"),
      "--guild", "guild-pending", "--token", "fixture-token", "--yes", "--no-remote-check",
    ], () => cliMain({ runtimeDir: path.join(root, "runtime"), apiFactory: mockApiFactory(calls) })),
    /生成済み出力の整合性検証に失敗.*pending/s
  );
  assert.equal(calls.created, 0);
  assert.equal(calls.getGuildChannels, 0);
});

test("posting refuses a generated pair whose profile hash no longer matches", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-artifacts-profile-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputDir = path.join(root, "input");
  const categoryDir = path.join(inputDir, "category");
  await writeLegacyPair(categoryDir);
  const zip = await fs.readFile(path.join(categoryDir, "sample.zip"));
  const pdf = await fs.readFile(path.join(categoryDir, "sample.pdf"));
  await fs.writeFile(path.join(categoryDir, "sample.assets.json"), JSON.stringify({
    zip: { bytes: zip.length, sha256: "0".repeat(64) },
    pdf: {
      bytes: pdf.length,
      sha256: crypto.createHash("sha256").update(pdf).digest("hex"),
    },
  }));

  const calls = { created: 0, getGuildChannels: 0, getRecentMessages: 0, createMessage: 0 };
  await assert.rejects(
    withArgv([
      "run", "--input", inputDir, "--manifest", path.join(root, "manifest.json"),
      "--guild", "guild-profile", "--token", "fixture-token", "--yes", "--no-remote-check",
    ], () => cliMain({ runtimeDir: path.join(root, "runtime"), apiFactory: mockApiFactory(calls) })),
    /生成済み出力の整合性検証に失敗.*SHA-256/s
  );
  assert.equal(calls.created, 0);
  assert.equal(calls.getGuildChannels, 0);
});

test("an interrupted forced rebuild leaves mixed outputs blocked until the pair is recovered", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-artifacts-mixed-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const inputDir = path.join(root, "input");
  const outputDir = path.join(root, "output");
  const imageDir = path.join(inputDir, "sample");
  await fs.mkdir(imageDir, { recursive: true });
  const imagePath = path.join(imageDir, "one.png");

  await fs.writeFile(
    imagePath,
    await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 30, g: 90, b: 180 } },
    }).png().toBuffer()
  );
  await withArgv([
    "run", "--input", inputDir, "--output", outputDir, "--concurrency", "1",
  ], () => buildMain({ runtimeDir: path.join(root, "build-runtime") }));

  const categoryDir = path.join(outputDir, "カテゴリ1");
  const zipPath = path.join(categoryDir, "sample.zip");
  const pdfPath = path.join(categoryDir, "sample.pdf");
  const profilePath = path.join(categoryDir, "sample.assets.json");
  const pairPendingPath = path.join(categoryDir, "sample.pending");
  const setPendingPath = path.join(categoryDir, "sample.assets.pending");
  const oldProfile = JSON.parse(await fs.readFile(profilePath, "utf8"));
  const oldPdfHash = crypto.createHash("sha256")
    .update(await fs.readFile(pdfPath))
    .digest("hex");
  assert.equal(oldPdfHash, oldProfile.pdf.sha256);

  // Make the next forced build produce different bytes, then stop after the
  // new ZIP has replaced the old one but before the PDF replacement.
  await fs.writeFile(
    imagePath,
    await sharp({
      create: { width: 64, height: 48, channels: 3, background: { r: 190, g: 40, b: 60 } },
    }).png().toBuffer()
  );
  const previousRename = fs.rename;
  let zipFinalRenamed = false;
  fs.rename = async (source, destination) => {
    const destinationPath = path.resolve(String(destination));
    if (destinationPath === path.resolve(zipPath)) {
      zipFinalRenamed = true;
      return previousRename(source, destination);
    }
    if (zipFinalRenamed && destinationPath === path.resolve(pdfPath)) {
      throw new Error("injected PDF final rename failure");
    }
    return previousRename(source, destination);
  };
  try {
    await assert.rejects(
      withArgv([
        "run", "--input", inputDir, "--output", outputDir,
        "--concurrency", "1", "--force",
      ], () => buildMain({ runtimeDir: path.join(root, "build-runtime") })),
      /injected PDF final rename failure/
    );
  } finally {
    fs.rename = previousRename;
  }
  assert.equal(zipFinalRenamed, true);

  await fs.access(pairPendingPath);
  await fs.access(setPendingPath);
  const mixedProfile = JSON.parse(await fs.readFile(profilePath, "utf8"));
  const mixedZipHash = crypto.createHash("sha256")
    .update(await fs.readFile(zipPath))
    .digest("hex");
  const mixedPdfHash = crypto.createHash("sha256")
    .update(await fs.readFile(pdfPath))
    .digest("hex");
  assert.notEqual(mixedZipHash, mixedProfile.zip.sha256);
  assert.equal(mixedPdfHash, mixedProfile.pdf.sha256);
  assert.equal(mixedProfile.pdf.sha256, oldPdfHash);

  const blockedCalls = { created: 0, getGuildChannels: 0, getRecentMessages: 0, createMessage: 0 };
  await assert.rejects(
    withArgv([
      "run", "--input", outputDir, "--manifest", path.join(root, "blocked.json"),
      "--guild", "guild-mixed-blocked", "--token", "fixture-token", "--yes", "--no-remote-check",
    ], () => cliMain({
      runtimeDir: path.join(root, "blocked-runtime"),
      apiFactory: mockApiFactory(blockedCalls),
    })),
    /生成済み出力の整合性検証に失敗.*作品全体/s
  );
  assert.equal(blockedCalls.created, 0);
  assert.equal(blockedCalls.createMessage, 0);

  await withArgv([
    "run", "--input", inputDir, "--output", outputDir, "--concurrency", "1",
  ], () => buildMain({ runtimeDir: path.join(root, "build-runtime") }));
  await assert.rejects(fs.access(pairPendingPath), { code: "ENOENT" });
  await assert.rejects(fs.access(setPendingPath), { code: "ENOENT" });
  const recoveredProfile = JSON.parse(await fs.readFile(profilePath, "utf8"));
  const recoveredZip = await fs.readFile(zipPath);
  const recoveredPdf = await fs.readFile(pdfPath);
  assert.equal(recoveredProfile.zip.sha256, crypto.createHash("sha256").update(recoveredZip).digest("hex"));
  assert.equal(recoveredProfile.pdf.sha256, crypto.createHash("sha256").update(recoveredPdf).digest("hex"));
  assert.notEqual(recoveredProfile.zip.sha256, oldProfile.zip.sha256);

  const recoveredCalls = { created: 0, getGuildChannels: 0, getRecentMessages: 0, createMessage: 0 };
  await withArgv([
    "run", "--input", outputDir, "--manifest", path.join(root, "recovered.json"),
    "--guild", "guild-mixed-recovered", "--token", "fixture-token", "--yes", "--no-remote-check",
  ], () => cliMain({
    runtimeDir: path.join(root, "recovered-runtime"),
    apiFactory: mockApiFactory(recoveredCalls),
  }));
  assert.equal(recoveredCalls.createMessage, 1);
  assert.deepEqual(recoveredCalls.fileCounts, [2]);
});

test("a profile-bound output needs a pair while legacy zip-only input stays allowed", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-artifacts-pair-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputDir = path.join(root, "input");
  const categoryDir = path.join(inputDir, "category");
  await fs.mkdir(categoryDir, { recursive: true });
  const zipPath = path.join(categoryDir, "sample.zip");
  const zip = Buffer.from("fixture zip");
  await fs.writeFile(zipPath, zip);
  await fs.writeFile(path.join(categoryDir, "sample.assets.json"), JSON.stringify({
    zip: { bytes: zip.length, sha256: crypto.createHash("sha256").update(zip).digest("hex") },
  }));

  const blockedCalls = { created: 0, getGuildChannels: 0, getRecentMessages: 0, createMessage: 0 };
  await assert.rejects(
    withArgv([
      "run", "--input", inputDir, "--manifest", path.join(root, "manifest.json"),
      "--guild", "guild-pair", "--token", "fixture-token", "--yes", "--no-remote-check",
    ], () => cliMain({ runtimeDir: path.join(root, "blocked-runtime"), apiFactory: mockApiFactory(blockedCalls) })),
    /生成済み出力の整合性検証に失敗.*pair/s
  );
  assert.equal(blockedCalls.created, 0);

  await fs.rm(path.join(categoryDir, "sample.assets.json"));
  const legacyCalls = { created: 0, getGuildChannels: 0, getRecentMessages: 0, createMessage: 0 };
  await withArgv([
    "run", "--input", inputDir, "--manifest", path.join(root, "legacy-manifest.json"),
    "--guild", "guild-legacy", "--token", "fixture-token", "--yes", "--no-remote-check",
  ], () => cliMain({ runtimeDir: path.join(root, "legacy-runtime"), apiFactory: mockApiFactory(legacyCalls) }));
  assert.equal(legacyCalls.createMessage, 1);
});

test("a split build transaction marker blocks partial posting and is recovered by a later run", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-artifacts-split-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputDir = path.join(root, "input");
  const outputDir = path.join(root, "output");
  const imageDir = path.join(inputDir, "work");
  await fs.mkdir(imageDir, { recursive: true });
  for (const [name, color] of [
    ["one.png", { r: 20, g: 80, b: 140 }],
    ["two.png", { r: 140, g: 80, b: 20 }],
    ["three.png", { r: 80, g: 140, b: 20 }],
  ]) {
    await fs.writeFile(path.join(imageDir, name), await sharp({
      create: { width: 32, height: 32, channels: 3, background: color },
    }).png().toBuffer());
  }

  const previousRm = fs.rm;
  let injected = false;
  fs.rm = async (target, options) => {
    const targetText = String(target);
    if (!injected && targetText.endsWith(`${path.sep}work_1-1.pending`)) {
      injected = true;
      await previousRm(target, options);
      throw new Error("injected stop after first split output");
    }
    return previousRm(target, options);
  };
  try {
    await assert.rejects(
      withArgv([
        "run", "--input", inputDir, "--output", outputDir,
        "--chunk-size", "1", "--concurrency", "1",
      ], () => buildMain({ runtimeDir: path.join(root, "build-runtime") })),
      /injected stop after first split output/
    );
  } finally {
    fs.rm = previousRm;
  }
  assert.equal(injected, true);

  const categoryDir = path.join(outputDir, "カテゴリ1");
  await fs.access(path.join(categoryDir, "work_1-1.zip"));
  await fs.access(path.join(categoryDir, "work_1-1.pdf"));
  await fs.access(path.join(categoryDir, "work_1-1.assets.json"));
  await assert.rejects(fs.access(path.join(categoryDir, "work_2-3.zip")), { code: "ENOENT" });
  await fs.access(path.join(categoryDir, "work.assets.pending"));
  await assert.rejects(fs.access(path.join(categoryDir, "work_1-1.pending")), { code: "ENOENT" });

  const blockedCalls = { created: 0, getGuildChannels: 0, getRecentMessages: 0, createMessage: 0 };
  await assert.rejects(
    withArgv([
      "run", "--input", outputDir, "--manifest", path.join(root, "blocked.json"),
      "--guild", "guild-split-blocked", "--token", "fixture-token", "--yes", "--no-remote-check",
    ], () => cliMain({ runtimeDir: path.join(root, "blocked-runtime"), apiFactory: mockApiFactory(blockedCalls) })),
    /生成済み出力の整合性検証に失敗.*作品全体/s
  );
  assert.equal(blockedCalls.created, 0);

  await withArgv([
    "run", "--input", inputDir, "--output", outputDir,
    "--chunk-size", "1", "--concurrency", "1",
  ], () => buildMain({ runtimeDir: path.join(root, "build-runtime") }));
  await assert.rejects(fs.access(path.join(categoryDir, "work.assets.pending")), { code: "ENOENT" });
  await fs.access(path.join(categoryDir, "work_2-3.zip"));
  await fs.access(path.join(categoryDir, "work_2-3.pdf"));
  await fs.access(path.join(categoryDir, "work_2-3.assets.json"));

  const recoveredCalls = { created: 0, getGuildChannels: 0, getRecentMessages: 0, createMessage: 0 };
  await withArgv([
    "run", "--input", outputDir, "--manifest", path.join(root, "recovered.json"),
    "--guild", "guild-split-recovered", "--token", "fixture-token", "--yes", "--no-remote-check",
  ], () => cliMain({ runtimeDir: path.join(root, "recovered-runtime"), apiFactory: mockApiFactory(recoveredCalls) }));
  assert.deepEqual(recoveredCalls.fileCounts, [4]);
});

test("manifest staging keeps a.json and a.json.tmp independent and rejects reserved paths", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-artifacts-manifest-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputDir = path.join(root, "input");
  await writeLegacyPair(path.join(inputDir, "category"));
  const manifestA = path.join(root, "a.json");
  const manifestB = `${manifestA}.tmp`;

  for (const [manifest, guild, prefix] of [
    [manifestA, "guild-a", "a"],
    [manifestB, "guild-b", "b"],
  ]) {
    const calls = { created: 0, getGuildChannels: 0, getRecentMessages: 0, createMessage: 0 };
    await withArgv([
      "run", "--input", inputDir, "--manifest", manifest, "--guild", guild,
      "--token", "fixture-token", "--yes", "--no-remote-check",
    ], () => cliMain({ runtimeDir: path.join(root, `runtime-${prefix}`), apiFactory: mockApiFactory(calls, prefix) }));
    assert.equal(calls.getGuildChannels, 1);
    assert.equal(calls.createMessage, 1);
  }

  const savedA = JSON.parse(await fs.readFile(manifestA, "utf8"));
  const savedB = JSON.parse(await fs.readFile(manifestB, "utf8"));
  assert.deepEqual(Object.keys(savedA.guilds), ["guild-a"]);
  assert.deepEqual(Object.keys(savedB.guilds), ["guild-b"]);

  const stagingRoot = path.join(root, ".discord-post-tool-manifest-staging");
  const stagingEntries = await fs.readdir(stagingRoot, { withFileTypes: true });
  assert.equal(stagingEntries.filter((entry) => entry.isDirectory()).length, 2);
  for (const entry of stagingEntries.filter((item) => item.isDirectory())) {
    assert.deepEqual(await fs.readdir(path.join(stagingRoot, entry.name)), []);
  }

  const calls = { created: 0, getGuildChannels: 0, getRecentMessages: 0, createMessage: 0 };
  await assert.rejects(
    withArgv([
      "run", "--input", inputDir, "--manifest", path.join(stagingRoot, "reserved.json"),
      "--guild", "guild-reserved", "--token", "fixture-token", "--yes", "--no-remote-check",
    ], () => cliMain({ runtimeDir: path.join(root, "runtime-reserved"), apiFactory: mockApiFactory(calls) })),
    /reserved staging directory/
  );
  assert.equal(calls.created, 0);
});

test("manifest staging under the input root is never treated as a Discord category", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-artifacts-manifest-input-root-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const inputDir = path.join(root, "input");
  const manifestPath = path.join(inputDir, "manifest.json");
  await writeLegacyPair(path.join(inputDir, "category"));

  const channels = [];
  const createdChannels = [];
  const calls = { created: 0, getGuildChannels: 0, getRecentMessages: 0, createMessage: 0 };
  let nextChannelId = 0;
  const apiFactory = () => ({
    async getGuildChannels() {
      calls.getGuildChannels += 1;
      return channels.map((channel) => ({ ...channel }));
    },
    async createGuildChannel(_guildId, options) {
      const channel = {
        id: `input-root-${++nextChannelId}`,
        name: options.name,
        type: options.type,
        parent_id: options.parent_id || null,
      };
      channels.push(channel);
      createdChannels.push(channel);
      return channel;
    },
    async getRecentMessages() {
      calls.getRecentMessages += 1;
      return [];
    },
    async createMessage(_channelId, _body, files) {
      calls.createMessage += 1;
      calls.fileCounts ||= [];
      calls.fileCounts.push(files?.length || 0);
      return { id: `input-root-message-${calls.createMessage}` };
    },
  });

  const args = [
    "run", "--input", inputDir, "--manifest", manifestPath,
    "--guild", "guild-input-root", "--token", "fixture-token", "--yes", "--no-remote-check",
  ];
  await withArgv(args, () => cliMain({
    runtimeDir: path.join(root, "runtime"),
    apiFactory,
  }));

  const stagingRoot = path.join(inputDir, ".discord-post-tool-manifest-staging");
  await fs.access(stagingRoot);
  await withArgv(args, () => cliMain({
    runtimeDir: path.join(root, "runtime"),
    apiFactory,
  }));

  assert.deepEqual(
    createdChannels.map((channel) => channel.name),
    ["category", "sample"]
  );
  assert.equal(calls.createMessage, 1);
  const saved = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.deepEqual(Object.keys(saved.guilds), ["guild-input-root"]);
  assert.deepEqual(
    Object.keys(saved.guilds["guild-input-root"].categories),
    ["category"]
  );
  assert.deepEqual(
    Object.keys(saved.guilds["guild-input-root"].categories.category.groups),
    ["sample"]
  );
});

test("different manifests run concurrently in one runtime registry", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-artifacts-manifest-concurrent-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const inputDir = path.join(root, "input");
  await writeLegacyPair(path.join(inputDir, "category"));
  const manifestA = path.join(root, "a.json");
  const manifestB = `${manifestA}.tmp`;
  const runtimeDir = path.join(root, "shared-runtime");
  const cliPath = JSON.stringify(path.join(repoRoot, "src", "cli.js"));
  const childCode = `
    const fs = require("node:fs/promises");
    const fsSync = require("node:fs");
    const path = require("node:path");
    const { main } = require(${cliPath});
    const args = JSON.parse(process.env.DPT_ARGS);
    process.argv = [process.execPath, "cli", ...args];
    const guild = args[args.indexOf("--guild") + 1];
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let nextId = 0;
    (async () => {
      try {
        if (process.env.DPT_BARRIER_READY) {
          const originalRename = fs.rename;
          const manifestPath = path.resolve(process.env.DPT_MANIFEST).toLowerCase();
          let stopped = false;
          fs.rename = async (source, destination) => {
            const destinationPath = path.resolve(String(destination)).toLowerCase();
            if (!stopped && destinationPath === manifestPath) {
              stopped = true;
              await fs.writeFile(process.env.DPT_BARRIER_READY, "ready\\n");
              const deadline = Date.now() + 25000;
              while (!fsSync.existsSync(process.env.DPT_BARRIER_RESUME)) {
                if (Date.now() >= deadline) throw new Error("manifest barrier timed out");
                await delay(25);
              }
            }
            return originalRename(source, destination);
          };
        }

        await main({
          runtimeDir: process.env.DPT_RUNTIME_DIR,
          apiFactory: () => ({
            async getGuildChannels() {
              await delay(30);
              return [];
            },
            async createGuildChannel(_guildId, options) {
              await delay(10);
              const id = guild + "-" + (++nextId);
              return { id, name: options.name, type: options.type, parent_id: options.parent_id || null };
            },
            async createMessage() {
              await delay(10);
              return { id: guild + "-message" };
            },
          }),
        });
        if (process.env.DPT_BARRIER_DONE) {
          await fs.writeFile(process.env.DPT_BARRIER_DONE, "done\\n");
        }
      } catch (error) {
        console.error(error.stack || error.message);
        process.exitCode = 1;
      }
    })();
  `;
  const makeArgs = (manifest, guild) => [
    "run", "--input", inputDir, "--manifest", manifest, "--guild", guild,
    "--token", "fixture-token", "--yes", "--no-remote-check",
  ];
  const barrierReady = path.join(root, "a-ready");
  const barrierResume = path.join(root, "a-resume");
  const barrierDone = path.join(root, "b-done");
  let processA;
  let processB;
  let resultA;
  let resultB;
  try {
    processA = startNode(["-e", childCode], {
      DPT_ARGS: JSON.stringify(makeArgs(manifestA, "guild-concurrent-a")),
      DPT_RUNTIME_DIR: runtimeDir,
      DPT_MANIFEST: manifestA,
      DPT_BARRIER_READY: barrierReady,
      DPT_BARRIER_RESUME: barrierResume,
    }, 30000);
    await waitForFile(barrierReady, 25000);

    processB = startNode(["-e", childCode], {
      DPT_ARGS: JSON.stringify(makeArgs(manifestB, "guild-concurrent-b")),
      DPT_RUNTIME_DIR: runtimeDir,
      DPT_MANIFEST: manifestB,
      DPT_BARRIER_DONE: barrierDone,
    }, 30000);
    await waitForFile(barrierDone, 25000);

    await fs.writeFile(barrierResume, "resume\\n");
    [resultA, resultB] = await Promise.all([processA.done, processB.done]);
  } finally {
    if (processA) await processA.stop();
    if (processB) await processB.stop();
  }
  assert.equal(resultA.code, 0, resultA.stderr || resultA.stdout);
  assert.equal(resultB.code, 0, resultB.stderr || resultB.stdout);

  const savedA = JSON.parse(await fs.readFile(manifestA, "utf8"));
  const savedB = JSON.parse(await fs.readFile(manifestB, "utf8"));
  assert.deepEqual(Object.keys(savedA.guilds), ["guild-concurrent-a"]);
  assert.deepEqual(Object.keys(savedB.guilds), ["guild-concurrent-b"]);
});
