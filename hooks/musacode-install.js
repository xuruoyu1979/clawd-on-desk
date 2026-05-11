#!/usr/bin/env node
// Register Clawd's musacode plugin in the user's global musacode config.
//
// Strategy: append the absolute path of hooks/musacode-plugin/ into
// ~/.config/musacode/musacode.jsonc under the "plugin" array. Idempotent.
//
// Why global musacode.jsonc and not plugins/ directory scanning:
//   - Global scope (~/.config/musacode/musacode.jsonc) applies to every project
//     the user opens, matching Gemini/Cursor install behavior.

const fs = require("fs");
const path = require("path");
const os = require("os");
const { writeJsonAtomic, readJsonc, asarUnpackedPath } = require("./json-utils");

const PLUGIN_DIR_NAME = "musacode-plugin";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".config", "musacode");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "musacode.jsonc");

/**
 * Resolve the absolute path to hooks/musacode-plugin/ as seen from a running
 * musacode (Bun) process. When Clawd is packaged into app.asar, hooks/** is
 * unpacked to app.asar.unpacked/ (see package.json "asarUnpack"). musacode
 * cannot require files inside asar, so we must point it at the unpacked copy.
 *
 * @param {string} [baseDir]  defaults to __dirname (hooks/); exposed for tests
 */
function resolvePluginDir(baseDir) {
  // Normalize to forward slashes for JSON storage + cross-platform musacode compat
  const dir = path.resolve(baseDir || __dirname, PLUGIN_DIR_NAME).replace(/\\/g, "/");
  return asarUnpackedPath(dir);
}

/**
 * Register the Clawd musacode plugin in ~/.config/musacode/musacode.jsonc.
 *
 * @param {object} [options]
 * @param {boolean} [options.silent]   suppress console output
 * @param {string}  [options.configPath]  override path to musacode.jsonc (for tests)
 * @param {string}  [options.pluginDir]   override plugin dir absolute path (for tests)
 * @returns {{ added: boolean, skipped: boolean, created: boolean, configPath: string, pluginDir: string }}
 */
function registerMusacodePlugin(options = {}) {
  const configDir = path.join(os.homedir(), ".config", "musacode");
  const configPath = options.configPath || path.join(configDir, "musacode.jsonc");
  const pluginDir = options.pluginDir || resolvePluginDir();

  // Skip if ~/.config/musacode/ doesn't exist (musacode not installed) — unless caller overrides
  if (!options.configPath) {
    let exists = false;
    try { exists = fs.statSync(configDir).isDirectory(); } catch {}
    if (!exists) {
      if (!options.silent) {
        console.log("Clawd: ~/.config/musacode/ not found — skipping musacode plugin registration");
      }
      return { added: false, skipped: true, created: false, configPath, pluginDir };
    }
  }

  let settings = {};
  let created = false;
  try {
    const raw = fs.readFileSync(configPath, "utf-8");
    settings = readJsonc(configPath);
    if (!settings || typeof settings !== "object") settings = {};
  } catch (err) {
    if (err.code === "ENOENT") {
      settings = {};
      created = true;
    } else {
      // Parse error or other I/O — do not clobber the user's config
      throw new Error(`Failed to read ${configPath}: ${err.message}`);
    }
  }

  if (!Array.isArray(settings.plugin)) settings.plugin = [];

  // Idempotency: match by exact path OR by directory basename on an
  // absolute-path entry. Basename catches stale paths from earlier installs
  // at different locations (dev vs packaged) and updates them in place.
  // The isAbsolute guard is critical: musacode may also accept npm package
  // specifiers in the plugin array (e.g. "musacode-wakatime" or a scoped
  // "@vendor/musacode-plugin"), and path.basename of a scoped package name
  // happens to return the segment after the slash — so a naive basename
  // equality would stomp any third-party scoped package ending in
  // "/musacode-plugin". Clawd itself only ever writes absolute paths, so
  // restricting the match to absolute entries is safe.
  let matchIndex = -1;
  for (let i = 0; i < settings.plugin.length; i++) {
    const entry = settings.plugin[i];
    if (typeof entry !== "string") continue;
    if (entry === pluginDir) {
      matchIndex = i;
      break;
    }
    const normalized = entry.replace(/\\/g, "/");
    // Platform-agnostic absolute-path check: POSIX (/foo) or Windows (C:/foo).
    // Config files can sync across machines, so we accept either shape.
    const isAbsolute = path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized);
    if (isAbsolute && path.posix.basename(normalized) === PLUGIN_DIR_NAME) {
      matchIndex = i;
      break;
    }
  }

  let added = false;
  let skipped = false;
  if (matchIndex === -1) {
    settings.plugin.push(pluginDir);
    added = true;
  } else if (settings.plugin[matchIndex] !== pluginDir) {
    // Stale path (e.g. old install location) — update in place
    settings.plugin[matchIndex] = pluginDir;
    added = true; // counts as a change for atomic write
  } else {
    skipped = true;
  }

  if (!skipped) {
    writeJsonAtomic(configPath, settings);
  }

  if (!options.silent) {
    console.log(`Clawd musacode plugin → ${configPath}`);
    if (created) console.log("  Created musacode.jsonc");
    if (added) console.log(`  Registered: ${pluginDir}`);
    if (skipped) console.log(`  Already registered: ${pluginDir}`);
  }

  return { added, skipped, created, configPath, pluginDir };
}

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  registerMusacodePlugin,
  resolvePluginDir,
};

if (require.main === module) {
  try {
    registerMusacodePlugin({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
