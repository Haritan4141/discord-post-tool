// Manifest namespaces for folder-driven Discord category / forum placement.
// Flat inputs keep their original journal; nested inputs never flatten names.
function own(map, key) {
  return map && Object.hasOwn(map, key) ? map[key] : undefined;
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Invalid forum manifest: ${label}`);
  }
  return value;
}

function put(map, key, value) {
  Object.defineProperty(map, key, { value, writable: true, enumerable: true, configurable: true });
  return value;
}

function guildEntry(manifest, guildId, create) {
  if (!manifest.guilds && create) manifest.guilds = {};
  if (!manifest.guilds) return undefined;
  const guilds = object(manifest.guilds, "guilds");
  let entry = own(guilds, guildId);
  if (!entry && create) entry = put(guilds, guildId, { categories: {} });
  return entry && object(entry, "guild");
}

function folderCategory(manifest, guildId, parentName, create = false) {
  const guild = guildEntry(manifest, guildId, create);
  if (!guild) return undefined;
  if (!guild.folderCategories && create) guild.folderCategories = {};
  if (!guild.folderCategories) return undefined;
  const parents = object(guild.folderCategories, "folderCategories");
  let entry = own(parents, parentName);
  if (!entry && create) entry = put(parents, parentName, { id: null, name: parentName, forums: {} });
  return entry && object(entry, "folder category");
}

function forumManifest(manifest, guildId, category, create = false) {
  let container;
  if (category.parentName !== undefined) {
    const parent = folderCategory(manifest, guildId, category.parentName, create);
    if (!parent) return undefined;
    if (!parent.forums && create) parent.forums = {};
    if (!parent.forums) return undefined;
    container = object(parent.forums, "forums");
  } else {
    const guild = guildEntry(manifest, guildId, create);
    if (!guild) return undefined;
    if (!guild.categories && create) guild.categories = {};
    if (!guild.categories) return undefined;
    container = object(guild.categories, "categories");
  }
  let entry = own(container, category.name);
  if (!entry && create) entry = put(container, category.name, { id: null, name: category.name, groups: {} });
  if (entry) {
    object(entry, "forum");
    if (!entry.groups && create) entry.groups = {};
    if (entry.groups) object(entry.groups, "groups");
  }
  return entry;
}

function groupManifest(manifest, guildId, category, name, create = false) {
  const forum = forumManifest(manifest, guildId, category, create);
  if (!forum?.groups) return undefined;
  let entry = own(forum.groups, name);
  if (!entry && create) entry = put(forum.groups, name, { channelId: null, files: {} });
  return entry && object(entry, "work");
}

module.exports = { own, put, folderCategory, forumManifest, groupManifest };
