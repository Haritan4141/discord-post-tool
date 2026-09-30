const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { projectProfilePath, migrateLocalStorage } = require("../src/gui/project-profile");

test("project profiles isolate session/cache paths and copy legacy settings only once", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "discord-profiles-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const legacy = path.join(dir, "legacy");
  const projects = [path.join(dir, "a"), path.join(dir, "b")];
  for (const project of projects) fs.mkdirSync(project);
  const profiles = projects.map(project => projectProfilePath(project, legacy));
  assert.notEqual(profiles[0], profiles[1]);
  const alias = path.join(dir, "alias");
  fs.symlinkSync(projects[0], alias, process.platform === "win32" ? "junction" : "dir");
  assert.equal(projectProfilePath(alias, legacy), profiles[0]);
  fs.mkdirSync(path.join(legacy, "Local Storage", "leveldb"), { recursive: true });
  fs.mkdirSync(path.join(legacy, "GPUCache"));
  fs.writeFileSync(path.join(legacy, "Local Storage", "leveldb", "fixture"), "old state");
  fs.writeFileSync(path.join(legacy, "GPUCache", "fixture"), "old cache");
  for (const profile of profiles) {
    fs.mkdirSync(profile, { recursive: true });
    assert.equal(migrateLocalStorage(legacy, profile), true);
    const saved = path.join(profile, "Local Storage", "leveldb", "fixture");
    assert.equal(fs.readFileSync(saved, "utf8"), "old state");
    assert.equal(fs.existsSync(path.join(profile, "GPUCache")), false);
    fs.writeFileSync(saved, "new state");
    assert.equal(migrateLocalStorage(legacy, profile), false);
    assert.equal(fs.readFileSync(saved, "utf8"), "new state");
  }
  assert.equal(fs.readFileSync(path.join(legacy, "Local Storage", "leveldb", "fixture"), "utf8"), "old state");
});
