"use strict";

const defaultFs = require("fs");
const defaultPath = require("path");

const {
  SETTINGS_WINDOW_TITLE,
  getSettingsWindowIconPath,
  getSettingsWindowTaskbarDetails,
} = require("./settings-window-icon");

function requiredDependency(value, name) {
  if (!value) throw new Error(`createSettingsWindowRuntime requires ${name}`);
  return value;
}

function createSettingsWindowRuntime(options = {}) {
  const app = requiredDependency(options.app, "app");
  const BrowserWindow = requiredDependency(options.BrowserWindow, "BrowserWindow");
  const nativeTheme = requiredDependency(options.nativeTheme, "nativeTheme");
  const fs = options.fs || defaultFs;
  const path = options.path || defaultPath;
  const platform = options.platform || process.platform;
  const isWin = options.isWin != null ? !!options.isWin : platform === "win32";
  const resourcesPath = options.resourcesPath || process.resourcesPath;
  const execPath = options.execPath || process.execPath;
  const appDir = options.appDir || path.join(__dirname, "..");
  const settingsHtmlPath = options.settingsHtmlPath || path.join(__dirname, "settings.html");
  const preloadPath = options.preloadPath || path.join(__dirname, "preload-settings.js");

  let settingsWindow = null;

  function getWindow() {
    return settingsWindow;
  }

  function getIconPath() {
    return getSettingsWindowIconPath({
      platform,
      isPackaged: app.isPackaged,
      resourcesPath,
      appDir,
      existsSync: fs.existsSync,
    });
  }

  function getTaskbarDetails() {
    return getSettingsWindowTaskbarDetails({
      platform,
      isPackaged: app.isPackaged,
      resourcesPath,
      appDir,
      execPath,
      appPath: app.getAppPath(),
      existsSync: fs.existsSync,
    });
  }

  function openWhenReady() {
    if (app.isReady()) {
      open();
      return;
    }
    app.once("ready", open);
  }

  function open() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      if (settingsWindow.isMinimized()) settingsWindow.restore();
      settingsWindow.show();
      settingsWindow.focus();
      return;
    }

    const iconPath = getIconPath();
    const opts = {
      width: 800,
      height: 560,
      minWidth: 640,
      minHeight: 480,
      show: false,
      frame: true,
      transparent: false,
      resizable: true,
      minimizable: true,
      maximizable: true,
      skipTaskbar: false,
      alwaysOnTop: false,
      title: SETTINGS_WINDOW_TITLE,
      // Match settings.html's dark-mode palette to avoid a white flash before
      // CSS media query kicks in. Hex values must stay in sync with the
      // `--bg` CSS variable in settings.html for each theme.
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#1c1c1f" : "#f5f5f7",
      webPreferences: {
        preload: preloadPath,
        nodeIntegration: false,
        contextIsolation: true,
      },
    };
    if (iconPath) opts.icon = iconPath;

    if (typeof options.onBeforeCreate === "function") options.onBeforeCreate();
    settingsWindow = new BrowserWindow(opts);
    if (isWin && typeof settingsWindow.setAppDetails === "function") {
      const taskbarDetails = getTaskbarDetails();
      if (taskbarDetails && taskbarDetails.appIconPath) {
        settingsWindow.setAppDetails(taskbarDetails);
      }
    }
    settingsWindow.setMenuBarVisibility(false);
    settingsWindow.loadFile(settingsHtmlPath);
    settingsWindow.show();
    settingsWindow.focus();
    settingsWindow.once("ready-to-show", () => {
      // show/focus already called after loadFile above
    });
    settingsWindow.on("closed", () => {
      if (typeof options.onBeforeClosed === "function") options.onBeforeClosed();
      settingsWindow = null;
      if (typeof options.onAfterClosed === "function") options.onAfterClosed();
    });
  }

  return {
    getIconPath,
    getTaskbarDetails,
    getWindow,
    open,
    openWhenReady,
  };
}

module.exports = createSettingsWindowRuntime;
