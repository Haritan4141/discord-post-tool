const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { AsyncLocalStorage } = require("node:async_hooks");
const { getProcessIdentity, ownerStates } = require("./process-identity");

const mutexContext = new AsyncLocalStorage();
const failedReleases = new Map();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const claimName = /^[0-9a-f-]{36}\.json$/;

function runtimeDirectory() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), ".cache");
  return path.join(base, "discord-post-tool", "runtime-v1");
}

async function removeClaim(file) {
  for (let attempt = 0; ; attempt += 1) {
    try { await fs.unlink(file); return; }
    catch (error) {
      if (error.code === "ENOENT") return;
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 5) throw error;
      await sleep(50);
    }
  }
}

async function renameClaim(source, destination) {
  // Windows can temporarily deny replacement while another handle is open.
  // Keep the choosing claim visible throughout retries; never unlink to replace.
  for (let attempt = 0; ; attempt += 1) {
    try { await fs.rename(source, destination); return; }
    catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || attempt >= 20) throw error;
      await sleep(100);
    }
  }
}

async function publishClaim(file, claim, first = false, onPublished) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, JSON.stringify(claim), { flag: "wx", mode: 0o600 });
    // Initial publication is exclusive and complete; never expose an empty owner.
    if (first) await fs.link(temporary, file);
    else await renameClaim(temporary, file);
    onPublished?.();
  } finally { await removeClaim(temporary); }
}

async function readClaims(directory) {
  const claims = [];
  for (const name of await fs.readdir(directory)) {
    if (!claimName.test(name)) continue;
    let claim;
    try { claim = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (name !== `${claim.id}.json` || !Number.isInteger(claim.pid) || claim.pid <= 0 ||
        typeof claim.processIdentity !== "string" || !claim.processIdentity ||
        !(claim.ticket === null || (Number.isSafeInteger(claim.ticket) && claim.ticket > 0))) {
      throw new Error("内部ロックの所有者情報が不正です。安全のため停止しました。");
    }
    claims.push(claim);
  }
  const states = await ownerStates(claims);
  const active = [];
  for (let index = 0; index < claims.length; index += 1) {
    const claim = claims[index];
    if (states[index] === "dead") await removeClaim(path.join(directory, `${claim.id}.json`));
    else active.push(claim);
  }
  return active;
}

async function withFileMutex(file, action, timeoutMs = 180000) {
  const key = await canonicalPath(file);
  if (mutexContext.getStore()?.has(key)) {
    throw Object.assign(new Error("同じ内部ロックの再帰取得はできません。"), { code: "EDEADLOCK" });
  }
  const cleanupError = (cause) => Object.assign(new Error(
    "内部ロックを解放できませんでした。処理を停止し、アクセスできることを確認してアプリを再起動してください。",
    { cause }), { code: "ELOCKCLEANUP" });
  const cleanupFailedClaims = async () => {
    const failures = failedReleases.get(key);
    if (!failures) return;
    for (const orphan of failures) {
      try { await removeClaim(orphan); failures.delete(orphan); }
      catch (error) { throw cleanupError(error); }
    }
    if (failures.size === 0 && failedReleases.get(key) === failures) failedReleases.delete(key);
  };
  await cleanupFailedClaims();
  const directory = `${key}.mutex-v2`;
  await fs.mkdir(directory, { recursive: true });
  const claim = { id: crypto.randomUUID(), pid: process.pid,
    processIdentity: await getProcessIdentity(), ticket: null };
  const ownFile = path.join(directory, `${claim.id}.json`);
  const started = Date.now();
  let published = false;
  try {
    await publishClaim(ownFile, claim, true, () => { published = true; });
    const existing = await readClaims(directory);
    claim.ticket = Math.max(0, ...existing.map((entry) => entry.ticket || 0)) + 1;
    if (!Number.isSafeInteger(claim.ticket)) throw new Error("内部ロック番号の上限に達しました。");
    await publishClaim(ownFile, claim);

    // Bakery ordering: paused live owners keep their UUID claim, without expiry.
    // Unique files mean a release/reclaim cannot delete a successor's claim.
    while (true) {
      await cleanupFailedClaims();
      if (Date.now() - started >= timeoutMs) {
        throw Object.assign(new Error("別の処理の内部ロック解放を待ち切れませんでした。完了後に再実行してください。"),
          { code: "ELOCKED" });
      }
      const active = await readClaims(directory);
      const own = active.find((entry) => entry.id === claim.id);
      if (!own || own.ticket !== claim.ticket || own.processIdentity !== claim.processIdentity) {
        throw new Error("内部ロックの所有権を確認できないため停止しました。");
      }
      const waiting = active.some((entry) => entry.id !== claim.id &&
        (entry.ticket === null || entry.ticket < claim.ticket ||
          (entry.ticket === claim.ticket && entry.id < claim.id)));
      if (!waiting && Date.now() - started < timeoutMs) break;
      await sleep(75 + Math.floor(Math.random() * 75));
    }
    // Sequential timeout checks end at admission; no timer can delete an owner.
    const context = new Set(mutexContext.getStore() || []);
    context.add(key);
    return await mutexContext.run(context, action);
  } finally {
    if (published) {
      try { await removeClaim(ownFile); }
      catch (error) {
        if (!failedReleases.has(key)) failedReleases.set(key, new Set());
        failedReleases.get(key).add(ownFile);
        throw cleanupError(error);
      }
    }
  }
}

async function canonicalPath(value) {
  let current = path.resolve(value);
  const missing = [];
  while (true) {
    try { current = path.join(await fs.realpath(current), ...missing.reverse()); break; }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
  return process.platform === "win32" ? current.toLowerCase() : current;
}

function pathsOverlap(a, b) {
  const inside = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." && !path.isAbsolute(relative));
  };
  return inside(a, b) || inside(b, a);
}

function conflicts(a, b) {
  if (a.type === "guild" || b.type === "guild") return a.type === b.type && a.key === b.key;
  return (a.mode === "write" || b.mode === "write") && pathsOverlap(a.path, b.path);
}

async function assertSafePathTree(value, allowRootLink = true) {
  let entry;
  try { entry = await fs.lstat(value); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  const stat = await fs.stat(value);
  if (entry.isSymbolicLink() && (!allowRootLink || !stat.isDirectory())) {
    throw new Error(`Junction/シンボリックリンクは安全に保護できないため停止しました: ${value}`);
  }
  if (!stat.isDirectory()) return;
  for (const child of await fs.readdir(value, { withFileTypes: true })) {
    const target = path.join(value, child.name);
    if (child.isSymbolicLink()) {
      throw new Error(`フォルダ配下のJunction/シンボリックリンクは安全に保護できないため停止しました: ${target}`);
    }
    if (child.isDirectory()) await assertSafePathTree(target, false);
  }
}

async function acquireResources(resources, options = {}) {
  const root = options.runtimeDir || runtimeDirectory();
  const leasesDir = path.join(root, "jobs");
  const normalized = await Promise.all(resources.map(async (resource) => {
    if (resource.type === "guild") {
      if (typeof resource.key !== "string" || !resource.key.trim()) throw new Error("Invalid Guild key");
      return { type: "guild", key: resource.key.trim() };
    }
    if (resource.type !== "path") throw new Error("Invalid resource type");
    if (!["read", "write"].includes(resource.mode)) throw new Error("Invalid resource mode");
    return { type: "path", path: await canonicalPath(resource.path), mode: resource.mode };
  }));
  const id = crypto.randomUUID();
  const leasePath = path.join(leasesDir, `${id}.json`);
  const lease = { id, pid: process.pid, processIdentity: await getProcessIdentity(),
    label: options.label || "処理", project: process.cwd(), resources: normalized };

  await withFileMutex(path.join(root, "jobs-registry"), async () => {
    await fs.mkdir(leasesDir, { recursive: true });
    const entries = [];
    for (const name of await fs.readdir(leasesDir)) {
      if (!name.endsWith(".json")) continue;
      const existing = JSON.parse(await fs.readFile(path.join(leasesDir, name), "utf8"));
      if (!Number.isInteger(existing.pid) || existing.pid <= 0 || !Array.isArray(existing.resources) ||
          (existing.processIdentity !== undefined &&
            (typeof existing.processIdentity !== "string" || !existing.processIdentity)) ||
          !existing.resources.every((resource) => resource &&
            (resource.type === "guild"
              ? typeof resource.key === "string" && resource.key.length > 0
              : resource.type === "path" && typeof resource.path === "string" &&
                path.isAbsolute(resource.path) && ["read", "write"].includes(resource.mode)))) {
        throw new Error("実行中処理の管理情報が不正です。安全のため停止しました。");
      }
      entries.push({ name, existing });
    }
    const states = await ownerStates(entries.map((entry) => entry.existing));
    for (let index = 0; index < entries.length; index += 1) {
      const { name, existing } = entries[index];
      if (states[index] === "dead") { await fs.unlink(path.join(leasesDir, name)); continue; }
      const conflict = normalized.find((a) => existing.resources.some((b) => conflicts(a, b)));
      if (conflict) {
        const target = conflict.type === "guild" ? `サーバー ${conflict.key}` : conflict.path;
        throw new Error(`同じ対象を別の処理が使用中のため停止しました: ${target}\n` +
          `${existing.label} / PID ${existing.pid} / ${existing.project}\nその処理の完了後に再実行してください。`);
      }
    }
    const temporary = `${leasePath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(lease), { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, leasePath);
  });

  let released = false;
  const release = async () => {
    if (released) return;
    await withFileMutex(path.join(root, "jobs-registry"), async () => { await removeClaim(leasePath); });
    released = true;
  };
  try {
    // Hold roots while checking; corresponding writers never introduce links.
    for (const resource of resources) {
      if (resource.type !== "guild") await assertSafePathTree(path.resolve(resource.path));
    }
  } catch (error) { await release(); throw error; }
  return release;
}

async function withResources(resources, action, options) {
  const release = await acquireResources(resources, options);
  try { return await action(); }
  finally { await release(); }
}

module.exports = { runtimeDirectory, withFileMutex, canonicalPath, acquireResources, withResources };
