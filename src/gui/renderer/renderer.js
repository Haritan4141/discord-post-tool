const api = window.discordPostTool;
const BASE_STORAGE_KEY = "discordPostToolState";
const ASSET_PROFILE_STORAGE_VERSION = 4;

const state = {
  activeTab: "assets",
  localStateKey: BASE_STORAGE_KEY,
  defaultOptimizedDir: "",
  running: false,
};

const elements = {};

document.addEventListener("DOMContentLoaded", async () => {
  bindElements();
  bindEvents();
  const defaults = await hydrateDefaults();
  restoreLocalState();
  document.documentElement.dataset.ready = "true";
  if (!defaults.smokeTest) refreshGuildName({ silent: true });
});

function bindElements() {
  for (const id of [
    "tokenStatus",
    "guildStatus",
    "viewTitle",
    "viewSubtitle",
    "assetsView",
    "postView",
    "stopJob",
    "logOutput",
    "jobState",
    "clearLog",
    "assetInputDir",
    "assetOutputDir",
    "assetChunkSize",
    "assetTargetMiB",
    "assetZipWebpQuality",
    "assetZipWebpMaxQuality",
    "assetZipWebpMinQuality",
    "assetPdfJpegQuality",
    "assetPdfJpegMaxQuality",
    "assetPdfLongEdge",
    "assetPdfMaxLongEdge",
    "assetPdfMinLongEdge",
    "assetConcurrency",
    "assetSetName",
    "assetLimit",
    "assetForce",
    "assetKeepJpgs",
    "assetPlan",
    "assetRun",
    "postInputDir",
    "postGuildId",
    "checkGuild",
    "postGuildName",
    "postBotToken",
    "postUploadMode",
    "postMaxFileMiB",
    "postMaxRequestMiB",
    "postCategory",
    "postLimit",
    "postNoRemoteCheck",
    "postNoRecreateMissing",
    "postPlan",
    "postRun",
  ]) {
    elements[id] = document.getElementById(id);
  }
}

function bindEvents() {
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });

  document.querySelectorAll("[data-folder-target]").forEach((button) => {
    button.addEventListener("click", async () => {
      const target = elements[button.dataset.folderTarget];
      const selected = await api.chooseFolder(target.value);
      if (selected) {
        target.value = selected;
        saveLocalState();
      }
    });
  });

  elements.assetPlan.addEventListener("click", () => startAssetsJob("plan"));
  elements.assetRun.addEventListener("click", () => startAssetsJob("run"));
  elements.postPlan.addEventListener("click", () => startPostJob("plan"));
  elements.postRun.addEventListener("click", () => startPostJob("run"));
  elements.checkGuild.addEventListener("click", () => refreshGuildName());
  elements.stopJob.addEventListener("click", () => api.stopJob());
  elements.clearLog.addEventListener("click", () => {
    elements.logOutput.textContent = "";
  });

  document.querySelectorAll("input, select").forEach((input) => {
    input.addEventListener("change", () => {
      saveLocalState();
      if (input.id === "postGuildId" || input.id === "postBotToken") {
        markGuildUnchecked();
      }
    });
  });

  api.onJobEvent(handleJobEvent);
}

async function hydrateDefaults() {
  const defaults = await api.getDefaults();
  state.localStateKey = makeProjectStateKey(defaults.rootDir);
  state.defaultOptimizedDir = defaults.optimizedDir;
  elements.assetInputDir.value ||= defaults.rawImagesDir;
  elements.assetOutputDir.value ||= defaults.optimizedDir;
  elements.postInputDir.value ||= defaults.optimizedDir;
  elements.postGuildId.value ||= defaults.guildId;
  elements.tokenStatus.textContent = defaults.hasBotToken ? "設定済み" : "未設定";
  elements.guildStatus.textContent = defaults.guildId ? "設定済み" : "未設定";
  return defaults;
}

function switchTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll(".tab-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.tab === tab);
  });
  elements.assetsView.classList.toggle("active", tab === "assets");
  elements.postView.classList.toggle("active", tab === "post");

  if (tab === "assets") {
    elements.viewTitle.textContent = "画像変換";
    elements.viewSubtitle.textContent = "ZIPは元解像度WebP、PDFは縮小JPEGで生成します。";
  } else {
    elements.viewTitle.textContent = "Discord投稿";
    elements.viewSubtitle.textContent = "変換済みフォルダのカテゴリ/ファイル構成をDiscordへ反映します。";
  }

  saveLocalState();
}

async function startAssetsJob(command) {
  const request = {
    type: "assets",
    command,
    inputDir: elements.assetInputDir.value,
    outputDir: elements.assetOutputDir.value,
    chunkSize: valueOrEmpty(elements.assetChunkSize.value),
    targetMiB: valueOrEmpty(elements.assetTargetMiB.value),
    zipWebpQuality: valueOrEmpty(elements.assetZipWebpQuality.value),
    zipWebpMaxQuality: valueOrEmpty(elements.assetZipWebpMaxQuality.value),
    zipWebpMinQuality: valueOrEmpty(elements.assetZipWebpMinQuality.value),
    pdfJpegQuality: valueOrEmpty(elements.assetPdfJpegQuality.value),
    pdfJpegMaxQuality: valueOrEmpty(elements.assetPdfJpegMaxQuality.value),
    pdfLongEdge: valueOrEmpty(elements.assetPdfLongEdge.value),
    pdfMaxLongEdge: valueOrEmpty(elements.assetPdfMaxLongEdge.value),
    pdfMinLongEdge: valueOrEmpty(elements.assetPdfMinLongEdge.value),
    concurrency: valueOrEmpty(elements.assetConcurrency.value),
    force: elements.assetForce.checked,
    keepJpgs: elements.assetKeepJpgs.checked,
    setName: valueOrEmpty(elements.assetSetName.value),
    limit: valueOrEmpty(elements.assetLimit.value),
  };

  await startJob(request);
}

async function startPostJob(command) {
  const request = {
    type: "post",
    command,
    inputDir: elements.postInputDir.value,
    guildId: valueOrEmpty(elements.postGuildId.value),
    botToken: valueOrEmpty(elements.postBotToken.value),
    uploadMode: elements.postUploadMode.value,
    maxFileMiB: valueOrEmpty(elements.postMaxFileMiB.value),
    maxRequestMiB: valueOrEmpty(elements.postMaxRequestMiB.value),
    category: valueOrEmpty(elements.postCategory.value),
    limit: valueOrEmpty(elements.postLimit.value),
    noRemoteCheck: elements.postNoRemoteCheck.checked,
    noRecreateMissing: elements.postNoRecreateMissing.checked,
  };

  await startJob(request);
}

async function refreshGuildName(options = {}) {
  const silent = Boolean(options.silent);
  elements.postGuildName.textContent = "取得中...";
  elements.checkGuild.disabled = true;

  try {
    const guild = await api.getGuildInfo({
      guildId: valueOrEmpty(elements.postGuildId.value),
      botToken: valueOrEmpty(elements.postBotToken.value),
    });
    elements.postGuildName.textContent = `サーバー名: ${guild.name}`;
    elements.guildStatus.textContent = guild.name || "取得済み";
  } catch (error) {
    if (silent) {
      elements.postGuildName.textContent = "未確認";
      return;
    }
    elements.postGuildName.textContent = `取得失敗: ${error.message}`;
    elements.guildStatus.textContent = "取得失敗";
  } finally {
    elements.checkGuild.disabled = state.running;
  }
}

function markGuildUnchecked() {
  elements.postGuildName.textContent = "未確認";
  elements.guildStatus.textContent = valueOrEmpty(elements.postGuildId.value) ? "未確認" : "未設定";
}

async function startJob(request) {
  if (state.running) {
    return;
  }

  saveLocalState();
  setRunning(true);
  appendLog(`\n> ${request.type === "assets" ? "画像変換" : "Discord投稿"} ${request.command}\n`);

  try {
    await api.startJob(request);
  } catch (error) {
    appendLog(`${error.message}\n`, "stderr");
    setRunning(false);
  }
}

function handleJobEvent(event) {
  if (event.type === "start") {
    elements.jobState.textContent = `${event.label} 実行中`;
    appendLog(`${event.command}\n`);
    return;
  }

  if (event.type === "stdout") {
    appendLog(event.text);
    return;
  }

  if (event.type === "stderr" || event.type === "error") {
    appendLog(event.text, "stderr");
    return;
  }

  if (event.type === "close") {
    const ok = event.code === 0;
    appendLog(ok ? "\n完了しました。\n" : `\n終了コード ${event.code ?? "なし"} で停止しました。\n`, ok ? "" : "stderr");
    elements.jobState.textContent = ok ? "完了" : "エラー";
    setRunning(false);
  }
}

function setRunning(running) {
  state.running = running;
  elements.stopJob.disabled = !running;
  for (const button of [
    elements.assetPlan,
    elements.assetRun,
    elements.postPlan,
    elements.postRun,
    elements.checkGuild,
  ]) {
    button.disabled = running;
  }
  if (running) {
    elements.jobState.textContent = "実行中";
  }
}

function appendLog(text, className = "") {
  if (!className) {
    elements.logOutput.textContent += text;
  } else {
    elements.logOutput.textContent += text;
  }
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

function valueOrEmpty(value) {
  const text = String(value ?? "").trim();
  return text === "" ? "" : text;
}

function makeProjectStateKey(rootDir) {
  const normalizedRoot = String(rootDir || "")
    .trim()
    .replace(/\\/g, "/")
    .toLowerCase();
  return normalizedRoot ? `${BASE_STORAGE_KEY}:${normalizedRoot}` : BASE_STORAGE_KEY;
}

function saveLocalState() {
  const data = {};
  document.querySelectorAll("input, select").forEach((input) => {
    if (input.id === "postBotToken") {
      return;
    }
    data[input.id] = input.type === "checkbox" ? input.checked : input.value;
  });
  data.activeTab = state.activeTab;
  data.assetProfileVersion = ASSET_PROFILE_STORAGE_VERSION;
  localStorage.setItem(state.localStateKey, JSON.stringify(data));
}

function restoreLocalState() {
  const raw = localStorage.getItem(state.localStateKey);
  if (!raw) {
    return;
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  for (const [id, value] of Object.entries(data)) {
    if (id === "activeTab" || id === "assetProfileVersion") {
      continue;
    }
    const input = elements[id];
    if (!input) {
      continue;
    }
    if (input.type === "checkbox") {
      input.checked = Boolean(value);
    } else {
      input.value = value;
    }
  }

  if (data.assetProfileVersion !== ASSET_PROFILE_STORAGE_VERSION) {
    elements.assetChunkSize.value = "100";
    elements.assetZipWebpMaxQuality.value = "85";
    if (String(data.assetZipWebpMinQuality ?? "70") === "70") {
      elements.assetZipWebpMinQuality.value = "65";
    }
    elements.assetPdfJpegMaxQuality.value = "75";
    elements.assetPdfMaxLongEdge.value = "1600";
    if (isLegacySplitOutput(elements.assetOutputDir.value)) {
      elements.assetOutputDir.value = state.defaultOptimizedDir;
    }
    if (isLegacySplitOutput(elements.postInputDir.value)) {
      elements.postInputDir.value = state.defaultOptimizedDir;
    }
    saveLocalState();
  }

  if (data.activeTab) {
    switchTab(data.activeTab);
  }
}

function isLegacySplitOutput(value) {
  return /(?:^|[\\/])optimized_split[\\/]?$/i.test(String(value || "").trim());
}
