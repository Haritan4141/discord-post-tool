const { spawn } = require("node:child_process");
const path = require("node:path");

const electronPath = require("electron");
const rootDir = path.resolve(__dirname, "..", "..");
const args = [rootDir, ...process.argv.slice(2)];
const env = { ...process.env };

delete env.ELECTRON_RUN_AS_NODE;
env.DISCORD_POST_TOOL_NODE = process.execPath;

const child = spawn(electronPath, args, {
  cwd: rootDir,
  env,
  stdio: "inherit",
  windowsHide: false,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
