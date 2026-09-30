const { app, BrowserWindow, dialog, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { projectProfilePath, migrateLocalStorage } = require("./project-profile");
const { discordFetch } = require("../discord-request");

const ROOT_DIR = path.resolve(__dirname, "..", "..");
const CLI_SCRIPT = path.join(ROOT_DIR, "src", "cli.js");
const BUILD_ASSETS_SCRIPT = path.join(ROOT_DIR, "src", "build-assets.js");
const DISCORD_API_BASE = "https://discord.com/api/v10";
const SMOKE_TEST = process.argv.includes("--smoke-test");
const legacyUserData = app.getPath("userData");
const profileDir = projectProfilePath(ROOT_DIR, legacyUserData);
fsSync.mkdirSync(profileDir, { recursive: true });
app.setPath("userData", profileDir);
app.setPath("sessionData", profileDir);
const ownsProfile = app.requestSingleInstanceLock();

let mainWindow = null;
let activeJob = null;

if (!ownsProfile) {
  app.quit();
} else {
  try {
    migrateLocalStorage(legacyUserData, profileDir);
  } catch (error) {
    dialog.showErrorBox("設定の引き継ぎに失敗しました", error.message +
      "\n旧版のアプリをすべて終了してから、再起動してください。");
    app.exit(1);
  }
  app.on("second-instance", (_event, argv) => {
    if (argv.includes("--smoke-test") || !mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 1040,
    minHeight: 760,
    title: "Discord Post Tool",
    backgroundColor: "#f4f5f7",
    autoHideMenuBar: true,
    show: !SMOKE_TEST,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));

  if (SMOKE_TEST) {
    mainWindow.webContents.once("did-finish-load", async () => {
      try {
        const ready = await mainWindow.webContents.executeJavaScript(`new Promise((resolve) => {
          const started = Date.now();
          const check = () => {
            if (document.documentElement.dataset.ready === "true") return resolve(true);
            if (Date.now() - started > 5000) return resolve(false);
            setTimeout(check, 25);
          };
          check();
        })`);
        if (!ready) throw new Error("Renderer initialization timed out");
        console.log(JSON.stringify({ rootDir: ROOT_DIR, userData: app.getPath("userData"),
          sessionData: app.getPath("sessionData"), ready }));
        setTimeout(() => app.quit(), 2500);
      } catch (error) {
        console.error(error.message);
        app.exit(1);
      }
    });
  }
}

app.whenReady().then(() => {
  if (!ownsProfile) return;
  registerIpc();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (ownsProfile && BrowserWindow.getAllWindows().length === 0) {
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
      smokeTest: SMOKE_TEST,
      rawImagesDir: path.join(ROOT_DIR, "raw_images"),
      optimizedDir: path.join(ROOT_DIR, "optimized_webp_pdf"),
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
  pushOption(args, "--zip-webp-quality", request.zipWebpQuality);
  pushOption(args, "--zip-webp-max-quality", request.zipWebpMaxQuality);
  pushOption(args, "--zip-webp-min-quality", request.zipWebpMinQuality);
  pushOption(args, "--pdf-jpeg-quality", request.pdfJpegQuality);
  pushOption(args, "--pdf-jpeg-max-quality", request.pdfJpegMaxQuality);
  pushOption(args, "--pdf-long-edge", request.pdfLongEdge);
  pushOption(args, "--pdf-max-long-edge", request.pdfMaxLongEdge);
  pushOption(args, "--pdf-min-long-edge", request.pdfMinLongEdge);
  pushOption(args, "--concurrency", request.concurrency);
  pushOption(args, "--limit", request.limit);
  pushOption(args, "--set", request.setName);

  if (request.force) {
    args.push("--force");
  }
  if (request.keepJpgs) {
    args.push("--keep-jpgs");
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

  const response = await discordFetch(
    botToken, `${DISCORD_API_BASE}/guilds/${encodeURIComponent(guildId)}`
  );

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
