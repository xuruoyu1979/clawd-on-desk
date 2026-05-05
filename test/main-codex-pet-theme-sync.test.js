const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const MAIN = path.join(ROOT, "src", "main.js");
const PRELOAD_SETTINGS = path.join(ROOT, "src", "preload-settings.js");
const SETTINGS_ACTIONS = path.join(ROOT, "src", "settings-actions.js");
const SETTINGS_TAB_THEME = path.join(ROOT, "src", "settings-tab-theme.js");

test("main syncs Codex Pet themes before the first theme load", () => {
  const source = fs.readFileSync(MAIN, "utf8");
  const syncIdx = source.indexOf("let _startupCodexPetSyncSummary = _syncCodexPetThemesForMain(_requestedThemeId);");
  const loadIdx = source.indexOf("let activeTheme = themeLoader.loadTheme(_requestedThemeId");

  assert.ok(source.includes('const codexPetAdapter = require("./codex-pet-adapter");'));
  assert.ok(syncIdx >= 0, "startup Codex Pet sync should be present");
  assert.ok(loadIdx >= 0, "initial theme load should be present");
  assert.ok(syncIdx < loadIdx, "Codex Pet sync must run before loading the selected theme");
  assert.ok(source.includes("_summaryHasActiveCodexPetOrphan(_startupCodexPetSyncSummary, _requestedThemeId)"));
  assert.ok(source.includes('theme: _requestedThemeId,'));
});

test("settings exposes Codex Pet refresh and managed theme metadata", () => {
  const mainSource = fs.readFileSync(MAIN, "utf8");
  const preloadSource = fs.readFileSync(PRELOAD_SETTINGS, "utf8");
  const tabSource = fs.readFileSync(SETTINGS_TAB_THEME, "utf8");

  assert.ok(mainSource.includes('ipcMain.handle("settings:refresh-codex-pets"'));
  assert.ok(mainSource.includes('ipcMain.handle("settings:open-codex-pets-dir"'));
  assert.ok(mainSource.includes('ipcMain.handle("settings:import-codex-pet-zip"'));
  assert.ok(mainSource.includes('ipcMain.handle("settings:remove-codex-pet"'));
  assert.ok(mainSource.includes("codexPetImporter.importCodexPetFromZipBuffer"));
  assert.ok(mainSource.includes("fs.promises.readFile(zipPath)"));
  assert.ok(mainSource.includes("_resolveCodexPetRemovalTarget(themeId)"));
  assert.ok(mainSource.includes("fs.promises.rm(target.packageDir"));
  assert.ok(mainSource.includes("_decorateCodexPetThemeMetadata({"));
  assert.ok(mainSource.includes("managedCodexPet: true"));
  assert.ok(mainSource.includes("function _getCodexPetPreviewAtlasUrl"));
  assert.ok(mainSource.includes("previewAtlasUrl: _getCodexPetPreviewAtlasUrl(theme.id, marker)"));
  assert.ok(mainSource.includes("unchanged: (a.unchanged || 0) + (b.unchanged || 0)"));
  assert.ok(preloadSource.includes('refreshCodexPets: () => ipcRenderer.invoke("settings:refresh-codex-pets")'));
  assert.ok(preloadSource.includes('openCodexPetsDir: () => ipcRenderer.invoke("settings:open-codex-pets-dir")'));
  assert.ok(preloadSource.includes('importCodexPetZip: () => ipcRenderer.invoke("settings:import-codex-pet-zip")'));
  assert.ok(preloadSource.includes('removeCodexPet: (themeId) => ipcRenderer.invoke("settings:remove-codex-pet", themeId)'));
  assert.ok(tabSource.includes("theme.managedCodexPet"));
  assert.ok(tabSource.includes("themeRefreshImportedPets"));
  assert.ok(tabSource.includes("themeImportPetZip"));
  assert.ok(tabSource.includes("themeOpenCodexPetsFolder"));
  assert.ok(tabSource.includes("themeUninstallPetLabel"));
  assert.ok(tabSource.includes("handleRemoveCodexPet"));
  assert.ok(tabSource.includes("getThemeSections"));
  assert.ok(tabSource.includes("themeGroupImportedCodexPets"));
});

test("managed Codex Pet themes cannot be removed through the user-theme delete command", () => {
  const mainSource = fs.readFileSync(MAIN, "utf8");
  const actionsSource = fs.readFileSync(SETTINGS_ACTIONS, "utf8");

  assert.ok(mainSource.includes("managedCodexPet: !!_readCodexPetManagedThemeMarker(themeId)"));
  assert.ok(actionsSource.includes("info.managedCodexPet"));
  assert.ok(actionsSource.includes("remove it from Petdex instead"));
});
