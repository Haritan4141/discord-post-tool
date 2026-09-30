const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sharp = require("sharp");
const { PDFDocument } = require("pdf-lib");
const { acquireResources, canonicalPath } = require("../src/runtime-locks");

const ROOT = path.resolve(__dirname, "..");
const WORKER = `
const fs = require("node:fs/promises");
const path = require("node:path");
const args = JSON.parse(process.argv[1]);
const send = (type, details = {}) => process.send({type, ...details});
const go = () => new Promise(resolve => process.once("message", resolve));
(async () => {
  if (args.action === "lock") {
    const {acquireResources} = require(path.join(args.root, "src/runtime-locks"));
    const release = await acquireResources(args.resources, {runtimeDir: args.runtimeDir});
    send("locked");
    await go();
    await release();
  } else if (args.action === "rate") {
    const {discordFetch} = require(path.join(args.root, "src/discord-request"));
    send("ready");
    await go();
    let call = 0;
    await discordFetch(args.token, "https://discord.com/api/v10/guilds/test", {}, {
      runtimeDir: args.runtimeDir, intervalMs: 0,
      fetch: async () => {
        send("fetch", {at: Date.now()});
        await new Promise(resolve => setTimeout(resolve, 75));
        const limited = args.limited && call++ === 0;
        return new Response(JSON.stringify(limited ? {retry_after: 0.4, global: true} : {}), {
          status: limited ? 429 : 200,
          headers: !limited && args.exhausted ? {
            "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "0.4"
          } : {}
        });
      }
    });
  } else if (args.action === "build") {
    process.argv = [process.execPath, "build-assets", "run", "--input", args.input,
      "--output", args.output, "--concurrency", "1"];
    await require(path.join(args.root, "src/build-assets")).main({runtimeDir: args.runtimeDir});
  } else if (args.action === "post") {
    process.env.DISCORD_BOT_TOKEN = "fixture-token-not-a-secret";
    process.env.DISCORD_GUILD_ID = args.guild;
    process.argv = [process.execPath, "cli", "run", "--input", args.input,
      "--manifest", args.manifest, "--yes"];
    const remoteFile = path.join(process.cwd(), "remote-" + args.guild + ".json");
    let remote = {channels: [], messages: [], sequence: 0};
    try { remote = JSON.parse(await fs.readFile(remoteFile, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const save = () => fs.writeFile(remoteFile, JSON.stringify(remote));
    const api = {
      getGuildChannels: async () => {
        send("api");
        if (args.hold) await go();
        return remote.channels;
      },
      createGuildChannel: async (_guild, payload) => {
        const channel = {id: String(++remote.sequence), ...payload};
        remote.channels.push(channel);
        await save();
        return channel;
      },
      getRecentMessages: async channelId => remote.messages.filter(m => m.channel_id === channelId),
      createMessage: async (channelId, payload, files) => {
        assertNoText(payload);
        const message = {id: String(++remote.sequence), channel_id: channelId,
          attachments: files.map(f => ({filename: f.name, size: f.size}))};
        remote.messages.push(message);
        await save();
        return message;
      }
    };
    function assertNoText(payload) {
      if (payload.content) throw new Error("Unexpected message text");
    }
    await require(path.join(args.root, "src/cli")).main({
      runtimeDir: args.runtimeDir, apiFactory: () => api
    });
  }
  send("done");
  process.disconnect();
})().catch(error => {
  send("error", {message: error.message});
  process.exitCode = 1;
  process.disconnect();
});
`;

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "discord-concurrency-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, runtimeDir: path.join(dir, "runtime") };
}

function worker(t, fixture, args) {
  const child = spawn(process.execPath, ["-e", WORKER, JSON.stringify({
    root: ROOT, runtimeDir: fixture.runtimeDir, ...args,
  })], { cwd: fixture.dir, stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
  const messages = [];
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.on("message", (message) => messages.push(message));
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
  });
  return {
    child, messages, exited,
    output: () => output,
    wait(type) {
      const found = messages.find((m) => m.type === type || m.type === "error");
      if (found) return found.type === "error" ? Promise.reject(new Error(found.message)) : Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error(`Timeout waiting for ${type}: ${output}`)), 10000);
        const listener = (message) => {
          if (message.type === type) finish(null, message);
          else if (message.type === "error") finish(new Error(message.message));
        };
        function finish(error, value) {
          clearTimeout(timer);
          child.off("message", listener);
          if (error) reject(error); else resolve(value);
        }
        child.on("message", listener);
      });
    },
  };
}

const resource = (file, mode = "write") => ({ type: "path", path: file, mode });

test("directory leases reject overlapping writers and allow independent outputs/readers", async (t) => {
  const f = await fixture(t);
  const output = path.join(f.dir, "output");
  const release = await acquireResources([resource(output)], f);
  await assert.rejects(acquireResources([resource(path.join(output, "category"), "read")], f), /使用中/);
  await assert.rejects(acquireResources([resource(f.dir)], f), /使用中/);
  const independent = await acquireResources([resource(`${output}-other`)], f);
  await independent();
  await release();
  const reader1 = await acquireResources([resource(output, "read")], f);
  const reader2 = await acquireResources([resource(output, "read")], f);
  await assert.rejects(acquireResources([resource(output)], f), /使用中/);
  await reader1();
  await reader2();
});

test("junction/real paths share leases, including missing descendant paths", async (t) => {
  const f = await fixture(t);
  const real = path.join(f.dir, "real");
  const alias = path.join(f.dir, "alias");
  await fs.mkdir(real);
  await fs.symlink(real, alias, process.platform === "win32" ? "junction" : "dir");
  assert.equal(await canonicalPath(path.join(real, "missing")), await canonicalPath(path.join(alias, "missing")));
  const release = await acquireResources([resource(real)], f);
  await assert.rejects(acquireResources([resource(path.join(alias, "missing"))], f), /使用中/);
  await release();
});

test("a killed process releases its job lease on the next attempt", async (t) => {
  const f = await fixture(t);
  const resources = [resource(path.join(f.dir, "output"))];
  const owner = worker(t, f, { action: "lock", resources });
  await owner.wait("locked");
  await assert.rejects(acquireResources(resources, f), /使用中/);
  owner.child.kill("SIGKILL");
  await owner.exited;
  const release = await acquireResources(resources, f);
  await release();
});

test("only one of two simultaneous processes can own the same output", async (t) => {
  const f = await fixture(t);
  const resources = [resource(path.join(f.dir, "output"))];
  const a = worker(t, f, { action: "lock", resources });
  const b = worker(t, f, { action: "lock", resources });
  const results = await Promise.allSettled([a.wait("locked"), b.wait("locked")]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected");
  assert.match(rejected.reason.message, /使用中/);
  for (const w of [a, b]) if (w.messages.some((m) => m.type === "locked")) w.child.send("release");
  await Promise.all([a.exited, b.exited]);
});

async function imageInput(f) {
  const input = path.join(f.dir, "input");
  const images = path.join(input, "category", "sample_png");
  await fs.mkdir(images, { recursive: true });
  await sharp({ create: { width: 64, height: 80, channels: 3, background: "#507b62" } })
    .png().toFile(path.join(images, "001.png"));
  return input;
}

test("two real conversions can use independent output folders", async (t) => {
  const f = await fixture(t);
  const input = await imageInput(f);
  const a = worker(t, f, { action: "build", input, output: path.join(f.dir, "a") });
  const b = worker(t, f, { action: "build", input, output: path.join(f.dir, "b") });
  for (const w of [a, b]) assert.equal(await w.exited, 0, w.output());
  for (const name of ["a", "b"]) {
    const bytes = await fs.readFile(path.join(f.dir, name, "category", "sample.pdf"));
    assert.equal((await PDFDocument.load(bytes)).getPageCount(), 1);
  }
});

test("conversion refuses to overwrite input held by posting, and posting refuses an active conversion", async (t) => {
  const f = await fixture(t);
  const input = await imageInput(f);
  const output = path.join(f.dir, "output");
  let release = await acquireResources([resource(output, "read")], f);
  const build = worker(t, f, { action: "build", input, output });
  assert.equal(await build.exited, 1);
  assert.match(build.messages.find(m => m.type === "error").message, /使用中/);
  await release();
  release = await acquireResources([resource(output)], f);
  const post = worker(t, f, { action: "post", input: output, guild: "1", manifest: path.join(f.dir, "manifest.json") });
  assert.equal(await post.exited, 1);
  assert.equal(post.messages.some(m => m.type === "api"), false);
  assert.match(post.messages.find(m => m.type === "error").message, /使用中/);
  await release();
});

async function postInput(f) {
  const input = path.join(f.dir, "post-input");
  const category = path.join(input, "category");
  await fs.mkdir(category, { recursive: true });
  for (const name of ["sample_1-50.zip", "sample_1-50.pdf", "sample_51-100.zip", "sample_51-100.pdf"]) {
    await fs.writeFile(path.join(category, name), "fixture");
  }
  return input;
}

test("same Guild posting stops before the API; different Guilds run and reuse four attachments", async (t) => {
  const f = await fixture(t);
  const input = await postInput(f);
  const base = { action: "post", input, hold: true };
  const manifestA = path.join(f.dir, "a.json");
  const a = worker(t, f, { ...base, guild: "1", manifest: manifestA });
  await a.wait("api");
  const same = worker(t, f, { ...base, guild: "1", manifest: path.join(f.dir, "duplicate.json") });
  assert.equal(await same.exited, 1);
  assert.equal(same.messages.some(m => m.type === "api"), false);
  assert.match(same.messages.find(m => m.type === "error").message, /サーバー 1/);
  const sameManifest = worker(t, f, { ...base, guild: "2", manifest: manifestA });
  assert.equal(await sameManifest.exited, 1);
  assert.equal(sameManifest.messages.some(m => m.type === "api"), false);
  const b = worker(t, f, { ...base, guild: "2", manifest: path.join(f.dir, "b.json") });
  await b.wait("api");
  a.child.send("go");
  b.child.send("go");
  for (const w of [a, b]) assert.equal(await w.exited, 0, w.output());
  for (const guild of ["1", "2"]) {
    const remote = JSON.parse(await fs.readFile(path.join(f.dir, `remote-${guild}.json`), "utf8"));
    assert.equal(remote.channels.filter(c => c.type === 0).length, 1);
    assert.equal(remote.messages.length, 1);
    assert.equal(remote.messages[0].attachments.length, 4);
  }
  const resumed = worker(t, f, { action: "post", input, guild: "1", manifest: manifestA });
  assert.equal(await resumed.exited, 0, resumed.output());
  assert.match(resumed.output(), /files already posted/);
  const remote = JSON.parse(await fs.readFile(path.join(f.dir, "remote-1.json"), "utf8"));
  assert.equal(remote.messages.length, 1);
});

test("same Bot requests serialize across processes and share 429/header cooldowns", async (t) => {
  for (const kind of ["limited", "exhausted"]) {
    const f = await fixture(t);
    const a = worker(t, f, { action: "rate", token: "fixture-shared-token", [kind]: true });
    const b = worker(t, f, { action: "rate", token: "fixture-shared-token" });
    await Promise.all([a.wait("ready"), b.wait("ready")]);
    a.child.send("go");
    const first = await a.wait("fetch");
    b.child.send("go");
    for (const w of [a, b]) assert.equal(await w.exited, 0, w.output());
    const later = [...a.messages, ...b.messages].filter(m => m.type === "fetch" && m.at !== first.at);
    assert.ok(later.every(m => m.at - first.at >= 475));
    assert.equal(a.messages.filter(m => m.type === "fetch").length, kind === "limited" ? 2 : 1);
    const botDirs = await fs.readdir(path.join(f.runtimeDir, "bots"));
    assert.equal(botDirs.length, 1);
    assert.match(botDirs[0], /^[0-9a-f]{64}$/);
    const state = await fs.readFile(path.join(f.runtimeDir, "bots", botDirs[0], "rate.json"), "utf8");
    assert.equal(state.includes("fixture-shared-token"), false);
  }
});
