const fs = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);
let selfIdentityPromise;

function processExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "ESRCH" ? false : null; }
}

async function readIdentities(pids) {
  const results = new Map();
  const pending = [];
  for (const pid of new Set(pids)) {
    if (processExists(pid) === false) results.set(pid, { status: "dead" });
    else pending.push(pid);
  }
  if (!pending.length) return results;
  if (process.platform === "win32") {
    // Read only PID/creation metadata. Never pass tokens or command lines.
    const script = `$results = @(foreach ($targetPid in @(${pending.join(",")})) {
      try {
        $proc = [System.Diagnostics.Process]::GetProcessById($targetPid)
        try {
          $created = $proc.StartTime.ToUniversalTime().Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
          [pscustomobject]@{pid=$targetPid;created=$created;status='known'}
        } finally { $proc.Dispose() }
      } catch { [pscustomobject]@{pid=$targetPid;created=$null;status='unknown'} }
    }); ConvertTo-Json -InputObject $results -Compress`;
    try {
      const executable = path.join(process.env.SystemRoot || "C:\\Windows",
        "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const { stdout } = await execFileAsync(executable,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, timeout: 10000, maxBuffer: 1024 * 1024 });
      const decoded = JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
      for (const entry of Array.isArray(decoded) ? decoded : [decoded]) {
        if (pending.includes(entry.pid) && entry.status === "known" &&
            typeof entry.created === "string" && /^\d+$/.test(entry.created)) {
          results.set(entry.pid, { status: "known", identity: `win32:${entry.created}` });
        }
      }
    } catch { /* Helper/permission/observation failures stay unknown. */ }
  } else if (process.platform === "linux") {
    try {
      const boot = (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      if (!boot) throw new Error("Missing boot identity");
      await Promise.all(pending.map(async (pid) => {
        try {
          const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
          const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
          if (!/^\d+$/.test(fields[19] || "")) throw new Error("Invalid process metadata");
          if (["Z", "X", "x"].includes(fields[0])) {
            results.set(pid, { status: "dead" });
            return;
          }
          results.set(pid, { status: "known", identity: `linux:${boot}:${fields[19]}` });
        } catch { /* Confirm absence below; otherwise remain unknown. */ }
      }));
    } catch { /* Unknown is safer than reclaiming a live owner. */ }
  }
  for (const pid of pending) {
    if (!results.has(pid)) results.set(pid,
      { status: processExists(pid) === false ? "dead" : "unknown" });
  }
  return results;
}

async function getProcessIdentity() {
  selfIdentityPromise ||= readIdentities([process.pid]).then((results) => {
    const own = results.get(process.pid);
    if (own?.status !== "known") {
      throw new Error("プロセスの作成時刻を確認できないため、安全のため停止しました。");
    }
    return own.identity;
  });
  return selfIdentityPromise;
}

async function ownerStates(owners) {
  const identities = await readIdentities(owners.filter((owner) => owner.pid !== process.pid)
    .map((owner) => owner.pid));
  identities.set(process.pid, { status: "known", identity: await getProcessIdentity() });
  return owners.map((owner) => {
    const observed = identities.get(owner.pid);
    if (observed.status === "dead") return "dead";
    // Legacy leases have no birth identity: a living/reused PID stays protected.
    if (!owner.processIdentity || observed.status !== "known") return "unknown";
    return observed.identity === owner.processIdentity ? "alive" : "dead";
  });
}

module.exports = { getProcessIdentity, ownerStates };
