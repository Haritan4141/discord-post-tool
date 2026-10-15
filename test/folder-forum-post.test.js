const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sharp = require("sharp");
const yazl = require("yazl");
const { spawnSync } = require("node:child_process");
const { main } = require("../src/cli");
const { folderCategory, groupManifest } = require("../src/forum-folders");

const permissions = String(16n | 1024n | 2048n | 32768n | 65536n | (1n << 38n));

async function imageZip(count) {
  const archive = new yazl.ZipFile();
  const chunks = [];
  const done = new Promise((resolve, reject) => {
    archive.outputStream.on("data", chunk => chunks.push(chunk));
    archive.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    archive.outputStream.on("error", reject);
  });
  for (let i = 1; i <= count; i++) {
    archive.addBuffer(await sharp({ create: { width: 16, height: 16, channels: 3,
      background: { r: i, g: i % 30, b: 80 } } }).webp().toBuffer(), `${i}.webp`);
  }
  archive.end(); return done;
}

async function fixture(t, count = 1) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "discord-folder-forum-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, "input"), manifest = path.join(dir, "manifest.json");
  const zip = await imageZip(count);
  async function add(parent = "20261014", forum = "forum", work = "work") {
    const target = path.join(input, parent, forum); await fs.mkdir(target, { recursive: true });
    await fs.writeFile(path.join(target, `${work}.zip`), zip);
    await fs.writeFile(path.join(target, `${work}.pdf`), "%PDF-test");
  }
  await add();
  const state = { channels: [], threads: [], messages: [], sequence: 1000, creates: [], failure: null, permissions };
  const id = () => String(++state.sequence);
  function message(channelId, payload, files, messageId = id()) {
    assert.equal(payload.content, undefined);
    const result = { id: messageId, channel_id: channelId, author: { id: "901" }, nonce: payload.nonce, flags: payload.flags,
      attachments: files.map(f => ({ id: id(), filename: f.name, size: f.size })) };
    state.messages.push(result); return result;
  }
  const api = {
    getGuildChannels: async () => structuredClone(state.channels),
    async createGuildChannel(guildId, payload) {
      if (payload.type === 4 && state.failure === "category-before") {
        state.failure = null; throw new Error("category outcome unknown");
      }
      if (payload.type === 4 && state.failure === "category-403") {
        state.failure = null; throw Object.assign(new Error("category 403"), { status: 403 });
      }
      const result = { ...structuredClone(payload), id: id(), guild_id: guildId };
      state.channels.push(result); state.creates.push(result);
      if (payload.type === 4 && state.failure === "category-after") {
        state.failure = null; throw new Error("lost category response");
      }
      if (payload.type === 15 && state.failure === "forum-after") {
        state.failure = null; throw new Error("lost forum response");
      }
      if (payload.type === 15 && state.forumResponseOverrides) {
        const overrides = state.forumResponseOverrides; state.forumResponseOverrides = null;
        return { ...result, ...overrides };
      }
      return result;
    },
    async createForumThread(forumId, payload, files) {
      if (state.failure === "thread-before" || state.failure === "thread-403") {
        const failure = state.failure; state.failure = null;
        throw Object.assign(new Error(failure), failure === "thread-403" ? { status: 403 } : {});
      }
      const thread = { id: id(), guild_id: "900", parent_id: forumId, name: payload.name, type: 11,
        thread_metadata: { archived: false, locked: false } };
      state.threads.push(thread); thread.message = message(thread.id, payload.message, files, thread.id);
      if (state.failure === "thread-after") { state.failure = null; throw new Error("lost starter response"); }
      if (state.threadResponseTransform) {
        const transform = state.threadResponseTransform; state.threadResponseTransform = null;
        return transform(thread);
      }
      return thread;
    },
    async createMessage(channelId, payload, files) { return message(channelId, payload, files); },
    async getRecentMessages(channelId, limit = 100, before) {
      return state.messages.filter(m => m.channel_id === channelId && (!before || BigInt(m.id) < BigInt(before)))
        .sort((a, b) => Number(b.id) - Number(a.id)).slice(0, limit);
    },
    async request(method, route) {
      assert.equal(method, "GET");
      if (route === "/guilds/900") return { id: "900", features: ["COMMUNITY"], roles: [{ id: "900", permissions: state.permissions }] };
      if (route === "/users/@me") return { id: "901" };
      if (route === "/guilds/900/members/901") return { roles: [] };
      if (route === "/guilds/900/threads/active") return { threads: state.threads.filter(t => !t.thread_metadata?.archived) };
      if (route.includes("/threads/archived/public")) return { threads: state.threads.filter(t => t.thread_metadata?.archived && t.parent_id === route.split("/")[2]), has_more: false };
      const parts = route.split("/");
      if (parts[3] === "messages") return state.messages.find(m => m.id === parts[4] && m.channel_id === parts[2]);
      const channel = [...state.threads, ...state.channels].find(c => c.id === parts[2]);
      if (channel) return channel;
      throw Object.assign(new Error("404"), { status: 404 });
    },
  };
  async function run(extra = []) {
    const old = process.argv;
    process.argv = [process.execPath, "cli", "run", "--input", input, "--guild", "900", "--token", "fake-fixture",
      "--manifest", manifest, "--yes", ...extra];
    try { await main({ apiFactory: () => api, runtimeDir: path.join(dir, "runtime") }); }
    finally { process.argv = old; }
  }
  return { dir, input, manifest, add, state, api, run, saved: async () => JSON.parse(await fs.readFile(manifest, "utf8")) };
}

test("nested folders create a public category and two child forums; 100 images precede archives and reruns skip", async t => {
  const f = await fixture(t, 100); await f.add("20261014", "forum2");
  // Forum posts require SEND_MESSAGES; CREATE_PUBLIC_THREADS is ignored by
  // this endpoint and intentionally absent from the fixture's role permissions.
  assert.equal(BigInt(f.state.permissions) & (1n << 35n), 0n);
  // An unrelated private operations channel does not define the new category's visibility.
  f.state.channels.push({ id: "10", type: 0, name: "ops", permission_overwrites: [{ id: "900", type: 0, deny: "1024", allow: "0" }] });
  await f.run();
  assert.deepEqual(f.state.creates.map(c => c.type), [4, 15, 15]);
  const parent = f.state.creates[0];
  assert.deepEqual(parent.permission_overwrites, [{ id: "900", type: 0, allow: "1024", deny: "0" }]);
  for (const forum of f.state.creates.slice(1)) {
    assert.equal(forum.parent_id, parent.id); assert.equal(forum.nsfw, true);
    assert.deepEqual(forum.permission_overwrites, parent.permission_overwrites);
  }
  for (const thread of f.state.threads) {
    const messages = f.state.messages.filter(m => m.channel_id === thread.id);
    assert.deepEqual(messages.map(m => m.flags), [0, ...Array(10).fill(4096)]);
    assert.deepEqual(messages.map(m => m.attachments.length), [...Array(10).fill(10), 2]);
    assert.equal(new Set(messages.slice(0, 10).flatMap(m => m.attachments.map(a => a.filename))).size, 100);
    assert.deepEqual(messages.at(-1).attachments.map(a => a.filename), ["work.zip", "work.pdf"]);
  }
  const journal = await f.saved(); assert.ok(journal.guilds["900"].folderCategories["20261014"].forums.forum.groups.work.forum.threadId);
  const ids = f.state.messages.map(m => m.id); await f.run();
  assert.deepEqual(f.state.messages.map(m => m.id), ids); assert.equal(f.state.creates.length, 3);
});

test("same forum/work names in separate categories have independent journals and threads", async t => {
  const f = await fixture(t); await f.add("20261015"); await f.run();
  assert.equal(f.state.creates.filter(c => c.type === 4).length, 2);
  assert.equal(f.state.threads.length, 2);
  const saved = await f.saved(), categories = saved.guilds["900"].folderCategories;
  assert.notEqual(categories["20261014"].forums.forum.groups.work.forum.threadId, categories["20261015"].forums.forum.groups.work.forum.threadId);
  await f.run(); assert.equal(f.state.messages.length, 4);
});

test("actual PNG conversion into nested output posts all 100 ZIP images and validates generated profiles", async t => {
  const f = await fixture(t, 1);
  const raw = path.join(f.dir, "raw_images"), work = path.join(raw, "20261014", "forum", "work");
  await fs.mkdir(work, { recursive: true });
  for (let i = 1; i <= 100; i++) {
    await sharp({ create: { width: 32, height: 40, channels: 3,
      background: { r: i, g: i % 20, b: 100 } } }).png().toFile(path.join(work, `${i}.png`));
  }
  const build = spawnSync(process.execPath, [path.resolve(__dirname, "../src/build-assets.js"), "run",
    "--input", raw, "--output", f.input, "--chunk-size", "100", "--concurrency", "2"],
  { cwd: path.resolve(__dirname, ".."), windowsHide: true, encoding: "utf8",
    env: { ...process.env, LOCALAPPDATA: path.join(f.dir, "localappdata") } });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  const output = path.join(f.input, "20261014", "forum");
  assert.deepEqual((await fs.readdir(output)).sort(), ["work.assets.json", "work.pdf", "work.zip"]);
  await f.run(); assert.equal(f.state.messages.length, 11);
  assert.equal(f.state.messages.flatMap(m => m.attachments).length, 102);
  await f.run(); assert.equal(f.state.messages.length, 11);
  // Tampering with the generated ZIP must fail validation before any API write.
  const zipFile = path.join(output, "work.zip"), bytes = await fs.readFile(zipFile);
  bytes[10] ^= 1; await fs.writeFile(zipFile, bytes);
  await assert.rejects(f.run(), /SHA-256/); assert.equal(f.state.messages.length, 11);
});

test("existing category permissions are preserved and inherited without patching it", async t => {
  const f = await fixture(t);
  const overwrites = [{ id: "900", type: 0, allow: "0", deny: "1024" }, { id: "901", type: 1, allow: "1024", deny: "0" }];
  f.state.channels.push({ id: "12", type: 4, guild_id: "900", name: "20261014", permission_overwrites: overwrites });
  await f.run(); assert.deepEqual(f.state.creates.map(c => c.type), [15]);
  assert.deepEqual(f.state.creates[0].permission_overwrites, overwrites); assert.equal(f.state.creates[0].parent_id, "12");
});

test("ambiguous parent, changed tracked parent and missing tracked parent all stop without writes", async t => {
  const f = await fixture(t);
  f.state.channels.push(...["10", "11"].map(id => ({ id, type: 4, name: "20261014", permission_overwrites: [] })));
  await assert.rejects(f.run(), /同名カテゴリ/); assert.equal(f.state.creates.length, 0);
  f.state.channels.pop(); await f.run(); const writes = f.state.creates.length;
  f.state.channels[0].name = "renamed";
  await assert.rejects(f.run(), /保存済みカテゴリのGuild・名前/); assert.equal(f.state.creates.length, writes);
  f.state.channels.shift();
  await assert.rejects(f.run(), /保存済みカテゴリを確認できません/); assert.equal(f.state.creates.length, writes);
});

test("category plus forum capacity and permissions are checked before any create", async t => {
  const f = await fixture(t);
  f.state.channels = Array.from({ length: 499 }, (_, i) => ({ id: String(i + 10), type: 0, name: `channel${i}` }));
  await assert.rejects(f.run(), /チャンネル枠/); assert.equal(f.state.creates.length, 0);
  f.state.channels = Array.from({ length: 50 }, (_, i) => ({ id: String(i + 10), type: 4, name: `category${i}` }));
  await assert.rejects(f.run(), /カテゴリ50/); assert.equal(f.state.creates.length, 0);
  f.state.channels = []; f.state.permissions = String(BigInt(permissions) & ~(1n << 38n));
  await assert.rejects(f.run(), /SEND_MESSAGES_IN_THREADS/); assert.equal(f.state.creates.length, 0);
});

test("parent child capacity includes existing channels and all requested forums", async t => {
  const f = await fixture(t); await f.add("20261014", "forum2");
  f.state.channels = [{ id: "10", type: 4, name: "20261014", permission_overwrites: [] },
    ...Array.from({ length: 49 }, (_, i) => ({ id: String(i + 11), type: 0, name: `work${i}`, parent_id: "10" }))];
  await assert.rejects(f.run(), /親カテゴリの50/); assert.equal(f.state.creates.length, 0);
});

test("lost category response is reconciled without a second category create", async t => {
  const f = await fixture(t); f.state.failure = "category-after";
  await assert.rejects(f.run(), /lost category response/); assert.equal(f.state.creates.length, 1);
  await f.run(); assert.deepEqual(f.state.creates.map(c => c.type), [4, 15]);
  assert.equal((await f.saved()).guilds["900"].folderCategories["20261014"].creating, undefined);
});

test("unknown category result with no match or different permissions never retries", async t => {
  const f = await fixture(t); f.state.failure = "category-before";
  await assert.rejects(f.run(), /category outcome unknown/);
  await assert.rejects(f.run(), /前回のカテゴリ作成結果/); assert.equal(f.state.creates.length, 0);
  f.state.channels.push({ id: "10", type: 4, name: "20261014", permission_overwrites: [] });
  await assert.rejects(f.run(), /前回のカテゴリ作成結果/); assert.equal(f.state.creates.length, 0);
});

test("definite category refusal allows retry; lost forum response cannot duplicate a forum", async t => {
  const f = await fixture(t); f.state.failure = "category-403";
  await assert.rejects(f.run(), /category 403/); f.state.failure = "forum-after";
  await assert.rejects(f.run(), /lost forum response/);
  await f.run(); assert.deepEqual(f.state.creates.map(c => c.type), [4, 15]); assert.equal(f.state.threads.length, 1);
  assert.equal(f.state.messages.filter(m => m.flags === 0).length, 1);
});

test("moving an old recorded work into a new folder namespace cannot repost it", async t => {
  const f = await fixture(t);
  await fs.writeFile(f.manifest, JSON.stringify({ version: 1, guilds: { "900": { categories: {
    forum: { groups: { work: { channelId: "800", files: {} } } },
  } } } }));
  await assert.rejects(f.run(), /旧階層で開始済み/); assert.equal(f.state.creates.length, 0);
});

test("duplicate works in shallow and nested local folders cannot post twice in one run", async t => {
  const f = await fixture(t);
  const shallow = path.join(f.input, "forum"); await fs.mkdir(shallow);
  for (const ext of ["zip", "pdf"]) {
    await fs.copyFile(path.join(f.input, "20261014", "forum", `work.${ext}`), path.join(shallow, `work.${ext}`));
  }
  await assert.rejects(f.run(), /両方に同じ作品/); assert.equal(f.state.creates.length, 0);
  await f.run(["--category", "20261014"]); assert.equal(f.state.threads.length, 1);
});

test("folder journals accept prototype property names without cross-contamination", () => {
  const manifest = { guilds: {} };
  const category = { parentName: "__proto__", name: "constructor" };
  folderCategory(manifest, "900", category.parentName, true);
  groupManifest(manifest, "900", category, "__proto__", true).channelId = "100";
  assert.equal(groupManifest(manifest, "900", category, "__proto__").channelId, "100");
  assert.equal({}.channelId, undefined);
  assert.equal(groupManifest(manifest, "900", { parentName: "other", name: "constructor" }, "__proto__"), undefined);
});

test("incorrect successful forum settings never start an upload and are reconciled on rerun", async t => {
  for (const overrides of [
    { nsfw: false }, { flags: 16 }, { permission_overwrites: [] },
    { default_forum_layout: 1 }, { default_sort_order: 0 }, { parent_id: null },
  ]) {
    const f = await fixture(t); f.state.forumResponseOverrides = overrides;
    await assert.rejects(f.run(), /フォーラム作成応答/);
    assert.equal(f.state.messages.length, 0);
    assert.ok((await f.saved()).guilds["900"].folderCategories["20261014"].forums.forum.forumCreating);
    await f.run(); assert.equal(f.state.creates.length, 2); assert.equal(f.state.threads.length, 1);
  }
});

test("malformed successful starter identity or attachment IDs remain unconfirmed and recover without reposting", async t => {
  for (const transform of [
    thread => ({ ...thread, name: "wrong title" }),
    thread => ({ ...thread, message: { ...thread.message, channel_id: "999" } }),
    thread => ({ ...thread, message: { ...thread.message, id: "999" } }),
    thread => ({ ...thread, message: { ...thread.message,
      attachments: thread.message.attachments.map(a => ({ ...a, id: undefined })) } }),
  ]) {
    const f = await fixture(t); f.state.threadResponseTransform = transform;
    await assert.rejects(f.run(), /応答/); assert.equal(f.state.messages.length, 1);
    const album = (await f.saved()).guilds["900"].folderCategories["20261014"].forums.forum.groups.work.forum;
    assert.equal(album.batches[0].status, "sending"); assert.equal(album.threadId, undefined);
    await f.run(); assert.equal(f.state.threads.length, 1); assert.equal(f.state.messages.length, 2);
  }
});

test("renamed recorded work threads cannot continue under a different title", async t => {
  const f = await fixture(t); await f.run(); f.state.threads[0].name = "renamed work";
  await assert.rejects(f.run(), /different parent\/guild\/type\/name/);
  assert.equal(f.state.threads.length, 1); assert.equal(f.state.messages.length, 2);
});

test("legacy channels journals also preserve prototype category and work names", async t => {
  const f = await fixture(t);
  await fs.rename(path.join(f.input, "20261014", "forum"), path.join(f.input, "__proto__"));
  await fs.rmdir(path.join(f.input, "20261014"));
  for (const ext of ["zip", "pdf"]) await fs.rename(path.join(f.input, "__proto__", `work.${ext}`), path.join(f.input, "__proto__", `constructor.${ext}`));
  await f.run(["--posting-layout", "channels"]);
  const saved = await f.saved();
  assert.ok(Object.hasOwn(saved.guilds["900"].categories, "__proto__"));
  assert.ok(Object.hasOwn(saved.guilds["900"].categories.__proto__.groups, "constructor"));
  assert.equal({}.channelId, undefined); assert.equal(f.state.messages.length, 1);
  await f.run(["--posting-layout", "channels"]); assert.equal(f.state.messages.length, 1);
});

const forumJournal = saved => saved.guilds["900"].folderCategories["20261014"].forums.forum;
const normalMessages = state => state.messages.filter(m => m.flags === 0);

test("each Forum reserves exactly one normal starter across multiple works, later additions and reruns", async t => {
  const f = await fixture(t, 15);
  await f.add("20261014", "forum", "work2"); await f.add("20261014", "forum2");
  await f.run();
  assert.equal(normalMessages(f.state).length, 2);
  for (const forum of f.state.channels.filter(c => c.type === 15)) {
    const threads = f.state.threads.filter(thread => thread.parent_id === forum.id);
    const normal = normalMessages(f.state).filter(m => threads.some(thread => thread.id === m.channel_id));
    assert.equal(normal.length, 1); assert.equal(normal[0].id, threads[0].id);
    assert(f.state.messages.filter(m => threads.some(thread => thread.id === m.channel_id) && m.id !== normal[0].id).every(m => m.flags === 4096));
  }
  const before = await f.saved();
  const reservation = forumJournal(before).firstMessageNotification;
  assert.equal(reservation.firstPost.nonce, forumJournal(before).groups.work.forum.batches[0].nonce);
  await f.add("20261014", "forum", "work3"); await f.run(); await f.run();
  assert.equal(normalMessages(f.state).length, 2);
  assert.deepEqual(forumJournal(await f.saved()).firstMessageNotification, reservation);
});

test("lost starter response is recovered from an archive without another normal notification", async t => {
  const f = await fixture(t); f.state.failure = "thread-after";
  await assert.rejects(f.run(), /lost starter response/);
  const reservation = forumJournal(await f.saved()).firstMessageNotification;
  assert.equal(normalMessages(f.state).length, 1);
  f.state.threads[0].thread_metadata.archived = true;
  await f.add("20261014", "forum", "work2"); await f.run(); await f.run();
  assert.equal(f.state.threads.length, 2); assert.equal(normalMessages(f.state).length, 1);
  assert.deepEqual(forumJournal(await f.saved()).firstMessageNotification, reservation);
});

test("unknown starter result stops without retry; definite refusal can retry the same reservation", async t => {
  const unknown = await fixture(t); unknown.state.failure = "thread-before";
  await assert.rejects(unknown.run(), /thread-before/);
  await assert.rejects(unknown.run(), /初回投稿の結果が未確定/);
  assert.equal(unknown.state.threads.length, 0); assert.equal(normalMessages(unknown.state).length, 0);
  const refused = await fixture(t); refused.state.failure = "thread-403";
  await assert.rejects(refused.run(), /thread-403/);
  const reservation = forumJournal(await refused.saved()).firstMessageNotification;
  await refused.run(); await refused.run();
  assert.equal(normalMessages(refused.state).length, 1);
  assert.deepEqual(forumJournal(await refused.saved()).firstMessageNotification, reservation);
});

test("existing Forums and migrated progress without notification markers never notify retroactively", async t => {
  for (const keepHistory of [false, true]) {
    const f = await fixture(t); await f.run();
    const saved = await f.saved();
    if (keepHistory) delete forumJournal(saved).firstMessageNotification;
    else {
      saved.guilds["900"].folderCategories["20261014"].forums.forum = { groups: {} };
      for (const ext of ["zip", "pdf"]) await fs.unlink(path.join(f.input, "20261014", "forum", `work.${ext}`));
    }
    await fs.writeFile(f.manifest, JSON.stringify(saved));
    await f.add("20261014", "forum", "work2"); await f.run();
    assert.equal(normalMessages(f.state).length, 1);
    assert.equal(forumJournal(await f.saved()).firstMessageNotification.firstPost, null);
  }
});

test("empty preexisting Forum stays silent and uncertain Forum creation retains the notification lineage", async t => {
  const f = await fixture(t); f.state.failure = "forum-after";
  await assert.rejects(f.run(), /lost forum response/);
  const saved = await f.saved(); delete forumJournal(saved).forumCreating;
  await fs.writeFile(f.manifest, JSON.stringify(saved));
  await f.run(); assert.equal(normalMessages(f.state).length, 0);
  assert.equal(forumJournal(await f.saved()).firstMessageNotification.firstPost, null);
  const recovered = await fixture(t); recovered.state.failure = "forum-after";
  await assert.rejects(recovered.run(), /lost forum response/);
  await recovered.run(); await recovered.run();
  assert.equal(normalMessages(recovered.state).length, 1);
});

test("remote posts arriving before a recovered Forum or reserved starter keep the next upload silent", async t => {
  for (const failure of ["forum-after", "thread-403"]) {
    const f = await fixture(t); f.state.failure = failure;
    await assert.rejects(f.run(), failure === "forum-after" ? /lost forum response/ : /thread-403/);
    const forum = f.state.channels.find(c => c.type === 15);
    f.state.threads.push({ id: "800", guild_id: "900", parent_id: forum.id, type: 11, name: "someone else's post",
      thread_metadata: { archived: true, locked: false } });
    await f.run(); assert.equal(normalMessages(f.state).length, 0);
  }
});

test("corrupt Forum notification reservations fail before any further API writes", async t => {
  for (const change of [
    cm => { cm.firstMessageNotification = null; },
    cm => { cm.firstMessageNotification.version = 2; },
    cm => { cm.firstMessageNotification.forumId = "999"; },
    cm => { cm.firstMessageNotification.firstPost = {}; },
    cm => { cm.firstMessageNotification.firstPost.workName = "missing"; },
    cm => { cm.firstMessageNotification.firstPost.nonce = "a".repeat(25); },
  ]) {
    const f = await fixture(t); await f.run();
    const saved = await f.saved(); change(forumJournal(saved)); await fs.writeFile(f.manifest, JSON.stringify(saved));
    await f.add("20261014", "forum2");
    await assert.rejects(f.run(), /Invalid Forum notification/);
    assert.equal(f.state.creates.length, 2); assert.equal(f.state.messages.length, 2);
  }
});

test("failed durable reservation save never starts a notification-bearing upload", async t => {
  const { buildLocalPlan } = require("../src/cli");
  const { prepareForumPlan, executeForumPlan } = require("../src/forum-post");
  const f = await fixture(t), manifest = { version: 1, guilds: {} };
  const limits = { maxFileBytes: 10 * 1024 * 1024, maxRequestBytes: 25 * 1024 * 1024, uploadMode: "auto" };
  const plan = await buildLocalPlan(f.input, { ...limits, postingLayout: "forum" });
  await prepareForumPlan({ ...limits, plan, manifest, guildId: "900" });
  await assert.rejects(executeForumPlan({ ...limits, plan, manifest, guildId: "900", api: f.api,
    saveManifest: async (_file, value) => {
      if (value.guilds["900"]?.folderCategories?.["20261014"]?.forums?.forum?.firstMessageNotification) throw new Error("reservation save failed");
    } }), /reservation save failed/);
  assert.equal(f.state.messages.length, 0);
});

test("multipart transport preserves one normal starter and suppresses mentions", async () => {
  const { DiscordApi } = require("../src/cli");
  const api = new DiscordApi("fake-fixture");
  const files = [{ name: "sample.webp", data: Buffer.from("fixture"), mime: "image/webp" }];
  const payload = { name: "work", message: { flags: 0, allowed_mentions: { parse: ["everyone"] } } };
  const starter = JSON.parse((await api.attachmentForm(payload, files, true)).get("payload_json"));
  assert.equal(starter.message.flags, 0); assert.deepEqual(starter.message.allowed_mentions, { parse: [] });
  assert.equal(starter.message.content, undefined);
  const reply = JSON.parse((await api.attachmentForm({ flags: 4096 }, files)).get("payload_json"));
  assert.equal(reply.flags, 4096); assert.deepEqual(reply.allowed_mentions, { parse: [] });
});
