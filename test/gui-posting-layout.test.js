const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");

async function restoreRenderer(saved) {
  const html = await fs.readFile(path.join(ROOT, "src/gui/renderer/index.html"), "utf8");
  const inputs = [...html.matchAll(/<(input|select)\b([^>]*\bid="([^"]+)"[^>]*)>/g)].map(match => ({
    id: match[3],
    value: /\bvalue="([^"]*)"/.exec(match[2])?.[1] || "",
    type: /\btype="([^"]*)"/.exec(match[2])?.[1] || "select",
    checked: false,
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

function loadMainContext() {
  const context = vm.createContext({
    require: name => name === "electron" ? {
      app: {
        getPath: () => os.tmpdir(), setPath() {}, requestSingleInstanceLock: () => false,
        quit() {}, on() {}, whenReady: () => Promise.resolve(),
      },
    } : name === "./project-profile" ? {
      projectProfilePath: () => os.tmpdir(), migrateLocalStorage() {},
    } : name === "../discord-request" ? {} : require(name),
    __dirname: path.join(ROOT, "src/gui"),
    process: { argv: [], env: {} },
  });
  return fs.readFile(path.join(ROOT, "src/gui/main.js"), "utf8")
    .then(source => {
      vm.runInContext(source, context);
      return context;
    });
}

test("GUI defaults old saved settings to forum gallery once", async () => {
  const result = await restoreRenderer({
    assetProfileVersion: 4,
    assetPerformanceVersion: 1,
    postPostingLayout: "channels",
    postForumLayout: "list",
  });

  assert.equal(result.inputs.get("postPostingLayout").value, "forum");
  assert.equal(result.inputs.get("postForumLayout").value, "gallery");
  assert.equal(result.saved.postingProfileVersion, 1);
});

test("GUI preserves an explicit current posting layout and parent category", async () => {
  const result = await restoreRenderer({
    assetProfileVersion: 4,
    assetPerformanceVersion: 1,
    postingProfileVersion: 1,
    postPostingLayout: "channels",
    postForumLayout: "list",
    postForumParent: "123456789012345678",
  });

  assert.equal(result.inputs.get("postPostingLayout").value, "channels");
  assert.equal(result.inputs.get("postForumLayout").value, "list");
  assert.equal(result.inputs.get("postForumParent").value, "123456789012345678");
});

test("GUI passes forum layout options to both plan and run child commands", async () => {
  const context = await loadMainContext();
  for (const command of ["plan", "run"]) {
    const job = vm.runInContext(`buildPostJob(${JSON.stringify({
      command,
      inputDir: "optimized_webp_pdf",
      uploadMode: "auto",
      postingLayout: "forum",
      forumLayout: "gallery",
      forumParent: "123456789012345678",
    })})`, context);
    assert.deepEqual(Array.from(job.args.slice(job.args.indexOf("--posting-layout"))), [
      "--posting-layout", "forum",
      "--forum-layout", "gallery",
      "--forum-parent", "123456789012345678",
      ...(command === "run" ? ["--yes"] : []),
    ]);
    if (command === "plan") {
      assert.equal(job.args.includes("--yes"), false);
    } else {
      assert.equal(job.args.at(-1), "--yes");
    }
  }
});
