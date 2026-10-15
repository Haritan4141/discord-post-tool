const fs = require("node:fs/promises");
const crypto = require("node:crypto");
const { readGroupImages } = require("./forum-assets");
const { folderCategory, forumManifest, groupManifest } = require("./forum-folders");

const MiB = 1024 * 1024;
// Leaves room for multipart boundaries, metadata and UTF-8 filenames.
const OVERHEAD = 48 * 1024;
const SUPPRESS_NOTIFICATIONS = 1 << 12;
const REQUIRED = { VIEW_CHANNEL: 1024n, SEND_MESSAGES: 2048n, ATTACH_FILES: 32768n,
  READ_MESSAGE_HISTORY: 65536n, SEND_MESSAGES_IN_THREADS: 1n << 38n };
const sha = data => crypto.createHash("sha256").update(data).digest("hex");
const title = name => Array.from(name).length <= 100 ? name :
  Array.from(name).slice(0, 90).join("") + "-" + sha(name).slice(0, 8);

function legacyEntry(manifest, guildId, category, group) {
  const entry = groupManifest(manifest, guildId, category, group.baseName);
  return entry?.channelId && !entry.forum ? entry : null;
}

async function albumFiles(group, options) {
  const images = await readGroupImages(group.files, {
    maxCompressedBytes: options.maxFileBytes, maxFileBytes: options.maxFileBytes,
    maxTotalBytes: 256 * MiB,
  });
  const imageFiles = images.map((image, index) => ({
    ...image, key: `image:${image.key}`,
    name: `image-${String(index + 1).padStart(4, "0")}-${image.sha256.slice(0, 16)}.webp`, type: "image",
  }));
  const archives = [];
  for (const file of group.files) {
    const data = await fs.readFile(file.path);
    if (data.length !== file.size) throw new Error(`${file.name}: input changed during planning`);
    archives.push({ ...file, data, sha256: sha(data), key: `archive:${file.name}` });
  }
  const all = [...imageFiles, ...archives];
  const fingerprint = sha(JSON.stringify(all.map(f => [f.key, f.name, f.size, f.sha256])));
  return { images: imageFiles, archives, all, fingerprint };
}

function batches(files, maxBytes, maxCount = 10) {
  const result = [];
  for (const file of files) {
    if (file.size + OVERHEAD > maxBytes) throw new Error(`${file.name}: cannot fit in --max-request-mib`);
    let last = result.at(-1);
    if (!last || last.length >= maxCount || last.reduce((n, f) => n + f.size, 0) + file.size + OVERHEAD > maxBytes) {
      result.push(last = []);
    }
    last.push(file);
  }
  return result;
}

function makeAlbumPlan(assets, options) {
  const shuffled = [...assets.images];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const first = shuffled.slice(0, 10);
  const keys = new Set(first.map(f => f.key));
  const ordered = [...first, ...assets.images.filter(f => !keys.has(f.key))];
  const maxBytes = Math.min(options.maxRequestBytes, 25 * MiB);
  const chunks = [...batches(ordered, maxBytes), ...batches(assets.archives, maxBytes,
    options.uploadMode === "separate" ? 1 : 10)];
  return {
    version: 1, fingerprint: assets.fingerprint, imageCount: assets.images.length,
    bytes: assets.all.reduce((n, f) => n + f.size, 0),
    files: assets.all.map(f => ({ key: f.key, name: f.name, size: f.size, sha256: f.sha256, type: f.type })),
    batches: chunks.map(files => ({ keys: files.map(f => f.key), nonce: crypto.randomUUID().replace(/-/g, "").slice(0, 25), status: "pending" })),
  };
}

async function prepareForumPlan(context) {
  const locations = new Map();
  for (const category of context.plan.categories) for (const group of category.groups) {
    const key = JSON.stringify([category.name, group.baseName]);
    const previous = locations.get(key) || [];
    if (previous.some(c => (c.parentName === undefined) !== (category.parentName === undefined))) {
      throw new Error(`${category.name}/${group.baseName}: 旧浅い階層と新カテゴリ/フォーラム階層の両方に同じ作品があります。重複投稿を避けるため、投稿入力またはカテゴリフィルタで一方を選択してください。`);
    }
    previous.push(category); locations.set(key, previous);
  }
  for (const category of context.plan.categories) for (const group of category.groups) {
    if (category.parentName !== undefined && !groupManifest(context.manifest, context.guildId, category, group.baseName)) {
      const old = groupManifest(context.manifest, context.guildId, { name: category.name }, group.baseName);
      if (old?.channelId || old?.forum) {
        throw new Error(`${category.parentName}/${category.name}/${group.baseName}: 旧階層で開始済みの投稿があります。自動移動・重複投稿を避けるため元の階層で再開してください。`);
      }
    }
    group.legacy = Boolean(legacyEntry(context.manifest, context.guildId, category, group));
    if (group.legacy) continue;
    if (group.warnings.some(w => /zip file is missing|pdf file is missing/.test(w))) {
      throw new Error(`${group.baseName}: フォーラム投稿には各partのZIP/PDF pairが必要です。`);
    }
    const assets = await albumFiles(group, context);
    const saved = groupManifest(context.manifest, context.guildId, category, group.baseName)?.forum;
    if (saved && saved.fingerprint !== assets.fingerprint) {
      throw new Error(`${category.name}/${group.baseName}: 投稿開始後の画像/ZIP/PDFが変わっています。既存投稿を確認して別作品名で投稿してください。`);
    }
    group.albumPlan = saved || makeAlbumPlan(assets, context);
    validateAlbumPlan(group.albumPlan, assets, context);
  }
}

function validateAlbumPlan(plan, assets, options) {
  const files = new Map(assets.all.map(f => [f.key, f]));
  const keys = plan.batches.flatMap(b => b.keys);
  if (keys.length !== files.size || new Set(keys).size !== files.size || keys.some(k => !files.has(k))) {
    throw new Error("Invalid forum manifest: missing or duplicate files");
  }
  const maxBytes = Math.min(options.maxRequestBytes, 25 * MiB);
  let archivesStarted = false;
  let unfinished = false;
  if (plan.imageCount !== assets.images.length) throw new Error("Invalid forum image count");
  if (plan.batches.some(b => b.status === "done") && !validId(plan.threadId)) throw new Error("Invalid saved work thread ID");
  if (plan.threadId && (!validId(plan.threadId) || plan.batches[0]?.status === "pending")) throw new Error("Invalid saved work first batch progress");
  for (const batch of plan.batches) {
    const current = batch.keys.map(k => files.get(k));
    if (!current.length || current.length > 10 || current.reduce((n, f) => n + f.size, 0) + OVERHEAD > maxBytes) {
      throw new Error("Saved forum batches exceed attachment/request limits; use the original request limit to resume");
    }
    if (current.some(f => f.type !== "image")) archivesStarted = true;
    else if (archivesStarted) throw new Error("Invalid forum manifest: image after archive");
    if (!["pending", "sending", "done"].includes(batch.status)) throw new Error("Invalid forum batch status");
    if (typeof batch.nonce !== "string" || !/^[a-f0-9]{25}$/.test(batch.nonce)) throw new Error("Invalid forum batch nonce");
    if (batch.status === "done" && (unfinished || !validId(batch.messageId))) throw new Error("Invalid forum batch progress/ID");
    if (batch.status !== "done") unfinished = true;
  }
}

function effectivePermissions(guild, member, userId, channel) {
  const roles = new Set([guild.id, ...member.roles]);
  let bits = 0n;
  for (const role of guild.roles) if (roles.has(role.id)) bits |= BigInt(role.permissions);
  if (bits & 8n) return (1n << 64n) - 1n;
  const overwrites = channel.permission_overwrites || [];
  const everyone = overwrites.find(o => o.type === 0 && o.id === guild.id);
  if (everyone) bits = (bits & ~BigInt(everyone.deny || "0")) | BigInt(everyone.allow || "0");
  let deny = 0n, allow = 0n;
  for (const o of overwrites) if (o.type === 0 && o.id !== guild.id && roles.has(o.id)) {
    deny |= BigInt(o.deny || "0"); allow |= BigInt(o.allow || "0");
  }
  bits = (bits & ~deny) | allow;
  const own = overwrites.find(o => o.type === 1 && o.id === userId);
  if (own) bits = (bits & ~BigInt(own.deny || "0")) | BigInt(own.allow || "0");
  return bits;
}

function assertPermissions(guild, member, userId, channel) {
  const bits = effectivePermissions(guild, member, userId, channel);
  const missing = Object.entries(REQUIRED).filter(([, bit]) => !(bits & bit)).map(([name]) => name);
  if (missing.length) throw new Error(`${channel.name}: Bot権限が不足しています: ${missing.join(", ")}`);
}

function folderParents(context, channels, guild, member, user) {
  const parents = new Map();
  for (const category of context.plan.categories) {
    if (!category.groups.length || category.parentName === undefined || parents.has(category.parentName)) continue;
    if (context.forumParent) throw new Error("カテゴリ/フォーラム階層では親カテゴリIDを空欄にしてください。フォルダ名から配置を決定します。");
    const pm = folderCategory(context.manifest, context.guildId, category.parentName, true);
    const expectedName = title(category.parentName);
    let channel = pm.id ? channels.find(c => c.id === pm.id && c.type === 4) : null;
    if (pm.id && !channel) throw new Error(`${category.parentName}: 保存済みカテゴリを確認できません。削除/権限を確認してください。`);
    const matches = channels.filter(c => c.type === 4 && c.name === expectedName);
    if (!channel && matches.length > 1) throw new Error(`${category.parentName}: 同名カテゴリが複数あるため停止しました。`);
    channel ||= matches[0];
    if (channel && (channel.name !== expectedName || (channel.guild_id && channel.guild_id !== context.guildId))) {
      throw new Error(`${category.parentName}: 保存済みカテゴリのGuild・名前が異なります。配置を確認してください。`);
    }
    // User policy: newly created categories are visible to everyone. Existing
    // categories retain their overwrites, including any restricted visibility.
    const payload = { name: expectedName, type: 4,
      permission_overwrites: [{ id: context.guildId, type: 0, allow: "1024", deny: "0" }] };
    if (pm.creating) {
      if (!channel || !pm.creating.payload || channel.name !== pm.creating.payload.name ||
        JSON.stringify(normalizeOverwrites(channel.permission_overwrites)) !==
        JSON.stringify(normalizeOverwrites(pm.creating.payload.permission_overwrites))) {
        throw new Error(`${category.parentName}: 前回のカテゴリ作成結果を確認できないため再作成しません。Discord側を確認してください。`);
      }
    }
    if (!channel && !(effectivePermissions(guild, member, user.id, {}) & 16n)) {
      throw new Error("カテゴリ新設にはBotのMANAGE_CHANNELS権限が必要です。");
    }
    if (!channel && !(effectivePermissions(guild, member, user.id, {}) & 1024n)) {
      throw new Error("カテゴリの閲覧許可を設定するためBotのVIEW_CHANNEL権限が必要です。");
    }
    parents.set(category.parentName, { pm, channel, payload });
  }
  return parents;
}

function normalizeOverwrites(overwrites = []) {
  return overwrites.map(o => ({ id: o.id, type: o.type, allow: String(BigInt(o.allow || "0")),
    deny: String(BigInt(o.deny || "0")) })).sort((a, b) => a.id.localeCompare(b.id) || a.type - b.type);
}

function assertCreatedForum(forum, payload, guildId) {
  if (!validId(forum?.id) || forum.guild_id !== guildId || forum.type !== 15 || forum.name !== payload.name ||
    (forum.parent_id || null) !== (payload.parent_id || null) || !forum.nsfw || (forum.flags & 16) ||
    forum.default_forum_layout !== payload.default_forum_layout || forum.default_sort_order !== payload.default_sort_order ||
    JSON.stringify(normalizeOverwrites(forum.permission_overwrites)) !== JSON.stringify(normalizeOverwrites(payload.permission_overwrites))) {
    throw new Error("フォーラム作成応答の配置・権限・年齢制限・表示が不正です。結果を確認するまで投稿・再作成しません。");
  }
}

function validateFirstMessageNotification(cm, forumId) {
  if (!Object.hasOwn(cm, "firstMessageNotification")) return null;
  const journal = cm.firstMessageNotification;
  if (!journal || journal.version !== 1 || !validId(journal.forumId) || journal.forumId !== forumId ||
    (journal.firstPost !== null && (!journal.firstPost || typeof journal.firstPost.workName !== "string" ||
      !/^[a-f0-9]{25}$/.test(journal.firstPost.nonce)))) {
    throw new Error("Invalid Forum notification journal");
  }
  if (journal.firstPost !== null) {
    const selected = Object.hasOwn(cm.groups, journal.firstPost.workName) && cm.groups[journal.firstPost.workName]?.forum;
    if (!selected || selected.batches?.[0]?.nonce !== journal.firstPost.nonce ||
      !["pending", "sending", "done"].includes(selected.batches[0].status)) {
      throw new Error("Invalid Forum notification work reservation");
    }
  }
  return journal;
}

async function initializeFirstMessageNotification(context, cm, category, forum, created, threadIndex) {
  if (validateFirstMessageNotification(cm, forum.id)) return;
  let firstPost = null;
  // Never retroactively notify existing Forums or work started by older versions.
  if (created && !Object.values(cm.groups).some(group => group?.forum)) {
    threadIndex.names = new Set((await listForumThreads(context.api, context.guildId, forum.id)).map(t => t.name));
    if (threadIndex.names.size === 0) {
      const group = category.groups.find(g => !g.legacy);
      const gm = groupManifest(context.manifest, context.guildId, category, group.baseName, true);
      gm.forum = structuredClone(group.albumPlan);
      firstPost = { workName: group.baseName, nonce: gm.forum.batches[0].nonce };
    }
  }
  // The caller saves the Forum ID, selected album and immutable reservation together,
  // before any starter POST. Sending/done batch recovery must never reassign it.
  cm.firstMessageNotification = { version: 1, forumId: forum.id, firstPost };
  validateFirstMessageNotification(cm, forum.id);
}

async function executeForumPlan(context) {
  const { api, guildId, plan, manifest, manifestPath, saveManifest } = context;
  const save = () => saveManifest(manifestPath, manifest);
  const channels = await api.getGuildChannels(guildId);
  const hasNew = plan.categories.some(c => c.groups.some(g => !g.legacy));
  let guild, user, member;
  if (plan.totals.groups) {
    guild = await api.request("GET", `/guilds/${guildId}`);
    if (hasNew && !guild.features?.includes("COMMUNITY")) throw new Error("フォーラムにはCommunityの有効化が必要です。サーバー管理者が設定してから再実行してください。");
    user = await api.request("GET", "/users/@me");
    member = await api.request("GET", `/guilds/${guildId}/members/${user.id}`);
  }
  const parents = folderParents(context, channels, guild, member, user);
  const prepared = [];
  const newParents = [...parents.values()].filter(p => !p.channel);
  let newCount = newParents.length;
  const parentAdds = new Map();
  // Complete permission/capacity/legacy checks before creating anything.
  for (const category of plan.categories) {
    const cm = forumManifest(manifest, guildId, category, true);
    const parent = category.parentName === undefined ? null : parents.get(category.parentName);
    const desiredParent = parent?.channel?.id || (parent ? null : context.forumParent);
    for (const group of category.groups.filter(g => g.legacy)) {
      const entry = legacyEntry(manifest, guildId, category, group);
      const channel = channels.find(c => c.id === entry.channelId && c.type === 0);
      if (!channel) throw new Error(`${group.baseName}: 既存投稿チャンネルを確認できません。重複防止のため自動移行しません。`);
      const bits = effectivePermissions(guild, member, user.id, channel);
      const missing = Object.entries(REQUIRED).filter(([name, bit]) => name !== "SEND_MESSAGES_IN_THREADS" && !(bits & bit));
      if (missing.length) throw new Error(`${group.baseName}: 既存チャンネルのBot権限が不足しています: ${missing.map(([name]) => name).join(", ")}`);
    }
    if (category.groups.every(g => g.legacy)) { prepared.push({ category, cm }); continue; }
    const matches = channels.filter(c => c.type === 15 && c.name === title(category.name) &&
      (!parent || (parent.channel && c.parent_id === parent.channel.id)));
    let forum = cm.forumId ? channels.find(c => c.id === cm.forumId && c.type === 15) : null;
    if (cm.forumId && !forum) throw new Error(`${category.name}: 保存済みフォーラムを確認できません。削除/閲覧権限を確認してください。`);
    if (!forum && matches.length > 1) throw new Error(`${category.name}: 同名フォーラムが複数あるため停止しました。`);
    forum ||= matches[0];
    validateFirstMessageNotification(cm, forum?.id);
    if (forum && (forum.guild_id !== guildId || forum.name !== title(category.name) ||
      ((parent || context.forumParent) && forum.parent_id !== desiredParent) ||
      (cm.forumParentId !== undefined && (forum.parent_id || null) !== cm.forumParentId))) {
      throw new Error(`${category.name}: 保存済み/同名フォーラムのGuild・名前・親カテゴリが異なります。配置を確認してください。`);
    }
    const source = parent ? (parent.channel || parent.payload) : channels.find(c => c.type === 4 && c.id === context.forumParent) ||
      channels.find(c => c.type === 4 && c.id === cm.id) ||
      channels.find(c => c.type === 4 && c.name === category.name);
    if (context.forumParent && !channels.some(c => c.id === context.forumParent && c.type === 4)) {
      throw new Error("フォーラム親カテゴリIDを確認できません。");
    }
    if (!forum && !source && channels.some(c => (c.permission_overwrites || []).some(o =>
      (BigInt(o.allow || "0") | BigInt(o.deny || "0")) & 1024n))) {
      throw new Error(`${category.name}: 新規フォーラムの閲覧制限を特定できません。権限を引き継ぐ親カテゴリIDを指定するか、同名フォーラムをDiscord側で設定してください。`);
    }
    const payload = { name: title(category.name), type: 15, default_forum_layout: context.forumLayout === "list" ? 1 : 2,
      default_sort_order: 1, default_auto_archive_duration: 1440, nsfw: true };
    if (source) payload.permission_overwrites = source.permission_overwrites || [];
    if (desiredParent) payload.parent_id = desiredParent;
    if (forum && cm.forumCreating) assertCreatedForum(forum, cm.forumCreating.payload || payload, guildId);
    assertPermissions(guild, member, user.id, forum || payload);
    if (forum?.flags & 16) throw new Error(`${category.name}: 必須タグを解除した専用フォーラムを使用してください。`);
    if (forum && !forum.nsfw) throw new Error(`${category.name}: 既存フォーラムの年齢制限を設定してから再実行してください。`);
    if (forum && source && JSON.stringify(normalizeVisibility(forum.permission_overwrites)) !==
      JSON.stringify(normalizeVisibility(source.permission_overwrites))) {
      throw new Error(`${category.name}: フォーラムと権限の引継ぎ元カテゴリの閲覧設定が異なります。配置/権限を確認してください。`);
    }
    if (!forum) {
      if (cm.forumCreating) throw new Error(`${category.name}: 前回のフォーラム作成結果を確認できないため再作成しません。Discord側を確認してください。`);
      if (!(effectivePermissions(guild, member, user.id, {}) & 16n)) throw new Error("BotにMANAGE_CHANNELS権限が必要です。");
      newCount++;
      const parentKey = parent?.channel?.id || parent || payload.parent_id;
      if (parentKey) parentAdds.set(parentKey, (parentAdds.get(parentKey) || 0) + 1);
    }
    prepared.push({ category, cm, forum, payload, parent });
  }
  if (channels.length + newCount > 500) throw new Error(`サーバーのチャンネル枠が不足しています (${channels.length} existing + ${newCount} new categories/forums)。`);
  if (channels.filter(c => c.type === 4).length + newParents.length > 50) {
    throw new Error("サーバーのカテゴリ50件上限を超えます。");
  }
  for (const [parentKey, added] of parentAdds) {
    const parentId = typeof parentKey === "string" ? parentKey : parentKey.channel?.id;
    if (channels.filter(c => parentId && c.parent_id === parentId).length + added > 50) {
      throw new Error("親カテゴリの50チャンネル上限を超えます。");
    }
  }
  // All categories, forums, permissions and capacity were checked before the
  // first write. Persist intent before each create to avoid unknown retries.
  for (const parent of parents.values()) {
    if (!parent.channel) {
      parent.pm.creating = { payload: structuredClone(parent.payload) }; await save();
      try {
        const created = await api.createGuildChannel(guildId, parent.payload);
        if (!validId(created?.id) || created.guild_id !== guildId || created.type !== 4 || created.name !== parent.payload.name ||
          JSON.stringify(normalizeOverwrites(created.permission_overwrites)) !== JSON.stringify(normalizeOverwrites(parent.payload.permission_overwrites))) {
          throw new Error("カテゴリ作成応答が不正です。結果を確認するまで再作成しません。");
        }
        parent.channel = created; channels.push(created);
      } catch (error) {
        if (definiteRejection(error)) { delete parent.pm.creating; await save(); }
        throw error;
      }
    }
    parent.pm.id = parent.channel.id; delete parent.pm.creating; await save();
  }
  for (const item of prepared) {
    const { category, cm, payload, parent } = item;
    let { forum } = item;
    for (const group of category.groups.filter(g => g.legacy)) {
      const entry = legacyEntry(manifest, guildId, category, group);
      console.log(`[${category.name}] ${group.baseName}: existing channel, resume without migration`);
      await uploadLegacySafely({ ...context, category, group, entry, user,
        channel: channels.find(c => c.id === entry.channelId), save });
    }
    if (!payload) continue;
    if (parent) payload.parent_id = parent.channel.id;
    const createdForNotification = !forum || Boolean(cm.forumCreating);
    if (!forum) {
      cm.forumCreating = { payload: structuredClone(payload) }; await save();
      try {
        forum = await api.createGuildChannel(guildId, payload);
        assertCreatedForum(forum, payload, guildId);
      }
      catch (error) { if (definiteRejection(error)) { delete cm.forumCreating; await save(); } throw error; }
    }
    const threadIndex = { names: null };
    cm.forumId = forum.id; cm.forumParentId = forum.parent_id || null;
    await initializeFirstMessageNotification(context, cm, category, forum, createdForNotification, threadIndex);
    delete cm.forumCreating; await save();
    console.log(`[${category.name}] Forum ${forum.id}`);
    for (const group of category.groups.filter(g => !g.legacy)) {
      const gm = groupManifest(manifest, guildId, category, group.baseName, true);
      gm.forum ||= structuredClone(group.albumPlan);
      await save();
      await uploadAlbum({ ...context, category, group, forum, album: gm.forum, user, save, threadIndex,
        notification: cm.firstMessageNotification });
    }
  }
  console.log("Done.");
}

function definiteRejection(error) {
  return [400, 401, 403, 404, 405, 413, 429].includes(error.status);
}

const validId = id => typeof id === "string" && /^[1-9]\d{0,19}$/.test(id);

function normalizeVisibility(overwrites = []) {
  const mask = 1024n | 65536n;
  return overwrites.map(o => ({ id: o.id, type: o.type, allow: String(BigInt(o.allow || "0") & mask), deny: String(BigInt(o.deny || "0") & mask) }))
    .filter(o => o.allow !== "0" || o.deny !== "0")
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function allMessages(api, channelId) {
  const all = []; let before;
  for (;;) {
    const page = await api.getRecentMessages(channelId, 100, before);
    if (!Array.isArray(page)) throw new Error("Invalid message response");
    all.push(...page);
    if (page.length < 100) return all;
    const cursor = page.at(-1).id;
    if (!cursor || cursor === before || all.length > 100000) throw new Error("Message pagination could not complete safely");
    before = cursor;
  }
}

function matchesBatch(message, files, userId, nonce) {
  if (message.author?.id !== userId) return false;
  // Filenames contain image hashes. Archive sends additionally have durable nonces.
  if (nonce && String(message.nonce) === nonce) return attachmentSizesMatch(message, files);
  if (files.some(f => f.type !== "image")) return false;
  return message.attachments?.length === files.length && files.every(f =>
    message.attachments.some(a => a.filename === f.name && a.size === f.size));
}

function attachmentSizesMatch(message, files) {
  if (message.attachments?.length !== files.length) return false;
  return message.attachments.every((a, i) => a.size === files[i].size &&
    (files[i].type !== "image" || a.filename === files[i].name));
}

function finishBatch(batch, message, files, userId) {
  if (!validId(message?.id) || message.author?.id !== userId || !attachmentSizesMatch(message, files) ||
    message.attachments.some(a => !validId(a.id)) || new Set(message.attachments.map(a => a.id)).size !== files.length) {
    throw new Error("投稿応答の添付が一致しません。結果を確認してから再開します。");
  }
  batch.status = "done"; batch.messageId = message.id;
  batch.attachments = message.attachments.map(a => ({ id: a.id, name: a.filename, size: a.size }));
}

async function uploadLegacySafely(context) {
  const { api, group, channel, entry, user, save } = context;
  entry.files ||= {};
  entry.legacySends ||= [];
  for (const send of entry.legacySends) {
    if (!["pending", "sending", "done"].includes(send.status) || !Array.isArray(send.files) ||
      !send.files.length || send.files.length > 10 || typeof send.nonce !== "string" || !/^[a-f0-9]{25}$/.test(send.nonce)) {
      throw new Error("Invalid legacy send journal");
    }
    if (send.status === "done" && (!validId(send.messageId) || send.files.some(file => {
      const recorded = entry.files[file.name];
      return !recorded || recorded.messageId !== send.messageId || recorded.channelId !== channel.id ||
        recorded.size !== file.size || recorded.sha256 !== file.sha256;
    }))) throw new Error("Invalid legacy completed journal/file progress");
  }
  const files = [];
  for (const file of group.files) {
    const data = await fs.readFile(file.path);
    const current = { ...file, data, sha256: sha(data) };
    const old = entry.files[file.name];
    if (old?.messageId && (old.size === undefined || old.size === file.size) && (!old.channelId || old.channelId === channel.id)) {
      if (old.sha256 && old.sha256 !== current.sha256) throw new Error(`${file.name}: legacy投稿後にファイルが変わっています。`);
      continue;
    }
    files.push(current);
  }
  if (!files.length) return;
  let remote = null;
  if (context.remoteCheck || entry.legacySends.some(s => s.status === "sending")) remote = await allMessages(api, channel.id);
  const pending = [];
  const mark = (file, messageId) => {
    entry.files[file.name] = { type: file.type, size: file.size, sha256: file.sha256,
      channelId: channel.id, messageId, mode: "legacy-resume", postedAt: new Date().toISOString() };
  };
  for (const file of files) {
    const ambiguous = entry.legacySends.find(s => s.files.some(f => f.name === file.name));
    if (!ambiguous && remote) {
      const found = remote.filter(m => m.author?.id === user.id && m.attachments?.some(a =>
        (a.filename === file.name || (typeof a.title === "string" && `${a.title}.${file.type}` === file.name)) && a.size === file.size));
      if (found.length > 1) throw new Error(`${file.name}: 同名の既存添付が複数あります。Discord側を確認してください。`);
      if (found.length === 1) { mark(file, found[0].id); continue; }
    }
    pending.push(file);
  }
  await save();
  const byName = new Map(pending.map(f => [f.name, f]));
  for (const send of entry.legacySends.filter(s => s.status !== "done")) {
    const current = send.files.map(f => {
      const file = byName.get(f.name);
      if (!file || file.sha256 !== f.sha256 || file.size !== f.size) throw new Error("Legacy send inputs changed");
      return file;
    });
    if (send.status === "sending") {
      const found = remote.filter(m => matchesBatch(m, current, user.id, send.nonce));
      if (found.length !== 1) throw new Error("既存チャンネルの送信結果が未確定です。重複防止のため再送しません。");
      finishBatch(send, found[0], current, user.id);
      current.forEach(f => { mark(f, found[0].id); byName.delete(f.name); }); await save();
    }
  }
  const queued = new Set(entry.legacySends.filter(s => s.status === "pending").flatMap(s => s.files.map(f => f.name)));
  for (const chunk of batches([...byName.values()].filter(f => !queued.has(f.name)), Math.min(context.maxRequestBytes, 25 * MiB),
    context.uploadMode === "separate" ? 1 : 10)) {
    entry.legacySends.push({ nonce: crypto.randomUUID().replace(/-/g, "").slice(0, 25), status: "pending",
      files: chunk.map(f => ({ name: f.name, size: f.size, sha256: f.sha256 })) });
  }
  await save();
  for (const send of entry.legacySends.filter(s => s.status === "pending")) {
    const current = send.files.map(f => byName.get(f.name));
    send.status = "sending"; await save();
    let message;
    try {
      message = await api.createMessage(channel.id, { nonce: send.nonce, enforce_nonce: true, flags: SUPPRESS_NOTIFICATIONS }, current);
      if (!validId(message?.id) || message.channel_id !== channel.id) throw new Error("Legacy send response invalid");
    } catch (error) { if (definiteRejection(error)) { send.status = "pending"; await save(); } throw error; }
    finishBatch(send, message, current, user.id); current.forEach(f => mark(f, message.id)); await save();
  }
}

async function listForumThreads(api, guildId, forumId) {
  const active = await api.request("GET", `/guilds/${guildId}/threads/active`);
  if (!Array.isArray(active?.threads)) throw new Error("Invalid active Forum thread listing");
  const candidates = active.threads.filter(t => t.parent_id === forumId);
  let before;
  for (;;) {
    const page = await api.request("GET", `/channels/${forumId}/threads/archived/public?limit=100` +
      (before ? `&before=${encodeURIComponent(before)}` : ""));
    if (!Array.isArray(page?.threads) || typeof page.has_more !== "boolean" ||
      page.threads.some(t => t.parent_id !== forumId)) throw new Error("Invalid archived Forum thread listing");
    candidates.push(...page.threads);
    if (!page.has_more) break;
    const cursor = page.threads.at(-1)?.thread_metadata?.archive_timestamp;
    if (!cursor || cursor === before) throw new Error("Archived thread pagination failed");
    before = cursor;
  }
  return [...new Map(candidates.map(t => [t.id, t])).values()];
}

async function recoverThread(context, firstFiles) {
  const { api, guildId, forum, album, user, group } = context;
  const candidates = (await listForumThreads(api, guildId, forum.id)).filter(t => t.name === title(group.baseName));
  const found = [];
  for (const thread of candidates) {
    const message = await api.request("GET", `/channels/${thread.id}/messages/${thread.id}`);
    if (thread.type === 11 && thread.guild_id === guildId && message?.id === thread.id &&
      message.channel_id === thread.id && matchesBatch(message, firstFiles, user.id)) found.push({ thread, message });
  }
  if (found.length !== 1) throw new Error(`${group.baseName}: 初回投稿の結果が未確定です。重複防止のため再送せず停止しました。Discord側の投稿を確認してください。`);
  album.threadId = found[0].thread.id;
  finishBatch(album.batches[0], found[0].message, firstFiles, user.id);
  await context.save();
}

async function uploadAlbum(context) {
  const { api, album, group, forum, user, save } = context;
  const assets = await albumFiles(group, context);
  if (assets.fingerprint !== album.fingerprint) throw new Error("Forum inputs changed during execution");
  validateAlbumPlan(album, assets, context);
  const files = new Map(assets.all.map(f => [f.key, f]));
  const firstFiles = album.batches[0].keys.map(k => files.get(k));
  if (!album.threadId && album.batches[0].status === "sending") await recoverThread(context, firstFiles);
  if (!album.threadId) {
    context.threadIndex.names ||= new Set((await listForumThreads(api, context.guildId, forum.id)).map(t => t.name));
    if (context.threadIndex.names.has(title(group.baseName))) throw new Error(`${group.baseName}: 同名の作品投稿が既に存在します。元のmanifestを確認してください。重複投稿はしません。`);
    album.batches[0].status = "sending"; await save();
    let thread;
    const firstPost = context.notification.firstPost;
    const starterFlags = firstPost?.workName === group.baseName && firstPost.nonce === album.batches[0].nonce &&
      context.threadIndex.names.size === 0
      ? 0 : SUPPRESS_NOTIFICATIONS;
    try { thread = await api.createForumThread(forum.id, {
      name: title(group.baseName), auto_archive_duration: 1440, message: { flags: starterFlags },
    }, firstFiles);
      if (!validId(thread?.id) || !validId(thread.message?.id) || thread.type !== 11 ||
        thread.parent_id !== forum.id || thread.guild_id !== context.guildId || thread.name !== title(group.baseName) ||
        thread.message.id !== thread.id || thread.message.channel_id !== thread.id) {
        throw new Error("初回投稿の応答が不正です。結果を照合してから再開します。");
      }
    }
    catch (error) { if (definiteRejection(error)) { album.batches[0].status = "pending"; await save(); } throw error; }
    album.threadId = thread.id;
    context.threadIndex.names.add(thread.name);
    // Validate before marking done; malformed 2xx responses remain recoverable.
    finishBatch(album.batches[0], thread.message, firstFiles, user.id);
    await save();
  }
  const thread = await api.request("GET", `/channels/${album.threadId}`);
  if (thread.type !== 11 || thread.parent_id !== forum.id || thread.guild_id !== context.guildId || thread.name !== title(group.baseName)) {
    throw new Error("Saved work thread has a different parent/guild/type/name");
  }
  if (thread.thread_metadata?.locked && album.batches.some(b => b.status !== "done")) throw new Error("作品のスレッドがロックされています。");
  let messages = null;
  if (context.remoteCheck || album.batches.some(b => b.status === "sending")) messages = await allMessages(api, thread.id);
  for (let index = 0; index < album.batches.length; index++) {
    const batch = album.batches[index];
    const current = batch.keys.map(k => files.get(k));
    if (batch.status === "done") {
      const message = messages?.find(m => m.id === batch.messageId && m.author?.id === user.id);
      if (messages && (!message || !attachmentSizesMatch(message, current) ||
        (batch.attachments && batch.attachments.some((a, i) =>
          message.attachments[i].id !== a.id || message.attachments[i].filename !== a.name || message.attachments[i].size !== a.size)))) {
        throw new Error("投稿済みメッセージ/添付が一致しません。削除/権限を確認してください。自動再送はしません。");
      }
      if (message && !batch.attachments) { finishBatch(batch, message, current, user.id); await save(); }
      continue;
    }
    if (batch.status === "sending") {
      const found = messages.filter(m => matchesBatch(m, current, user.id, batch.nonce));
      if (found.length !== 1) throw new Error("送信結果が未確定です。重複防止のため再送せず停止しました。Discord側を確認してください。");
      finishBatch(batch, found[0], current, user.id); await save(); continue;
    }
    batch.status = "sending"; await save();
    console.log(`[${context.category.name}] ${group.baseName}: ${index + 1}/${album.batches.length} uploading ${current.length} ${current[0].type === "image" ? "images" : "ZIP/PDF files"}`);
    let message;
    try { message = await api.createMessage(thread.id, { nonce: batch.nonce, enforce_nonce: true, flags: SUPPRESS_NOTIFICATIONS }, current);
      if (!validId(message?.id) || message.channel_id !== thread.id) throw new Error("追加投稿の応答が不正です。結果を照合してから再開します。");
    }
    catch (error) { if (definiteRejection(error)) { batch.status = "pending"; await save(); } throw error; }
    finishBatch(batch, message, current, user.id); await save();
  }
  console.log(`[${context.category.name}] ${group.baseName}: ${album.imageCount} images + ZIP/PDF complete / ${album.threadId}`);
}

module.exports = { prepareForumPlan, executeForumPlan, effectivePermissions, makeAlbumPlan, batches };
