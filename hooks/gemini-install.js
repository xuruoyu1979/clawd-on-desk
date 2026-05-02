#!/usr/bin/env node
// Merge Clawd Gemini CLI hooks into ~/.gemini/settings.json (append-only, idempotent)

const fs = require("fs");
const path = require("path");
const os = require("os");
const { resolveNodeBin } = require("./server-config");
const { writeJsonAtomic, asarUnpackedPath, extractExistingNodeBin, formatNodeHookCommand } = require("./json-utils");
const MARKER = "gemini-hook.js";
const DEFAULT_PARENT_DIR = path.join(os.homedir(), ".gemini");
const DEFAULT_CONFIG_PATH = path.join(DEFAULT_PARENT_DIR, "settings.json");

const GEMINI_HOOK_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "BeforeAgent",
  "AfterAgent",
  "BeforeTool",
  "AfterTool",
  "Notification",
  "PreCompress",
];

function isClawdHookCommand(command) {
  return typeof command === "string" && command.includes(MARKER);
}

function buildGeminiHookEntry(command) {
  return {
    matcher: "*",
    hooks: [{ name: "clawd", type: "command", command }],
  };
}

function buildGeminiHookCommand(nodeBin, hookScript, event, options = {}) {
  return `${formatNodeHookCommand(nodeBin, hookScript, options)} ${event}`;
}

function normalizeGeminiHookEntry(entry, desiredCommand) {
  if (!entry || typeof entry !== "object") return { matched: false, changed: false };

  if (isClawdHookCommand(entry.command)) {
    const desired = buildGeminiHookEntry(desiredCommand);
    const changed = JSON.stringify(entry) !== JSON.stringify(desired);
    if (changed) {
      for (const key of Object.keys(entry)) delete entry[key];
      Object.assign(entry, desired);
    }
    return { matched: true, changed };
  }

  if (!Array.isArray(entry.hooks)) return { matched: false, changed: false };
  const hook = entry.hooks.find((candidate) => candidate && isClawdHookCommand(candidate.command));
  if (!hook) return { matched: false, changed: false };

  let changed = false;
  if (entry.matcher !== "*") {
    entry.matcher = "*";
    changed = true;
  }
  if (hook.name !== "clawd") {
    hook.name = "clawd";
    changed = true;
  }
  if (hook.type !== "command") {
    hook.type = "command";
    changed = true;
  }
  if (hook.command !== desiredCommand) {
    hook.command = desiredCommand;
    changed = true;
  }
  return { matched: true, changed };
}

/**
 * Register Clawd hooks into ~/.gemini/settings.json
 * @param {object} [options]
 * @param {boolean} [options.silent]
 * @param {string} [options.settingsPath]
 * @returns {{ added: number, skipped: number, updated: number }}
 */
function registerGeminiHooks(options = {}) {
  const settingsPath = options.settingsPath || path.join(os.homedir(), ".gemini", "settings.json");

  // Skip if ~/.gemini/ doesn't exist (Gemini CLI not installed)
  const geminiDir = path.dirname(settingsPath);
  if (!options.settingsPath && !fs.existsSync(geminiDir)) {
    if (!options.silent) console.log("Clawd: ~/.gemini/ not found — skipping Gemini hook registration");
    return { added: 0, skipped: 0, updated: 0 };
  }

  const hookScript = asarUnpackedPath(path.resolve(__dirname, "gemini-hook.js").replace(/\\/g, "/"));

  let settings = {};
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read settings.json: ${err.message}`);
    }
  }

  // Resolve node path; if detection fails, preserve existing absolute path
  const resolved = options.nodeBin !== undefined ? options.nodeBin : resolveNodeBin();
  const nodeBin = resolved
    || extractExistingNodeBin(settings, MARKER, { nested: true })
    || "node";

  if (!settings.hooks || typeof settings.hooks !== "object") settings.hooks = {};

  let added = 0;
  let skipped = 0;
  let updated = 0;
  let changed = false;

  for (const event of GEMINI_HOOK_EVENTS) {
    const desiredCommand = buildGeminiHookCommand(nodeBin, hookScript, event);
    if (!Array.isArray(settings.hooks[event])) {
      settings.hooks[event] = [];
      changed = true;
    }

    const arr = settings.hooks[event];
    let found = false;
    let entryChanged = false;
    for (const entry of arr) {
      const result = normalizeGeminiHookEntry(entry, desiredCommand);
      if (!result.matched) continue;
      found = true;
      if (result.changed) {
        entryChanged = true;
        changed = true;
      }
      break;
    }

    if (found) {
      if (entryChanged) {
        updated++;
      } else {
        skipped++;
      }
      continue;
    }

    arr.push(buildGeminiHookEntry(desiredCommand));
    added++;
    changed = true;
  }

  if (added > 0 || changed) {
    writeJsonAtomic(settingsPath, settings);
  }

  if (!options.silent) {
    console.log(`Clawd Gemini hooks → ${settingsPath}`);
    console.log(`  Added: ${added}, updated: ${updated}, skipped: ${skipped}`);
  }

  return { added, skipped, updated };
}

module.exports = {
  DEFAULT_PARENT_DIR,
  DEFAULT_CONFIG_PATH,
  registerGeminiHooks,
  GEMINI_HOOK_EVENTS,
  __test: { buildGeminiHookCommand },
};

if (require.main === module) {
  try {
    registerGeminiHooks({});
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
