const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sharp = require("sharp");
const { main: buildMain } = require("../src/build-assets");
const { main: postMain } = require("../src/cli");
const { acquireResources } = require("../src/runtime-locks");

async function withArgv(args, action) {
  const previous = process.argv;
  process.argv = [process.execPath, "fixture-cli", ...args];
  try { return await action(); }
  finally { process.argv = previous; }
}

test("conversion and posting stop before touching a nested Junction target", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "discord-path-safety-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, "images"), output = path.join(dir, "output");
  const target = path.join(dir, "target"), runtimeDir = path.join(dir, "runtime");
  await fs.mkdir(path.join(input, "sample"), { recursive: true });
  await fs.writeFile(path.join(input, "sample", "one.png"), await sharp({
    create: { width: 32, height: 32, channels: 3, background: "#345678" },
  }).png().toBuffer());
  await fs.mkdir(output); await fs.mkdir(target);
  await fs.symlink(target, path.join(output, "カテゴリ1"),
    process.platform === "win32" ? "junction" : "dir");
  const release = await acquireResources([{ type: "path", path: target, mode: "read" }], { runtimeDir });
  try {
    await assert.rejects(withArgv([
      "run", "--input", input, "--output", output, "--concurrency", "1",
    ], () => buildMain({ runtimeDir })), /配下のJunction/);
    assert.deepEqual(await fs.readdir(target), []);
    assert.equal((await fs.readdir(path.join(runtimeDir, "jobs"))).length, 1);
  } finally { await release(); }

  await fs.writeFile(path.join(target, "sample.zip"), "fixture zip");
  await fs.writeFile(path.join(target, "sample.pdf"), "fixture pdf");
  let apiClients = 0;
  await assert.rejects(withArgv([
    "run", "--input", output, "--manifest", path.join(dir, "manifest.json"),
    "--guild", "fixture-guild", "--token", "fixture-token", "--yes",
  ], () => postMain({ runtimeDir, apiFactory: () => { apiClients += 1; throw new Error("unexpected API client"); } })),
  /配下のJunction/);
  assert.equal(apiClients, 0);
  assert.deepEqual(await fs.readdir(path.join(runtimeDir, "jobs")), []);
  assert.deepEqual((await fs.readdir(target)).sort(), ["sample.pdf", "sample.zip"]);
});
