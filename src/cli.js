#!/usr/bin/env node

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { withResources, canonicalPath } = require("./runtime-locks");
const { discordFetch } = require("./discord-request");
const { prepareForumPlan, executeForumPlan } = require("./forum-post");
const { own, put } = require("./forum-folders");

const API_BASE = "https://discord.com/api/v10";
const CHANNEL_TYPES = {
  GUILD_TEXT: 0,
  GUILD_CATEGORY: 4,
};
const MANIFEST_STAGING_DIR_NAME = ".discord-post-tool-manifest-staging";

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

    const response = await discordFetch(this.token, url, { method, headers, body }, {
      onRateLimit: (seconds) => console.log(`Rate limited. Waiting ${seconds.toFixed(2)}s...`),
    });
    const responseText = await response.text();
    if (!response.ok) {
      throw new DiscordApiError(
        `${method} ${route} failed with HTTP ${response.status}`,
        response.status,
        responseText
      );
    }
    if (response.status === 204 || responseText.trim() === "") return null;
    return JSON.parse(responseText);
  }

  getGuildChannels(guildId) {
    return this.request("GET", `/guilds/${guildId}/channels`);
  }

  createGuildChannel(guildId, payload) {
    return this.request("POST", `/guilds/${guildId}/channels`, { json: payload });
  }

  getRecentMessages(channelId, limit = 100, before = null) {
    return this.request("GET", `/channels/${channelId}/messages?limit=${limit}` +
      (before ? `&before=${encodeURIComponent(before)}` : ""));
  }

  async attachmentForm(payload, files, forum = false) {
    const form = new FormData();
    const attachments = [];

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const bytes = file.data || await fs.readFile(file.path);
      const blob = new Blob([bytes], { type: file.mime });
      form.append(`files[${index}]`, blob, file.name);
      attachments.push({
        id: index,
        filename: file.name,
      });
    }

    form.append(
      "payload_json",
      JSON.stringify(forum ? {
        ...payload, message: { ...payload.message, allowed_mentions: { parse: [] }, attachments },
      } : { ...payload, allowed_mentions: { parse: [] }, attachments })
    );

    return form;
  }

  async createMessage(channelId, payload, files) {
    return this.request("POST", `/channels/${channelId}/messages`, {
      form: await this.attachmentForm(payload, files),
    });
  }

  async createForumThread(forumId, payload, files) {
    return this.request("POST", `/channels/${forumId}/threads`, {
      form: await this.attachmentForm(payload, files, true),
    });
  }
}

async function main(options = {}) {
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
  const postingLayout = String(args["posting-layout"] || "forum").toLowerCase();
  const forumLayout = String(args["forum-layout"] || "gallery").toLowerCase();
  const forumParent = args["forum-parent"] ? String(args["forum-parent"]).trim() : null;
  if (!["forum", "channels"].includes(postingLayout)) throw new Error("--posting-layout must be forum or channels");
  if (!["gallery", "list"].includes(forumLayout)) throw new Error("--forum-layout must be gallery or list");
  if (forumParent && !/^\d+$/.test(forumParent)) throw new Error("--forum-parent must be a Discord category ID");
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

  const guildId = String(args.guild || process.env.DISCORD_GUILD_ID || "").trim();
  const token = String(args.token || process.env.DISCORD_BOT_TOKEN || "").trim();
  const manifestWritePlan = command === "run"
    ? await createManifestWritePlan(manifestPath)
    : null;
  const resources = [{ type: "path", path: inputDir, mode: "read" }];
  if (command === "run") {
    if (!guildId) {
      throw new Error("Guild ID is required. Use --guild or DISCORD_GUILD_ID.");
    }
    if (!token) {
      throw new Error("Bot token is required. Use --token or DISCORD_BOT_TOKEN.");
    }
    if (!args.yes && !args.y) {
      throw new Error("Run requires --yes to avoid accidental channel creation/uploads.");
    }
    resources.push(
      { type: "guild", key: guildId },
      { type: "path", path: manifestWritePlan.manifestPath, mode: "write" },
      { type: "path", path: manifestWritePlan.stagingDir, mode: "write" }
    );
  }
  await withResources(resources, async () => {
    const plan = await buildLocalPlan(inputDir, {
      categoryFilter,
      limit,
      maxFileBytes: mibToBytes(maxFileMiB),
      maxRequestBytes: mibToBytes(maxRequestMiB),
      postingLayout,
    });
    assertRunnablePlan(plan, postingLayout);
    if (plan.hasNestedLayout && forumParent) {
      throw new Error(
        "--forum-parent cannot be used with the category/forum folder layout; leave it empty so each folder category is resolved by name."
      );
    }
    await validateGeneratedOutputs(plan);
    const manifest = await loadManifest(manifestWritePlan?.manifestPath || manifestPath);
    if (postingLayout === "forum") await prepareForumPlan({
      plan, manifest, guildId, maxFileBytes: mibToBytes(maxFileMiB),
      maxRequestBytes: mibToBytes(maxRequestMiB), uploadMode,
    });
    printPlan(plan, { uploadMode, maxFileMiB, maxRequestMiB, categoryFilter, limit, postingLayout });
    if (command === "plan") return;
    const api = options.apiFactory ? options.apiFactory(token) : new DiscordApi(token);
    const context = {
      api, guildId, plan, manifest, manifestPath: manifestWritePlan.manifestPath, uploadMode, remoteCheck,
      recreateMissing, maxRequestBytes: mibToBytes(maxRequestMiB), maxFileBytes: mibToBytes(maxFileMiB),
      forumLayout, forumParent, saveManifest,
    };
    await (postingLayout === "forum" ? executeForumPlan(context) : executePlan(context));
  }, {
    runtimeDir: options.runtimeDir,
    label: command === "run" ? "Discord投稿" : "投稿計画",
  });
}

async function buildLocalPlan(inputDir, options = {}) {
  options = {
    ...options,
    categoryFilter: options.categoryFilter ?? null,
    limit: options.limit === undefined ? null : options.limit,
    postingLayout: options.postingLayout || "channels",
  };
  const inputStat = await fs.stat(inputDir).catch(() => null);
  if (!inputStat || !inputStat.isDirectory()) {
    throw new Error(`Input directory does not exist: ${inputDir}`);
  }

  const entries = await fs.readdir(inputDir, { withFileTypes: true });
  const categoryDirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !isManifestStagingDirectory(name))
    .filter((name) => !options.categoryFilter || name === options.categoryFilter)
    .sort(compareNames);

  if (options.categoryFilter && categoryDirs.length === 0) {
    throw new Error(`Category directory was not found: ${options.categoryFilter}`);
  }

  const categories = [];
  const nestedParentNames = new Set();
  const planWarnings = [];
  let remainingLimit = options.limit;

  for (const rootName of categoryDirs) {
    if (remainingLimit !== null && remainingLimit <= 0) break;
    const rootPath = path.join(inputDir, rootName);
    const layout = await inspectPostInputDirectory(rootPath, { allowEmpty: true });
    if (layout.kind === "empty") {
      planWarnings.push(...(layout.warnings || []).map((warning) => `${rootPath}: ${warning}`));
      continue;
    }
    if (layout.kind === "flat") {
      const collected = await collectPlanGroups(rootPath, options);
      if (collected.groups.length === 0) {
        planWarnings.push(...collected.warnings.map((warning) => `${rootPath}: ${warning}`));
        continue;
      }
      const category = makePlanCategory({
        name: rootName,
        path: rootPath,
        groups: collected.groups,
        parentName: null,
        inputWarnings: collected.warnings,
        options,
      });
      appendSelectedCategory(categories, category, () => {
        if (remainingLimit === null) return;
        const selected = category.groups.slice(0, remainingLimit);
        remainingLimit -= selected.length;
        category.groups = selected;
      });
    } else {
      planWarnings.push(...(layout.warnings || []).map((warning) => `${rootPath}: ${warning}`));
      for (const forum of layout.forums) {
        if (remainingLimit !== null && remainingLimit <= 0) break;
        const collected = await collectPlanGroups(forum.path, options, { allowEmpty: true });
        if (collected.groups.length === 0) {
          planWarnings.push(...collected.warnings.map((warning) => `${forum.path}: ${warning}`));
          continue;
        }
        nestedParentNames.add(rootName);
        const category = makePlanCategory({
          name: forum.name,
          path: forum.path,
          groups: collected.groups,
          parentName: rootName,
          inputWarnings: collected.warnings,
          options,
        });
        appendSelectedCategory(categories, category, () => {
          if (remainingLimit === null) return;
          const selected = category.groups.slice(0, remainingLimit);
          remainingLimit -= selected.length;
          category.groups = selected;
        });
      }
    }

    if (remainingLimit !== null && remainingLimit <= 0) break;
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
    { categories: 0, forums: 0, parentCategories: 0, groups: 0, files: 0, bytes: 0 }
  );
  totals.forums = categories.length;
  totals.parentCategories = nestedParentNames.size;

  return {
    inputDir,
    categories,
    totals,
    hasNestedLayout: nestedParentNames.size > 0,
    warnings: planWarnings,
  };
}

const IMAGE_FILE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

function isPreviewImageDirectory(name) {
  return /_jpg$/i.test(name);
}

function isWindowsMetadataFile(name) {
  return /^(?:thumbs\.db|desktop\.ini)$/i.test(name);
}

function isKnownOutputMetadata(name) {
  return /\.assets(?:\.pending)?\.json$/i.test(name) || /\.pending$/i.test(name);
}

function isUploadFile(name) {
  const ext = path.extname(name).toLowerCase();
  return ext === ".zip" || ext === ".pdf";
}

function isRawImageFile(name) {
  return IMAGE_FILE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

async function inspectPostInputDirectory(directory, { allowEmpty = false } = {}) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile());
  const uploadFiles = files.filter((entry) => isUploadFile(entry.name));
  const rawImages = files.filter((entry) => isRawImageFile(entry.name));
  const unknownFiles = files.filter((entry) =>
    !isUploadFile(entry.name) &&
    !isKnownOutputMetadata(entry.name) &&
    !isWindowsMetadataFile(entry.name)
  );
  const ignoredWarnings = unknownFiles.length > 0
    ? [`ignored unrelated file(s): ${unknownFiles.map((entry) => entry.name).join(", ")}`]
    : [];
  const metadataFiles = files.filter((entry) => isKnownOutputMetadata(entry.name));
  const childDirs = entries.filter((entry) => entry.isDirectory());
  const uploadBaseNames = new Set(uploadFiles.map((entry) =>
    path.basename(entry.name, path.extname(entry.name)).toLocaleLowerCase()
  ));
  const previewDirs = new Set(childDirs
    .filter((entry) => isPreviewImageDirectory(entry.name))
    .filter((entry) => uploadBaseNames.has(
      entry.name.slice(0, -"_jpg".length).toLocaleLowerCase()
    ))
    .map((entry) => entry.name));
  const forumDirs = childDirs.filter((entry) => !previewDirs.has(entry.name));

  if (rawImages.length > 0) {
    throw new Error(`${directory}: raw input images were found in a posting folder; run the image conversion first.`);
  }
  if (uploadFiles.length > 0) {
    if (forumDirs.length > 0) {
      throw new Error(`${directory}: shallow and nested category/forum layouts are mixed; put ZIP/PDF files either directly here or under forum folders.`);
    }
    return { kind: "flat", warnings: ignoredWarnings };
  }

  if (metadataFiles.length > 0 && forumDirs.length > 0) {
    throw new Error(`${directory}: shallow output metadata is mixed with nested category/forum folders; resolve the output layout before posting.`);
  }

  if (forumDirs.length === 0) {
    if (childDirs.length > 0) {
      if (allowEmpty && childDirs.every((entry) => isPreviewImageDirectory(entry.name))) {
        return { kind: "empty", warnings: ignoredWarnings };
      }
      throw new Error(`${directory}: only *_jpg preview folders were found and no ZIP/PDF output exists.`);
    }
    if (files.length > 0) {
      if (allowEmpty && files.every((entry) => isWindowsMetadataFile(entry.name))) {
        return { kind: "empty", warnings: ignoredWarnings };
      }
      if (metadataFiles.length > 0) {
        throw new Error(`${directory}: generated profile/pending metadata exists without its ZIP/PDF output.`);
      }
      if (allowEmpty) return { kind: "empty", warnings: ignoredWarnings };
      throw new Error(`${directory}: no ZIP/PDF output exists.`);
    }
    if (allowEmpty) return { kind: "empty", warnings: ignoredWarnings };
    throw new Error(`${directory}: no forum works were found.`);
  }

  return {
    kind: "nested",
    forums: forumDirs.sort((a, b) => compareNames(a.name, b.name)).map((entry) => ({
      name: entry.name,
      path: path.join(directory, entry.name),
    })),
  };
}

async function collectPlanGroups(categoryPath, options, inspectOptions = {}) {
  const layout = await inspectPostInputDirectory(categoryPath, inspectOptions);
  if (layout.kind === "empty") return { groups: [], warnings: layout.warnings || [] };
  if (layout.kind !== "flat") {
    throw new Error(`${categoryPath}: category/forum layout is deeper than supported.`);
  }
  const fileEntries = await fs.readdir(categoryPath, { withFileTypes: true });
  const fileGroups = new Map();

  for (const entry of fileEntries) {
    if (!entry.isFile() || !isUploadFile(entry.name)) continue;
    const ext = path.extname(entry.name).toLowerCase();
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

  const groups = Array.from(fileGroups.values()).sort((a, b) => compareNames(a.baseName, b.baseName));
  for (const group of groups) group.files.sort(compareUploadFiles);
  assignUniqueChannelNames(groups);

  for (const group of groups) {
    for (const part of groupParts(group)) {
      if (!part.files.zip) group.warnings.push(`${part.label}: zip file is missing`);
      if (!part.files.pdf) group.warnings.push(`${part.label}: pdf file is missing`);
    }
    const files = groupFiles(group);
    for (const file of files) {
      if (options.maxFileBytes !== undefined && file.size > options.maxFileBytes) {
        group.warnings.push(`${file.name} exceeds max file size`);
      }
    }
    if (options.maxRequestBytes !== undefined && sumSizes(files) > options.maxRequestBytes) {
      group.warnings.push("all files exceed max request size; auto mode will upload separately");
    }
  }
  return { groups, warnings: layout.warnings || [] };
}

function makePlanCategory({ name, path: categoryPath, groups, parentName, inputWarnings = [], options }) {
  const warnings = [...inputWarnings];
  if (options.postingLayout !== "forum" && groups.length > 50) {
    warnings.push("Discord categories can contain up to 50 channels");
  }
  return {
    name,
    ...(parentName ? { parentName } : {}),
    path: categoryPath,
    groups,
    originalGroupCount: groups.length,
    warnings,
  };
}

function appendSelectedCategory(categories, category, select) {
  select();
  categories.push(category);
}

function isManifestStagingDirectory(name) {
  return process.platform === "win32"
    ? name.toLowerCase() === MANIFEST_STAGING_DIR_NAME.toLowerCase()
    : name === MANIFEST_STAGING_DIR_NAME;
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
  const forum = options.postingLayout === "forum";
  console.log(`Input: ${plan.inputDir}`);
  if (plan.hasNestedLayout) {
    console.log(
      `Plan: ${plan.totals.parentCategories} Discord categories, ${plan.totals.forums} ${forum ? "forums" : "forum folders"}, ` +
        `${plan.totals.groups} ${forum ? "works" : "channels"}, ${plan.totals.files} files, ${formatBytes(plan.totals.bytes)}`
    );
  } else {
    console.log(
      `Plan: ${plan.totals.categories} ${forum ? "forums" : "categories"}, ${plan.totals.groups} ${forum ? "works" : "channels"}, ` +
        `${plan.totals.files} files, ${formatBytes(plan.totals.bytes)}`
    );
  }
  if (forum) console.log("Forum: images in batches of up to 10, then ZIP/PDF; existing channel uploads stay in place.");
  for (const warning of plan.warnings || []) {
    console.log(`! ${warning}`);
  }
  console.log(
    `Upload mode: ${options.uploadMode} / max file ${options.maxFileMiB} MiB / ` +
      `max bundled request ${options.maxRequestMiB} MiB`
  );
  if (options.categoryFilter) {
    console.log(`Category filter: ${options.categoryFilter}`);
  }
  if (options.limit !== null) {
    console.log(`Limit: ${options.limit} ${forum ? "work(s)" : "channel(s)"}`);
  }

  for (const category of plan.categories) {
    const suffix =
      category.groups.length === category.originalGroupCount
        ? ""
        : ` (${category.groups.length}/${category.originalGroupCount} selected)`;
    console.log("");
    const categoryLabel = category.parentName
      ? `${category.parentName} / ${category.name}`
      : category.name;
    console.log(`[${categoryLabel}] ${category.groups.length} ${forum ? "work(s)" : "channel(s)"}${suffix}`);

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
      console.log(forum ? `  Post: ${group.baseName}` : `  # ${group.channelName}${renameNote}`);
      console.log(`    ${files || "no uploadable files"}`);
      if (forum) console.log(group.legacy ? "    Existing channel: resume/skip without migration" :
        `    ${group.albumPlan.imageCount} images, ${group.albumPlan.batches.length} messages, ${formatBytes(group.albumPlan.bytes)} total attachments`);
      for (const warning of group.warnings) {
        console.log(`    ! ${warning}`);
      }
    }
  }
}

function assertRunnablePlan(plan, postingLayout = "channels") {
  const problems = [];
  if (plan.hasNestedLayout && postingLayout !== "forum") {
    problems.push("The category/forum folder layout requires --posting-layout forum; the legacy channels layout cannot represent it safely.");
  }
  for (const category of plan.categories) {
    if (postingLayout !== "forum" && category.groups.length > 50) {
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

async function validateGeneratedOutputs(plan) {
  const problems = [];

  for (const category of plan.categories) {
    for (const group of category.groups) {
      const plannedFiles = groupFiles(group);
      if (plannedFiles.length > 0) {
        const categoryDir = path.dirname(plannedFiles[0].path);
        const pendingBases = new Set([
          group.baseName,
          ...plannedFiles.map((file) => file.fileBaseName),
        ]);
        for (const pendingBase of pendingBases) {
          const setPendingPath = path.join(categoryDir, `${pendingBase}.assets.pending`);
          if (await pathExists(setPendingPath)) {
            problems.push(
              `${setPendingPath}: 作品全体の変換が未確定です。全分割出力の再変換が完了するまで投稿できません。`
            );
          }
        }
      }

      const byBaseName = new Map();
      for (const file of plannedFiles) {
        if (!byBaseName.has(file.fileBaseName)) {
          byBaseName.set(file.fileBaseName, []);
        }
        byBaseName.get(file.fileBaseName).push(file);
      }

      for (const [baseName, files] of byBaseName) {
        const categoryDir = path.dirname(files[0].path);
        const pendingPath = path.join(categoryDir, `${baseName}.pending`);
        if (await pathExists(pendingPath)) {
          problems.push(`${pendingPath}: 変換中または未確定の出力です。再変換が完了するまで投稿できません。`);
        }

        const profilePath = path.join(categoryDir, `${baseName}.assets.json`);
        if (!(await pathExists(profilePath))) {
          // Files without a profile are legacy/manual inputs and remain supported.
          continue;
        }

        const zipFiles = files.filter((file) => file.type === "zip");
        const pdfFiles = files.filter((file) => file.type === "pdf");
        if (zipFiles.length !== 1 || pdfFiles.length !== 1) {
          problems.push(
            `${profilePath}: assets.jsonがある生成物は、同じ名前のzip/pdf pairが必要です。`
          );
          continue;
        }

        try {
          const profile = JSON.parse(await fs.readFile(profilePath, "utf8"));
          const [zipStat, pdfStat] = await Promise.all([
            fs.stat(zipFiles[0].path),
            fs.stat(pdfFiles[0].path),
          ]);
          const [zipBuffer, pdfBuffer] = await Promise.all([
            fs.readFile(zipFiles[0].path),
            fs.readFile(pdfFiles[0].path),
          ]);
          const profileMatches =
            profile.zip?.bytes === zipStat.size &&
            profile.pdf?.bytes === pdfStat.size &&
            typeof profile.zip?.sha256 === "string" &&
            typeof profile.pdf?.sha256 === "string" &&
            hashBuffer(zipBuffer) === profile.zip.sha256 &&
            hashBuffer(pdfBuffer) === profile.pdf.sha256;
          if (!profileMatches) {
            problems.push(`${profilePath}: profileとzip/pdfのサイズまたはSHA-256が一致しません。`);
          }
        } catch (error) {
          problems.push(`${profilePath}: profileを検証できません (${getErrorMessage(error)}).`);
        }
      }
    }
  }

  if (problems.length > 0) {
    throw new Error(
      [
        "生成済み出力の整合性検証に失敗したため、Discord APIへ接続せず停止しました。",
        ...problems.map((problem) => `- ${problem}`),
        "変換を完了してprofileを再生成するか、手動入力ではassets.jsonとpending markerを確認してください。",
      ].join("\n")
    );
  }
}

async function createManifestWritePlan(manifestPath) {
  const resolvedManifestPath = path.resolve(manifestPath);
  const canonicalManifestPath = await canonicalPath(manifestPath);
  const reservedName = process.platform === "win32"
    ? MANIFEST_STAGING_DIR_NAME.toLowerCase()
    : MANIFEST_STAGING_DIR_NAME;
  const hasReservedSegment = [resolvedManifestPath, canonicalManifestPath].some((candidate) =>
    candidate
      .split(path.sep)
      .some((segment) => (process.platform === "win32" ? segment.toLowerCase() : segment) === reservedName)
  );
  if (hasReservedSegment) {
    throw new Error(
      `Manifest path is inside the reserved staging directory and cannot be used: ${manifestPath}`
    );
  }

  const stagingRoot = path.join(path.dirname(canonicalManifestPath), MANIFEST_STAGING_DIR_NAME);
  const manifestHash = crypto.createHash("sha256").update(canonicalManifestPath).digest("hex");
  return {
    manifestPath: canonicalManifestPath,
    stagingDir: path.join(stagingRoot, manifestHash),
  };
}

async function executePlan(context) {
  const { api, guildId, plan, manifest, manifestPath, recreateMissing } = context;
  const guildManifest = ensureGuildManifest(manifest, guildId);
  for (const category of plan.categories) for (const group of category.groups) {
    if (guildManifest.categories[category.name]?.groups?.[group.baseName]?.forum) {
      throw new Error(`${group.baseName}: フォーラムで開始済みの作品です。重複防止のため --posting-layout forum で再開してください。`);
    }
  }

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
  const writePlan = await createManifestWritePlan(manifestPath);
  await fs.mkdir(path.dirname(writePlan.manifestPath), { recursive: true });
  await fs.mkdir(writePlan.stagingDir, { recursive: true });
  const tmpPath = path.join(writePlan.stagingDir, `${crypto.randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(tmpPath, writePlan.manifestPath);
  } finally {
    await fs.rm(tmpPath, { force: true }).catch(() => {});
  }
}

function ensureGuildManifest(manifest, guildId) {
  manifest.guilds ||= {};
  const guild = own(manifest.guilds, guildId) || put(manifest.guilds, guildId, { categories: {} });
  guild.categories ||= {};
  return guild;
}

function ensureCategoryManifest(guildManifest, categoryName) {
  const category = own(guildManifest.categories, categoryName) || put(guildManifest.categories, categoryName, {
    id: null,
    name: categoryName,
    groups: {},
  });
  category.groups ||= {};
  return category;
}

function ensureGroupManifest(guildManifest, categoryName, baseName) {
  const category = ensureCategoryManifest(guildManifest, categoryName);
  const group = own(category.groups, baseName) || put(category.groups, baseName, {
    channelId: null,
    channelName: null,
    files: {},
  });
  group.files ||= {};
  return group;
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

async function pathExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function mibToBytes(mib) {
  return mib * 1024 * 1024;
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
  --posting-layout <mode> forum | channels. Default: forum (legacy channel uploads stay in place)
  --forum-layout <mode> gallery | list. Default: gallery
  --forum-parent <id>  Existing category for old flat layout; leave empty for nested folder layout
  --input <path>       Input folder. Default: ./example
  --guild <id>         Discord server ID. Required for run unless env is set
  --token <token>      Discord bot token. Required for run unless env is set
  --upload-mode <mode> auto | bundle | separate. Default: auto
  --manifest <path>    Manifest path. Default: ./.discord-post-tool-manifest.json
  --category <name>    Only process one category folder (nested layout: Discord category name)
  --limit <n>          Process only the first n planned works
  --max-file-mib <n>   Per-file preflight limit. Default: 10
  --max-request-mib <n> Bundled upload preflight limit. Default: 25
  --no-remote-check    Do not check recent messages for existing attachments
  --no-recreate-missing Stop instead of recreating manifest-tracked categories/channels if missing
  --yes                Required by run
`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("");
    console.error(error.message);
    if (error instanceof DiscordApiError && error.body) console.error(error.body);
    process.exitCode = 1;
  });
}

module.exports = { main, DiscordApi, buildLocalPlan };
