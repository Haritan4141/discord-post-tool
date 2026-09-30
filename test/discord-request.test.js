const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { discordFetch } = require("../src/discord-request");

async function fixture(t) {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), "discord-request-safety-"));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  return runtimeDir;
}

test("transport failures are not retried and release the shared Bot mutex", async (t) => {
  const runtimeDir = await fixture(t);
  let calls = 0;
  await assert.rejects(discordFetch("fixture-bot", "https://fixture.invalid", { method: "POST" }, {
    runtimeDir, fetch: async () => { calls += 1; throw new TypeError("fixture transport failure"); },
  }), /fixture transport failure/);
  assert.equal(calls, 1);
  const response = await discordFetch("fixture-bot", "https://fixture.invalid", {}, {
    runtimeDir, intervalMs: 0, fetch: async () => new Response("{}"),
  });
  assert.equal(response.status, 200);
});

test("an aborted fetch releases the mutex without retrying an ambiguous POST", async (t) => {
  const runtimeDir = await fixture(t);
  const abort = new AbortController();
  let calls = 0;
  const request = discordFetch("fixture-timeout", "https://fixture.invalid", {
    method: "POST", signal: abort.signal,
  }, {
    runtimeDir, fetch: async (_url, init) => {
      calls += 1;
      return new Promise((_resolve, reject) => {
        const rejectAborted = () => reject(init.signal.reason);
        init.signal.addEventListener("abort", rejectAborted, { once: true });
        abort.abort(new DOMException("fixture timeout", "TimeoutError"));
      });
    },
  });
  await assert.rejects(request, { name: "TimeoutError" });
  assert.equal(calls, 1);
  await discordFetch("fixture-timeout", "https://fixture.invalid", {}, {
    runtimeDir, intervalMs: 0, fetch: async () => new Response("{}"),
  });
});

test("eight repeated 429 responses respect cooldowns and return the final response", async (t) => {
  const runtimeDir = await fixture(t);
  const starts = [];
  const response = await discordFetch("fixture-429", "https://fixture.invalid", {}, {
    runtimeDir, intervalMs: 0, fetch: async () => {
      starts.push(Date.now());
      return new Response(JSON.stringify({ retry_after: 0.001, global: true }), { status: 429 });
    },
  });
  assert.equal(response.status, 429);
  assert.equal(starts.length, 8);
  for (let index = 1; index < starts.length; index += 1) {
    assert.ok(starts[index] - starts[index - 1] >= 240);
  }
});

test("different Bots do not serialize independent requests", async (t) => {
  const runtimeDir = await fixture(t);
  let entered = 0, active = 0, peak = 0, release;
  const both = new Promise((resolve) => { release = resolve; });
  const fetch = async () => {
    entered += 1;
    peak = Math.max(peak, ++active);
    if (entered === 2) release();
    await both;
    active -= 1;
    return new Response("{}");
  };
  const watchdog = setTimeout(() => release(), 3000);
  try {
    await Promise.all(["fixture-a", "fixture-b"].map((token) =>
      discordFetch(token, "https://fixture.invalid", {}, { runtimeDir, intervalMs: 0, fetch })));
    assert.equal(entered, 2);
    assert.equal(peak, 2);
  } finally { clearTimeout(watchdog); }
});
