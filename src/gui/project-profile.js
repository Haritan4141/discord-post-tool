const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

function projectProfilePath(rootDir, legacyUserData) {
  let canonical = fs.realpathSync.native(rootDir);
  if (process.platform === "win32") canonical = canonical.toLowerCase();
  const id = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 24);
  return path.join(legacyUserData, "projects", id);
}

function migrateLocalStorage(legacyUserData, profileDir) {
  const source = path.join(legacyUserData, "Local Storage");
  const destination = path.join(profileDir, "Local Storage");
  if (fs.existsSync(destination) || !fs.existsSync(source)) return false;
  // Copy only saved form state, never the old shared GPU/session caches.
  // First upgrade must happen with all old-version windows closed.
  const staging = path.join(profileDir, `local-storage-migration-${crypto.randomUUID()}`);
  fs.cpSync(source, staging, { recursive: true, errorOnExist: true, force: false });
  fs.renameSync(staging, destination);
  return true;
}

module.exports = { projectProfilePath, migrateLocalStorage };
