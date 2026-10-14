const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const { buildLocalPlan } = require(path.join(ROOT, "src", "cli.js"));

const planOptions = (overrides = {}) => ({
  categoryFilter: null,
  limit: null,
  maxFileBytes: 1024 * 1024,
  maxRequestBytes: 4 * 1024 * 1024,
  postingLayout: "forum",
  ...overrides,
});

async function writePair(directory, name = "作品") {
  await fs.mkdir(directory, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(directory, `${name}.zip`), "zip"),
    fs.writeFile(path.join(directory, `${name}.pdf`), "pdf"),
    fs.writeFile(path.join(directory, `${name}.assets.json`), "{}"),
  ]);
}

test("buildLocalPlan reads category/forum/work nesting and keeps duplicate forum names separate", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-post-tool-nested-plan-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await writePair(path.join(root, "10月作品", "限定作品1014"), "作品A");
  await fs.mkdir(path.join(root, "10月作品", "限定作品1014", "作品A_jpg"), { recursive: true });
  await fs.writeFile(path.join(root, "10月作品", "限定作品1014", "作品A_jpg", "preview.jpg"), "preview");
  await writePair(path.join(root, "10月作品", "限定作品1015"), "作品B");
  await fs.mkdir(path.join(root, "10月作品", "空のフォーラム"), { recursive: true });
  await fs.writeFile(path.join(root, "10月作品", "空のフォーラム", "Thumbs.db"), "thumbnail cache");
  await writePair(path.join(root, "別サーバー", "限定作品1014"), "作品C");
  await writePair(path.join(root, "別サーバー", "forum_jpg"), "作品D");

  const plan = await buildLocalPlan(root, planOptions());
  assert.equal(plan.hasNestedLayout, true);
  assert.deepEqual(
    plan.categories.map((category) => ({
      parentName: category.parentName,
      name: category.name,
      path: path.relative(root, category.path),
      groups: category.groups.map((group) => group.baseName),
    })),
    [
      { parentName: "別サーバー", name: "限定作品1014", path: "別サーバー\\限定作品1014", groups: ["作品C"] },
      { parentName: "別サーバー", name: "forum_jpg", path: "別サーバー\\forum_jpg", groups: ["作品D"] },
      { parentName: "10月作品", name: "限定作品1014", path: "10月作品\\限定作品1014", groups: ["作品A"] },
      { parentName: "10月作品", name: "限定作品1015", path: "10月作品\\限定作品1015", groups: ["作品B"] },
    ].sort((a, b) => `${a.parentName}/${a.name}`.localeCompare(`${b.parentName}/${b.name}`, "ja")),
  );
  assert.equal(plan.totals.parentCategories, 2);
  assert.equal(plan.totals.forums, 4);
  assert.equal(plan.totals.groups, 4);
  assert.equal(plan.categories.some((category) => category.name === "空のフォーラム"), false);

  const filtered = await buildLocalPlan(root, planOptions({ categoryFilter: "10月作品" }));
  assert.deepEqual(filtered.categories.map((category) => category.name), ["限定作品1014", "限定作品1015"]);
  assert.ok(filtered.categories.every((category) => category.parentName === "10月作品"));

  const limited = await buildLocalPlan(root, planOptions({ categoryFilter: "10月作品", limit: 1 }));
  assert.equal(limited.categories.length, 1);
  assert.equal(limited.categories[0].groups.length, 1);
  assert.equal(limited.totals.parentCategories, 1);
  assert.equal(limited.totals.forums, 1);
});

test("buildLocalPlan keeps the old flat output layout compatible", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-post-tool-flat-plan-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writePair(path.join(root, "限定作品1014"), "作品A");
  await fs.writeFile(path.join(root, "限定作品1014", "Thumbs.db"), "thumbnail cache");
  await fs.writeFile(path.join(root, "限定作品1014", "desktop.ini"), "folder metadata");
  await fs.writeFile(path.join(root, "限定作品1014", "README.txt"), "kept sidecar");
  await fs.writeFile(path.join(root, "限定作品1014", "preview.gif"), "unsupported preview");

  const plan = await buildLocalPlan(root, planOptions());
  assert.equal(plan.hasNestedLayout, false);
  assert.equal(plan.categories.length, 1);
  assert.equal(plan.categories[0].name, "限定作品1014");
  assert.equal(plan.categories[0].parentName, undefined);
  assert.equal(plan.categories[0].groups[0].baseName, "作品A");
  assert.ok(plan.categories[0].warnings.some((warning) => /README\.txt/.test(warning)));
  assert.ok(plan.categories[0].warnings.some((warning) => /preview\.gif/.test(warning)));
});

test("empty old categories are omitted while incomplete generated metadata still stops", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-post-tool-empty-plan-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "空カテゴリ"), { recursive: true });
  await fs.mkdir(path.join(root, "README-only"), { recursive: true });
  await fs.writeFile(path.join(root, "README-only", "README.txt"), "sidecar");

  const emptyPlan = await buildLocalPlan(root, planOptions());
  assert.equal(emptyPlan.categories.length, 0);
  assert.ok(emptyPlan.warnings.some((warning) => /README\.txt/.test(warning)));

  await fs.mkdir(path.join(root, "未完了"), { recursive: true });
  await fs.writeFile(path.join(root, "未完了", "作品.assets.json"), "{}");
  await assert.rejects(
    buildLocalPlan(root, planOptions()),
    /generated profile\/pending metadata exists without its ZIP\/PDF output/,
  );
});

test("mixed or deeper layouts and raw images stop planning instead of being skipped", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-post-tool-invalid-plan-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  await writePair(path.join(root, "混在"), "作品");
  await writePair(path.join(root, "混在", "別フォーラム"), "別作品");
  await assert.rejects(
    buildLocalPlan(root, planOptions()),
    /shallow and nested category\/forum layouts are mixed/,
  );

  await fs.rm(path.join(root, "混在", "別フォーラム"), { recursive: true, force: true });
  await fs.rm(path.join(root, "混在", "作品.zip"));
  await fs.rm(path.join(root, "混在", "作品.pdf"));
  await fs.rm(path.join(root, "混在", "作品.assets.json"));
  await fs.writeFile(path.join(root, "混在", "raw.png"), "raw");
  await assert.rejects(buildLocalPlan(root, planOptions()), /raw input images were found/);

  await fs.rm(path.join(root, "混在", "raw.png"));
  await fs.mkdir(path.join(root, "混在", "フォーラム", "作品"), { recursive: true });
  await writePair(path.join(root, "混在", "フォーラム", "作品"), "深すぎる");
  await assert.rejects(buildLocalPlan(root, planOptions()), /category\/forum layout is deeper than supported/);
});

test("legacy channels layout and explicit forum parent reject nested output", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-post-tool-nested-cli-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await writePair(path.join(root, "カテゴリ", "フォーラム"), "作品");

  for (const args of [
    ["--posting-layout", "channels"],
    ["--forum-parent", "123456789012345678"],
  ]) {
    const result = spawnSync(process.execPath, [path.join(ROOT, "src", "cli.js"), "plan", "--input", root, ...args], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0, `${args.join(" ")} unexpectedly succeeded`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /category\/forum folder layout|category\/forum folder layout requires/);
  }
});
