#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");

const API_BASE = "https://discord.com/api/v10";
const CHANNEL_TYPES = {
  GUILD_TEXT: 0,
  GUILD_CATEGORY: 4,
};

class DiscordApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = "DiscordApiError";
    this.status = status;
    this.body = body;
  }
}

class DiscordApi {
  constructor(token) {
    this.token = token;
  }

  async request(method, route, options = {}) {
    const url = `${API_BASE}${route}`;
    const headers = {
      Authorization: `Bot ${this.token}`,
      "User-Agent": "discord-post-tool/0.1.0",
    };

    let body;
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    } else if (options.form !== undefined) {
      body = options.form;
    }

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const response = await fetch(url, {
        method,
        headers,
        body,
      });

      if (response.status === 429) {
        const retryAfter = await readRetryAfter(response);
        console.log(`Rate limited. Waiting ${retryAfter.toFixed(2)}s...`);
        await sleep(Math.ceil(retryAfter * 1000) + 250);
        continue;
      }

      const responseText = await response.text();
      if (!response.ok) {
        throw new DiscordApiError(
          `${method} ${route} failed with HTTP ${response.status}`,
          response.status,
          responseText
        );
      }

      await respectRateLimitHeaders(response);

      if (response.status === 204 || responseText.trim() === "") {
        return null;
      }

      return JSON.parse(responseText);
    }

    throw new Error(`${method} ${route} failed after repeated rate limit retries.`);
  }

  getGuildChannels(guildId) {
    return this.request("GET", `/guilds/${guildId}/channels`);
  }

  createGuildChannel(guildId, payload) {
    return this.request("POST", `/guilds/${guildId}/channels`, { json: payload });
  }

  getRecentMessages(channelId, limit = 100) {
    return this.request("GET", `/channels/${channelId}/messages?limit=${limit}`);
  }

  async createMessage(channelId, payload, files) {
    const form = new FormData();
    const attachments = [];

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const bytes = await fs.readFile(file.path);
      const blob = new Blob([bytes], { type: file.mime });
      form.append(`files[${index}]`, blob, file.name);
      attachments.push({
        id: index,
        filename: file.name,
      });
    }

    form.append(
      "payload_json",
      JSON.stringify({
        ...payload,
        allowed_mentions: { parse: [] },
        attachments,
      })
    );

    return this.request("POST", `/channels/${channelId}/messages`, { form });
  }
}

async function main() {
  await loadDotEnv(path.resolve(process.cwd(), ".env"));

  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || "help";

  if (command === "help" || args.help || args.h) {
    printHelp();
    return;
  }

  if (!["plan", "run"].includes(command)) {
    throw new Error(`Unknown command: ${command}`);
  }

  const inputDir = path.resolve(process.cwd(), String(args.input || "./example"));
  const uploadMode = String(args["upload-mode"] || "auto").toLowerCase();
  if (!["auto", "bundle", "separate"].includes(uploadMode)) {
    throw new Error("--upload-mode must be one of: auto, bundle, separate");
  }

  const maxFileMiB = readNumberArg(args, "max-file-mib", 10);
  const maxRequestMiB = readNumberArg(args, "max-request-mib", 25);
  const limit = args.limit === undefined ? null : readIntegerArg(args, "limit", 1);
  const categoryFilter = args.category ? String(args.category) : null;
  const remoteCheck = args["remote-check"] !== false;
  const recreateMissing = args["recreate-missing"] !== false;
  const manifestPath = path.resolve(
    process.cwd(),
    String(args.manifest || ".discord-post-tool-manifest.json")
  );

  const plan = await buildLocalPlan(inputDir, {
    categoryFilter,
    limit,
    maxFileBytes: mibToBytes(maxFileMiB),
    maxRequestBytes: mibToBytes(maxRequestMiB),
  });

  printPlan(plan, {
    uploadMode,
    maxFileMiB,
    maxRequestMiB,
    categoryFilter,
    limit,
  });

  if (command === "plan") {
    return;
  }

  const guildId = String(args.guild || process.env.DISCORD_GUILD_ID || "").trim();
  const token = String(args.token || process.env.DISCORD_BOT_TOKEN || "").trim();

  if (!guildId) {
    throw new Error("Guild ID is required. Use --guild or DISCORD_GUILD_ID.");
  }
  if (!token) {
    throw new Error("Bot token is required. Use --token or DISCORD_BOT_TOKEN.");
  }
  if (!args.yes && !args.y) {
    throw new Error("Run requires --yes to avoid accidental channel creation/uploads.");
  }

  assertRunnablePlan(plan);

  const manifest = await loadManifest(manifestPath);
  const api = new DiscordApi(token);

  await executePlan({
    api,
    guildId,
    plan,
    manifest,
    manifestPath,
    uploadMode,
    remoteCheck,
    recreateMissing,
    maxRequestBytes: mibToBytes(maxRequestMiB),
  });
}

async function buildLocalPlan(inputDir, options) {
  const inputStat = await fs.stat(inputDir).catch(() => null);
  if (!inputStat || !inputStat.isDirectory()) {
    throw new Error(`Input directory does not exist: ${inputDir}`);
  }

  const entries = await fs.readdir(inputDir, { withFileTypes: true });
  const categoryDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !options.categoryFilter || name === options.categoryFilter)
    .sort(compareNames);

  if (options.categoryFilter && categoryDirs.length === 0) {
    throw new Error(`Category directory was not found: ${options.categoryFilter}`);
  }

  const categories = [];
  let remainingLimit = options.limit;

  for (const categoryName of categoryDirs) {
    const categoryPath = path.join(inputDir, categoryName);
    const fileEntries = await fs.readdir(categoryPath, { withFileTypes: true });
    const fileGroups = new Map();

    for (const entry of fileEntries) {
      if (!entry.isFile()) {
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (ext !== ".zip" && ext !== ".pdf") {
        continue;
      }

      const fileBaseName = path.basename(entry.name, ext);
      const parsedBaseName = parsePartFileBaseName(fileBaseName);
      const groupBaseName = parsedBaseName.groupBaseName;
      if (!fileGroups.has(groupBaseName)) {
        fileGroups.set(groupBaseName, {
          baseName: groupBaseName,
          channelName: "",
          files: [],
          warnings: [],
        });
      }

      const filePath = path.join(categoryPath, entry.name);
      const stat = await fs.stat(filePath);
      const type = ext.slice(1);
      fileGroups.get(groupBaseName).files.push({
        type,
        name: entry.name,
        path: filePath,
        size: stat.size,
        mime: ext === ".pdf" ? "application/pdf" : "application/zip",
        fileBaseName,
        part: parsedBaseName.part,
      });
    }

    const groups = Array.from(fileGroups.values()).sort((a, b) =>
      compareNames(a.baseName, b.baseName)
    );

    for (const group of groups) {
      group.files.sort(compareUploadFiles);
    }

    assignUniqueChannelNames(groups);

    for (const group of groups) {
      for (const part of groupParts(group)) {
        if (!part.files.zip) {
          group.warnings.push(`${part.label}: zip file is missing`);
        }
        if (!part.files.pdf) {
          group.warnings.push(`${part.label}: pdf file is missing`);
        }
      }

      const files = groupFiles(group);
      for (const file of files) {
        if (file.size > options.maxFileBytes) {
          group.warnings.push(`${file.name} exceeds max file size`);
        }
      }

      const requestSize = sumSizes(files);
      if (requestSize > options.maxRequestBytes) {
        group.warnings.push("all files exceed max request size; auto mode will upload separately");
      }
    }

    let selectedGroups = groups;
    if (remainingLimit !== null) {
      selectedGroups = groups.slice(0, remainingLimit);
      remainingLimit -= selectedGroups.length;
    }

    categories.push({
      name: categoryName,
      path: categoryPath,
      groups: selectedGroups,
      originalGroupCount: groups.length,
      warnings: selectedGroups.length > 50 ? ["Discord categories can contain up to 50 channels"] : [],
    });

    if (remainingLimit !== null && remainingLimit <= 0) {
      break;
    }
  }

  const totals = categories.reduce(
    (acc, category) => {
      acc.categories += 1;
      acc.groups += category.groups.length;
      for (const group of category.groups) {
        const files = groupFiles(group);
        acc.files += files.length;
        acc.bytes += sumSizes(files);
      }
      return acc;
    },
    { categories: 0, groups: 0, files: 0, bytes: 0 }
  );

  return {
    inputDir,
    categories,
    totals,
  };
}

function assignUniqueChannelNames(groups) {
  const counts = new Map();

  for (const group of groups) {
    const desiredName = sanitizeChannelName(group.baseName);
    const seen = counts.get(desiredName) || 0;
    counts.set(desiredName, seen + 1);

    if (seen === 0) {
      group.channelName = desiredName;
      continue;
    }

    const suffix = `-${seen + 1}`;
    group.channelName = truncateChannelName(desiredName, suffix.length) + suffix;
    group.warnings.push(`channel name duplicated; renamed to ${group.channelName}`);
  }
}

function sanitizeChannelName(name) {
  const normalized = name
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[\\/#?%&{}<>*+$!'":;,@`|=\[\]()]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  return truncateChannelName(normalized || "file", 0);
}

function truncateChannelName(value, reservedChars) {
  const maxLength = 100 - reservedChars;
  const chars = Array.from(value);
  return chars.length > maxLength ? chars.slice(0, maxLength).join("") : value;
}

function groupFiles(group) {
  return [...group.files].sort(compareUploadFiles);
}

function groupParts(group) {
  const parts = new Map();

  for (const file of group.files) {
    const key = file.part ? `${file.part.start}-${file.part.end}` : file.fileBaseName;
    if (!parts.has(key)) {
      parts.set(key, {
        label: file.part ? key : file.fileBaseName,
        start: file.part ? file.part.start : Number.MAX_SAFE_INTEGER,
        end: file.part ? file.part.end : Number.MAX_SAFE_INTEGER,
        files: {},
      });
    }
    parts.get(key).files[file.type] = file;
  }

  return Array.from(parts.values()).sort((a, b) => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }
    return compareNames(a.label, b.label);
  });
}

function parsePartFileBaseName(fileBaseName) {
  const match = fileBaseName.match(/^(.*)_([1-9]\d*)-([1-9]\d*)$/);
  if (!match) {
    return {
      groupBaseName: fileBaseName,
      part: null,
    };
  }

  const start = Number(match[2]);
  const end = Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) {
    return {
      groupBaseName: fileBaseName,
      part: null,
    };
  }

  return {
    groupBaseName: match[1],
    part: {
      start,
      end,
    },
  };
}

function compareUploadFiles(a, b) {
  const aStart = a.part ? a.part.start : Number.MAX_SAFE_INTEGER;
  const bStart = b.part ? b.part.start : Number.MAX_SAFE_INTEGER;
  if (aStart !== bStart) {
    return aStart - bStart;
  }

  const aEnd = a.part ? a.part.end : Number.MAX_SAFE_INTEGER;
  const bEnd = b.part ? b.part.end : Number.MAX_SAFE_INTEGER;
  if (aEnd !== bEnd) {
    return aEnd - bEnd;
  }

  const typeOrder = { zip: 0, pdf: 1 };
  if (typeOrder[a.type] !== typeOrder[b.type]) {
    return typeOrder[a.type] - typeOrder[b.type];
  }

  return compareNames(a.name, b.name);
}

function printPlan(plan, options) {
  console.log(`Input: ${plan.inputDir}`);
  console.log(
    `Plan: ${plan.totals.categories} categories, ${plan.totals.groups} channels, ` +
      `${plan.totals.files} files, ${formatBytes(plan.totals.bytes)}`
  );
  console.log(
    `Upload mode: ${options.uploadMode} / max file ${options.maxFileMiB} MiB / ` +
      `max bundled request ${options.maxRequestMiB} MiB`
  );
  if (options.categoryFilter) {
    console.log(`Category filter: ${options.categoryFilter}`);
  }
  if (options.limit !== null) {
    console.log(`Limit: ${options.limit} channel(s)`);
  }

  for (const category of plan.categories) {
    const suffix =
      category.groups.length === category.originalGroupCount
        ? ""
        : ` (${category.groups.length}/${category.originalGroupCount} selected)`;
    console.log("");
    console.log(`[${category.name}] ${category.groups.length} channel(s)${suffix}`);

    for (const warning of category.warnings) {
      console.log(`  ! ${warning}`);
    }

    for (const group of category.groups) {
      const files = groupFiles(group)
        .map((file) => `${file.name} ${formatBytes(file.size)}`)
        .join(", ");
      const renameNote =
        sanitizeChannelName(group.baseName) === group.channelName
          ? ""
          : ` (channel: ${group.channelName})`;
      console.log(`  # ${group.channelName}${renameNote}`);
      console.log(`    ${files || "no uploadable files"}`);
      for (const warning of group.warnings) {
        console.log(`    ! ${warning}`);
      }
    }
  }
}

function assertRunnablePlan(plan) {
  const problems = [];
  for (const category of plan.categories) {
    if (category.groups.length > 50) {
      problems.push(`${category.name}: more than 50 channels`);
    }

    for (const group of category.groups) {
      for (const warning of group.warnings) {
        if (warning.includes("exceeds max file size")) {
          problems.push(`${category.name}/${group.baseName}: ${warning}`);
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(`Cannot run because the plan has blocking issue(s):\n${problems.join("\n")}`);
  }
}

async function executePlan(context) {
  const { api, guildId, plan, manifest, manifestPath, recreateMissing } = context;
  const guildManifest = ensureGuildManifest(manifest, guildId);

  console.log("");
  console.log("Fetching Discord channels...");
  const channels = await api.getGuildChannels(guildId);
  const state = buildRemoteState(channels);

  for (const category of plan.categories) {
    const categoryChannel = await ensureCategory({
      api,
      guildId,
      category,
      state,
      guildManifest,
      manifest,
      manifestPath,
      recreateMissing,
    });

    const childCount = countChildren(state.channels, categoryChannel.id);
    const channelsToCreate = category.groups.filter(
      (group) => !findTextChannelByName(state.channels, categoryChannel.id, group.channelName)
    ).length;
    if (childCount + channelsToCreate > 50) {
      throw new Error(
        `${category.name} would exceed Discord's 50-channel category limit ` +
          `(${childCount} existing + ${channelsToCreate} new).`
      );
    }

    for (const group of category.groups) {
      const textChannel = await ensureTextChannel({
        api,
        guildId,
        category,
        categoryChannel,
        group,
        state,
        guildManifest,
        manifest,
        manifestPath,
        recreateMissing,
      });

      await uploadGroup({
        ...context,
        category,
        group,
        channel: textChannel,
      });
    }
  }

  await saveManifest(manifestPath, manifest);
  console.log("");
  console.log("Done.");
}

async function ensureCategory(context) {
  const {
    api,
    guildId,
    category,
    state,
    guildManifest,
    manifest,
    manifestPath,
    recreateMissing,
  } = context;
  const categoryManifest = ensureCategoryManifest(guildManifest, category.name);
  const existing =
    (categoryManifest.id ? findCategoryById(state.channels, categoryManifest.id) : null) ||
    findSingleCategoryByName(state.channels, category.name, categoryManifest.id);

  if (existing) {
    categoryManifest.id = existing.id;
    categoryManifest.name = existing.name;
    await saveManifest(manifestPath, manifest);
    console.log(`[${category.name}] Using existing category ${existing.id}`);
    return existing;
  }

  if (categoryManifest.id && !recreateMissing) {
    throw new Error(
      `[${category.name}] manifest points to category ${categoryManifest.id}, but the bot cannot see it. ` +
        "Rerun without --no-recreate-missing to recreate it."
    );
  }

  console.log(`[${category.name}] Creating category...`);
  const created = await api.createGuildChannel(guildId, {
    name: category.name,
    type: CHANNEL_TYPES.GUILD_CATEGORY,
  });
  state.channels.push(created);
  categoryManifest.id = created.id;
  categoryManifest.name = created.name;
  await saveManifest(manifestPath, manifest);
  return created;
}

async function ensureTextChannel(context) {
  const {
    api,
    guildId,
    category,
    categoryChannel,
    group,
    state,
    guildManifest,
    manifest,
    manifestPath,
    recreateMissing,
  } = context;
  const groupManifest = ensureGroupManifest(guildManifest, category.name, group.baseName);
  const existing =
    (groupManifest.channelId
      ? findTextChannelById(state.channels, categoryChannel.id, groupManifest.channelId)
      : null) ||
    findSingleTextChannelByName(
      state.channels,
      categoryChannel.id,
      group.channelName,
      groupManifest.channelId
    );

  if (existing) {
    resetPostedFilesIfChannelChanged(groupManifest, existing.id);
    groupManifest.channelId = existing.id;
    groupManifest.channelName = existing.name;
    await saveManifest(manifestPath, manifest);
    console.log(`[${category.name}] #${group.channelName}: using existing channel ${existing.id}`);
    return existing;
  }

  if (groupManifest.channelId && !recreateMissing) {
    throw new Error(
      `[${category.name}] #${group.channelName} manifest points to channel ${groupManifest.channelId}, ` +
        "but the bot cannot see it. Rerun without --no-recreate-missing to recreate it."
    );
  }

  console.log(`[${category.name}] #${group.channelName}: creating channel...`);
  const created = await api.createGuildChannel(guildId, {
    name: group.channelName,
    type: CHANNEL_TYPES.GUILD_TEXT,
    parent_id: categoryChannel.id,
    topic: group.baseName,
  });
  state.channels.push(created);
  resetPostedFilesIfChannelChanged(groupManifest, created.id);
  groupManifest.channelId = created.id;
  groupManifest.channelName = created.name;
  await saveManifest(manifestPath, manifest);
  return created;
}

function resetPostedFilesIfChannelChanged(groupManifest, channelId) {
  if (groupManifest.channelId && groupManifest.channelId !== channelId) {
    groupManifest.files = {};
  }
}

async function uploadGroup(context) {
  const {
    api,
    category,
    group,
    channel,
    manifest,
    manifestPath,
    guildId,
    uploadMode,
    remoteCheck,
    maxRequestBytes,
  } = context;
  const groupManifest = ensureGroupManifest(
    ensureGuildManifest(manifest, guildId),
    category.name,
    group.baseName
  );
  const files = groupFiles(group);
  const remoteFileNames = remoteCheck ? await getRemoteAttachmentNames(api, channel, group) : null;
  const pending = files.filter((file) => {
    if (isPosted(groupManifest, file, channel.id)) {
      return false;
    }
    if (remoteFileNames?.has(file.name)) {
      return false;
    }
    return true;
  });

  for (const file of files) {
    if (remoteFileNames?.has(file.name) && !isPosted(groupManifest, file, channel.id)) {
      markPosted(groupManifest, file, {
        messageId: "remote-detected",
        mode: "remote-check",
        channelId: channel.id,
      });
    }
  }

  if (pending.length === 0) {
    console.log(`[${category.name}] #${group.channelName}: files already posted`);
    await saveManifest(manifestPath, manifest);
    return;
  }

  const shouldBundle =
    uploadMode === "bundle" ||
    (uploadMode === "auto" && pending.length > 1 && sumSizes(pending) <= maxRequestBytes);

  if (shouldBundle) {
    try {
      console.log(
        `[${category.name}] #${group.channelName}: uploading ${pending.length} file(s) together...`
      );
      const message = await api.createMessage(
        channel.id,
        {},
        pending
      );
      for (const file of pending) {
        markPosted(groupManifest, file, {
          messageId: message.id,
          mode: "bundle",
          channelId: channel.id,
        });
      }
      await saveManifest(manifestPath, manifest);
      return;
    } catch (error) {
      if (uploadMode !== "auto" || pending.length <= 1 || !looksLikeUploadSizeError(error)) {
        throw error;
      }
      console.log(
        `[${category.name}] #${group.channelName}: bundled upload was rejected; retrying separately...`
      );
    }
  }

  for (const file of pending) {
    console.log(`[${category.name}] #${group.channelName}: uploading ${file.name}...`);
    let message;
    try {
      message = await api.createMessage(channel.id, {}, [file]);
    } catch (error) {
      if (looksLikeUploadSizeError(error)) {
        throw new Error(
          `Discord rejected ${file.name} (${formatBytes(file.size)}) because it is too large ` +
            "for the current bot/server upload limit. User Nitro does not raise a bot token's " +
            "upload limit. Use a boosted server limit, reduce the file size, or post an external link."
        );
      }
      throw error;
    }
    markPosted(groupManifest, file, {
      messageId: message.id,
      mode: "separate",
      channelId: channel.id,
    });
    await saveManifest(manifestPath, manifest);
  }
}

async function getRemoteAttachmentNames(api, channel, group) {
  try {
    const messages = await api.getRecentMessages(channel.id, 100);
    const names = new Set();
    for (const message of messages) {
      for (const attachment of message.attachments || []) {
        names.add(attachment.filename);
      }
    }
    return names;
  } catch (error) {
    console.log(
      `#${group.channelName}: could not check existing messages; relying on manifest only.`
    );
    return null;
  }
}

function buildRemoteState(channels) {
  return { channels: [...channels] };
}

function findCategoryById(channels, id) {
  return channels.find(
    (channel) => channel.type === CHANNEL_TYPES.GUILD_CATEGORY && channel.id === id
  );
}

function findCategoryByName(channels, name) {
  return channels.find(
    (channel) => channel.type === CHANNEL_TYPES.GUILD_CATEGORY && channel.name === name
  );
}

function findSingleCategoryByName(channels, name, missingPreferredId = null) {
  const matches = channels.filter(
    (channel) => channel.type === CHANNEL_TYPES.GUILD_CATEGORY && channel.name === name
  );
  if (matches.length === 1) {
    if (missingPreferredId && matches[0].id !== missingPreferredId) {
      console.log(
        `[${name}] manifest category ${missingPreferredId} was not visible; relinking to existing category ${matches[0].id}.`
      );
    }
    return matches[0];
  }
  if (missingPreferredId && matches.length > 1) {
    throw new Error(
      `[${name}] manifest category ${missingPreferredId} was not visible, and ${matches.length} categories with the same name exist. ` +
        "Delete/rename duplicates or specify a clean manifest before rerunning."
    );
  }
  return null;
}

function findTextChannelById(channels, parentId, id) {
  return channels.find(
    (channel) =>
      channel.type === CHANNEL_TYPES.GUILD_TEXT &&
      channel.parent_id === parentId &&
      channel.id === id
  );
}

function findTextChannelByName(channels, parentId, name) {
  return channels.find(
    (channel) =>
      channel.type === CHANNEL_TYPES.GUILD_TEXT &&
      channel.parent_id === parentId &&
      channel.name === name
  );
}

function findSingleTextChannelByName(channels, parentId, name, missingPreferredId = null) {
  const matches = channels.filter(
    (channel) =>
      channel.type === CHANNEL_TYPES.GUILD_TEXT &&
      channel.parent_id === parentId &&
      channel.name === name
  );
  if (matches.length === 1) {
    if (missingPreferredId && matches[0].id !== missingPreferredId) {
      console.log(
        `#${name}: manifest channel ${missingPreferredId} was not visible; relinking to existing channel ${matches[0].id}.`
      );
    }
    return matches[0];
  }
  if (missingPreferredId && matches.length > 1) {
    throw new Error(
      `#${name}: manifest channel ${missingPreferredId} was not visible, and ${matches.length} channels with the same name exist in this category. ` +
        "Delete/rename duplicates or specify a clean manifest before rerunning."
    );
  }
  return null;
}

function countChildren(channels, parentId) {
  return channels.filter((channel) => channel.parent_id === parentId).length;
}

async function loadManifest(manifestPath) {
  try {
    const text = await fs.readFile(manifestPath, "utf8");
    return JSON.parse(text);
  } catch (error) {
    if (error.code === "ENOENT") {
      return { version: 1, guilds: {} };
    }
    throw error;
  }
}

async function saveManifest(manifestPath, manifest) {
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  const tmpPath = `${manifestPath}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await fs.rename(tmpPath, manifestPath);
}

function ensureGuildManifest(manifest, guildId) {
  manifest.guilds ||= {};
  manifest.guilds[guildId] ||= { categories: {} };
  manifest.guilds[guildId].categories ||= {};
  return manifest.guilds[guildId];
}

function ensureCategoryManifest(guildManifest, categoryName) {
  guildManifest.categories[categoryName] ||= {
    id: null,
    name: categoryName,
    groups: {},
  };
  guildManifest.categories[categoryName].groups ||= {};
  return guildManifest.categories[categoryName];
}

function ensureGroupManifest(guildManifest, categoryName, baseName) {
  const category = ensureCategoryManifest(guildManifest, categoryName);
  category.groups[baseName] ||= {
    channelId: null,
    channelName: null,
    files: {},
  };
  category.groups[baseName].files ||= {};
  return category.groups[baseName];
}

function isPosted(groupManifest, file, channelId) {
  const entry = groupManifest.files?.[file.name];
  if (!entry?.messageId) {
    return false;
  }

  if (entry.size !== undefined && entry.size !== file.size) {
    return false;
  }

  if (entry.channelId) {
    return entry.channelId === channelId;
  }

  return !groupManifest.channelId || groupManifest.channelId === channelId;
}

function markPosted(groupManifest, file, details) {
  groupManifest.files[file.name] = {
    type: file.type,
    size: file.size,
    channelId: details.channelId,
    messageId: details.messageId,
    mode: details.mode,
    postedAt: new Date().toISOString(),
  };
}

function looksLikeUploadSizeError(error) {
  if (!(error instanceof DiscordApiError)) {
    return false;
  }
  const body = String(error.body || "").toLowerCase();
  return (
    error.status === 413 ||
    body.includes("request entity too large") ||
    body.includes("maximum file size") ||
    body.includes("file size") ||
    body.includes("payload too large")
  );
}

async function readRetryAfter(response) {
  const retryHeader = response.headers.get("retry-after");
  if (retryHeader) {
    return Number(retryHeader);
  }

  const body = await response.json().catch(() => ({}));
  return Number(body.retry_after || 1);
}

async function respectRateLimitHeaders(response) {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const resetAfter = response.headers.get("x-ratelimit-reset-after");
  if (remaining === "0" && resetAfter) {
    const seconds = Number(resetAfter);
    if (Number.isFinite(seconds) && seconds > 0 && seconds < 5) {
      await sleep(Math.ceil(seconds * 1000) + 100);
    }
  }
}

async function loadDotEnv(envPath) {
  let text;
  try {
    text = await fs.readFile(envPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) {
      continue;
    }

    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function parseArgs(argv) {
  const parsed = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("-") || arg === "-") {
      parsed._.push(arg);
      continue;
    }

    if (arg === "--") {
      parsed._.push(...argv.slice(index + 1));
      break;
    }

    const long = arg.startsWith("--");
    const body = long ? arg.slice(2) : arg.slice(1);
    const equalsIndex = body.indexOf("=");
    let key = body;
    let value = true;

    if (equalsIndex !== -1) {
      key = body.slice(0, equalsIndex);
      value = body.slice(equalsIndex + 1);
    } else if (key.startsWith("no-")) {
      key = key.slice(3);
      value = false;
    } else if (argv[index + 1] && !argv[index + 1].startsWith("-")) {
      value = argv[index + 1];
      index += 1;
    }

    parsed[key] = value;
  }

  return parsed;
}

function readNumberArg(args, name, defaultValue) {
  const raw = args[name] === undefined ? defaultValue : args[name];
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`--${name} must be a positive number`);
  }
  return value;
}

function readIntegerArg(args, name, minValue) {
  const value = readNumberArg(args, name, minValue);
  if (!Number.isInteger(value) || value < minValue) {
    throw new Error(`--${name} must be an integer >= ${minValue}`);
  }
  return value;
}

function compareNames(a, b) {
  return a.localeCompare(b, "ja");
}

function sumSizes(files) {
  return files.reduce((sum, file) => sum + file.size, 0);
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function mibToBytes(mib) {
  return mib * 1024 * 1024;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printHelp() {
  console.log(`discord-post-tool

Usage:
  node src/cli.js plan --input ./example
  node src/cli.js run --guild <server_id> --input ./example --yes

Environment:
  DISCORD_BOT_TOKEN   Bot token used for Discord API calls
  DISCORD_GUILD_ID    Target server ID

Commands:
  plan                 Read local folders and show categories/channels/files
  run                  Create missing categories/channels and upload files

Options:
  --input <path>       Input folder. Default: ./example
  --guild <id>         Discord server ID. Required for run unless env is set
  --token <token>      Discord bot token. Required for run unless env is set
  --upload-mode <mode> auto | bundle | separate. Default: auto
  --manifest <path>    Manifest path. Default: ./.discord-post-tool-manifest.json
  --category <name>    Only process one category directory
  --limit <n>          Process only the first n planned channels
  --max-file-mib <n>   Per-file preflight limit. Default: 10
  --max-request-mib <n> Bundled upload preflight limit. Default: 25
  --no-remote-check    Do not check recent messages for existing attachments
  --no-recreate-missing Stop instead of recreating manifest-tracked categories/channels if missing
  --yes                Required by run
`);
}

main().catch((error) => {
  console.error("");
  console.error(error.message);
  if (error instanceof DiscordApiError && error.body) {
    console.error(error.body);
  }
  process.exitCode = 1;
});
