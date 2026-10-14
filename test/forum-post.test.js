const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sharp = require("sharp");
const yazl = require("yazl");
const { main } = require("../src/cli");
const { batches, effectivePermissions } = require("../src/forum-post");

async function zipImages(count, start = 0) {
  const zip = new yazl.ZipFile(), output = [];
  const done = new Promise((resolve, reject) => {
    zip.outputStream.on("data", b => output.push(b));
    zip.outputStream.on("end", () => resolve(Buffer.concat(output)));
    zip.outputStream.on("error", reject);
  });
  for (let i = start; i < count + start; i++) {
    const image = await sharp({ create: { width: 24, height: 24, channels: 3,
      background: { r: i % 256, g: (i * 3) % 256, b: (i * 7) % 256 } } }).webp().toBuffer();
    zip.addBuffer(image, `page-${String(i + 1).padStart(3, "0")}.webp`);
  }
  zip.end(); return done;
}

async function fixture(t, count = 100, split = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "discord-forum-post-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const input = path.join(dir, "input"), category = path.join(input, "2026-10-14");
  await fs.mkdir(category, { recursive: true });
  if (split) {
    await fs.writeFile(path.join(category, "work_1-50.zip"), await zipImages(50));
    await fs.writeFile(path.join(category, "work_51-100.zip"), await zipImages(50, 50));
    for (const part of ["1-50", "51-100"]) await fs.writeFile(path.join(category, `work_${part}.pdf`), "%PDF-test");
  } else {
    await fs.writeFile(path.join(category, "work.zip"), await zipImages(count));
    await fs.writeFile(path.join(category, "work.pdf"), "%PDF-test");
  }
  const state = { channels: [], threads: [], messages: [], sequence: 10000, creates: [], failure: null,
    features: ["COMMUNITY"], permissions: String(16n | 1024n | 2048n | 32768n | 65536n | (1n << 38n)) };
  const id = () => String(++state.sequence);
  function message(channelId, payload, files, messageId = id()) {
    assert.equal(payload.content, undefined);
    const m = { id: messageId, channel_id: channelId, author: { id: "bot" }, nonce: payload.nonce,
      attachments: files.map(f => ({ id: id(), filename: state.sanitizeNames ? f.name.replace(/[^\x21-\x7e]/g, "") : f.name, size: f.size })) };
    state.messages.push(m); return m;
  }
  const api = {
    getGuildChannels: async () => [...state.channels],
    async createGuildChannel(guildId, payload) {
      const created = { ...payload, id: id(), guild_id: guildId };
      state.channels.push(created); state.creates.push(payload.type); return created;
    },
    async createForumThread(forumId, payload, files) {
      const thread = { id: id(), guild_id: "guild", parent_id: forumId, type: 11, name: payload.name,
        thread_metadata: { archived: false, locked: false } };
      state.threads.push(thread);
      thread.message = message(thread.id, payload.message, files, thread.id);
      if (state.failure === "thread-after") { state.failure = null; throw new Error("lost thread response"); }
      return thread;
    },
    async createMessage(channelId, payload, files) {
      if (state.failure === "message-before") { state.failure = null; throw new Error("request outcome unknown"); }
      if (state.failure === "rejected") { state.failure = null; throw Object.assign(new Error("403"), { status: 403 }); }
      const m = message(channelId, payload, files);
      if (state.failure === "message-after") { state.failure = null; throw new Error("lost message response"); }
      if (state.failure === "ambiguous-408") { state.failure = null; throw Object.assign(new Error("408"), { status: 408 }); }
      if (state.failure === "invalid-id") { state.failure = null; return { ...m, id: undefined }; }
      return m;
    },
    async getRecentMessages(channelId, limit = 100, before) {
      return state.messages.filter(m => m.channel_id === channelId && (!before || Number(m.id) < Number(before)))
        .sort((a, b) => Number(b.id) - Number(a.id)).slice(0, limit);
    },
    async request(method, route) {
      assert.equal(method, "GET");
      if (route === "/guilds/guild") return { id: "guild", features: state.features,
        roles: [{ id: "guild", permissions: state.permissions }] };
      if (route === "/users/@me") return { id: "bot" };
      if (route === "/guilds/guild/members/bot") return { roles: [] };
      if (route === "/guilds/guild/threads/active") return { threads: state.threads.filter(t => !t.thread_metadata.archived) };
      if (route.includes("/threads/archived/public")) return { threads: state.threads.filter(t => t.thread_metadata.archived), has_more: false };
      const parts = route.split("/");
      if (parts[3] === "messages") return state.messages.find(m => m.id === parts[4] && m.channel_id === parts[2]);
      const channel = [...state.threads, ...state.channels].find(c => c.id === parts[2]);
      if (channel) return channel;
      throw Object.assign(new Error("404"), { status: 404 });
    },
  };
  const manifest = path.join(dir, "manifest.json");
  async function run(extra = []) {
    const prior = process.argv;
    process.argv = [process.execPath, "cli", "run", "--input", input, "--guild", "guild",
      "--token", "fixture-not-a-secret", "--manifest", manifest, "--yes", ...extra];
    try { await main({ apiFactory: () => api, runtimeDir: path.join(dir, "runtime") }); }
    finally { process.argv = prior; }
  }
  const saved = async () => JSON.parse(await fs.readFile(manifest, "utf8"));
  return { dir, input, category, state, api, manifest, run, saved };
}

test("default forum sends 100 unique images in ten batches then ZIP/PDF and skips a rerun", async t => {
  const f = await fixture(t); await f.run();
  assert.deepEqual(f.state.creates, [15]);
  assert.equal(f.state.channels[0].default_forum_layout, 2);
  assert.equal(f.state.channels[0].nsfw, true);
  assert.equal(f.state.threads.length, 1);
  assert.deepEqual(f.state.messages.map(m => m.attachments.length), [...Array(10).fill(10), 2]);
  const names = f.state.messages.slice(0, 10).flatMap(m => m.attachments.map(a => a.filename));
  assert.equal(new Set(names).size, 100);
  assert.deepEqual(f.state.messages.at(-1).attachments.map(a => a.filename), ["work.zip", "work.pdf"]);
  const firstPlan = (await f.saved()).guilds.guild.categories["2026-10-14"].groups.work.forum;
  await f.run(); assert.equal(f.state.messages.length, 11);
  assert.deepEqual((await f.saved()).guilds.guild.categories["2026-10-14"].groups.work.forum, firstPlan);
});

test("split ZIP parts still produce one work with 100 images and four final archives", async t => {
  const f = await fixture(t, 100, true); await f.run();
  assert.equal(f.state.threads.length, 1); assert.equal(f.state.messages.length, 11);
  assert.equal(f.state.messages.at(-1).attachments.length, 4);
  assert.equal(new Set(f.state.messages.slice(0, 10).flatMap(m => m.attachments.map(a => a.filename))).size, 100);
});

test("lost message response is recovered without duplication even after archival and over 100 replies", async t => {
  const f = await fixture(t); f.state.failure = "message-after";
  await assert.rejects(f.run(), /lost message/);
  f.state.threads[0].thread_metadata.archived = true;
  for (let i = 0; i < 110; i++) f.state.messages.push({ id: String(++f.state.sequence),
    channel_id: f.state.threads[0].id, author: { id: "someone" }, attachments: [] });
  await f.run(); assert.equal(f.state.messages.filter(m => m.author.id === "bot").length, 11);
});

test("lost initial post response is recovered from an archived thread", async t => {
  const f = await fixture(t); f.state.failure = "thread-after";
  await assert.rejects(f.run(), /lost thread/);
  f.state.threads[0].thread_metadata.archived = true;
  await f.run(); assert.equal(f.state.threads.length, 1); assert.equal(f.state.messages.length, 11);
});

test("unknown send outcome with no matching message fails closed rather than blind retry", async t => {
  const f = await fixture(t); f.state.failure = "message-before";
  await assert.rejects(f.run(), /outcome unknown/);
  await assert.rejects(f.run(), /送信結果が未確定/);
  assert.equal(f.state.messages.length, 1);
});

test("definite 403 rejection can safely resume, preserving image order", async t => {
  const f = await fixture(t); f.state.failure = "rejected";
  await assert.rejects(f.run(), /403/);
  const original = (await f.saved()).guilds.guild.categories["2026-10-14"].groups.work.forum;
  await f.run(); const current = (await f.saved()).guilds.guild.categories["2026-10-14"].groups.work.forum;
  assert.deepEqual(current.batches.map(b => b.keys), original.batches.map(b => b.keys));
  assert.equal(f.state.messages.length, 11);
});

test("missing Community or thread permission stops before forum creation", async t => {
  const f = await fixture(t); f.state.features = [];
  await assert.rejects(f.run(), /Community/); assert.equal(f.state.channels.length, 0);
  f.state.features = ["COMMUNITY"]; f.state.permissions = String(BigInt(f.state.permissions) & ~(1n << 38n));
  await assert.rejects(f.run(), /SEND_MESSAGES_IN_THREADS/); assert.equal(f.state.channels.length, 0);
});

test("changed same-size input after posting and removed attachments stop without additional writes", async t => {
  const f = await fixture(t); await f.run();
  const pdf = path.join(f.category, "work.pdf"); const original = await fs.readFile(pdf);
  await fs.writeFile(pdf, Buffer.alloc(original.length, 90));
  await assert.rejects(f.run(), /変わっています/); assert.equal(f.state.messages.length, 11);
  await fs.writeFile(pdf, original); f.state.messages[0].attachments.pop();
  await assert.rejects(f.run(), /添付が一致しません/); assert.equal(f.state.messages.length, 11);
});

test("legacy partially posted work finishes in its existing channel without forum migration", async t => {
  const f = await fixture(t); const zipSize = (await fs.stat(path.join(f.category, "work.zip"))).size;
  f.state.channels.push({ id: "12345", type: 0, name: "work", parent_id: "12344" });
  await fs.writeFile(f.manifest, JSON.stringify({ version: 1, guilds: { guild: { categories: {
    "2026-10-14": { id: "12344", groups: { work: { channelId: "12345", files: {
      "work.zip": { channelId: "12345", size: zipSize, messageId: "old-post" },
    } } } },
  } } } }));
  await f.run(["--no-remote-check"]);
  assert.equal(f.state.threads.length, 0); assert.equal(f.state.messages.length, 1);
  assert.deepEqual(f.state.messages[0].attachments.map(a => a.filename), ["work.pdf"]);
});

test("multipart reserve, attachment count and permission overwrites are enforced", () => {
  assert.deepEqual(batches(Array.from({ length: 11 }, () => ({ size: 1 })), 50000).map(b => b.length), [10, 1]);
  assert.throws(() => batches([{ size: 1000 }], 50000), /cannot fit/);
  const guild = { id: "g", roles: [{ id: "g", permissions: "1024" }, { id: "r", permissions: "2048" }] };
  const channel = { permission_overwrites: [{ id: "g", type: 0, deny: "2048", allow: "0" },
    { id: "r", type: 0, deny: "0", allow: "2048" }, { id: "b", type: 1, deny: "2048", allow: "0" }] };
  assert.equal(effectivePermissions(guild, { roles: ["r"] }, "b", channel), 1024n);
});

test("Discord filename sanitization is recorded and does not prevent safe reruns", async t => {
  const f = await fixture(t);
  const name = "100枚テスト・WebPギャラリー";
  for (const ext of ["zip", "pdf"]) await fs.rename(path.join(f.category, `work.${ext}`), path.join(f.category, `${name}.${ext}`));
  f.state.sanitizeNames = true; await f.run();
  assert.deepEqual(f.state.messages.at(-1).attachments.map(a => a.filename), ["100WebP.zip", "100WebP.pdf"]);
  await f.run(); assert.equal(f.state.messages.length, 11);
  const last = (await f.saved()).guilds.guild.categories["2026-10-14"].groups[name].forum.batches.at(-1);
  assert.equal(last.attachments[0].name, "100WebP.zip");
});

test("invalid success ID and ambiguous HTTP 408 are reconciled rather than retried", async t => {
  for (const failure of ["invalid-id", "ambiguous-408"]) {
    const f = await fixture(t); f.state.failure = failure;
    await assert.rejects(f.run(), failure === "invalid-id" ? /応答が不正/ : /408/);
    await f.run(); assert.equal(f.state.messages.length, 11);
  }
});

test("moved or renamed existing forum and lost manifest do not create duplicate works", async t => {
  const f = await fixture(t); await f.run();
  f.state.channels[0].parent_id = "different-parent";
  await assert.rejects(f.run(), /親カテゴリが異なります/);
  delete f.state.channels[0].parent_id;
  f.state.channels[0].name = "changed";
  await assert.rejects(f.run(), /名前・親カテゴリが異なります/);
  f.state.channels[0].name = "2026-10-14";
  await fs.rm(f.manifest); await assert.rejects(f.run(), /同名の作品投稿/);
  assert.equal(f.state.threads.length, 1); assert.equal(f.state.messages.length, 11);
});

test("channelId-only legacy state and unknown legacy POST outcome remain in the old channel", async t => {
  const f = await fixture(t);
  f.state.channels.push({ id: "12345", guild_id: "guild", type: 0, name: "work" });
  await fs.writeFile(f.manifest, JSON.stringify({ version: 1, guilds: { guild: { categories: {
    "2026-10-14": { groups: { work: { channelId: "12345", files: {} } } },
  } } } }));
  f.state.failure = "message-after";
  await assert.rejects(f.run(["--no-remote-check"]), /lost message/);
  for (let i = 0; i < 110; i++) f.state.messages.push({ id: String(++f.state.sequence), channel_id: "12345", author: { id: "someone" }, attachments: [] });
  await f.run(["--no-remote-check"]);
  assert.equal(f.state.threads.length, 0);
  assert.equal(f.state.messages.filter(m => m.author.id === "bot").length, 1);
});

test("more than 50 works use one forum and server capacity is checked before creating it", async t => {
  const f = await fixture(t, 1);
  for (let i = 1; i <= 50; i++) for (const ext of ["zip", "pdf"]) {
    await fs.copyFile(path.join(f.category, `work.${ext}`), path.join(f.category, `work-${i}.${ext}`));
  }
  await f.run(); assert.equal(f.state.threads.length, 51); assert.deepEqual(f.state.creates, [15]);
  const other = await fixture(t, 1);
  other.state.channels.push(...Array.from({length:500},(_,i)=>({id:String(20000+i),type:0,name:`existing-${i}`})));
  await assert.rejects(other.run(), /チャンネル枠が不足/); assert.equal(other.state.creates.length,0);
});

test("new restricted-server date forums require an explicit inheritance source", async t => {
  const f = await fixture(t,1);
  f.state.channels.push({id:"54321",guild_id:"guild",type:4,name:"private-parent",
    permission_overwrites:[{id:"private-role",type:0,allow:"1024",deny:"0"}]});
  await assert.rejects(f.run(), /閲覧制限を特定できません/); assert.equal(f.state.creates.length,0);
  await f.run(["--forum-parent","54321"]);
  assert.equal(f.state.channels.at(-1).parent_id,"54321");
  assert.deepEqual(f.state.channels.at(-1).permission_overwrites,f.state.channels[0].permission_overwrites);
});

test("switching an existing forum work to channels or corrupting its progress cannot duplicate it", async t => {
  const f = await fixture(t,1); await f.run();
  await assert.rejects(f.run(["--posting-layout","channels"]), /フォーラムで開始済み/);
  const manifest=await f.saved();
  manifest.guilds.guild.categories["2026-10-14"].groups.work.forum.batches[0].messageId=undefined;
  await fs.writeFile(f.manifest,JSON.stringify(manifest));
  await assert.rejects(f.run(), /Invalid forum batch progress/);
  assert.equal(f.state.creates.length,1); assert.equal(f.state.messages.length,2);
});

test("threadId with pending starter and missing legacy completed file entry stop without duplication", async t => {
  const f=await fixture(t,1);await f.run();
  const manifest=await f.saved();
  manifest.guilds.guild.categories["2026-10-14"].groups.work.forum.batches[0].status="pending";
  await fs.writeFile(f.manifest,JSON.stringify(manifest));
  await assert.rejects(f.run(), /first batch progress/);assert.equal(f.state.messages.length,2);
  const legacy=await fixture(t,1);
  legacy.state.channels.push({id:"12345",guild_id:"guild",type:0,name:"work"});
  await fs.writeFile(legacy.manifest,JSON.stringify({version:1,guilds:{guild:{categories:{
    "2026-10-14":{groups:{work:{channelId:"12345",files:{}}}},
  }}}}));
  await legacy.run(["--no-remote-check"]);
  const saved=await legacy.saved();delete saved.guilds.guild.categories["2026-10-14"].groups.work.files["work.zip"];
  await fs.writeFile(legacy.manifest,JSON.stringify(saved));
  await assert.rejects(legacy.run(), /completed journal\/file progress/);assert.equal(legacy.state.messages.length,1);
});
