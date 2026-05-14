const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const CLI_SCRIPT = path.join(ROOT_DIR, "src", "cli.js");
const BUILD_ASSETS_SCRIPT = path.join(ROOT_DIR, "src", "build-assets.js");
const DISCORD_API_BASE = "https://discord.com/api/v10";

let mainWindow = null;
let activeJob = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 1040,
    minHeight: 760,
    title: "Discord Post Tool",
    backgroundColor: "#f4f5f7",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  if (process.argv.includes("--smoke-test")) {
    mainWindow.webContents.once("did-finish-load", () => {
      setTimeout(() => app.quit(), 300);
    });
  }
}

app.whenReady().then(() => {
  registerIpc();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

app.on("before-quit", () => {
  if (activeJob) {
    activeJob.kill();
  }
});

function registerIpc() {
  ipcMain.handle("app:get-defaults", async () => {
    const env = await readDotEnv(path.join(ROOT_DIR, ".env"));
    return {
      rootDir: ROOT_DIR,
      rawImagesDir: path.join(ROOT_DIR, "raw_images"),
      optimizedDir: path.join(ROOT_DIR, "optimized_split"),
      hasBotToken: Boolean(env.DISCORD_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN),
      guildId: env.DISCORD_GUILD_ID || process.env.DISCORD_GUILD_ID || "",
    };
  });

  ipcMain.handle("discord:get-guild-info", async (_event, request) => {
    return getGuildInfo(request);
  });

  ipcMain.handle("dialog:choose-folder", async (_event, currentPath) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "フォルダを選択",
      defaultPath: currentPath || ROOT_DIR,
      properties: ["openDirectory", "createDirectory"],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  ipcMain.handle("job:start", async (event, request) => {
    if (activeJob) {
      throw new Error("別の処理が実行中です。完了または停止してから再実行してください。");
    }

    const job = buildJobRequest(request);
    return startJob(event.sender, job);
  });

  ipcMain.handle("job:stop", async () => {
    if (!activeJob) {
      return { stopped: false };
    }
    activeJob.kill();
    return { stopped: true };
  });
}

function buildJobRequest(request) {
  if (!request || typeof request !== "object") {
    throw new Error("Invalid job request.");
  }

  if (request.type === "assets") {
    return buildAssetsJob(request);
  }

  if (request.type === "post") {
    return buildPostJob(request);
  }

  throw new Error(`Unknown job type: ${request.type}`);
}

function buildAssetsJob(request) {
  const command = request.command === "run" ? "run" : "plan";
  const args = [BUILD_ASSETS_SCRIPT, command];

  pushOption(args, "--input", request.inputDir);
  pushOption(args, "--output", request.outputDir);
  pushOption(args, "--chunk-size", request.chunkSize);
  pushOption(args, "--target-mib", request.targetMiB);
  pushOption(args, "--max-quality", request.maxQuality);
  pushOption(args, "--min-quality", request.minQuality);
  pushOption(args, "--concurrency", request.concurrency);
  pushOption(args, "--limit", request.limit);
  pushOption(args, "--set", request.setName);

  if (request.preserveResolution) {
    args.push("--preserve-resolution");
  }
  if (request.force) {
    args.push("--force");
  }
  if (request.keepJpgs) {
    args.push("--keep-jpgs");
  }
  if (request.fixedQualityEnabled) {
    pushOption(args, "--quality", request.fixedQuality);
  }

  return {
    label: command === "run" ? "画像変換" : "画像変換計画",
    args,
    env: {},
  };
}

function buildPostJob(request) {
  const command = request.command === "run" ? "run" : "plan";
  const args = [CLI_SCRIPT, command];

  pushOption(args, "--input", request.inputDir);
  pushOption(args, "--upload-mode", request.uploadMode);
  pushOption(args, "--max-file-mib", request.maxFileMiB);
  pushOption(args, "--max-request-mib", request.maxRequestMiB);
  pushOption(args, "--limit", request.limit);
  pushOption(args, "--category", request.category);

  if (command === "run") {
    args.push("--yes");
  }
  if (request.noRemoteCheck) {
    args.push("--no-remote-check");
  }
  if (request.noRecreateMissing) {
    args.push("--no-recreate-missing");
  }

  const env = {};
  if (request.guildId) {
    env.DISCORD_GUILD_ID = String(request.guildId).trim();
  }
  if (request.botToken) {
    env.DISCORD_BOT_TOKEN = String(request.botToken).trim();
  }

  return {
    label: command === "run" ? "Discord投稿" : "投稿計画",
    args,
    env,
  };
}

function startJob(webContents, job) {
  const jobId = `${Date.now()}`;
  const nodePath = process.env.DISCORD_POST_TOOL_NODE || "node";
  const child = spawn(nodePath, job.args, {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      ...job.env,
      FORCE_COLOR: "0",
      NO_COLOR: "1",
    },
    windowsHide: true,
  });

  activeJob = child;

  webContents.send("job:event", {
    jobId,
    type: "start",
    label: job.label,
    command: `node ${job.args.map(quoteArgForDisplay).join(" ")}`,
  });

  child.stdout.on("data", (chunk) => {
    webContents.send("job:event", {
      jobId,
      type: "stdout",
      text: chunk.toString("utf8"),
    });
  });

  child.stderr.on("data", (chunk) => {
    webContents.send("job:event", {
      jobId,
      type: "stderr",
      text: chunk.toString("utf8"),
    });
  });

  child.on("error", (error) => {
    webContents.send("job:event", {
      jobId,
      type: "error",
      text: `${error.message}\n`,
    });
  });

  child.on("close", (code, signal) => {
    activeJob = null;
    webContents.send("job:event", {
      jobId,
      type: "close",
      code,
      signal,
    });
  });

  return { jobId };
}

function pushOption(args, name, value) {
  if (value === undefined || value === null || value === "") {
    return;
  }
  args.push(name, String(value));
}

function quoteArgForDisplay(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_./:\\-]+$/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '\\"')}"`;
}

async function getGuildInfo(request = {}) {
  const env = await readDotEnv(path.join(ROOT_DIR, ".env"));
  const guildId = String(
    request.guildId || env.DISCORD_GUILD_ID || process.env.DISCORD_GUILD_ID || "",
  ).trim();
  const botToken = String(
    request.botToken || env.DISCORD_BOT_TOKEN || process.env.DISCORD_BOT_TOKEN || "",
  )
    .trim()
    .replace(/^Bot\s+/i, "");

  if (!guildId) {
    throw new Error("Guild IDを入力するか、.envにDISCORD_GUILD_IDを設定してください。");
  }
  if (!botToken) {
    throw new Error("Bot Tokenを入力するか、.envにDISCORD_BOT_TOKENを設定してください。");
  }

  const response = await fetch(`${DISCORD_API_BASE}/guilds/${encodeURIComponent(guildId)}`, {
    headers: {
      Authorization: `Bot ${botToken}`,
    },
  });

  if (!response.ok) {
    const detail = await readDiscordError(response);
    throw new Error(`サーバー名を取得できませんでした (HTTP ${response.status})${detail}`);
  }

  const guild = await response.json();
  return {
    id: guild.id,
    name: guild.name,
  };
}

async function readDiscordError(response) {
  let text = "";
  try {
    const body = await response.json();
    text = body.message || JSON.stringify(body);
  } catch {
    try {
      text = await response.text();
    } catch {
      text = "";
    }
  }

  const trimmed = String(text).trim();
  return trimmed ? `: ${trimmed.slice(0, 180)}` : "";
}

async function readDotEnv(envPath) {
  let text;
  try {
    text = await fs.readFile(envPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }

  const values = {};
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
    values[key] = value;
  }
  return values;
}
