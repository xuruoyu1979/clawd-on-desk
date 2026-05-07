const { app, BrowserWindow, screen, ipcMain, globalShortcut, nativeTheme, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs");
const { applyStationaryCollectionBehavior } = require("./mac-window");
const {
  applyWindowsAppUserModelId,
  shouldOpenSettingsWindowFromArgv,
} = require("./settings-window-icon");
const createSettingsWindowRuntime = require("./settings-window");
const {
  createSettingsSizePreviewSession,
} = require("./settings-size-preview-session");
const { registerSettingsIpc } = require("./settings-ipc");
const createSettingsEffectRouter = require("./settings-effect-router");
const { registerSessionIpc } = require("./session-ipc");
const { registerPetInteractionIpc } = require("./pet-interaction-ipc");
const initPermission = require("./permission");
const { registerPermissionIpc } = initPermission;
const initUpdateBubble = require("./update-bubble");
const { registerUpdateBubbleIpc } = initUpdateBubble;
const createSettingsAnimationOverridesMain = require("./settings-animation-overrides-main");
const { registerSettingsAnimationOverridesIpc } = createSettingsAnimationOverridesMain;
const createShortcutRuntime = require("./shortcut-runtime");
const createPetGeometryMain = require("./pet-geometry-main");
const {
  findNearestWorkArea,
  computeLooseClamp,
  getDisplayInsets,
  buildDisplaySnapshot,
  findMatchingDisplay,
  isPointInAnyWorkArea,
  SYNTHETIC_WORK_AREA,
} = require("./work-area");
const {
  getThemeMarginBox,
  computeStableVisibleContentMargins,
  getLooseDragMargins,
  getRestClampMargins,
} = require("./visible-margins");
const {
  createDragSnapshot,
  computeAnchoredDragBounds,
  computeFinalDragBounds,
  needsFinalClampAdjustment,
  materializeVirtualBounds,
} = require("./drag-position");
const {
  getLaunchPixelSize,
  getLaunchSizingWorkArea,
  getProportionalPixelSize,
} = require("./size-utils");
const { keepOutOfTaskbar } = require("./taskbar");
const {
  animateWindowOpacity,
  setWindowOpacity,
} = require("./window-opacity-transition");
const {
  getFocusableLocalHudSessionIds: selectFocusableLocalHudSessionIds,
} = require("./session-focus");
const { getAllAgents } = require("../agents/registry");

// ── Autoplay policy: allow sound playback without user gesture ──
// MUST be set before any BrowserWindow is created (before app.whenReady)
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const isMac = process.platform === "darwin";
const isLinux = process.platform === "linux";
const isWin = process.platform === "win32";
const LINUX_WINDOW_TYPE = "toolbar";
const THEME_SWITCH_FADE_OUT_MS = 140;
const THEME_SWITCH_FADE_IN_MS = 180;
const THEME_SWITCH_FADE_FALLBACK_MS = 4000;

applyWindowsAppUserModelId(app, process.platform);


// ── Windows: AllowSetForegroundWindow via FFI ──
let _allowSetForeground = null;
if (isWin) {
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    _allowSetForeground = user32.func("bool __stdcall AllowSetForegroundWindow(int dwProcessId)");
  } catch (err) {
    console.warn("Clawd: koffi/AllowSetForegroundWindow not available:", err.message);
  }
}


// ── Window size presets ──
const SIZES = {
  S: { width: 200, height: 200 },
  M: { width: 280, height: 280 },
  L: { width: 360, height: 360 },
};

// ── Settings (prefs.js + settings-controller.js) ──
//
// `prefs.js` handles disk I/O + schema validation + migrations.
// `settings-controller.js` is the single writer of the in-memory snapshot.
// Module-level `lang`/`showTray`/etc. below are mirror caches kept in sync via
// a subscriber wired after menu.js loads. The ctx setters route writes through
// `_settingsController.applyUpdate()`, which auto-persists.
const prefsModule = require("./prefs");
const { createSettingsController } = require("./settings-controller");
const { createTranslator, i18n } = require("./i18n");
const {
  getBubblePolicy,
  isAllBubblesHidden,
} = require("./bubble-policy");
const loginItemHelpers = require("./login-item");
const PREFS_PATH = path.join(app.getPath("userData"), "clawd-prefs.json");
const _initialPrefsLoad = prefsModule.load(PREFS_PATH);

// Lazy helpers — these run inside the action `effect` callbacks at click time,
// long after server.js / hooks/install.js are loaded. Wrapping them in closures
// avoids a chicken-and-egg require order at module load.
function _installAutoStartHook() {
  const { registerHooks } = require("../hooks/install.js");
  registerHooks({ silent: true, autoStart: true, port: getHookServerPort() });
}
function _uninstallAutoStartHook() {
  const { unregisterAutoStart } = require("../hooks/install.js");
  unregisterAutoStart();
}
async function _uninstallClaudeHooksNow() {
  const { unregisterHooksAsync } = require("../hooks/install.js");
  await unregisterHooksAsync();
}

// Cross-platform "open at login" writer used by both the openAtLogin effect
// and the startup hydration helper. Throws on failure so the action layer can
// surface the error to the UI.
function _writeSystemOpenAtLogin(enabled) {
  if (isLinux) {
    const launchScript = path.join(__dirname, "..", "launch.js");
    const execCmd = app.isPackaged
      ? `"${process.env.APPIMAGE || app.getPath("exe")}"`
      : `node "${launchScript}"`;
    loginItemHelpers.linuxSetOpenAtLogin(enabled, { execCmd });
    return;
  }
  app.setLoginItemSettings(
    loginItemHelpers.getLoginItemSettings({
      isPackaged: app.isPackaged,
      openAtLogin: enabled,
      execPath: process.execPath,
      appPath: app.getAppPath(),
    })
  );
}
function _readSystemOpenAtLogin() {
  if (isLinux) return loginItemHelpers.linuxGetOpenAtLogin();
  return app.getLoginItemSettings(
    app.isPackaged ? {} : { path: process.execPath, args: [app.getAppPath()] }
  ).openAtLogin;
}

// Forward declarations — these are defined later in the file but the
// controller's injectedDeps need to resolve them lazily. Using a function
// wrapper lets us bind them after module scope finishes without a second
// `setDeps()` API on the controller.
function _deferredStartMonitorForAgent(id) {
  return startMonitorForAgent(id);
}
function _deferredStopMonitorForAgent(id) {
  return stopMonitorForAgent(id);
}
function _deferredSyncIntegrationForAgent(id) {
  return _server && typeof _server.syncIntegrationForAgent === "function"
    ? _server.syncIntegrationForAgent(id)
    : false;
}
function _deferredRepairIntegrationForAgent(id, options) {
  return _server && typeof _server.repairIntegrationForAgent === "function"
    ? _server.repairIntegrationForAgent(id, options)
    : false;
}
function _deferredStopIntegrationForAgent(id) {
  return _server && typeof _server.stopIntegrationForAgent === "function"
    ? _server.stopIntegrationForAgent(id)
    : false;
}
function _deferredClearSessionsByAgent(id) {
  return _state && typeof _state.clearSessionsByAgent === "function"
    ? _state.clearSessionsByAgent(id)
    : 0;
}
function _deferredDismissPermissionsByAgent(id) {
  const removed = _perm && typeof _perm.dismissPermissionsByAgent === "function"
    ? _perm.dismissPermissionsByAgent(id)
    : 0;
  // Symmetric cleanup for Kimi's state.js animation lock: dismissing the
  // passive bubble alone would leave `kimiPermissionHolds` pinning
  // notification forever with nothing actionable (same class of bug we
  // already fixed for DND). Kimi is the only agent with a state-side
  // permission lock today, so scope the extra work to it.
  if (id === "kimi-cli" && _state && typeof _state.disposeAllKimiPermissionState === "function") {
    const disposed = _state.disposeAllKimiPermissionState();
    if (disposed && typeof _state.resolveDisplayState === "function" && typeof _state.setState === "function") {
      const resolved = _state.resolveDisplayState();
      _state.setState(resolved, _state.getSvgOverride ? _state.getSvgOverride(resolved) : undefined);
    }
  }
  return removed;
}
function _deferredResizePet(sizeKey) {
  // Bound to _menu.resizeWindow after menu module is created below. Settings
  // panel's size slider commands route through here so they get the same
  // window resize + hitWin sync + bubble reposition as the context menu.
  if (_menu && typeof _menu.resizeWindow === "function") {
    _menu.resizeWindow(sizeKey);
  }
}

let _restartScheduled = false;
function _restartClawdNow() {
  if (_restartScheduled) return;
  _restartScheduled = true;
  // Triggered by Doctor's restart-clawd repair. relaunch() queues a fresh
  // process; quit() then follows the normal shutdown path so before-quit
  // still flushes prefs and cleans up server/monitor resources.
  // setImmediate so the IPC reply for repairDoctorIssue lands in the
  // renderer before the main process starts closing windows.
  setImmediate(() => {
    isQuitting = true;
    app.relaunch();
    app.quit();
  });
}

let shortcutRuntime = null;
const shortcutHandlers = {
  togglePet: () => togglePetVisibility(),
};
const _settingsController = createSettingsController({
  prefsPath: PREFS_PATH,
  loadResult: _initialPrefsLoad,
  injectedDeps: {
    installAutoStart: _installAutoStartHook,
    uninstallAutoStart: _uninstallAutoStartHook,
    syncClaudeHooksNow: () => {
      const { registerHooksAsync } = require("../hooks/install.js");
      return registerHooksAsync({ silent: true, autoStart: autoStartWithClaude, port: getHookServerPort() });
    },
    uninstallClaudeHooksNow: _uninstallClaudeHooksNow,
    startClaudeSettingsWatcher: () => _server.startClaudeSettingsWatcher(),
    stopClaudeSettingsWatcher: () => _server.stopClaudeSettingsWatcher(),
    setOpenAtLogin: _writeSystemOpenAtLogin,
    startMonitorForAgent: _deferredStartMonitorForAgent,
    stopMonitorForAgent: _deferredStopMonitorForAgent,
    syncIntegrationForAgent: _deferredSyncIntegrationForAgent,
    repairIntegrationForAgent: _deferredRepairIntegrationForAgent,
    stopIntegrationForAgent: _deferredStopIntegrationForAgent,
    repairLocalServer: () => _server && typeof _server.repairRuntimeStatus === "function"
      ? _server.repairRuntimeStatus()
      : false,
    restartClawd: _restartClawdNow,
    clearSessionsByAgent: _deferredClearSessionsByAgent,
    dismissPermissionsByAgent: _deferredDismissPermissionsByAgent,
    resizePet: _deferredResizePet,
    getActiveSessionAliasKeys: () =>
      _state && typeof _state.getActiveSessionAliasKeys === "function"
        ? _state.getActiveSessionAliasKeys()
        : new Set(),
    // Theme deps — defined much later in the file, wrapped in lazy closures.
    // activateTheme accepts (themeId, variantId?, overrideMap?) and returns
    // { themeId, variantId } with the actually-resolved variantId
    // (lenient fallback on unknown variants).
    activateTheme: (id, variantId, overrideMap) => _deferredActivateTheme(id, variantId, overrideMap),
    getThemeInfo: (id) => _deferredGetThemeInfo(id),
    removeThemeDir: (id) => _deferredRemoveThemeDir(id),
    globalShortcut,
    shortcutHandlers,
    // The controller is created before shortcutRuntime because each side needs
    // the other. These callbacks may run before the runtime is assigned.
    getShortcutFailure: (actionId) => shortcutRuntime ? shortcutRuntime.getFailure(actionId) : null,
    clearShortcutFailure: (actionId) => {
      if (shortcutRuntime) shortcutRuntime.clearFailure(actionId);
    },
  },
});

// Mirror of `_settingsController.get("lang")` so existing sync read sites in
// menu.js / state.js / etc. don't have to round-trip through the controller.
// Updated by the settings-effect-router subscriber below; never
// assign directly.
let lang = _settingsController.get("lang");
const translate = createTranslator(() => lang);

function getDashboardI18nPayload() {
  const dict = i18n[lang] || i18n.en;
  return { lang, translations: { ...dict } };
}

// First-run import of system-backed settings into prefs. The actual truth for
// `openAtLogin` lives in OS login items / autostart files; if we just trusted
// the schema default (false), an upgrading user with login-startup already
// enabled would silently lose it the first time prefs is saved. So on first
// boot after this field exists in the schema, copy the system value INTO prefs
// and mark it hydrated. After that, prefs is the source of truth and the
// openAtLogin pre-commit gate handles future writes back to the system.
//
// MUST run inside app.whenReady() — Electron's app.getLoginItemSettings() is
// only stable after the app is ready. MUST run before createWindow() so the
// first menu render reads the hydrated value.
function hydrateSystemBackedSettings() {
  if (_settingsController.get("openAtLoginHydrated")) return;
  let systemValue = false;
  try {
    systemValue = !!_readSystemOpenAtLogin();
  } catch (err) {
    console.warn("Clawd: failed to read system openAtLogin during hydration:", err && err.message);
  }
  const result = _settingsController.hydrate({
    openAtLogin: systemValue,
    openAtLoginHydrated: true,
  });
  if (result && result.status === "error") {
    console.warn("Clawd: openAtLogin hydration failed:", result.message);
  }
}

// Capture window/mini runtime state into the controller and write to disk.
// Replaces the legacy `savePrefs()` callsites — they used to read fresh
// `win.getBounds()` and `_mini.*` at save time, so we mirror that here.
function flushRuntimeStateToPrefs() {
  if (!win || win.isDestroyed()) return;
  const bounds = getPetWindowBounds();
  _settingsController.applyBulk({
    x: bounds.x,
    y: bounds.y,
    positionSaved: true,
    positionThemeId: activeTheme ? activeTheme._id : "",
    positionVariantId: activeTheme ? activeTheme._variantId : "",
    positionDisplay: captureCurrentDisplaySnapshot(bounds),
    savedPixelWidth: bounds.width,
    savedPixelHeight: bounds.height,
    size: currentSize,
    miniMode: _mini.getMiniMode(),
    miniEdge: _mini.getMiniEdge(),
    preMiniX: _mini.getPreMiniX(),
    preMiniY: _mini.getPreMiniY(),
  });
}

// Snapshot the display the pet is currently on so the next launch can tell
// whether the same physical monitor is still attached (see startup regularize
// logic below). Returns null if screen.* is unavailable — any truthy snapshot
// here unlocks the "trust saved position" path, so we fail closed.
function captureCurrentDisplaySnapshot(bounds) {
  try {
    const display = screen.getDisplayNearestPoint({
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
    });
    return buildDisplaySnapshot(display);
  } catch {
    return null;
  }
}

const CodexSubagentClassifier = require("../agents/codex-subagent-classifier");
const {
  buildCodexMonitorUpdateOptions,
  isCodexMonitorPermissionEvent,
} = require("./codex-monitor-callback");
const _codexSubagentClassifier = new CodexSubagentClassifier();
let _codexMonitor = null;          // Codex CLI JSONL log polling instance
const CODEX_OFFICIAL_LOG_SUPPRESS_TTL_MS = 10 * 60 * 1000;
const CODEX_LOG_EVENTS_COVERED_BY_OFFICIAL_HOOKS = new Set([
  "session_meta",
  "event_msg:task_started",
  "event_msg:user_message",
  "event_msg:guardian_assessment",
  "response_item:function_call",
  "response_item:custom_tool_call",
  "event_msg:exec_command_end",
  "event_msg:patch_apply_end",
  "event_msg:custom_tool_call_output",
  "event_msg:task_complete",
]);
const codexOfficialHookSessions = new Map();

function markCodexOfficialHookSession(sessionId) {
  if (!sessionId) return;
  codexOfficialHookSessions.set(String(sessionId), Date.now());
}

function hasRecentCodexOfficialHookSession(sessionId) {
  const lastHookAt = codexOfficialHookSessions.get(String(sessionId));
  if (!lastHookAt) return false;
  if (Date.now() - lastHookAt > CODEX_OFFICIAL_LOG_SUPPRESS_TTL_MS) {
    codexOfficialHookSessions.delete(String(sessionId));
    return false;
  }
  return true;
}

function shouldSuppressCodexLogEvent(sessionId, state, event) {
  // P2: official PermissionRequest owns the interactive bubble. Drop the
  // legacy JSONL codex-permission notification for hook-active sessions so the
  // user does not see both the real approval bubble and the old "Got it" hint.
  if (state === "codex-permission") return hasRecentCodexOfficialHookSession(sessionId);
  if (!CODEX_LOG_EVENTS_COVERED_BY_OFFICIAL_HOOKS.has(event)) return false;
  return hasRecentCodexOfficialHookSession(sessionId);
}

function updateSessionFromServer(sessionId, state, event, opts = {}) {
  if (opts && opts.agentId === "codex" && opts.hookSource === "codex-official") {
    markCodexOfficialHookSession(sessionId);
  }
  return updateSession(sessionId, state, event, opts);
}

// Hook-based agents have no module-level monitor — they're gated at the
// HTTP route layer. Only log-poll agents hit these branches.
function startMonitorForAgent(agentId) {
  if (agentId === "codex" && _codexMonitor) _codexMonitor.start();
}
function stopMonitorForAgent(agentId) {
  if (agentId === "codex" && _codexMonitor) _codexMonitor.stop();
}

function safeConsoleError(...args) {
  try {
    console.error(...args);
  } catch (err) {
    try {
      const line = `${new Date().toISOString()} ${args.map((x) => String(x)).join(" ")}\n`;
      fs.appendFileSync(path.join(app.getPath("userData"), "clawd-main.log"), line);
    } catch {}
  }
}

// ── Theme loader ──
const themeLoader = require("./theme-loader");
const createCodexPetMain = require("./codex-pet-main");
themeLoader.init(__dirname, app.getPath("userData"));

let animationOverridesMain = null;
function bumpAnimationOverridePreviewPosterGeneration() {
  return animationOverridesMain && animationOverridesMain.bumpPreviewPosterGeneration();
}
function maybeDestroyIdleAnimationPreviewPosterWindow() {
  if (animationOverridesMain) animationOverridesMain.maybeDestroyIdlePreviewPosterWindow();
}

const settingsWindowRuntime = createSettingsWindowRuntime({
  app,
  BrowserWindow,
  fs,
  isWin,
  nativeTheme,
  path,
  onBeforeCreate: () => bumpAnimationOverridePreviewPosterGeneration(),
  onBeforeClosed: () => {
    bumpAnimationOverridePreviewPosterGeneration();
    if (shortcutRuntime) shortcutRuntime.stopRecording();
    void settingsSizePreviewSession.cleanup();
  },
  onAfterClosed: () => maybeDestroyIdleAnimationPreviewPosterWindow(),
});

function getSettingsWindow() {
  return settingsWindowRuntime.getWindow();
}

shortcutRuntime = createShortcutRuntime({
  ipcMain,
  globalShortcut,
  settingsController: _settingsController,
  getSettingsWindow,
  shortcutHandlers,
});

// The injected window/menu closures below are intentionally lazy. During
// startup before activeTheme / win / Settings window / rebuildAllMenus exist,
// only the sync/summary/merge methods are safe to call.
const codexPetMain = createCodexPetMain({
  app,
  BrowserWindow,
  dialog,
  fs,
  getActiveTheme: () => activeTheme,
  getLang: () => lang,
  getMainWindow: () => win,
  getSettingsWindow,
  path,
  rebuildAllMenus: () => rebuildAllMenus(),
  settingsController: _settingsController,
  shell,
  themeLoader,
});
const REGISTER_PROTOCOL_DEV_ARG = codexPetMain.REGISTER_PROTOCOL_DEV_ARG;
// Lenient load so a missing/corrupt user-selected theme can't brick boot.
// If lenient fell back to "clawd" OR the variant fell back to "default",
// hydrate prefs to match so the store stays truth.
//
// Startup runs BEFORE the window is ready, so we call themeLoader.loadTheme
// directly — not activateTheme (which requires ready windows) and not the
// setThemeSelection command (which goes through activateTheme). The runtime
// switch path via UI goes through setThemeSelection post-window-ready.
let _requestedThemeId = _settingsController.get("theme") || "clawd";
const _initialVariantMap = _settingsController.get("themeVariant") || {};
let _requestedVariantId = _initialVariantMap[_requestedThemeId] || "default";
const _initialThemeOverrides = _settingsController.get("themeOverrides") || {};
let _requestedThemeOverrides = _initialThemeOverrides[_requestedThemeId] || null;
let _startupCodexPetSyncSummary = codexPetMain.syncThemes(_requestedThemeId);
if (codexPetMain.summaryHasActiveOrphan(_startupCodexPetSyncSummary, _requestedThemeId)) {
  const orphanThemeId = _requestedThemeId;
  const nextVariantMap = { ...(_settingsController.get("themeVariant") || {}) };
  const nextOverrides = { ...(_settingsController.get("themeOverrides") || {}) };
  delete nextVariantMap[orphanThemeId];
  delete nextOverrides[orphanThemeId];

  _requestedThemeId = "clawd";
  _requestedVariantId = nextVariantMap[_requestedThemeId] || "default";
  _requestedThemeOverrides = nextOverrides[_requestedThemeId] || null;
  const result = _settingsController.hydrate({
    theme: _requestedThemeId,
    themeVariant: nextVariantMap,
    themeOverrides: nextOverrides,
  });
  if (result && result.status === "error") {
    console.warn("Clawd: Codex Pet active theme fallback hydrate failed:", result.message);
  }
  _startupCodexPetSyncSummary = codexPetMain.mergeSyncSummaries(
    _startupCodexPetSyncSummary,
    codexPetMain.syncThemes(_requestedThemeId)
  );
  codexPetMain.setLastSyncSummary(_startupCodexPetSyncSummary);
}
let activeTheme = themeLoader.loadTheme(_requestedThemeId, {
  variant: _requestedVariantId,
  overrides: _requestedThemeOverrides,
});
activeTheme._overrideSignature = JSON.stringify(_requestedThemeOverrides || {});
if (activeTheme._id !== _requestedThemeId || activeTheme._variantId !== _requestedVariantId) {
  const nextVariantMap = { ...(_settingsController.get("themeVariant") || {}) };
  // Self-heal: store the resolved ids so next boot doesn't fall back again.
  nextVariantMap[activeTheme._id] = activeTheme._variantId;
  if (activeTheme._id !== _requestedThemeId) {
    delete nextVariantMap[_requestedThemeId];
  }
  const result = _settingsController.hydrate({
    theme: activeTheme._id,
    themeVariant: nextVariantMap,
  });
  if (result && result.status === "error") {
    console.warn("Clawd: theme hydrate after fallback failed:", result.message);
  }
}

// ── CSS <object> sizing (from theme) ──
const petGeometryMain = createPetGeometryMain({
  getActiveTheme: () => activeTheme,
  getCurrentState: () => _state.getCurrentState(),
  getCurrentSvg: () => _state.getCurrentSvg(),
  getCurrentHitBox: () => _state.getCurrentHitBox(),
  getMiniMode: () => _mini.getMiniMode(),
  getMiniPeekOffset: () => _mini.PEEK_OFFSET,
});

function getObjRect(bounds) {
  return petGeometryMain.getObjRect(bounds);
}

function getAssetPointerPayload(bounds, point) {
  return petGeometryMain.getAssetPointerPayload(bounds, point);
}

let win;
let hitWin;  // input window — small opaque rect over hitbox, receives all pointer events
let viewportOffsetY = 0;
const themeMarginEnvelopeCache = new Map();
let tray = null;
let contextMenuOwner = null;
let settingsSizePreviewSyncFrozen = false;
// Mirror of _settingsController.get("size") — initialized from disk, kept in
// sync by the settings subscriber. The legacy S/M/L → P:N migration runs
// inside createWindow() because it needs the screen API.
let currentSize = _settingsController.get("size");

// ── Proportional size mode ──
// currentSize = "P:<ratio>" means the pet occupies <ratio>% of the display long edge,
// so rotating the same monitor to portrait does not suddenly shrink the pet.
const PROPORTIONAL_RATIOS = [8, 10, 12, 15];

function isProportionalMode(size) {
  return typeof (size || currentSize) === "string" && (size || currentSize).startsWith("P:");
}

function getProportionalRatio(size) {
  return parseFloat((size || currentSize).slice(2)) || 10;
}

function getPixelSizeFor(sizeKey, overrideWa) {
  if (!isProportionalMode(sizeKey)) return SIZES[sizeKey] || SIZES.S;
  const ratio = getProportionalRatio(sizeKey);
  let wa = overrideWa;
  if (!wa && win && !win.isDestroyed()) {
    const { x, y, width, height } = getPetWindowBounds();
    wa = getNearestWorkArea(x + width / 2, y + height / 2);
  }
  if (!wa) wa = getPrimaryWorkAreaSafe() || SYNTHETIC_WORK_AREA;
  return getProportionalPixelSize(ratio, wa);
}

function getCurrentPixelSize(overrideWa) {
  if (!isProportionalMode()) return SIZES[currentSize] || SIZES.S;
  return getPixelSizeFor(currentSize, overrideWa);
}

function getEffectiveCurrentPixelSize(overrideWa) {
  if (
    keepSizeAcrossDisplaysCached &&
    isProportionalMode() &&
    win &&
    !win.isDestroyed()
  ) {
    const bounds = getPetWindowBounds();
    return { width: bounds.width, height: bounds.height };
  }
  return getCurrentPixelSize(overrideWa);
}
let contextMenu;
let doNotDisturb = false;
let isQuitting = false;
// Mirror caches: kept in sync with the settings store via settings-effect-router
// further down. Read freely; never assign
// directly (writes go through ctx setters → controller.applyUpdate).
let showTray = _settingsController.get("showTray");
let showDock = _settingsController.get("showDock");
let manageClaudeHooksAutomatically = _settingsController.get("manageClaudeHooksAutomatically");
let autoStartWithClaude = _settingsController.get("autoStartWithClaude");
let openAtLogin = _settingsController.get("openAtLogin");
let bubbleFollowPet = _settingsController.get("bubbleFollowPet");
let sessionHudEnabled = _settingsController.get("sessionHudEnabled");
let sessionHudShowElapsed = _settingsController.get("sessionHudShowElapsed");
let sessionHudCleanupDetached = _settingsController.get("sessionHudCleanupDetached");
let soundMuted = _settingsController.get("soundMuted");
let soundVolume = _settingsController.get("soundVolume");
let lowPowerIdleMode = _settingsController.get("lowPowerIdleMode");
let allowEdgePinningCached = _settingsController.get("allowEdgePinning");
let keepSizeAcrossDisplaysCached = _settingsController.get("keepSizeAcrossDisplays");
let petHidden = false;

function getRuntimeBubblePolicy(kind) {
  return getBubblePolicy(_settingsController.getSnapshot(), kind);
}

function getAllBubblesHidden() {
  return isAllBubblesHidden(_settingsController.getSnapshot());
}

function togglePetVisibility() {
  if (!win || win.isDestroyed()) return;
  if (_mini.getMiniTransitioning()) return;
  if (petHidden) {
    win.showInactive();
    keepOutOfTaskbar(win);
    if (hitWin && !hitWin.isDestroyed()) {
      hitWin.showInactive();
      keepOutOfTaskbar(hitWin);
    }
    // Restore any permission bubbles that were hidden
    for (const perm of pendingPermissions) {
      if (perm.bubble && !perm.bubble.isDestroyed()) {
        perm.bubble.showInactive();
        keepOutOfTaskbar(perm.bubble);
      }
    }
    syncUpdateBubbleVisibility();
    reapplyMacVisibility();
    petHidden = false;
  } else {
    win.hide();
    if (hitWin && !hitWin.isDestroyed()) hitWin.hide();
    // Also hide any permission bubbles
    for (const perm of pendingPermissions) {
      if (perm.bubble && !perm.bubble.isDestroyed()) perm.bubble.hide();
    }
    hideUpdateBubble();
    petHidden = true;
  }
  syncSessionHudVisibility();
  repositionFloatingBubbles();
  syncPermissionShortcuts();
  buildTrayMenu();
  buildContextMenu();
}

function bringPetToPrimaryDisplay() {
  if (!win || win.isDestroyed()) return;
  if (_mini.getMiniMode() || _mini.getMiniTransitioning()) return;

  const workArea = getPrimaryWorkAreaSafe() || SYNTHETIC_WORK_AREA;
  const size = getEffectiveCurrentPixelSize(workArea);
  const bounds = {
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + (workArea.height - size.height) / 2),
    width: size.width,
    height: size.height,
  };

  applyPetWindowBounds(bounds);
  syncHitWin();
  repositionFloatingBubbles();

  if (petHidden) {
    togglePetVisibility();
  } else {
    win.showInactive();
    keepOutOfTaskbar(win);
    if (hitWin && !hitWin.isDestroyed()) {
      hitWin.showInactive();
      keepOutOfTaskbar(hitWin);
    }
  }

  reapplyMacVisibility();
  reassertWinTopmost();
  scheduleHwndRecovery();
  flushRuntimeStateToPrefs();
}

function sendToRenderer(channel, ...args) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, ...args);
}
function sendToHitWin(channel, ...args) {
  if (hitWin && !hitWin.isDestroyed()) hitWin.webContents.send(channel, ...args);
}

function setViewportOffsetY(offsetY) {
  const next = Number.isFinite(offsetY) ? Math.max(0, Math.round(offsetY)) : 0;
  if (next === viewportOffsetY) return;
  viewportOffsetY = next;
  sendToRenderer("viewport-offset", viewportOffsetY);
}

function getPetWindowBounds() {
  if (!win || win.isDestroyed()) return null;
  const bounds = win.getBounds();
  return {
    x: bounds.x,
    y: bounds.y - viewportOffsetY,
    width: bounds.width,
    height: bounds.height,
  };
}

function applyPetWindowBounds(bounds) {
  if (!win || win.isDestroyed() || !bounds) return null;
  const workArea = getNearestWorkArea(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2
  );
  const materialized = materializeVirtualBounds(bounds, workArea);
  if (!materialized) return null;
  win.setBounds(materialized.bounds);
  setViewportOffsetY(materialized.viewportOffsetY);
  repositionSessionHud();
  return materialized.bounds;
}

function applyPetWindowPosition(x, y) {
  const bounds = getPetWindowBounds();
  if (!bounds) return null;
  return applyPetWindowBounds({ ...bounds, x, y });
}

function hasStoredPositionThemeMismatch(prefs) {
  if (!prefs || !activeTheme) return false;
  return prefs.positionThemeId !== activeTheme._id
    || prefs.positionVariantId !== activeTheme._variantId;
}

function syncHitStateAfterLoad() {
  sendToHitWin("hit-state-sync", {
    currentSvg: _state.getCurrentSvg(),
    currentState: _state.getCurrentState(),
    miniMode: _mini.getMiniMode(),
    dndEnabled: doNotDisturb,
  });
}

function syncRendererStateAfterLoad({ includeStartupRecovery = true } = {}) {
  sendToRenderer("low-power-idle-mode-change", lowPowerIdleMode);
  if (_mini.getMiniMode()) {
    sendToRenderer("mini-mode-change", true, _mini.getMiniEdge());
  }
  if (doNotDisturb) {
    sendToRenderer("dnd-change", true);
    if (_mini.getMiniMode()) {
      applyState("mini-sleep");
    } else {
      applyState("sleeping");
    }
    return;
  }
  if (_mini.getMiniMode()) {
    applyState("mini-idle");
    return;
  }

  // Theme hot-reload path (override tweak / variant swap): re-render whatever
  // we were already showing. Going through resolveDisplayState() here flashes
  // "working/typing" when sessions Map still holds a stale session whose
  // state hasn't been stale-downgraded yet — currentState already reflects
  // the user-visible state before reload and stays authoritative.
  if (!includeStartupRecovery) {
    const prev = _state.getCurrentState();
    applyState(prev, getSvgOverride(prev));
    return;
  }

  if (sessions.size > 0) {
    const resolved = resolveDisplayState();
    applyState(resolved, getSvgOverride(resolved));
    return;
  }

  applyState("idle", getSvgOverride("idle"));

  setTimeout(() => {
    if (sessions.size > 0 || doNotDisturb) return;
    detectRunningAgentProcesses((found) => {
      if (found && sessions.size === 0 && !doNotDisturb) {
        _startStartupRecovery();
        resetIdleTimer();
      }
    });
  }, 5000);
}

// ── Sound playback ──
let lastSoundTime = 0;
const SOUND_COOLDOWN_MS = 10000;

function playSound(name) {
  if (soundMuted || doNotDisturb) return;
  const now = Date.now();
  if (now - lastSoundTime < SOUND_COOLDOWN_MS) return;
  const url = themeLoader.getSoundUrl(name);
  if (!url) return;
  lastSoundTime = now;
  sendToRenderer("play-sound", { url, volume: soundVolume });
}

function resetSoundCooldown() {
  lastSoundTime = 0;
}

// Sync input window position to match render window's hitbox.
// Called manually after every win position/size change + event-level safety net.
let _lastHitW = 0, _lastHitH = 0;
function syncHitWin() {
  if (!hitWin || hitWin.isDestroyed() || !win || win.isDestroyed()) return;
  // Keep the captured pointer stable while dragging. Repositioning the input
  // window mid-drag can break pointer capture on Windows.
  if (dragLocked) return;
  const bounds = getPetWindowBounds();
  const hit = getHitRectScreen(bounds);
  const x = Math.round(hit.left);
  const y = Math.round(hit.top);
  const w = Math.round(hit.right - hit.left);
  const h = Math.round(hit.bottom - hit.top);
  if (w <= 0 || h <= 0) return;
  hitWin.setBounds({ x, y, width: w, height: h });
  // Update shape if hitbox dimensions changed (e.g. after resize)
  if (w !== _lastHitW || h !== _lastHitH) {
    _lastHitW = w; _lastHitH = h;
    hitWin.setShape([{ x: 0, y: 0, width: w, height: h }]);
  }
  repositionSessionHud();
}

let mouseOverPet = false;
let dragLocked = false;
let dragSnapshot = null;
let menuOpen = false;
let idlePaused = false;
let forceEyeResend = false;
let forceEyeResendBoostUntil = 0;
let requestFastTick = () => {};
let themeReloadInProgress = false;
let themeSwitchTransitionSeq = 0;
let themeSwitchFadeFallbackTimer = null;
let themeSwitchOpacityCancelSignal = null;
let themeSwitchReloadListenerCleanup = null;
let repositionSessionHud = () => {};
let syncSessionHudVisibility = () => {};
let broadcastSessionHudSnapshot = () => {};
let sendSessionHudI18n = () => {};
let getSessionHudReservedOffset = () => 0;
let getSessionHudWindow = () => null;

function setForceEyeResend(value) {
  forceEyeResend = !!value;
  if (forceEyeResend) {
    forceEyeResendBoostUntil = Math.max(forceEyeResendBoostUntil, Date.now() + 2000);
    requestFastTick(100);
  }
}

// Keep drag math in Electron's main-process DIP coordinate space. Renderer
// PointerEvent.screenX/Y can be scaled differently on high-DPI displays.
function beginDragSnapshot() {
  if (!win || win.isDestroyed()) {
    dragSnapshot = null;
    return;
  }
  const bounds = getPetWindowBounds();
  // When keepSizeAcrossDisplays is on, the pet may currently be sized from
  // a prior display (e.g. dragged from a small monitor and kept small on a
  // large one). Snapshotting getCurrentPixelSize() here would snap it to
  // the large display's proportional size at drag start, which is the
  // exact behaviour the user disabled.
  const size = keepSizeAcrossDisplaysCached
    ? { width: bounds.width, height: bounds.height }
    : getCurrentPixelSize();
  dragSnapshot = createDragSnapshot(
    screen.getCursorScreenPoint(),
    bounds,
    size
  );
}

function clearDragSnapshot() {
  dragSnapshot = null;
}

function moveWindowForDrag() {
  if (!dragLocked) return;
  if (_mini.getMiniMode() || _mini.getMiniTransitioning()) return;
  if (!win || win.isDestroyed()) return;
  if (!dragSnapshot) return;

  const bounds = computeAnchoredDragBounds(
    dragSnapshot,
    screen.getCursorScreenPoint(),
    looseClampPetToDisplays
  );
  if (!bounds) return;

  applyPetWindowBounds(bounds);
  if (isWin && isNearWorkAreaEdge(bounds)) reassertWinTopmost();
  syncHitWin();
  repositionSessionHud();
  repositionFloatingBubbles();
}

// ── Mini Mode — delegated to src/mini.js ──
// Initialized after state module (needs applyState, resolveDisplayState, etc.)
// See _mini initialization below


// ── Permission bubble — delegated to src/permission.js ──
const {
  isAgentEnabled: _isAgentEnabled,
  isAgentPermissionsEnabled: _isAgentPermissionsEnabled,
  isAgentNotificationHookEnabled: _isAgentNotificationHookEnabled,
  isCodexPermissionInterceptEnabled: _isCodexPermissionInterceptEnabled,
} = require("./agent-gate");
const _permCtx = {
  get win() { return win; },
  get lang() { return lang; },
  get sessions() { return sessions; },
  get bubbleFollowPet() { return bubbleFollowPet; },
  get permDebugLog() { return permDebugLog; },
  get doNotDisturb() { return doNotDisturb; },
  get hideBubbles() { return getAllBubblesHidden(); },
  get petHidden() { return petHidden; },
  getBubblePolicy: getRuntimeBubblePolicy,
  getPetWindowBounds,
  getNearestWorkArea,
  getHitRectScreen,
  getHudReservedOffset: () => getSessionHudReservedOffset(),
  guardAlwaysOnTop,
  reapplyMacVisibility,
  isAgentPermissionsEnabled: (agentId) =>
    _isAgentPermissionsEnabled({ agents: _settingsController.get("agents") }, agentId),
  focusTerminalForSession: (sessionId, options = {}) => {
    const s = sessions.get(sessionId);
    if (s && s.sourcePid) {
      focusTerminalWindow({
        sourcePid: s.sourcePid,
        cwd: s.cwd,
        editor: s.editor,
        pidChain: s.pidChain,
        sessionId: String(sessionId),
        agentId: s.agentId,
        requestSource: options.requestSource || "permission-bubble",
      });
    }
  },
  getSettingsSnapshot: () => _settingsController.getSnapshot(),
  subscribeShortcuts: (cb) => _settingsController.subscribeKey("shortcuts", (_value, snapshot) => {
    if (typeof cb === "function") cb(snapshot);
  }),
  reportShortcutFailure: (actionId, reason) => shortcutRuntime.reportFailure(actionId, reason),
  clearShortcutFailure: (actionId) => shortcutRuntime.clearFailure(actionId),
  repositionUpdateBubble: () => repositionUpdateBubble(),
};
const _perm = initPermission(_permCtx);
const { showPermissionBubble, resolvePermissionEntry, sendPermissionResponse, repositionBubbles, permLog, PASSTHROUGH_TOOLS, showCodexNotifyBubble, clearCodexNotifyBubbles, showKimiNotifyBubble, clearKimiNotifyBubbles, syncPermissionShortcuts, replyOpencodePermission } = _perm;
const pendingPermissions = _perm.pendingPermissions;
let permDebugLog = null; // set after app.whenReady()
let updateDebugLog = null; // set after app.whenReady()
let sessionDebugLog = null; // set after app.whenReady()
let focusDebugLog = null; // set after app.whenReady()

const _updateBubbleCtx = {
  get win() { return win; },
  get bubbleFollowPet() { return bubbleFollowPet; },
  get petHidden() { return petHidden; },
  getBubblePolicy: getRuntimeBubblePolicy,
  getPendingPermissions: () => pendingPermissions,
  getPetWindowBounds,
  getNearestWorkArea,
  getUpdateBubbleAnchorRect,
  getHitRectScreen,
  getHudReservedOffset: () => getSessionHudReservedOffset(),
  guardAlwaysOnTop,
  reapplyMacVisibility,
};
const _updateBubble = initUpdateBubble(_updateBubbleCtx);
const {
  showUpdateBubble,
  hideUpdateBubble,
  repositionUpdateBubble,
  syncVisibility: syncUpdateBubbleVisibility,
} = _updateBubble;

function repositionFloatingBubbles() {
  if (pendingPermissions.length) repositionBubbles();
  repositionUpdateBubble();
}

// ── macOS cross-Space visibility helper ──
// Prefer native collection behavior over Electron's setVisibleOnAllWorkspaces:
// Electron may briefly hide the window while transforming process type, while
// the native path also mirrors Masko Code's SkyLight-backed stationary Space.
function reapplyMacVisibility() {
  if (!isMac) return;
  const apply = (w) => {
    if (w && !w.isDestroyed()) {
      const deferUntil = Number(w.__clawdMacDeferredVisibilityUntil) || 0;
      if (deferUntil > Date.now()) return;
      if (deferUntil) delete w.__clawdMacDeferredVisibilityUntil;
      w.setAlwaysOnTop(true, MAC_TOPMOST_LEVEL);
      if (!applyStationaryCollectionBehavior(w)) {
        const opts = { visibleOnFullScreen: true };
        if (!showDock) opts.skipTransformProcessType = true;
        w.setVisibleOnAllWorkspaces(true, opts);
        // First, try the native flicker-free path.
        // If the native path fails, use Electron's cross-space API as a fallback.
        // After using Electron as a fallback, try the native enhancement again to avoid Electron resetting the window behavior we want.
        applyStationaryCollectionBehavior(w);
      }
    }
  };
  apply(win);
  apply(hitWin);
  for (const perm of pendingPermissions) apply(perm.bubble);
  apply(_updateBubble.getBubbleWindow());
  apply(getSessionHudWindow());
  apply(contextMenuOwner);
}

// ── State machine — delegated to src/state.js ──
let showDashboard = () => {};
let broadcastDashboardSessionSnapshot = () => {};
let sendDashboardI18n = () => {};

const _stateCtx = {
  get theme() { return activeTheme; },
  get win() { return win; },
  get hitWin() { return hitWin; },
  get doNotDisturb() { return doNotDisturb; },
  set doNotDisturb(v) { doNotDisturb = v; },
  get miniMode() { return _mini.getMiniMode(); },
  get miniTransitioning() { return _mini.getMiniTransitioning(); },
  get mouseOverPet() { return mouseOverPet; },
  get miniSleepPeeked() { return _mini.getMiniSleepPeeked(); },
  set miniSleepPeeked(v) { _mini.setMiniSleepPeeked(v); },
  get miniPeeked() { return _mini.getMiniPeeked(); },
  set miniPeeked(v) { _mini.setMiniPeeked(v); },
  get idlePaused() { return idlePaused; },
  set idlePaused(v) { idlePaused = v; },
  get forceEyeResend() { return forceEyeResend; },
  set forceEyeResend(v) { setForceEyeResend(v); },
  get mouseStillSince() { return _tick ? _tick._mouseStillSince : Date.now(); },
  get pendingPermissions() { return pendingPermissions; },
  sendToRenderer,
  sendToHitWin,
  syncHitWin,
  playSound,
  t: (key) => t(key),
  focusTerminalWindow: (...args) => focusTerminalWindow(...args),
  resolvePermissionEntry: (...args) => resolvePermissionEntry(...args),
  dismissPermissionsForDnd: (...args) => _perm.dismissPermissionsForDnd(...args),
  showKimiNotifyBubble: (...args) => showKimiNotifyBubble(...args),
  clearKimiNotifyBubbles: (...args) => clearKimiNotifyBubbles(...args),
  // state.js needs this to gate startKimiPermissionPoll symmetrically with
  // shouldSuppressKimiNotifyBubble in permission.js — without it the
  // permissionsEnabled=false toggle would silently rebuild holds on every
  // incoming Kimi PermissionRequest.
  isAgentPermissionsEnabled: (agentId) =>
    _isAgentPermissionsEnabled({ agents: _settingsController.get("agents") }, agentId),
  // state.js gates self-issued Notification events (idle / wait-for-input
  // pings) via this reader. Living in updateSession (not at the HTTP
  // boundary) keeps the gate consistent for hook / log-poll / plugin paths.
  isAgentNotificationHookEnabled: (agentId) =>
    _isAgentNotificationHookEnabled({ agents: _settingsController.get("agents") }, agentId),
  miniPeekIn: () => miniPeekIn(),
  miniPeekOut: () => miniPeekOut(),
  buildContextMenu: () => buildContextMenu(),
  buildTrayMenu: () => buildTrayMenu(),
  debugLog: (msg) => sessionLog(msg),
  broadcastSessionSnapshot: (snapshot) => {
    broadcastDashboardSessionSnapshot(snapshot);
    broadcastSessionHudSnapshot(snapshot);
    repositionFloatingBubbles();
  },
  // Phase 3b: 读 prefs.themeOverrides 判断某个 oneshot state 是否被用户禁用。
  // state.js gate 调这个做 early-return。不做白名单校验——settings-actions
  // 负责写入合法性，这里只读。
  isOneshotDisabled: (stateKey) => {
    const themeId = activeTheme && activeTheme._id;
    if (!themeId || !stateKey) return false;
    const overrides = _settingsController.get("themeOverrides");
    const themeMap = overrides && overrides[themeId];
    const stateMap = themeMap && themeMap.states;
    const entry = (stateMap && stateMap[stateKey]) || (themeMap && themeMap[stateKey]);
    return !!(entry && entry.disabled === true);
  },
  get sessionHudCleanupDetached() { return sessionHudCleanupDetached; },
  getSessionAliases: () => _settingsController.get("sessionAliases"),
  hasAnyEnabledAgent: () => {
    // `get("agents")` returns the live reference (no clone) — we're only
    // reading. Missing agents field falls back to "assume enabled" (the
    // legacy default-true contract for unconfigured installs); but an
    // explicit empty object means every agent was cleared, so return
    // false. Without that distinction, a user who wiped the field would
    // still trigger startup-recovery process scans.
    const agents = _settingsController.get("agents");
    if (!agents || typeof agents !== "object") return true;
    const probe = { agents };
    for (const id of Object.keys(agents)) {
      if (_isAgentEnabled(probe, id)) return true;
    }
    return false;
  },
};
const _state = require("./state")(_stateCtx);
const { setState, applyState, updateSession, resolveDisplayState, getSvgOverride,
        enableDoNotDisturb, disableDoNotDisturb, startStaleCleanup, stopStaleCleanup,
        startWakePoll, stopWakePoll, detectRunningAgentProcesses,
        startStartupRecovery: _startStartupRecovery } = _state;
const sessions = _state.sessions;

// ── Hit-test: SVG bounding box → screen coordinates ──
function getHitRectScreen(bounds) {
  return petGeometryMain.getHitRectScreen(bounds);
}

function getUpdateBubbleAnchorRect(bounds) {
  return petGeometryMain.getUpdateBubbleAnchorRect(bounds);
}

function getSessionHudAnchorRect(bounds) {
  return petGeometryMain.getSessionHudAnchorRect(bounds);
}

function getVisibleContentMargins(bounds) {
  if (!bounds || !activeTheme) return { top: 0, bottom: 0 };
  const box = getThemeMarginBox(activeTheme);
  if (!box) return { top: 0, bottom: 0 };

  const cacheKey = [
    activeTheme._id || "",
    activeTheme._variantId || "",
    bounds.width,
    bounds.height,
    JSON.stringify(box),
  ].join("|");
  const cached = themeMarginEnvelopeCache.get(cacheKey);
  if (cached) return cached;

  const margins = computeStableVisibleContentMargins(activeTheme, bounds, { box });
  themeMarginEnvelopeCache.set(cacheKey, margins);
  return margins;
}

// ── Main tick — delegated to src/tick.js ──
const _tickCtx = {
  get theme() { return activeTheme; },
  get win() { return win; },
  getPetWindowBounds,
  get currentState() { return _state.getCurrentState(); },
  get currentSvg() { return _state.getCurrentSvg(); },
  get miniMode() { return _mini.getMiniMode(); },
  get miniTransitioning() { return _mini.getMiniTransitioning(); },
  get dragLocked() { return dragLocked; },
  get menuOpen() { return menuOpen; },
  get idlePaused() { return idlePaused; },
  get isAnimating() { return _mini.getIsAnimating(); },
  get miniSleepPeeked() { return _mini.getMiniSleepPeeked(); },
  set miniSleepPeeked(v) { _mini.setMiniSleepPeeked(v); },
  get miniPeeked() { return _mini.getMiniPeeked(); },
  set miniPeeked(v) { _mini.setMiniPeeked(v); },
  get mouseOverPet() { return mouseOverPet; },
  set mouseOverPet(v) { mouseOverPet = v; },
  get forceEyeResend() { return forceEyeResend; },
  set forceEyeResend(v) { setForceEyeResend(v); },
  get forceEyeResendBoostUntil() { return forceEyeResendBoostUntil; },
  get startupRecoveryActive() { return _state.getStartupRecoveryActive(); },
  sendToRenderer,
  sendToHitWin,
  setState,
  applyState,
  miniPeekIn: () => miniPeekIn(),
  miniPeekOut: () => miniPeekOut(),
  getObjRect,
  getHitRectScreen,
  getAssetPointerPayload,
};
const _tick = require("./tick")(_tickCtx);
requestFastTick = (maxDelay) => _tick.scheduleSoon(maxDelay);
const { startMainTick, resetIdleTimer } = _tick;

// ── Terminal focus — delegated to src/focus.js ──
const _focus = require("./focus")({ _allowSetForeground, focusLog });
const { initFocusHelper, killFocusHelper, focusTerminalWindow, clearMacFocusCooldownTimer } = _focus;

function getFocusableLocalHudSessionIds() {
  if (!_state || typeof _state.buildSessionSnapshot !== "function") return [];
  return selectFocusableLocalHudSessionIds(_state.buildSessionSnapshot());
}

function focusDashboardSession(sessionId, options = {}) {
  if (!sessionId) return;
  const requestSource = options.requestSource || "dashboard";
  const session = sessions.get(String(sessionId));
  if (session && session.sourcePid) {
    focusTerminalWindow({
      sourcePid: session.sourcePid,
      cwd: session.cwd,
      editor: session.editor,
      pidChain: session.pidChain,
      sessionId: String(sessionId),
      agentId: session.agentId,
      requestSource,
    });
  } else if (!session) {
    focusLog(`focus result branch=none reason=session-not-found source=${requestSource} sid=${String(sessionId)}`);
  } else {
    focusLog(`focus result branch=none reason=no-source-pid source=${requestSource} sid=${String(sessionId)}`);
  }
}

function hideDashboardSession(sessionId) {
  if (!_state || typeof _state.dismissSession !== "function") {
    return { status: "error", message: "session state is not ready" };
  }
  const removed = _state.dismissSession(String(sessionId || ""));
  return removed
    ? { status: "ok" }
    : { status: "not-found" };
}

const _dashboard = require("./dashboard")({
  get lang() { return lang; },
  t: (key) => translate(key),
  getSessionSnapshot: () => _state.buildSessionSnapshot(),
  getI18n: () => getDashboardI18nPayload(),
  getPetWindowBounds,
  getNearestWorkArea,
  iconPath: settingsWindowRuntime.getIconPath(),
});
showDashboard = _dashboard.showDashboard;
broadcastDashboardSessionSnapshot = _dashboard.broadcastSessionSnapshot;
sendDashboardI18n = _dashboard.sendI18n;

const _sessionHud = require("./session-hud")({
  get win() { return win; },
  get petHidden() { return petHidden; },
  get sessionHudEnabled() { return sessionHudEnabled; },
  get sessionHudShowElapsed() { return sessionHudShowElapsed; },
  getMiniMode: () => _mini.getMiniMode(),
  getMiniTransitioning: () => _mini.getMiniTransitioning(),
  getSessionSnapshot: () => _state.buildSessionSnapshot(),
  getI18n: () => getDashboardI18nPayload(),
  getPetWindowBounds,
  getHitRectScreen,
  getSessionHudAnchorRect,
  getNearestWorkArea,
  guardAlwaysOnTop,
  reapplyMacVisibility,
  onReservedOffsetChange: () => repositionFloatingBubbles(),
});
repositionSessionHud = _sessionHud.repositionSessionHud;
syncSessionHudVisibility = _sessionHud.syncSessionHud;
broadcastSessionHudSnapshot = _sessionHud.broadcastSessionSnapshot;
sendSessionHudI18n = _sessionHud.sendI18n;
getSessionHudReservedOffset = _sessionHud.getHudReservedOffset;
getSessionHudWindow = _sessionHud.getWindow;

// ── HTTP server — delegated to src/server.js ──
const _serverCtx = {
  get manageClaudeHooksAutomatically() { return manageClaudeHooksAutomatically; },
  get autoStartWithClaude() { return autoStartWithClaude; },
  get doNotDisturb() { return doNotDisturb; },
  shouldDropForDnd: () => _state.shouldDropForDnd ? _state.shouldDropForDnd() : doNotDisturb,
  get hideBubbles() { return getAllBubblesHidden(); },
  getBubblePolicy: getRuntimeBubblePolicy,
  get pendingPermissions() { return pendingPermissions; },
  get PASSTHROUGH_TOOLS() { return PASSTHROUGH_TOOLS; },
  get STATE_SVGS() { return _state.STATE_SVGS; },
  get sessions() { return sessions; },
  isAgentEnabled: (agentId) => _isAgentEnabled({ agents: _settingsController.get("agents") }, agentId),
  isAgentPermissionsEnabled: (agentId) => _isAgentPermissionsEnabled({ agents: _settingsController.get("agents") }, agentId),
  isCodexPermissionInterceptEnabled: () => _isCodexPermissionInterceptEnabled({ agents: _settingsController.get("agents") }),
  codexSubagentClassifier: _codexSubagentClassifier,
  setState,
  updateSession: updateSessionFromServer,
  resolvePermissionEntry,
  sendPermissionResponse,
  showPermissionBubble,
  replyOpencodePermission,
  permLog,
};
const _server = require("./server")(_serverCtx);
const { startHttpServer, getHookServerPort } = _server;

// ── alwaysOnTop recovery (Windows DWM / Shell can strip TOPMOST flag) ──
// The "always-on-top-changed" event only fires from Electron's own SetAlwaysOnTop
// path — it does NOT fire when Explorer/Start menu/Gallery silently reorder windows.
// So we keep the event listener for the cases it does catch (Alt/Win key), and add
// a slow watchdog (20s) to recover from silent shell-initiated z-order drops.
const WIN_TOPMOST_LEVEL = "pop-up-menu";  // above taskbar-level UI
const MAC_TOPMOST_LEVEL = "screen-saver"; // above fullscreen apps on macOS
const TOPMOST_WATCHDOG_MS = 5_000;
let topmostWatchdog = null;
let hwndRecoveryTimer = null;

function reassertWinTopmost() {
  if (!isWin) return;
  if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
  if (hitWin && !hitWin.isDestroyed()) hitWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
}

function isNearWorkAreaEdge(bounds, tolerance = 2) {
  if (!bounds) return false;
  const wa = getNearestWorkArea(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  if (!wa) return false;
  return (
    bounds.x <= wa.x + tolerance ||
    bounds.y <= wa.y + tolerance ||
    bounds.x + bounds.width >= wa.x + wa.width - tolerance ||
    bounds.y + bounds.height >= wa.y + wa.height - tolerance
  );
}

// Reinitialize HWND input routing after DWM z-order disruptions.
// showInactive() (ShowWindow SW_SHOWNOACTIVATE) is the same call that makes
// the right-click context menu restore drag capability — it forces Windows to
// fully recalculate the transparent window's input target region.
function scheduleHwndRecovery() {
  if (!isWin) return;
  if (hwndRecoveryTimer) clearTimeout(hwndRecoveryTimer);
  hwndRecoveryTimer = setTimeout(() => {
    hwndRecoveryTimer = null;
    if (!win || win.isDestroyed()) return;
    // Just restore z-order — input routing is handled by hitWin now
    reassertWinTopmost();
    setForceEyeResend(true);
  }, 1000);
}

function guardAlwaysOnTop(w) {
  if (!isWin) return;
  w.on("always-on-top-changed", (_, isOnTop) => {
    if (!isOnTop && w && !w.isDestroyed()) {
      w.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
      if (w === win && !dragLocked && !_mini.getIsAnimating() && !_mini.getMiniTransitioning()) {
        setForceEyeResend(true);
        const bounds = getPetWindowBounds();
        applyPetWindowPosition(bounds.x + 1, bounds.y);
        applyPetWindowPosition(bounds.x, bounds.y);
        syncHitWin();
        scheduleHwndRecovery();
      }
    }
  });
}

function startTopmostWatchdog() {
  if (!isWin || topmostWatchdog) return;
  topmostWatchdog = setInterval(() => {
    if (win && !win.isDestroyed()) {
      win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
      keepOutOfTaskbar(win);
    }
    // Keep hitWin topmost too
    if (hitWin && !hitWin.isDestroyed()) {
      hitWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
      keepOutOfTaskbar(hitWin);
    }
    for (const perm of pendingPermissions) {
      if (perm.bubble && !perm.bubble.isDestroyed() && perm.bubble.isVisible()) {
        perm.bubble.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
        keepOutOfTaskbar(perm.bubble);
      }
    }
    const updateBubbleWin = _updateBubble.getBubbleWindow();
    if (updateBubbleWin && !updateBubbleWin.isDestroyed() && updateBubbleWin.isVisible()) {
      updateBubbleWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
      keepOutOfTaskbar(updateBubbleWin);
    }
    const sessionHudWin = getSessionHudWindow();
    if (sessionHudWin && !sessionHudWin.isDestroyed() && sessionHudWin.isVisible()) {
      sessionHudWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
      keepOutOfTaskbar(sessionHudWin);
    }
    if (contextMenuOwner && !contextMenuOwner.isDestroyed()) {
      keepOutOfTaskbar(contextMenuOwner);
    }
  }, TOPMOST_WATCHDOG_MS);
}

function stopTopmostWatchdog() {
  if (topmostWatchdog) { clearInterval(topmostWatchdog); topmostWatchdog = null; }
}

function updateLog(msg) {
  if (!updateDebugLog) return;
  const { rotatedAppend } = require("./log-rotate");
  rotatedAppend(updateDebugLog, `[${new Date().toISOString()}] ${msg}\n`);
}

function sessionLog(msg) {
  if (!sessionDebugLog) return;
  const { rotatedAppend } = require("./log-rotate");
  rotatedAppend(sessionDebugLog, `[${new Date().toISOString()}] ${msg}\n`);
}

function focusLog(msg) {
  if (!focusDebugLog) return;
  const { rotatedAppend } = require("./log-rotate");
  rotatedAppend(focusDebugLog, `[${new Date().toISOString()}] ${msg}\n`);
}

// ── Menu — delegated to src/menu.js ──
//
// Setters that previously assigned to module-level vars now route through
// `_settingsController.applyUpdate(key, value)`. The mirror cache is updated
// by the settings-effect-router subscriber after this ctx is built. Side
// effects that used to live inside setters (e.g.
// `syncPermissionShortcuts()` for hideBubbles) are now reactive and live in
// the subscriber too.
const _menuCtx = {
  get win() { return win; },
  get sessions() { return sessions; },
  get currentSize() { return currentSize; },
  set currentSize(v) { _settingsController.applyUpdate("size", v); },
  get doNotDisturb() { return doNotDisturb; },
  get lang() { return lang; },
  set lang(v) { _settingsController.applyUpdate("lang", v); },
  get showTray() { return showTray; },
  set showTray(v) { _settingsController.applyUpdate("showTray", v); },
  get showDock() { return showDock; },
  set showDock(v) { _settingsController.applyUpdate("showDock", v); },
  get manageClaudeHooksAutomatically() { return manageClaudeHooksAutomatically; },
  get autoStartWithClaude() { return autoStartWithClaude; },
  set autoStartWithClaude(v) { _settingsController.applyUpdate("autoStartWithClaude", v); },
  get openAtLogin() { return openAtLogin; },
  set openAtLogin(v) { _settingsController.applyUpdate("openAtLogin", v); },
  get bubbleFollowPet() { return bubbleFollowPet; },
  set bubbleFollowPet(v) { _settingsController.applyUpdate("bubbleFollowPet", v); },
  get hideBubbles() { return getAllBubblesHidden(); },
  set hideBubbles(v) { _settingsController.applyCommand("setAllBubblesHidden", { hidden: !!v }).catch((err) => {
    console.warn("Clawd: setAllBubblesHidden failed:", err && err.message);
  }); },
  get soundMuted() { return soundMuted; },
  set soundMuted(v) { _settingsController.applyUpdate("soundMuted", v); },
  get soundVolume() { return soundVolume; },
  get pendingPermissions() { return pendingPermissions; },
  repositionBubbles: () => repositionFloatingBubbles(),
  get petHidden() { return petHidden; },
  togglePetVisibility: () => togglePetVisibility(),
  bringPetToPrimaryDisplay: () => bringPetToPrimaryDisplay(),
  get isQuitting() { return isQuitting; },
  set isQuitting(v) { isQuitting = v; },
  get menuOpen() { return menuOpen; },
  set menuOpen(v) { menuOpen = v; },
  get tray() { return tray; },
  set tray(v) { tray = v; },
  get contextMenuOwner() { return contextMenuOwner; },
  set contextMenuOwner(v) { contextMenuOwner = v; },
  get contextMenu() { return contextMenu; },
  set contextMenu(v) { contextMenu = v; },
  enableDoNotDisturb: () => enableDoNotDisturb(),
  disableDoNotDisturb: () => disableDoNotDisturb(),
  enterMiniViaMenu: () => enterMiniViaMenu(),
  exitMiniMode: () => exitMiniMode(),
  getMiniMode: () => _mini.getMiniMode(),
  getMiniTransitioning: () => _mini.getMiniTransitioning(),
  miniHandleResize: (sizeKey) => _mini.handleResize(sizeKey),
  checkForUpdates: (...args) => checkForUpdates(...args),
  getUpdateMenuItem: () => getUpdateMenuItem(),
  openDashboard: () => showDashboard(),
  // The settings controller is the only writer of persisted prefs. Toggle
  // setters above route through it; resize/sendToDisplay use
  // flushRuntimeStateToPrefs to capture window bounds after movement.
  flushRuntimeStateToPrefs,
  settings: _settingsController,
  syncHitWin,
  getPetWindowBounds,
  applyPetWindowBounds,
  getCurrentPixelSize,
  getEffectiveCurrentPixelSize,
  getPixelSizeFor,
  isProportionalMode,
  PROPORTIONAL_RATIOS,
  getHookServerPort: () => getHookServerPort(),
  clampToScreenVisual,
  getNearestWorkArea,
  reapplyMacVisibility,
  discoverThemes: () => themeLoader.discoverThemes(),
  getActiveThemeId: () => activeTheme ? activeTheme._id : "clawd",
  getActiveThemeCapabilities: () => activeTheme ? activeTheme._capabilities : null,
  ensureUserThemesDir: () => themeLoader.ensureUserThemesDir(),
  openSettingsWindow: () => settingsWindowRuntime.open(),
};
const _menu = require("./menu")(_menuCtx);
const { t, buildContextMenu, buildTrayMenu, rebuildAllMenus, createTray,
        destroyTray, showPetContextMenu, ensureContextMenuOwner,
        requestAppQuit, applyDockVisibility } = _menu;

// ── Settings effect router ──
const SETTINGS_MIRROR_SETTERS = {
  lang: (v) => { lang = v; }, size: (v) => { currentSize = v; }, showTray: (v) => { showTray = v; },
  showDock: (v) => { showDock = v; }, manageClaudeHooksAutomatically: (v) => { manageClaudeHooksAutomatically = v; },
  autoStartWithClaude: (v) => { autoStartWithClaude = v; }, openAtLogin: (v) => { openAtLogin = v; },
  bubbleFollowPet: (v) => { bubbleFollowPet = v; }, sessionHudEnabled: (v) => { sessionHudEnabled = v; },
  sessionHudShowElapsed: (v) => { sessionHudShowElapsed = v; }, sessionHudCleanupDetached: (v) => { sessionHudCleanupDetached = v; },
  soundMuted: (v) => { soundMuted = v; }, soundVolume: (v) => { soundVolume = v; }, lowPowerIdleMode: (v) => { lowPowerIdleMode = v; },
  allowEdgePinning: (v) => { allowEdgePinningCached = v; }, keepSizeAcrossDisplays: (v) => { keepSizeAcrossDisplaysCached = v; },
};

function updateSettingsMirrors(changes) { for (const [key, value] of Object.entries(changes)) if (SETTINGS_MIRROR_SETTERS[key]) SETTINGS_MIRROR_SETTERS[key](value); }

function callRuntimeMethod(owner, method, ...args) { return owner && typeof owner[method] === "function" ? owner[method](...args) : undefined; }

function reclampPetAfterEdgePinningChange() {
  if (!win || win.isDestroyed() || dragLocked || _mini.getMiniMode() || _mini.getMiniTransitioning()) return;
  const clamped = computeFinalDragBounds(getPetWindowBounds(), getEffectiveCurrentPixelSize(), clampToScreenVisual);
  if (clamped) applyPetWindowBounds(clamped);
  syncHitWin(); repositionFloatingBubbles();
}

const settingsEffectRouter = createSettingsEffectRouter({
  settingsController: _settingsController,
  BrowserWindow,
  updateMirrors: updateSettingsMirrors,
  createTray,
  destroyTray,
  applyDockVisibility,
  sendToRenderer,
  sendDashboardI18n: () => sendDashboardI18n(),
  sendSessionHudI18n: () => sendSessionHudI18n(),
  emitSessionSnapshot: (options) => _state.emitSessionSnapshot(options),
  cleanStaleSessions: () => _state.cleanStaleSessions(),
  syncPermissionShortcuts,
  dismissInteractivePermissionBubbles: () => callRuntimeMethod(_perm, "dismissInteractivePermissionBubbles"),
  clearCodexNotifyBubbles,
  clearKimiNotifyBubbles,
  refreshPassiveNotifyAutoClose: () => callRuntimeMethod(_perm, "refreshPassiveNotifyAutoClose"),
  hideUpdateBubbleForPolicy: () => callRuntimeMethod(_updateBubble, "hideForPolicy"),
  refreshUpdateBubbleAutoClose: () => callRuntimeMethod(_updateBubble, "refreshAutoCloseForPolicy"),
  repositionFloatingBubbles,
  syncSessionHudVisibility: () => syncSessionHudVisibility(),
  reclampPetAfterEdgePinningChange,
  rebuildAllMenus,
  logWarn: console.warn,
});
settingsEffectRouter.start();

animationOverridesMain = createSettingsAnimationOverridesMain({
  app,
  BrowserWindow,
  dialog,
  shell,
  fs,
  path,
  themeLoader,
  settingsController: _settingsController,
  getActiveTheme: () => activeTheme,
  getSettingsWindow,
  getLang: () => lang,
  getThemeReloadInProgress: () => themeReloadInProgress,
  getStateRuntime: () => _state,
  sendToRenderer,
});
registerSettingsAnimationOverridesIpc({
  ipcMain,
  animationOverridesMain,
});
// ── Auto-updater — delegated to src/updater.js ──
const _updaterCtx = {
  get doNotDisturb() { return doNotDisturb; },
  get miniMode() { return _mini.getMiniMode(); },
  get lang() { return lang; },
  t, rebuildAllMenus, updateLog,
  showUpdateBubble: (payload) => showUpdateBubble(payload),
  hideUpdateBubble: () => hideUpdateBubble(),
  setUpdateVisualState: (kind) => _state.setUpdateVisualState(kind),
  applyState: (state, svgOverride) => applyState(state, svgOverride),
  resolveDisplayState: () => resolveDisplayState(),
  getSvgOverride: (state) => getSvgOverride(state),
  resetSoundCooldown: () => resetSoundCooldown(),
};
const _updater = require("./updater")(_updaterCtx);
const { setupAutoUpdater, checkForUpdates, getUpdateMenuItem, getUpdateMenuLabel } = _updater;

// ── Doctor tab IPC ──
const { registerDoctorIpc } = require("./doctor-ipc");
registerDoctorIpc({
  ipcMain,
  app,
  shell,
  server: _server,
  getPrefsSnapshot: () => _settingsController.getSnapshot(),
  getDoNotDisturb: () => doNotDisturb,
  getLocale: () => _settingsController.get("lang") || "en",
});

// ── Settings panel window ──
//
// Single-instance, non-modal, system-titlebar BrowserWindow that hosts the
// settings UI. Reuses the settings IPC registration already wired up for the
// controller. The renderer subscribes to
// settings-changed broadcasts so menu changes and panel changes stay in sync.
const SIZE_PREVIEW_KEY_RE = /^P:\d+(?:\.\d+)?$/;

function isValidSizePreviewKey(value) {
  return typeof value === "string" && SIZE_PREVIEW_KEY_RE.test(value);
}

function beginSettingsSizePreviewProtection() {
  settingsSizePreviewSyncFrozen = true;
  if (!isWin) return;
  const settingsWindow = getSettingsWindow();
  if (
    settingsWindow
    && !settingsWindow.isDestroyed()
    && typeof settingsWindow.setAlwaysOnTop === "function"
  ) {
    settingsWindow.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    if (typeof settingsWindow.moveTop === "function") settingsWindow.moveTop();
  }
  if (
    hitWin
    && !hitWin.isDestroyed()
    && typeof hitWin.setIgnoreMouseEvents === "function"
  ) {
    hitWin.setIgnoreMouseEvents(true);
  }
}

function endSettingsSizePreviewProtection() {
  settingsSizePreviewSyncFrozen = false;
  if (!isWin) return;
  const settingsWindow = getSettingsWindow();
  if (
    settingsWindow
    && !settingsWindow.isDestroyed()
    && typeof settingsWindow.setAlwaysOnTop === "function"
  ) {
    settingsWindow.setAlwaysOnTop(false);
  }
  if (
    hitWin
    && !hitWin.isDestroyed()
    && typeof hitWin.setIgnoreMouseEvents === "function"
  ) {
    hitWin.setIgnoreMouseEvents(false);
    hitWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
  }
  reassertWinTopmost();
  scheduleHwndRecovery();
}

const settingsSizePreviewSession = createSettingsSizePreviewSession({
  beginProtection: async () => {
    beginSettingsSizePreviewProtection();
  },
  endProtection: async () => {
    endSettingsSizePreviewProtection();
  },
  applyPreview: async (sizeKey) => {
    if (!isValidSizePreviewKey(sizeKey)) {
      throw new Error(`invalid preview size "${sizeKey}"`);
    }
    if (_menu && typeof _menu.resizeWindow === "function") {
      _menu.resizeWindow(sizeKey, { mode: "preview" });
    }
  },
  commitFinal: async (sizeKey) => {
    if (!isValidSizePreviewKey(sizeKey)) {
      return { status: "error", message: `invalid preview size "${sizeKey}"` };
    }
    return _settingsController.applyCommand("resizePet", sizeKey);
  },
});

registerSettingsIpc({
  ipcMain,
  app,
  BrowserWindow,
  dialog,
  shell,
  fs,
  path,
  settingsController: _settingsController,
  themeLoader,
  codexPetMain,
  getSettingsWindow,
  getActiveTheme: () => activeTheme,
  getLang: () => lang,
  settingsSizePreviewSession,
  isValidSizePreviewKey,
  sendToRenderer,
  getDoNotDisturb: () => doNotDisturb,
  getSoundMuted: () => soundMuted,
  getSoundVolume: () => soundVolume,
  getAllAgents,
  checkForUpdates,
  aboutHeroSvgPath: path.join(__dirname, "..", "assets", "svg", "clawd-about-hero.svg"),
});

registerSessionIpc({
  ipcMain,
  getSessionSnapshot: () => _state.buildSessionSnapshot(),
  getI18n: () => getDashboardI18nPayload(),
  focusSession: (sessionId, options) => focusDashboardSession(sessionId, options),
  hideSession: (sessionId) => hideDashboardSession(sessionId),
  setSessionAlias: (payload) => _settingsController.applyCommand("setSessionAlias", payload),
  showDashboard: () => showDashboard(),
});

function createWindow() {
  // Read everything from the settings controller. The mirror caches above
  // (lang/showTray/etc.) were already initialized at module-load time, so
  // here we just need the position/mini fields plus the legacy size migration.
  let prefs = _settingsController.getSnapshot();
  // Legacy S/M/L → P:N migration. Only kicks in for prefs files that haven't
  // been touched since v0; new files always store the proportional form.
  if (SIZES[prefs.size]) {
    const wa = getPrimaryWorkAreaSafe() || SYNTHETIC_WORK_AREA;
    const px = SIZES[prefs.size].width;
    const ratio = Math.round(px / wa.width * 100);
    const migrated = `P:${Math.max(1, Math.min(75, ratio))}`;
    _settingsController.applyUpdate("size", migrated); // subscriber updates currentSize mirror
    prefs = _settingsController.getSnapshot();
  }
  // macOS: apply dock visibility (default visible — but persisted state wins).
  if (isMac) {
    applyDockVisibility();
  }
  const launchSizingWorkArea = getLaunchSizingWorkArea(
    prefs,
    getPrimaryWorkAreaSafe() || SYNTHETIC_WORK_AREA,
    getNearestWorkArea,
  );
  // keepSizeAcrossDisplays preserves the last realized pixel size across restarts.
  const proportionalSize = getCurrentPixelSize(launchSizingWorkArea);
  const size = getLaunchPixelSize(prefs, proportionalSize);

  // Restore saved position, or default to bottom-right of primary display.
  // Prefs file always exists in the new architecture (defaults are hydrated
  // by prefs.load()), so the "no prefs" branch from the legacy code is gone —
  // a fresh install gets x=0, y=0 from defaults, and we treat that as "place
  // bottom-right" via the explicit zero check below.
  let startBounds;
  if (prefs.miniMode) {
    startBounds = _mini.restoreFromPrefs(prefs, size);
  } else if (prefs.positionSaved) {
    startBounds = { x: prefs.x, y: prefs.y, width: size.width, height: size.height };
  } else {
    const workArea = getPrimaryWorkAreaSafe() || SYNTHETIC_WORK_AREA;
    startBounds = {
      x: workArea.x + workArea.width - size.width - 20,
      y: workArea.y + workArea.height - size.height - 20,
      width: size.width,
      height: size.height,
    };
  }
  // Display-snapshot gate: if the monitor the pet was last on is still here
  // (same bounds or matching display.id), we trust the saved position even if
  // a generic clamp would otherwise nudge it. Only when the monitor is gone
  // — unplugged external display, RDP session ended, laptop closed with pet
  // on the external, etc. — do we regularize to the current topology.
  //
  // Visibility backstop: even with a matching display, if the saved center
  // landed outside every current workArea (manual prefs edits, exotic multi-
  // monitor rearrangements where bounds matched but the pet's coordinates
  // ended up in no-man's-land), fall back to regularize so the user isn't
  // greeted by an invisible pet. Normal "pet partially off-screen" cases
  // pass this check because the midpoint still lands inside a workArea.
  //
  // Legacy prefs (positionDisplay === null) fall through to the clamp-delta
  // check, preserving v0.6.0 behavior for users who haven't re-saved yet.
  const allDisplays = screen.getAllDisplays();
  const savedDisplayStillAttached = !!findMatchingDisplay(
    prefs.positionDisplay,
    allDisplays
  );
  const savedCenterVisible = isPointInAnyWorkArea(
    startBounds.x + startBounds.width / 2,
    startBounds.y + startBounds.height / 2,
    allDisplays
  );
  const startupNeedsRegularize = prefs.positionSaved
    && !prefs.miniMode
    && (
      hasStoredPositionThemeMismatch(prefs)
      || (
        !(savedDisplayStillAttached && savedCenterVisible)
        && needsFinalClampAdjustment(startBounds, size, clampToScreenVisual)
      )
    );
  const startupRegularizedBounds = startupNeedsRegularize
    ? computeFinalDragBounds(startBounds, size, clampToScreenVisual)
    : null;
  const initialVirtualBounds = startupRegularizedBounds || startBounds;
  const initialWorkArea = getNearestWorkArea(
    initialVirtualBounds.x + initialVirtualBounds.width / 2,
    initialVirtualBounds.y + initialVirtualBounds.height / 2
  );
  const initialMaterialized = materializeVirtualBounds(initialVirtualBounds, initialWorkArea);
  const initialWindowBounds = (initialMaterialized && initialMaterialized.bounds) || initialVirtualBounds;

  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: initialWindowBounds.x,
    y: initialWindowBounds.y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    enableLargerThanScreen: true,
    ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
    ...(isMac ? { type: "panel", roundedCorners: false } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      backgroundThrottling: false,
      additionalArguments: [
        "--theme-config=" + JSON.stringify(themeLoader.getRendererConfig()),
      ],
    },
  });

  win.setFocusable(false);

  // Watchdog (Linux only): prevent accidental window close.
  // render-process-gone is handled by the global crash-recovery handler below.
  // On macOS/Windows the WM handles window lifecycle differently.
  if (isLinux) {
    win.on("close", (event) => {
      if (!isQuitting) {
        event.preventDefault();
        if (!win.isVisible()) {
          win.showInactive();
          keepOutOfTaskbar(win);
        }
      }
    });
    win.on("unresponsive", () => {
      if (isQuitting) return;
      console.warn("Clawd: renderer unresponsive — reloading");
      win.webContents.reload();
    });
  }

  if (isWin) {
    // Windows: use pop-up-menu level to stay above taskbar/shell UI
    win.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
  }
  win.loadFile(path.join(__dirname, "index.html"));
  applyPetWindowBounds(initialVirtualBounds);
  win.showInactive();
  keepOutOfTaskbar(win);
  // macOS: apply after showInactive() — it resets NSWindowCollectionBehavior
  reapplyMacVisibility();

  // macOS: startup-time dock state can be overridden during app/window activation.
  // Re-apply once on next tick so persisted showDock reliably takes effect.
  if (isMac) {
    setTimeout(() => {
      if (!win || win.isDestroyed()) return;
      applyDockVisibility();
    }, 0);
  }

  buildContextMenu();
  if (!isMac || showTray) createTray();
  ensureContextMenuOwner();



  // ── Create input window (hitWin) — small rect over hitbox, receives all pointer events ──
  {
    const initBounds = getPetWindowBounds();
    const initHit = getHitRectScreen(initBounds);
    const hx = Math.round(initHit.left), hy = Math.round(initHit.top);
    const hw = Math.round(initHit.right - initHit.left);
    const hh = Math.round(initHit.bottom - initHit.top);

    hitWin = new BrowserWindow({
      width: hw, height: hh, x: hx, y: hy,
      frame: false,
      transparent: true,
      alwaysOnTop: true,
      resizable: false,
      skipTaskbar: true,
      hasShadow: false,
      fullscreenable: false,
      enableLargerThanScreen: true,
      ...(isLinux ? { type: LINUX_WINDOW_TYPE } : {}),
      ...(isMac ? { type: "panel", roundedCorners: false } : {}),
      focusable: !isLinux,  // KEY EXPERIMENT: allow activation to avoid WS_EX_NOACTIVATE input routing bugs (Windows-only issue)
      webPreferences: {
        preload: path.join(__dirname, "preload-hit.js"),
        backgroundThrottling: false,
        additionalArguments: [
          "--hit-theme-config=" + JSON.stringify(themeLoader.getHitRendererConfig()),
        ],
      },
    });
    // setShape: native hit region, no per-pixel alpha dependency.
    // hitWin has no visual content — clipping is irrelevant.
    hitWin.setShape([{ x: 0, y: 0, width: hw, height: hh }]);
    hitWin.setIgnoreMouseEvents(false);  // PERMANENT — never toggle
    if (isMac) hitWin.setFocusable(false);
    hitWin.showInactive();
    keepOutOfTaskbar(hitWin);
    if (isWin) {
      hitWin.setAlwaysOnTop(true, WIN_TOPMOST_LEVEL);
    }
    // macOS: apply after showInactive() — it resets NSWindowCollectionBehavior
    reapplyMacVisibility();
    hitWin.loadFile(path.join(__dirname, "hit.html"));
    if (isWin) guardAlwaysOnTop(hitWin);

    // Event-level safety net for position sync
    const syncFloatingWindows = () => {
      if (settingsSizePreviewSyncFrozen) return;
      syncHitWin();
      repositionSessionHud();
      repositionFloatingBubbles();
    };
    win.on("move", syncFloatingWindows);
    win.on("resize", syncFloatingWindows);

    // Send initial state to hitWin once it's ready
    hitWin.webContents.on("did-finish-load", () => {
      sendToHitWin("theme-config", themeLoader.getHitRendererConfig());
      if (themeReloadInProgress) return;
      syncHitStateAfterLoad();
    });

    // Crash recovery for hitWin
    hitWin.webContents.on("render-process-gone", (_event, details) => {
      safeConsoleError("hitWin renderer crashed:", details.reason);
      hitWin.webContents.reload();
    });
  }

  syncSessionHudVisibility();

  registerPetInteractionIpc({
    ipcMain,
    showContextMenu: (event) => showPetContextMenu(event),
    moveWindowForDrag: () => moveWindowForDrag(),
    setIdlePaused: (value) => { idlePaused = !!value; },
    isMiniTransitioning: () => _mini.getMiniTransitioning(),
    getCurrentState: () => _state.getCurrentState(),
    getCurrentSvg: () => _state.getCurrentSvg(),
    sendToRenderer,
    setDragLocked: (value) => { dragLocked = !!value; },
    setMouseOverPet: (value) => { mouseOverPet = !!value; },
    beginDragSnapshot: () => beginDragSnapshot(),
    clearDragSnapshot: () => clearDragSnapshot(),
    syncHitWin: () => syncHitWin(),
    isMiniMode: () => _mini.getMiniMode(),
    checkMiniModeSnap: () => checkMiniModeSnap(),
    hasPetWindow: () => !!(win && !win.isDestroyed()),
    getPetWindowBounds: () => getPetWindowBounds(),
    getKeepSizeAcrossDisplays: () => keepSizeAcrossDisplaysCached,
    getCurrentPixelSize: () => getCurrentPixelSize(),
    computeDragEndBounds: (virtualBounds, size) =>
      computeFinalDragBounds(virtualBounds, size, clampToScreenVisual),
    applyPetWindowBounds: (bounds) => applyPetWindowBounds(bounds),
    reassertWinTopmost: () => reassertWinTopmost(),
    scheduleHwndRecovery: () => scheduleHwndRecovery(),
    repositionFloatingBubbles: () => repositionFloatingBubbles(),
    exitMiniMode: () => exitMiniMode(),
    getFocusableLocalHudSessionIds: () => getFocusableLocalHudSessionIds(),
    focusLog: (message) => focusLog(message),
    showDashboard: () => showDashboard(),
    focusSession: (sessionId, options) => focusDashboardSession(sessionId, options),
  });

  registerPermissionIpc({
    ipcMain,
    permission: _perm,
  });

  registerUpdateBubbleIpc({
    ipcMain,
    updateBubble: _updateBubble,
  });

  initFocusHelper();
  startMainTick();
  startHttpServer();
  startStaleCleanup();
  // Wait for renderer to be ready before sending initial state
  // If hooks arrived during startup, respect them instead of forcing idle
  // Also handles crash recovery (render-process-gone → reload)
  win.webContents.on("did-finish-load", () => {
    sendToRenderer("theme-config", themeLoader.getRendererConfig());
    sendToRenderer("viewport-offset", viewportOffsetY);
    if (themeReloadInProgress) return;
    syncRendererStateAfterLoad();
  });

  // ── Crash recovery: renderer process can die from <object> churn ──
  win.webContents.on("render-process-gone", (_event, details) => {
    safeConsoleError("Renderer crashed:", details.reason);
    dragLocked = false;
    idlePaused = false;
    mouseOverPet = false;
    win.webContents.reload();
  });

  guardAlwaysOnTop(win);
  startTopmostWatchdog();

  // ── Display change: re-clamp window to prevent off-screen ──
  // In proportional mode, also recalculate size based on the new work area,
  // unless keepSizeAcrossDisplays is on — then we preserve the current window
  // size and only re-clamp the position.
  screen.on("display-metrics-changed", () => {
    reapplyMacVisibility();
    if (!win || win.isDestroyed()) return;
    if (_mini.getMiniTransitioning()) return;
    if (_mini.getMiniMode()) {
      _mini.handleDisplayChange();
      return;
    }
    const current = getPetWindowBounds();
    const size = keepSizeAcrossDisplaysCached
      ? { width: current.width, height: current.height }
      : getCurrentPixelSize();
    const clamped = clampToScreenVisual(current.x, current.y, size.width, size.height);
    const proportionalRecalc = isProportionalMode() && !keepSizeAcrossDisplaysCached;
    if (proportionalRecalc || clamped.x !== current.x || clamped.y !== current.y) {
      applyPetWindowBounds({ ...clamped, width: size.width, height: size.height });
      syncHitWin();
      repositionSessionHud();
      repositionFloatingBubbles();
    }
  });
  screen.on("display-removed", () => {
    reapplyMacVisibility();
    if (!win || win.isDestroyed()) return;
    if (_mini.getMiniTransitioning()) return;
    if (_mini.getMiniMode()) {
      exitMiniMode();
      return;
    }
    const current = getPetWindowBounds();
    const size = keepSizeAcrossDisplaysCached
      ? { width: current.width, height: current.height }
      : getCurrentPixelSize();
    const clamped = clampToScreenVisual(current.x, current.y, size.width, size.height);
    applyPetWindowBounds({ ...clamped, width: size.width, height: size.height });
    syncHitWin();
    repositionSessionHud();
    repositionFloatingBubbles();
  });
  screen.on("display-added", () => {
    reapplyMacVisibility();
    repositionSessionHud();
    repositionFloatingBubbles();
  });
}

// Read primary display safely — getPrimaryDisplay() can also throw during
// display topology changes, so wrap it. Returns null on failure; the pure
// helpers in work-area.js will fall through to a synthetic last-resort.
function getPrimaryWorkAreaSafe() {
  try {
    const primary = screen.getPrimaryDisplay();
    return (primary && primary.workArea) || null;
  } catch {
    return null;
  }
}

function getNearestWorkArea(cx, cy) {
  return findNearestWorkArea(screen.getAllDisplays(), getPrimaryWorkAreaSafe(), cx, cy);
}

function getNearestDisplayBottomInset(cx, cy) {
  const point = { x: Math.round(cx), y: Math.round(cy) };
  let display = null;
  try {
    display = screen.getDisplayNearestPoint(point);
  } catch {}
  if (!display || !display.bounds || !display.workArea) {
    try {
      display = screen.getPrimaryDisplay();
    } catch {}
  }
  return getDisplayInsets(display).bottom;
}

// Loose clamp used during drag: union of all display work areas as the boundary,
// so the pet can freely cross between screens. Only prevents going fully off-screen.
function looseClampPetToDisplays(x, y, w, h) {
  const margins = getVisibleContentMargins({ x, y, width: w, height: h });
  const bottomInset = getNearestDisplayBottomInset(x + w / 2, y + h / 2);
  return computeLooseClamp(
    screen.getAllDisplays(),
    getPrimaryWorkAreaSafe(),
    x,
    y,
    w,
    h,
    getLooseDragMargins({
      width: w,
      height: h,
      visibleMargins: margins,
      allowEdgePinning: allowEdgePinningCached,
      bottomInset,
    })
  );
}

function clampToScreenVisual(x, y, w, h, options = {}) {
  const margins = getVisibleContentMargins(
    { x, y, width: w, height: h },
    options
  );
  const nearest = getNearestWorkArea(x + w / 2, y + h / 2);
  const bottomInset = getNearestDisplayBottomInset(x + w / 2, y + h / 2);
  const mLeft  = Math.round(w * 0.25);
  const mRight = Math.round(w * 0.25);
  const clampMargins = getRestClampMargins({
    height: h,
    visibleMargins: margins,
    allowEdgePinning: "allowEdgePinning" in options ? options.allowEdgePinning : allowEdgePinningCached,
    bottomInset,
  });
  return {
    x: Math.max(nearest.x - mLeft, Math.min(x, nearest.x + nearest.width - w + mRight)),
    y: Math.max(
      nearest.y - clampMargins.top,
      Math.min(y, nearest.y + nearest.height - h + clampMargins.bottom)
    ),
  };
}

function clampToScreen(x, y, w, h) {
  return clampToScreenVisual(x, y, w, h);
}

// ── Mini Mode — initialized here after state module ──
const _miniCtx = {
  get theme() { return activeTheme; },
  get win() { return win; },
  get currentSize() { return currentSize; },
  get doNotDisturb() { return doNotDisturb; },
  set doNotDisturb(v) { doNotDisturb = v; },
  get currentState() { return _state.getCurrentState(); },
  SIZES,
  getCurrentPixelSize,
  getEffectiveCurrentPixelSize,
  getPixelSizeFor,
  isProportionalMode,
  sendToRenderer,
  sendToHitWin,
  syncHitWin,
  applyState,
  resolveDisplayState,
  getSvgOverride,
  stopWakePoll,
  clampToScreenVisual,
  getNearestWorkArea,
  getPetWindowBounds,
  applyPetWindowBounds,
  applyPetWindowPosition,
  setViewportOffsetY,
  get bubbleFollowPet() { return bubbleFollowPet; },
  get pendingPermissions() { return pendingPermissions; },
  repositionBubbles: () => repositionFloatingBubbles(),
  syncSessionHudVisibility: () => {
    syncSessionHudVisibility();
    repositionFloatingBubbles();
  },
  repositionSessionHud: () => repositionSessionHud(),
  buildContextMenu: () => buildContextMenu(),
  buildTrayMenu: () => buildTrayMenu(),
  getAnimationAssetCycleMs: (file) => {
    if (!file) return null;
    const probe = _buildAnimationAssetProbe(file);
    return Number.isFinite(probe && probe.assetCycleMs) && probe.assetCycleMs > 0
      ? probe.assetCycleMs
      : null;
  },
};
const _mini = require("./mini")(_miniCtx);
const { enterMiniMode, exitMiniMode, enterMiniViaMenu, miniPeekIn, miniPeekOut,
        checkMiniModeSnap, cancelMiniTransition, animateWindowX, animateWindowParabola } = _mini;

// Convenience getters for mini state (used throughout main.js)
Object.defineProperties(this || {}, {}); // no-op placeholder
// Mini state is accessed via _mini getters in ctx objects below

// ── Theme switching ──
//
// The `theme` settings effect calls this. MUST throw on failure so the
// controller rejects the commit — otherwise prefs would record a theme id
// that can't actually render. Does NOT write `theme` back to prefs; the
// controller commits after this returns (writing here would infinite-loop).
function clearThemeSwitchFadeFallback() {
  if (themeSwitchFadeFallbackTimer) {
    clearTimeout(themeSwitchFadeFallbackTimer);
    themeSwitchFadeFallbackTimer = null;
  }
}

function cancelThemeSwitchOpacityAnimation() {
  if (themeSwitchOpacityCancelSignal) {
    themeSwitchOpacityCancelSignal.cancelled = true;
    themeSwitchOpacityCancelSignal = null;
  }
}

function clearThemeSwitchReloadListeners() {
  if (themeSwitchReloadListenerCleanup) {
    themeSwitchReloadListenerCleanup();
    themeSwitchReloadListenerCleanup = null;
  }
}

function scheduleThemeSwitchFadeFallback(seq, onFallback) {
  clearThemeSwitchFadeFallback();
  themeSwitchFadeFallbackTimer = setTimeout(() => {
    themeSwitchFadeFallbackTimer = null;
    if (seq !== themeSwitchTransitionSeq) return;
    if (typeof onFallback === "function") {
      onFallback();
    } else {
      setWindowOpacity(win, 1);
    }
  }, THEME_SWITCH_FADE_FALLBACK_MS);
}

function animateThemeWindowOpacity(seq, targetOpacity, durationMs) {
  if (seq !== themeSwitchTransitionSeq) return Promise.resolve(false);
  cancelThemeSwitchOpacityAnimation();
  const cancelSignal = { cancelled: false };
  themeSwitchOpacityCancelSignal = cancelSignal;
  return animateWindowOpacity(win, targetOpacity, { durationMs, cancelSignal })
    .finally(() => {
      if (themeSwitchOpacityCancelSignal === cancelSignal) {
        themeSwitchOpacityCancelSignal = null;
      }
    });
}

function fadeInThemeWindow(seq) {
  if (seq !== themeSwitchTransitionSeq) return;
  clearThemeSwitchFadeFallback();
  animateThemeWindowOpacity(seq, 1, THEME_SWITCH_FADE_IN_MS).then((ok) => {
    if (!ok && seq === themeSwitchTransitionSeq) setWindowOpacity(win, 1);
  });
}

function reloadThemeWindowsAfterFade(seq, onReady, onFallback) {
  if (seq !== themeSwitchTransitionSeq) return;
  if (!win || win.isDestroyed() || !hitWin || hitWin.isDestroyed()) {
    if (typeof onFallback === "function") onFallback();
    else setWindowOpacity(win, 1);
    return;
  }
  clearThemeSwitchReloadListeners();
  const renderContents = win.webContents;
  const hitContents = hitWin.webContents;
  renderContents.once("did-finish-load", onReady);
  hitContents.once("did-finish-load", onReady);
  themeSwitchReloadListenerCleanup = () => {
    renderContents.removeListener("did-finish-load", onReady);
    hitContents.removeListener("did-finish-load", onReady);
  };
  scheduleThemeSwitchFadeFallback(seq, onFallback);
  try {
    renderContents.reload();
    hitContents.reload();
  } catch {
    if (typeof onFallback === "function") onFallback();
  }
}

function activateTheme(themeId, variantId) {
  if (!win || win.isDestroyed()) {
    throw new Error("theme switch requires ready windows");
  }
  // Resolve variantId: explicit arg wins; else current per-theme preference; else default.
  // (Unknown variants lenient-fallback inside loadTheme, so we still commit strict on themeId.)
  const currentVariantMap = _settingsController.get("themeVariant") || {};
  const targetVariant = (typeof variantId === "string" && variantId) ? variantId
    : (currentVariantMap[themeId] || "default");
  const currentOverrides = _settingsController.get("themeOverrides") || {};
  const targetOverrideMap = arguments.length >= 3 ? arguments[2] : (currentOverrides[themeId] || null);
  const targetOverrideSignature = JSON.stringify(targetOverrideMap || {});

  // Joint dedup: same theme + same variant → skip reload. Different variant
  // on same theme MUST run the full reload pipeline (can't hot-patch tiers /
  // displayHint / geometry safely — see plan-settings-panel-3b-swap.md §6.2).
  if (
    activeTheme &&
    activeTheme._id === themeId &&
    activeTheme._variantId === targetVariant &&
    (activeTheme._overrideSignature || "{}") === targetOverrideSignature
  ) {
    return { themeId, variantId: activeTheme._variantId };
  }

  // Strict load first: if it throws, nothing downstream has mutated yet.
  const newTheme = themeLoader.loadTheme(themeId, {
    strict: true,
    variant: targetVariant,
    overrides: targetOverrideMap,
  });
  newTheme._overrideSignature = targetOverrideSignature;
  if (animationOverridesMain) animationOverridesMain.clearPreviewTimer();
  if (!activeTheme || activeTheme._id !== newTheme._id) {
    bumpAnimationOverridePreviewPosterGeneration();
  }
  let preservedVirtualBounds = getPetWindowBounds();

  _state.cleanup();
  _tick.cleanup();
  _mini.cleanup();
  // ⚠️ Don't clear pendingPermissions — bubbles are independent BrowserWindows
  // ⚠️ Don't clear sessions — keep active session tracking
  // ⚠️ Don't clear displayHint — semantic tokens resolve through new theme's map

  if (_mini.getMiniMode() && !newTheme.miniMode.supported) {
    preservedVirtualBounds = null;
    _mini.exitMiniMode();
  }

  activeTheme = newTheme;
  _mini.refreshTheme();
  _state.refreshTheme();
  _tick.refreshTheme();
  if (_mini.getMiniMode()) _mini.handleDisplayChange();

  const transitionSeq = ++themeSwitchTransitionSeq;
  cancelThemeSwitchOpacityAnimation();
  clearThemeSwitchFadeFallback();
  clearThemeSwitchReloadListeners();
  themeReloadInProgress = true;

  let ready = 0;
  let reloadSettled = false;
  const finishThemeReload = () => {
    if (transitionSeq !== themeSwitchTransitionSeq || reloadSettled) return;
    reloadSettled = true;
    clearThemeSwitchFadeFallback();
    clearThemeSwitchReloadListeners();
    themeReloadInProgress = false;
    if (preservedVirtualBounds && !_mini.getMiniTransitioning() && win && !win.isDestroyed()) {
      applyPetWindowBounds(preservedVirtualBounds);
      const clamped = computeFinalDragBounds(
        getPetWindowBounds(),
        { width: preservedVirtualBounds.width, height: preservedVirtualBounds.height },
        clampToScreenVisual
      );
      if (clamped) applyPetWindowBounds(clamped);
    }
    // Fallback can reach this path before both reload events arrive; the sync
    // helpers are window-guarded and serve as a best-effort state resend.
    if (hitWin && !hitWin.isDestroyed()) syncHitStateAfterLoad();
    if (win && !win.isDestroyed()) {
      syncRendererStateAfterLoad({ includeStartupRecovery: false });
      syncHitWin();
    }
    syncSessionHudVisibility();
    if (win && !win.isDestroyed()) startMainTick();
    if (animationOverridesMain) animationOverridesMain.runPendingPostReloadTasks();
    fadeInThemeWindow(transitionSeq);
  };
  const onReady = () => {
    if (transitionSeq !== themeSwitchTransitionSeq) return;
    if (++ready < 2) return;
    finishThemeReload();
  };

  animateThemeWindowOpacity(transitionSeq, 0, THEME_SWITCH_FADE_OUT_MS).then(() => {
    reloadThemeWindowsAfterFade(
      transitionSeq,
      onReady,
      () => finishThemeReload()
    );
  });

  flushRuntimeStateToPrefs();

  // Return resolved ids so the caller (setThemeSelection command) can commit
  // the actually-loaded variantId — handles "author deleted variant" dirty state.
  return { themeId, variantId: newTheme._variantId };
}

// Inject theme deps into the settings controller now that activateTheme,
// themeLoader, and activeTheme are all defined. Uses lazy closures because
// these references are captured at call time (inside an effect or command).
function _deferredActivateTheme(themeId, variantId, overrideMap) {
  return activateTheme(themeId, variantId, overrideMap);
}
function _deferredGetThemeInfo(themeId) {
  const all = themeLoader.discoverThemes();
  const entry = all.find((t) => t.id === themeId);
  if (!entry) return null;
  return {
    builtin: !!entry.builtin,
    active: activeTheme && activeTheme._id === themeId,
    managedCodexPet: codexPetMain.isManagedTheme(themeId),
  };
}
function _deferredRemoveThemeDir(themeId) {
  const userThemesDir = themeLoader.ensureUserThemesDir();
  if (!userThemesDir) throw new Error("user themes directory unavailable");
  // Re-verify path containment as a defensive check — settings-actions
  // already rejects built-in / active themes, and ensureUserThemesDir only
  // ever returns the userData subtree, but belt + suspenders on an fs.rm
  // call is worth the two lines.
  const target = path.resolve(path.join(userThemesDir, themeId));
  const root = path.resolve(userThemesDir);
  if (!target.startsWith(root + path.sep)) {
    throw new Error(`theme path escapes user themes directory: ${themeId}`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  // Rebuild menus so Theme submenu reflects the deleted entry.
  try { rebuildAllMenus(); } catch { /* best-effort */ }
}

// ── Auto-install VS Code / Cursor terminal-focus extension ──
const EXT_ID = "clawd.clawd-terminal-focus";
const EXT_VERSION = "0.1.0";
const EXT_DIR_NAME = `${EXT_ID}-${EXT_VERSION}`;

function installTerminalFocusExtension() {
  const os = require("os");
  const home = os.homedir();

  // Extension source — in dev: ../extensions/vscode/, in packaged: app.asar.unpacked/
  let extSrc = path.join(__dirname, "..", "extensions", "vscode");
  extSrc = extSrc.replace("app.asar" + path.sep, "app.asar.unpacked" + path.sep);

  if (!fs.existsSync(extSrc)) {
    console.log("Clawd: terminal-focus extension source not found, skipping auto-install");
    return;
  }

  const targets = [
    path.join(home, ".vscode", "extensions"),
    path.join(home, ".cursor", "extensions"),
  ];

  const filesToCopy = ["package.json", "extension.js"];
  let installed = 0;

  for (const extRoot of targets) {
    if (!fs.existsSync(extRoot)) continue; // editor not installed
    const dest = path.join(extRoot, EXT_DIR_NAME);
    // Skip if already installed (check package.json exists)
    if (fs.existsSync(path.join(dest, "package.json"))) continue;
    try {
      fs.mkdirSync(dest, { recursive: true });
      for (const file of filesToCopy) {
        fs.copyFileSync(path.join(extSrc, file), path.join(dest, file));
      }
      installed++;
      console.log(`Clawd: installed terminal-focus extension to ${dest}`);
    } catch (err) {
      console.warn(`Clawd: failed to install extension to ${dest}:`, err.message);
    }
  }
  if (installed > 0) {
    console.log(`Clawd: terminal-focus extension installed to ${installed} editor(s). Restart VS Code/Cursor to activate.`);
  }
}

// ── Single instance lock ──
app.on("open-url", (event, url) => {
  event.preventDefault();
  codexPetMain.enqueueImportUrl(url);
});

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  if (process.argv.includes(REGISTER_PROTOCOL_DEV_ARG)) {
    const protocolRegistered = codexPetMain.registerProtocolClient();
    console.log(`Clawd: clawd:// dev protocol registration ${protocolRegistered ? "succeeded" : "failed"}`);
  }
  // Another instance is already running — quit silently
  app.quit();
} else {
  app.on("second-instance", (_event, commandLine) => {
    if (win) {
      win.showInactive();
      keepOutOfTaskbar(win);
    }
    if (hitWin && !hitWin.isDestroyed()) {
      hitWin.showInactive();
      keepOutOfTaskbar(hitWin);
    }
    if (shouldOpenSettingsWindowFromArgv(commandLine)) {
      settingsWindowRuntime.openWhenReady();
    }
    codexPetMain.enqueueImportUrlsFromArgv(commandLine);
    reapplyMacVisibility();
  });

  // macOS: hide dock icon early if user previously disabled it
  if (isMac && app.dock) {
    if (_settingsController.get("showDock") === false) {
      app.dock.hide();
    }
  }

  app.whenReady().then(() => {
    const protocolRegistered = codexPetMain.registerProtocolClient();
    if (process.argv.includes(REGISTER_PROTOCOL_DEV_ARG)) {
      console.log(`Clawd: clawd:// dev protocol registration ${protocolRegistered ? "succeeded" : "failed"}`);
      app.quit();
      return;
    }

    // Import system-backed settings (openAtLogin) into prefs on first run.
    // Must run before createWindow() so the first menu draw sees the
    // hydrated value rather than the schema default.
    hydrateSystemBackedSettings();

    permDebugLog = path.join(app.getPath("userData"), "permission-debug.log");
    updateDebugLog = path.join(app.getPath("userData"), "update-debug.log");
    sessionDebugLog = path.join(app.getPath("userData"), "session-debug.log");
    focusDebugLog = path.join(app.getPath("userData"), "focus-debug.log");
    createWindow();
    if (shouldOpenSettingsWindowFromArgv(process.argv)) {
      settingsWindowRuntime.open();
    }
    codexPetMain.enqueueImportUrlsFromArgv(process.argv);
    codexPetMain.flushPendingImportUrls().catch((err) => {
      console.warn("Clawd: Codex Pet import queue failed:", err && err.message);
    });

    // Register persistent global shortcuts from the validated prefs snapshot.
    shortcutRuntime.registerPersistentShortcutsFromSettings();

    // Construct log monitors. We always instantiate them so toggling the
    // agent on/off later can call start()/stop() without paying the require
    // cost at click time. Whether we call .start() right now depends on the
    // agent-gate snapshot — a user who disabled Codex at last shutdown
    // shouldn't see its file watcher spin up on the next launch.
    try {
      const CodexLogMonitor = require("../agents/codex-log-monitor");
      const codexAgent = require("../agents/codex");
      _codexMonitor = new CodexLogMonitor(codexAgent, (sid, state, event, extra) => {
        if (shouldSuppressCodexLogEvent(sid, state, event)) return;
        if (isCodexMonitorPermissionEvent(state)) {
          updateSession(sid, "notification", event, buildCodexMonitorUpdateOptions(extra, {
            includeHeadless: false,
          }));
          showCodexNotifyBubble({
            sessionId: sid,
            command: (extra && extra.permissionDetail && extra.permissionDetail.command) || "",
          });
          return;
        }
        clearCodexNotifyBubbles(sid, `codex-state-transition:${state}`);
        updateSession(sid, state, event, buildCodexMonitorUpdateOptions(extra, {
          includeHeadless: true,
        }));
      }, { classifier: _codexSubagentClassifier });
      if (_isAgentEnabled(_settingsController.getSnapshot(), "codex")) {
        _codexMonitor.start();
      }
    } catch (err) {
      console.warn("Clawd: Codex log monitor not started:", err.message);
    }

    // Auto-install VS Code/Cursor terminal-focus extension
    try { installTerminalFocusExtension(); } catch (err) {
      console.warn("Clawd: failed to auto-install terminal-focus extension:", err.message);
    }

    // Auto-updater: setup event handlers (user triggers check via tray menu)
    setupAutoUpdater();
  });

  app.on("before-quit", () => {
    isQuitting = true;
    flushRuntimeStateToPrefs();
    globalShortcut.unregisterAll();
    void settingsSizePreviewSession.cleanup();
    _perm.cleanup();
    _server.cleanup();
    _updateBubble.cleanup();
    _state.cleanup();
    _tick.cleanup();
    _mini.cleanup();
    _sessionHud.cleanup();
    if (_codexMonitor) _codexMonitor.stop();
    stopTopmostWatchdog();
    if (hwndRecoveryTimer) { clearTimeout(hwndRecoveryTimer); hwndRecoveryTimer = null; }
    _focus.cleanup();
    if (animationOverridesMain) animationOverridesMain.cleanup();
    if (hitWin && !hitWin.isDestroyed()) hitWin.destroy();
  });

  app.on("window-all-closed", () => {
    if (!isQuitting) return;
    app.quit();
  });
}
