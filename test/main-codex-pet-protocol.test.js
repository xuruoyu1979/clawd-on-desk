const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const MAIN = path.join(ROOT, "src", "main.js");
const PACKAGE_JSON = path.join(ROOT, "package.json");
const LAUNCH = path.join(ROOT, "launch.js");

test("main wires clawd:// protocol dispatch through the Codex Pet importer", () => {
  const source = fs.readFileSync(MAIN, "utf8");

  assert.ok(source.includes('const codexPetImporter = require("./codex-pet-importer");'));
  assert.ok(source.includes('app.on("open-url"'));
  assert.ok(source.includes('app.on("second-instance"'));
  assert.ok(source.includes("_enqueueCodexPetImportUrlsFromArgv(commandLine);"));
  assert.ok(source.includes("_enqueueCodexPetImportUrlsFromArgv(process.argv);"));
  assert.ok(source.includes("codexPetImporter.parseClawdImportUrl(rawUrl)"));
  assert.ok(source.includes("codexPetImporter.importCodexPetFromUrl(parsed.url, {"));
  assert.ok(source.includes("confirmReplaceExistingPackage: _confirmReplaceExistingCodexPetPackage"));
  assert.ok(source.includes("codexPetImporter.ERR_REPLACE_DECLINED"));
  assert.ok(source.includes("async function _confirmReplaceExistingCodexPetPackage"));
  assert.ok(source.includes('setThemeSelection", { themeId: generated.themeId }'));
});

test("package metadata registers the clawd protocol and exposes dev registration", () => {
  const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, "utf8"));
  const launchSource = fs.readFileSync(LAUNCH, "utf8");
  const protocols = (((pkg || {}).build || {}).protocols || []);

  assert.ok(pkg.scripts["register-protocol:dev"].includes("--register-protocol"));
  assert.ok(protocols.some((entry) => Array.isArray(entry.schemes) && entry.schemes.includes("clawd")));
  assert.ok(launchSource.includes("process.argv.slice(2)"));
  assert.ok(launchSource.includes("...forwardedArgs"));
});
