const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { runtimeDirectory, withFileMutex } = require("./runtime-locks");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function discordFetch(token, url, init = {}, options = {}) {
  const normalizedToken = String(token).trim().replace(/^Bot\s+/i, "");
  const key = crypto.createHash("sha256").update(normalizedToken).digest("hex");
  const dir = path.join(options.runtimeDir || runtimeDirectory(), "bots", key);
  const stateFile = path.join(dir, "rate.json");
  const fetchImpl = options.fetch || globalThis.fetch;
  const intervalMs = options.intervalMs ?? 100;

  for (let attempt = 0; attempt < 8;) {
    const result = await withFileMutex(path.join(dir, "request"), async () => {
      let state = { nextAllowedAt: 0 };
      try {
        state = JSON.parse(await fs.readFile(stateFile, "utf8"));
        if (!Number.isFinite(state.nextAllowedAt)) throw new Error("Invalid rate state");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const waitMs = state.nextAllowedAt - Date.now();
      if (waitMs > 0) return { waitMs };

      const headers = new Headers(init.headers);
      headers.set("Authorization", `Bot ${normalizedToken}`);
      const signal = init.signal || AbortSignal.timeout(120000);
      const response = await fetchImpl(url, { ...init, headers, signal });
      let delayMs = intervalMs;
      if (response.headers.get("x-ratelimit-remaining") === "0") {
        const seconds = Number(response.headers.get("x-ratelimit-reset-after"));
        if (Number.isFinite(seconds) && seconds > 0) {
          delayMs = Math.max(delayMs, Math.ceil(seconds * 1000) + 100);
        }
      }
      if (response.status === 429) {
        const body = await response.clone().json().catch(() => ({}));
        const seconds = Number(body.retry_after || response.headers.get("retry-after") || 1);
        delayMs = Math.max(delayMs, Math.ceil((Number.isFinite(seconds) ? seconds : 1) * 1000) + 250);
      }
      // Conservatively share every cooldown across all routes for this Bot.
      // Tokens are never persisted; independent projects use the same hash key.
      const temporary = `${stateFile}.${crypto.randomUUID()}.tmp`;
      await fs.writeFile(temporary, JSON.stringify({ nextAllowedAt: Date.now() + delayMs }), {
        mode: 0o600,
      });
      await fs.rename(temporary, stateFile);
      return { response, delayMs };
    });

    if (result.waitMs) {
      await sleep(result.waitMs);
      continue;
    }
    attempt += 1;
    if (result.response.status !== 429) return result.response;
    options.onRateLimit?.(result.delayMs / 1000);
    if (attempt === 8) return result.response;
  }
}

module.exports = { discordFetch };
